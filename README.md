# ⏰ RemindMe — Smart Reminder Hub

AI-powered reminder app with WhatsApp (AiSensy) + Outlook email notifications, Gemini AI features, GitHub Actions scheduling, and GitHub Pages hosting.

---

## 🗂️ Project Structure

```
remindme/
├── frontend/
│   └── index.html              ← Full app (host on GitHub Pages)
├── backend/
│   ├── server.js               ← Node.js API + cron logic
│   ├── package.json
│   └── data/
│       ├── users.json          ← User accounts
│       ├── reminders.json      ← All reminders
│       ├── contacts.json       ← User contacts
│       └── logs.json           ← Send logs
├── .github/
│   └── workflows/
│       ├── reminder-cron.yml   ← Fires every 15 min
│       └── deploy.yml          ← Auto-deploys frontend
└── README.md
```

---

## 🚀 Setup Guide (Step by Step)

### Step 1 — Create GitHub Repository

1. Go to [github.com](https://github.com) → **New repository**
2. Name it `remindme` → Set to **Public** (required for free GitHub Pages)
3. Upload all the project files

### Step 2 — Add GitHub Secrets

Go to your repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

Add these secrets:

| Secret Name | Value | Where to get it |
|---|---|---|
| `AISENSY_API_KEY` | Your AiSensy API key | AiSensy dashboard → API |
| `AISENSY_CAMPAIGN_NAME` | Your campaign name | AiSensy → Campaigns |
| `OUTLOOK_EMAIL` | your@outlook.com | Your Microsoft 365 email |
| `OUTLOOK_PASSWORD` | Your password or App Password | Microsoft account settings |
| `GEMINI_API_KEY` | Your Gemini API key | [aistudio.google.com](https://aistudio.google.com) → Get API Key |
| `GH_PAT` | GitHub Personal Access Token | GitHub → Settings → Developer Settings → PAT (classic) → give `repo` scope |
| `CRON_SECRET` | Any random string e.g. `mysecret123` | You make this up |

### Step 3 — Enable GitHub Pages

1. Go to repo → **Settings** → **Pages**
2. Source: **GitHub Actions**
3. Save — the deploy workflow will run automatically on next push

### Step 4 — Enable GitHub Actions

1. Go to repo → **Actions** tab
2. If prompted, click **"I understand my workflows, go ahead and enable them"**
3. The cron job will now run every 15 minutes automatically

### Step 5 — Configure the Frontend

1. Open your GitHub Pages URL: `https://yourusername.github.io/remindme`
2. Log in with **admin / admin**
3. Go to **Settings** in the sidebar
4. If you're using Railway/Render for the backend: paste the backend URL
5. If using GitHub Actions only (no separate backend): leave blank — app runs in offline mode

---

## 📱 AiSensy Setup

1. Log in to [app.aisensy.com](https://app.aisensy.com)
2. Go to **Campaigns** → Create a new campaign
3. Campaign type: **API Campaign**
4. Template: Create a template like:
   ```
   🔔 Reminder: {{1}}
   ```
   Where `{{1}}` will be replaced with your reminder message
5. Once approved, copy the **Campaign Name** → add to GitHub Secrets as `AISENSY_CAMPAIGN_NAME`
6. Copy your **API Key** from Settings → add as `AISENSY_API_KEY`

---

## 📧 Outlook/Microsoft 365 Setup

If you have 2FA enabled on your Microsoft account:
1. Go to [account.microsoft.com](https://account.microsoft.com)
2. Security → Advanced security options → App passwords
3. Create a new app password for "RemindMe"
4. Use this app password as `OUTLOOK_PASSWORD` (not your regular password)

---

## 🤖 Gemini AI Setup (Free)

1. Go to [aistudio.google.com](https://aistudio.google.com)
2. Click **Get API Key** → Create API key
3. Add to GitHub Secrets as `GEMINI_API_KEY`
4. Free tier: 15 requests/minute — more than enough for personal use

---

## ⏱️ How the Cron Works

- GitHub Actions runs `reminder-cron.yml` every 15 minutes (free, no server needed)
- The script checks `backend/data/reminders.json` for reminders due in the last 15 minutes
- Sends WhatsApp via AiSensy API + email via Outlook SMTP
- Updates `notified: true` in the JSON and commits back to the repo
- Recurring reminders automatically get their next date scheduled

**Note:** Reminders may be delivered up to 15 minutes late due to GitHub Actions minimum interval.

---

## 🔑 Default Login

- **Username:** `admin`
- **Password:** `admin`

⚠️ Change this immediately after first login by editing `backend/data/users.json`

---

## 💰 Cost Summary

| Service | Cost |
|---|---|
| GitHub (repo + Actions + Pages) | **₹0 forever** |
| AiSensy | Your existing plan |
| Microsoft 365 SMTP | **₹0** (already have it) |
| Gemini Flash API | **₹0** (free tier) |
| **Total** | **₹0/month** |

---

## 🛠️ Local Development

```bash
cd backend
npm install
cp .env.example .env  # fill in your keys
npm run dev           # starts server on port 3001
```

Open `frontend/index.html` directly in browser → set backend URL to `http://localhost:3001` in Settings.
