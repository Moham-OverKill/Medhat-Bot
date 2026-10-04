import { PermissionsBitField, Routes } from 'discord.js';
import { getPool } from '../storage/postgres.js';
import { sendLog, sysLog, sysWarn, sysError } from '../utils/logger.js';

export const DEFAULT_BLACKLISTED_EMOJIS = ['🖕', '🍆', '🍑', '💦'];

// In-memory cache for fast Gateway checks: guildId -> { blacklist: string[], enabled: boolean, cachedAt: number }
const emojiBlacklistCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Rate limit cooldown for channel renames: channelId -> timestamp (Discord limit: 2 renames per 10m)
const channelRenameCooldowns = new Map();
const CHANNEL_RENAME_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Load emoji blacklist config for a guild from database
 */
async function loadGuildEmojiBlacklist(guildId) {
  try {
    const pool = getPool();
    const result = await pool.query(
      `SELECT config->'channel_filters' as filters FROM guild_configs WHERE guild_id = $1`,
      [guildId]
    );

    const filters = result.rows[0]?.filters;
    const blacklist = Array.isArray(filters?.reaction_blacklist)
      ? filters.reaction_blacklist
      : [...DEFAULT_BLACKLISTED_EMOJIS];
    const enabled = filters?.reaction_blacklist_enabled !== false;

    const entry = {
      blacklist,
      enabled,
      cachedAt: Date.now()
    };
    emojiBlacklistCache.set(guildId, entry);
    return entry;
  } catch (error) {
    sysError('Failed to load emoji blacklist cache', error, { guild: guildId });
    return {
      blacklist: [...DEFAULT_BLACKLISTED_EMOJIS],
      enabled: true,
      cachedAt: Date.now()
    };
  }
}

/**
 * Invalidate cache for a specific guild
 */
export function invalidateEmojiBlacklistCache(guildId) {
  if (guildId) {
    emojiBlacklistCache.delete(guildId);
  }
}

/**
 * Retrieve cached blacklist configuration for a guild
 */
export async function getGuildEmojiBlacklist(guildId) {
  if (!guildId) return { blacklist: [...DEFAULT_BLACKLISTED_EMOJIS], enabled: false };
  let cached = emojiBlacklistCache.get(guildId);
  if (!cached || Date.now() - cached.cachedAt > CACHE_TTL_MS) {
    cached = await loadGuildEmojiBlacklist(guildId);
  }
  return cached;
}

/**
 * Check if a text string contains any blacklisted emoji
 */
export function containsBlacklistedEmoji(text, blacklist) {
  if (!text || typeof text !== 'string' || !blacklist || blacklist.length === 0) return false;
  const normalizedText = text.replace(/\uFE0F/g, '');

  for (const item of blacklist) {
    if (!item) continue;
    const customMatch = typeof item === 'string' && item.match(/^<a?:([a-zA-Z0-9_]+):(\d{17,20})>$/);
    if (customMatch) {
      const emojiId = customMatch[2];
      if (text.includes(emojiId) || text.includes(item)) return true;
    } else {
      const cleanItem = typeof item === 'string' ? item.replace(/\uFE0F/g, '') : '';
      if (cleanItem && normalizedText.includes(cleanItem)) return true;
    }
  }
  return false;
}

/**
 * Strip all blacklisted emojis from a text string while keeping the rest intact.
 * Handles Unicode variation selectors, skin tone modifiers (\u1F3FB-\u1F3FF), and custom emojis.
 */
