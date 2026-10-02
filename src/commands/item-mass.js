import { 
  SlashCommandBuilder, 
  PermissionFlagsBits, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import { getShopCategories, getShopItems, getShopItem, updateShopItem, addShopItem, addShopCategory, validateRoleUniqueness } from '../economy/shop.js';
import { getLootBoxCategoryName } from '../economy/lootbox.js';
import { getTradableOptions } from './shop-setup.js';
import { query } from '../storage/postgres.js';
import { handleInteractionError } from '../utils/errors.js';
import { addColorRole, removeColorRole } from '../storage/colors.js';
import { isMemberBooster } from './colors.js';
import { hasAnyDangerousPermission } from './colors.js';
import { logServerEvent, sendBulkLog, sysError } from '../utils/logger.js';
import { getUserDisplayName, getUserLogName, isValidEconomyAmount, parseSelectEmoji, RARITY_OPTIONS } from '../shared.js';
import { buildPaginatedSelectMenu } from '../utils/paginator.js';

// Temporary storage: guildId:userId -> input_ids
const pendingMassOps = new Map();
function getMassKey(guildId, userId) {
    return `${guildId}:${userId}`;
}

export const itemMassCommand = new SlashCommandBuilder()
  .setName('mass')
  .setDescription('Bulk operations')
  .setDMPermission(false)
  .addSubcommand(sub => 
    sub.setName('item')
       .setDescription('Bulk populate Shop Packs or Categories with Items')
       .addStringOption(option => 
         option.setName('input')
               .setDescription('Role IDs separated by space, comma, or newline')
               .setRequired(true)
       )
  )
  .addSubcommand(sub =>
    sub.setName('color')
       .setDescription('Bulk add or remove color roles')
       .addStringOption(option =>
         option.setName('mode')
               .setDescription('Operation mode')
               .setRequired(true)
               .addChoices(
                 { name: 'Add', value: 'add' },
                 { name: 'Remove', value: 'remove' }
               )
       )
       .addStringOption(option =>
         option.setName('type')
               .setDescription('Type of colors')
               .setRequired(true)
               .addChoices(
                 { name: 'Normal Colors', value: 'normal' },
                 { name: 'Booster Colors', value: 'booster' }
               )
       )
       .addStringOption(option =>
         option.setName('roles')
               .setDescription('Role IDs separated by space, comma, or hyphen')
               .setRequired(true)
       )
  );

export async function handleItemMassCommand(interaction) {
  try {
    const { verifyAdminAccess } = await import('../storage/admins.js');
    if (!(await verifyAdminAccess(interaction))) return;

    // Verify subcommand (in case we add more)
    const sub = interaction.options.getSubcommand();
    
    if (sub === 'item') {
        await handleMassItemSubcommand(interaction);
    } else if (sub === 'color') {
        await handleMassColorSubcommand(interaction);
    }
  } catch (error) {
    await handleInteractionError(interaction, error, 'mass command');
  }
}

async function handleMassItemSubcommand(interaction) {
    const input = interaction.options.getString('input');
    // Price is no longer set during mass import — must be set at post time.
    
    // Validate input (basic check)
    // Allow generic separators
    const rawIds = input.split(/[\s,]+/).filter(id => /^\d{17,20}$/.test(id));
    const ids = [...new Set(rawIds)];
    
    if (ids.length === 0) {
      return interaction.reply({ content: '❌ No valid Role IDs found in input.', flags: MessageFlags.Ephemeral });
    }
    
    // Init State
    pendingMassOps.set(getMassKey(interaction.guildId, interaction.user.id), {
        ids: ids,
        categoryId: null,
        packId: null,
        rarity: 'common',
        is_tradable: true,
        price: null,  // Always null - set at post time
        categoryPage: 1,
        packPage: 1
    });
    
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await renderMassPanel(interaction, interaction.user.id);
}

// --- Mass Item Logic ---

async function renderMassPanel(interaction, userId) {
    const state = pendingMassOps.get(getMassKey(interaction.guildId, userId));
    if (!state) {
        try {
             await interaction.editReply({ files: [], content: '❌ Session expired. Please run /mass item again.', components: [] });
        } catch (e) {
             if (!interaction.replied) await interaction.followUp({ content: '❌ Session expired.', flags: MessageFlags.Ephemeral });
        }
        return;
    }

    const { ids, categoryId, packId } = state;

    // Fetch Data
    const categories = await getShopCategories(interaction.guildId);
    const packs = (await getShopItems(interaction.guildId, null, 'name', true))
        .filter(i => i.item_type === 'pack' || i.is_pack);

    const components = [];

    // Row 1: Category Select (Paginated)
    const catPage = state.categoryPage || 1;
    const allCatItems = [
        { id: 'null', name: 'No Category (Default)', isDefaultNull: true },
        ...categories
    ];
    const selectedCategory = categories.find(c => c.id.toString() === categoryId);
    const catPlaceholder = selectedCategory
        ? `Category: ${selectedCategory.name.slice(0, 80)}`
        : (categoryId ? 'Select Category (Optional)' : 'Category: None (Standalone)');

    const { selectMenu: catSelect } = buildPaginatedSelectMenu({
        items: allCatItems,
        page: catPage,
        customId: 'mass_select_category',
        placeholder: catPlaceholder,
        pageSize: 23,
        pageNavPrefix: 'mass_cat_page_',
        mapOption: (item) => {
            if (item.isDefaultNull) {
                return {
                    label: item.name,
                    value: 'null',
                    emoji: '🏷️',
                    description: 'Create as standalone items',
                    default: categoryId === null
                };
            }
            return {
                label: item.name.slice(0, 100),
                value: item.id.toString(),
                emoji: '📂',
                default: categoryId === item.id.toString()
            };
        }
    });
    components.push(new ActionRowBuilder().addComponents(catSelect));

    // Row 2: Pack Select (Paginated)
    const packPage = state.packPage || 1;
    const allPackItems = [
        { id: 'null', name: 'No Pack (Default)', isDefaultNull: true },
        ...packs
    ];
    const selectedPack = packs.find(p => p.id.toString() === packId);
    const packPlaceholder = selectedPack
        ? `Pack: ${selectedPack.name.slice(0, 80)}`
        : (packId ? 'Select Pack (Optional)' : 'Pack: None');

    const { selectMenu: packSelect } = buildPaginatedSelectMenu({
        items: allPackItems,
        page: packPage,
        customId: 'mass_select_pack',
        placeholder: packPlaceholder,
        pageSize: 23,
        pageNavPrefix: 'mass_pack_page_',
        mapOption: (item) => {
            if (item.isDefaultNull) {
                return {
                    label: item.name,
                    value: 'null',
                    emoji: '🏷️',
                    description: 'Do not add to any pack',
                    default: packId === null
                };
            }
            return {
                label: item.name.slice(0, 100),
                value: item.id.toString(),
                emoji: '📦',
                description: `ID: ${item.id}`,
                default: packId === item.id.toString()
            };
        }
    });
    components.push(new ActionRowBuilder().addComponents(packSelect));

    // Row 3: Rarity Select
    const { rarity: currentRarity, is_tradable: currentTradable } = state;
    const raritySelect = new StringSelectMenuBuilder()
        .setCustomId('mass_select_rarity')
        .setPlaceholder('Rarity')
        .addOptions(RARITY_OPTIONS.map(o => ({
            label: o.label,
            value: o.value,
            emoji: parseSelectEmoji(o.emoji, interaction.guild),
            default: o.value === currentRarity
        })));
    components.push(new ActionRowBuilder().addComponents(raritySelect));

    // Row 4: Status Select
    const lootBoxCatName = await getLootBoxCategoryName(interaction.guildId);
    const tradableOptions = getTradableOptions(lootBoxCatName);
    const tradableSelect = new StringSelectMenuBuilder()
        .setCustomId('mass_select_tradable')
        .setPlaceholder('Status')
        .addOptions(tradableOptions.map(o => ({ ...o, default: (o.value === 'tradable') === currentTradable })));
    components.push(new ActionRowBuilder().addComponents(tradableSelect));

    // Row 5: Buttons
    const buttonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('mass_create_cat_start')
            .setLabel('Create Category')
            .setEmoji('➕')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('mass_create_pack_start')
            .setLabel('Create Pack')
            .setEmoji('📦')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('mass_save')
            .setLabel('Save & Create Items')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Success)
    );

    components.push(buttonRow);

    const content = `Found **${ids.length}** Role IDs.\nConfigure how you want to import them:`;
    
    await interaction.editReply({ files: [], content, components, embeds: [] });
}

