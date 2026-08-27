const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// Configuration
const BOT_TOKEN = process.env.BOT_TOKEN || '8591620877:AAEPG8St3Z62odg2jwzWZIDuUOjs02jTfoE';
const GROUP_ID = parseInt(process.env.GROUP_ID || '-4647688137');
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = 'OSM77'; // Admin password

// Data file
const dataFile = '/tmp/data.json';

// Initialize data
let emailsData = { emails: {} };

// Load data
function loadData() {
  try {
    if (fs.existsSync(dataFile)) {
      emailsData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    }
  } catch (err) {
    console.log('Creating new data file');
  }
}

// Save data
function saveData() {
  try {
    fs.writeFileSync(dataFile, JSON.stringify(emailsData, null, 2));
  } catch (err) {
    console.error('Error saving data:', err);
  }
}

// Generate random 6-digit code
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Initialize Telegram Bot
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Listen to messages in group
bot.on('message', (msg) => {
  if (msg.chat.id !== GROUP_ID) return;

  const text = msg.text || '';
  const timestamp = new Date().toISOString();
  
  // Extract email addresses
  const emailRegex = /([a-zA-Z0-9._%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const emails = text.match(emailRegex) || [];
  
  // Extract OTP codes (4-10 digit numbers)
  const codeRegex = /(\b\d{4,10}\b)/g;
  const codes = text.match(codeRegex) || [];
  
  if (emails.length > 0) {
    emails.forEach(email => {
      if (!emailsData.emails[email]) {
        emailsData.emails[email] = {
          code: generateCode(),
          messages: [],
          created: timestamp
        };
      }

      const messageObj = {
        id: msg.message_id,
        text: text,
        timestamp: timestamp,
        codes: codes
      };

      emailsData.emails[email].messages.unshift(messageObj);
      
      if (emailsData.emails[email].messages.length > 100) {
        emailsData.emails[email].messages.pop();
      }
    });

    saveData();
    console.log(`✅ ${new Date().toISOString()} - Saved emails: ${emails.join(', ')}`);
  }
});

bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

// Express Server
const app = express();
app.use(cors());
app.use(express.json());
app.set('trust proxy', 1);

// ==================== API ENDPOINTS ====================

// Get all emails
app.get('/api/emails', (req, res) => {
  loadData();
  const emailsList = Object.keys(emailsData.emails).map(email => ({
    email,
    code: emailsData.emails[email].code,
    messageCount: emailsData.emails[email].messages.length,
    created: emailsData.emails[email].created
  }));
  res.json(emailsList);
});

// Get messages for a specific code
app.get('/api/messages/:code', (req, res) => {
  loadData();
  const code = req.params.code;
  
  const email = Object.keys(emailsData.emails).find(
    e => emailsData.emails[e].code === code
  );

  if (!email) {
    return res.status(404).json({ error: 'Invalid code' });
  }

  const messages = emailsData.emails[email].messages;
  res.json({
    email,
    code,
    messageCount: messages.length,
    messages: messages
  });
});

// Get all messages
app.get('/api/all-messages', (req, res) => {
  loadData();
  const allMessages = [];
  
  Object.keys(emailsData.emails).forEach(email => {
    emailsData.emails[email].messages.forEach(msg => {
      allMessages.push({
        email,
        code: emailsData.emails[email].code,
        ...msg
      });
    });
  });

  allMessages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(allMessages.slice(0, 50));
});

// ==================== ADMIN ENDPOINTS ====================

// Add email (requires admin password)
app.post('/api/admin/add-email', (req, res) => {
  const { email, password } = req.body;
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  
  if (!email) {
    return res.status(400).json({ error: 'Email required' });
  }

  const code = generateCode();
  emailsData.emails[email] = {
    code: code,
    messages: [],
    created: new Date().toISOString()
  };

  saveData();
  res.json({
    success: true,
    email,
    code
  });
});

// Delete email (requires admin password)
app.delete('/api/admin/delete-email/:email', (req, res) => {
  const { password } = req.body;
  const email = req.params.email;
  
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  
  if (emailsData.emails[email]) {
    delete emailsData.emails[email];
    saveData();
    res.json({ success: true, message: 'Email and code deleted' });
  } else {
    res.status(404).json({ error: 'Email not found' });
  }
});

// Verify admin password
app.post('/api/admin/verify', (req, res) => {
  const { password } = req.body;
  
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, message: 'Password correct' });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'Bot is running',
    timestamp: new Date().toISOString(),
    emailCount: Object.keys(emailsData.emails).length
  });
});

// Root
app.get('/', (req, res) => {
  res.json({
    name: 'OTP Email Fetcher Bot',
    status: 'running',
    botStatus: 'Listening to Telegram group'
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════╗
║   OTP Email Fetcher - RENDER           ║
║   Running 24/7 - 100% FREE ✅          ║
╚════════════════════════════════════════╝

🤖 Bot Token: ${BOT_TOKEN.slice(0, 10)}...
📱 Group ID: ${GROUP_ID}
🌐 API Server: Running on port ${PORT}

Admin Password: OSM77

API Endpoints:
  GET  /api/emails              - List all emails
  GET  /api/messages/:code      - Get messages for code
  POST /api/admin/add-email     - Add email (needs password)
  DELETE /api/admin/delete-email/:email - Remove email
  POST /api/admin/verify        - Verify password
  GET  /api/health              - Health check

Bot is listening to Telegram group...
  `);
});

loadData();

process.on('SIGTERM', () => {
  saveData();
  process.exit(0);
});
        
