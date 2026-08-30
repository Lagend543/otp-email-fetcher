const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');
const fs = require('fs');

// Config
const BOT_TOKEN = process.env.BOT_TOKEN || '8591620877:AAEPG8St3Z62odg2jwzWZIDuUOjs02jTfoE';
const GROUP_ID = parseInt(process.env.GROUP_ID || '-1004424660443');
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = 'OSM77';

// Data file
const dataFile = '/tmp/data.json';
let emailsData = { emails: {} };

// Load data
function loadData() {
  try {
    if (fs.existsSync(dataFile)) {
      emailsData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    }
  } catch (err) {
    console.log('New data file created');
  }
}

// Save data
function saveData() {
  fs.writeFileSync(dataFile, JSON.stringify(emailsData, null, 2));
}

// Generate code
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Initialize bot with polling
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

console.log(`
╔════════════════════════════════════════╗
║   OTP Email Fetcher - SIMPLE VERSION   ║
║   Just stores full email text          ║
╚════════════════════════════════════════╝
Bot Token: ${BOT_TOKEN.slice(0, 20)}...
Group ID: ${GROUP_ID}
Admin Password: ${ADMIN_PASSWORD}
`);

// Start polling explicitly
bot.startPolling({
  allowed_updates: ['message'],
  polling: {
    interval: 300,
    autoStart: true,
    params: {
      timeout: 10
    }
  }
});

console.log('✅ Bot polling started!');

// Listen for messages
bot.on('message', (msg) => {
  // Only read from target group
  if (!msg || msg.chat.id !== GROUP_ID) {
    return;
  }

  // Get text from any message type
  let text = msg.text || msg.caption || '';
  
  if (!text || text.trim().length === 0) {
    return;
  }

  const timestamp = new Date().toISOString();
  
  console.log(`\n📨 NEW MESSAGE FROM GROUP:`);
  console.log(`   Text length: ${text.length} chars`);
  console.log(`   Preview: ${text.substring(0, 100)}...`);
  
  // Load stored emails to check
  loadData();
  
  // Check if this message contains any of our tracked emails
  let foundEmails = [];
  
  for (let email of Object.keys(emailsData.emails)) {
    // Simple check: does message contain the email address?
    if (text.includes(email)) {
      foundEmails.push(email);
      console.log(`\n✅ FOUND TRACKED EMAIL: ${email}`);
    }
  }

  // If we found any tracked emails, store the FULL message
  if (foundEmails.length > 0) {
    console.log(`📧 Storing FULL email text for: ${foundEmails.join(', ')}`);
    
    foundEmails.forEach(email => {
      // Store complete message as-is
      emailsData.emails[email].messages.unshift({
        id: msg.message_id,
        text: text,  // FULL TEXT - no parsing!
        timestamp: timestamp
      });

      // Keep last 50 messages per email
      if (emailsData.emails[email].messages.length > 50) {
        emailsData.emails[email].messages = emailsData.emails[email].messages.slice(0, 50);
      }
      
      console.log(`   Stored message for ${email} (total: ${emailsData.emails[email].messages.length})`);
    });

    saveData();
    console.log(`✅ DATA SAVED!\n`);
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
app.get('/api/emails', (req, res) => {
  loadData();
  const list = Object.keys(emailsData.emails).map(email => ({
    email,
    code: emailsData.emails[email].code,
    messages: emailsData.emails[email].messages.length
  }));
  res.json(list);
});

// API: Get messages for code
app.get('/api/messages/:code', (req, res) => {
  loadData();
  const code = req.params.code;
  const email = Object.keys(emailsData.emails).find(e => emailsData.emails[e].code === code);
  
  if (!email) {
    return res.status(404).json({ error: 'Invalid code' });
  }
  
  res.json({
    email,
    code,
    messageCount: emailsData.emails[email].messages.length,
    messages: emailsData.emails[email].messages
  });
});

// API: All messages
app.get('/api/all-messages', (req, res) => {
  loadData();
  const all = [];
  Object.keys(emailsData.emails).forEach(email => {
    emailsData.emails[email].messages.forEach(msg => {
      all.push({ email, code: emailsData.emails[email].code, ...msg });
    });
  });
  all.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(all.slice(0, 50));
});

// API: Add email (admin)
app.post('/api/admin/add-email', (req, res) => {
  const { email, password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid' });
  if (!email) return res.status(400).json({ error: 'Email needed' });
  
  const code = generateCode();
  emailsData.emails[email] = { code, messages: [], created: new Date().toISOString() };
  saveData();
  
  console.log(`\n✅ ADMIN: Added email ${email} with code ${code}`);
  
  res.json({ success: true, email, code });
});

// API: Delete email (admin)
app.delete('/api/admin/delete-email/:email', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid' });
  if (!emailsData.emails[req.params.email]) return res.status(404).json({ error: 'Not found' });
  
  delete emailsData.emails[req.params.email];
  saveData();
  
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
    emails: Object.keys(emailsData.emails).length
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🌐 API Server running on port ${PORT}`);
  console.log(`✅ Ready!\n`);
});

loadData();

// Save on exit
process.on('SIGTERM', () => {
  saveData();
  bot.stopPolling();
  process.exit(0);
});