export function stripBlacklistedEmojis(text, blacklist) {
  if (!text || typeof text !== 'string' || !blacklist || blacklist.length === 0) return text || '';
  let result = text;

  for (const item of blacklist) {
    if (!item) continue;
    const customMatch = typeof item === 'string' && item.match(/^<a?:([a-zA-Z0-9_]+):(\d{17,20})>$/);
    if (customMatch) {
      const emojiId = customMatch[2];
      result = result.replace(new RegExp('<a?:[a-zA-Z0-9_]+:' + emojiId + '>', 'g'), '');
      result = result.replace(new RegExp(emojiId, 'g'), '');
    } else {
      const cleanItem = typeof item === 'string' ? item.replace(/\uFE0F/g, '') : '';
      if (cleanItem) {
        // Strip clean item with optional skin tone modifier
        const re = new RegExp(cleanItem + '(?:[\u{1F3FB}-\u{1F3FF}])?', 'gu');
        result = result.replace(re, '');
      }
    }
  }

  // Strip dangling variation selectors and skin tone modifier artifacts
  return result.replace(/\uFE0F/g, '').replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '');
}

/**
 * Check if a reaction emoji matches the blacklist
 */
export function isReactionBlacklisted(reactionEmoji, blacklist) {
  if (!reactionEmoji || !blacklist || blacklist.length === 0) return false;
  const emojiId = reactionEmoji.id;
  const emojiName = reactionEmoji.name ? reactionEmoji.name.replace(/\uFE0F/g, '') : '';

  for (const item of blacklist) {
    if (!item) continue;
    const customMatch = typeof item === 'string' && item.match(/^<a?:([a-zA-Z0-9_]+):(\d{17,20})>$/);
    if (customMatch) {
      if (emojiId && emojiId === customMatch[2]) return true;
    } else {
      const cleanItem = typeof item === 'string' ? item.replace(/\uFE0F/g, '') : '';
      if (cleanItem && emojiName === cleanItem) return true;
    }
  }
  return false;
}

/**
 * Vector 1: Scan and delete messages containing blacklisted emojis.
 * Also scans Discord native polls (question and answer options).
 */
export async function processMessageEmojiFilter(message) {
  if (!message || !message.guild || !message.author || message.author.bot || message.webhookId) return false;
  const guildId = message.guild.id;

  const config = await getGuildEmojiBlacklist(guildId);
  if (!config.enabled || config.blacklist.length === 0) return false;

  let hasRestricted = false;
  const content = message.content || '';

  if (containsBlacklistedEmoji(content, config.blacklist)) {
    hasRestricted = true;
  }

  // Check Discord native poll if present
  if (!hasRestricted && message.poll) {
    if (containsBlacklistedEmoji(message.poll.question?.text, config.blacklist)) {
      hasRestricted = true;
    } else if (message.poll.answers) {
      for (const answer of message.poll.answers.values()) {
        if (containsBlacklistedEmoji(answer.text, config.blacklist)) {
          hasRestricted = true;
          break;
        }
        if (answer.emoji && isReactionBlacklisted(answer.emoji, config.blacklist)) {
          hasRestricted = true;
          break;
        }
      }
    }
  }

  if (!hasRestricted) return false;

  const botMember = message.guild.members.me;
  if (!botMember || !botMember.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
    sysWarn('Cannot delete blacklisted message — missing ManageMessages', { guild: guildId, channel: message.channel?.id });
    return false;
  }

  await message.delete().catch(() => {});
  sendLog(message.guild, 'audit', 'crimson', 'Emoji Blacklist Violation — Message Deleted',
    `**User:** <@${message.author.id}> (\`${message.author.tag || message.author.username}\`)\n` +
    `**Channel:** <#${message.channel.id}>\n` +
    `**Content:** \`${content.slice(0, 150)}\``
  );
  return true;
}

/**
 * Vector 2: Scan and remove reactions matching blacklisted emojis
 */