// --- Handlers ---

export async function handleMassSelect(interaction) {
    await interaction.deferUpdate();
    const userId = interaction.user.id;
    const state = pendingMassOps.get(getMassKey(interaction.guildId, userId));
    
    if (!state) return interaction.editReply({ files: [], content: '❌ Session expired.', components: [] });

    const value = interaction.values[0];
    
    if (interaction.customId === 'mass_select_category') {
        if (value.startsWith('mass_cat_page_')) {
            state.categoryPage = parseInt(value.replace('mass_cat_page_', ''), 10) || 1;
        } else {
            state.categoryId = value === 'null' ? null : value;
        }
    } else if (interaction.customId === 'mass_select_pack') {
        if (value.startsWith('mass_pack_page_')) {
            state.packPage = parseInt(value.replace('mass_pack_page_', ''), 10) || 1;
        } else {
            state.packId = value === 'null' ? null : value;
        }
    } else if (interaction.customId === 'mass_select_rarity') {
        state.rarity = value;
    } else if (interaction.customId === 'mass_select_tradable') {
        state.is_tradable = value === 'tradable';
    }
    
    await renderMassPanel(interaction, userId);
}

export async function handleMassCreateStandalone(interaction) {
    await interaction.deferUpdate();
    const userId = interaction.user.id;
    const state = pendingMassOps.get(getMassKey(interaction.guildId, userId));
    
    if (!state) return interaction.editReply({ files: [], content: '❌ Session expired.', components: [] });

    // Reset to standalone
    state.categoryId = null;
    state.packId = null;
    
    await renderMassPanel(interaction, userId);
}

