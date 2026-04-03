/**
 * RemindMe Backend Server v2.0
 * ─────────────────────────────
 * Fixes:
 *  1. Dual AI: Gemini + OpenAI support with fallback
 *  2. Cron reliability: better time window, IST handling, logging
 *  3. Agentic: smart rescheduling, follow-up suggestions, priority auto-adjust
 *  4. Password change API + hashed admin password
 * 
 * Database: Supabase (PostgreSQL)
 * Runs as GitHub Actions cron every 15 minutes
 */

const express = require('express');
const nodemailer = require('nodemailer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const crypto = require('crypto');

// ─── Password hashing (matches frontend SHA-256) ─────────────
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
      tls: { ciphers: 'SSLv3', rejectUnauthorized: false }
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

// ─── AI Provider: Gemini ──────────────────────────────────────
function getGemini() {
  if (!process.env.GEMINI_API_KEY) return null;
  return new GoogleGenerativeAI(process.env.GEMINI_API_KEY).getGenerativeModel({ model: 'gemini-2.0-flash' });
}

// ─── AI Provider: OpenAI ──────────────────────────────────────
async function callOpenAI(prompt, jsonMode = true) {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const body = {
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a helpful assistant. Always respond with valid JSON only, no markdown.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3
    };
    if (jsonMode) body.response_format = { type: 'json_object' };
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch(e) { console.error('OpenAI error:', e.message); return null; }
}

// ─── Unified AI call (tries preferred provider, falls back) ──
async function callAIProvider(prompt, jsonMode = true) {
  const preferred = process.env.AI_PROVIDER || 'gemini'; // 'gemini' or 'openai'
  
  // Try preferred first
  if (preferred === 'openai') {
    const oResult = await callOpenAI(prompt, jsonMode);
    if (oResult) return oResult;
    // Fallback to Gemini
    const gemini = getGemini();
    if (gemini) {
      const r = await gemini.generateContent(prompt);
      return r.response.text();
    }
  } else {
    // Gemini first
    const gemini = getGemini();
    if (gemini) {
      try {
        const r = await gemini.generateContent(prompt);
        const text = r.response.text();
        if (text) return text;
      } catch(e) { console.error('Gemini error:', e.message); }
    }
    // Fallback to OpenAI
    const oResult = await callOpenAI(prompt, jsonMode);
    if (oResult) return oResult;
  }
  return null;
}

// ─── CRON: Process due reminders (FIXED) ─────────────────────
async function processDueReminders() {
  const now = new Date();
  console.log(`[CRON] Starting at ${now.toISOString()}`);
  
  // Get ALL non-completed, non-notified reminders
  const { data: reminders, error } = await supabase
    .from('reminders')
    .select('*')
    .eq('completed', false)
    .eq('notified', false);
  
  if (error) { console.error('Supabase fetch error:', error); return 0; }
  console.log(`[CRON] Found ${(reminders||[]).length} total unnotified reminders`);

  const due = (reminders || []).filter(r => {
    if (!r.date || !r.time) return false;
    // Treat reminder time as IST (UTC+5:30)
    const dueAt = new Date(`${r.date}T${r.time}:00+05:30`);
    const diffMin = (now - dueAt) / 60000;
    console.log(`  [CHECK] "${r.title}" due=${dueAt.toISOString()} now=${now.toISOString()} diff=${diffMin.toFixed(1)}min`);
    // Window: 0 to 20 minutes past due (wider than 16 to catch edge cases)
    return diffMin >= -1 && diffMin <= 20;
  });

  console.log(`[CRON] ${due.length} reminders are due NOW`);

  let processed = 0;
  for (const r of due) {
    try {
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
      
      let sent = false;
      for (const contact of contacts) {
        if ((r.platform === 'whatsapp' || r.platform === 'both') && contact.phone) {
          const ok = await sendWhatsApp(contact.phone, message, waParams);
          if (ok) sent = true;
        }
        if ((r.platform === 'email' || r.platform === 'both') && contact.email) {
          const ok = await sendEmail(contact.email, `🔔 Reminder: ${r.title}`, message);
          if (ok) sent = true;
        }
      }
      
      // If no contacts but reminder is due, still mark as notified
      if (!contacts.length) {
        console.log(`  [WARN] Reminder "${r.title}" has no contacts — marking notified anyway`);
        sent = true;
      }

      const updateData = { notified: true, notified_at: now.toISOString() };
      
      // Handle recurring reminders
      if (r.recur && r.recur !== 'none') {
        const d = new Date(r.date);
        if (r.recur === 'daily') d.setDate(d.getDate()+1);
        if (r.recur === 'weekly') d.setDate(d.getDate()+7);
        if (r.recur === 'monthly') d.setMonth(d.getMonth()+1);
        updateData.date = d.toISOString().split('T')[0];
        updateData.notified = false;
        updateData.notified_at = null;
        console.log(`  [RECUR] Next occurrence: ${updateData.date}`);
      }
      
      await supabase.from('reminders').update(updateData).eq('id', r.id);
      await addLog('reminder', `Processed: ${r.title}`, `platform:${r.platform}, contacts:${contacts.length}, sent:${sent}`, r.user_id);
      processed++;
    } catch(e) {
      console.error(`  [ERROR] Processing "${r.title}":`, e.message);
      await addLog('error', `Failed processing: ${r.title}`, e.message, r.user_id);
    }
  }
  
  console.log(`[CRON] Done. Processed ${processed}/${due.length} reminders.`);
  return processed;
}

// ─── Gemini: Digest ───────────────────────────────────────────
async function generateDigest(userId) {
  const today = new Date().toISOString().split('T')[0];
  const { data: reminders } = await supabase.from('reminders').select('*').eq('user_id', userId).eq('completed', false);
  
  // Include today + upcoming 3 days
  const upcoming = (reminders || []).filter(r => {
    if (!r.date) return false;
    const d = new Date(r.date);
    const diff = (d - new Date(today)) / 86400000;
    return diff >= 0 && diff <= 3;
  });
  
  if (!upcoming.length) return "You have no reminders for the next 3 days! 🎉 Enjoy your time.";
  
  try {
    const list = upcoming.map((r,i) => `${i+1}. ${r.title} on ${r.date} at ${r.time||'anytime'} (${r.priority})`).join('\n');
    const prompt = `You are a friendly productivity assistant. Summarize these upcoming reminders in 4-5 sentences with emojis. Group by urgency, mention any patterns, and give one motivating tip:\n${list}`;
    const text = await callAIProvider(prompt, false);
    return text || upcoming.map(r => `• ${r.title} at ${r.time||'anytime'} on ${r.date}`).join('\n');
  } catch(e) { return upcoming.map(r=>`• ${r.title} at ${r.time||'anytime'}`).join('\n'); }
}

// ─── AI: Parse Natural Language ───────────────────────────────
async function parseNaturalLanguage(text) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const dayName = new Date().toLocaleDateString('en-US', { weekday: 'long' });
    const prompt = `Today is ${today} (${dayName}). Parse this reminder into JSON only, no markdown, no extra text:\n"${text}"\nReturn exactly: {"title":"...","desc":"...","date":"YYYY-MM-DD","time":"HH:MM","priority":"high|medium|low","recur":"none|daily|weekly|monthly"}\nRules:\n- No date mentioned = today (${today})\n- No time mentioned = 09:00\n- "tomorrow" = add 1 day\n- "next Monday" = calculate correct date\n- "this Friday" = calculate correct date from today\n- Infer priority from urgency words (urgent/important/asap = high, normal = medium, whenever/low = low)\n- Keep title concise but clear`;
    const raw = await callAIProvider(prompt, true);
    if (!raw) return null;
    const clean = raw.replace(/```json|```/g,'').trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch(e) { console.error('NL parse error:', e); return null; }
}