export async function processReactionEmojiFilter(reaction, user) {
  if (!reaction || !user || user.bot) return false;
  const guildId = reaction.message?.guildId || reaction.message?.guild?.id;
  if (!guildId) return false;

  const config = await getGuildEmojiBlacklist(guildId);
  if (!config.enabled || config.blacklist.length === 0) return false;

  if (!isReactionBlacklisted(reaction.emoji, config.blacklist)) return false;

  const guild = reaction.message.guild || reaction.client?.guilds?.cache?.get(guildId);
  const botMember = guild?.members?.me;
  if (!botMember || !botMember.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
    sysWarn('Cannot remove blacklisted reaction — missing ManageMessages', { guild: guildId });
    return false;
  }

  await reaction.users.remove(user.id).catch(() => reaction.remove().catch(() => {}));

  if (guild) {
    const emojiDisplay = reaction.emoji.id
      ? `<${reaction.emoji.animated ? 'a' : ''}:${reaction.emoji.name}:${reaction.emoji.id}>`
      : reaction.emoji.name;

    sendLog(guild, 'audit', 'crimson', 'Emoji Blacklist Violation — Reaction Removed',
      `**User:** <@${user.id}> (\`${user.tag || user.username}\`)\n` +
      `**Channel:** <#${reaction.message.channelId}>\n` +
      `**Message:** [Jump to Message](${reaction.message.url})\n` +
      `**Reaction:** ${emojiDisplay}`
    );
  }
  return true;
}

/**
 * Vector 3: Sanitize member nicknames/display names
 * STRICT SAFETY GUARDRAIL: Never kicks or bans users. Only sets sanitized nickname.
 */
export async function processMemberNicknameEmojiFilter(member) {
  if (!member || !member.guild || member.user?.bot) return false;
  const guildId = member.guild.id;

  // STRICT SAFETY GUARDRAIL: Never touch server owner
  if (member.id === member.guild.ownerId) return false;

  const config = await getGuildEmojiBlacklist(guildId);
  if (!config.enabled || config.blacklist.length === 0) return false;

  const currentNick = member.nickname || member.user.displayName || member.user.username;
  if (!containsBlacklistedEmoji(currentNick, config.blacklist)) return false;

  const botMember = member.guild.members.me;
  if (!botMember || !botMember.permissions.has(PermissionsBitField.Flags.ManageNicknames)) {
    sysWarn('Cannot sanitize nickname — missing ManageNicknames', { guild: guildId, user: member.id });
    return false;
  }

  // STRICT SAFETY GUARDRAIL: Role hierarchy check
  if (member.roles.highest.position >= botMember.roles.highest.position) {
    return false;
  }

  let sanitized = stripBlacklistedEmojis(currentNick, config.blacklist).trim();
  if (!sanitized) {
    sanitized = stripBlacklistedEmojis(member.user.username, config.blacklist).trim() || 'Member';
  }
  sanitized = sanitized.slice(0, 32);

  if (sanitized === member.nickname) return false;

  // Strictly rename only — NEVER kick or ban
  await member.setNickname(sanitized, 'Restricted emoji removed from nickname').catch(() => {});

  sendLog(member.guild, 'audit', 'crimson', 'Emoji Blacklist Violation — Nickname Sanitized',
    `**User:** <@${member.id}> (\`${member.user.tag || member.user.username}\`)\n` +
    `**Old Name:** \`${currentNick}\`\n` +
    `**Sanitized Name:** \`${sanitized}\``
  );
  return true;
}

/**
 * Vector 4: Sanitize channel names and channel topics (text, voice, threads, forums, categories)
 * STRICT SAFETY GUARDRAIL: UNDER NO CIRCUMSTANCES SHALL A CHANNEL BE DELETED.
 * Only renames the channel or updates topic to strip forbidden emojis.
 */
