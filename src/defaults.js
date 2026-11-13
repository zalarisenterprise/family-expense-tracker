export const DEFAULT_CONFIG = {
  currency: '₹',
  monthStartDay: 1,
  categories: [
    { id: 'food', name: 'Food & Groceries', color: '#2a78d6', subs: ['Groceries', 'Vegetables', 'Hotel', 'Snacks'] },
    { id: 'home', name: 'Rent & Home', color: '#eb6834', subs: ['Rent', 'Maintenance', 'Furniture'] },
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
  modes: ['Cash', 'UPI', 'Debit card', 'Credit card', 'Bank transfer'],
};
