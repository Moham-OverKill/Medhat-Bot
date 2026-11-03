import {
  PermissionFlagsBits,
  ChannelType,
  OverwriteType,
  PermissionsBitField,
  SystemChannelFlagsBitField
} from 'discord.js';
import {
  getServerPauseState,
  recordServerPauseSnapshot,
  getServerChannelPermissionBackups,
  clearServerPauseSnapshot
} from '../../storage/pause.js';
import { sendLog, sysLog, sysWarn, sysError } from '../../utils/logger.js';
import { getUserLogName } from '../../shared.js';

// Per-guild mutex sets to prevent concurrent operations
const activeLockdownGuilds = new Set();
const activeUnpauseGuilds = new Set();

export const ELIGIBLE_CHANNEL_TYPES = Object.freeze(new Set([
  ChannelType.GuildText,
  ChannelType.GuildVoice,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
  ChannelType.GuildStageVoice
]));

const VIEW_CHANNEL_BIT = PermissionsBitField.Flags.ViewChannel;

/**
 * Helper to pause execution for pacing REST requests.
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Validate that the bot has Administrator permissions and can manage channels.
 * 
 * @param {import('discord.js').Guild} guild
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateLockdownPrerequisites(guild) {
  if (!guild) return { valid: false, error: 'Guild not found.' };

  const me = guild.members.me;
  if (!me) return { valid: false, error: 'Bot member profile could not be resolved.' };

  if (!me.permissions.has(PermissionFlagsBits.Administrator)) {
    return {
      valid: false,
      error: 'Medhat requires the **Administrator** permission to execute a server lockdown.'
    };
  }

  return { valid: true };
}

/**
 * Serialize relevant guild configuration settings into a JSON-compatible object.
 * 
 * @param {import('discord.js').Guild} guild
 * @returns {object}
 */
export function captureGuildSettings(guild) {
  if (!guild) return {};

  return {
    name: guild.name || null,
    verificationLevel: guild.verificationLevel ?? null,
    defaultMessageNotifications: guild.defaultMessageNotifications ?? null,
    explicitContentFilter: guild.explicitContentFilter ?? null,
    afkChannelId: guild.afkChannelId || null,
    afkTimeout: guild.afkTimeout ?? null,
    systemChannelId: guild.systemChannelId || null,
    systemChannelFlags: guild.systemChannelFlags?.bitfield !== undefined ? guild.systemChannelFlags.bitfield.toString() : null,
    rulesChannelId: guild.rulesChannelId || null,
    publicUpdatesChannelId: guild.publicUpdatesChannelId || null,
    preferredLocale: guild.preferredLocale || null,
    description: guild.description || null
  };
}

/**
 * Execute a complete, zero-loss server lockdown.
 * 
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').User} adminUser
 * @param {string[]} whitelistChannelIds
 * @returns {Promise<{
 *   success: boolean,
 *   lockedCount: number,
 *   skippedCount: number,
 *   whitelistedCount: number,
 *   error?: string
 * }>}
 */