export async function processChannelNameEmojiFilter(channel) {
  if (!channel || !channel.guild || !channel.name) return false;
  const guildId = channel.guild.id;

  const config = await getGuildEmojiBlacklist(guildId);
  if (!config.enabled || config.blacklist.length === 0) return false;

  const botMember = channel.guild.members.me;
  const hasManageChannels = botMember && (
    botMember.permissions.has(PermissionsBitField.Flags.ManageChannels) ||
    botMember.permissions.has(PermissionsBitField.Flags.Administrator)
  );

  if (!hasManageChannels) {
    sysWarn('Cannot sanitize channel — missing ManageChannels', { guild: guildId, channel: channel.id });
    return false;
  }

  let didSanitize = false;

  // 1. Channel Topic Check
  if (channel.topic && containsBlacklistedEmoji(channel.topic, config.blacklist) && typeof channel.setTopic === 'function') {
    const cleanTopic = stripBlacklistedEmojis(channel.topic, config.blacklist).trim();
    await channel.setTopic(cleanTopic, 'Restricted emoji removed from topic').catch(() => {});
    didSanitize = true;
    sendLog(channel.guild, 'audit', 'crimson', 'Emoji Blacklist Violation — Channel Topic Sanitized',
      `**Channel:** <#${channel.id}> (\`${channel.name}\`)\n` +
      `**Sanitized Topic:** \`${cleanTopic.slice(0, 150)}\``
    );
  }

  // 2. Channel Name Check with anti-spam rate limit protection
  if (containsBlacklistedEmoji(channel.name, config.blacklist)) {
    const lastRename = channelRenameCooldowns.get(channel.id) || 0;
    if (Date.now() - lastRename < CHANNEL_RENAME_COOLDOWN_MS) {
      // Cooldown active to avoid Discord API 429
      return didSanitize;
    }

    let sanitized = stripBlacklistedEmojis(channel.name, config.blacklist).trim();
    if (!sanitized) {
      sanitized = channel.isVoiceBased?.() ? 'voice-channel' : 'channel';
    }
    sanitized = sanitized.slice(0, 100);

    if (sanitized !== channel.name) {
      channelRenameCooldowns.set(channel.id, Date.now());
      const oldName = channel.name;
      // Strictly rename only — NEVER delete channel
      await channel.setName(sanitized, 'Restricted emoji removed from channel name').catch(() => {});
      didSanitize = true;

      sendLog(channel.guild, 'audit', 'crimson', 'Emoji Blacklist Violation — Channel Renamed',
        `**Channel:** <#${channel.id}> (\`${oldName}\`)\n` +
        `**Sanitized Name:** \`${sanitized}\``
      );
    }
  }

  return didSanitize;
}

/**
 * Vector 5: Sanitize call status / voice channel status
 * STRICT SAFETY GUARDRAIL: UNDER NO CIRCUMSTANCES SHALL A CHANNEL BE DELETED.
 */
export async function processVoiceStatusEmojiFilter(client, guildId, channelId, statusText) {
  if (!client || !guildId || !channelId) return false;
  if (!statusText || typeof statusText !== 'string') return false;

  const config = await getGuildEmojiBlacklist(guildId);
  if (!config.enabled || config.blacklist.length === 0) return false;

  if (!containsBlacklistedEmoji(statusText, config.blacklist)) return false;

  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  const botMember = guild?.members?.me || await guild?.members?.fetchMe().catch(() => null);

  const hasVoiceStatusPerm = botMember && (
    botMember.permissions.has(PermissionsBitField.Flags.SetVoiceChannelStatus) ||
    botMember.permissions.has(PermissionsBitField.Flags.ManageChannels) ||
    botMember.permissions.has(PermissionsBitField.Flags.Administrator)
  );

  if (!hasVoiceStatusPerm) {
    sysWarn('Cannot sanitize call/voice status — missing SetVoiceChannelStatus/ManageChannels', { guild: guildId, channel: channelId });
    return false;
  }

  const sanitized = stripBlacklistedEmojis(statusText, config.blacklist).trim();

  // Strictly update status via REST API — NEVER delete channel
  await client.rest.put(Routes.channelVoiceStatus(channelId), {
    body: { status: sanitized }
  }).catch((err) => {
    sysError('Failed to sanitize voice status via REST', err, { guild: guildId, channel: channelId });
  });

  if (guild) {
    sendLog(guild, 'audit', 'crimson', 'Emoji Blacklist Violation — Call Status Sanitized',
      `**Channel:** <#${channelId}>\n` +
      `**Old Call Status:** \`${statusText}\`\n` +
      `**Sanitized Call Status:** \`${sanitized || '(cleared)'}\``
    );
  }
  return true;
}

/**
 * Comprehensive retroactive sweep of all channels, topics, and member nicknames across the server
 */
