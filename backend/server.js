/**
 * RemindMe Backend Server
 * Handles: REST API, AiSensy WhatsApp, Outlook SMTP, Gemini AI
 * Database: Supabase (PostgreSQL)
 * Runs as GitHub Actions cron every 15 minutes
 */

const express = require('express');
const nodemailer = require('nodemailer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const crypto = require('crypto');

// Hash password same way as frontend
function hashPassword(password) {
  return crypto.createHash('sha256').update(password + 'remindme_salt_2025').digest('hex');
}

const app = express();
app.use(cors());
app.use(express.json());

// ─── Supabase client ──────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Logging ──────────────────────────────────────────────────
async function addLog(type, message, detail = '', userId = null) {
  console.log(`[${type.toUpperCase()}] ${message}`, detail);
  try { await supabase.from('logs').insert({ type, message, detail, user_id: userId }); } catch(e) {}
}

// ─── Email (Outlook SMTP) ─────────────────────────────────────
async function sendEmail(to, subject, body) {
  try {
    const transporter = nodemailer.createTransport({
      host: 'smtp.office365.com', port: 587, secure: false,
      auth: { user: process.env.OUTLOOK_EMAIL, pass: process.env.OUTLOOK_PASSWORD },
      tls: { ciphers: 'SSLv3' }
    });
    await transporter.sendMail({
      from: `"RemindMe 🔔" <${process.env.OUTLOOK_EMAIL}>`, to, subject,
      html: `<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;padding:24px;background:#f0f4f8;border-radius:12px">
        <div style="background:#0f2045;color:white;padding:16px 20px;border-radius:8px;margin-bottom:20px"><h2 style="margin:0">⏰ RemindMe</h2></div>
        <div style="background:white;padding:20px;border-radius:8px;border:1px solid #dde4ef">${body.replace(/\n/g,'<br>')}</div>
        <p style="text-align:center;font-size:12px;color:#9ca3af;margin-top:16px">Sent by RemindMe</p></div>`
    });
    await addLog('email', `Sent email to ${to}`, subject);
    return true;
  } catch (err) { await addLog('error', `Email failed to ${to}`, err.message); return false; }
}

// ─── WhatsApp (AiSensy) ───────────────────────────────────────
async function sendWhatsApp(phone, message, params = {}) {
  try {
    const res = await fetch('https://backend.aisensy.com/campaign/t1/api/v2', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: process.env.AISENSY_API_KEY,
        campaignName: process.env.AISENSY_CAMPAIGN_NAME,
        destination: phone.replace(/\D/g, ''),
        userName: 'RemindMe',
        templateParams: [
          params.title || message,
          params.datetime || '',
          params.priority || '',
          params.desc || ''
        ],
        media: {}, buttons: [], carouselCards: [], location: {}
      })
    });
    const data = await res.json();
    if (res.ok) { await addLog('whatsapp', `Sent WhatsApp to ${phone}`, message.slice(0,60)); return true; }
    else { await addLog('error', `WhatsApp failed to ${phone}`, JSON.stringify(data)); return false; }
  } catch (err) { await addLog('error', `WhatsApp error`, err.message); return false; }
}

// ─── Gemini AI ────────────────────────────────────────────────
function getGemini() {
  return new GoogleGenerativeAI(process.env.GEMINI_API_KEY).getGenerativeModel({ model: 'gemini-1.5-flash' });
}

