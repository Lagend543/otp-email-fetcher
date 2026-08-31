const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');
const fs = require('fs');

// Config
const BOT_TOKEN = process.env.BOT_TOKEN || '8591620877:AAEPG8St3Z62odg2jwzWZIDuUOjs02jTfoE';
const GROUP_ID = parseInt(process.env.GROUP_ID || '-1004424660443');
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = 'OSM77';
const MESSAGE_TTL_MS = 60 * 60 * 1000; // Auto-delete each type's message after 1 hour of its own age

// Persistent storage: Render's free tier wipes local files (like /tmp) on
// every restart/spin-down/redeploy - that's what was silently deleting
// tracked emails. Upstash Redis (free, no expiry) survives all of that.
// If not configured, falls back to the old local-file behavior (which will
// still lose data on restart) so the bot doesn't crash outright.
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const USE_PERSISTENT_STORAGE = !!(UPSTASH_URL && UPSTASH_TOKEN);
const REDIS_KEY = 'otp-fetcher-data';

// Local file fallback (only used if Upstash isn't configured)
const dataFile = '/tmp/data.json';

let emailsData = { emails: {} };

async function loadData() {
  if (USE_PERSISTENT_STORAGE) {
    try {
      const res = await fetch(`${UPSTASH_URL}/get/${REDIS_KEY}`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
      });
      const data = await res.json();
      emailsData = data.result ? JSON.parse(data.result) : { emails: {} };
    } catch (err) {
      console.log('⚠️ Could not load from Upstash, starting fresh:', err.message);
      emailsData = { emails: {} };
    }
  } else {
    try {
      if (fs.existsSync(dataFile)) {
        emailsData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      }
    } catch (err) {
      console.log('New local data file created (⚠️ NOT persistent - set up Upstash!)');
    }
  }
}

