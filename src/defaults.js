// Bump this when DEFAULT_CONFIG gains new built-in items that older saved settings should receive once.
export const CFG_VERSION = 2;

export const HOUSEHOLD_CATEGORY = {
  id: 'household', name: 'Household', color: '#0e9aa7',
  subs: ['Maid / Help', 'Cleaning supplies', 'Kitchen items', 'Gas cylinder', 'Repairs', 'Appliances', 'Home decor', 'Pest control', 'Water can / purifier', 'Laundry'],
};

export const DEFAULT_CONFIG = {
  cfgVersion: CFG_VERSION,
  currency: '₹',
  monthStartDay: 1,
  categories: [
    { id: 'food', name: 'Food & Groceries', color: '#2a78d6', subs: ['Groceries', 'Vegetables', 'Hotel', 'Snacks'] },
    { id: 'home', name: 'Rent & Home', color: '#eb6834', subs: ['Rent', 'Maintenance', 'Furniture'] },
    { ...HOUSEHOLD_CATEGORY, subs: [...HOUSEHOLD_CATEGORY.subs] },
    { id: 'bills', name: 'Bills & Utilities', color: '#1baf7a', subs: ['EB Bill', 'Water', 'Internet', 'Mobile recharge', 'Gas'] },
    { id: 'travel', name: 'Transport', color: '#eda100', subs: ['Fuel', 'Bus / Train', 'Cab / Auto', 'Vehicle service'] },
    { id: 'shop', name: 'Shopping', color: '#e87ba4', subs: ['Clothes', 'Electronics', 'Online'] },
    { id: 'health', name: 'Health', color: '#008300', subs: ['Medicines', 'Doctor', 'Insurance'] },
    { id: 'edu', name: 'Education', color: '#6250d6', subs: ['School fees', 'Books', 'Courses'] },
    { id: 'emi', name: 'EMI & Loans', color: '#e34948', subs: [] },
    { id: 'fun', name: 'Entertainment', color: '#7a7a74', subs: ['Movies', 'Subscriptions', 'Outings'] },
    { id: 'other', name: 'Others', color: '#9a9992', subs: [] },
  ],
  incomeCategories: ['Salary', 'Business', 'Interest', 'Gift', 'Other income'],
  savingCategories: ['SIP / Mutual fund', 'RD', 'Chit fund', 'FD', 'PPF / EPF', 'Gold', 'Stocks', 'Other savings'],
  modes: ['Cash', 'UPI', 'Debit card', 'Credit card', 'Bank transfer', 'Auto Debit'],
};

// One-time upgrade of settings saved by an older version: add the new built-in
// "Household" category and "Auto Debit" payment mode (only once, so a later removal sticks).
export function upgradeConfig(cfg) {
  const out = { ...cfg, categories: (cfg.categories || []).map((c) => ({ ...c })), modes: [...(cfg.modes || [])] };
  const hasHousehold = out.categories.some((c) => c.id === 'household' || /^house\s?hold$/i.test(String(c.name || '').trim()));
  if (!hasHousehold) {
    const at = out.categories.findIndex((c) => c.id === 'other');
    const cat = { ...HOUSEHOLD_CATEGORY, subs: [...HOUSEHOLD_CATEGORY.subs] };
    if (at >= 0) out.categories.splice(at, 0, cat); else out.categories.push(cat);
  }
  if (!out.modes.some((m) => String(m).trim().toLowerCase() === 'auto debit')) out.modes.push('Auto Debit');
  out.cfgVersion = CFG_VERSION;
  return out;
}

const clip = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const cleanList = (a) => (Array.isArray(a) ? a.map((x) => clip(x, 60)).filter(Boolean).slice(0, 40) : []);

// Turns settings sent by the app (or found in a backup file) into a safe, complete config.
// Returns null when there is no category at all.
export function cleanConfig(b, makeId) {
  b = b && typeof b === 'object' ? b : {};
  const cats = Array.isArray(b.categories) ? b.categories.slice(0, 60).map((c) => {
    c = c && typeof c === 'object' ? c : {};
    return {
      id: clip(c.id, 40) || makeId(),
      name: clip(c.name, 60) || 'Category',
      color: /^#[0-9a-fA-F]{6}$/.test(c.color) ? c.color : '#9a9992',
      subs: Array.isArray(c.subs) ? c.subs.map((x) => clip(x, 60)).filter(Boolean).slice(0, 40) : [],
    };
  }) : null;
  if (!cats || !cats.length) return null;
  const inc = cleanList(b.incomeCategories), sav = cleanList(b.savingCategories), modes = cleanList(b.modes);
  return {
    cfgVersion: CFG_VERSION,
    currency: clip(b.currency, 5) || '₹',
    monthStartDay: Math.min(28, Math.max(1, parseInt(b.monthStartDay, 10) || 1)),
    categories: cats,
    incomeCategories: inc.length ? inc : DEFAULT_CONFIG.incomeCategories,
    savingCategories: sav.length ? sav : DEFAULT_CONFIG.savingCategories,
    modes: modes.length ? modes : DEFAULT_CONFIG.modes,
  };
}
