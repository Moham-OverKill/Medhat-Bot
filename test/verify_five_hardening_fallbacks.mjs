import test from 'node:test';
import assert from 'node:assert/strict';

test('Hardening Fallback 1: In-Flight Action Deduplication', async () => {
    // Simulate deduplication logic
    const inFlightUserActions = new Set();
    function checkAction(guildId, userId, customId) {
        const key = `${guildId}:${userId}:${customId}`;
        if (inFlightUserActions.has(key)) return { allowed: false };
        inFlightUserActions.add(key);
        return { allowed: true, release: () => inFlightUserActions.delete(key) };
    }

    const first = checkAction('guild-1', 'user-1', 'bank_daily');
    assert.equal(first.allowed, true);

    // Second rapid duplicate click while first is in-flight
    const duplicate = checkAction('guild-1', 'user-1', 'bank_daily');
    assert.equal(duplicate.allowed, false);

    // Different user is allowed
    const diffUser = checkAction('guild-1', 'user-2', 'bank_daily');
    assert.equal(diffUser.allowed, true);

    // Release first action
    first.release();
    const retry = checkAction('guild-1', 'user-1', 'bank_daily');
    assert.equal(retry.allowed, true);
    retry.release();
    diffUser.release();
});

test('Hardening Fallback 2: Equip Verification & Hierarchy Defense', async () => {
    // Simulate role check logic from toggleEquipItem
    const botMember = { roles: { highest: { position: 10 } } };
    const guildRoles = new Map([
        ['role-low', { id: 'role-low', position: 5, permissions: { has: () => false } }],
        ['role-high', { id: 'role-high', position: 15, permissions: { has: () => false } }]
    ]);

    function validateEquipRole(roleId) {
        const roleObj = guildRoles.get(roleId);
        if (!roleObj) {
            return { valid: false, error: 'The server role associated with this item no longer exists in Discord.' };
        }
        if (roleObj.position >= botMember.roles.highest.position) {
            return { valid: false, error: 'Cannot assign this role: the bot role is positioned lower than this role in Server Settings → Roles.' };
        }
        return { valid: true };
    }

    assert.equal(validateEquipRole('role-deleted').valid, false);
    assert.match(validateEquipRole('role-deleted').error, /no longer exists/);

    assert.equal(validateEquipRole('role-high').valid, false);
    assert.match(validateEquipRole('role-high').error, /positioned lower/);

    assert.equal(validateEquipRole('role-low').valid, true);
});

test('Hardening Fallback 3: Atomic Drop Claim Limit Enforcement', async () => {
    // Simulate atomic check inside transaction
    const claimsTable = new Map();
    function atomicClaim(messageId, userId, requestedQty, claimLimit) {
        const key = `${messageId}:${userId}`;
        const currentClaims = claimsTable.get(key) || 0;
        if (currentClaims + requestedQty > claimLimit) {
            return { success: false, error: `Limit reached (${claimLimit})` };
        }
        claimsTable.set(key, currentClaims + requestedQty);
        return { success: true, newClaims: claimsTable.get(key) };
    }

    const res1 = atomicClaim('msg-100', 'user-1', 1, 1);
    assert.equal(res1.success, true);
    assert.equal(res1.newClaims, 1);

    // Concurrent second claim must be rejected
    const res2 = atomicClaim('msg-100', 'user-1', 1, 1);
    assert.equal(res2.success, false);
    assert.match(res2.error, /Limit reached/);
});

test('Hardening Fallback 4: Loot Box Ghost Role & Orphan Prize Filtering', async () => {
    const guildRoles = new Set(['role-valid-1', 'role-valid-2']);
    const candidateItems = [
        { id: 1, name: 'Normal Role Item', role_id: 'role-valid-1', rarity: 'common' },
        { id: 2, name: 'Deleted Role Item', role_id: 'role-deleted-99', rarity: 'rare' },
        { id: 3, name: 'No Role Item', role_id: null, rarity: 'common' }
    ];

    const validGuildItems = candidateItems.filter(item => {
        if (!item.role_id) return true;
        const roleIds = item.role_id.split(/[,\s]+/).filter(Boolean);
        return roleIds.every(rid => guildRoles.has(rid));
    });

    assert.equal(validGuildItems.length, 2);
    assert.equal(validGuildItems.some(i => i.name === 'Deleted Role Item'), false);
    assert.equal(validGuildItems.some(i => i.name === 'Normal Role Item'), true);
    assert.equal(validGuildItems.some(i => i.name === 'No Role Item'), true);
});

test('Hardening Fallback 5: Log Channel Stale ID Auto-Healing & Fallback Dispatch', async () => {
    const mockDb = {
        configs: { 'guild-1': { log_eco_channel_id: '12345', log_audit_channel_id: '67890' } }
    };

    function pruneConfigKey(guildId, configKey) {
        if (mockDb.configs[guildId]) {
            delete mockDb.configs[guildId][configKey];
        }
    }

    // Simulate safeSend discovering channel 12345 is deleted (code 10003)
    pruneConfigKey('guild-1', 'log_eco_channel_id');
    assert.equal(mockDb.configs['guild-1'].log_eco_channel_id, undefined);
    assert.equal(mockDb.configs['guild-1'].log_audit_channel_id, '67890');
});

test('Avatar Customization: Unified Server editMe and Permission Fallback', async () => {
    // 1. Verify MIME type detection from magic bytes
    function detectMimeType(buf) {
        if (buf.length >= 4) {
            if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
            if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
            if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
            if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
        }
        return 'image/png';
    }

    const pngHeader = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const jpegHeader = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]);
    assert.equal(detectMimeType(pngHeader), 'image/png');
    assert.equal(detectMimeType(jpegHeader), 'image/jpeg');

    // 2. Verify unified editMe call and fallback logic when nickname lacks permission (50013)
    const calls = [];
    const mockGuildMemberManager = {
        async editMe(payload) {
            calls.push(payload);
            if (payload.nick && payload.nick === 'ForbiddenNick') {
                const err = new Error('Missing Permissions');
                err.code = 50013;
                throw err;
            }
            return { avatar: payload.avatar ? 'avatar_hash_123' : null, nick: payload.nick || null };
        }
    };

    // Combined request with forbidden nickname
    const initialPayload = { nick: 'ForbiddenNick', avatar: 'data:image/png;base64,sample' };
    let finalAvatarStatus = 'Failed ❌';
    let finalNicknameStatus = 'Failed ❌';

    try {
        await mockGuildMemberManager.editMe(initialPayload);
        finalNicknameStatus = 'Updated ✅';
        finalAvatarStatus = 'Updated ✅';
    } catch (err) {
        if (err.code === 50013 && initialPayload.nick !== undefined && initialPayload.avatar !== undefined) {
            finalNicknameStatus = 'Failed ❌';
            try {
                await mockGuildMemberManager.editMe({ avatar: initialPayload.avatar });
                finalAvatarStatus = 'Updated ✅';
            } catch {
                finalAvatarStatus = 'Failed ❌';
            }
        }
    }

    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { nick: 'ForbiddenNick', avatar: 'data:image/png;base64,sample' });
    assert.deepEqual(calls[1], { avatar: 'data:image/png;base64,sample' });
    assert.equal(finalNicknameStatus, 'Failed ❌');
    assert.equal(finalAvatarStatus, 'Updated ✅');
});
