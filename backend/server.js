/**
 * RemindMe Backend Server
 * Handles: REST API, AiSensy WhatsApp, Outlook SMTP, Gemini AI
 * Runs as GitHub Actions job every 15 minutes
 */

const express = require('express');
const nodemailer = require('nodemailer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ─── File paths ───────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const FILES = {
  reminders: path.join(DATA_DIR, 'reminders.json'),
  users:     path.join(DATA_DIR, 'users.json'),
  contacts:  path.join(DATA_DIR, 'contacts.json'),
  logs:      path.join(DATA_DIR, 'logs.json'),
};

// Ensure data directory and files exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
Object.entries(FILES).forEach(([key, fp]) => {
  if (!fs.existsSync(fp)) {
    const defaults = {
      users: [{ id: 'admin', username: 'admin', password: 'admin', name: 'Administrator', role: 'admin' }],
      reminders: [], contacts: {}, logs: []
    };
    fs.writeFileSync(fp, JSON.stringify(defaults[key] || [], null, 2));
  }
});

// ─── Helpers ──────────────────────────────────────────────────
const readJSON  = (fp) => JSON.parse(fs.readFileSync(fp, 'utf8'));
const writeJSON = (fp, data) => fs.writeFileSync(fp, JSON.stringify(data, null, 2));

function addLog(type, message, detail = '') {
  const logs = readJSON(FILES.logs);
  logs.unshift({ type, message, detail, time: new Date().toISOString() });
  if (logs.length > 500) logs.splice(500);
  writeJSON(FILES.logs, logs);
  console.log(`[${type.toUpperCase()}] ${message}`, detail);
}

// ─── Email (Outlook SMTP) ──────────────────────────────────────
function createMailer() {
  return nodemailer.createTransport({
    host: 'smtp.office365.com',
    port: 587,
    secure: false,
    auth: {
      user: process.env.OUTLOOK_EMAIL,
      pass: process.env.OUTLOOK_PASSWORD,
    },
    tls: { ciphers: 'SSLv3' }
  });
}

