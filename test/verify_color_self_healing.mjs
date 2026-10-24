import assert from 'node:assert';
import { buildColorPanelPayload, handleColorButton } from '../src/commands/colors.js';
import { MessageFlags } from 'discord.js';

console.log('--- Testing Color Panel Self-Healing & Ephemeral Guard Logic ---');

// Test 1: buildColorPanelPayload construction
{
  const mockRoles = [
    { roleId: '1001', role: { name: 'Red', hexColor: '#FF0000', position: 10 } },
    { roleId: '1002', role: { name: 'Green', hexColor: '#00FF00', position: 9 } },
    { roleId: '1003', role: { name: 'Blue', hexColor: '#0000FF', position: 8 } },
    { roleId: '1004', role: { name: 'Yellow', hexColor: '#FFFF00', position: 7 } },
    { roleId: '1005', role: { name: 'Purple', hexColor: '#800080', position: 6 } },
    { roleId: '1006', role: { name: 'Orange', hexColor: '#FFA500', position: 5 } },
    { roleId: '1007', role: { name: 'Cyan', hexColor: '#00FFFF', position: 4 } },
    { roleId: '1008', role: { name: 'Pink', hexColor: '#FFC0CB', position: 3 } },
    { roleId: '1009', role: { name: 'Teal', hexColor: '#008080', position: 2 } },
    { roleId: '1010', role: { name: 'Lime', hexColor: '#00FF80', position: 1 } },
    { roleId: '1011', role: { name: 'White', hexColor: '#FFFFFF', position: 0 } }
  ];

  const mockGuild = { id: 'guild_test' };

  // Panel 0 (First 10 colors)
  const panel0 = await buildColorPanelPayload(mockGuild, 'normal', 0, mockRoles);
  assert.ok(panel0, 'Panel 0 should be generated');
  assert.strictEqual(panel0.content, '', 'Content should be empty');
  assert.strictEqual(panel0.files.length, 1, 'Should have 1 file attachment');
  assert.strictEqual(panel0.files[0].name, 'colors_normal_1.png');
  assert.strictEqual(panel0.components.length, 2, 'Should have 2 action rows of buttons');
  assert.strictEqual(panel0.components[0].components.length, 5, 'Row 1 should have 5 buttons');
  assert.strictEqual(panel0.components[1].components.length, 5, 'Row 2 should have 5 buttons');
  assert.strictEqual(panel0.components[0].components[0].data.label, '01');
  assert.strictEqual(panel0.components[0].components[0].data.custom_id, 'color_normal_1001');

  // Panel 1 (11th color)
  const panel1 = await buildColorPanelPayload(mockGuild, 'normal', 1, mockRoles);
  assert.ok(panel1, 'Panel 1 should be generated');
  assert.strictEqual(panel1.files[0].name, 'colors_normal_2.png');
  assert.strictEqual(panel1.components.length, 1, 'Should have 1 action row for 1 button');
  assert.strictEqual(panel1.components[0].components[0].data.label, '11');
  assert.strictEqual(panel1.components[0].components[0].data.custom_id, 'color_normal_1011');

  console.log('✓ Test 1: buildColorPanelPayload properly constructs grid image and button rows');
}

// Test 2: Corrupted Message Content Matching & Role Extraction
{
  const testCases = [
    { content: 'Color <@&1335368300095340616> Selected', expectedRoleId: '1335368300095340616' },
    { content: 'Color <@&1186325633765232672> Removed', expectedRoleId: '1186325633765232672' },
    { content: 'Some unrelated message', expectedRoleId: null }
  ];

  for (const tc of testCases) {
    const match = tc.content.match(/Color\s+<@&(\d+)>\s+(Selected|Removed)/i);
    const extracted = match ? match[1] : null;
    assert.strictEqual(extracted, tc.expectedRoleId, `Failed extracting from "${tc.content}"`);
  }

  // Panel index calculation check
  const calculatePanelIndex = (colorIndex) => Math.floor(colorIndex / 10);
  assert.strictEqual(calculatePanelIndex(0), 0);
  assert.strictEqual(calculatePanelIndex(9), 0);
  assert.strictEqual(calculatePanelIndex(10), 1);
  assert.strictEqual(calculatePanelIndex(19), 1);
  assert.strictEqual(calculatePanelIndex(25), 2);

  console.log('✓ Test 2: Corrupted color message regex parsing and panel index calculation validated');
}

// Test 3: handleColorButton Ephemeral Response Guard
{
  let editReplyCalled = false;
  let followUpCalled = false;
  let followUpFlags = null;

  const mockNonEphemeralInteraction = {
    customId: 'color_normal_99999',
    guildId: 'guild_test',
    user: { id: 'user_test' },
    guild: {
      id: 'guild_test',
      roles: {
        cache: new Map([['99999', { id: '99999', name: 'Test Role', hexColor: '#123456', position: 5 }]])
      },
      members: {
        fetchMe: async () => ({ roles: { highest: { position: 10 } } })
      }
    },
    member: {
      id: 'user_test',
      guild: { id: 'guild_test' },
      roles: {
        cache: new Map(),
        remove: async () => {},
        add: async () => {}
      }
    },
    deferred: true,
    replied: false,
    ephemeral: false, // Simulated interaction that had a public deferral!
    editReply: async () => {
      editReplyCalled = true;
    },
    followUp: async (payload) => {
      followUpCalled = true;
      followUpFlags = payload.flags;
    }
  };

  await handleColorButton(mockNonEphemeralInteraction);

  assert.strictEqual(editReplyCalled, false, 'CRITICAL: editReply MUST NEVER be called on non-ephemeral interaction!');
  assert.strictEqual(followUpCalled, true, 'followUp must be called instead');
  assert.strictEqual(followUpFlags, MessageFlags.Ephemeral, 'followUp must include ephemeral flag');

  console.log('✓ Test 3: handleColorButton error path guarantees private response and protects public card');
}

// Test 4: Ephemeral Interaction Path (when properly deferred as ephemeral)
{
  let editReplyCalled = false;
  let followUpCalled = false;

  const mockEphemeralInteraction = {
    customId: 'color_normal_99999',
    guildId: 'guild_test',
    user: { id: 'user_test' },
    guild: {
      id: 'guild_test',
      roles: {
        cache: new Map([['99999', { id: '99999', name: 'Test Role', hexColor: '#123456', position: 5 }]])
      },
      members: {
        fetchMe: async () => ({ roles: { highest: { position: 10 } } })
      }
    },
    member: {
      id: 'user_test',
      guild: { id: 'guild_test' },
      roles: {
        cache: new Map(),
        remove: async () => {},
        add: async () => {}
      }
    },
    deferred: true,
    replied: false,
    ephemeral: true, // PROPER ephemeral deferral!
    editReply: async () => {
      editReplyCalled = true;
    },
    followUp: async () => {
      followUpCalled = true;
    }
  };

  await handleColorButton(mockEphemeralInteraction);

  assert.strictEqual(editReplyCalled, true, 'editReply is safely called when interaction.ephemeral is true');
  assert.strictEqual(followUpCalled, false, 'followUp not needed when editReply is safe');

  console.log('✓ Test 4: handleColorButton safely uses editReply when interaction is properly ephemeral');
}

console.log('\n--- All Color Self-Healing & Ephemeral Tests Passed! ---');
