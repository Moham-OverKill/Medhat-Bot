# 🏗️ MVP Discord Bot: Master Architecture & Logic Anchor

This document is the **definitive Source of Truth** for the AI coding assistant. It defines the system architecture, state management rules, core business logic, and strict coding conventions. **Read this file before every task.**

## 1. System Philosophy: "The Source of Truth" Model

The system follows a strict hierarchical state model to ensure data integrity and prevent race conditions.

### A. Data Hierarchy
1.  **PostgreSQL (Master State):** The absolute source of truth for all persistent data (Balances, Inventory, Shop Config, Missions, Transactions). If it’s not in Postgres, it doesn’t exist.
2.  **Discord States (Shared View):**
    *   **Roles:** The "View Layer" for inventory items. Roles are awarded/removed based on DB state changes.
    *   **Channels/Permissions:** Controlled by the bot/admin.
3.  **In-Memory State (Transient):**
    *   Used only for active interaction setups (e.g., `trade.js` `ACTIVE_SETUPS`, `shop-setup.js` `pendingPosts`, activity cooldowns).
    *   Never stores master data. If the bot restarts, transient state is safely lost.

### B. The Inventory Synthesis (The 3 States)
*   **State A (Owned):** Item exists in DB `user_inventory` and role is present in Discord.
*   **State B (Inactive):** Item exists in DB but role is NOT present (Unequipped/Expired).
*   **State C (Admin-Granted):** Role is present in Discord but NO entry exists in DB.
    *   **Rule:** These items must be synthesized into the `/bank` and `/inventory` views as "🛡️ Admin Granted."
    *   **Rule:** State C items are "Soulbound" and cannot be traded or dropped.

---

## 2. Core Modules & Responsibilities

### Economy System (`src/economy/`)
*   **`service.js`**: Atomic balance updates, daily claim logic (Cairo time), and streak management.
*   **`shop.js`**: The central hub for purchasing. Handles prerequisite checks, stock management, seller payouts, and pack logic.
*   **`shop-setup.js`**: Admin-only shop configuration (Items, Packs, Categories).

### Activity & MVP (`src/activity/`, `src/mvp/`)
*   **`tracker.js`**: Text (cooldown based) and Voice (stopwatch based) activity tracking.
*   **`award.js`**: The Daily Cycle. Hardcoded to **00:00 Cairo Time**. Executes:
    1.  Voice Time Flush.
    2.  Stale Streak Clear.
    3.  MVP Award Ceremony (Roles + Payouts).
    4.  Leaderboard Snapshot.
    5.  Deep Point Reset.

### Missions (`src/missions/`)
*   **`missions.js`**: Daily mission rotation (Cairo midnight). Progress is only tracked if a user explicitly "starts" the mission.

### Storage & Audit (`src/storage/`)
*   **`postgres.js`**: Connection pooling and schema.
*   **`config.js`**: Per-server JSONB configuration with schema validation.
*   **`audit.js`**: High-level system logs and automated refunds.

---

## 3. Strict State Management Rules

### RULE 1: Transactional Atomicity
All financial and ownership transfers MUST be wrapped in SQL transactions (`BEGIN`/`COMMIT`/`ROLLBACK`).
*   **Example:** If a role assignment fails during a purchase, the coin deduction must be rolled back.

### RULE 2: Just-In-Time (JIT) Validation
Condition checks (Balance, Ownership, PREREQUISITES) must be re-validated at the moment of execution, inside the transaction, to prevent race conditions.

### RULE 3: Soulbound Items
*   All items with a duration (Temporary items) are Soulbound.
*   All Admin-Granted (State C) items are Soulbound.
*   **Soulbound items cannot be Traded or Dropped.**

---

## 4. UI/UX & Interaction Patterns

<h3>The "Interaction Router" Pattern</h3>
All slash commands and component interactions (buttons, selects, modals) must route through a centralized handler found in `src/index.js`.

### Ephemeral Consistency
*   Administrative panels and sensitive setups (Bank, Trade config, Shop setup) MUST use ephemeral responses to prevent channel clutter.
*   High-stakes actions (Dropping items, Deleting categories) MUST use a 2-step confirmation flow.

### Navigation Components
*   **Carousels:** Used for paginating items (e.g., Inventory item management).
*   **Back Buttons:** Every sub-menu MUST have a "Back" button returning to the parent view.

---

## 5. Global Coding Conventions

### A. Safety & Sanity
*   **Economy Ceiling:** Hard cap of **700,000,000,000 OK Coins**.
*   **Snowflake Validation:** Always use `isValidSnowflake()` from `shared.js` before querying or acting on IDs.
*   **Error Handling:** Use `handleInteractionError` or `sanitizeError` to prevent sensitive data leakage.

### B. Time Handling
*   **Official Timezone:** `Africa/Cairo` (GMT+2/+3).
*   **Midnight Reset:** All "Daily" logic triggers at **00:00 Cairo Time**.

### C. Constants
*   **Coin Emoji:** `<:OK_COIN:1490666813501997076>` (Stored as `COIN_EMOJI` in `shared.js`).
*   **Thumbnails:** Bank and Shop use hardcoded media URLs for consistency.

---

## 6. Prime Directive for AI
> **"Study Before Writing. Ask Before Assuming. Roll Back Before Breaking."**
> 1.  Read the relevant logic files in full.
> 2.  Validate against this architecture document.
> 3.  If a variable (e.g., `interaction`, `COIN_EMOJI`) is not explicitly available in scope, **find where it is defined or ask.** Do not invent it.
