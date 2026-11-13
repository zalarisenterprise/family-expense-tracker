# Family Expense Tracker

A private expense tracker for your family. Each person logs in with their own username and password.

- **Admin:** sees everyone's expenses, the **Family view** (every member's full details, one panel each), settings and budgets, and adds family members with their **name and relationship**.
- **Member:** sees their own expenses plus the shared household expenses.
- **Viewer:** sees the household expenses only, read-only.

Every date field (entry date, custom date range, recurring start month and day of month) opens a **calendar** you can tap.

It's built with Node.js (Express) and a Turso database. It runs on **Render** or **Vercel**.

---

## 1. Create the database on Turso (5 minutes)

**Using the website:**
1. Sign up at https://turso.tech.
2. Click **Create Database**, name it `family-expenses`, and pick the region closest to you (for example Mumbai, `bom`).
3. Open the database and copy its **URL**. It looks like `libsql://family-expenses-yourname.turso.io`.
4. Click **Generate Token** (or Create Token), choose *Read & Write* with no expiry, and copy the token.

**Or using the Turso CLI:**
```bash
turso auth signup
turso db create family-expenses
turso db show family-expenses --url
turso db tokens create family-expenses
```

You don't need to create any tables. The app creates them the first time it runs.

## 2. Make a secret key

The app signs login sessions with a secret key. Generate one:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Keep it private. If it changes, everyone has to log in again.

## 3. Put the code on GitHub (private repository)

Create a **private** repository in the `zalarisenterprise` account, then push this folder to it.

**With the GitHub CLI (`gh`)**, from this folder:
```bash
gh auth login
git init -b main
git add .
git commit -m "Family expense tracker"
gh repo create zalarisenterprise/family-expense-tracker --private --source=. --push
```

**Or on the website:**
1. Sign in to GitHub as `zalarisenterprise`, click **New repository**, name it `family-expense-tracker`, choose **Private**, and don't add a README.
2. Then run:
```bash
git init -b main
git add .
git commit -m "Family expense tracker"
git remote add origin https://github.com/zalarisenterprise/family-expense-tracker.git
git push -u origin main
```

The repository holds only the code. Passwords, the Turso token and the secret key live in your hosting settings, never in GitHub, and `.gitignore` keeps `local.db` and `.env` out.

**Your family doesn't need GitHub access.** They only open your website address and log in with the username and password you made for them. Keep the repository private and add only people who should change the code (Settings → Collaborators).

## 4a. Deploy on Render

1. Go to https://render.com and choose **New → Web Service**, then select your GitHub repo.
2. Use these settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
3. Under **Environment**, add:

| Key | Value |
|---|---|
| `TURSO_DATABASE_URL` | `libsql://family-expenses-yourname.turso.io` |
| `TURSO_AUTH_TOKEN` | your Turso token |
| `JWT_SECRET` | the secret key from step 2 |
| `NODE_ENV` | `production` |

4. Click **Deploy**. Your site will be at `https://<name>.onrender.com`.

> Render's free plan puts the app to sleep after about 15 minutes without visitors. The first visit after that takes 30–60 seconds to load. The paid plan doesn't sleep.

## 4b. Or deploy on Vercel

1. Go to https://vercel.com and choose **Add New → Project**, then import your GitHub repo.
2. **Framework preset:** Other. Leave the build and output settings empty.
3. Under **Environment Variables**, add the same four values as the Render table above.
4. Click **Deploy**. Your site will be at `https://<name>.vercel.app`.

Vercel serves `public/` as the website and runs `api/index.js` for every `/api/...` request (see `vercel.json`).

## 5. First login

1. Open your site. The first time, it shows **Create the admin account**. Choose your name, username and password.
2. Go to **Family members**, then **Add member**. Enter their name, relationship (Wife, Son, Mother…), username, role and a temporary password, then click **Copy** to send them the login details.
3. When they log in for the first time, they're asked to set their own password.

---

## Everyday admin tasks

| Task | Where |
|---|---|
| Someone forgot their password | Family members → **Reset password**, then send them the new temporary password |
| Stop someone logging in but keep their history | Family members → **Edit** → untick *Account active* |
| Change categories, payment modes, currency or month start day | Settings |
| Set the household budget | Budgets → Household budget → Edit budgets |
| Set a member's budget | Budgets → that member's block → Edit budgets |
| Change someone's relationship or name | Family members → **Edit** |
| See one member's full details | Family view → open their panel (or **Details ↓**) |
| See a member's EMI, SIP, RD or chit | EMI & savings → choose the person at the top |
| Download a full backup | Settings → **Download full backup** |

**If you, the admin, forget your own password**, run this on your computer from the project folder:
```bash
npm install
TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... npm run reset-password -- <your-username> <new-password>
```
On Windows PowerShell, set the variables first: `$env:TURSO_DATABASE_URL="..."; $env:TURSO_AUTH_TOKEN="..."`.

## Where your data lives, and keeping it safe for free

Everything is stored in your Turso database. Turso has a free plan that is plenty for a family (several GB of storage, with generous monthly read and write limits; check https://turso.tech/pricing for the current numbers). No free service can promise to exist forever, so the safe plan is **free hosting plus your own backups**:

1. **Use the app regularly.** Turso can archive a free database after about 10 days with no activity (check Turso's docs for the current rule). Your family logging in keeps it active. If it is ever archived, your data isn't lost: run `turso group unarchive <group-name>`.
2. **Download a backup every month or two.** Sign in as admin, open **Settings → Download full backup**, and save the file in Google Drive or on your computer. It contains all entries, members (without passwords), budgets and settings.
3. **Optional full copy with the Turso CLI:**
   ```bash
   turso db shell family-expenses .dump > backup-$(date +%F).sql
   ```
4. **If you ever need to move**, the same code works with any libSQL or SQLite database, so you can switch to another free provider such as Cloudflare D1 with small changes.

## Running on your own computer

```bash
npm install
npm start
```
Then open http://localhost:3000. Without Turso settings, it saves to a local file called `local.db`.

## Security built in

- Passwords are hashed with bcrypt and never stored or shown in plain text.
- Sessions use an HTTP-only, SameSite cookie that lasts 30 days, so scripts on the page can't read it.
- After 5 wrong passwords, the account is locked for 15 minutes.
- Changing or resetting a password logs that person out on their other devices.
- The server checks every request: members can only read and change their own entries plus household ones, and viewers can't change anything.
- Requests that change data must come from the app itself, which blocks cross-site attacks.

## Project layout

```
server.js            start file for Render or your own computer
api/index.js         start file for Vercel
vercel.json          sends /api/* to the API on Vercel
src/app.js           all API routes: login, users, entries, budgets, recurring, settings, backup
src/db.js            Turso connection and table creation
src/defaults.js      starting categories and payment modes
public/login.html    login page and first-time admin setup
public/index.html    the tracker app
scripts/             migrate and reset-password helpers
```
