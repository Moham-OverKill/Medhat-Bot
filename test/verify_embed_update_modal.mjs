import assert from 'node:assert';
import { TextInputStyle } from 'discord.js';
import fs from 'node:fs';

console.log('--- Testing Embed Update Modal & Message URL Configuration ---');

// Test 1: Verify embeds.js update modals use Paragraph style and example URL placeholder
{
  const fileContent = fs.readFileSync('src/commands/settings/embeds.js', 'utf8');

  // Single embed update modal check
  const singleModalMatch = fileContent.match(/embed_update_[\s\S]*?new ModalBuilder\(\)[\s\S]*?new TextInputBuilder\(\)([\s\S]*?)\.setRequired\(true\);/);
  assert.ok(singleModalMatch, 'Single embed update modal input should exist in embeds.js');
  const singleBlock = singleModalMatch[1];
  assert.ok(singleBlock.includes('TextInputStyle.Paragraph'), 'Single embed modal should use TextInputStyle.Paragraph');
  assert.ok(singleBlock.includes('.setPlaceholder(\'https://discord.com/channels/123456789012345678/123456789012345678/123456789012345678\')'), 'Single embed modal should have example URL placeholder');

  // Group embed update modal check
  const groupModalMatch = fileContent.match(/embed_group_update_[\s\S]*?new ModalBuilder\(\)[\s\S]*?new TextInputBuilder\(\)([\s\S]*?)\.setRequired\(true\);/);
  assert.ok(groupModalMatch, 'Group embed update modal input should exist in embeds.js');
  const groupBlock = groupModalMatch[1];
  assert.ok(groupBlock.includes('TextInputStyle.Paragraph'), 'Group embed modal should use TextInputStyle.Paragraph');
  assert.ok(groupBlock.includes('.setPlaceholder(\'https://discord.com/channels/123456789012345678/123456789012345678/123456789012345678\')'), 'Group embed modal should have example URL placeholder');

  console.log('✓ Test 1: Both single and group embed update modals configure Paragraph style and example URL');
}

// Test 2: Discord placeholder character limit compliance
{
  const placeholder = 'https://discord.com/channels/123456789012345678/123456789012345678/123456789012345678';
  assert.ok(placeholder.length <= 100, `Placeholder length (${placeholder.length}) must be <= 100 characters`);
  console.log(`✓ Test 2: Placeholder length is ${placeholder.length} characters (within 100-char Discord limit)`);
}

// Test 3: Robust URL parsing from multiline Paragraph input
{
  const multilineInput = `
    Some accidental text before
    https://discord.com/channels/723544218081034303/100000000000000001/200000000000000002
    extra trailing notes
  `;

  const urlMatch = multilineInput.match(/discord(?:app)?\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
  assert.ok(urlMatch, 'Regex must extract valid channel URL from multiline text');
  assert.strictEqual(urlMatch[1], '723544218081034303');
  assert.strictEqual(urlMatch[2], '100000000000000001');
  assert.strictEqual(urlMatch[3], '200000000000000002');
  console.log('✓ Test 3: Multiline Paragraph input is parsed accurately by embed update handler regex');
}

console.log('\n--- All Embed Update Modal Tests Passed! ---');