export async function sweepServerEmojiViolations(guild) {
  if (!guild) return { channels: 0, topics: 0, nicknames: 0 };
  const guildId = guild.id;

  const config = await getGuildEmojiBlacklist(guildId);
  if (!config.enabled || config.blacklist.length === 0) {
    return { channels: 0, topics: 0, nicknames: 0 };
  }

  const botMember = guild.members.me || await guild.members.fetchMe().catch(() => null);
  if (!botMember) return { channels: 0, topics: 0, nicknames: 0 };

  const hasManageChannels = botMember.permissions.has(PermissionsBitField.Flags.ManageChannels) ||
                            botMember.permissions.has(PermissionsBitField.Flags.Administrator);
  const hasManageNicknames = botMember.permissions.has(PermissionsBitField.Flags.ManageNicknames) ||
                             botMember.permissions.has(PermissionsBitField.Flags.Administrator);

  let channelsCleaned = 0;
  let topicsCleaned = 0;
  let nicknamesCleaned = 0;

  // 1. Sweep Channels & Threads
  if (hasManageChannels) {
    try {
      const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
      for (const ch of channels.values()) {
        if (!ch) continue;

        // Check topic
        if (ch.topic && containsBlacklistedEmoji(ch.topic, config.blacklist) && typeof ch.setTopic === 'function') {
          const cleanTopic = stripBlacklistedEmojis(ch.topic, config.blacklist).trim();
          await ch.setTopic(cleanTopic, 'Sweep: Restricted emoji removed from topic').catch(() => {});
          topicsCleaned++;
        }

        // Check name
        if (ch.name && containsBlacklistedEmoji(ch.name, config.blacklist)) {
          let sanitized = stripBlacklistedEmojis(ch.name, config.blacklist).trim();
          if (!sanitized) sanitized = ch.isVoiceBased?.() ? 'voice-channel' : 'channel';
          sanitized = sanitized.slice(0, 100);
          if (sanitized !== ch.name) {
            await ch.setName(sanitized, 'Sweep: Restricted emoji removed from name').catch(() => {});
            channelsCleaned++;
          }
        }
      }
    } catch (err) {
      sysError('Sweep channels error', err, { guild: guildId });
    }
  }

  // 2. Sweep Nicknames
  if (hasManageNicknames) {
    try {
      const members = await guild.members.fetch().catch(() => guild.members.cache);
      for (const mem of members.values()) {
        if (!mem || mem.user?.bot || mem.id === guild.ownerId) continue;
        if (mem.roles.highest.position >= botMember.roles.highest.position) continue;

        const currentName = mem.nickname || mem.user.displayName || mem.user.username;
        if (containsBlacklistedEmoji(currentName, config.blacklist)) {
          let sanitized = stripBlacklistedEmojis(currentName, config.blacklist).trim();
          if (!sanitized) {
            sanitized = stripBlacklistedEmojis(mem.user.username, config.blacklist).trim() || 'Member';
          }
          sanitized = sanitized.slice(0, 32);
          if (sanitized !== mem.nickname) {
            await mem.setNickname(sanitized, 'Sweep: Restricted emoji removed from nickname').catch(() => {});
            nicknamesCleaned++;
          }
        }
      }
    } catch (err) {
      sysError('Sweep nicknames error', err, { guild: guildId });
    }
  }

  sysLog('Emoji Blacklist Server Sweep Completed', {
    guild: guildId,
    channels: channelsCleaned,
    topics: topicsCleaned,
    nicknames: nicknamesCleaned
  });

  sendLog(guild, 'audit', 'cyan', 'Emoji Blacklist Server Sweep Completed',
    `• **Channels Renamed:** ${channelsCleaned}\n` +
    `• **Topics Sanitized:** ${topicsCleaned}\n` +
    `• **Nicknames Sanitized:** ${nicknamesCleaned}`
  );

  return { channels: channelsCleaned, topics: topicsCleaned, nicknames: nicknamesCleaned };
}
