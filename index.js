const fs = require('fs');
const path = require('path');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const OWNER_NUMBER = '8801344127041'; // digits only, no +
const BOT_NAME = 'Jisan BotX';
const BOT_NUMBER_DISPLAY = '+8801344127041';
// Optional: set PAIRING_NUMBER in your hosting environment to use pairing code.
// Example: 8801344127041 (digits only, with country code). Keep this private.

const LOGO_URL =
  'https://img.sanishtech.com/u/6467d578a3edfac120d4f772fdfed99b.jpg';
const MENU_IMAGE_URL =
  'https://img.sanishtech.com/u/0c8e55738a4809dd9541d7a634e6219c.jpg';

const SETTINGS_FILE = path.join(__dirname, 'group-settings.json');
const DEFAULT_SETTINGS = { antiSticker: false, antiLink: false, antiVideo: false };

let groupSettings = {};
try {
  if (fs.existsSync(SETTINGS_FILE)) {
    groupSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  }
} catch (error) {
  console.error('Could not read group-settings.json:', error.message);
  groupSettings = {};
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(groupSettings, null, 2));
  } catch (error) {
    console.error('Could not save group settings:', error.message);
  }
}

function getSettings(groupId) {
  if (!groupSettings[groupId]) {
    groupSettings[groupId] = { ...DEFAULT_SETTINGS };
  }
  return groupSettings[groupId];
}

function getText(message) {
  const m = message?.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.templateButtonReplyMessage?.selectedId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ''
  ).trim();
}

function unwrapMessage(message) {
  let m = message?.message;
  while (m?.ephemeralMessage?.message || m?.viewOnceMessage?.message ||
         m?.viewOnceMessageV2?.message || m?.documentWithCaptionMessage?.message) {
    m = m.ephemeralMessage?.message ||
        m.viewOnceMessage?.message ||
        m.viewOnceMessageV2?.message ||
        m.documentWithCaptionMessage?.message;
  }
  return m || {};
}

function getMessageKind(message) {
  const m = unwrapMessage(message);
  if (m.stickerMessage) return 'sticker';
  if (m.videoMessage) return 'video';
  return 'other';
}

function containsLink(text) {
  return /(?:https?:\/\/|www\.)\S+/i.test(text) ||
         /\b[a-z0-9-]+\.(?:com|net|org|xyz|info|me|io|gg|co|bd|app|dev|site|online|link)\b(?:\/\S*)?/i.test(text);
}

function jidToNumber(jid = '') {
  return jid.split('@')[0].split(':')[0].replace(/\D/g, '');
}

async function downloadImage(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`Image fetch failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function sendBrandedReply(sock, jid, text, quotedMessage) {
  try {
    const image = await downloadImage(LOGO_URL);
    await sock.sendMessage(
      jid,
      {
        image,
        caption:
          `👑 *${BOT_NAME}*\n` +
          `📱 ${BOT_NUMBER_DISPLAY}\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          text,
      },
      quotedMessage ? { quoted: quotedMessage } : {}
    );
  } catch (error) {
    console.error('Logo image send failed:', error.message);
    await sock.sendMessage(
      jid,
      {
        text: `👑 *${BOT_NAME}*  •  ${BOT_NUMBER_DISPLAY}\n━━━━━━━━━━━━━━━━━━\n${text}`,
      },
      quotedMessage ? { quoted: quotedMessage } : {}
    );
  }
}

async function sendMenu(sock, jid, quotedMessage) {
  const caption =
    `👑 *JISAN BOTX — MENU*\n` +
    `📱 ${BOT_NUMBER_DISPLAY}\n` +
    `🟢 Status: Active\n\n` +
    `*GROUP PROTECTION*\n` +
    `• .antisticker on/off — block stickers\n` +
    `• .antilink on/off — block common links\n` +
    `• .antivideo on/off — block videos\n\n` +
    `*GENERAL*\n` +
    `• .menu — show this menu\n` +
    `• .status — show protection status\n\n` +
    `⚠️ Protection works in groups when the bot is an admin.`;
  try {
    const image = await downloadImage(MENU_IMAGE_URL);
    await sock.sendMessage(
      jid,
      { image, caption },
      quotedMessage ? { quoted: quotedMessage } : {}
    );
  } catch (error) {
    console.error('Menu image send failed:', error.message);
    await sendBrandedReply(sock, jid, caption, quotedMessage);
  }
}

async function isGroupAdmin(sock, groupId, participantJid) {
  try {
    const metadata = await sock.groupMetadata(groupId);
    const participant = metadata.participants.find(p => p.id === participantJid);
    return Boolean(participant && (participant.admin === 'admin' || participant.admin === 'superadmin'));
  } catch (error) {
    console.error('Could not check group admins:', error.message);
    return false;
  }
}

async function isBotAdmin(sock, groupId) {
  try {
    const metadata = await sock.groupMetadata(groupId);
    const botJid = sock.user?.id;
    const botNumber = jidToNumber(botJid);
    const participant = metadata.participants.find(p => jidToNumber(p.id) === botNumber);
    return Boolean(participant && (participant.admin === 'admin' || participant.admin === 'superadmin'));
  } catch {
    return false;
  }
}