export async function executeServerLockdown(guild, adminUser, whitelistChannelIds = []) {
  if (!guild || !guild.id) return { success: false, error: 'Guild is required' };

  if (activeLockdownGuilds.has(guild.id)) {
    return { success: false, error: 'A lockdown operation is already in progress for this server.' };
  }
  if (activeUnpauseGuilds.has(guild.id)) {
    return { success: false, error: 'An unpause operation is currently in progress for this server.' };
  }

  const prereq = validateLockdownPrerequisites(guild);
  if (!prereq.valid) {
    return { success: false, error: prereq.error };
  }

  activeLockdownGuilds.add(guild.id);

  try {
    const whitelistSet = new Set((whitelistChannelIds || []).map(String));
    const settingsBackup = captureGuildSettings(guild);

    // Filter all eligible channels in the guild
    const allChannels = Array.from(guild.channels.cache.values()).filter(c => ELIGIBLE_CHANNEL_TYPES.has(c.type));
    const nonWhitelistedChannels = allChannels.filter(c => !whitelistSet.has(c.id));
    const whitelistedChannels = allChannels.filter(c => whitelistSet.has(c.id));

    // Phase 1: Full Comprehensive Pre-Pause Snapshot across all non-whitelisted channels
    const allRecordedOverwrites = [];

    for (const channel of nonWhitelistedChannels) {
      const overwritesCache = channel.permissionOverwrites?.cache;
      if (!overwritesCache) continue;

      let hasEveryoneOverwrite = false;

      for (const overwrite of overwritesCache.values()) {
        const isEveryone = String(overwrite.id) === String(guild.id);
        if (isEveryone) hasEveryoneOverwrite = true;

        allRecordedOverwrites.push({
          channel_id: channel.id,
          target_id: overwrite.id,
          target_type: overwrite.type === OverwriteType.Role ? 'role' : 'member',
          original_allow_bits: overwrite.allow.bitfield.toString(),
          original_deny_bits: overwrite.deny.bitfield.toString(),
          was_synthesized: false
        });
      }

      // If channel has no @everyone overwrite, record synthesized entry so unpause removes it cleanly
      if (!hasEveryoneOverwrite) {
        allRecordedOverwrites.push({
          channel_id: channel.id,
          target_id: guild.id,
          target_type: 'role',
          original_allow_bits: '0',
          original_deny_bits: '0',
          was_synthesized: true
        });
      }
    }

    // Phase 2: Commit snapshot atomically to PostgreSQL before touching Discord permissions
    await recordServerPauseSnapshot(guild.id, settingsBackup, allRecordedOverwrites);

    // Phase 3: Minimal Lockdown Execution
    // For each non-whitelisted channel:
    // 1. @everyone -> ViewChannel: DENY
    // 2. Roles/members with ViewChannel: ALLOW -> ViewChannel: DENY
    // 3. Roles/members with default (/) or already-denied -> IGNORE
    let lockedCount = 0;
    let skippedCount = 0;

    for (const channel of nonWhitelistedChannels) {
      try {
        const overwritesCache = channel.permissionOverwrites?.cache;
        if (!overwritesCache) {
          skippedCount++;
          continue;
        }

        // Apply @everyone: deny ViewChannel (explicitly pass type to prevent redundant member REST fetch)
        await channel.permissionOverwrites.edit(guild.id, {
          ViewChannel: false
        }, {
          type: OverwriteType.Role,
          reason: 'Server lockdown initiated by administrator'
        });

        // Apply explicit deny to any other existing overwrite that had ViewChannel allowed
        for (const overwrite of overwritesCache.values()) {
          if (String(overwrite.id) === String(guild.id)) continue;

          if (overwrite.allow.has(VIEW_CHANNEL_BIT)) {
            await channel.permissionOverwrites.edit(overwrite.id, {
              ViewChannel: false
            }, {
              type: overwrite.type,
              reason: 'Server lockdown: override allowed view permission'
            }).catch(err => {
              sysWarn(`Failed to edit overwrite for target ${overwrite.id} on channel ${channel.id}`, err);
            });
          }
        }

        lockedCount++;
        // Paced micro-sleep between channels to protect rate limit headroom
        await sleep(100);
      } catch (channelErr) {
        sysWarn(`Channel ${channel.id} skipped during lockdown execution`, channelErr);
        skippedCount++;
      }
    }

    // Phase 4: Dispatch Audit Log
    const logName = getUserLogName(adminUser);
    const whitelistSummary = whitelistedChannels.length > 0
      ? whitelistedChannels.map(c => `<#${c.id}>`).join(', ')
      : '_None_';

    sendLog(
      guild,
      'audit',
      'red',
      '🛑 Server Lockdown Activated',
      `**Admin:** \`${logName}\`\n` +
      `**Locked Channels:** \`${lockedCount}\`\n` +
      (skippedCount > 0 ? `**Skipped Channels (Errors):** \`${skippedCount}\`\n` : '') +
      `**Whitelisted Channels (${whitelistedChannels.length}):** ${whitelistSummary}\n` +
      `**Timestamp:** <t:${Math.floor(Date.now() / 1000)}:F>`
    ).catch(err => sysWarn('Failed to dispatch lockdown audit log', err));

    return {
      success: true,
      lockedCount,
      skippedCount,
      whitelistedCount: whitelistedChannels.length
    };
  } finally {
    activeLockdownGuilds.delete(guild.id);
  }
}

