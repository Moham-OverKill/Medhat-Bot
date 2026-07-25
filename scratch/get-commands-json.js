import { bankCommand } from '../src/commands/bank.js';
import { inventoryCommand } from '../src/commands/inventory.js';
import { itemMassCommand } from '../src/commands/item-mass.js';
import { settingsCommand } from '../src/commands/settings.js';
import { data as questCommand } from '../src/commands/quest.js';
import { tradeCommand } from '../src/commands/trade.js';
import { voteCommand } from '../src/commands/vote.js';
import fs from 'fs/promises';

const commands = [
  settingsCommand.toJSON(),
  bankCommand.toJSON(),
  inventoryCommand.toJSON(),
  itemMassCommand.toJSON(),
  questCommand.toJSON(),
  tradeCommand.toJSON(),
  voteCommand.toJSON()
];

await fs.writeFile('scratch/commands.json', JSON.stringify(commands, null, 2), 'utf8');
console.log('Commands JSON written to scratch/commands.json successfully!');