// ─── CRON: Process due reminders ─────────────────────────────
async function processDueReminders() {
  const now = new Date();
  const { data: reminders, error } = await supabase.from('reminders').select('*').eq('completed', false).eq('notified', false);
  if (error) { console.error('Supabase fetch error:', error); return 0; }

  const due = (reminders || []).filter(r => {
    if (!r.date || !r.time) return false;
    // Treat reminder time as IST (UTC+5:30) since users enter local time
    const dueAt = new Date(`${r.date}T${r.time}:00+05:30`);
    const diffMin = (now - dueAt) / 60000;
    console.log(`[CHECK] "${r.title}" due at ${dueAt.toISOString()} | now: ${now.toISOString()} | diff: ${diffMin.toFixed(1)} min`);
    return diffMin >= 0 && diffMin <= 16;
  });

  console.log(`[CRON] ${due.length} due reminders at ${now.toISOString()}`);

  for (const r of due) {
    const contactIds = r.contact_ids || [];
    let contacts = [];
    if (contactIds.length) {
      const { data } = await supabase.from('contacts').select('*').in('id', contactIds);
      contacts = data || [];
    }
    const message = `🔔 Reminder: ${r.title}\n\n${r.description ? r.description + '\n\n' : ''}📅 ${r.date} at ${r.time}\n⚡ Priority: ${r.priority}`;
    const waParams = {
      title: r.title,
      datetime: `${r.date} at ${r.time}`,
      priority: r.priority.charAt(0).toUpperCase() + r.priority.slice(1),
      desc: r.description || 'No additional details'
    };
    for (const contact of contacts) {
      if ((r.platform === 'whatsapp' || r.platform === 'both') && contact.phone) await sendWhatsApp(contact.phone, message, waParams);
      if ((r.platform === 'email' || r.platform === 'both') && contact.email) await sendEmail(contact.email, `🔔 Reminder: ${r.title}`, message);
    }
    const updateData = { notified: true, notified_at: now.toISOString() };
    if (r.recur && r.recur !== 'none') {
      const d = new Date(r.date);
      if (r.recur === 'daily') d.setDate(d.getDate()+1);
      if (r.recur === 'weekly') d.setDate(d.getDate()+7);
      if (r.recur === 'monthly') d.setMonth(d.getMonth()+1);
      updateData.date = d.toISOString().split('T')[0];
      updateData.notified = false; updateData.notified_at = null;
    }
    await supabase.from('reminders').update(updateData).eq('id', r.id);
    await addLog('reminder', `Processed: ${r.title}`, `platform:${r.platform}`, r.user_id);
  }
  return due.length;
}

// ─── Gemini: Digest ───────────────────────────────────────────
async function generateDigest(userId) {
  const today = new Date().toISOString().split('T')[0];
  const { data: reminders } = await supabase.from('reminders').select('*').eq('user_id', userId).eq('completed', false).eq('date', today);
  if (!reminders?.length) return "You have no reminders for today! 🎉 Enjoy your day.";
  try {
    const result = await getGemini().generateContent(`Summarize these today's reminders in 3-4 friendly sentences with emojis:\n${reminders.map((r,i)=>`${i+1}. ${r.title} at ${r.time||'anytime'} (${r.priority})`).join('\n')}`);
    return result.response.text();
  } catch(e) { return reminders.map(r=>`• ${r.title} at ${r.time||'anytime'}`).join('\n'); }
}

// ─── Gemini: Parse NL ─────────────────────────────────────────
async function parseNaturalLanguage(text) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const result = await getGemini().generateContent(`Today is ${today}. Parse this reminder into JSON only, no markdown:\n"${text}"\nReturn: {"title":"...","desc":"...","date":"YYYY-MM-DD","time":"HH:MM","priority":"high|medium|low","recur":"none|daily|weekly|monthly"}\nRules: no date=today, no time=09:00`);
    return JSON.parse(result.response.text().replace(/```json|```/g,'').trim());
  } catch(e) { return null; }
}

// ─── Gemini: Suggest ──────────────────────────────────────────
async function suggestFields(title) {
  try {
    const result = await getGemini().generateContent(`Improve this reminder title and suggest priority. Return JSON only:\n"${title}"\nReturn: {"improvedTitle":"...","priority":"high|medium|low","priorityReason":"one sentence"}`);
    return JSON.parse(result.response.text().replace(/```json|```/g,'').trim());
  } catch(e) { return null; }
}

// ═══════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// Auth
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const hashed = hashPassword(password);
  // Try hashed first, fallback to plain
  let { data } = await supabase.from('users').select('*').eq('username', username).eq('password', hashed).single();
  if (!data) {
    const res2 = await supabase.from('users').select('*').eq('username', username).eq('password', password).single();
    if (!res2.data) return res.status(401).json({ error: 'Invalid credentials' });
    data = res2.data;
    await supabase.from('users').update({ password: hashed }).eq('id', data.id);
  }
  const { password: _, ...safe } = data;
  res.json({ user: safe });
});

app.post('/api/register', async (req, res) => {
  const { username, password, name } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: 'Missing fields' });
  const newUser = { id: 'u_' + Date.now(), username, password: hashPassword(password), name, role: 'user' };
  const { error } = await supabase.from('users').insert(newUser);
  if (error) return res.status(409).json({ error: 'Username already taken' });
  const { password: _, ...safe } = newUser;
  res.json({ user: safe });
});