/**
 * Perform a pre-unpause preflight inspection.
 * Compares current live server state against the pre-pause snapshot.
 * Detects missing channels, newly created channels, modified permissions, and missing bot permissions.
 * 
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<{
 *   valid: boolean,
 *   isPaused: boolean,
 *   hasIssues: boolean,
 *   missingChannels: Array<{ id: string }>,
 *   newChannels: Array<{ id: string, name?: string }>,
 *   missingPermissions: string[],
 *   missingRoles: Array<{ id: string, channelId: string }>,
 *   driftedChannelsCount: number,
 *   totalBackedUpChannels: number,
 *   error?: string
 * }>}
 */
export async function inspectServerUnpauseState(guild) {
  if (!guild || !guild.id) {
    return { valid: false, isPaused: false, hasIssues: true, error: 'Guild is required.' };
  }

  const pauseState = await getServerPauseState(guild.id);
  const backups = await getServerChannelPermissionBackups(guild.id);

  if (!pauseState.is_paused && backups.length === 0) {
    return { valid: false, isPaused: false, hasIssues: false, error: 'This server is not currently paused.' };
  }

  // 1. Verify Bot Permissions
  const missingPermissions = [];
  const me = guild.members?.me;
  if (!me || !me.permissions?.has(PermissionFlagsBits.Administrator)) {
    missingPermissions.push('Administrator');
  }

  // 2. Identify Backed-Up Channels and Map Overwrites
  const backedUpChannelIds = new Set(backups.map(b => b.channel_id));
  const backupsByChannel = new Map();
  for (const b of backups) {
    if (!backupsByChannel.has(b.channel_id)) {
      backupsByChannel.set(b.channel_id, []);
    }
    backupsByChannel.get(b.channel_id).push(b);
  }

  const missingChannels = [];
  const missingRoles = [];
  let driftedChannelsCount = 0;

  for (const [channelId, channelBackups] of backupsByChannel.entries()) {
    let channel = guild.channels?.cache?.get(channelId);
    if (!channel && typeof guild.channels?.fetch === 'function') {
      channel = await guild.channels.fetch(channelId).catch(() => null);
    }

    if (!channel || !channel.permissionOverwrites) {
      missingChannels.push({ id: channelId });
      continue;
    }

    let channelHasDrift = false;
    for (const backup of channelBackups) {
      if (backup.target_type === 'role' && guild.roles?.cache && !guild.roles.cache.has(backup.target_id)) {
        missingRoles.push({ id: backup.target_id, channelId });
      }

      if (!backup.was_synthesized) {
        const liveOverwrite = channel.permissionOverwrites.cache?.get(backup.target_id);
        const targetAllow = BigInt(backup.original_allow_bits);
        const targetDeny = BigInt(backup.original_deny_bits);

        if (!liveOverwrite) {
          channelHasDrift = true;
        } else if (
          liveOverwrite.allow.bitfield !== targetAllow ||
          liveOverwrite.deny.bitfield !== targetDeny
        ) {
          channelHasDrift = true;
        }
      }
    }

    if (channelHasDrift) {
      driftedChannelsCount++;
    }
  }

  // 3. Identify New Channels created during the pause
  const whitelistSet = new Set(pauseState.whitelist_channel_ids || []);
  const newChannels = [];

  if (guild.channels?.cache) {
    for (const channel of guild.channels.cache.values()) {
      if (
        ELIGIBLE_CHANNEL_TYPES.has(channel.type) &&
        !whitelistSet.has(channel.id) &&
        !backedUpChannelIds.has(channel.id)
      ) {
        newChannels.push({ id: channel.id, name: channel.name });
      }
    }
  }

  const hasIssues = missingChannels.length > 0 ||
    newChannels.length > 0 ||
    missingPermissions.length > 0 ||
    missingRoles.length > 0;

  return {
    valid: true,
    isPaused: pauseState.is_paused,
    hasIssues,
    missingChannels,
    newChannels,
    missingPermissions,
    missingRoles,
    driftedChannelsCount,
    totalBackedUpChannels: backupsByChannel.size
  };
}

