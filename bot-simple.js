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
║   OTP Email Fetcher - SMART LINKS      ║
║   Bot Starting...                      ║
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

  // Get text from various message types
  let text = msg.text || msg.caption || '';
  
  // Handle forwarded messages
  if (msg.forward_from_chat) {
    text = msg.text || msg.caption || '';
  }
  
  // Handle quoted/reply messages
  if (msg.reply_to_message) {
    text = msg.text || msg.caption || text;
  }
  
  if (!text || text.trim().length === 0) {
    return;
  }

  const timestamp = new Date().toISOString();
  
  console.log(`\n📨 NEW MESSAGE RECEIVED:`);
  console.log(`   From: ${msg.chat.title || msg.chat.id}`);
  console.log(`   Text: ${text.substring(0, 80)}...`);
  
  // Extract emails - handle both [email] and plain email formats
  const emailRegex = /\[?([a-zA-Z0-9._%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\]?/g;
  let emails = [];
  let match;
  while ((match = emailRegex.exec(text)) !== null) {
    emails.push(match[1]);
  }
  // Remove duplicates
  emails = [...new Set(emails)];
  
  // Extract codes (4-10 digits, prioritize codes after "code:" text)
  let codes = [];
  
  // First try to find codes explicitly mentioned with "code:" prefix
  const codeWithLabel = /code[:\s]+(\d{4,10})/gi;
  let codeMatch;
  while ((codeMatch = codeWithLabel.exec(text)) !== null) {
    codes.push(codeMatch[1]);
  }
  
  // If no codes found, look for standalone numbers
  if (codes.length === 0) {
    const codeRegex = /\b(\d{4,10})\b/g;
    while ((codeMatch = codeRegex.exec(text)) !== null) {
      codes.push(codeMatch[1]);
    }
  }
  
  // Remove duplicates
  codes = [...new Set(codes)];
  
  // Extract links WITH their surrounding text context (SMART!)
  let linksWithText = [];
  
  // Split by links and capture surrounding text
  const lines = text.split('\n');
  const processedLinks = new Set();
  
  lines.forEach(line => {
    // Find all URLs in this line
    const urlPattern = /(https?:\/\/[^\s<>"{}|\\^`\[\]]*)/g;
    let urlMatch;
    
    while ((urlMatch = urlPattern.exec(line)) !== null) {
      const url = urlMatch[1];
      const startIdx = urlMatch.index;
      
      // Get text before URL (up to 60 chars)
      const beforeStart = Math.max(0, startIdx - 60);
      let textBefore = line.substring(beforeStart, startIdx).trim();
      // Get last sentence/phrase
      textBefore = textBefore.split(/[.!?]/).pop().trim();
      
      // Get text after URL (up to 60 chars)
      const endIdx = urlMatch.index + url.length;
      let textAfter = line.substring(endIdx, Math.min(line.length, endIdx + 60)).trim();
      // Get first sentence/phrase
      textAfter = textAfter.split(/[.!?]/)[0].trim();
      
      // Choose display text (prefer text before)
      let displayText = 'Link';
      
      if (textBefore && textBefore.length > 3 && textBefore.length < 60) {
        displayText = textBefore;
      } else if (textAfter && textAfter.length > 3 && textAfter.length < 60) {
        displayText = textAfter;
      } else {
        // Try to use domain as fallback
        try {
          const domain = new URL(url).hostname.replace('www.', '');
          displayText = domain.length < 30 ? domain : 'Open Link';
        } catch (e) {
          displayText = 'Open Link';
        }
      }
      
      // Avoid duplicates
      if (!processedLinks.has(url)) {
        linksWithText.push({
          url: url,
          text: displayText.substring(0, 60)  // Limit display text
        });
        processedLinks.add(url);
      }
    }
  });
  
  console.log(`📧 Extracted - Emails: ${emails.length}, Codes: ${codes.length}, Links: ${linksWithText.length}`);
  
  if (emails.length > 0) {
    console.log(`✅ FOUND ${emails.length} EMAIL(S): ${emails.join(', ')}`);
    console.log(`✅ FOUND ${codes.length} CODE(S): ${codes.join(', ')}`);
    if (linksWithText.length > 0) {
      linksWithText.forEach(link => {
        console.log(`   🔗 LINK: "${link.text}" → ${link.url.substring(0, 50)}...`);
      });
    }
    
    emails.forEach(email => {
      // Create if new
      if (!emailsData.emails[email]) {
        const newCode = generateCode();
        emailsData.emails[email] = {
          code: newCode,
          messages: [],
          created: timestamp
        };
        console.log(`   ➕ NEW EMAIL: ${email}`);
        console.log(`   🔐 CODE: ${newCode}`);
      }

      // Add message with links
      emailsData.emails[email].messages.unshift({
        id: msg.message_id,
        text: text,
        timestamp: timestamp,
        codes: codes,
        links: linksWithText  // Store with display text
      });

      // Keep last 50 messages
      if (emailsData.emails[email].messages.length > 50) {
        emailsData.emails[email].messages = emailsData.emails[email].messages.slice(0, 50);
      }
    });

    saveData();
    console.log(`✅ DATA SAVED!\n`);
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
  res.json({ success: true, email, code });
});

// API: Delete email (admin)
app.delete('/api/admin/delete-email/:email', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid' });
  if (!emailsData.emails[req.params.email]) return res.status(404).json({ error: 'Not found' });
  
  delete emailsData.emails[req.params.email];
  saveData();
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
    mode: 'polling',
    emails: Object.keys(emailsData.emails).length
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🌐 API Server running on port ${PORT}`);
  console.log(`📍 URL: http://0.0.0.0:${PORT}`);
  console.log(`✅ Ready to receive messages!\n`);
});

loadData();

// Save on exit
process.on('SIGTERM', () => {
  saveData();
  bot.stopPolling();
  process.exit(0);
});
                   