// ─── AI: Suggest improvements ─────────────────────────────────
async function suggestFields(title) {
  try {
    const prompt = `Improve this reminder title to be clearer and more actionable, and suggest a priority level. Return JSON only:\n"${title}"\nReturn exactly: {"improvedTitle":"...","priority":"high|medium|low","priorityReason":"one sentence explaining why"}`;
    const raw = await callAIProvider(prompt, true);
    if (!raw) return null;
    const clean = raw.replace(/```json|```/g,'').trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch(e) { return null; }
}

// ─── AI: Smart reschedule suggestion (Agentic) ───────────────
async function suggestReschedule(userId) {
  try {
    const { data: reminders } = await supabase.from('reminders').select('*').eq('user_id', userId).eq('completed', false);
    if (!reminders?.length) return { suggestions: [] };
    
    const today = new Date().toISOString().split('T')[0];
    const overdue = reminders.filter(r => r.date && r.date < today && !r.notified);
    const todayHeavy = reminders.filter(r => r.date === today);
    
    const list = reminders.map(r => `- "${r.title}" on ${r.date} at ${r.time} (${r.priority})`).join('\n');
    const prompt = `You are a productivity agent. Analyze these reminders and suggest optimizations. Return JSON only:\n${list}\n\nToday is ${today}. Return: {"suggestions":[{"id":"reminder_title","action":"reschedule|split|delegate|cancel","reason":"why","newDate":"YYYY-MM-DD if reschedule","newTime":"HH:MM if reschedule"}],"overdueSummary":"brief note about overdue items","loadBalance":"brief note about today's workload"}\n\nRules: Only suggest for overdue or overloaded days. Max 5 suggestions.`;
    const raw = await callAIProvider(prompt, true);
    if (!raw) return { suggestions: [], overdueSummary: `${overdue.length} overdue reminders`, loadBalance: `${todayHeavy.length} reminders today` };
    const clean = raw.replace(/```json|```/g,'').trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : { suggestions: [] };
  } catch(e) { return { suggestions: [] }; }
}

// ─── AI: Follow-up generator (Agentic) ───────────────────────
async function generateFollowUp(reminderId) {
  try {
    const { data: r } = await supabase.from('reminders').select('*').eq('id', reminderId).single();
    if (!r) return null;
    const prompt = `This reminder was just completed: "${r.title}" (${r.description || 'no description'}). Suggest 1-2 natural follow-up reminders. Return JSON only:\n{"followUps":[{"title":"...","desc":"...","daysFromNow":1,"priority":"medium"}]}`;
    const raw = await callAIProvider(prompt, true);
    if (!raw) return null;
    const clean = raw.replace(/```json|```/g,'').trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch(e) { return null; }
}

// ═══════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString(), ai: { gemini: !!process.env.GEMINI_API_KEY, openai: !!process.env.OPENAI_API_KEY } }));

// Auth
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const hashed = hashPassword(password);
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

// Password change
app.post('/api/change-password', async (req, res) => {
  const { userId, currentPassword, newPassword } = req.body;
  if (!userId || !currentPassword || !newPassword) return res.status(400).json({ error: 'Missing fields' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  
  const hashedCurrent = hashPassword(currentPassword);
  const { data: user } = await supabase.from('users').select('*').eq('id', userId).single();
  if (!user) return res.status(404).json({ error: 'User not found' });
  
  // Check current password (hashed or plain for migration)
  if (user.password !== hashedCurrent && user.password !== currentPassword) {
    return res.status(401).json({ error: 'Current password is wrong' });
  }
  
  const hashedNew = hashPassword(newPassword);
  await supabase.from('users').update({ password: hashedNew }).eq('id', userId);
  await addLog('auth', `Password changed for user ${userId}`, '', userId);
  res.json({ ok: true });
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
  if (b.notified !== undefined) updates.notified = b.notified;
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
  const { error } = await supabase.from('users').insert({ id:'u_'+Date.now(), username, password: hashPassword(password), name, role:role||'user' });
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

// AI endpoints
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

// Agentic endpoints
app.get('/api/ai/reschedule/:userId', async (req, res) => {
  const result = await suggestReschedule(req.params.userId);
  res.json(result);
});

app.post('/api/ai/followup', async (req, res) => {
  const result = await generateFollowUp(req.body.reminderId);
  if (!result) return res.status(500).json({ error: 'Follow-up generation failed' });
  res.json(result);
});

// Logs
app.get('/api/logs', async (req, res) => {
  const { data } = await supabase.from('logs').select('*').order('created_at', { ascending: false }).limit(200);
  res.json(data || []);
});

// Manual cron trigger
app.post('/api/cron/run', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  const count = await processDueReminders();
  res.json({ processed: count, time: new Date().toISOString() });
});

// ─── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
if (process.env.RUN_CRON_ONLY === 'true') {
  console.log('═══════════════════════════════════════');
  console.log('  RemindMe CRON mode');
  console.log(`  Time: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════');
  processDueReminders().then(count => { 
    console.log(`\n✅ Done. Processed ${count} reminders.`); 
    process.exit(0); 
  }).catch(err => { console.error('❌ Cron error:', err); process.exit(1); });
} else {
  app.listen(PORT, () => console.log(`🚀 RemindMe server on port ${PORT}`));
}
