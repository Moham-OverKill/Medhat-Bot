import { MessageFlags } from 'discord.js';
import { handleSettingsComponent } from '../commands/settings.js';
import { handleMvpComponent } from '../commands/mvp.js';
import { handleRewardsComponent, handleRewardsModal } from '../commands/rewards.js';
import { handleColorButton, handleColorsComponent, handleRoleSelection } from '../commands/colors.js';
import {
  handleBankDaily,
  handleBankHistory,
  handleShopButton,
  handleShopCategorySelect,
  handleShopItemSelect,
  handleShopBuyButton,
  handleInventoryButton,
  handleInventoryCategorySelect,
  handleInventoryItemSelect,
  handleInventoryAction,
  handleItemClaim,
  handleBackButton,
  handleBankRefresh,
  handleShopConfirmBuy,
  handleShopCancelBuy
} from '../commands/bank.js';
import {
  handleShopSetup,
  handleCreateCategory,
  handleCategoryModalSubmit,
  handleAddTypeSelect,
  handleItemModalSubmit,
  handleAssignCategorySelect,
  handleEditItemStart,
  handleEditItemCategorySelect,
  handleEditItemSelect,
  handleDeleteItemStart,
  handleDeleteItemCategorySelect,
  handleDeleteItemSelect,
  handleShopAdminAdd,
  handleShopAdminEdit,
  handleShopAdminDelete,
  handleDeleteCategoryStart,
  handleDeleteCategoryConfirm,
  handleDeletePackStart,
  handleDeletePackSelect,
  handleEditPackStart,
  handleEditPackSelect,
  handleEditItemDetails,
  handleEditPackDetails,
  handleAdminBrowserSelect,
  handleManageTiers,
  handleAddTierModal,
  handleTierModalSubmit,
  handleEditCategoryStart,
  handleEditCategorySelect,
  handleEditCategoryModalSubmit,
  handleManageItemCategorySelect,
  handleEditCategoryRemoveItemsStart,
  handleEditCategoryRemoveItemsSelect,
  handleEditCategoryAddItemsStart,
  handleEditCategoryAddItemsSelect,
  handleEditCategoryRenameStart,
  handlePackAddContentStart,
  handlePackAddContentSelect,
  handlePackRemoveContentStart,
  handlePackRemoveContentSelect,
  handleShopPostStart,
  handleShopPostItemSelect,
  handleShopPostChannelSelect,
  handleShopPostSellerSelect,
  handleShopPostDescBtn,
  handleShopPostPayoutBtn,
  handleShopPostImageBtn,
  handleShopPostModalSubmit,
  handleShopPostPublish,
  handleShopPostPriceBtn,
  handleShopPostReset,
  handleShopPostStockBtn,
  handleShopPostGate,
  handleShopPostNewLayout,
  handleShopPostEditLayout,
  handleShopEditPostUrlSubmit,
  handleShopPostUpdate,
  handleRevokeItemStart,
  handleRevokeItemConfirm,
  handleNewItemAttrSelect,
  handleNewItemSave,
  handleEditItemRaritySelect,
  handleEditItemTradableSelect,
  handleLootBoxesPage,
  handleLootBoxCreateModalStart,
  handleLootBoxCreateModalSubmit,
  handleLootBoxRenameCatStart,
  handleLootBoxRenameCatSubmit,
  showLootBoxEditorPanel,
  handleLootBoxRenameModal,
  handleLootBoxRenameSubmit,
  handleLootBoxRarityRatesModal,
  handleLootBoxRarityRatesSubmit,
  handleLootBoxCoinsConfigModal,
  handleLootBoxCoinsConfigSubmit,
  handleLootBoxPrizeCountModal,
  handleLootBoxPrizeCountSubmit,
  showLootBoxDeleteConfirm,
  handleLootBoxDeleteConfirm,
  handleEditLootBoxStart,
  handleDeleteLootBoxStart,
  handleLootBoxToggleFeature,
  handleLootBoxConfigMenuSelect
} from '../commands/shop-setup.js';
import { handleLogsSettings, handleLogCategorySelect, handleLogDisable } from '../commands/settings/logs.js';
import { handleEconomySettings } from '../commands/settings/economy.js';
import { handleQuestsComponent, handleQuestsModal } from '../commands/quests-dashboard.js';
import { handleQuestInteraction } from '../commands/quest.js';
import {
  handleMassSelect,
  handleMassCreateStart,
  handleMassModalSubmit,
  handleMassSave,
  handleMassCreateStandalone
} from '../commands/item-mass.js';
import {
  handleTradeSetupInteraction,
  handleTradeModal,
  handleTradeSelect,
  handleTradeExecution,
  handleTradeFinalConfirmation
} from '../commands/trade.js';
import { sanitizeError, runInGuildContext } from '../shared.js';
import { handleInteractionError } from '../utils/errors.js';
import { logSystemEvent, sysLog, sysError } from '../utils/logger.js';