async function saveData() {
  if (USE_PERSISTENT_STORAGE) {
    try {
      await fetch(`${UPSTASH_URL}/set/${REDIS_KEY}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
        body: JSON.stringify(emailsData)
      });
    } catch (err) {
      console.log('⚠️ Could not save to Upstash:', err.message);
    }
  } else {
    fs.writeFileSync(dataFile, JSON.stringify(emailsData, null, 2));
  }
}

// Generate code
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Telegram often sends links as styled hyperlinks (e.g. "Restart membership")
// where the actual URL is NOT written anywhere in the visible text - it only
// lives in the message's "entities" metadata. Plain regex on the text can
// never find these. This pulls them out using the real URL + the exact
// visible label Telegram shows, without touching the raw text at all.
function extractEntityLinks(text, entities) {
  if (!entities || !Array.isArray(entities)) return [];

  const links = [];
  const seen = new Set();

  entities.forEach(entity => {
    let url = null;

    if (entity.type === 'text_link' && entity.url) {
      url = entity.url; // hidden link behind styled text, e.g. "Restart membership"
    } else if (entity.type === 'url') {
      url = text.substring(entity.offset, entity.offset + entity.length); // plain visible URL
    }

    if (url && !seen.has(url)) {
      const label = text.substring(entity.offset, entity.offset + entity.length);
      links.push({ text: label, url: url, offset: entity.offset, length: entity.length });
      seen.add(url);
    }
  });

  return links;
}

// Classifies a message into one of 4 known Netflix email types, using the
// SAME detection logic as the website (kept in sync intentionally). Each
// tracked email keeps only ONE message per type - a new message of a type
// instantly replaces the old one of that same type, while other types are
// left untouched until their own hour runs out.
function classifyMessageType(text, links) {
  if (/code to sign in[^\d]{0,40}(\d{4,8})/i.test(text)) return 'signcode';

  if (/verify with this code[:\s]*(\d{4,8})/i.test(text)) return '2fa';
  if (/someone is trying to access your account[\s\S]{0,300}?\b(\d{4,8})\b/i.test(text)) return '2fa';

  const normalize = s => s.replace(/\s+/g, ' ').trim().toLowerCase();
  if (links && links.length) {
    for (const link of links) {
      if (normalize(link.text).includes('reset password')) return 'reset';
    }
    for (const link of links) {
      const label = normalize(link.text);
      if (label.includes('yes, this was me') || label.includes('yes this was me') ||
          label.includes('get code') || label.includes('getcode')) return 'household';
    }
  }

  return null; // doesn't match any known type - not stored
}

// Remove type-slots older than MESSAGE_TTL_MS across all tracked emails.
// Each type (signcode/2fa/reset/household) expires independently based on
// its OWN arrival time - a fresh 2FA email never resets a Sign-Code email's
// clock, and vice versa.
async function cleanupOldMessages() {
  const now = Date.now();
  let removedCount = 0;

  Object.keys(emailsData.emails).forEach(email => {
    const types = emailsData.emails[email].types || {};
    Object.keys(types).forEach(type => {
      const slot = types[type];
      if (!slot) return;
      const age = now - new Date(slot.timestamp).getTime();
      if (age > MESSAGE_TTL_MS) {
        delete types[type];
        removedCount++;
      }
    });
  });

  if (removedCount > 0) {
    await saveData();
    console.log(`🧹 Cleanup: removed ${removedCount} expired type-slot(s) older than 1 hour`);
  }
}

// Initialize bot WITHOUT auto-polling first, so we can clear any webhook/conflicts
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

console.log(`
╔════════════════════════════════════════╗
║   OTP Email Fetcher - SIMPLE VERSION   ║
║   Just stores full email text          ║
╚════════════════════════════════════════╝
Bot Token: ${BOT_TOKEN.slice(0, 20)}...
Group ID: ${GROUP_ID}
Admin Password: ${ADMIN_PASSWORD}
Storage: ${USE_PERSISTENT_STORAGE ? '✅ Upstash Redis (persists across restarts)' : '⚠️ Local file only (WILL BE LOST on restart/redeploy - set up Upstash!)'}
`);

// Clear any leftover webhook and drop pending updates before polling.
// This prevents 409 Conflict errors caused by a stale webhook or a
// leftover polling session from a previous deploy.
async function startBotSafely() {
  try {
    await bot.deleteWebHook({ drop_pending_updates: true });
    console.log('✅ Cleared any existing webhook');
  } catch (err) {
    console.log('⚠️ Could not clear webhook (may not have existed):', err.message);
  }

  // Small delay to let Telegram fully release the previous connection
  await new Promise(resolve => setTimeout(resolve, 2000));

  bot.startPolling({
    restart: true,
    polling: {
      interval: 300,
      autoStart: true,
      params: { timeout: 10 }
    }
  });

  console.log('✅ Bot polling started!');
}

startBotSafely();

// Listen for messages
bot.on('message', async (msg) => {
  // Only read from target group
  if (!msg || msg.chat.id !== GROUP_ID) {
    return;
  }

  // Get text from any message type
  let text = msg.text || msg.caption || '';
  
  if (!text || text.trim().length === 0) {
    return;
  }

  // Grab hidden hyperlink URLs from Telegram's formatting metadata
  // (entities for regular messages, caption_entities for media captions)
  const entities = msg.entities || msg.caption_entities || [];
  const links = extractEntityLinks(text, entities);

  const timestamp = new Date().toISOString();
  
  console.log(`\n📨 NEW MESSAGE FROM GROUP:`);
  console.log(`   Text length: ${text.length} chars`);
  console.log(`   Preview: ${text.substring(0, 100)}...`);
  if (links.length > 0) {
    console.log(`   🔗 Found ${links.length} link(s): ${links.map(l => `"${l.text}"`).join(', ')}`);
  }
  
  // Load stored emails to check
  await loadData();
  
  // Check if this message contains any of our tracked emails
  let foundEmails = [];
  
  for (let email of Object.keys(emailsData.emails)) {
    // Simple check: does message contain the email address?
    if (text.includes(email)) {
      foundEmails.push(email);
      console.log(`\n✅ FOUND TRACKED EMAIL: ${email}`);
    }
  }

  // If we found any tracked emails, classify and store by type
  if (foundEmails.length > 0) {
    const msgType = classifyMessageType(text, links);

    if (!msgType) {
      console.log(`ℹ️ Message doesn't match any known type (Sign-Code/2FA/Reset/Household) - not stored\n`);
    } else {
      console.log(`📧 Classified as: ${msgType} — storing for: ${foundEmails.join(', ')}`);

      foundEmails.forEach(email => {
        if (!emailsData.emails[email].types) emailsData.emails[email].types = {};

        // Instantly replaces any existing message of this SAME type only.
        // Other types for this email are left completely untouched.
        emailsData.emails[email].types[msgType] = {
          id: msg.message_id,
          text: text,  // FULL TEXT - no parsing, no changes!
          links: links, // extra data only, doesn't touch the raw text above
          timestamp: timestamp
        };

        console.log(`   Stored "${msgType}" for ${email}`);
      });

      await saveData();
      console.log(`✅ DATA SAVED!\n`);
    }
  } else {
    console.log(`ℹ️ No tracked emails found in this message\n`);
  }
});

