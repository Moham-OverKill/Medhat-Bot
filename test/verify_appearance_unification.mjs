import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_SHORTCUT_REGISTRY } from '../src/commands/interface.js';
import {
  showMainMenu,
  showCoinsSubMenu,
  showCustomizeModal,
  showCoinsCustomizeModal
} from '../src/commands/settings.js';
import {
  handleLootBoxesPage,
  showLootBoxEditorPanel,
  handleLootBoxRenameModal,
  handleLootBoxRenameCatStart,
  handleOpenAppearanceModal,
  handleEditItemSelect,
  handleCreateItemStart,
  handleShopPostAppearanceBtn,
  handleShopPostStart
} from '../src/commands/shop-setup.js';
import { setMockPool } from '../src/storage/postgres.js';

describe('Unified Appearance UI Standardization Suite', () => {
  const validGuildId = '123456789012345678';

  it('1. Admin Hub Shortcut Registry: Appearance configuration', () => {
    const entry = ADMIN_SHORTCUT_REGISTRY.customize;
    assert.ok(entry, 'customize shortcut must exist');
    assert.equal(entry.name, 'Appearance');
    assert.equal(entry.label, 'APPEARANCE');
    assert.equal(entry.emoji, '🖼️');
    assert.equal(entry.buttonCustomId, 'admin_hub_customize');
  });

  it('2. Settings "Other" Menu: Appearance option and modal title', async () => {
    let payload = null;
    let modalShown = null;

    const mockInteraction = {
      guildId: validGuildId,
      guild: {
        id: validGuildId,
        roles: { cache: new Map() },
        members: { me: { nickname: 'TestBot', avatarURL: () => null } }
      },
      deferred: true,
      replied: false,
      isButton: () => false,
      isAnySelectMenu: () => false,
      editReply: async (p) => { payload = p; return p; },
      showModal: async (m) => { modalShown = m; return m; }
    };

    setMockPool({
      query: async () => ({ rows: [{ config: {} }] })
    });

    await showMainMenu(mockInteraction);
    assert.ok(payload);
    const otherSelect = payload.components[3].components[0];
    const appearanceOption = otherSelect.options.find(o => o.data.value === 'other_customize');
    assert.ok(appearanceOption, 'other_customize option must exist');
    assert.equal(appearanceOption.data.label, 'Appearance');
    assert.equal(appearanceOption.data.emoji.name, '🖼️');

    await showCustomizeModal(mockInteraction);
    assert.ok(modalShown);
    assert.equal(modalShown.data.title, 'Appearance');
  });

  it('3. Coins Submenu: Appearance button and Coins modal title', async () => {
    let payload = null;
    let modalShown = null;

    const mockInteraction = {
      guildId: validGuildId,
      guild: { id: validGuildId, roles: { cache: new Map() } },
      deferred: false,
      replied: false,
      isButton: () => true,
      isAnySelectMenu: () => false,
      update: async (p) => { payload = p; return p; },
      showModal: async (m) => { modalShown = m; return m; }
    };

    setMockPool({
      query: async () => ({ rows: [{ config: { coin_name: 'Rubies', coin_emoji: '💎' } }] })
    });

    await showCoinsSubMenu(mockInteraction);
    assert.ok(payload);
    const customizeBtn = payload.components.flatMap(r => r.components).find(b => b.data.custom_id === 'settings_coins_customize');
    assert.ok(customizeBtn, 'settings_coins_customize button must exist');
    assert.equal(customizeBtn.data.label, 'Appearance');
    assert.equal(customizeBtn.data.emoji.name, '🖼️');

    await showCoinsCustomizeModal(mockInteraction);
    assert.ok(modalShown);
    assert.equal(modalShown.data.title, 'Appearance');
  });

  it('4. Chest Editor Panel: Appearance button and Loot Box rename modal title', async () => {
    let payload = null;
    let modalShown = null;

    const mockInteraction = {
      guildId: validGuildId,
      guild: { id: validGuildId, roles: { cache: new Map() } },
      deferred: true,
      replied: false,
      isButton: () => false,
      isAnySelectMenu: () => false,
      editReply: async (p) => { payload = p; return p; },
      showModal: async (m) => { modalShown = m; return m; }
    };

    setMockPool({
      query: async (sql) => {
        if (sql.includes('FROM loot_boxes')) {
          return {
            rows: [{
              id: 42,
              guild_id: validGuildId,
              name: 'Mystery Chest',
              image_url: 'https://example.com/chest.png',
              items_enabled: true,
              coins_enabled: true
            }]
          };
        }
        return { rows: [{ config: {} }] };
      }
    });

    await showLootBoxEditorPanel(mockInteraction, 42, { showImageMenu: false });
    assert.ok(payload);
    const actionRow = payload.components[2].components;
    const appearanceBtn = actionRow.find(b => b.data.custom_id === 'shop_lb_rename_box_btn_42');
    assert.ok(appearanceBtn, 'shop_lb_rename_box_btn_42 button must exist');
    assert.equal(appearanceBtn.data.label, 'Appearance');
    assert.equal(appearanceBtn.data.emoji.name, '🖼️');

    await handleLootBoxRenameModal(mockInteraction, 42);
    assert.ok(modalShown);
    assert.equal(modalShown.data.title, 'Appearance');
  });

  it('5. Chests Root Page: Appearance category button and Category rename modal title', async () => {
    let payload = null;
    let modalShown = null;

    const mockInteraction = {
      guildId: validGuildId,
      guild: { id: validGuildId, roles: { cache: new Map() } },
      deferred: true,
      replied: false,
      isButton: () => false,
      isAnySelectMenu: () => false,
      editReply: async (p) => { payload = p; return p; },
      showModal: async (m) => { modalShown = m; return m; }
    };

    setMockPool({
      query: async (sql) => {
        if (sql.includes('FROM loot_boxes')) {
          return { rows: [] };
        }
        return { rows: [{ config: { loot_box_category_name: 'Treasure Chests' } }] };
      }
    });

    await handleLootBoxesPage(mockInteraction);
    assert.ok(payload);
    const catBtn = payload.components.flatMap(r => r.components).find(b => b.data.custom_id === 'shop_lb_rename_cat');
    assert.ok(catBtn, 'shop_lb_rename_cat button must exist');
    assert.equal(catBtn.data.label, 'Appearance');
    assert.equal(catBtn.data.emoji.name, '🖼️');

    await handleLootBoxRenameCatStart(mockInteraction);
    assert.ok(modalShown);
    assert.equal(modalShown.data.title, 'Appearance');
  });

  it('6. Shop Item Details Tab: Appearance button and modal title', async () => {
    let payload = null;
    let modalShown = null;
    const mockItem = {
      id: 77,
      guild_id: validGuildId,
      name: 'Legendary Sword',
      price: 100,
      description: 'A sharp blade',
      image_url: 'https://example.com/sword.png'
    };

    setMockPool({
      query: async (sql) => {
        if (sql.includes('FROM shop_items')) {
          return { rows: [mockItem] };
        }
        if (sql.includes('FROM shop_categories')) {
          return { rows: [] };
        }
        return { rows: [{ config: {} }] };
      }
    });

    const mockInteraction = {
      guildId: validGuildId,
      guild: { id: validGuildId, roles: { cache: new Map() } },
      customId: 'shop_item_tab_details_77',
      deferred: true,
      replied: false,
      isAnySelectMenu: () => false,
      isButton: () => true,
      editReply: async (p) => { payload = p; return p; },
      showModal: async (m) => { modalShown = m; return m; },
      followUp: async () => {}
    };

    await handleEditItemSelect(mockInteraction);
    assert.ok(payload && payload.components);
    const tabRow = payload.components[0].components;
    
    const detailsBtn = tabRow.find(b => b.data.custom_id === 'shop_item_tab_details_77');
    assert.ok(detailsBtn, 'shop_item_tab_details_77 button must exist');
    assert.equal(detailsBtn.data.label, 'Details');
    assert.equal(detailsBtn.data.emoji.name, 'ℹ️');

    const appBtn = tabRow.find(b => b.data.custom_id === 'shop_item_appearance_btn_77');
    assert.ok(appBtn, 'shop_item_appearance_btn_77 button must exist');
    assert.equal(appBtn.data.label, 'Appearance');
    assert.equal(appBtn.data.emoji.name, '🖼️');

    const configBtn = tabRow.find(b => b.data.custom_id === 'shop_item_tab_config_77');
    assert.ok(configBtn, 'shop_item_tab_config_77 button must exist');
    assert.equal(configBtn.data.label, 'Config');
    assert.equal(configBtn.data.emoji.name, '⚙️');

    const usersBtn = tabRow.find(b => b.data.custom_id === 'shop_item_tab_users_77');
    assert.ok(usersBtn, 'shop_item_tab_users_77 button must exist');
    assert.equal(usersBtn.data.label, 'Users');
    assert.equal(usersBtn.data.emoji.name, '👥');

    mockInteraction.customId = 'shop_item_appearance_btn_77';
    await handleOpenAppearanceModal(mockInteraction);
    assert.ok(modalShown);
    assert.equal(modalShown.data.title, 'Appearance');
  });

  it('7. Shop Item Creation Wizard: Tab bar emojis disabled placeholder', async () => {
    let payload = null;
    const mockInteraction = {
      guildId: validGuildId,
      deferred: true,
      replied: false,
      editReply: async (p) => { payload = p; return p; }
    };
    await handleCreateItemStart(mockInteraction);
    assert.ok(payload && payload.components);
    const tabRow = payload.components[0].components;

    const detailsBtn = tabRow.find(b => b.data.custom_id === 'shop_item_tab_details_new');
    assert.ok(detailsBtn);
    assert.equal(detailsBtn.data.label, 'Details');
    assert.equal(detailsBtn.data.emoji.name, 'ℹ️');

    const appBtn = tabRow.find(b => b.data.custom_id === 'shop_item_appearance_btn_new');
    assert.ok(appBtn, 'shop_item_appearance_btn_new button must exist');
    assert.equal(appBtn.data.label, 'Appearance');
    assert.equal(appBtn.data.emoji.name, '🖼️');

    const configBtn = tabRow.find(b => b.data.custom_id === 'shop_item_tab_config_new');
    assert.ok(configBtn);
    assert.equal(configBtn.data.label, 'Config');
    assert.equal(configBtn.data.emoji.name, '⚙️');

    const usersBtn = tabRow.find(b => b.data.custom_id === 'shop_item_tab_users_new');
    assert.ok(usersBtn);
    assert.equal(usersBtn.data.label, 'Users');
    assert.equal(usersBtn.data.emoji.name, '👥');
  });

  it('8. Post Item Wizard: Appearance button and Post appearance modal title', async () => {
    let payload = null;
    let modalShown = null;
    const mockInteraction = {
      guildId: validGuildId,
      channelId: '999',
      deferred: true,
      replied: false,
      customId: 'shop_post_appearance_btn:test-session',
      editReply: async (p) => { payload = p; return p; },
      showModal: async (m) => { modalShown = m; return m; },
      followUp: async () => {}
    };

    setMockPool({
      query: async (sql) => {
        if (sql.includes('FROM shop_items')) {
          return {
            rows: [{
              id: 88,
              name: 'Dragon Shield',
              price: 50,
              guild_id: validGuildId
            }]
          };
        }
        return { rows: [] };
      }
    });

    await handleShopPostStart(mockInteraction);
    assert.ok(payload && payload.components);
    const btnRow = payload.components[2].components;
    const appBtn = btnRow.find(b => b.data.custom_id.startsWith('shop_post_appearance_btn'));
    assert.ok(appBtn, 'shop_post_appearance_btn button must exist');
    assert.equal(appBtn.data.label, 'Appearance');
    assert.equal(appBtn.data.emoji.name, '🖼️');

    await handleShopPostAppearanceBtn(mockInteraction);
    assert.ok(modalShown);
    assert.equal(modalShown.data.title, 'Appearance');
  });
});