async function handleCommand(sock, message, commandText, groupId, senderJid) {
  const parts = commandText.slice(1).trim().split(/\s+/);
  const command = (parts.shift() || '').toLowerCase();
  const option = (parts.shift() || '').toLowerCase();
  const senderNumber = jidToNumber(senderJid);
  const isOwner = senderNumber === OWNER_NUMBER;
  const isAdmin = isOwner || await isGroupAdmin(sock, groupId, senderJid);

  if (command === 'menu' || command === 'help') {
    return sendMenu(sock, groupId, message);
  }

  if (command === 'status') {
    const s = getSettings(groupId);
    return sendBrandedReply(
      sock,
      groupId,
      `🛡️ *Protection Status*\n` +
      `• AntiSticker: ${s.antiSticker ? '🟢 ON' : '🔴 OFF'}\n` +
      `• AntiLink: ${s.antiLink ? '🟢 ON' : '🔴 OFF'}\n` +
      `• AntiVideo: ${s.antiVideo ? '🟢 ON' : '🔴 OFF'}`,
      message
    );
  }

  const commandMap = {
    antisticker: { key: 'antiSticker', label: 'AntiSticker' },
    antilink: { key: 'antiLink', label: 'AntiLink' },
    antivideo: { key: 'antiVideo', label: 'AntiVideo' },
  };
  const config = commandMap[command];
  if (!config) return;

  if (!isAdmin) {
    return sendBrandedReply(
      sock, groupId,
      '⛔ এই কমান্ড চালাতে গ্রুপ অ্যাডমিন হতে হবে।',
      message
    );
  }

  if (option !== 'on' && option !== 'off') {
    const current = getSettings(groupId)[config.key];
    return sendBrandedReply(
      sock, groupId,
      `ℹ️ ব্যবহার: .${command} on অথবা .${command} off\nবর্তমান অবস্থা: ${current ? 'ON' : 'OFF'}`,
      message
    );
  }

  const settings = getSettings(groupId);
  settings[config.key] = option === 'on';
  saveSettings();

  return sendBrandedReply(
    sock,
    groupId,
    `${settings[config.key] ? '✅' : '❌'} *${config.label} ${option.toUpperCase()}*\n` +
    (settings[config.key]
      ? 'এই গ্রুপে ফিচারটি চালু হয়েছে।'
      : 'এই গ্রুপে ফিচারটি বন্ধ হয়েছে।'),
    message
  );
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info'));
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = undefined;
  }

  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: !process.env.PAIRING_NUMBER,
    browser: ['Jisan BotX', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // If PAIRING_NUMBER is configured and this session is not linked yet,
  // request a WhatsApp pairing code instead of relying on a QR scan.
  if (process.env.PAIRING_NUMBER && !state.creds.registered) {
    const phoneNumber = process.env.PAIRING_NUMBER.replace(/\D/g, '');
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        console.log(`\n🔐 ${BOT_NAME} Pairing Code: ${code}`);
        console.log('WhatsApp > Linked Devices > Link a Device > Link with phone number instead.');
      } catch (error) {
        console.error('Could not generate pairing code:', error.message);
        console.error('Check PAIRING_NUMBER (country code + number) and try again.');
      }
    }, 3000);
  }

  sock.ev.on('connection.update', update => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('\nScan the QR code shown in the terminal with WhatsApp Linked Devices.\n');
    }
    if (connection === 'open') {
      console.log(`✅ ${BOT_NAME} connected successfully.`);
    } else if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed.', shouldReconnect ? 'Reconnecting...' : 'Logged out; remove auth_info and pair again.');
      if (shouldReconnect) setTimeout(startBot, 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const message of messages) {
      try {
        if (!message.message || message.key.fromMe) continue;
        const groupId = message.key.remoteJid;
        if (!groupId || !groupId.endsWith('@g.us')) continue;

        const senderJid = message.key.participant || message.key.remoteJid;
        const text = getText(message);
        const settings = getSettings(groupId);

        // Commands start with a dot. Run command handling before moderation.
        if (text.startsWith('.')) {
          await handleCommand(sock, message, text, groupId, senderJid);
          continue;
        }

        const kind = getMessageKind(message);
        let reason = '';

        if (settings.antiSticker && kind === 'sticker') reason = '🚫 AntiSticker is ON — স্টিকার পাঠানো যাবে না।';
        else if (settings.antiVideo && kind === 'video') reason = '🚫 AntiVideo is ON — ভিডিও পাঠানো যাবে না।';
        else if (settings.antiLink && text && containsLink(text)) reason = '🚫 AntiLink is ON — লিংক পাঠানো যাবে না।';

        if (!reason) continue;

        const botAdmin = await isBotAdmin(sock, groupId);
        if (!botAdmin) {
          console.log(`Cannot enforce moderation in ${groupId}: bot is not a group admin.`);
          continue;
        }

        // Delete the violating message, then send a branded warning.
        await sock.sendMessage(groupId, { delete: message.key });
        await sendBrandedReply(sock, groupId, reason, null);
      } catch (error) {
        console.error('Message handling error:', error.message);
      }
    }
  });
}

startBot().catch(error => {
  console.error('Fatal startup error:', error);
  process.exitCode = 1;
});