let handlersSetup = false;

export function setupComponentHandlers(client) {
  if (handlersSetup) {
    sysLog('Handlers Redundancy', { detail: 'Component handlers already set up' });
    return;
  }

  client.on('interactionCreate', async (interaction) => {
    return runInGuildContext(interaction.guildId, async () => {
      // --- 0. INTERACTION WATCHDOG ---
    // Log a warning if any interaction takes > 2.5s to acknowledge.
    const watchdog = setTimeout(() => {
      if (!interaction.deferred && !interaction.replied) {
        const detail = interaction.isCommand() ? `/${interaction.commandName}` : (interaction.customId || 'unidentified');
        sysLog('⚠️ Latency Warning', {
          user: interaction.user.tag,
          guildId: interaction.guildId,
          detail: `Interaction "${detail}" not acknowledged within 2.5s. Potential for "Unknown interaction" error!`
        });
      }
    }, 2500);

    try {
      // 1. --- INTERACTION WATCHTOWER ---
      if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
        const type = interaction.isButton() ? 'Button' :
          interaction.isAnySelectMenu() ? 'Menu' :
            interaction.isModalSubmit() ? 'Modal' : 'Interaction';

        sysLog(`${type} Clicked`, {
          user: interaction.user,
          guild: interaction.guild,
          detail: `CustomID: ${interaction.customId}`
        });
      }
      // --- SECURITY GUARDRAIL ---
      if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
        const adminPrefixes = [
          'settings_', 'mvp_', 'rewards_', 'leaderboard_', 'colors_', 'logs_', 'organize_',
          'shop_admin_', 'shop_setup_', 'shop_pack_', 'shop_add_', 'shop_edit_',
          'shop_delete_', 'shop_post_', 'shop_cat_', 'shop_assign_', 'shop_select_cat_delete',
          'shop_select_item_delete', 'mass_', 'quests_', 'admin_user_', 'lb_',
          'role_rewards_', 'shop_lb_',
          // Previously unguarded admin routes — patched in security audit
          'shop_item_edit', 'shop_pack_manage', 'shop_pack_edit', 'shop_cat_manage',
          'shop_item_manage_tiers', 'shop_manage_tiers', 'shop_tier_add', 'shop_cat_settings',
          'shop_select_pack_edit', 'shop_select_cat_edit', 'shop_select_pack_delete'
        ];

        // Check if interaction ID starts with any admin prefix
        const isAdminInteraction = adminPrefixes.some(prefix => interaction.customId.startsWith(prefix));

        if (isAdminInteraction) {
          // Need to check permissions
          // Note: permissions are on interaction.member for guild interactions
          if (!interaction.member?.permissions.has('Administrator')) {
            const reply = { content: '⛔ This button is for Admins only.', flags: 64 }; // 64 = Ephemeral
            if (interaction.deferred || interaction.replied) await interaction.followUp(reply);
            else await interaction.reply(reply);
            return;
          }
        }
      }

      // --- MODALS ---
      if (interaction.isModalSubmit()) {
        if (interaction.customId === 'quests_add_modal' || interaction.customId.startsWith('quests_edit_modal_')) {
          await handleQuestsModal(interaction);
        } else if (interaction.customId.startsWith('rewards_')) {
          await handleRewardsModal(interaction);
        } else if (interaction.customId === 'shop_category_modal') {
          await handleCategoryModalSubmit(interaction);
        } else if (interaction.customId.startsWith('shop_pack_modal_edit_')) {
          await handleItemModalSubmit(interaction);
        } else if (interaction.customId.startsWith('shop_item_modal_')) {
          await handleItemModalSubmit(interaction);
        } else if (interaction.customId.startsWith('shop_tier_modal_')) {
          await handleTierModalSubmit(interaction);
        } else if (interaction.customId.startsWith('shop_cat_modal_edit_')) {
          await handleEditCategoryModalSubmit(interaction);
        } else if (interaction.customId === 'shop_lb_create_modal') {
          await handleLootBoxCreateModalSubmit(interaction);
        } else if (interaction.customId === 'shop_lb_rename_cat_modal') {
          await handleLootBoxRenameCatSubmit(interaction);
        } else if (interaction.customId.startsWith('shop_lb_rename_modal_') || interaction.customId.startsWith('shop_lb_edit_modal_')) {
          const boxId = parseInt(interaction.customId.replace('shop_lb_rename_modal_', '').replace('shop_lb_edit_modal_', ''), 10);
          await handleLootBoxRenameSubmit(interaction, boxId);
        } else if (interaction.customId.startsWith('shop_lb_rates_modal_')) {
          const boxId = parseInt(interaction.customId.replace('shop_lb_rates_modal_', ''), 10);
          await handleLootBoxRarityRatesSubmit(interaction, boxId);
        } else if (interaction.customId.startsWith('shop_lb_coins_modal_')) {
          const boxId = parseInt(interaction.customId.replace('shop_lb_coins_modal_', ''), 10);
          await handleLootBoxCoinsConfigSubmit(interaction, boxId);
        } else if (interaction.customId.startsWith('shop_lb_prizes_modal_')) {
          const boxId = parseInt(interaction.customId.replace('shop_lb_prizes_modal_', ''), 10);
          await handleLootBoxPrizeCountSubmit(interaction, boxId);
        } else if (
          interaction.customId.startsWith('shop_post_image_modal') ||
          interaction.customId.startsWith('shop_post_desc_modal') ||
          interaction.customId.startsWith('shop_post_payout_modal') ||
          interaction.customId.startsWith('shop_post_stock_modal') ||
          interaction.customId.startsWith('shop_post_price_modal')
        ) {
          await handleShopPostModalSubmit(interaction);
        } else if (interaction.customId === 'shop_edit_post_url_modal') {
          await handleShopEditPostUrlSubmit(interaction);
        } else if (interaction.customId.startsWith('mass_modal_create_')) {
          await handleMassModalSubmit(interaction);
        } else if (interaction.customId.startsWith('admin_user_balmod_')) {
          const { handleBalanceModal } = await import('../commands/admin-users.js');
          await handleBalanceModal(interaction);
        } else if (interaction.customId.startsWith('admin_user_stkmod_')) {
          const { handleStreakModal } = await import('../commands/admin-users.js');
          await handleStreakModal(interaction);
        } else if (interaction.customId.startsWith('admin_user_setqty_')) {
          const { handleAdminSetQuantity } = await import('../commands/admin-users.js');
          await handleAdminSetQuantity(interaction);
        } else if (interaction.customId.startsWith('trade_modal_')) {
          await handleTradeModal(interaction);
        } else if (interaction.customId.startsWith('trade_confirm_')) {
          await handleTradeFinalConfirmation(interaction);
        } else if (interaction.customId.startsWith('settings_')) {
          await handleSettingsComponent(interaction);
        } else if (interaction.customId.startsWith('shop_buy_qty_modal_')) {
          const { handleShopBuyModalSubmit } = await import('../commands/bank.js');
          await handleShopBuyModalSubmit(interaction);
        } else if (interaction.customId.startsWith('bank_inv_drop_qty_')) {
          const { handleInventoryDropModalSubmit } = await import('../commands/bank.js');
          await handleInventoryDropModalSubmit(interaction);
        }
        return;
      }

      // --- BUTTONS & MENUS ---
      if (!interaction.isAnySelectMenu() && !interaction.isButton()) return;


      const customId = interaction.customId;

      // SETTINGS NAVIGATION (back button, module navigation, leaderboard channel selections, admin users, organize filters, role rewards)
      if (
        customId.startsWith('settings_') ||
        customId.startsWith('organize_') ||
        customId.startsWith('leaderboard_channel_') ||
        customId.startsWith('admin_user_') ||
        customId.startsWith('lb_') ||
        customId.startsWith('role_rewards_')
      ) {
        await handleSettingsComponent(interaction);
        return;
      }

      // ECONOMY DASHBOARD
      if (customId.startsWith('economy_') || customId.startsWith('eco_')) {
        await handleEconomySettings(interaction);
        return;
      }

      // MASS ITEM OPS
      if (customId.startsWith('mass_select_')) {
        await handleMassSelect(interaction);
        return;
      } else if (customId.startsWith('mass_create_')) {
        if (customId === 'mass_create_standalone') {
          await handleMassCreateStandalone(interaction);
        } else {
          await handleMassCreateStart(interaction);
        }
        return;
      } else if (customId === 'mass_save') {
        await handleMassSave(interaction);
        return;
      }

      // BANK: Daily & History
      if (customId === 'bank_daily') {
        await handleBankDaily(interaction);
      } else if (customId === 'bank_history' || customId.startsWith('history_page_')) {
        await handleBankHistory(interaction);
      } else if (customId === 'bank_back') {
        await handleBackButton(interaction);
      } else if (customId === 'bank_refresh') {
        await handleBankRefresh(interaction);
      }
      // BANK: Transfer
      // BANK: Shop
      else if (customId === 'shop_main' || customId === 'bank_shop') {
        await handleShopButton(interaction);
      } else if (customId === 'shop_select_pack_edit' || customId === 'shop_select_cat_edit_rename') {
        if (customId === 'shop_select_pack_edit') await handleEditPackSelect(interaction);
        else await handleEditCategorySelect(interaction);
      } else if (customId.startsWith('shop_assign_cat_select_')) {
        await handleManageItemCategorySelect(interaction);
      } else if (customId.startsWith('shop_new_cat_select_') || customId.startsWith('shop_new_rarity_select_') || customId.startsWith('shop_new_tradable_select_')) {
        await handleNewItemAttrSelect(interaction);
      } else if (customId.startsWith('shop_edit_rarity_select_')) {
        await handleEditItemRaritySelect(interaction);
      } else if (customId.startsWith('shop_edit_tradable_select_')) {
        await handleEditItemTradableSelect(interaction);
      } else if (customId === 'bank_shop_item') {
        await handleShopItemSelect(interaction);
      } else if (customId === 'shop_edit_item_select' || customId === 'shop_select_item_edit' || customId === 'shop_item_edit_select') {
        await handleEditItemSelect(interaction);
      } else if (customId === 'shop_edit_category_start') {
        await handleEditCategoryStart(interaction);
      } else if (customId === 'shop_edit_pack_start') {
        await handleEditPackStart(interaction);
      } else if (customId === 'shop_edit_item' || customId.startsWith('shop_edit_item_back_')) {
        await handleEditItemStart(interaction);
      } else if (customId === 'shop_admin_browser_select') {
        await handleAdminBrowserSelect(interaction);
      } else if (customId.startsWith('shop_item_view_details_')) {
        await handleEditItemSelect(interaction);
      } else if (customId.startsWith('shop_item_view_users_')) {
        await handleEditItemSelect(interaction);
      } else if (customId.startsWith('shop_item_page_prev_') || customId.startsWith('shop_item_page_next_')) {
        await handleEditItemSelect(interaction);
      } else if (customId.startsWith('shop_item_edit_select_')) {
        await handleEditItemSelect(interaction);
      } else if (customId.startsWith('shop_item_revoke_confirm_')) {
        await handleRevokeItemConfirm(interaction);
      } else if (customId.startsWith('shop_item_revoke_')) {
        await handleRevokeItemStart(interaction);
      } else if (customId.startsWith('shop_item_edit_details_')) {
        await handleEditItemDetails(interaction);
      } else if (customId.startsWith('shop_pack_edit_')) {
        await handleEditPackDetails(interaction);
      } else if (customId.startsWith('bank_shop_buy_') || customId.startsWith('force_buy_')) {
        await handleShopBuyButton(interaction);
      } else if (customId.startsWith('bank_shop_confirm_')) {
        await handleShopConfirmBuy(interaction);
      } else if (customId.startsWith('bank_shop_cancel_')) {
        await handleShopCancelBuy(interaction);
      } else if (customId === 'bank_inventory' || customId.startsWith('bank_inv_page_')) {
        await handleInventoryButton(interaction);
      } else if (customId.startsWith('bank_inv_cat_')) {
        await handleInventoryCategorySelect(interaction);
      } else if (customId.startsWith('bank_inv_item_') || customId.startsWith('inv_nav_')) {
        await handleInventoryItemSelect(interaction);
      } else if (customId.startsWith('bank_item_claim_') || customId.startsWith('force_claim_')) {
        await handleItemClaim(interaction);
      } else if (customId.startsWith('bank_inv_open_') || customId.startsWith('bank_inv_equip_') || customId.startsWith('bank_inv_drop_') || customId.startsWith('bank_inv_dropconfirm_') || customId.startsWith('bank_inv_dropcancel_')) {
        await handleInventoryAction(interaction);
      } else if (customId === 'bank_back') {
        await handleBackButton(interaction);
      }

      // ADMIN SHOP SETUP - EDIT START HANDLERS
      else if (customId.startsWith('shop_cat_settings_')) {
        await handleEditCategoryRenameStart(interaction);
      } else if (customId.startsWith('shop_cat_manage_')) {
        await handleEditCategorySelect(interaction);
      } else if (customId.startsWith('shop_pack_manage_')) {
        await handleEditPackSelect(interaction);
      } else if (customId.startsWith('shop_edit_cat_add_select_')) {
        await handleEditCategoryAddItemsSelect(interaction);
      } else if (customId.startsWith('shop_edit_cat_remove_select_')) {
        await handleEditCategoryRemoveItemsSelect(interaction);
      }
      // ADMIN SHOP SETUP - MAIN MENU
      else if (customId === 'shop_admin_home' || customId === 'shop_setup_home') {
        await handleShopSetup(interaction);
      } else if (customId === 'settings_home') {
        await handleSettingsComponent(interaction);
      } else if (customId === 'settings_logs') {
        await handleLogsSettings(interaction);
      } else if (customId === 'logs_disable_all' || customId === 'logs_disable_btn') {
        await handleLogDisable(interaction);
      } else if (customId.startsWith('logs_assign_')) {
        await handleLogCategorySelect(interaction);
      } else if (customId === 'leaderboard_refresh') {
        // Leaderboard refresh button - import dynamically
        const { handleSettingsComponent } = await import('../commands/settings.js');
        await handleSettingsComponent(interaction);
      }
      // Shop Setup Button Routing
      else if (customId === 'shop_admin_add' || customId === 'shop_setup_add') {
        await handleShopAdminAdd(interaction);
      } else if (customId.startsWith('shop_new_save_')) {
        await handleNewItemSave(interaction);
      } else if (customId === 'shop_admin_edit' || customId === 'shop_setup_edit') {
        await handleShopAdminEdit(interaction);
      } else if (customId === 'shop_admin_delete' || customId === 'shop_setup_delete') {
        await handleShopAdminDelete(interaction);
      } else if (customId === 'shop_admin_post' || customId === 'shop_setup_post') {
        await handleShopPostGate(interaction);
      } else if (customId === 'shop_post_new_layout') {
        await handleShopPostNewLayout(interaction);
      } else if (customId === 'shop_post_edit_layout') {
        await handleShopPostEditLayout(interaction);
      } else if (customId === 'shop_post_update') {
        await handleShopPostUpdate(interaction);
      } else if (customId.startsWith('shop_pack_add_content_select_')) {
        await handlePackAddContentSelect(interaction);
      } else if (customId.startsWith('shop_pack_add_')) {
        await handlePackAddContentStart(interaction);
      } else if (customId.startsWith('shop_pack_remove_content_select_')) {
        await handlePackRemoveContentSelect(interaction);
      } else if (customId.startsWith('shop_pack_remove_')) {
        await handlePackRemoveContentStart(interaction);
      } else if (customId === 'shop_post_item_select') {
        await handleShopPostItemSelect(interaction);
      } else if (customId === 'shop_post_channel_select') {
        await handleShopPostChannelSelect(interaction);
      }
      // Setup Modal Routing
      else if (customId === 'shop_post_seller_select') {
        await handleShopPostSellerSelect(interaction);
      } else if (customId === 'shop_post_desc_btn') {
        await handleShopPostDescBtn(interaction);
      } else if (customId === 'shop_post_payout_btn') {
        await handleShopPostPayoutBtn(interaction);
      } else if (customId === 'shop_post_image_btn') {
        await handleShopPostImageBtn(interaction);
      } else if (customId === 'shop_post_publish') {
        await handleShopPostPublish(interaction);
      } else if (customId === 'shop_post_price_btn') {
        await handleShopPostPriceBtn(interaction);
      } else if (customId === 'shop_post_reset') {
        await handleShopPostReset(interaction);
      } else if (customId === 'shop_post_stock_btn') {
        await handleShopPostStockBtn(interaction);
      }
      // ADMIN SHOP SETUP - ADD FLOW
      else if (customId.startsWith('shop_add_type_')) {
        await handleAddTypeSelect(interaction);
      } else if (customId === 'shop_lb_home') {
        await handleLootBoxesPage(interaction);
      } else if (customId === 'shop_lb_select_box') {
        const boxId = parseInt(interaction.values[0].replace('lb_', ''), 10);
        await showLootBoxEditorPanel(interaction, boxId);
      } else if (customId === 'shop_lb_create_start') {
        await handleLootBoxCreateModalStart(interaction);
      } else if (customId === 'shop_edit_lootbox') {
        await handleEditLootBoxStart(interaction);
      } else if (customId === 'shop_delete_lootbox') {
        await handleDeleteLootBoxStart(interaction);
      } else if (customId === 'shop_lb_rename_cat') {
        await handleLootBoxRenameCatStart(interaction);
      } else if (customId.startsWith('shop_lb_config_menu_')) {
        await handleLootBoxConfigMenuSelect(interaction);
      } else if (customId.startsWith('shop_lb_toggle_items_')) {
        const boxId = parseInt(customId.replace('shop_lb_toggle_items_', ''), 10);
        await handleLootBoxToggleFeature(interaction, boxId, 'items');
      } else if (customId.startsWith('shop_lb_toggle_prizes_')) {
        const boxId = parseInt(customId.replace('shop_lb_toggle_prizes_', ''), 10);
        await handleLootBoxToggleFeature(interaction, boxId, 'prizes');
      } else if (customId.startsWith('shop_lb_toggle_coins_')) {
        const boxId = parseInt(customId.replace('shop_lb_toggle_coins_', ''), 10);
        await handleLootBoxToggleFeature(interaction, boxId, 'coins');
      } else if (customId.startsWith('shop_lb_rates_btn_')) {
        const boxId = parseInt(customId.replace('shop_lb_rates_btn_', ''), 10);
        await handleLootBoxRarityRatesModal(interaction, boxId);
      } else if (customId.startsWith('shop_lb_coins_btn_')) {
        const boxId = parseInt(customId.replace('shop_lb_coins_btn_', ''), 10);
        await handleLootBoxCoinsConfigModal(interaction, boxId);
      } else if (customId.startsWith('shop_lb_prizes_btn_')) {
        const boxId = parseInt(customId.replace('shop_lb_prizes_btn_', ''), 10);
        await handleLootBoxPrizeCountModal(interaction, boxId);
      } else if (customId.startsWith('shop_lb_rename_box_btn_')) {
        const boxId = parseInt(customId.replace('shop_lb_rename_box_btn_', ''), 10);
        await handleLootBoxRenameModal(interaction, boxId);
      } else if (customId.startsWith('shop_lb_view_') || customId.startsWith('shop_lb_edit_details_') || customId.startsWith('shop_lb_cancel_delete_')) {
        const boxId = parseInt(customId.replace('shop_lb_view_', '').replace('shop_lb_edit_details_', '').replace('shop_lb_cancel_delete_', ''), 10);
        await showLootBoxEditorPanel(interaction, boxId);
      } else if (customId.startsWith('shop_lb_delete_start_')) {
        const boxId = parseInt(customId.replace('shop_lb_delete_start_', ''), 10);
        await showLootBoxDeleteConfirm(interaction, boxId);
      } else if (customId.startsWith('shop_delete_lootbox_confirm_')) {
        const boxId = parseInt(customId.replace('shop_delete_lootbox_confirm_', ''), 10);
        await handleLootBoxDeleteConfirm(interaction, boxId);
      } else if (customId.startsWith('shop_cat_add_')) {
        await handleEditCategoryAddItemsStart(interaction);
      } else if (customId.startsWith('shop_cat_remove_')) {
        await handleEditCategoryRemoveItemsStart(interaction);
      }
      // ADMIN SHOP SETUP - DELETE FLOW
      else if (customId === 'shop_delete_item') {
        await handleDeleteItemStart(interaction);
      } else if (customId === 'shop_select_cat_delete') {
        await handleDeleteItemCategorySelect(interaction);
      } else if (customId === 'shop_select_item_delete') {
        await handleDeleteItemSelect(interaction);
      } else if (customId === 'shop_delete_category_start') {
        await handleDeleteCategoryStart(interaction);
      } else if (customId === 'shop_select_cat_delete_confirm') {
        await handleDeleteCategoryConfirm(interaction);
      } else if (customId === 'shop_delete_pack') {
        await handleDeletePackStart(interaction);
      } else if (customId === 'shop_select_pack_delete') {
        await handleDeletePackSelect(interaction);
      }
      // ADMIN SHOP SETUP - TIERS
      else if (customId.startsWith('shop_item_manage_tiers_') || customId.startsWith('shop_manage_tiers_')) {
        await handleManageTiers(interaction);
      } else if (customId.startsWith('shop_tier_add_')) {
        await handleAddTierModal(interaction);
      }
      // MVP Components
      else if (customId.startsWith('mvp_')) {
        await handleMvpComponent(interaction);
      }
      // Rewards Components
      else if (customId.startsWith('rewards_')) {
        await handleRewardsComponent(interaction);
      }
      // Quests Components
      else if (customId.startsWith('quests_')) {
        await handleQuestsComponent(interaction);
      }
      // Colors Components (Unified Routing)
      else if (customId.startsWith('colors_')) {
        if (customId === 'colors:back' || customId === 'boosters:back') {
          const { handleColorsCommand } = await import('../commands/colors.js');
          await handleColorsCommand(interaction);
        } else if (customId.startsWith('colors_role_')) {
          await handleRoleSelection(interaction);
        } else {
          // Standard Dashboard handling (tabs, creation, menu selections)
          await handleColorsComponent(interaction);
        }
      } else if (customId.startsWith('color_')) {
        await handleColorButton(interaction);
      } else if (customId.startsWith('quest_')) {
        await handleQuestInteraction(interaction);
      } else if (customId.startsWith('help_')) {
        const { handleHelpSelect, handleHelpStepNavigation } = await import('../commands/help.js');
        if (customId === 'help_select_topic') {
          await handleHelpSelect(interaction);
        } else {
          await handleHelpStepNavigation(interaction);
        }
      } else if (interaction.customId.startsWith('trade_')) {
        if (customId.startsWith('trade_setup_') || customId.startsWith('trade_cat_')) {
          await handleTradeSetupInteraction(interaction);
        } else if (customId.startsWith('trade_select_')) {
          await handleTradeSelect(interaction);
        } else if (customId.startsWith('trade_accept_') || customId.startsWith('trade_decline_')) {
          await handleTradeExecution(interaction);
        }
      } else {
        // --- SAFETY NET: LOG UNHANDLED ---
        if (customId && !customId.startsWith('shop_main') && !customId.startsWith('bank_')) {
          sysLog('Unhandled Interaction', { detail: `ID: "${customId}" | Type: ${interaction.type}` });
        }
      }

    } catch (error) {
      const errorMsg = error?.message || String(error);
      if (errorMsg.includes('already been sent') || error?.code === 10062) {
        sysLog('Interaction Notice', { 
          user: interaction.user.id, 
          guild: interaction.guildId, 
          detail: `Handled: ${errorMsg}` 
        });
      } else {
        sysError('Interaction Handler Failure', error, { user: interaction.user.id, guild: interaction.guildId, detail: 'InteractionCreate event' });
        await handleInteractionError(interaction, error, `Component Handler (${interaction.customId || 'Unknown'})`);
      }
    } finally {
      clearTimeout(watchdog);
    }
  });
});

  handlersSetup = true;
  sysLog('Infrastructure Audit', { detail: 'Component handlers set up' });
}
