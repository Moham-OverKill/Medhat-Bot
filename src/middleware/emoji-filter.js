import { PermissionsBitField, Routes } from 'discord.js';
import { getPool } from '../storage/postgres.js';
import { sendLog, sysLog, sysWarn, sysError } from '../utils/logger.js';

export const DEFAULT_BLACKLISTED_EMOJIS = Object.freeze(['🖕', '🍆', '🍑', '💦']);

// In-memory cache for fast Gateway checks: guildId -> { blacklist: string[], enabled: boolean, cachedAt: number }
const emojiBlacklistCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Anti-concurrency guard to prevent overlapping background sweeps
const activeSweeps = new Set();

// ============================================
// RESILIENT RATE-LIMIT & TIMEOUT RETRY QUEUE
// ============================================

/**
 * Registry of pending retry tasks:
 * taskId -> { taskId, description, execute, timer, attempts, scheduledAt, expiresAt }
 */
const pendingRetryQueue = new Map();

/**
 * Checks if an error is a Discord rate limit (429), timeout, or socket abort
 */
export function isRateLimitOrTimeoutError(err) {
  if (!err) return false;
  if (err.status === 429) return true;
  if (err.code === 50035 && err.message?.includes('rate limit')) return true;
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET' || err.name === 'AbortError') return true;
  const msg = (err.message || '').toLowerCase();
  return msg.includes('rate limit') || msg.includes('timeout') || msg.includes('aborted');
}

/**
 * Resolves the cooldown duration in milliseconds from a Discord error object
 */
export function extractRetryAfterMs(err, fallbackMs = 10000) {
  const retryVal = err?.retryAfter ?? err?.rawError?.retry_after ?? err?.response?.headers?.get?.('retry-after');
  if (typeof retryVal === 'number') {
    const ms = retryVal < 1000 ? Math.ceil(retryVal * 1000) : retryVal;
    return Math.max(2000, ms + 500);
  }
  if (typeof retryVal === 'string') {
    const parsed = parseFloat(retryVal);
    if (!isNaN(parsed)) {
      const ms = parsed < 1000 ? Math.ceil(parsed * 1000) : parsed;
      return Math.max(2000, ms + 500);
    }
  }
  return fallbackMs;
}

/**
 * Enqueue a task to retry automatically once the cooldown/timeout is over.
 */
