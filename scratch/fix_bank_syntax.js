import fs from 'fs';
const path = 'e:/Programs/Projects/Code/mvp discord bot/src/commands/bank.js';
let content = fs.readFileSync(path, 'utf8');
content = content.replace(
    'content: ❌ You do not currently meet the requirements to equip this item!,',
    'content: `❌ You do not currently meet the requirements to equip this item!`, '
);
fs.writeFileSync(path, content, 'utf8');
console.log('Fixed syntax error in bank.js');