export async function handleMassCreateStart(interaction) {
    const type = interaction.customId === 'mass_create_cat_start' ? 'category' : 'pack';
    
    const modal = new ModalBuilder()
        .setCustomId(`mass_modal_create_${type}`)
        .setTitle(`Create New ${type === 'category' ? 'Category' : 'Pack'}`);

    const nameInput = new TextInputBuilder()
        .setCustomId('name')
        .setLabel('Name')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
        
    const row = new ActionRowBuilder().addComponents(nameInput);
    
    if (type === 'pack') {
        const priceInput = new TextInputBuilder()
            .setCustomId('price')
            .setLabel('Price (Optional)')
            .setPlaceholder('Leave blank for Warehouse / unposted')
            .setStyle(TextInputStyle.Short)
            .setRequired(false);
        modal.addComponents(row, new ActionRowBuilder().addComponents(priceInput));
    } else {
        modal.addComponents(row);
    }
    
    await interaction.showModal(modal);
}

export async function handleMassModalSubmit(interaction) {
    const parts = interaction.customId.split('_');
    const type = parts[3]; 
    const userId = interaction.user.id;
    
    await interaction.deferUpdate();
    
    const state = pendingMassOps.get(getMassKey(interaction.guildId, userId));
    if (!state) return interaction.followUp({ content: '❌ Session expired.', flags: MessageFlags.Ephemeral });

    const name = interaction.fields.getTextInputValue('name');
    
    try {
        if (type === 'category') {
             const cat = await addShopCategory(interaction.guildId, name);
             state.categoryId = cat.id.toString();
        } else {
             const priceInput = interaction.fields.getTextInputValue('price')?.trim();
             let price = null;
             if (priceInput && priceInput.length > 0) {
                 if (!isValidEconomyAmount(priceInput, false)) {
                     return interaction.followUp({ content: '❌ Invalid price. Maximum allowed is **700,000,000,000**.', flags: MessageFlags.Ephemeral });
                 }
                 price = parseInt(priceInput, 10);
             }
             const pack = await addShopItem(interaction.guildId, null, '', name, '', price, null, null, 'pack');
             state.packId = pack.id.toString();
        }
        
        await renderMassPanel(interaction, userId);
        
    } catch (error) {
        sysError(`Mass create ${type} failed`, error, { user: interaction.user.id, guild: interaction.guildId });
        await interaction.followUp({ content: `❌ Failed to create ${type}.`, flags: MessageFlags.Ephemeral });
    }
}

