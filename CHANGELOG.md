# Changelog

Each release ships as a patch file in `patches/` (for example `patches/v2.patch`). Apply with `git apply patches/v2.patch`, or `git am patches/v2.patch` to keep the commit message.

## v2.0.0

Household money, admin control, and a check that your data really reaches Turso.

### Data safety
- In production (Render, Vercel or `NODE_ENV=production`) the app no longer falls back to a temporary local file when `TURSO_DATABASE_URL` is missing. It shows a clear error instead of quietly losing entries on restart.
- **Settings → Database check** (admin): shows where data is stored, runs a write-and-read-back test, and lists every member's entry count and the latest saved entries with who added them.
- If a second person logs in on the same browser, the older tab is stopped (`409 session_changed`) instead of saving entries under the wrong person.
- Existing databases upgrade themselves on first start (new columns `entries.by_user`, `entries.debit_from`, `recurring.debit_from`; household entries and rules are back-filled). Existing settings get the new Household category and Auto Debit mode once.

### Household expenses and salary
- New **Household** category with its own sub-categories.
- A household entry has **Spent by** and **Debit from salary of** (a member or the shared household pool). The amount reduces only that person's balance (Income − Expenses − Savings); the family total counts it once; the Family view has a Shared household pool row.
- Fixed monthly commitments (EMI, SIP, RD, chit, bills) have the same *Debit from* option.
- Deleting a member moves the household items charged to them to the shared pool, so family totals do not change.

### Entries and commitments
- **Sub-category** is a dropdown of the category's choices plus **Other (type your own)**.
- New payment mode **Auto Debit**.
- Fixed monthly commitments can be **added, edited, paused and deleted** from the Dashboard, the Family view and the EMI & savings page. Editing a rule also updates the entry already posted for the current month; earlier months keep what was recorded.
- The admin can add, edit and delete **every** entry and every member's commitments (including moving an entry to another member).

### Family view
- Member picker: choose one member, several, or all, and optionally the shared household pool. Totals follow the selection.

### Phone and computer
- Phone layout: four bottom tabs plus a **More** menu, a floating **+** button, and tables shown as one card per row so Edit and Delete are always easy to tap.
- Fixed: the family picker's Done button being covered by the + button, and Edit/Delete being overlapped on narrow screens.

### Tests run for this release
- 68 API tests against a real server and database, 57 desktop browser tests, 40 phone-size browser tests, all passing.

## v1.0.0

First release: logins with admin / member / viewer roles, family members with relationships, calendar date pickers, budgets, recurring entries (EMI, SIP, RD, chit), Family view with member-wise panels, backup download.
