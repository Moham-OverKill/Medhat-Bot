import { StringSelectMenuBuilder } from 'discord.js';

/**
 * Builds a paginated StringSelectMenuBuilder with a maximum of 20 items per page
 * plus Back, Previous Page, and Next Page navigation options.
 *
 * @param {Object} params
 * @param {Array} params.items - Full array of items to paginate
 * @param {number} [params.page=1] - Current page number (1-indexed)
 * @param {string} params.customId - Custom ID for the select menu
 * @param {string} params.placeholder - Placeholder text
 * @param {Function} params.mapOption - Function(item, index) returning { label, value, description?, emoji? }
 * @param {Object} [params.backOption] - Optional { label, value, emoji?, description? } for top back option
 * @param {string} [params.pageNavPrefix] - Value prefix for page navigation options (e.g., 'nav_page_')
 * @param {number} [params.pageSize=20] - Number of item options per page
 * @returns {{ selectMenu: StringSelectMenuBuilder, page: number, totalPages: number, pageSlice: Array }}
 */
export function buildPaginatedSelectMenu({
  items = [],
  page = 1,
  customId,
  placeholder,
  mapOption,
  backOption = null,
  pageNavPrefix = 'nav_page_',
  pageSize = 20
}) {
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const currentPage = Math.min(Math.max(1, page), totalPages);

  const startIndex = (currentPage - 1) * pageSize;
  const pageSlice = items.slice(startIndex, startIndex + pageSize);

  const options = [];

  // 1. Previous Option (All the way at the top if page > 1)
  if (currentPage > 1) {
    options.push({
      label: 'Previous',
      value: `${pageNavPrefix}${currentPage - 1}`,
      emoji: '◀️',
      description: `Show items from page ${currentPage - 1}`
    });
  }

  // 2. Back Option
  if (backOption) {
    const bOpt = {
      label: backOption.label || 'Back',
      value: backOption.value || 'back',
      emoji: backOption.emoji || '⬅️'
    };
    if (backOption.description) bOpt.description = backOption.description;
    options.push(bOpt);
  }

  // 3. Page Item Options
  pageSlice.forEach((item, idx) => {
    const opt = mapOption(item, startIndex + idx);
    if (opt) options.push(opt);
  });

  // 4. Next Option (All the way at the bottom if page < totalPages)
  if (currentPage < totalPages) {
    options.push({
      label: 'Next',
      value: `${pageNavPrefix}${currentPage + 1}`,
      emoji: '▶️',
      description: `Show items from page ${currentPage + 1}`
    });
  }

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .addOptions(options);

  return {
    selectMenu,
    page: currentPage,
    totalPages,
    pageSlice
  };
}