async function sendEmail(to, subject, body) {
  try {
    const transporter = createMailer();
    await transporter.sendMail({
      from: `"RemindMe 🔔" <${process.env.OUTLOOK_EMAIL}>`,
      to,
      subject,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:24px;background:#f0f4f8;border-radius:12px">
          <div style="background:#0f2045;color:white;padding:16px 20px;border-radius:8px;margin-bottom:20px">
            <h2 style="margin:0;font-size:18px">⏰ RemindMe</h2>
          </div>
          <div style="background:white;padding:20px;border-radius:8px;border:1px solid #dde4ef">
            ${body.replace(/\n/g, '<br>')}
          </div>
          <p style="text-align:center;font-size:12px;color:#9ca3af;margin-top:16px">Sent by RemindMe</p>
        </div>`,
    });
    addLog('email', `Sent email to ${to}`, subject);
    return true;
  } catch (err) {
    addLog('error', `Email failed to ${to}`, err.message);
    return false;
  }
}

// ─── WhatsApp (AiSensy) ────────────────────────────────────────
async function sendWhatsApp(phone, message, templateName) {
  try {
    const payload = {
      apiKey: process.env.AISENSY_API_KEY,
      campaignName: templateName || process.env.AISENSY_CAMPAIGN_NAME || 'reminder_notification',
      destination: phone.replace(/\D/g, ''), // digits only
      userName: 'RemindMe',
      templateParams: [message],
      media: {},
      buttons: [],
      carouselCards: [],
      location: {}
    };

    const res = await fetch('https://backend.aisensy.com/campaign/t1/api/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (res.ok) {
      addLog('whatsapp', `Sent WhatsApp to ${phone}`, message.slice(0, 60));
      return true;
    } else {
      addLog('error', `WhatsApp failed to ${phone}`, JSON.stringify(data));
      return false;
    }
  } catch (err) {
    addLog('error', `WhatsApp error to ${phone}`, err.message);
    return false;
  }
}

// ─── Gemini AI ─────────────────────────────────────────────────
function getGemini() {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });
}

// ─── CRON LOGIC: Fire due reminders ───────────────────────────
async function processDueReminders() {
  const reminders = readJSON(FILES.reminders);
  const contacts  = readJSON(FILES.contacts);
  const now = new Date();

  // Window: reminders due in last 15 min that haven't been sent
  const due = reminders.filter(r => {
    if (r.completed || r.notified) return false;
    if (!r.date || !r.time) return false;
    const dueAt = new Date(`${r.date}T${r.time}`);
    const diffMin = (now - dueAt) / 60000;
    return diffMin >= 0 && diffMin <= 15;
  });

  console.log(`[CRON] Found ${due.length} due reminders at ${now.toISOString()}`);

  for (const r of due) {
    const userContacts = contacts[r.userId] || [];
    const selectedContacts = (r.contactIds || [])
      .map(id => userContacts.find(c => c.id === id))
      .filter(Boolean);

    const message = buildMessage(r);

    for (const contact of selectedContacts) {
      if ((r.platform === 'whatsapp' || r.platform === 'both') && contact.phone) {
        await sendWhatsApp(contact.phone, message, r.whatsappTemplate);
      }
      if ((r.platform === 'email' || r.platform === 'both') && contact.email) {
        await sendEmail(contact.email, `🔔 Reminder: ${r.title}`, message);
      }
    }

    // Mark as notified
    r.notified = true;
    r.notifiedAt = now.toISOString();

    // Handle recurring — schedule next occurrence
    if (r.recur && r.recur !== 'none') {
      const next = getNextOccurrence(r.date, r.recur);
      r.date = next;
      r.notified = false;
      r.notifiedAt = null;
    }

    addLog('reminder', `Processed: ${r.title}`, `platform:${r.platform}`);
  }

  if (due.length > 0) writeJSON(FILES.reminders, reminders);
  return due.length;
}

function buildMessage(r) {
  return `🔔 *Reminder: ${r.title}*\n\n${r.desc ? r.desc + '\n\n' : ''}📅 Due: ${r.date} at ${r.time}\n⚡ Priority: ${r.priority}\n\n_Sent by RemindMe_`;
}

function getNextOccurrence(dateStr, recur) {
  const d = new Date(dateStr);
  if (recur === 'daily')   d.setDate(d.getDate() + 1);
  if (recur === 'weekly')  d.setDate(d.getDate() + 7);
  if (recur === 'monthly') d.setMonth(d.getMonth() + 1);
  return d.toISOString().split('T')[0];
}

// ─── Digest: Gemini daily summary ─────────────────────────────
async function generateDigest(userId) {
  const reminders = readJSON(FILES.reminders);
  const today = new Date().toISOString().split('T')[0];
  const todayRems = reminders.filter(r =>
    r.userId === userId && !r.completed && r.date === today
  );

  if (!todayRems.length) return "You have no reminders for today! 🎉 Enjoy your day.";

  try {
    const model = getGemini();
    const prompt = `You are a helpful assistant. Summarize these reminders for today in a friendly, concise way (3-4 sentences max). Use emojis. Make it motivating.

Reminders:
${todayRems.map((r, i) => `${i+1}. ${r.title} at ${r.time || 'anytime'} (${r.priority} priority)${r.desc ? ' — ' + r.desc : ''}`).join('\n')}`;

    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (err) {
    addLog('error', 'Gemini digest failed', err.message);
    return todayRems.map(r => `• ${r.title} at ${r.time || 'anytime'}`).join('\n');
  }
}

// ─── AI: Parse natural language reminder ──────────────────────
async function parseNaturalLanguage(text, userId) {
  try {
    const model = getGemini();
    const today = new Date().toISOString().split('T')[0];
    const prompt = `Today is ${today}. Parse this reminder request into JSON. Return ONLY valid JSON, no markdown.

Input: "${text}"

Return this exact structure:
{
  "title": "short action title",
  "desc": "longer description if any, else empty string",
  "date": "YYYY-MM-DD",
  "time": "HH:MM",
  "priority": "high|medium|low",
  "recur": "none|daily|weekly|monthly"
}

Rules:
- If no date mentioned, use today
- If no time mentioned, use 09:00
- Infer priority from urgency words (urgent/important=high, normal=medium, someday=low)
- Title should be action-oriented and concise`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().replace(/```json|```/g, '').trim();
    return JSON.parse(raw);
  } catch (err) {
    addLog('error', 'NLP parse failed', err.message);
    return null;
  }
}

// ─── AI: Suggest priority & title ─────────────────────────────
async function suggestFields(title) {
  try {
    const model = getGemini();
    const prompt = `Given this reminder title, suggest improvements. Return ONLY valid JSON, no markdown.

Title: "${title}"

Return:
{
  "improvedTitle": "cleaner, action-oriented version of the title",
  "priority": "high|medium|low",
  "priorityReason": "one short sentence why"
}`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().replace(/```json|```/g, '').trim();
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// REST API ROUTES
// ═══════════════════════════════════════════════════════════════

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── Auth ──
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const users = readJSON(FILES.users);
  const user = users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const { password: _, ...safe } = user;
  res.json({ user: safe });
});

app.post('/api/register', (req, res) => {
  const { username, password, name } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: 'Missing fields' });
  const users = readJSON(FILES.users);
  if (users.find(u => u.username === username)) return res.status(409).json({ error: 'Username taken' });
  const newUser = { id: 'u_' + Date.now(), username, password, name, role: 'user' };
  users.push(newUser);
  writeJSON(FILES.users, users);
  const { password: _, ...safe } = newUser;
  res.json({ user: safe });
});

// ── Reminders ──
app.get('/api/reminders', (req, res) => {
  const { userId, role } = req.query;
  const all = readJSON(FILES.reminders);
  const result = role === 'admin' ? all : all.filter(r => r.userId === userId);
  res.json(result);
});

app.post('/api/reminders', (req, res) => {
  const reminders = readJSON(FILES.reminders);
  const reminder = { ...req.body, id: 'r_' + Date.now(), notified: false, createdAt: new Date().toISOString() };
  reminders.push(reminder);
  writeJSON(FILES.reminders, reminders);
  res.json(reminder);
});

app.put('/api/reminders/:id', (req, res) => {
  const reminders = readJSON(FILES.reminders);
  const i = reminders.findIndex(r => r.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Not found' });
  reminders[i] = { ...reminders[i], ...req.body };
  writeJSON(FILES.reminders, reminders);
  res.json(reminders[i]);
});

app.delete('/api/reminders/:id', (req, res) => {
  const reminders = readJSON(FILES.reminders);
  const filtered = reminders.filter(r => r.id !== req.params.id);
  writeJSON(FILES.reminders, filtered);
  res.json({ ok: true });
});

// ── Contacts ──
app.get('/api/contacts/:userId', (req, res) => {
  const contacts = readJSON(FILES.contacts);
  res.json(contacts[req.params.userId] || []);
});

app.post('/api/contacts/:userId', (req, res) => {
  const contacts = readJSON(FILES.contacts);
  if (!contacts[req.params.userId]) contacts[req.params.userId] = [];
  const contact = { ...req.body, id: 'c_' + Date.now() };
  contacts[req.params.userId].push(contact);
  writeJSON(FILES.contacts, contacts);
  res.json(contact);
});

app.put('/api/contacts/:userId/:contactId', (req, res) => {
  const contacts = readJSON(FILES.contacts);
  const list = contacts[req.params.userId] || [];
  const i = list.findIndex(c => c.id === req.params.contactId);
  if (i === -1) return res.status(404).json({ error: 'Not found' });
  list[i] = { ...list[i], ...req.body };
  contacts[req.params.userId] = list;
  writeJSON(FILES.contacts, contacts);
  res.json(list[i]);
});

app.delete('/api/contacts/:userId/:contactId', (req, res) => {
  const contacts = readJSON(FILES.contacts);
  contacts[req.params.userId] = (contacts[req.params.userId] || []).filter(c => c.id !== req.params.contactId);
  writeJSON(FILES.contacts, contacts);
  res.json({ ok: true });
});

// ── Users (admin) ──
app.get('/api/users', (req, res) => {
  const users = readJSON(FILES.users).map(({ password, ...u }) => u);
  res.json(users);
});

app.post('/api/users', (req, res) => {
  const { username, password, name, role } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: 'Missing fields' });
  const users = readJSON(FILES.users);
  if (users.find(u => u.username === username)) return res.status(409).json({ error: 'Username taken' });
  const newUser = { id: 'u_' + Date.now(), username, password, name, role: role || 'user' };
  users.push(newUser);
  writeJSON(FILES.users, users);
  res.json({ ok: true });
});

app.delete('/api/users/:id', (req, res) => {
  if (req.params.id === 'admin') return res.status(403).json({ error: 'Cannot delete admin' });
  const users = readJSON(FILES.users).filter(u => u.id !== req.params.id);
  writeJSON(FILES.users, users);
  // Also delete their reminders and contacts
  const reminders = readJSON(FILES.reminders).filter(r => r.userId !== req.params.id);
  writeJSON(FILES.reminders, reminders);
  const contacts = readJSON(FILES.contacts);
  delete contacts[req.params.id];
  writeJSON(FILES.contacts, contacts);
  res.json({ ok: true });
});

// ── AI Endpoints ──
app.post('/api/ai/parse', async (req, res) => {
  const { text, userId } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });
  const result = await parseNaturalLanguage(text, userId);
  if (!result) return res.status(500).json({ error: 'AI parsing failed' });
  res.json(result);
});

app.post('/api/ai/suggest', async (req, res) => {
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: 'No title' });
  const result = await suggestFields(title);
  if (!result) return res.status(500).json({ error: 'AI suggestion failed' });
  res.json(result);
});

app.get('/api/ai/digest/:userId', async (req, res) => {
  const digest = await generateDigest(req.params.userId);
  res.json({ digest });
});

// ── Logs ──
app.get('/api/logs', (req, res) => res.json(readJSON(FILES.logs)));

// ── Manual cron trigger (also called by GitHub Actions) ──
app.post('/api/cron/run', async (req, res) => {
  const secret = req.headers['x-cron-secret'];
  if (secret !== process.env.CRON_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  const count = await processDueReminders();
  res.json({ processed: count, time: new Date().toISOString() });
});

// ─── Start server or run as cron script ───────────────────────
const PORT = process.env.PORT || 3001;

if (process.env.RUN_CRON_ONLY === 'true') {
  // GitHub Actions mode — just process reminders and exit
  console.log('Running in CRON mode...');
  processDueReminders().then(count => {
    console.log(`Done. Processed ${count} reminders.`);
    process.exit(0);
  }).catch(err => {
    console.error('Cron error:', err);
    process.exit(1);
  });
} else {
  app.listen(PORT, () => console.log(`RemindMe server running on port ${PORT}`));
}