export function queueEmojiModerationRetry(taskId, { guild, description, execute, retryAfterMs = 10000, attempts = 0 }) {
  if (attempts >= 5) {
    sysWarn('Emoji moderation task exceeded maximum retries', { taskId, description });
    pendingRetryQueue.delete(taskId);
    return;
  }

  // Clear existing timer if a newer task for this target arrived
  const existing = pendingRetryQueue.get(taskId);
  if (existing?.timer) {
    clearTimeout(existing.timer);
  }

  const waitMs = Math.min(Math.max(retryAfterMs, 3000), 10 * 60 * 1000); // 3s min, 10m max

  if (guild) {
    const seconds = Math.ceil(waitMs / 1000);
    sendLog(guild, 'audit', 'orange', 'Task Queued — Cooldown / Rate Limit Detected',
      `• **Action:** ${description}\n` +
      `• **Status:** Rate limit or timeout encountered.\n` +
      `• **Queue State:** Scheduled for automatic execution in \`${seconds}s\` once cooldown expires.`
    );
  }

  sysLog('Emoji moderation task queued for retry', {
    taskId,
    description,
    waitMs,
    attempt: attempts + 1
  });

  const timer = setTimeout(async () => {
    pendingRetryQueue.delete(taskId);
    try {
      await execute(attempts + 1);
    } catch (err) {
      if (isRateLimitOrTimeoutError(err)) {
        const nextWait = extractRetryAfterMs(err, waitMs * 1.5);
        queueEmojiModerationRetry(taskId, {
          guild,
          description,
          execute,
          retryAfterMs: nextWait,
          attempts: attempts + 1
        });
      } else {
        sysError('Queued emoji moderation task failed on retry', err, { taskId, description });
      }
    }
  }, waitMs);

  pendingRetryQueue.set(taskId, {
    taskId,
    description,
    execute,
    timer,
    attempts,
    scheduledAt: Date.now(),
    expiresAt: Date.now() + waitMs
  });
}

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
    const enabled = filters?.reaction_blacklist_enabled === true;

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
      enabled: false,
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
    } else if (typeof item === 'string' && /^\d{17,20}$/.test(item)) {
      result = result.replace(new RegExp('<a?:[a-zA-Z0-9_]+:' + item + '>', 'g'), '');
      result = result.replace(new RegExp(item, 'g'), '');
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
  const emojiName = reactionEmoji.name ? reactionEmoji.name.replace(/\uFE0F/g, '').replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '') : '';

  for (const item of blacklist) {
    if (!item) continue;
    const customMatch = typeof item === 'string' && item.match(/^<a?:([a-zA-Z0-9_]+):(\d{17,20})>$/);
    if (customMatch) {
      if (emojiId && emojiId === customMatch[2]) return true;
    } else if (typeof item === 'string' && /^\d{17,20}$/.test(item)) {
      if (emojiId && emojiId === item) return true;
    } else {
      const cleanItem = typeof item === 'string' ? item.replace(/\uFE0F/g, '').replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '') : '';
      if (cleanItem && (emojiName === cleanItem || emojiName.includes(cleanItem))) return true;
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

  const messageTaskId = `message_delete:${message.channel.id}:${message.id}`;
  try {
    await message.delete();
    sendLog(message.guild, 'audit', 'crimson', 'Emoji Blacklist Violation — Message Deleted',
      `**User:** <@${message.author.id}> (\`${message.author.tag || message.author.username}\`)\n` +
      `**Channel:** <#${message.channel.id}>\n` +
      `**Content:** \`${content.slice(0, 150)}\``
    );
  } catch (err) {
    if (isRateLimitOrTimeoutError(err)) {
      const retryMs = extractRetryAfterMs(err, 5000);
      queueEmojiModerationRetry(messageTaskId, {
        guild: message.guild,
        description: `Delete restricted emoji message in <#${message.channel.id}> from <@${message.author.id}>`,
        retryAfterMs: retryMs,
        execute: async () => {
          const freshMsg = await message.channel.messages.fetch(message.id).catch(() => null);
          if (freshMsg) {
            await freshMsg.delete();
            sendLog(message.guild, 'audit', 'cyan', 'Queued Action Executed — Message Deleted',
              `**User:** <@${message.author.id}>\n` +
              `**Channel:** <#${message.channel.id}>\n` +
              `**Status:** Deleted successfully after cooldown.`
            );
          }
        }
      });
    }
  }
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

  const reactionTaskId = `reaction_remove:${reaction.message.channelId}:${reaction.message.id}:${user.id}`;
  try {
    await reaction.users.remove(user.id);
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
  } catch (err) {
    if (isRateLimitOrTimeoutError(err)) {
      const retryMs = extractRetryAfterMs(err, 5000);
      queueEmojiModerationRetry(reactionTaskId, {
        guild,
        description: `Remove reaction from <@${user.id}> in <#${reaction.message.channelId}>`,
        retryAfterMs: retryMs,
        execute: async () => {
          const freshMsg = await reaction.message.channel.messages.fetch(reaction.message.id).catch(() => null);
          const freshReaction = freshMsg?.reactions?.cache?.get(reaction.emoji.id || reaction.emoji.name);
          if (freshReaction) {
            await freshReaction.users.remove(user.id);
            if (guild) {
              sendLog(guild, 'audit', 'cyan', 'Queued Action Executed — Reaction Removed',
                `**User:** <@${user.id}>\n` +
                `**Channel:** <#${reaction.message.channelId}>\n` +
                `**Status:** Removed successfully after cooldown.`
              );
            }
          }
        }
      });
    } else {
      await reaction.remove().catch(() => {});
    }
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

  const config = await getGuildEmojiBlacklist(guildId);
  if (!config.enabled || config.blacklist.length === 0) return false;

  const currentNick = member.nickname || member.user.displayName || member.user.username;
  if (!containsBlacklistedEmoji(currentNick, config.blacklist)) return false;

  const botMember = member.guild.members.me || await member.guild.members.fetchMe().catch(() => null);
  if (!botMember) return false;

  const hasManageNicknames = botMember.permissions.has(PermissionsBitField.Flags.ManageNicknames) ||
                             botMember.permissions.has(PermissionsBitField.Flags.Administrator);

  if (!hasManageNicknames) {
    sysWarn('Cannot sanitize nickname — missing ManageNicknames', { guild: guildId, user: member.id });
    return false;
  }

  const isOwner = member.id === member.guild.ownerId;
  const isAboveBot = member.roles.highest.position >= botMember.roles.highest.position;

  if (isOwner || isAboveBot) {
    sysWarn('Nickname moderation blocked by Discord permission hierarchy', {
      guild: guildId,
      user: member.id,
      isOwner,
      isAboveBot
    });

    sendLog(member.guild, 'audit', 'orange', 'Emoji Blacklist Violation — Nickname Moderation Blocked',
      `**User:** <@${member.id}> (\`${member.user.tag || member.user.username}\`)\n` +
      `**Detected Name:** \`${currentNick}\`\n` +
      `**Status:** Blocked by Discord Permission Hierarchy\n` +
      `**Reason:** ${isOwner ? 'Discord API prevents bots from modifying the Server Owner\'s nickname.' : 'The user\'s role is higher than or equal to the bot\'s highest role. To moderate this user, drag the bot\'s role above their role in Server Settings > Roles.'}`
    );
    return false;
  }

  let sanitized = stripBlacklistedEmojis(currentNick, config.blacklist).trim();
  if (!sanitized) {
    sanitized = stripBlacklistedEmojis(member.user.username, config.blacklist).trim() || 'Member';
  }
  sanitized = sanitized.slice(0, 32);

  if (sanitized === member.nickname) return false;

  const nickTaskId = `member_nick:${guildId}:${member.id}`;
  try {
    await member.setNickname(sanitized, 'Restricted emoji removed from nickname');
    sendLog(member.guild, 'audit', 'crimson', 'Emoji Blacklist Violation — Nickname Sanitized',
      `**User:** <@${member.id}> (\`${member.user.tag || member.user.username}\`)\n` +
      `**Old Name:** \`${currentNick}\`\n` +
      `**Sanitized Name:** \`${sanitized}\``
    );
    return true;
  } catch (err) {
    if (isRateLimitOrTimeoutError(err)) {
      const retryMs = extractRetryAfterMs(err, 10000);
      queueEmojiModerationRetry(nickTaskId, {
        guild: member.guild,
        description: `Sanitize nickname for <@${member.id}> to \`${sanitized}\``,
        retryAfterMs: retryMs,
        execute: async () => {
          const fresh = await member.guild.members.fetch(member.id).catch(() => null);
          if (fresh) {
            const freshNick = fresh.nickname || fresh.user.displayName || fresh.user.username;
            if (containsBlacklistedEmoji(freshNick, config.blacklist)) {
              let clean = stripBlacklistedEmojis(freshNick, config.blacklist).trim();
              if (!clean) clean = stripBlacklistedEmojis(fresh.user.username, config.blacklist).trim() || 'Member';
              await fresh.setNickname(clean.slice(0, 32), 'Restricted emoji removed (queued retry)');
              sendLog(member.guild, 'audit', 'cyan', 'Queued Action Executed — Nickname Sanitized',
                `**User:** <@${member.id}>\n` +
                `**Sanitized Name:** \`${clean.slice(0, 32)}\`\n` +
                `**Status:** Sanitized successfully after cooldown.`
              );
            }
          }
        }
      });
      return false;
    }
    sysError('Failed to sanitize member nickname', err, { guild: guildId, user: member.id });
    return false;
  }
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

  const botMember = channel.guild.members.me || await channel.guild.members.fetchMe().catch(() => null);
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
    const topicTaskId = `channel_topic:${channel.id}`;
    try {
      await channel.setTopic(cleanTopic, 'Restricted emoji removed from topic');
      didSanitize = true;
      sendLog(channel.guild, 'audit', 'crimson', 'Emoji Blacklist Violation — Channel Topic Sanitized',
        `**Channel:** <#${channel.id}> (\`${channel.name}\`)\n` +
        `**Sanitized Topic:** \`${cleanTopic.slice(0, 150)}\``
      );
    } catch (err) {
      if (isRateLimitOrTimeoutError(err)) {
        const retryMs = extractRetryAfterMs(err, 10000);
        queueEmojiModerationRetry(topicTaskId, {
          guild: channel.guild,
          description: `Sanitize channel topic in <#${channel.id}>`,
          retryAfterMs: retryMs,
          execute: async () => {
            const fresh = await channel.fetch().catch(() => null);
            if (fresh && fresh.topic && containsBlacklistedEmoji(fresh.topic, config.blacklist)) {
              const freshTopic = stripBlacklistedEmojis(fresh.topic, config.blacklist).trim();
              await fresh.setTopic(freshTopic, 'Restricted emoji removed from topic (queued retry)');
              sendLog(channel.guild, 'audit', 'cyan', 'Queued Action Executed — Channel Topic Sanitized',
                `**Channel:** <#${channel.id}>\n` +
                `**Sanitized Topic:** \`${freshTopic.slice(0, 150)}\`\n` +
                `**Status:** Sanitized successfully after cooldown.`
              );
            }
          }
        });
      } else {
        sysError('Failed to sanitize channel topic', err, { channel: channel.id });
      }
    }
  }

  // 2. Channel Name Check (Zero artificial cooldown: always attempts immediate rename, queues retry on 429/timeout)
  if (containsBlacklistedEmoji(channel.name, config.blacklist)) {
    let sanitized = stripBlacklistedEmojis(channel.name, config.blacklist).trim();
    if (!sanitized) {
      sanitized = channel.isVoiceBased?.() ? 'voice-channel' : 'channel';
    }
    sanitized = sanitized.slice(0, 100);

    if (sanitized !== channel.name) {
      const oldName = channel.name;
      const channelTaskId = `channel_name:${channel.id}`;
      try {
        await channel.setName(sanitized, 'Restricted emoji removed from channel name');
        didSanitize = true;

        sendLog(channel.guild, 'audit', 'crimson', 'Emoji Blacklist Violation — Channel Renamed',
          `**Channel:** <#${channel.id}> (\`${oldName}\`)\n` +
          `**Sanitized Name:** \`${sanitized}\``
        );
      } catch (err) {
        if (isRateLimitOrTimeoutError(err)) {
          const retryAfterMs = extractRetryAfterMs(err, 15000);
          queueEmojiModerationRetry(channelTaskId, {
            guild: channel.guild,
            description: `Rename channel <#${channel.id}> to \`${sanitized}\``,
            retryAfterMs: retryAfterMs,
            execute: async () => {
              const fresh = await channel.fetch().catch(() => null);
              if (fresh && containsBlacklistedEmoji(fresh.name, config.blacklist)) {
                const clean = stripBlacklistedEmojis(fresh.name, config.blacklist).trim() ||
                  (fresh.isVoiceBased?.() ? 'voice-channel' : 'channel');
                await fresh.setName(clean.slice(0, 100), 'Restricted emoji removed (queued retry)');
                sendLog(channel.guild, 'audit', 'cyan', 'Queued Action Executed — Channel Renamed',
                  `**Channel:** <#${channel.id}>\n` +
                  `**Sanitized Name:** \`${clean.slice(0, 100)}\`\n` +
                  `**Status:** Renamed successfully after cooldown.`
                );
              }
            }
          });
        } else {
          sysError('Failed to rename channel', err, { channel: channel.id });
        }
      }
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

  const voiceTaskId = `voice_status:${channelId}`;
  try {
    await client.rest.put(Routes.channelVoiceStatus(channelId), {
      body: { status: sanitized }
    });
    if (guild) {
      sendLog(guild, 'audit', 'crimson', 'Emoji Blacklist Violation — Call Status Sanitized',
        `**Channel:** <#${channelId}>\n` +
        `**Old Call Status:** \`${statusText}\`\n` +
        `**Sanitized Call Status:** \`${sanitized || '(cleared)'}\``
      );
    }
  } catch (err) {
    if (isRateLimitOrTimeoutError(err)) {
      const retryMs = extractRetryAfterMs(err, 10000);
      queueEmojiModerationRetry(voiceTaskId, {
        guild,
        description: `Sanitize call status in <#${channelId}> to \`${sanitized}\``,
        retryAfterMs: retryMs,
        execute: async () => {
          await client.rest.put(Routes.channelVoiceStatus(channelId), {
            body: { status: sanitized }
          });
          if (guild) {
            sendLog(guild, 'audit', 'cyan', 'Queued Action Executed — Call Status Sanitized',
              `**Channel:** <#${channelId}>\n` +
              `**Sanitized Call Status:** \`${sanitized || '(cleared)'}\`\n` +
              `**Status:** Sanitized successfully after cooldown.`
            );
          }
        }
      });
    } else {
      sysError('Failed to sanitize voice status via REST', err, { guild: guildId, channel: channelId });
    }
  }
  return true;
}

/**
 * Comprehensive retroactive sweep of all channels, topics, and member nicknames across the server
 * STRICT SAFETY GUARDRAIL: UNDER NO CIRCUMSTANCES DOES THIS DELETE CHANNELS, GUILDS, OR BAN/KICK MEMBERS.
 * Throttled to prevent Discord API 429 rate limits, with a circuit breaker max cap.
 */
export async function sweepServerEmojiViolations(guild) {
  if (!guild || !guild.id) return { channels: 0, topics: 0, nicknames: 0 };
  const guildId = guild.id;

  // Anti-concurrency guard: avoid overlapping sweeps on the same server
  if (activeSweeps.has(guildId)) {
    return { channels: 0, topics: 0, nicknames: 0 };
  }
  activeSweeps.add(guildId);

  try {
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

    // Circuit breaker limits to prevent API throttling
    const MAX_CHANNELS_PER_SWEEP = 25;
    const MAX_NICKNAMES_PER_SWEEP = 50;

    // 1. Sweep Channels & Threads
    if (hasManageChannels) {
      try {
        const channels = await guild.channels.fetch().catch(() => guild.channels.cache);
        for (const ch of channels.values()) {
          if (!ch || ch.deleted) continue;
          if (channelsCleaned + topicsCleaned >= MAX_CHANNELS_PER_SWEEP) break;

          // Check topic
          if (ch.topic && containsBlacklistedEmoji(ch.topic, config.blacklist) && typeof ch.setTopic === 'function') {
            const cleanTopic = stripBlacklistedEmojis(ch.topic, config.blacklist).trim();
            try {
              await ch.setTopic(cleanTopic, 'Sweep: Restricted emoji removed from topic');
              topicsCleaned++;
            } catch (err) {
              if (isRateLimitOrTimeoutError(err)) {
                queueEmojiModerationRetry(`channel_topic:${ch.id}`, {
                  guild,
                  description: `Sweep: Sanitize topic in <#${ch.id}>`,
                  retryAfterMs: extractRetryAfterMs(err, 15000),
                  execute: async () => {
                    const fresh = await ch.fetch().catch(() => null);
                    if (fresh && fresh.topic && containsBlacklistedEmoji(fresh.topic, config.blacklist)) {
                      await fresh.setTopic(stripBlacklistedEmojis(fresh.topic, config.blacklist).trim(), 'Sweep retry');
                    }
                  }
                });
              }
            }
            await new Promise(r => setTimeout(r, 1000));
          }

          // Check name
          if (ch.name && containsBlacklistedEmoji(ch.name, config.blacklist)) {
            let sanitized = stripBlacklistedEmojis(ch.name, config.blacklist).trim();
            if (!sanitized) sanitized = ch.isVoiceBased?.() ? 'voice-channel' : 'channel';
            sanitized = sanitized.slice(0, 100);
            if (sanitized !== ch.name) {
              try {
                await ch.setName(sanitized, 'Sweep: Restricted emoji removed from name');
                channelsCleaned++;
              } catch (err) {
                if (isRateLimitOrTimeoutError(err)) {
                  queueEmojiModerationRetry(`channel_name:${ch.id}`, {
                    guild,
                    description: `Sweep: Rename channel <#${ch.id}> to \`${sanitized}\``,
                    retryAfterMs: extractRetryAfterMs(err, 15000),
                    execute: async () => {
                      const fresh = await ch.fetch().catch(() => null);
                      if (fresh && containsBlacklistedEmoji(fresh.name, config.blacklist)) {
                        const clean = stripBlacklistedEmojis(fresh.name, config.blacklist).trim() || 'channel';
                        await fresh.setName(clean.slice(0, 100), 'Sweep retry');
                      }
                    }
                  });
                }
              }
              await new Promise(r => setTimeout(r, 1000));
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
          if (!mem || mem.user?.bot || mem.id === guild.ownerId || mem.id === botMember.id) continue;
          if (mem.roles.highest.position >= botMember.roles.highest.position) continue;
          if (nicknamesCleaned >= MAX_NICKNAMES_PER_SWEEP) break;

          const currentName = mem.nickname || mem.user.displayName || mem.user.username;
          if (containsBlacklistedEmoji(currentName, config.blacklist)) {
            let sanitized = stripBlacklistedEmojis(currentName, config.blacklist).trim();
            if (!sanitized) {
              sanitized = stripBlacklistedEmojis(mem.user.username, config.blacklist).trim() || 'Member';
            }
            sanitized = sanitized.slice(0, 32);
            if (sanitized !== mem.nickname) {
              try {
                await mem.setNickname(sanitized, 'Sweep: Restricted emoji removed from nickname');
                nicknamesCleaned++;
              } catch (err) {
                if (isRateLimitOrTimeoutError(err)) {
                  queueEmojiModerationRetry(`member_nick:${guildId}:${mem.id}`, {
                    guild,
                    description: `Sweep: Sanitize nickname for <@${mem.id}>`,
                    retryAfterMs: extractRetryAfterMs(err, 10000),
                    execute: async () => {
                      const fresh = await guild.members.fetch(mem.id).catch(() => null);
                      if (fresh) {
                        const freshNick = fresh.nickname || fresh.user.displayName || fresh.user.username;
                        if (containsBlacklistedEmoji(freshNick, config.blacklist)) {
                          await fresh.setNickname(stripBlacklistedEmojis(freshNick, config.blacklist).trim().slice(0, 32), 'Sweep retry');
                        }
                      }
                    }
                  });
                }
              }
              await new Promise(r => setTimeout(r, 250));
            }
          }
        }
      } catch (err) {
        sysError('Sweep nicknames error', err, { guild: guildId });
      }
    }

    if (channelsCleaned > 0 || topicsCleaned > 0 || nicknamesCleaned > 0) {
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
    }

    return { channels: channelsCleaned, topics: topicsCleaned, nicknames: nicknamesCleaned };
  } finally {
    activeSweeps.delete(guildId);
  }
}