// Reminders
app.get('/api/reminders', async (req, res) => {
  const { userId, role } = req.query;
  let q = supabase.from('reminders').select('*').order('created_at', { ascending: false });
  if (role !== 'admin') q = q.eq('user_id', userId);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/reminders', async (req, res) => {
  const b = req.body;
  const r = { id:'r_'+Date.now(), user_id:b.userId, title:b.title, description:b.desc||'', date:b.date, time:b.time, priority:b.priority||'medium', recur:b.recur||'none', platform:b.platform||'whatsapp', contact_ids:b.contactIds||[], completed:false, notified:false };
  const { data, error } = await supabase.from('reminders').insert(r).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/reminders/:id', async (req, res) => {
  const b = req.body;
  const updates = {};
  if (b.title !== undefined) updates.title = b.title;
  if (b.desc !== undefined) updates.description = b.desc;
  if (b.description !== undefined) updates.description = b.description;
  if (b.date !== undefined) updates.date = b.date;
  if (b.time !== undefined) updates.time = b.time;
  if (b.priority !== undefined) updates.priority = b.priority;
  if (b.recur !== undefined) updates.recur = b.recur;
  if (b.platform !== undefined) updates.platform = b.platform;
  if (b.contactIds !== undefined) updates.contact_ids = b.contactIds;
  if (b.contact_ids !== undefined) updates.contact_ids = b.contact_ids;
  if (b.completed !== undefined) updates.completed = b.completed;
  const { data, error } = await supabase.from('reminders').update(updates).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/reminders/:id', async (req, res) => {
  const { error } = await supabase.from('reminders').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Contacts
app.get('/api/contacts/:userId', async (req, res) => {
  const { data, error } = await supabase.from('contacts').select('*').eq('user_id', req.params.userId);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/contacts/:userId', async (req, res) => {
  const c = { id:'c_'+Date.now(), user_id:req.params.userId, name:req.body.name, phone:req.body.phone||'', email:req.body.email||'' };
  const { data, error } = await supabase.from('contacts').insert(c).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/contacts/:userId/:contactId', async (req, res) => {
  const { data, error } = await supabase.from('contacts').update({ name:req.body.name, phone:req.body.phone, email:req.body.email }).eq('id', req.params.contactId).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/contacts/:userId/:contactId', async (req, res) => {
  const { error } = await supabase.from('contacts').delete().eq('id', req.params.contactId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Users
app.get('/api/users', async (req, res) => {
  const { data } = await supabase.from('users').select('id, username, name, role, created_at');
  res.json(data || []);
});

app.post('/api/users', async (req, res) => {
  const { username, password, name, role } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: 'Missing fields' });
  const { error } = await supabase.from('users').insert({ id:'u_'+Date.now(), username, password, name, role:role||'user' });
  if (error) return res.status(409).json({ error: 'Username taken' });
  res.json({ ok: true });
});

app.delete('/api/users/:id', async (req, res) => {
  if (req.params.id === 'admin') return res.status(403).json({ error: 'Cannot delete admin' });
  await supabase.from('reminders').delete().eq('user_id', req.params.id);
  await supabase.from('contacts').delete().eq('user_id', req.params.id);
  await supabase.from('users').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// AI
app.post('/api/ai/parse', async (req, res) => {
  const result = await parseNaturalLanguage(req.body.text);
  if (!result) return res.status(500).json({ error: 'AI parsing failed' });
  res.json(result);
});

app.post('/api/ai/suggest', async (req, res) => {
  const result = await suggestFields(req.body.title);
  if (!result) return res.status(500).json({ error: 'AI suggestion failed' });
  res.json(result);
});

app.get('/api/ai/digest/:userId', async (req, res) => {
  res.json({ digest: await generateDigest(req.params.userId) });
});

// Logs
app.get('/api/logs', async (req, res) => {
  const { data } = await supabase.from('logs').select('*').order('created_at', { ascending: false }).limit(200);
  res.json(data || []);
});

// Manual cron
app.post('/api/cron/run', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  const count = await processDueReminders();
  res.json({ processed: count, time: new Date().toISOString() });
});

// ─── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
if (process.env.RUN_CRON_ONLY === 'true') {
  console.log('Running in CRON mode...');
  processDueReminders().then(count => { console.log(`Done. Processed ${count} reminders.`); process.exit(0); })
    .catch(err => { console.error('Cron error:', err); process.exit(1); });
} else {
  app.listen(PORT, () => console.log(`RemindMe server on port ${PORT}`));
}
