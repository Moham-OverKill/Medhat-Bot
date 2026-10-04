import { PermissionsBitField, Routes } from 'discord.js';
import { getPool } from '../storage/postgres.js';
import { sendLog, sysLog, sysWarn, sysError } from '../utils/logger.js';

export const DEFAULT_BLACKLISTED_EMOJIS = ['🖕', '🍆', '🍑', '💦'];

// In-memory cache for fast Gateway checks: guildId -> { blacklist: string[], enabled: boolean, cachedAt: number }
const emojiBlacklistCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

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
 * Strip all blacklisted emojis from a text string while keeping the rest intact
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
        result = result.split(cleanItem).join('');
        result = result.split(item).join('');
      }
    }
  }

  return result.replace(/\uFE0F/g, '');
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
 * Vector 1: Scan and delete messages containing blacklisted emojis
 */
export async function processMessageEmojiFilter(message) {
  if (!message || !message.guild || !message.author || message.author.bot || message.webhookId) return false;
  const guildId = message.guild.id;

  const config = await getGuildEmojiBlacklist(guildId);
  if (!config.enabled || config.blacklist.length === 0) return false;

  const content = message.content || '';
  if (!containsBlacklistedEmoji(content, config.blacklist)) return false;

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
 * Vector 4: Sanitize channel names (text, voice, forums, categories)
 * STRICT SAFETY GUARDRAIL: UNDER NO CIRCUMSTANCES SHALL A CHANNEL BE DELETED.
 * Only renames the channel to strip forbidden emojis.
 */
export async function processChannelNameEmojiFilter(channel) {
  if (!channel || !channel.guild || !channel.name) return false;
  const guildId = channel.guild.id;

  const config = await getGuildEmojiBlacklist(guildId);
  if (!config.enabled || config.blacklist.length === 0) return false;

  if (!containsBlacklistedEmoji(channel.name, config.blacklist)) return false;

  const botMember = channel.guild.members.me;
  if (!botMember || !botMember.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
    sysWarn('Cannot sanitize channel name — missing ManageChannels', { guild: guildId, channel: channel.id });
    return false;
  }

  let sanitized = stripBlacklistedEmojis(channel.name, config.blacklist).trim();
  if (!sanitized) {
    sanitized = channel.isVoiceBased?.() ? 'voice-channel' : 'channel';
  }
  sanitized = sanitized.slice(0, 100);

  if (sanitized === channel.name) return false;

  const oldName = channel.name;
  // Strictly rename only — NEVER delete channel
  await channel.setName(sanitized, 'Restricted emoji removed from channel name').catch(() => {});

  sendLog(channel.guild, 'audit', 'crimson', 'Emoji Blacklist Violation — Channel Renamed',
    `**Channel:** <#${channel.id}> (\`${oldName}\`)\n` +
    `**Sanitized Name:** \`${sanitized}\``
  );
  return true;
}

/**
 * Vector 5: Sanitize voice channel status
 * STRICT SAFETY GUARDRAIL: UNDER NO CIRCUMSTANCES SHALL A CHANNEL BE DELETED.
 */
export async function processVoiceStatusEmojiFilter(client, guildId, channelId, statusText) {
  if (!client || !guildId || !channelId || !statusText) return false;

  const config = await getGuildEmojiBlacklist(guildId);
  if (!config.enabled || config.blacklist.length === 0) return false;

  if (!containsBlacklistedEmoji(statusText, config.blacklist)) return false;

  const guild = client.guilds.cache.get(guildId);
  const botMember = guild?.members?.me;
  if (!botMember || !botMember.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
    sysWarn('Cannot sanitize voice status — missing ManageChannels', { guild: guildId, channel: channelId });
    return false;
  }

  const sanitized = stripBlacklistedEmojis(statusText, config.blacklist).trim();

  // Strictly update status via REST API — NEVER delete channel
  await client.rest.put(Routes.channelVoiceStatus(channelId), {
    body: { status: sanitized }
  }).catch(() => {});

  if (guild) {
    sendLog(guild, 'audit', 'crimson', 'Emoji Blacklist Violation — Voice Status Sanitized',
      `**Channel:** <#${channelId}>\n` +
      `**Old Status:** \`${statusText}\`\n` +
      `**Sanitized Status:** \`${sanitized || '(empty)'}\``
    );
  }
  return true;
}