export async function handleMassSave(interaction) {
    await interaction.deferUpdate();
    const userId = interaction.user.id;
    const state = pendingMassOps.get(getMassKey(interaction.guildId, userId));
    
    if (!state) return interaction.editReply({ files: [], content: '❌ Session expired.', components: [] });
    
    const { ids, categoryId, packId, rarity, is_tradable, price } = state;
    
    try {
        let created = 0;
        let updated = 0;
        let addedToPack = 0;
        let addedToCategory = 0;
        let errors = 0;
        const processedItemIds = [];
        const processedRoleIds = [];
        
        const guild = interaction.guild;
        
        // Standalone if no category selected
        // categoryId is null by default, which means standalone.
        
        const skipped = [];
        
        // Pre-fetch configs for blocking system roles
        const boosterRoleId = guild.roles.premiumSubscriberRole?.id;
        const { getGuildConfig } = await import('../storage/config.js');
        const guildConfig = await getGuildConfig(guild.id);
        const mvpRoleId = guildConfig?.mvpRoleId;

        for (const roleId of ids) {
            try {
                // Check 1: Role must exist in guild (anti-zombie)
                const role = guild.roles.cache.get(roleId);
                if (!role) {
                    skipped.push(`${roleId} (not found)`);
                    errors++;
                    continue;
                }

                // Check 2: Block Dangerous Roles (Administrator / Moderation)
                if (hasAnyDangerousPermission(role)) {
                    skipped.push(`${role.name || roleId} (dangerous permissions)`);
                    errors++;
                    continue;
                }
                
                // Block System Managed Roles (Booster & MVP)
                if (boosterRoleId && roleId === boosterRoleId) {
                    skipped.push(`Booster Role (Discord managed)`);
                    errors++;
                    continue;
                }
                if (mvpRoleId && roleId === mvpRoleId) {
                    skipped.push(`MVP Role (System managed)`);
                    errors++;
                    continue;
                }
                
                const existing = await query('SELECT * FROM shop_items WHERE role_id = $1 AND guild_id = $2', [roleId, guild.id]);
                
                if (existing.rows.length > 0) {
                    const item = existing.rows[0];
                    const updates = { rarity, is_tradable };
                    if (categoryId && item.category_id != categoryId) {
                        updates.category_id = categoryId;
                        addedToCategory++;
                    } else if (categoryId && item.category_id == categoryId) {
                        addedToCategory++;
                    }
                    await updateShopItem(item.id, updates, guild.id);
                    updated++;
                    processedItemIds.push(item.id);
                } else {
                    // Check 2: Role uniqueness (should pass since we checked existing above)
                    const uniqueCheck = await validateRoleUniqueness(guild.id, roleId);
                    if (!uniqueCheck.valid) {
                        skipped.push(`${roleId} (duplicate)`);
                        errors++;
                        continue;
                    }
                    
                    const role = guild.roles.cache.get(roleId);
                    const name = role ? role.name : `Role ${roleId}`;
                    // Price is null — must be set at post time via the Post panel
                    const newItem = await addShopItem(guild.id, categoryId, roleId, name, '', null, null, null, 'role', [], [], null, rarity, is_tradable);
                    created++;
                    if (categoryId) addedToCategory++;
                    processedItemIds.push(newItem.id);
                }
                processedRoleIds.push(roleId);
            } catch (e) {
                sysError(`Mass process role failed`, e, { user: interaction.user.id, guild: interaction.guildId, detail: roleId });
                errors++;
            }
        }
        
        if (packId && processedItemIds.length > 0) {
            const pack = await getShopItem(packId, interaction.guildId);
            if (pack) {
                // Update Roles
                const currentRoles = pack.role_id ? pack.role_id.split(/[,\s]+/) : [];
                const newRoles = [...new Set([...currentRoles, ...processedRoleIds])];
                
                // Update Contents (Item IDs)
                let currentContents = pack.contents;
                if (typeof currentContents === 'string') {
                     try { currentContents = JSON.parse(currentContents); } catch (e) { currentContents = []; }
                }
                if (!Array.isArray(currentContents)) currentContents = [];
                
                const newContents = [...new Set([...currentContents, ...processedItemIds])];
                const itemsActuallyAdded = newContents.length - currentContents.length;

                await updateShopItem(packId, { 
                    role_id: newRoles.join(' '),
                    contents: newContents
                }, interaction.guildId);
                addedToPack = itemsActuallyAdded;
            }
        }
        
        const summary = [
            `✅ **Operation Complete**`,
            `🆕 Items Created: **${created}** (Saved to Warehouse as unposted)`,
            `🔄 Items Updated: **${updated}**`,
            packId ? `📦 Added to Pack: **${addedToPack}**` : null,
            categoryId ? `🏷️ Added to Category: **${addedToCategory}**` : null,
            errors > 0 ? `⚠️ Errors/Skipped: **${errors}** (${skipped.join(', ')})` : null,
            '',
            `💡 _New items are stored in your Warehouse. Use \`/shop-setup\` -> **Post** to set prices and publish them to the shop._`
        ].filter(v => v !== null).join('\n');
        
        await interaction.editReply({ files: [], content: summary, components: [], embeds: [] });
        pendingMassOps.delete(getMassKey(interaction.guildId, userId));

        // Bulk Audit Log
        if (created > 0 || updated > 0) {
            const logName = getUserLogName(interaction);
            const auditSummary = [
                `**Admin:** \`${logName}\`\n`,
                created > 0 ? `• **New Items Created:** \`${created}\`` : null,
                updated > 0 ? `• **Items Updated:** \`${updated}\`` : null,
                addedToPack > 0 ? `• **Added to Pack:** \`${addedToPack}\`` : null,
                addedToCategory > 0 ? `• **Added to Category:** \`${addedToCategory}\`` : null,
                categoryId ? `• **CategoryID:** \`${categoryId}\`` : null
            ].filter(Boolean).join('\n');
            
            await sendBulkLog(guild, 'shop', 'cyan', '📦 Bulk Item Creation', auditSummary);
        }
        
    } catch (error) {
        sysError('Mass save failed', error, { user: interaction.user.id, guild: interaction.guildId });
        await interaction.editReply({ content: `❌ Error: ${error.message}`, components: [] });
    }
}

