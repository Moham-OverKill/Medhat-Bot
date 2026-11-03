import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

test('Zero hardcoded chest, box, or lootbox terms in user-facing texts', async () => {
  const forbiddenWords = ['chest', 'chests', 'box', 'boxes', 'lootbox', 'lootboxes', 'loot box', 'loot boxes'];
  const regex = new RegExp(`\\b(${forbiddenWords.join('|')})\\b`, 'i');

  const srcDir = path.resolve('src');
  const violations = [];

  function scanDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.js')) {
        const relativePath = path.relative(srcDir, fullPath).replace(/\\/g, '/');
        const content = fs.readFileSync(fullPath, 'utf8');
        const lines = content.split('\n');

        lines.forEach((line, index) => {
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return;

          // 1. Fallback strings in user-facing logic
          if (
            trimmed.includes("|| 'Chests'") ||
            trimmed.includes('|| "Chests"') ||
            trimmed.includes("|| 'Chest'") ||
            trimmed.includes('|| "Chest"') ||
            trimmed.includes("|| 'Loot Boxes'") ||
            trimmed.includes('|| "Loot Boxes"') ||
            trimmed.includes("|| 'Loot Box'") ||
            trimmed.includes('|| "Loot Box"')
          ) {
            violations.push({
              file: relativePath,
              line: index + 1,
              reason: 'Hardcoded chest/box fallback string detected',
              code: trimmed
            });
            return;
          }

          // 2. User-facing method calls (Embeds, Messages, Buttons, Select Menus, Modals)
          const isUserFacingMethod =
            /setTitle\s*\(\s*['"`]([^'"`]+)['"`]\)/i.exec(line) ||
            /setDescription\s*\(\s*['"`]([^'"`]+)['"`]\)/i.exec(line) ||
            /setPlaceholder\s*\(\s*['"`]([^'"`]+)['"`]\)/i.exec(line) ||
            /setLabel\s*\(\s*['"`]([^'"`]+)['"`]\)/i.exec(line) ||
            /content:\s*['"`]([^'"`]+)['"`]/i.exec(line) ||
            /error:\s*['"`]([^'"`]+)['"`]/i.exec(line) ||
            /sendLog\s*\([^,]+,[^,]+,[^,]+,\s*['"`]([^'"`]+)['"`]/i.exec(line) ||
            /sendLog\s*\([^,]+,[^,]+,[^,]+,[^,]+,\s*['"`]([^'"`]+)['"`]/i.exec(line);

          if (isUserFacingMethod) {
            const strVal = isUserFacingMethod[1];
            // Strip JS template interpolations like ${box.name} so variable names aren't mistaken for text
            const textOnly = strVal.replace(/\${[^}]+}/g, '');
            if (regex.test(textOnly)) {
              violations.push({
                file: relativePath,
                line: index + 1,
                reason: `User-facing text contains forbidden term: "${strVal}"`,
                code: trimmed
              });
            }
          }
        });
      }
    }
  }

  scanDir(srcDir);

  if (violations.length > 0) {
    console.error(`Found ${violations.length} forbidden naming violations:`);
    violations.forEach(v => {
      console.error(`- [${v.file}:${v.line}] ${v.reason}\n    ${v.code}`);
    });
  }

  assert.equal(violations.length, 0, `Expected 0 violations, found ${violations.length}`);
});