// Error handler
bot.on('polling_error', (error) => {
  console.error('❌ Polling error:', error.message);
});

// Express API
const app = express();
app.use(cors());
app.use(express.json());

// API: Get all emails
app.get('/api/emails', async (req, res) => {
  await loadData();
  await cleanupOldMessages();
  const list = Object.keys(emailsData.emails).map(email => ({
    email,
    code: emailsData.emails[email].code,
    messages: Object.keys(emailsData.emails[email].types || {}).length
  }));
  res.json(list);
});

// API: Get messages for code - returns each type's current message (or
// null if none stored / expired), so the site can look up exactly the
// type it needs without any client-side searching.
app.get('/api/messages/:code', async (req, res) => {
  await loadData();
  await cleanupOldMessages();

  const code = req.params.code;
  const email = Object.keys(emailsData.emails).find(e => emailsData.emails[e].code === code);
  
  if (!email) {
    return res.status(404).json({ error: 'Invalid code' });
  }

  const types = emailsData.emails[email].types || {};

  res.json({
    email,
    code,
    types: {
      signcode: types.signcode || null,
      '2fa': types['2fa'] || null,
      reset: types.reset || null,
      household: types.household || null
    }
  });
});

// API: All messages (admin overview)
app.get('/api/all-messages', async (req, res) => {
  await loadData();
  await cleanupOldMessages();
  const all = [];
  Object.keys(emailsData.emails).forEach(email => {
    const types = emailsData.emails[email].types || {};
    Object.keys(types).forEach(type => {
      all.push({ email, code: emailsData.emails[email].code, type, ...types[type] });
    });
  });
  all.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(all.slice(0, 50));
});

// API: Add email (admin)
app.post('/api/admin/add-email', async (req, res) => {
  const { email, password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid' });
  if (!email) return res.status(400).json({ error: 'Email needed' });

  await loadData();
  const code = generateCode();
  emailsData.emails[email] = { code, types: {}, created: new Date().toISOString() };
  await saveData();
  
  console.log(`\n✅ ADMIN: Added email ${email} with code ${code}`);
  
  res.json({ success: true, email, code });
});

// API: Delete email (admin)
app.delete('/api/admin/delete-email/:email', async (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid' });

  await loadData();
  if (!emailsData.emails[req.params.email]) return res.status(404).json({ error: 'Not found' });
  
  delete emailsData.emails[req.params.email];
  await saveData();
  
  console.log(`\n✅ ADMIN: Deleted email ${req.params.email}`);
  
  res.json({ success: true });
});

// API: Verify password
app.post('/api/admin/verify', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid' });
  }
});

// API: Health
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'running',
    mode: 'simple-full-text',
    storage: USE_PERSISTENT_STORAGE ? 'upstash-redis' : 'local-file-NOT-PERSISTENT',
    emails: Object.keys(emailsData.emails).length
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🌐 API Server running on port ${PORT}`);
  console.log(`✅ Ready!\n`);
});

(async () => {
  await loadData();
  await cleanupOldMessages();
})();

// Run cleanup every 5 minutes in the background, so messages expire
// even if nobody is actively checking the site
setInterval(() => { cleanupOldMessages(); }, 5 * 60 * 1000);

// Save on exit
process.on('SIGTERM', async () => {
  await saveData();
  bot.stopPolling();
  process.exit(0);
});
                            