async function handleMassColorSubcommand(interaction) {
    try {
        const mode = interaction.options.getString('mode');
        const guildId = interaction.guildId;
        const type = interaction.options.getString('type');
        const rolesInput = interaction.options.getString('roles');
        const isBooster = type === 'booster';

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // Parse role IDs (flexible separators: space, comma, hyphen)
        const rawRoleIds = rolesInput
          .trim()
          .split(/[\s,\-]+/)
          .filter(id => /^\d{17,20}$/.test(id));
          
        const roleIds = [...new Set(rawRoleIds)];

        if (roleIds.length === 0) {
          await interaction.editReply('❌ No valid role IDs found. Separate IDs with spaces, commas, or hyphens.');
          return;
        }

        const guild = await interaction.client.guilds.fetch(guildId);
        const botMember = await guild.members.fetchMe().catch(() => null);
        let added = 0, removed = 0, skipped = 0;
        const errors = [];

        for (const roleId of roleIds) {
          const role = await guild.roles.fetch(roleId).catch(() => null);

          if (!role) {
            errors.push(`<@&${roleId}> not found`);
            skipped++;
            continue;
          }

          if (mode === 'add') {
            if (role.managed) {
              errors.push(`${role.name}: managed role`);
              skipped++;
              continue;
            }
            if (hasAnyDangerousPermission(role)) {
              errors.push(`${role.name}: dangerous permissions`);
              skipped++;
              continue;
            }
            if (botMember && role.comparePositionTo(botMember.roles.highest) >= 0) {
              errors.push(`${role.name}: role is equal to or higher than bot role`);
              skipped++;
              continue;
            }

            const result = await addColorRole(guildId, roleId, isBooster);
            if (result.success) {
              added++;
            } else {
              skipped++;
            }
          } else if (mode === 'remove') {
            const result = await removeColorRole(guildId, roleId, isBooster);
            if (result.deleted) {
              removed++;
            } else {
              skipped++;
            }
          }
        }

        const typeLabel = isBooster ? 'booster ' : '';
        const summary = [];
        if (added > 0) summary.push(`✅ Added ${added} ${typeLabel}role(s)`);
        if (removed > 0) summary.push(`✅ Removed ${removed} ${typeLabel}role(s)`);
        if (skipped > 0) summary.push(`⏭️ Skipped ${skipped}`);
        if (errors.length > 0 && errors.length <= 5) summary.push(`\n${errors.join(', ')}`);
        if (errors.length > 5) summary.push(`\n...and ${errors.length - 5} more errors`);

        // Log administrative action
        const logName = getUserLogName(interaction);
        if (added > 0) {
          sendBulkLog(guild, 'audit', 'cyan', '🎨 Mass Colors Added', 
            `**Admin:** \`${logName}\`\n` +
            `**Action:** Added **${added}** ${typeLabel}color roles to the system.`
          );
        }
        if (removed > 0) {
          sendBulkLog(guild, 'audit', 'red', '🎨 Mass Colors Removed', 
            `**Admin:** \`${logName}\`\n` +
            `**Action:** Removed **${removed}** ${typeLabel}color roles from the system.`
          );
        }

        await interaction.editReply(summary.join('\n') || '✅ Done');
    } catch (error) {
        sysError('Mass color command failed', error, { user: interaction.user.id, guild: interaction.guildId });
        await interaction.editReply('An error occurred while processing your request.');
    }
}