/**
 * Execute an unpause operation, perfectly restoring channel overwrites and server settings.
 * 
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').User} adminUser
 * @returns {Promise<{
 *   success: boolean,
 *   restoredChannelsCount: number,
 *   skippedChannelsCount: number,
 *   error?: string
 * }>}
 */
export async function executeServerUnpause(guild, adminUser) {
  if (!guild || !guild.id) return { success: false, error: 'Guild is required' };

  if (activeUnpauseGuilds.has(guild.id)) {
    return { success: false, error: 'An unpause operation is already in progress for this server.' };
  }
  if (activeLockdownGuilds.has(guild.id)) {
    return { success: false, error: 'A lockdown operation is currently in progress for this server.' };
  }

  activeUnpauseGuilds.add(guild.id);

  try {
    const pauseState = await getServerPauseState(guild.id);
    const backups = await getServerChannelPermissionBackups(guild.id);

    if (!pauseState.is_paused && backups.length === 0) {
      return { success: false, error: 'This server is not currently paused.' };
    }

    // Group backed-up overwrites by channel ID
    const backupsByChannel = new Map();
    for (const b of backups) {
      if (!backupsByChannel.has(b.channel_id)) {
        backupsByChannel.set(b.channel_id, []);
      }
      backupsByChannel.get(b.channel_id).push(b);
    }

    let restoredChannelsCount = 0;
    let skippedChannelsCount = 0;

    for (const [channelId, channelBackups] of backupsByChannel.entries()) {
      try {
        // Safe channel resolution: check cache or fetch, catch missing/deleted channel
        const channel = guild.channels.cache.get(channelId) ||
          await guild.channels.fetch(channelId).catch(() => null);

        if (!channel || !channel.permissionOverwrites) {
          sysLog(`Channel ${channelId} was deleted or is inaccessible; skipping unpause restoration`);
          skippedChannelsCount++;
          continue;
        }

        for (const backup of channelBackups) {
          try {
            if (backup.target_type === 'role' && guild.roles?.cache && !guild.roles.cache.has(backup.target_id)) {
              sysLog(`Role ${backup.target_id} was deleted during pause; skipping overwrite restoration on channel ${channelId}`);
              continue;
            }

            if (backup.was_synthesized) {
              // Synthesized @everyone overwrite was added solely for lockdown: delete it
              await channel.permissionOverwrites.delete(backup.target_id, 'Server unpause: remove temporary lockdown overwrite').catch(() => {});
            } else {
              // Pre-existing overwrite: compare live bitfields against pre-pause snapshot
              const liveOverwrite = channel.permissionOverwrites.cache.get(backup.target_id);
              const targetAllow = BigInt(backup.original_allow_bits);
              const targetDeny = BigInt(backup.original_deny_bits);

              if (liveOverwrite) {
                const liveAllow = liveOverwrite.allow.bitfield;
                const liveDeny = liveOverwrite.deny.bitfield;

                // Self-healing check: if live overwrite bitfields match snapshot, skip REST edit
                if (liveAllow === targetAllow && liveDeny === targetDeny) {
                  continue;
                }
              }

              // Restore exact original bitfields (explicitly pass type to prevent redundant member REST fetch)
              await channel.permissionOverwrites.edit(backup.target_id, {
                allow: targetAllow,
                deny: targetDeny
              }, {
                type: backup.target_type === 'role' ? OverwriteType.Role : OverwriteType.Member,
                reason: 'Server unpause: restore pre-pause channel permissions'
              });
            }
          } catch (overwriteErr) {
            sysWarn(`Failed to restore overwrite for target ${backup.target_id} on channel ${channelId}`, overwriteErr);
          }
        }

        restoredChannelsCount++;
        await sleep(100);
      } catch (channelErr) {
        sysWarn(`Error restoring channel ${channelId}`, channelErr);
        skippedChannelsCount++;
      }
    }

    // Restore guild configuration settings if available (only apply if mutated)
    if (pauseState.server_settings_backup && typeof pauseState.server_settings_backup === 'object') {
      try {
        const sb = pauseState.server_settings_backup;
        const editPayload = {};

        if (sb.name && sb.name !== guild.name) editPayload.name = sb.name;
        if (sb.verificationLevel !== null && sb.verificationLevel !== undefined && sb.verificationLevel !== guild.verificationLevel) {
          editPayload.verificationLevel = sb.verificationLevel;
        }
        if (sb.defaultMessageNotifications !== null && sb.defaultMessageNotifications !== undefined && sb.defaultMessageNotifications !== guild.defaultMessageNotifications) {
          editPayload.defaultMessageNotifications = sb.defaultMessageNotifications;
        }
        if (sb.explicitContentFilter !== null && sb.explicitContentFilter !== undefined && sb.explicitContentFilter !== guild.explicitContentFilter) {
          editPayload.explicitContentFilter = sb.explicitContentFilter;
        }
        if (sb.afkChannelId !== undefined && sb.afkChannelId !== guild.afkChannelId) {
          editPayload.afkChannel = sb.afkChannelId;
        }
        if (sb.afkTimeout !== undefined && sb.afkTimeout !== guild.afkTimeout) {
          editPayload.afkTimeout = sb.afkTimeout;
        }
        if (sb.systemChannelId !== undefined && sb.systemChannelId !== guild.systemChannelId) {
          editPayload.systemChannel = sb.systemChannelId;
        }
        if (sb.systemChannelFlags !== undefined && sb.systemChannelFlags !== null && guild.systemChannelFlags && guild.systemChannelFlags.bitfield.toString() !== String(sb.systemChannelFlags)) {
          editPayload.systemChannelFlags = new SystemChannelFlagsBitField(BigInt(sb.systemChannelFlags));
        }

        if (Object.keys(editPayload).length > 0) {
          await guild.edit(editPayload, 'Server unpause: restore server settings').catch(err => {
            sysWarn('Guild settings restore partial failure (non-fatal)', err);
          });
        }
      } catch (settingsErr) {
        sysWarn('Guild settings restoration failed (non-fatal)', settingsErr);
      }
    }

    // Clear backups and set is_paused = FALSE in PostgreSQL
    await clearServerPauseSnapshot(guild.id);

    // Dispatch Unpause Audit Log
    const logName = getUserLogName(adminUser);
    sendLog(
      guild,
      'audit',
      'green',
      '🟢 Server Lockdown Deactivated',
      `**Admin:** \`${logName}\`\n` +
      `**Restored Channels:** \`${restoredChannelsCount}\`\n` +
      (skippedChannelsCount > 0 ? `**Skipped Channels (Deleted/Inaccessible):** \`${skippedChannelsCount}\`\n` : '') +
      `**Timestamp:** <t:${Math.floor(Date.now() / 1000)}:F>`
    ).catch(err => sysWarn('Failed to dispatch unpause audit log', err));

    return {
      success: true,
      restoredChannelsCount,
      skippedChannelsCount
    };
  } finally {
    activeUnpauseGuilds.delete(guild.id);
  }
}
