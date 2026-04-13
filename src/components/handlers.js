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
  handleShopPostStockBtn
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
import { sanitizeError } from '../shared.js';
import { logSystemEvent, sysLog, sysError } from '../utils/logger.js';

let handlersSetup = false;

export function setupComponentHandlers(client) {
  if (handlersSetup) {
    sysLog('Handlers Redundancy', { detail: 'Component handlers already set up' });
    return;
  }

  client.on('interactionCreate', async (interaction) => {
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
          'settings_', 'mvp_', 'rewards_', 'leaderboard_', 'colors_', 'logs_',
          'shop_admin_', 'shop_setup_', 'shop_pack_', 'shop_add_', 'shop_edit_',
          'shop_delete_', 'shop_post_', 'shop_cat_', 'shop_assign_', 'shop_select_cat_delete',
          'shop_select_item_delete', 'mass_', 'quests_', 'admin_user_', 'lb_'
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
        } else if (interaction.customId === 'shop_post_image_modal' || interaction.customId === 'shop_post_desc_modal' || interaction.customId === 'shop_post_payout_modal' || interaction.customId === 'shop_post_stock_modal' || interaction.customId === 'shop_post_price_modal') {
          await handleShopPostModalSubmit(interaction);
        } else if (interaction.customId.startsWith('mass_modal_create_')) {
          await handleMassModalSubmit(interaction);
        } else if (interaction.customId.startsWith('admin_user_balmod_')) {
          const { handleBalanceModal } = await import('../commands/admin-users.js');
          await handleBalanceModal(interaction);
        } else if (interaction.customId.startsWith('trade_modal_')) {
          await handleTradeModal(interaction);
        } else if (interaction.customId.startsWith('trade_confirm_')) {
          await handleTradeFinalConfirmation(interaction);
        }
        return;
      }

      // --- BUTTONS & MENUS ---
      if (!interaction.isAnySelectMenu() && !interaction.isButton()) return;


      const customId = interaction.customId;

      // SETTINGS NAVIGATION (back button, module navigation, leaderboard channel selections, admin users)
      if (customId.startsWith('settings_') || customId.startsWith('leaderboard_channel_') || customId.startsWith('admin_user_') || customId.startsWith('lb_')) {
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
      } else if (customId === 'bank_shop_item') {
        await handleShopItemSelect(interaction);
      } else if (customId === 'shop_edit_item_select' || customId === 'shop_select_item_edit') {
        await handleEditItemSelect(interaction);
      } else if (customId === 'shop_edit_category_start') {
        await handleEditCategoryStart(interaction);
      } else if (customId === 'shop_edit_pack_start') {
        await handleEditPackStart(interaction);
      } else if (customId === 'shop_edit_item') {
        await handleEditItemStart(interaction);
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
      } else if (customId.startsWith('bank_inv_equip_') || customId.startsWith('bank_inv_drop_') || customId.startsWith('bank_inv_dropconfirm_') || customId.startsWith('bank_inv_dropcancel_')) {
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
      } else if (customId === 'shop_admin_edit' || customId === 'shop_setup_edit') {
        await handleShopAdminEdit(interaction);
      } else if (customId === 'shop_admin_delete' || customId === 'shop_setup_delete') {
        await handleShopAdminDelete(interaction);
      } else if (customId === 'shop_admin_post' || customId === 'shop_setup_post') {
        await handleShopPostStart(interaction);
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
      // Colors Components
      else if (customId === 'colors:back' || customId === 'boosters:back') {
        const { handleColorsCommand } = await import('../commands/colors.js');
        await handleColorsCommand(interaction);
      } else if (customId.startsWith('colors_')) {
        if (customId.startsWith('colors_normal_') || customId.startsWith('colors_booster_')) {
          await handleColorsComponent(interaction);
        } else if (customId.startsWith('colors_role_')) {
          await handleRoleSelection(interaction);
        }
      } else if (customId.startsWith('color_')) {
        await handleColorButton(interaction);
      } else if (customId.startsWith('quest_')) {
        await handleQuestInteraction(interaction);
      } else if (interaction.customId.startsWith('trade_')) {
        if (customId.startsWith('trade_setup_')) {
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
      sysError('Interaction Handler Failure', error, { user: interaction.user.id, guild: interaction.guildId, detail: 'InteractionCreate event' });
    } finally {
      clearTimeout(watchdog);
    }
  });

  handlersSetup = true;
  sysLog('Infrastructure Audit', { detail: 'Component handlers set up' });
}
