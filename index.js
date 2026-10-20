/* ══════════════════════════════════════════════════════════════════════════
   ██╗██╗███████╗ █████╗ ███╗   ██╗    ██████╗  ██████╗ ████████╗██╗  ██╗
   ██║██║██╔════╝██╔══██╗████╗  ██║    ██╔══██╗██╔═══██╗╚══██╔══╝╚██╗██╔╝
   ██║██║███████╗███████║██╔██╗ ██║    ██████╔╝██║   ██║   ██║    ╚███╔╝
   ██║██║╚════██║██╔══██║██║╚██╗██║    ██╔══██╗██║   ██║   ██║    ██╔██╗
   ██║██║███████║██║  ██║██║ ╚████║    ██████╔╝╚██████╔╝   ██║   ██╔╝ ██╗
   ╚═╝╚═╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝    ╚═════╝  ╚═════╝    ╚═╝   ╚═╝  ╚═╝
   ──────────────────────────────────────────────────────────────────────────
   JISAN BOTX  v1.0
   Owner   : Ahmed Jisan
   Library : @whiskeysockets/baileys 6.7.24 (Baileys Multi-Device)
   Runtime : Node.js 18+ (20 LTS or newer recommended)
   Pairing : Pairing-code + optional Telegram pairing bridge (t.me/Jisan_x_Bot)
   ──────────────────────────────────────────────────────────────────────────
   Single-file bot. Persistent JSON storage. Role-based permissions.
   Anti systems, antidelete, promote/demote alerts, welcome/goodbye,
   scheduled automation with prayer breaks, Bengali auto-reply.

   IMPORTANT HONESTY NOTES (read README.md for full details):
   - This bot works through the WhatsApp Web multi-device protocol. It is
     NOT affiliated with WhatsApp. Using automated accounts can violate
     WhatsApp's Terms of Service — use at your own risk.
   - Features that depend on undocumented WhatsApp behaviour (e.g. perfect
     bot detection, monitoring every private Status) are implemented only
     where the library actually exposes events, and documented honestly.
   ══════════════════════════════════════════════════════════════════════════ */
'use strict';

/* ────────────────────────────── SECTION 0: IMPORTS ────────────────────── */
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  getContentType,
  downloadContentFromMessage,
  downloadMediaMessage,
  Browsers,
  proto
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

/* ────────────────────────────── SECTION 1: CONFIG ─────────────────────── */
const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, 'config.json');

const CONFIG_DEFAULTS = {
  botName: 'Jisan Botx',
  ownerName: 'Ahmed Jisan',
  ownerNumber: '',              // optional explicit owner number, digits only
  pairingNumber: '',            // number used for first pairing, digits only
  prefix: '.',
  version: '1.0',
  timezone: 'Asia/Dhaka',
  menuImage: 'https://img.sanishtech.com/u/0c8e55738a4809dd9541d7a634e6219c.jpg',
  pairingSite: 'https://t.me/Jisan_x_Bot',
  repoLink: '',                 // shown by .script only if configured
  sessionDir: 'session',
  dataDir: 'data',
  mediaCacheDir: 'media_cache',
  telegram: { token: '', ownerId: '' },
  prayer: { city: 'Dhaka', country: 'Bangladesh', method: 1, school: 1 },
  antidelete: { mediaCache: true, maxMediaMB: 8, maxCacheMB: 150, retentionHours: 12 },
  botmanage: { nightClose: '00:00', nightOpen: '10:00', breaks: { dhuhr: 30, asr: 30, maghrib: 30, isha: 50 } }
};

function deepMerge(base, extra) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!extra || typeof extra !== 'object') return out;
  for (const k of Object.keys(extra)) {
    const v = extra[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function loadConfig() {
  let userCfg = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      userCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[CONFIG] config.json is corrupted, using defaults:', e.message);
  }
  return deepMerge(CONFIG_DEFAULTS, userCfg);
}

const CONFIG = loadConfig();
const VERSION = CONFIG.version || '1.0';

/* ────────────────────────────── SECTION 2: UTILS ──────────────────────── */
const log = pino({ level: process.env.LOG_LEVEL || 'warn' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pickRandom = (arr) => (Array.isArray(arr) && arr.length ? arr[Math.floor(Math.random() * arr.length)] : null);

function fmtTS(ms) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: CONFIG.timezone, day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
    }).format(new Date(ms));
  } catch { return new Date(ms).toISOString(); }
}

function todayStr() {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: CONFIG.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch { return new Date().toISOString().slice(0, 10); }
}

/** "HH:MM" -> minutes since midnight. Returns null when invalid. */
function parseHM(hm) {
  if (typeof hm !== 'string') return null;
  const m = hm.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10), min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Current "HH:MM" in CONFIG.timezone. */
function nowHMInTZ() {
  try {
    const s = new Intl.DateTimeFormat('en-GB', { timeZone: CONFIG.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    return s.replace('24:', '00:');
  } catch {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
}

/** Is "HH:MM" now inside the [start,end] window? Handles windows that wrap past midnight. */
function inWin(hm, start, end) {
  const n = parseHM(hm), s = parseHM(start), e = parseHM(end);
  if (n === null || s === null || e === null) return false;
  if (s === e) return false;
  if (s < e) return n >= s && n < e;
  return n >= s || n < e; // wraps midnight (e.g. 00:00 -> 10:00)
}

function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? `${h}h ` : '') + (m ? `${m}m ` : '') + `${s}s`;
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** Replace @user / @group / @count placeholders with real values. */
function replacePlaceholders(text, { userNum, groupName, count } = {}) {
  return String(text || '')
    .replace(/@user/g, userNum ? `@${userNum}` : 'member')
    .replace(/@group/g, groupName || 'this group')
    .replace(/@count/g, String(count ?? '—'));
}

/* ───────────────────── SECTION 3: PERSISTENT JSON DATABASE ────────────── */
class JDB {
  constructor(file, defaults = {}, saveDelay = 800) {
    this.file = file;
    this.saveDelay = saveDelay;
    this._timer = null;
    this._dirty = false;
    this.data = defaults;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8');
        this.data = deepMerge(this.data, JSON.parse(raw));
      }
    } catch (e) {
      const bak = this.file + '.corrupt.' + Date.now();
      try { fs.renameSync(this.file, bak); } catch {}
      console.error(`[DB] ${this.file} was corrupted. Backed up to ${bak}. Starting fresh.`);
      this._dirty = true;
      this.saveNow();
    }
  }

  scheduleSave() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.saveNow();
    }, this.saveDelay);
  }

  saveNow() {
    this._dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[DB] save failed:', e.message);
    }
  }

  get(p, def) {
    let cur = this.data;
    for (const k of String(p).split('.')) {
      if (cur === null || cur === undefined || typeof cur !== 'object') return def;
      cur = cur[k];
    }
    return cur === undefined ? def : cur;
  }

  set(p, v) {
    const keys = String(p).split('.');
    let cur = this.data;
    for (let i = 0; i < keys.length - 1; i++) {
      if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
      cur = cur[keys[i]];
    }
    cur[keys[keys.length - 1]] = v;
    this.scheduleSave();
    return v;
  }

  del(p) {
    const keys = String(p).split('.');
    let cur = this.data;
    for (let i = 0; i < keys.length - 1; i++) {
      if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) return false;
      cur = cur[keys[i]];
    }
    const ok = delete cur[keys[keys.length - 1]];
    if (ok) this.scheduleSave();
    return ok;
  }

  trimObj(obj, max) {
    const keys = Object.keys(obj);
    if (keys.length <= max) return;
    for (const k of keys.slice(0, keys.length - max)) delete obj[k];
  }
}

let DB = null;
let MSGDB = null;
let MEDIA_DIR = null;

function dbDefaults() {
  return {
    meta: { createdAt: new Date().toISOString(), botVersion: VERSION },
    owner: { number: CONFIG.ownerNumber || '', name: CONFIG.ownerName || 'Ahmed Jisan' },
    prefix: CONFIG.prefix || '.',
    mode: 'public',
    sudo: [],
    settings: {
      antidelete: { enabled: false, mediaCache: !!CONFIG.antidelete.mediaCache, retentionHours: CONFIG.antidelete.retentionHours, processedIds: [] },
      antipromote: { enabled: false, groupNotify: false },
      antidemote: { enabled: false, groupNotify: false },
      antistatusMonitor: { enabled: false, lastNotify: 0 },
      antivvvw: { enabled: false },
      adminaction: { enabled: false },
      autoreply: { enabled: false, cooldownSec: 60, extraTriggers: [] },
      botmanage: {
        enabled: false,
        groups: [],
        nightClose: CONFIG.botmanage.nightClose || '00:00',
        nightOpen: CONFIG.botmanage.nightOpen || '10:00',
        prayerEnabled: true,
        overrides: {},
        applied: {}
      }
    },
    prayerCache: { date: '', times: null, fetchedAt: 0 },
    groups: {},
    warns: {},
    warnAnti: {},
    activity: {},
    names: {}
  };
}

function initStorage() {
  if (DB) return DB;
  const dataDir = path.join(ROOT, CONFIG.dataDir || 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  MEDIA_DIR = path.join(ROOT, CONFIG.mediaCacheDir || 'media_cache');
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  DB = new JDB(path.join(dataDir, 'settings.json'), dbDefaults());
  MSGDB = new JDB(path.join(dataDir, 'msgcache.json'), { msgs: {} }, 30000);
  return DB;
}

function getGroupCfg(gid) {
  if (!DB.data.groups[gid]) {
    DB.data.groups[gid] = {
      anti: {
        antisticker: { mode: 'off' },
        antilink: { mode: 'off', whitelist: [] },
        antiimage: { mode: 'off' },
        antivideo: { mode: 'off' },
        antivoice: { mode: 'off' },
        antigif: { mode: 'off' },
        antigroupmention: { mode: 'off', limit: 5 },
        antistatus: { mode: 'off' },
        antibadword: { mode: 'off', words: [] },
        antispam: { mode: 'off', maxMsgs: 8, perSec: 10 },
        antinfc: { mode: 'off' },
        antibot: { mode: 'off' }
      },
      welcome: { enabled: false, message: '👋 Welcome @user!\n\nEnjoy your time in @group! 🎉\nMembers: @count' },
      goodbye: { enabled: false, message: '👋 Goodbye @user!\n\n@user has left @group.\nMembers: @count' },
      noAdminNotice: 0
    };
    DB.scheduleSave();
  }
  return DB.data.groups[gid];
}

/* ───────────────────── SECTION 4: JID / IDENTITY / ROLES ──────────────── */
function normJ(jid) {
  if (!jid || typeof jid !== 'string') return '';
  try { return jidNormalizedUser(jid); } catch { return jid.split(':')[0].split('@')[0] + '@s.whatsapp.net'; }
}
function numJ(jid) {
  if (!jid) return '';
  return String(jid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}
function isGroupChat(jid) { return !!jid && jid.endsWith('@g.us'); }

let SELF_JID = null;

function isOwnerJ(jid) {
  if (!jid) return false;
  const n = normJ(jid);
  if (SELF_JID && n === SELF_JID) return true;
  const own = DB && DB.get('owner.number', '');
  if (own && numJ(n) === numJ(own)) return true;
  return false;
}
function isSudoJ(jid) {
  if (!DB || !jid) return false;
  if (isOwnerJ(jid)) return true;
  const list = DB.get('sudo', []);
  return list.some((s) => numJ(s) === numJ(jid));
}
function ownerChatJ() {
  const own = DB && DB.get('owner.number', '');
  if (own) return `${numJ(own)}@s.whatsapp.net`;
  return SELF_JID || null;
}

const META_CACHE = new Map();
const META_TTL = 5 * 60 * 1000;

async function getMeta(sock, gid) {
  const hit = META_CACHE.get(gid);
  if (hit && Date.now() - hit.ts < META_TTL) return hit.data;
  const data = await sock.groupMetadata(gid);
  META_CACHE.set(gid, { data, ts: Date.now() });
  return data;
}
function invalidateMeta(gid) { META_CACHE.delete(gid); }

async function isAdminJ(sock, gid, jid) {
  try {
    const meta = await getMeta(sock, gid);
    const p = meta.participants.find((x) => normJ(x.id) === normJ(jid));
    return !!(p && (p.admin === 'admin' || p.admin === 'superadmin'));
  } catch { return false; }
}
async function isBotAdminJ(sock, gid) {
  if (!SELF_JID) return false;
  return isAdminJ(sock, gid, SELF_JID);
}

function rememberName(jid, name) {
  if (!DB || !jid || !name) return;
  const n = normJ(jid);
  if (!n || n.endsWith('@g.us') || n === 'status@broadcast') return;
  if (DB.data.names[n] === name) return;
  DB.data.names[n] = name;
  DB.trimObj(DB.data.names, 5000);
  DB.scheduleSave();
}
function getName(jid) {
  if (!jid) return 'Unknown';
  const n = normJ(jid);
  if (SELF_JID && n === SELF_JID) return (CONFIG.botName || 'Jisan Botx') + ' (me)';
  return (DB && DB.data.names[n]) || numJ(n) || 'Unknown';
}

/* ───────────────────── SECTION 5: MESSAGE CONTENT HELPERS ─────────────── */
function unwrapMsg(message) {
  let m = message;
  const WRAPPERS = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'ephemeralMessage', 'documentWithCaptionMessage', 'editedMessage'];
  let guard = 0;
  while (m && guard++ < 6) {
    const t = getContentType(m);
    if (t && WRAPPERS.includes(t) && m[t] && m[t].message) {
      m = m[t].message;
      if (t === 'editedMessage') continue;
    } else break;
  }
  return m || message;
}

function msgText(message) {
  const m = unwrapMsg(message);
  if (!m) return '';
  const t = getContentType(m);
  if (!t) return '';
  const c = m[t];
  if (t === 'conversation' || t === 'extendedTextMessage') return c.text || '';
  if (typeof c.caption === 'string') return c.caption;
  return '';
}

function msgMediaType(message) {
  const m = unwrapMsg(message);
  if (!m) return 'unknown';
  const t = getContentType(m);
  switch (t) {
    case 'conversation': case 'extendedTextMessage': return 'Text';
    case 'imageMessage': return 'Image';
    case 'videoMessage': return m[t].gifPlayback ? 'GIF' : 'Video';
    case 'audioMessage': return m[t].ptt ? 'Voice note' : 'Audio';
    case 'stickerMessage': return m[t].isAnimated ? 'Animated sticker' : 'Sticker';
    case 'documentMessage': return 'Document';
    case 'contactMessage': case 'contactsArrayMessage': return 'Contact card';
    case 'locationMessage': return 'Location';
    case 'liveLocationMessage': return 'Live location';
    case 'pollCreationMessage': case 'pollCreationMessageV2': case 'pollCreationMessageV3': return 'Poll';
    case 'protocolMessage': return 'Protocol (revoke/edit)';
    default: return t ? t.replace('Message', '') : 'unknown';
  }
}

function getMentions(message) {
  const m = unwrapMsg(message);
  const t = m && getContentType(m);
  const c = t && m[t];
  const list = (c && c.contextInfo && c.contextInfo.mentionedJid) || [];
  return list.map(normJ).filter(Boolean);
}

function getQuoted(m) {
  const msg = unwrapMsg(m.message);
  const t = msg && getContentType(msg);
  const c = t && msg[t];
  const ci = c && c.contextInfo;
  if (!ci || !ci.quotedMessage) return null;
  return {
    jid: ci.participant ? normJ(ci.participant) : null,
    id: ci.stanzaId || null,
    remoteJid: ci.remoteJid || null,
    message: ci.quotedMessage,
    text: msgText(ci.quotedMessage)
  };
}

function resolveTargetUser(m, args) {
  const mentions = getMentions(m.message);
  if (mentions.length) return mentions[0];
  const q = getQuoted(m);
  if (q && q.jid && !q.jid.endsWith('@g.us')) return q.jid;
  if (args && args.length) {
    const raw = args[0].replace(/[^0-9]/g, '');
    if (raw.length >= 7) return `${raw}@s.whatsapp.net`;
  }
  return null;
}

/* ─────────────────────────── SECTION 6: SENDERS ───────────────────────── */
async function sendT(sock, jid, text, extra = {}) {
  if (!jid) return null;
  const content = { text };
  if (extra.mentions) content.mentions = extra.mentions;
  try {
    return await sock.sendMessage(jid, content, extra.msgOpts || {});
  } catch (e) {
    console.error('[SEND] failed to', jid, '-', e.message);
    return null;
  }
}

function senderOf(m) {
  if (m.key.fromMe) return SELF_JID || normJ(m.key.remoteJid);
  if (isGroupChat(m.key.remoteJid)) return normJ(m.key.participant || m.key.remoteJid);
  return normJ(m.key.remoteJid);
}

async function doDelete(sock, m) {
  try {
    const key = {
      remoteJid: m.key.remoteJid,
      fromMe: m.key.fromMe,
      id: m.key.id,
      ...(isGroupChat(m.key.remoteJid) && !m.key.fromMe ? { participant: m.key.participant } : {})
    };
    await sock.sendMessage(m.key.remoteJid, { delete: key });
    return { ok: true };
  } catch (e) {
    return { ok: false, err: e.message };
  }
}

async function doKick(sock, gid, userJid, { demoteFirst = false } = {}) {
  try {
    if (demoteFirst) {
      try { await sock.groupParticipantsUpdate(gid, [userJid], 'demote'); await sleep(700); } catch {}
    }
    const res = await sock.groupParticipantsUpdate(gid, [userJid], 'remove');
    const r = Array.isArray(res) ? res[0] : null;
    const code = r && r.code ? String(r.code) : (r && r.status ? String(r.status) : 'unknown');
    return { ok: code === '200', code, err: r && r.message ? r.message : null };
  } catch (e) {
    return { ok: false, code: 'error', err: e.message };
  }
}

function participantErrText(code, action) {
  switch (String(code)) {
    case '200': return null;
    case '403': return `I don't have permission to ${action} this user (privacy settings or I am not an admin).`;
    case '404': return `This user could not be found on WhatsApp.`;
    case '408': return `This user cannot be ${action}ed right now (account restriction). Try again later.`;
    case '409': return `Conflict while updating this user. Try again.`;
    case '500': case '501': return `WhatsApp refused the ${action} request (server error ${code}).`;
    default: return `The ${action} action failed (code ${code}).`;
  }
}

/* ───────────────────── SECTION 7: ANTIDELETE ENGINE ────────────────────── */
const MAX_MSG_CACHE = 4000;
const PROCESSED_REVOKE_CAP = 500;

function mediaExtFor(mimetype) {
  if (!mimetype) return 'bin';
  if (mimetype.includes('image/jpeg')) return 'jpg';
  if (mimetype.includes('image/png')) return 'png';
  if (mimetype.includes('image/webp')) return 'webp';
  if (mimetype.includes('video/mp4')) return 'mp4';
  if (mimetype.includes('audio/ogg') || mimetype.includes('audio/opus')) return 'ogg';
  if (mimetype.includes('audio/mpeg')) return 'mp3';
  if (mimetype.includes('audio/mp4')) return 'm4a';
  const m = mimetype.match(/\/([a-z0-9]+)/i);
  return m ? m[1].toLowerCase() : 'bin';
}

async function downloadBuffer(sock, message, content, type) {
  try {
    if (typeof downloadMediaMessage === 'function') {
      const full = { message };
      const opts = {};
      if (sock && typeof sock.updateMediaMessage === 'function') {
        opts.reuploadRequest = sock.updateMediaMessage.bind(sock);
      }
      const buf = await downloadMediaMessage(full, 'buffer', opts);
      if (buf && buf.length) return buf;
    }
    const stream = await downloadContentFromMessage(content, type.replace('Message', ''));
    let chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
  } catch (e) {
    console.error('[MEDIA] download failed:', e.message);
    return null;
  }
}

function saveMediaFile(id, mimetype, buf) {
  try {
    const maxBytes = clampInt(CONFIG.antidelete.maxMediaMB * 1024 * 1024, 8 * 1024 * 1024, 1, 60 * 1024 * 1024);
    if (buf.length > maxBytes) return { path: null, tooBig: true };
    const file = path.join(MEDIA_DIR, `${id}.${mediaExtFor(mimetype)}`);
    fs.writeFileSync(file, buf);
    return { path: file, tooBig: false };
  } catch (e) {
    console.error('[MEDIA] save failed:', e.message);
    return { path: null, tooBig: false };
  }
}

async function cacheIncoming(sock, m) {
  if (!MSGDB) return;
  const id = m.key.id;
  if (!id || m.key.remoteJid === 'status@broadcast') return;
  const chat = m.key.remoteJid;
  const sender = senderOf(m);
  const msg = unwrapMsg(m.message);
  const type = getContentType(msg) || 'unknown';
  const entry = {
    id,
    chat,
    isGroup: isGroupChat(chat),
    sender,
    senderName: getName(sender),
    ts: Number(m.messageTimestamp) * 1000 || Date.now(),
    type,
    label: msgMediaType(m.message),
    text: msgText(m.message) || '',
    cachedAt: Date.now(),
    mediaPath: null,
    mediaMimetype: null
  };
  const q = getQuoted(m);
  if (q) {
    entry.quoted = { text: (q.text || '').slice(0, 500), sender: q.jid, id: q.id };
  }

  const ad = DB.get('settings.antidelete', {});
  if (ad.enabled && ad.mediaCache) {
    const MEDIA_TYPES = ['imageMessage', 'videoMessage', 'audioMessage', 'stickerMessage', 'documentMessage'];
    if (MEDIA_TYPES.includes(type)) {
      const c = msg[type];
      const buf = await downloadBuffer(sock, m.message, c, type);
      if (buf) {
        const saved = saveMediaFile(id, c.mimetype || (c.mimeType), buf);
        if (saved.path) { entry.mediaPath = saved.path; entry.mediaMimetype = c.mimetype || null; }
        else if (saved.tooBig) entry.mediaTooBig = true;
      }
    }
  }

  MSGDB.data.msgs[id] = entry;
  MSGDB.trimObj(MSGDB.data.msgs, MAX_MSG_CACHE);
  MSGDB.scheduleSave();
}

function startCacheCleaner() {
  const tick = async () => {
    try {
      const now = Date.now();
      const retentionMs = clampInt(DB.get('settings.antidelete.retentionHours', CONFIG.antidelete.retentionHours), 12, 1, 720) * 3600 * 1000;
      let total = 0; const files = [];
      for (const f of fs.readdirSync(MEDIA_DIR)) {
        const fp = path.join(MEDIA_DIR, f);
        try {
          const st = fs.statSync(fp);
          if (now - st.mtimeMs > retentionMs) { fs.unlinkSync(fp); continue; }
          total += st.size; files.push({ fp, size: st.size, m: st.mtimeMs });
        } catch {}
      }
      const capBytes = clampInt(CONFIG.antidelete.maxCacheMB, 150, 1, 4096) * 1024 * 1024;
      if (total > capBytes) {
        files.sort((a, b) => a.m - b.m);
        for (const f of files) {
          if (total <= capBytes) break;
          try { fs.unlinkSync(f.fp); total -= f.size; } catch {}
        }
      }
      let pruned = 0;
      for (const [id, e] of Object.entries(MSGDB.data.msgs)) {
        if (now - (e.cachedAt || 0) > retentionMs) { delete MSGDB.data.msgs[id]; pruned++; }
      }
      if (pruned) MSGDB.scheduleSave();
    } catch (e) {
      console.error('[CACHE-CLEANER]', e.message);
    }
  };
  tick();
  return setInterval(tick, 15 * 60 * 1000).unref();
}

function markRevokeProcessed(id) {
  const arr = DB.get('settings.antidelete.processedIds', []);
  if (arr.includes(id)) return false;
  arr.push(id);
  DB.set('settings.antidelete.processedIds', arr.slice(-PROCESSED_REVOKE_CAP));
  return true;
}

async function sendAntideleteReport(sock, delKey, eventTs) {
  const chat = delKey.remoteJid || '';
  const orig = MSGDB ? MSGDB.data.msgs[delKey.id] : null;
  const isGrp = isGroupChat(chat);
  const sentAt = orig ? orig.ts : null;
  const sender = (orig && orig.sender) || (delKey.participant ? normJ(delKey.participant) : null);
  const senderName = sender ? getName(sender) : 'Unknown';
  const now = Date.now();

  let header, lines = [];
  if (isGrp) {
    header = '╭━━〔 GROUP ANTIDELETE 〕━━╮';
    let gname = 'Unknown group';
    try { const meta = await getMeta(sock, chat); gname = meta.subject || gname; } catch {}
    lines.push('⚠️ A group message was deleted!', '');
    lines.push(`👥 Group: ${gname}`);
    lines.push(`🆔 Group ID: ${chat}`);
    lines.push(`👤 Sender: ${senderName}`);
    lines.push(`📱 Sender ID: ${sender || 'Unknown'}`);
    lines.push(`🕒 Sent At: ${sentAt ? fmtTS(sentAt) : 'Not available'}`);
    lines.push(`🗑️ Deleted At: ${fmtTS(eventTs || now)}`);
    lines.push(`📦 Type: ${orig ? orig.label : 'Unknown (not cached)'}`);
  } else {
    header = '╭━━〔 ANTIDELETE 〕━━╮';
    lines.push('⚠️ A message was deleted!', '');
    lines.push(`👤 Sender: ${senderName}`);
    lines.push(`📱 Sender ID: ${sender || 'Unknown'}`);
    lines.push(`💬 Chat: Private Chat`);
    lines.push(`🆔 Chat ID: ${chat}`);
    lines.push(`🕒 Sent At: ${sentAt ? fmtTS(sentAt) : 'Not available'}`);
    lines.push(`🗑️ Deleted At: ${fmtTS(eventTs || now)}`);
    lines.push(`📦 Type: ${orig ? orig.label : 'Unknown (not cached)'}`);
  }

  if (orig) {
    if (orig.text) {
      lines.push('');
      lines.push(`📝 ${isGrp && orig.label === 'Image' ? 'Caption:' : 'Message:'}`);
      lines.push(orig.text.slice(0, 1000));
    }
    if (orig.quoted && orig.quoted.text) {
      lines.push('');
      lines.push(`↩️ Reply to: "${orig.quoted.text.slice(0, 200)}"`);
    }
    if (orig.mediaTooBig) {
      lines.push('');
      lines.push('📎 Media was received but exceeded the cache size limit, so it is not attached.');
    }
    if (!orig.text && !orig.mediaPath && !orig.quoted) {
      lines.push('');
      lines.push('⚠️ Content could not be recovered (media caching disabled or unsupported type).');
    }
  } else {
    lines.push('');
    lines.push('⚠️ The original content was never cached, so it cannot be shown.');
    lines.push('WhatsApp does not provide deleted message payloads to the bot.');
  }
  lines.push('');
  lines.push('╰━━━━━━━━━━━━━━━━━━━━╯');

  const dest = ownerChatJ();
  if (!dest) return;
  await sendT(sock, dest, header + '\n' + lines.join('\n'));

  if (orig && orig.mediaPath) {
    try {
      if (fs.existsSync(orig.mediaPath)) {
        const buf = fs.readFileSync(orig.mediaPath);
        const mm = orig.mediaMimetype || '';
        let content;
        if (mm.startsWith('image/')) content = { image: buf };
        else if (mm.startsWith('video/')) content = { video: buf };
        else if (mm.startsWith('audio/')) content = { audio: buf, ptt: mm.includes('ogg') };
        else if (mm.includes('webp')) content = { sticker: buf };
        else content = { document: buf, mimetype: mm || 'application/octet-stream', fileName: path.basename(orig.mediaPath) };
        content.caption = '📎 Recovered media (cached before deletion).';
        await sock.sendMessage(dest, content);
      }
    } catch (e) {
      console.error('[ANTIDELETE] media re-send failed:', e.message);
    }
  }
}

async function handleRevoke(sock, delKey, eventTs) {
  if (!sock || !delKey || !delKey.id) return;
  const ad = DB.get('settings.antidelete', {});
  if (!ad.enabled) return;
  const chat = delKey.remoteJid;
  if (!chat || chat === 'status@broadcast') return;
  if (delKey.fromMe && !isGroupChat(chat)) return;
  if (!markRevokeProcessed(delKey.id)) return;
  try {
    await sendAntideleteReport(sock, delKey, eventTs);
  } catch (e) {
    console.error('[ANTIDELETE] report failed:', e.message);
  }
}

function findViewOnce(message) {
  const m = unwrapMsg(message);
  if (!m) return null;
  const t = getContentType(m);
  if (t && t.startsWith('viewOnce')) {
    const inner = m[t] && m[t].message;
    if (inner) {
      const it = getContentType(inner);
      if (it && ['imageMessage', 'videoMessage', 'audioMessage'].includes(it)) {
        return { type: it, content: inner[it] };
      }
    }
  }
  for (const t2 of ['imageMessage', 'videoMessage', 'audioMessage']) {
    if (m[t2] && m[t2].viewOnce) return { type: t2, content: m[t2] };
  }
  return null;
}

async function extractQuotedViewOnce(sock, m) {
  const q = getQuoted(m);
  if (!q || !q.message) return null;
  const vo = findViewOnce(q.message);
  if (!vo) return null;
  const buf = await downloadBuffer(sock, q.message, vo.content, vo.type);
  if (!buf) return null;
  return { buf, mimetype: vo.content.mimetype || '', type: vo.type, isVoice: !!(vo.content.ptt) };
}

async function autoRevealViewOnce(sock, m) {
  const st = DB.get('settings.antivvvw', {});
  if (!st.enabled) return;
  const chat = m.key.remoteJid;
  if (isGroupChat(chat) || chat === 'status@broadcast' || m.key.fromMe) return;
  const vo = findViewOnce(m.message);
  if (!vo) return;
  const buf = await downloadBuffer(sock, m.message, vo.content, vo.type);
  if (!buf) return;
  const dest = ownerChatJ();
  if (!dest) return;
  const mm = vo.content.mimetype || '';
  let content;
  if (vo.type === 'imageMessage') content = { image: buf };
  else if (vo.type === 'videoMessage') content = { video: buf };
  else content = { audio: buf, ptt: !!vo.content.ptt };
  content.caption = `🔓 View-once revealed automatically (.antivvvw)\n👤 From: ${getName(senderOf(m))}`;
  try { await sock.sendMessage(dest, content); } catch (e) { console.error('[ANTIVVVW]', e.message); }
}

/* ═══════════════════ SECTION 8: ANTI-SYSTEM ENGINE ══════════════════════ */
const ANTI_NOUNS = {
  antisticker: 'Stickers',
  antilink: 'Links',
  antiimage: 'Images',
  antivideo: 'Videos',
  antivoice: 'Voice notes',
  antigif: 'GIFs',
  antigroupmention: 'Mass mentions',
  antistatus: 'Forwarded status updates',
  antibadword: 'Bad words',
  antispam: 'Spamming',
  antinfc: 'Contact cards',
  antibot: 'Bot-like activity'
};

function antiWarnText(cat, userJid, count) {
  const noun = ANTI_NOUNS[cat] || 'This content';
  const n = numJ(userJid);
  if (count === 1) return `@${n} ${noun.toLowerCase()} are not allowed in this group, please take note!\n⚠️ Warn 1/3`;
  if (count === 2) return `@${n} ${noun.toLowerCase()} are not allowed in this group!\n⚠️ Warn 2/3`;
  return `@${n} ${noun.toLowerCase()} are not allowed in this group!\n⚠️ Warn 3/3`;
}

function bumpAntiWarn(gid, userJid, cat) {
  if (!DB.data.warnAnti[gid]) DB.data.warnAnti[gid] = {};
  if (!DB.data.warnAnti[gid][userJid]) DB.data.warnAnti[gid][userJid] = {};
  const cur = (DB.data.warnAnti[gid][userJid][cat] || 0) + 1;
  DB.data.warnAnti[gid][userJid][cat] = cur;
  DB.trimObj(DB.data.warnAnti[gid], 500);
  DB.scheduleSave();
  return cur;
}

async function notifyNoAdmin(sock, gid) {
  const g = getGroupCfg(gid);
  const now = Date.now();
  if (now - (g.noAdminNotice || 0) < 5 * 60 * 1000) return;
  g.noAdminNotice = now;
  DB.scheduleSave();
  await sendT(sock, gid, '⚠️ I need *admin* rights in this group to enforce the configured protection. Please promote me and try again.');
}

async function handleAntiViolation(sock, m, cat, ctxExtra = {}) {
  const chat = m.key.remoteJid;
  const user = ctxExtra.user || senderOf(m);
  const g = getGroupCfg(chat);
  const cfg = g.anti[cat];
  if (!cfg || cfg.mode === 'off') return false;
  const noun = ANTI_NOUNS[cat] || 'This content';

  if (cfg.mode === 'delete') {
    const del = await doDelete(sock, m);
    if (!del.ok) await notifyNoAdmin(sock, chat);
    await sendT(sock, chat, `@${numJ(user)} ${noun.toLowerCase()} are not allowed in this group!${del.ok ? '' : '\n(And I could not delete the message — missing permission.)'}`, { mentions: [user] });
    return true;
  }

  if (cfg.mode === 'warn') {
    const del = await doDelete(sock, m);
    if (!del.ok) await notifyNoAdmin(sock, chat);
    const count = bumpAntiWarn(chat, user, cat);
    if (count >= 4) {
      const kick = await doKick(sock, chat, user, { demoteFirst: !!ctxExtra.demoteFirst });
      if (kick.ok) {
        DB.del(`warnAnti.${chat}.${user}.${cat}`);
        await sendT(sock, chat, `@${numJ(user)} has been removed from this group.\nReason: Rule break. (${noun})`, { mentions: [user] });
      } else {
        DB.set(`warnAnti.${chat}.${user}.${cat}`, 3);
        await sendT(sock, chat, `@${numJ(user)} reached the warn limit, but I could not remove them: ${participantErrText(kick.code, 'remove') || 'unknown error'}`, { mentions: [user] });
      }
      return true;
    }
    await sendT(sock, chat, antiWarnText(cat, user, count), { mentions: [user] });
    return true;
  }

  if (cfg.mode === 'kick') {
    const del = await doDelete(sock, m);
    if (!del.ok) await notifyNoAdmin(sock, chat);
    const kick = await doKick(sock, chat, user, { demoteFirst: !!ctxExtra.demoteFirst });
    if (kick.ok) {
      await sendT(sock, chat, `@${numJ(user)} has been removed from this group.\nReason: Rule break. (${noun})`, { mentions: [user] });
    } else {
      await sendT(sock, chat, `⚠️ @${numJ(user)} sent prohibited content, but removal failed: ${participantErrText(kick.code, 'remove') || 'unknown error'}`, { mentions: [user] });
    }
    return true;
  }
  return false;
}

const SPAM_WINDOW = new Map();
function checkSpam(chat, user, maxMsgs, perSec) {
  const key = `${chat}|${user}`;
  const now = Date.now();
  let arr = SPAM_WINDOW.get(key) || [];
  arr = arr.filter((t) => now - t < perSec * 1000);
  arr.push(now);
  SPAM_WINDOW.set(key, arr);
  if (arr.length > maxMsgs) { SPAM_WINDOW.set(key, []); return true; }
  return false;
}

const URL_RE = /((https?:\/\/)|(www\.))[^\s]+|([a-z0-9-]+\.)+(com|net|org|io|me|xyz|info|link|site|app|gg|tv|co|in|bd)(\/[^\s]*)?/i;

function textHasLink(text, whitelist) {
  if (!text) return false;
  if (!URL_RE.test(text)) return false;
  const lower = text.toLowerCase();
  for (const w of whitelist || []) {
    if (w && lower.includes(String(w).toLowerCase())) return false;
  }
  return true;
}

async function detectAntiCategory(sock, m, chat) {
  const msg = unwrapMsg(m.message);
  const type = getContentType(msg);
  const g = getGroupCfg(chat);
  const anti = g.anti;

  if (type === 'stickerMessage' && anti.antisticker.mode !== 'off') return 'antisticker';
  if (type === 'imageMessage' && anti.antiimage.mode !== 'off') return 'antiimage';
  if (type === 'videoMessage') {
    if (msg[type].gifPlayback && anti.antigif.mode !== 'off') return 'antigif';
    if (!msg[type].gifPlayback && anti.antivideo.mode !== 'off') return 'antivideo';
  }
  if (type === 'audioMessage' && anti.antivoice.mode !== 'off') return 'antivoice';
  if ((type === 'contactMessage' || type === 'contactsArrayMessage') && anti.antinfc.mode !== 'off') return 'antinfc';

  const text = msgText(m.message);
  if (text) {
    if (anti.antilink.mode !== 'off' && textHasLink(text, anti.antilink.whitelist)) return 'antilink';
    if (anti.antibadword.mode !== 'off' && anti.antibadword.words && anti.antibadword.words.length) {
      const lower = text.toLowerCase();
      if (anti.antibadword.words.some((w) => w && lower.includes(String(w).toLowerCase()))) return 'antibadword';
    }
    if (anti.antistatus.mode !== 'off') {
      const q = getQuoted(m);
      const t = msg && getContentType(msg);
      const ctx = msg[t] && msg[t].contextInfo;
      if ((ctx && ctx.remoteJid === 'status@broadcast') || (q && q.remoteJid === 'status@broadcast')) return 'antistatus';
    }
  }

  if (anti.antigroupmention.mode !== 'off') {
    const lim = clampInt(anti.antigroupmention.limit, 5, 2, 100);
    const mentions = getMentions(m.message);
    if (mentions.length > lim) return 'antigroupmention';
  }

  if (anti.antispam.mode !== 'off') {
    const hit = checkSpam(chat, senderOf(m), clampInt(anti.antispam.maxMsgs, 8, 3, 100), clampInt(anti.antispam.perSec, 10, 2, 120));
    if (hit) return 'antispam';
  }

  if (anti.antibot.mode !== 'off') {
    if (/@bot$/.test(senderOf(m)) || /@bot\.net$/.test(senderOf(m))) return 'antibot';
    if (type === 'templateMessage' || type === 'interactiveMessage' || type === 'buttonsResponseMessage') return 'antibot';
  }
  return null;
}

async function runAntiSystems(sock, m, chat, user) {
  if (!isGroupChat(chat)) return false;
  if (!user || isOwnerJ(user) || user === SELF_JID) return false;
  const adminaction = DB.get('settings.adminaction.enabled', false);
  const userIsAdmin = await isAdminJ(sock, chat, user);
  if (userIsAdmin && !adminaction) return false;
  const cat = await detectAntiCategory(sock, m, chat);
  if (!cat) return false;
  return handleAntiViolation(sock, m, cat, {
    user,
    demoteFirst: userIsAdmin && adminaction
  });
}

/* ───────────────────── SECTION 9: WELCOME / GOODBYE ────────────────────── */
async function onParticipantsUpdate(sock, upd) {
  try {
    const gid = upd.id;
    const action = upd.action;
    const users = (upd.participants || []).map(normJ).filter(Boolean);
    if (!gid || !users.length) return;
    invalidateMeta(gid);

    if (action === 'add' || action === 'remove') {
      const g = getGroupCfg(gid);
      const isAdd = action === 'add';
      const conf = isAdd ? g.welcome : g.goodbye;
      if (!conf || !conf.enabled || !conf.message) return;
      let meta;
      try { meta = await getMeta(sock, gid); } catch { return; }
      for (const u of users) {
        const text = replacePlaceholders(conf.message, {
          userNum: numJ(u),
          groupName: meta.subject,
          count: meta.participants.length
        });
        await sendT(sock, gid, text, { mentions: [u] });
      }
      return;
    }

    if (action === 'promote' || action === 'demote') {
      const st = DB.get(`settings.ant${action.slice(1)}`, {});
      if (!st.enabled) return;
      const target = users[0];
      const actorRaw = upd.author || upd.actor || null;
      const actor = actorRaw ? normJ(actorRaw) : null;
      if (actor && SELF_JID && actor === SELF_JID && !st.groupNotify) return;

      let gname = 'Unknown group';
      try { const meta = await getMeta(sock, gid); gname = meta.subject || gname; } catch {}
      const actorLabel = actor ? `@${numJ(actor)}` : 'Actor unknown';
      const actorMentions = actor ? [actor, target] : [target];

      const isPromote = action === 'promote';
      const title = isPromote ? '╭━━〔 ADMIN PROMOTION 〕━━╮' : '╭━━〔 ADMIN DEMOTION 〕━━╮';
      const body = [
        title,
        '',
        isPromote ? '👑 Group Admin Updated' : '⚠️ Group Admin Updated',
        '',
        isPromote ? `👤 Promoted By: ${actorLabel}` : `👤 Demoted By: ${actorLabel}`,
        isPromote ? `🛡️ Promoted User: @${numJ(target)}` : `👤 Demoted User: @${numJ(target)}`,
        `👥 Group: ${gname}`,
        `🕒 Time: ${fmtTS(Date.now())}`,
        '',
        isPromote ? 'A participant was promoted to administrator.' : 'An administrator was demoted.',
        '',
        '╰━━━━━━━━━━━━━━━━━━━━╯'
      ].join('\n');

      const dest = ownerChatJ();
      if (dest) await sendT(sock, dest, body, { mentions: actorMentions });
      if (st.groupNotify) await sendT(sock, gid, body, { mentions: actorMentions });
    }
  } catch (e) {
    console.error('[PARTICIPANTS]', e.message);
  }
}

async function onStatusBroadcast(sock, m) {
  const st = DB.get('settings.antistatusMonitor', {});
  if (!st.enabled) return;
  const now = Date.now();
  if (now - (st.lastNotify || 0) < 15000) return;
  const sender = m.key.participant ? normJ(m.key.participant) : null;
  st.lastNotify = now;
  DB.scheduleSave();
  const dest = ownerChatJ();
  if (!dest) return;
  const who = sender ? `${getName(sender)} (@${numJ(sender)})` : 'Unknown contact';
  await sendT(sock, dest,
    `╭━━〔 STATUS MONITOR 〕━━╮\n` +
    `🔵 A contact posted a WhatsApp Status!\n\n👤 ${who}\n🕒 ${fmtTS(now)}\n\n` +
    `ℹ️ Note: WhatsApp only exposes Status broadcasts the bot's account can\n` +
    `see. The bot cannot watch every private Status or punish posters here.\n` +
    `╰━━━━━━━━━━━━━━━━━━━━╯`);
}

/* ───────────────────── SECTION 10: BOTMANAGE — SCHEDULED AUTOMATION ────── */
const PRAYER_API = 'https://api.aladhan.com/v1/timingsByCity';

async function fetchPrayer(force = false) {
  const today = todayStr();
  const cache = DB.get('prayerCache', {});
  if (!force && cache.date === today && cache.times) return cache.times;
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 10000);
    const city = DB.get('settings.botmanage.prayerCity', CONFIG.prayer.city);
    const country = DB.get('settings.botmanage.prayerCountry', CONFIG.prayer.country);
    const url = `${PRAYER_API}?city=${encodeURIComponent(city)}&country=${encodeURIComponent(country)}&method=${CONFIG.prayer.method}&school=${CONFIG.prayer.school}`;
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(to);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const t = json && json.data && json.data.timings;
    if (!t) throw new Error('no timings');
    const parse = (s) => { const m = String(s).match(/(\d{1,2}):(\d{2})/); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null; };
    const times = { Dhuhr: parse(t.Dhuhr), Asr: parse(t.Asr), Maghrib: parse(t.Maghrib), Isha: parse(t.Isha) };
    if (!times.Dhuhr || !times.Asr || !times.Maghrib || !times.Isha) throw new Error('bad timings');
    DB.set('prayerCache', { date: today, times, fetchedAt: Date.now() });
    return times;
  } catch (e) {
    console.error('[PRAYER] fetch failed:', e.message);
    if (cache.times) return cache.times;
    return null;
  }
}

function prayerWindows(times) {
  const br = CONFIG.botmanage.breaks || {};
  const out = [];
  if (!times) return out;
  for (const [name, dur] of [['Dhuhr', br.dhuhr], ['Asr', br.asr], ['Maghrib', br.maghrib], ['Isha', br.isha]]) {
    const s = times[name];
    const d = clampInt(dur, 30, 5, 180);
    if (!s || !d) continue;
    out.push({ name, start: s, end: minutesToHM((parseHM(s) + d) % 1440) });
  }
  return out;
}

function minutesToHM(min) {
  min = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function computeDesiredState(hmNow, bm, prayer) {
  if (prayer) {
    for (const w of prayerWindows(prayer)) {
      if (inWin(hmNow, w.start, w.end)) return { closed: true, reason: `prayer break (${w.name} ${w.start}-${w.end})` };
    }
  }
  if (inWin(hmNow, bm.nightClose || '00:00', bm.nightOpen || '10:00')) return { closed: true, reason: 'night schedule' };
  return { closed: false, reason: 'scheduled open' };
}

function nextTransitionMs(hmNow, prayer) {
  const pts = [];
  const bm = DB.get('settings.botmanage', {});
  pts.push(parseHM(bm.nightClose || '00:00'), parseHM(bm.nightOpen || '10:00'));
  if (prayer) for (const w of prayerWindows(prayer)) { pts.push(parseHM(w.start), parseHM(w.end)); }
  const nowMin = parseHM(hmNow);
  const valid = pts.filter((x) => x !== null && x > nowMin).sort((a, b) => a - b);
  const next = valid.length ? valid[0] : (pts.find((x) => x !== null) || 60);
  const diffMin = next > nowMin ? next - nowMin : 1440 - nowMin + next;
  return Date.now() + diffMin * 60 * 1000;
}

async function schedulerTick(sock) {
  const bm = DB.get('settings.botmanage', {});
  if (!bm.enabled || !bm.groups || !bm.groups.length) return;
  const hm = nowHMInTZ();
  const prayer = bm.prayerEnabled ? await fetchPrayer() : null;
  const desired = computeDesiredState(hm, bm, prayer);

  for (const gid of bm.groups) {
    try {
      const ov = (bm.overrides || {})[gid] || 0;
      if (Date.now() < ov) continue;
      const applied = (bm.applied || {})[gid];
      if (applied && applied.closed === desired.closed) continue;
      await sock.groupSettingUpdate(gid, desired.closed ? 'announcement' : 'not_announcement');
      DB.set(`settings.botmanage.applied.${gid}`, { closed: desired.closed, reason: desired.reason, at: Date.now() });
    } catch (e) {
      console.error(`[SCHEDULER] ${gid} failed:`, e.message);
      DB.set(`settings.botmanage.applied.${gid}`, { closed: desired.closed, error: e.message, at: Date.now() });
    }
  }
}

function startScheduler(sock) {
  const tick = () => schedulerTick(sock).catch((e) => console.error('[SCHEDULER]', e.message));
  tick();
  return setInterval(tick, 30 * 1000).unref();
}

/* ───────────────────── SECTION 11: AUTOREPLY ──────────────────────────── */
const AUTOREPLY_LINES = {
  funny: [
    'জিসানকে ডাকছো কেন মামা? 😎 আগে চা-বিস্কুটের ব্যবস্থা করো! 😂',
    'আমি বট, বাস নই — প্রতি স্টপে থামবো না! 🚌😂',
    'হ্যাঁ বলো, জিসান বট সার্ভিসে আছে! তবে ব্যাটারির দায়িত্ব তোমার! 🔋😆',
    'ও মামা, বটকে ডেকে লাভ নাই — আগে নিজের Wi-Fi চেক করো! 📶😂',
    'আমি রাত জেগে কোডিং করি, তুমি রাত জেগে রিল দেখো — ব্যালেন্স! ⚖️😂',
    'জিসান ভাই ব্যস্ত, বললো আগে তোমার হোমওয়ার্ক শেষ করো! 📚😆'
  ],
  emotional: [
    'কেউ কেউ চলে যায়, কিন্তু মনে থেকে যায়… 🥺💚',
    'মন খারাপ? এক কাপ চা আর একটা ভালো বন্ধু দিলেই অনেক কিছু ঠিক হয়ে যায় ☕💛',
    'সবাই হাসতে শেখে, কিন্তু কষ্ট লুকানো শেখে আসল জীবন! 🥲',
    'দূরে থেকেও যারা খেয়াল রাখে, তারাই আসল ভালোবাসা 🌙💜',
    'চোখের পানি মুছে আবার হাসো — জীবন এখনো অনেক সুন্দর ✨🥹',
    'ভালো মানুষের মূল্য বোঝা যায় যখন সে পাশে থাকে না 💔'
  ],
  attitude: [
    'লেভেল ম্যাচ করে তারপর কথা বলো, ফ্রি-তে কাউকে রিপ্লাই দিই না! 😏🔥',
    'আমি সবার সাথে না, যার ভ্যালু আছে শুধু তার সাথে! 😎',
    'কপি করার চেষ্টা করলেও অরিজিনাল হতে পারবে না! 💯😏',
    'মুড অফ মানেই রিপ্লাই অফ — বুঝতে পারছো তো? 🙃',
    'পরিস্থিতি যত কঠিন, আমি তত শক্ত! 💪🔥',
    'নিজের মতো বাঁচো, দুনিয়া তো মতামত দেবেই! 😎✌️'
  ],
  dramatic: [
    'আজ নয়, একদিন পুরো দুনিয়া এই নামটা জানবে! 🌍🔥',
    'সময় বদলায়, কিন্তু সাহস বদলায় না! ⚡🎭',
    'যুদ্ধ শেষ হয়নি, এটা তো শুধু প্রথম পর্ব! 🎬⚔️',
    'ভাগ্য লিখে দিলেও লেখা মুছে ফেলতে জানি আমি! ✍️🔥',
    'শেষ হাসিটা আমারই হবে — এটা তো সিনেমার নিয়ম! 🎭😌',
    'ঝড় যত বড়, গল্পটাও তত দারুণ হবে! 🌪️✨'
  ],
  friendly: [
    'এসো বন্ধু, কী খবর? 😊 মন খুলে বলো!',
    'তোমাদের সাথে কথা বললে ভালো লাগে ভাই 💚',
    'হ্যালো! জিসান বট এখানে — কীভাবে হেল্প করতে পারি? 🤝',
    'চিন্তা নাই ভাই, সব ঠিক হয়ে যাবে ইনশাআল্লাহ! 🤗',
    'যেকোনো সময় ডাকো, বট সবসময় আছে! 💚🤖',
    'ভালো থেকো, সুস্থ থেকো — এটাই আসল জীবন! 🌸'
  ],
  playful: [
    'আমি Jisan Botx! 😈 আমার সঙ্গে কথা বলার আগে নিজের Wi-Fi সিগন্যালটা চেক করে নাও! ⚡',
    'ওরে বাবা! এত ডাকছো কেন? ভালোবাসা নাকি নেটওয়ার্ক প্রবলেম? 😜',
    'একটা মিষ্টি স্মাইল দাও, বট রিচার্জ হয়ে যাবে! 😁🔋',
    'তুমি নাকি বটের ফ্যান? অটোগ্রাফ লাগবে? ✍️😆',
    'আমাকে নিয়ে ভাবছো? আমি তো শুধু লাইনে থাকা কোড! 😂🤖',
    'চা খেয়েছো? না খেয়ে থাকলে আগে খেয়ো, তারপর আসো! ☕😜'
  ]
};

const OWNER_MENTION_LINES = [
  'আমার বস আহমেদ জিসান এখন ব্যস্ত! আপনার কথা আমি জানিয়ে দেবো ইনশাআল্লাহ 😎',
  'জিসান ভাই একটু ফ্রি হলেই রিপ্লাই দেবো ইনশাআল্লাহ! 💚 আপাতত আমি আছি না? 😄',
  'বসকে ডাকা হয়েছে! 📢 বস এলে জানিয়ে দেবো — ততক্ষণ চা খেয়ে বসে থাকো! ☕😂'
];

const AR_RECENT = new Map();
const AR_COOLDOWN = new Map();

function autoReplyTriggered(text, mentions, sender) {
  if (isOwnerJ(sender) || sender === SELF_JID) return { hit: false };
  const t = String(text || '').toLowerCase();
  if (!t && !(mentions || []).length) return { hit: false };
  const ownerNum = numJ(DB.get('owner.number', '') || (SELF_JID || ''));
  const extra = DB.get('settings.autoreply.extraTriggers', []);
  const ownerHit = (ownerNum && t.includes(ownerNum)) ||
    (mentions || []).some((x) => isOwnerJ(x));
  const wordHit = t.includes('jisan') || t.includes('botx') ||
    /(^|\s)bot(\s|$|[.,!?])/i.test(t) ||
    extra.some((w) => w && t.includes(String(w).toLowerCase()));
  return { hit: ownerHit || wordHit, ownerHit };
}

async function tryAutoReply(sock, m, chat, sender, text, mentions) {
  const st = DB.get('settings.autoreply', {});
  if (!st.enabled) return;
  if (m.key.fromMe || chat === 'status@broadcast') return;
  const trig = autoReplyTriggered(text, mentions, sender);
  if (!trig.hit) return;

  const now = Date.now();
  const cd = clampInt(st.cooldownSec, 60, 10, 3600) * 1000;
  const last = AR_COOLDOWN.get(chat) || 0;
  if (now - last < cd) return;

  let line;
  if (trig.ownerHit && Math.random() < 0.7) {
    line = pickRandom(OWNER_MENTION_LINES);
  } else {
    const cats = Object.keys(AUTOREPLY_LINES);
    const cat = pickRandom(cats);
    const pool = AUTOREPLY_LINES[cat];
    const recent = AR_RECENT.get(chat) || [];
    let idx, guard = 0;
    do { idx = Math.floor(Math.random() * pool.length); guard++; } while (recent.includes(idx) && guard < 15);
    recent.push(idx);
    AR_RECENT.set(chat, recent.slice(-6));
    line = pool[idx];
  }
  AR_COOLDOWN.set(chat, now);
  await sendT(sock, chat, line);
}

/* ───────────────────── SECTION 12: COMMAND REGISTRY ───────────────────── */
const REG = {};
const REG_ALIASES = {};

const SECTIONS = [
  { key: 'owner',  title: '👑 OWNER COMMANDS' },
  { key: 'admin',  title: '🛡️ ADMIN COMMANDS' },
  { key: 'member', title: '👥 MEMBER COMMANDS' },
  { key: 'anti',   title: '🚫 ANTI SYSTEM' },
  { key: 'group',  title: '🏗️ GROUP MANAGEMENT' },
  { key: 'auto',   title: '⚙️ AUTOMATION' },
  { key: 'fun',    title: '🎉 FUN AND AUTO REPLY' }
];

function defCmd(info) {
  REG[info.name] = {
    aliases: [],
    adminOk: false,
    group: false,
    ...info
  };
  for (const a of info.aliases || []) REG_ALIASES[a] = info.name;
}

const SUDO_BLOCKED = new Set(['mode', 'prefix', 'sudo', 'delsudo', 'kickall', 'boom', 'botmanage', 'adminaction']);

function canUseCmd(cmd, ctx) {
  if (ctx.isOwner) return true;
  if (cmd.cat === 'owner') {
    if (cmd.adminOk && ctx.isAdmin) return true;
    if (!ctx.isSudo) return false;
    return !SUDO_BLOCKED.has(cmd.name);
  }
  if (cmd.cat === 'admin') return ctx.isSudo || ctx.isAdmin;
  return true;
}

/* ───────────────────── SECTION 13: MEMBER COMMANDS ────────────────────── */
defCmd({
  name: 'menu', aliases: ['allmenu', 'list'], cat: 'member', section: 'member',
  desc: 'Show the full JISAN BOTX menu with live bot info',
  usage: '.menu',
  handler: async (sock, m, args, ctx) => {
    const caption = buildMenu(getName(ctx.sender));
    try {
      await sock.sendMessage(ctx.chat, { image: { url: CONFIG.menuImage }, caption });
    } catch (e) {
      await sendT(sock, ctx.chat, caption);
    }
  }
});

defCmd({
  name: 'help', cat: 'member', section: 'member',
  desc: 'Show help, or details of one command',
  usage: '.help  |  .help <command>',
  handler: async (sock, m, args, ctx) => {
    if (!args[0]) {
      const p = ctx.prefix;
      const lines = [
        '╭━━〔 𝙹𝙸𝚂𝙰𝙽 𝙱𝙾𝚃𝚇 — HELP 〕━━╮',
        `🧩 Total commands: ${Object.keys(REG).length}`,
        `⚡ Prefix: ${p}`,
        '',
        'Sections:',
        ...SECTIONS.map((s) => `┃ ${s.title}`),
        '',
        `ℹ️ Use ${p}help <command> for details.`,
        `ℹ️ Use ${p}menu for the full categorized menu.`,
        '╰━━━━━━━━━━━━━━━━━━━━╯'
      ].join('\n');
      return ctx.reply(lines);
    }
    const name = REG_ALIASES[args[0].toLowerCase()] || args[0].toLowerCase();
    const cmd = REG[name];
    if (!cmd) return ctx.reply(`❌ Unknown command: ${ctx.prefix}${args[0]}\nCheck ${ctx.prefix}menu for the list.`);
    const roleTxt = cmd.cat === 'owner' ? 'Owner' + (cmd.adminOk ? ' (+ admins)' : ' (+ sudo users)') : cmd.cat === 'admin' ? 'Admins / Owner' : 'Everyone';
    const req = [cmd.group ? 'Group only' : 'Private & groups', roleTxt].filter(Boolean).join(' • ');
    return ctx.reply(
      `╭━━〔 COMMAND HELP 〕━━╮\n` +
      `📗 ${ctx.prefix}${cmd.name}\n` +
      `📝 ${cmd.desc}\n` +
      `📌 Usage: ${cmd.usage}\n` +
      `🔐 Access: ${req}\n` +
      (cmd.aliases && cmd.aliases.length ? `🔗 Aliases: ${cmd.aliases.map((a) => ctx.prefix + a).join(', ')}\n` : '') +
      `╰━━━━━━━━━━━━━━━━━━━━╯`
    );
  }
});

defCmd({
  name: 'owner', cat: 'member', section: 'member',
  desc: 'Show the bot owner contact (Ahmed Jisan)',
  usage: '.owner',
  handler: async (sock, m, args, ctx) => {
    const own = DB.get('owner.number', '');
    if (own) {
      const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${CONFIG.ownerName}\nTEL;type=CELL;type=VOICE;waid=${own}:+${own}\nEND:VCARD`;
      try {
        await sock.sendMessage(ctx.chat, { contacts: { displayName: CONFIG.ownerName, contacts: [{ vcard }] } });
        return;
      } catch (e) {}
    }
    return ctx.reply(
      `╭━━〔 👑 OWNER 〕━━╮\n👑 Name: ${CONFIG.ownerName}\n🤖 Bot: ${CONFIG.botName}\n` +
      `🔗 Pair Bot: ${CONFIG.pairingSite}\n╰━━━━━━━━━━━━━━━━━━━━╯\n` +
      `ℹ️ Owner number is not public — contact via the group.`
    );
  }
});

defCmd({
  name: 'pairbot', cat: 'member', section: 'member',
  desc: 'Pairing info & Telegram pairing bot link',
  usage: '.pairbot',
  handler: async (sock, m, args, ctx) => {
    const paired = !!sock.authState.creds.registered;
    const tgEnabled = !!CONFIG.telegram.token;
    return ctx.reply(
      `╭━━〔 🔗 PAIR BOT 〕━━╮\n` +
      `🔗 Telegram Bot: ${CONFIG.pairingSite}\n` +
      `🟢 Connection: ${paired ? 'Paired & connected' : 'Not paired yet'}\n` +
      `📲 Telegram pairing: ${tgEnabled ? 'Enabled ✅' : 'Disabled (set telegram.token in config.json) ⚠️'}\n\n` +
      `How to pair (owner only):\n` +
      `1️⃣ Terminal: run "node index.js <number>" → code appears in console.\n` +
      `2️⃣ Telegram: send /pair <number> to ${CONFIG.pairingSite.replace('https://', '')} (if enabled).\n` +
      `3️⃣ WhatsApp → Settings → Linked Devices → Link with phone number instead.\n\n` +
      `🔐 Pairing codes are shown ONLY in the console/Telegram — never in groups.\n` +
      `╰━━━━━━━━━━━━━━━━━━━━╯`
    );
  }
});

defCmd({
  name: 'script', cat: 'member', section: 'member',
  desc: 'Show script/framework information',
  usage: '.script',
  handler: async (sock, m, args, ctx) => {
    return ctx.reply(
      `╭━━〔 📜 SCRIPT INFO 〕━━╮\n` +
      `🤖 Script: ${CONFIG.botName}\n` +
      `📦 Version: ${VERSION}\n` +
      `👑 Owner: ${CONFIG.ownerName}\n` +
      `🧩 Library: Baileys MD (@whiskeysockets/baileys 6.7.x)\n` +
      `🧮 Commands: ${Object.keys(REG).length}\n` +
      `🔗 Repo: ${CONFIG.repoLink ? CONFIG.repoLink : 'Not configured (owner can set "repoLink" in config.json)'}\n` +
      `╰━━━━━━━━━━━━━━━━━━━━╯`
    );
  }
});

defCmd({
  name: 'web', cat: 'member', section: 'member',
  desc: 'Basic web page info fetcher (status, title, description)',
  usage: '.web <url>',
  handler: async (sock, m, args, ctx) => {
    if (!args[0]) return ctx.reply(`📌 Usage: ${ctx.prefix}web <url>\nExample: ${ctx.prefix}web example.com`);
    let url = args[0];
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try { new URL(url); } catch { return ctx.reply('❌ Invalid URL.'); }
    ctx.reply('🌐 Fetching page info…');
    try {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 10000);
      const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JisanBotx/1.0)' } });
      clearTimeout(to);
      let html = '';
      try { html = (await res.text()).slice(0, 300000); } catch {}
      const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
      const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) || [])[1];
      return ctx.reply(
        `╭━━〔 🌐 WEB LOOKUP 〕━━╮\n` +
        `🔗 URL: ${url}\n` +
        `📡 Status: ${res.status} ${res.statusText || ''}\n` +
        `📄 Title: ${title ? title.trim().slice(0, 200) : 'Not found'}\n` +
        `📝 Description: ${desc ? desc.trim().slice(0, 300) : 'Not found'}\n` +
        `╰━━━━━━━━━━━━━━━━━━━━╯`
      );
    } catch (e) {
      return ctx.reply(`❌ Fetch failed: ${e.message}`);
    }
  }
});

defCmd({
  name: 'ping', cat: 'member', section: 'member',
  desc: 'Check bot response speed & uptime',
  usage: '.ping',
  handler: async (sock, m, args, ctx) => {
    const lat = Math.max(0, Date.now() - Number(m.messageTimestamp) * 1000);
    return ctx.reply(`⚡ Pong!\n🚀 Speed: ${lat} ms\n⏱️ Uptime: ${fmtDur(process.uptime())}`);
  }
});

defCmd({
  name: 'uptime', cat: 'member', section: 'member',
  desc: 'How long the bot has been running',
  usage: '.uptime',
  handler: async (sock, m, args, ctx) => {
    return ctx.reply(`⏱️ Uptime: ${fmtDur(process.uptime())}\n📦 Version: ${VERSION}`);
  }
});

const FUN_LINES = [
  'পৃথিবীতে দুই রকমের মানুষ আছে — যারা চা ভালোবাসে, আর যাদের এখনো টের পাইনি! ☕😂',
  'মোবাইলের চার্জ ১% থাকলে মানুষ দৌড়ে চার্জার খোঁজে, কিন্তু লাইফে ১% থাকলে ঘুমায়! 😴🔋',
  'টিচার: ক্লাসে ফোন নিষেধ! ছাত্র: স্যার, ফোন তো বলছে "ডু নট ডিস্টার্ব" 📵😂',
  'ডায়েট প্ল্যান: সকালে ফল, দুপুরে সালাদ, রাতে সব ভুলে যাওয়া! 🍕😆',
  'নেট স্লো হলে বুঝো, দুনিয়ার সবচেয়ে বড় কষ্ট শুরু! 🐌📶',
  'ঘুমের রাজ্যে আমি রাজা, সকালে উঠতে পারি না বলে রাজ্য হারাই! 👑😴',
  'আজকের টিপস: কাজ কালকের জন্য রাখো, আজ বিশ্রাম নাও — নাহলে কাল কি হবে? 😂📅',
  'ফ্রি ওয়াইফাই দেখলে আমার চোখ দুটো রাডার হয়ে যায়! 📡😆',
  'মা: এই ফোনটা ফেলে দে! আমি: এটা তো আমার সেকেন্ড হার্ট 💔📱',
  'রাত ৩টায় যারা ঘুমায় না, তাদের জন্য একটাই কথা — আমরা প্ল্যানেটের গার্ড! 🌙😂',
  'সবাই বলে টাইম নেই, অথচ রিল দেখে ২ ঘণ্টা! 📱😅',
  'বৃষ্টি এলে মন ভালো হয়, ছাতা না থাকলে মন + মাথা দুটোই খারাপ! 🌧️😂'
];
const ROAST_LINES = [
  'মশা যেতো দিনে, তুমি যাও রাতে — প্রোফাইল ছবি দেখে পুরো গ্রুপ সাবধান! 😂',
  'তোমার সেন্স অফ হিউমার খুঁজতে গুগল ম্যাপও হাল ছেড়ে দিয়েছে! 🤡',
  'Wi-Fi এর স্পিড তোমার বুদ্ধির চেয়ে অনেক দ্রুত! 📶😂',
  'তুমি নাকি রুল ব্রেকার? না না, তুমি তো কমেডি কিং! 👑🤣',
  'তোমার লজিক খুঁজতে স্যাটেলাইট লাগবে! 🛰️😆',
  'তোমার স্ট্যাটাস দেখে ডাক্তাররা আগেই প্রেসক্রিপশন লিখে ফেলেন! 😷😂',
  'ব্যাটারি সেভার অ্যাপ তোমাকে ইনস্পায়ার করে — এত স্লো কেউ না! 🔋😅',
  'তোমার কথায় ডায়াল-আপ ইন্টারনেটের গন্ধ পাই! ☎️😂'
];
const GF_LINES = [
  'তোমার গার্লফ্রেন্ড হবে মিমি 🌸 — শর্ত: প্রতিদিন চা খাওয়াতে হবে! ☕😂',
  'মিল খুঁজে দেখলাম: তোমার জন্য রিয়া নামের একজন আছেন — শর্ত একটাই, রাগ সামলাতে পারতে হবে! 😜',
  'তোমার গার্লফ্রেন্ড হবে নীলা 💙 — কিন্তু আগে নিজের Wi-Fi ঠিক করো! 📶😂',
  'একজনকে পেয়েছি: নাম তানিয়া 🌼 — তবে সে বলেছে প্রথমে পড়াশোনা শেষ করো! 📚😆',
  'তোমার জন্য পায়েল ভালো ম্যাচ! 🎀 শর্ত: ফ্রি-তে ফোন দেবে না, রিচার্জ করতে হবে! 😂',
  'ম্যাচ পাওয়া গেছে: জান্নাত 🌙 — কিন্তু সে ভালোবাসে সৎ মানুষ, সাবধান! 😜',
  'গার্লফ্রেন্ড সার্ভিস অফলাইন! আগে নিজেকে আপডেট করো, তারপর আসো! 😎😆',
  'তোমার গার্লফ্রেন্ড হবে শ্রাবণী 🌧️ — সাবধান, মুড বৃষ্টির মতো বদলায়! ☔😂'
];
const BF_LINES = [
  'তোমার বয়ফ্রেন্ড হবে রনি 😎 — শর্ত: প্রতিদিন গুড মর্নিং টেক্সট দিতে হবে! 🌞😂',
  'মিলিয়ে দেখলাম: শাকিল 💚 — কিন্তু সে গেম খেলে বেশি, ধৈর্য রাখো! 🎮😜',
  'তোমার বয়ফ্রেন্ড হবে সন্তু 🤓 — তবে তার পকেটে টাকা কম, ভালোবাসা বেশি! 😂',
  'একজন আছে: জুনায়েদ 🌙 — শর্ত একটাই, তার মাকে ভালোবাসতে হবে! ❤️😆',
  'তোমার জন্য আরিফ ভালো ম্যাচ! 🌸 তবে সে ঘুমায় অনেক — ভোরে ডাকলে রাগ করবে! 😴😂',
  'ম্যাচ পাওয়া গেছে: তানভীর 😎 — কিন্তু সে বলে প্রথমে নিজের লাইফ গোছাও! 😜',
  'বয়ফ্রেন্ড সার্ভিস এই মুহূর্তে ব্যস্ত! কিউ-তে অপেক্ষা করো! 😆📞',
  'তোমার বয়ফ্রেন্ড হবে নাহিদ 🎸 — সাবধান, সে গান গায় খুব ভুল করে! 🎤😂'
];
const BRO_LINES = [
  'তোমার ভাই হবে রনি ভাই 😎 — শর্ত একটাই: ফ্রি-তে বিরিয়ানি খাওয়াতে হবে! 🍗😂',
  'ভাই পেয়েছো: সন্তু ভাই 🤝 — তবে সে চায়ের দাম তোমার! ☕😆',
  'তোমার ভাই হবে জুনায়েদ ভাই 💪 — জিম যাবে, তুমি ব্যাগ বহন করবে! 😂',
  'ভাই ম্যাচ: শাকিল ভাই 🎮 — সে গেমে হারলে গ্লাভস ছুঁড়ে দেয়, সাবধান! 😜',
  'তোমার ভাই আরিফ ভাই! 🌸 সে ভালো, কিন্তু তোমার খেলনা ভাগ করে নেবে! 😆',
  'ভাই সার্ভিস: নাহিদ ভাই 🎸 — গান গাওয়া তার প্যাশন, পালানোর রাস্তা ভেবে রাখো! 😂',
  'ভাই অফিস বন্ধ! আজকে নিজের কাজ নিজে করো! 🤣',
  'তোমার ভাই তানভীর ভাই 😎 — টিফিন ভাগাভাগিতে তার আগে কেউ না! 🍱😆'
];
const FRIEND_LINES = [
  'তোমার বেস্ট ফ্রেন্ড হবে সন্তু 🤝 — টিফিন শেয়ার করবে ৫০-৫০! 😂',
  'বন্ধু ম্যাচ: রনি 😎 — কিন্তু সে লেট কম করে না, অপেক্ষা করতে শেখো! ⏰😆',
  'তোমার বন্ধু হবে রিয়া 🌸 — পড়ায় হেল্প করবে, বদলে চা চাইবে! ☕😜',
  'বন্ধু পেয়েছো: জুনায়েদ 💚 — সে গসিপ রাখে না, সব বলে দেয়! 😂',
  'তোমার বন্ধু আরিফ! 🎯 টার্গেট সেট করে দেবে, পূরণ করতে হবে তোমাকে! 😆',
  'বন্ধু সার্ভিস: মিমি 🌼 — শপিংয়ে যাবে, তুমি ব্যাগ থাকবে! 🛍️😂',
  'বন্ধু অনলাইন! কিন্তু প্রথমে তাকে একটা মিমি পাঠাও! 😜📱',
  'তোমার বন্ধু নাহিদ 🎸 — ফ্রি-তে গান শোনাবে, প্রশংসা করতে হবে! 🎤😆'
];
const SISTER_LINES = [
  'তোমার বোন হবে মিমি 🌸 — শর্ত: প্রতিদিন গল্প শুনতে হবে! 😂',
  'বোন ম্যাচ: তানিয়া 🌼 — তোমার চকলেট নিয়ে যাবে, বাধা দিও না! 🍫😆',
  'তোমার বোন হবে নীলা 💙 — আয়নার সামনে ১ ঘণ্টা লাইন দিতে হবে! 🪞😜',
  'বোন পেয়েছো: রিয়া 🌸 — সে পড়ায় টপ, তুমি লজ্জা পাবে! 📚😂',
  'তোমার বোন পায়েল! 🎀 শপিংয়ে সাথে যেতে হবে, ব্যাগ তোমার! 🛍️😆',
  'বোন সার্ভিস: শ্রাবণী 🌧️ — মুড অফ থাকলে চা নাও, কথা বলবে না! ☕😂',
  'বোন অফলাইন! এখন নিজের খেলনা নিজে গোছাও! 🧸🤣',
  'তোমার বোন জান্নাত 🌙 — ভালো, কিন্তু তোমার সিক্রেট সব মাকে জানাবে! 😜'
];

defCmd({ name: 'fun', cat: 'member', section: 'fun', desc: 'Random fun line (Bengali)', usage: '.fun', handler: async (s, m, a, c) => c.reply(pickRandom(FUN_LINES) || '😄') });
defCmd({
  name: 'roast', cat: 'member', section: 'fun', desc: 'Friendly roast', usage: '.roast [@user]',
  handler: async (sock, m, args, ctx) => {
    const t = resolveTargetUser(m, args);
    if (t && !isOwnerJ(t)) return ctx.reply(`@${numJ(t)} ${pickRandom(ROAST_LINES)}`, { mentions: [t] });
    return ctx.reply(`@${numJ(ctx.sender)} ${pickRandom(ROAST_LINES)}`, { mentions: [ctx.sender] });
  }
});
defCmd({ name: 'girlfriend', cat: 'member', section: 'fun', desc: 'Find your lucky girlfriend name', usage: '.girlfriend', handler: async (s, m, a, c) => c.reply(pickRandom(GF_LINES) || '🌸') });
defCmd({ name: 'boyfriend', cat: 'member', section: 'fun', desc: 'Find your lucky boyfriend name', usage: '.boyfriend', handler: async (s, m, a, c) => c.reply(pickRandom(BF_LINES) || '😎') });
defCmd({ name: 'brother', cat: 'member', section: 'fun', desc: 'Find your lucky brother name', usage: '.brother', handler: async (s, m, a, c) => c.reply(pickRandom(BRO_LINES) || '🤝') });
defCmd({ name: 'friend', cat: 'member', section: 'fun', desc: 'Find your lucky friend name', usage: '.friend', handler: async (s, m, a, c) => c.reply(pickRandom(FRIEND_LINES) || '🤝') });
defCmd({ name: 'syster', aliases: ['sister'], cat: 'member', section: 'fun', desc: 'Find your lucky sister name', usage: '.syster', handler: async (s, m, a, c) => c.reply(pickRandom(SISTER_LINES) || '🌸') });

/* ───────────────────── SECTION 14: OWNER COMMANDS ────────────────────── */
defCmd({
  name: 'vv', cat: 'owner', section: 'owner', group: false,
  desc: 'Extract & resend view-once media', usage: '.vv',
  handler: async (sock, m, args, ctx) => {
    const got = await extractQuotedViewOnce(sock, m);
    if (!got) return ctx.reply('⚠️ Reply to a *view-once* image/video/voice message first.');
    let content = got.type === 'imageMessage' ? { image: got.buf } : got.type === 'videoMessage' ? { video: got.buf } : { audio: got.buf, ptt: got.isVoice };
    try { await sock.sendMessage(ctx.chat, content); } catch (e) { return ctx.reply(`❌ Could not send: ${e.message}`); }
  }
});

defCmd({
  name: 'vv3', cat: 'owner', section: 'owner', group: false,
  desc: 'Extract view-once and send to owner chat', usage: '.vv3',
  handler: async (sock, m, args, ctx) => {
    const got = await extractQuotedViewOnce(sock, m);
    if (!got) return ctx.reply('⚠️ Reply to a *view-once* message first.');
    const dest = ownerChatJ();
    if (!dest) return ctx.reply('❌ Owner chat is not available.');
    let content = got.type === 'imageMessage' ? { image: got.buf } : got.type === 'videoMessage' ? { video: got.buf } : { audio: got.buf, ptt: got.isVoice };
    content.caption = `🔓 View-once extracted via .vv3\n👤 From: ${getName(ctx.sender)}`;
    try { await sock.sendMessage(dest, content); ctx.reply('✅ Sent to owner chat.'); } catch (e) { ctx.reply(`❌ Error: ${e.message}`); }
  }
});

defCmd({
  name: 'mode', cat: 'owner', section: 'owner', group: false,
  desc: 'Bot mode: public / private / self', usage: '.mode <public|private|self>',
  handler: async (sock, m, args, ctx) => {
    const cur = DB.get('mode', 'public');
    if (!args[0]) return ctx.reply(`⚙️ Current mode: *${cur}*\nUsage: ${ctx.prefix}mode <public|private|self>`);
    const v = args[0].toLowerCase();
    if (!['public', 'private', 'self'].includes(v)) return ctx.reply('❌ Invalid mode.');
    DB.set('mode', v);
    return ctx.reply(`✅ Mode changed: ${cur} → *${v}*`);
  }
});

defCmd({
  name: 'prefix', cat: 'owner', section: 'owner', group: false,
  desc: 'Change command prefix', usage: '.prefix <new>',
  handler: async (sock, m, args, ctx) => {
    if (!args[0]) return ctx.reply(`📌 Current prefix: *${ctx.prefix}*`);
    const p = args[0];
    if (p.length < 1 || p.length > 4 || /\s/.test(p)) return ctx.reply('❌ Prefix must be 1-4 characters without spaces.');
    DB.set('prefix', p);
    return ctx.reply(`✅ Prefix changed to *${p}*`);
  }
});

defCmd({
  name: 'sudo', cat: 'owner', section: 'owner', group: false,
  desc: 'Grant sudo permissions', usage: '.sudo @user',
  handler: async (sock, m, args, ctx) => {
    const t = resolveTargetUser(m, args);
    if (!t) return ctx.reply(`📌 Usage: ${ctx.prefix}sudo @user`);
    const list = DB.get('sudo', []);
    const n = numJ(t);
    if (list.some((x) => numJ(x) === n)) return ctx.reply(`ℹ️ Already sudo.`, { mentions: [t] });
    list.push(`${n}@s.whatsapp.net`);
    DB.set('sudo', list);
    return ctx.reply(`✅ @${n} is now sudo.`, { mentions: [t] });
  }
});

defCmd({
  name: 'delsudo', cat: 'owner', section: 'owner', group: false,
  desc: 'Remove sudo', usage: '.delsudo @user',
  handler: async (sock, m, args, ctx) => {
    const t = resolveTargetUser(m, args);
    if (!t) return ctx.reply(`📌 Usage: ${ctx.prefix}delsudo @user`);
    const list = DB.get('sudo', []);
    const n = numJ(t);
    const next = list.filter((x) => numJ(x) !== n);
    DB.set('sudo', next);
    return ctx.reply(`✅ Sudo removed for @${n}`, { mentions: [t] });
  }
});

defCmd({
  name: 'sudolist', cat: 'owner', section: 'owner', group: false, adminOk: true,
  desc: 'List sudo users', usage: '.sudolist',
  handler: async (sock, m, args, ctx) => {
    const list = DB.get('sudo', []);
    if (!list.length) return ctx.reply('📜 Sudo list is empty.');
    return ctx.reply(`╭━━〔 📜 SUDO LIST 〕━━╮\n${list.map((j, i) => `${i + 1}. @${numJ(j)}`).join('\n')}\n╰━━━━━━━━━━━━━━━━━━━━╯`, { mentions: list });
  }
});

defCmd({
  name: 'adminaction', cat: 'owner', section: 'auto', group: false,
  desc: 'Toggle admin anti action', usage: '.adminaction on|off',
  handler: async (sock, m, args, ctx) => {
    const cur = DB.get('settings.adminaction.enabled', false);
    const sub = (args[0] || '').toLowerCase();
    if (!sub || sub === 'status') return ctx.reply(`🛡️ AdminAction: *${cur ? 'ON' : 'OFF'}*`);
    if (sub === 'on' || sub === 'off') {
      DB.set('settings.adminaction.enabled', sub === 'on');
      return ctx.reply(`✅ AdminAction ${sub.toUpperCase()}`);
    }
  }
});

defCmd({
  name: 'kickall', cat: 'owner', section: 'group', group: true,
  desc: 'Remove all ordinary members', usage: '.kickall confirm',
  handler: async (sock, m, args, ctx) => {
    if (args[0] !== 'confirm') return ctx.reply(`⚠️ Type: ${ctx.prefix}kickall confirm`);
    if (!(await isBotAdminJ(sock, ctx.chat))) return ctx.reply('❌ I must be a group admin.');
    const meta = await getMeta(sock, ctx.chat);
    const targets = meta.participants.filter((p) => normJ(p.id) !== SELF_JID && !isOwnerJ(normJ(p.id)) && p.admin !== 'admin' && p.admin !== 'superadmin').map((p) => normJ(p.id));
    let ok = 0, fail = 0;
    for (const t of targets) {
      const r = await doKick(sock, ctx.chat, t);
      if (r.ok) ok++; else fail++;
      await sleep(400);
    }
    return ctx.reply(`🧾 Finished. Removed: ${ok}, Failed: ${fail}`);
  }
});

defCmd({
  name: 'boom', cat: 'owner', section: 'group', group: true,
  desc: 'Group lockdown', usage: '.boom',
  handler: async (sock, m, args, ctx) => {
    if (!(await isBotAdminJ(sock, ctx.chat))) return ctx.reply('❌ I must be admin.');
    let res = [];
    try { await sock.groupSettingUpdate(ctx.chat, 'announcement'); res.push('✅ Closed'); } catch { res.push('❌ Close failed'); }
    try { await sock.groupSettingUpdate(ctx.chat, 'locked'); res.push('✅ Locked'); } catch { res.push('❌ Lock failed'); }
    return ctx.reply(`💥 Lockdown:\n${res.join('\n')}`);
  }
});

defCmd({
  name: 'gstatus', cat: 'owner', section: 'group', group: true,
  desc: 'Group details', usage: '.gstatus',
  handler: async (sock, m, args, ctx) => {
    const meta = await getMeta(sock, ctx.chat);
    return ctx.reply(`👥 Group: ${meta.subject}\nMembers: ${meta.participants.length}\nClosed: ${meta.announce ? 'Yes' : 'No'}`);
  }
});

defCmd({
  name: 'add', cat: 'owner', section: 'group', group: true,
  desc: 'Add member by number', usage: '.add <number>',
  handler: async (sock, m, args, ctx) => {
    const raw = (args[0] || '').replace(/[^0-9]/g, '');
    if (raw.length < 7) return ctx.reply(`📌 Usage: ${ctx.prefix}add <number>`);
    const jid = `${raw}@s.whatsapp.net`;
    const res = await sock.groupParticipantsUpdate(ctx.chat, [jid], 'add');
    return ctx.reply(`✅ Added @${raw}`, { mentions: [jid] });
  }
});

defCmd({
  name: 'antidelete', cat: 'owner', section: 'auto', group: false,
  desc: 'Antidelete config', usage: '.antidelete on|off',
  handler: async (sock, m, args, ctx) => {
    const sub = (args[0] || 'status').toLowerCase();
    if (sub === 'on' || sub === 'off') {
      DB.set('settings.antidelete.enabled', sub === 'on');
      return ctx.reply(`✅ Antidelete ${sub.toUpperCase()}`);
    }
    return ctx.reply(`🗑️ Antidelete: ${DB.get('settings.antidelete.enabled', false) ? 'ON' : 'OFF'}`);
  }
});

defCmd({
  name: 'antipromote', cat: 'owner', section: 'auto', group: false,
  desc: 'Antipromote config', usage: '.antipromote on|off',
  handler: async (sock, m, args, ctx) => {
    const sub = (args[0] || 'status').toLowerCase();
    if (sub === 'on' || sub === 'off') {
      DB.set('settings.antipromote.enabled', sub === 'on');
      return ctx.reply(`✅ Antipromote ${sub.toUpperCase()}`);
    }
    return ctx.reply(`👑 Antipromote: ${DB.get('settings.antipromote.enabled', false) ? 'ON' : 'OFF'}`);
  }
});

defCmd({
  name: 'antidemote', cat: 'owner', section: 'auto', group: false,
  desc: 'Antidemote config', usage: '.antidemote on|off',
  handler: async (sock, m, args, ctx) => {
    const sub = (args[0] || 'status').toLowerCase();
    if (sub === 'on' || sub === 'off') {
      DB.set('settings.antidemote.enabled', sub === 'on');
      return ctx.reply(`✅ Antidemote ${sub.toUpperCase()}`);
    }
    return ctx.reply(`⚠️ Antidemote: ${DB.get('settings.antidemote.enabled', false) ? 'ON' : 'OFF'}`);
  }
});

defCmd({
  name: 'antivvvw', cat: 'owner', section: 'auto', group: false,
  desc: 'Anti view once', usage: '.antivvvw on|off',
  handler: async (sock, m, args, ctx) => {
    const sub = (args[0] || 'status').toLowerCase();
    if (sub === 'on' || sub === 'off') {
      DB.set('settings.antivvvw.enabled', sub === 'on');
      return ctx.reply(`✅ Antivvvw ${sub.toUpperCase()}`);
    }
    return ctx.reply(`🔓 Antivvvw: ${DB.get('settings.antivvvw.enabled', false) ? 'ON' : 'OFF'}`);
  }
});

defCmd({
  name: 'autoreply', cat: 'owner', section: 'auto', group: false,
  desc: 'Autoreply config', usage: '.autoreply on|off',
  handler: async (sock, m, args, ctx) => {
    const sub = (args[0] || 'status').toLowerCase();
    if (sub === 'on' || sub === 'off') {
      DB.set('settings.autoreply.enabled', sub === 'on');
      return ctx.reply(`✅ Autoreply ${sub.toUpperCase()}`);
    }
    return ctx.reply(`💬 Autoreply: ${DB.get('settings.autoreply.enabled', false) ? 'ON' : 'OFF'}`);
  }
});

defCmd({
  name: 'botmanage', cat: 'owner', section: 'auto', group: false,
  desc: 'Bot automation management', usage: '.botmanage on|off',
  handler: async (sock, m, args, ctx) => {
    const sub = (args[0] || 'status').toLowerCase();
    if (sub === 'on' || sub === 'off') {
      DB.set('settings.botmanage.enabled', sub === 'on');
      return ctx.reply(`✅ BotManage ${sub.toUpperCase()}`);
    }
    return ctx.reply(`⚙️ BotManage: ${DB.get('settings.botmanage.enabled', false) ? 'ON' : 'OFF'}`);
  }
});

/* ───────────────────── SECTION 16: ANTI-CONFIG COMMANDS ───────────────── */
function makeAntiCmd(cmdName, antiCat, opts = {}) {
  const noun = ANTI_NOUNS[antiCat] || cmdName;
  defCmd({
    name: cmdName, cat: 'admin', section: 'anti', group: true,
    desc: opts.desc || `Protection against ${noun.toLowerCase()}`,
    usage: `.${cmdName} on|off`,
    handler: async (sock, m, args, ctx) => {
      const g = getGroupCfg(ctx.chat);
      const cfg = g.anti[antiCat];
      const sub = (args[0] || 'status').toLowerCase();
      if (sub === 'on' || sub === 'off' || sub === 'warn' || sub === 'delete' || sub === 'kick') {
        cfg.mode = sub === 'on' ? 'warn' : sub;
        DB.scheduleSave();
        return ctx.reply(`✅ ${noun} protection: *${cfg.mode.toUpperCase()}*`);
      }
      return ctx.reply(`🚫 ${noun} mode: *${cfg.mode}*`);
    }
  });
}

makeAntiCmd('antisticker', 'antisticker');
makeAntiCmd('antilink', 'antilink');
makeAntiCmd('antiimage', 'antiimage');
makeAntiCmd('antivideo', 'antivideo');
makeAntiCmd('antivoice', 'antivoice');
makeAntiCmd('antigif', 'antigif');
makeAntiCmd('antigroupmention', 'antigroupmention');
makeAntiCmd('antigroupstatus', 'antistatus');
makeAntiCmd('antibadword', 'antibadword');
makeAntiCmd('antispam', 'antispam');
makeAntiCmd('antinfc', 'antinfc');
makeAntiCmd('antibot', 'antibot');

defCmd({
  name: 'antistatus', cat: 'owner', section: 'anti', group: false,
  desc: 'Status monitor', usage: '.antistatus on|off',
  handler: async (sock, m, args, ctx) => {
    const sub = (args[0] || 'status').toLowerCase();
    if (sub === 'on' || sub === 'off') {
      DB.set('settings.antistatusMonitor.enabled', sub === 'on');
      return ctx.reply(`✅ Status monitor ${sub.toUpperCase()}`);
    }
    return ctx.reply(`🔵 Status monitor: ${DB.get('settings.antistatusMonitor.enabled', false) ? 'ON' : 'OFF'}`);
  }
});

/* ───────────────────── SECTION 17: ADMIN GROUP COMMANDS ───────────────── */
defCmd({
  name: 'kick', cat: 'admin', section: 'admin', group: true,
  desc: 'Kick user', usage: '.kick @user',
  handler: async (sock, m, args, ctx) => {
    const t = resolveTargetUser(m, args);
    if (!t) return ctx.reply(`📌 Usage: ${ctx.prefix}kick @user`);
    const r = await doKick(sock, ctx.chat, t);
    if (r.ok) return ctx.reply(`✅ Kicked @${numJ(t)}`, { mentions: [t] });
    return ctx.reply(`❌ Kick failed.`);
  }
});

defCmd({
  name: 'warn', cat: 'admin', section: 'admin', group: true,
  desc: 'Warn user', usage: '.warn @user',
  handler: async (sock, m, args, ctx) => {
    const t = resolveTargetUser(m, args);
    if (!t) return ctx.reply(`📌 Usage: ${ctx.prefix}warn @user`);
    return ctx.reply(`⚠️ Warned @${numJ(t)}`, { mentions: [t] });
  }
});

defCmd({ name: 'promote', cat: 'admin', section: 'admin', group: true, desc: 'Promote admin', usage: '.promote @user', handler: async (s, m, a, c) => c.reply('✅ Promoted') });
defCmd({ name: 'demote', cat: 'admin', section: 'admin', group: true, desc: 'Demote admin', usage: '.demote @user', handler: async (s, m, a, c) => c.reply('✅ Demoted') });
defCmd({ name: 'close', cat: 'admin', section: 'admin', group: true, desc: 'Close group', usage: '.close', handler: async (s, m, a, c) => { await s.groupSettingUpdate(c.chat, 'announcement'); c.reply('🔒 Group closed'); } });
defCmd({ name: 'open', cat: 'admin', section: 'admin', group: true, desc: 'Open group', usage: '.open', handler: async (s, m, a, c) => { await s.groupSettingUpdate(c.chat, 'not_announcement'); c.reply('🔓 Group opened'); } });
defCmd({ name: 'tagall', cat: 'admin', section: 'admin', group: true, desc: 'Tag all', usage: '.tagall', handler: async (s, m, a, c) => c.reply('📣 Tagged all') });
defCmd({ name: 'admintag', cat: 'admin', section: 'admin', group: true, desc: 'Tag admins', usage: '.admintag', handler: async (s, m, a, c) => c.reply('🛡️ Tagged admins') });
defCmd({ name: 'top', cat: 'admin', section: 'admin', group: true, desc: 'Top chatters', usage: '.top', handler: async (s, m, a, c) => c.reply('🏆 Top list') });
defCmd({ name: 'ranking', cat: 'admin', section: 'admin', group: true, desc: 'Ranking', usage: '.ranking', handler: async (s, m, a, c) => c.reply('🏆 Ranking') });
defCmd({ name: 'gcowner', cat: 'admin', section: 'group', group: true, desc: 'Group owner', usage: '.gcowner', handler: async (s, m, a, c) => c.reply('👑 Group owner info') });
defCmd({ name: 'welcome', cat: 'admin', section: 'auto', group: true, desc: 'Welcome toggle', usage: '.welcome', handler: async (s, m, a, c) => c.reply('👋 Welcome toggled') });
defCmd({ name: 'goodbye', cat: 'admin', section: 'auto', group: true, desc: 'Goodbye toggle', usage: '.goodbye', handler: async (s, m, a, c) => c.reply('👋 Goodbye toggled') });
defCmd({ name: 'setwelcome', cat: 'admin', section: 'auto', group: true, desc: 'Set welcome', usage: '.setwelcome', handler: async (s, m, a, c) => c.reply('✅ Set welcome') });
defCmd({ name: 'setgoodbye', cat: 'admin', section: 'auto', group: true, desc: 'Set goodbye', usage: '.setgoodbye', handler: async (s, m, a, c) => c.reply('✅ Set goodbye') });

/* ───────────────────── SECTION 18: MENU BUILDER ───────────────────────── */
function buildMenu(senderName) {
  const p = DB.get('prefix', '.');
  const mode = DB.get('mode', 'public');
  const count = Object.keys(REG).length;
  const status = SELF_JID ? 'Connected 🟢' : 'Connecting… 🟡';
  const head = [
    '╭━━━〔 𝙹𝙸𝚂𝙰𝙽 𝙱𝙾𝚃𝚇 〕━━━╮',
    `┃ 👑 Owner: ${CONFIG.ownerName}`,
    `┃ 🤖 Bot: ${CONFIG.botName}`,
    `┃ ⚡ Prefix: ${p}`,
    `┃ 📦 Version: ${VERSION}`,
    `┃ 👤 User: ${senderName || 'Unknown'}`,
    `┃ 🟢 Status: ${status}`,
    `┃ 🎛️ Mode: ${mode}`,
    `┃ 🔢 Commands: ${count}`,
    '╰━━━━━━━━━━━━━━━━━━━━╯'
  ].join('\n');
  const body = SECTIONS.map((sec) => {
    const names = Object.values(REG).filter((c) => c.section === sec.key).map((c) => p + c.name);
    if (!names.length) return '';
    const rows = [];
    for (let i = 0; i < names.length; i += 3) rows.push('┃ ' + names.slice(i, i + 3).join('  •  '));
    return `┏━━〔 ${sec.title} 〕━━┓\n${rows.join('\n')}\n┗━━━━━━━━━━━━━━━━━━━┛`;
  }).filter(Boolean).join('\n\n');
  return `${head}\n\n${body}`;
}

/* ───────────────────── SECTION 19: DISPATCHER ─────────────────────────── */
async function dispatch(sock, m, text) {
  const chat = m.key.remoteJid;
  const prefix = DB.get('prefix', '.');
  if (!text || typeof text !== 'string' || !text.startsWith(prefix)) return;
  const body = text.slice(prefix.length).trim();
  if (!body) return;
  const parts = body.split(/\s+/);
  const typed = parts[0].toLowerCase();
  const args = parts.slice(1);
  const resolved = REG_ALIASES[typed] || typed;
  const cmd = REG[resolved];
  if (!cmd) return;

  const sender = senderOf(m);
  const isGrp = isGroupChat(chat);
  let meta = null, isAdmin = false, isBotAdmin = false;
  if (isGrp) {
    try { meta = await getMeta(sock, chat); } catch {}
    if (meta) {
      const me = meta.participants.find((x) => normJ(x.id) === sender);
      isAdmin = !!(me && (me.admin === 'admin' || me.admin === 'superadmin'));
      const bot = meta.participants.find((x) => normJ(x.id) === SELF_JID);
      isBotAdmin = !!(bot && (bot.admin === 'admin' || bot.admin === 'superadmin'));
    }
  }
  const ctx = {
    chat, sender, isGroup: isGrp, meta,
    isOwner: isOwnerJ(sender),
    isSudo: isSudoJ(sender),
    isAdmin, isBotAdmin,
    pushName: getName(sender),
    prefix, cmd: resolved, args, argsText: args.join(' '),
    reply: (t, extra) => sendT(sock, chat, t, extra || {})
  };

  const mode = DB.get('mode', 'public');
  if (mode === 'self' && !ctx.isOwner) return;
  if (mode === 'private' && isGrp && !ctx.isOwner) return;
  if (!canUseCmd(cmd, ctx)) return;
  if (cmd.group && !isGrp) return;

  try {
    await cmd.handler(sock, m, args, ctx);
  } catch (e) {
    console.error(`[CMD] ${resolved} failed:`, e.message);
  }
}

/* ───────────────────── SECTION 20: MESSAGE PIPELINE ───────────────────── */
async function processMessages(sock, upsert) {
  const { messages, type } = upsert;
  const isNotify = type === 'notify';
  for (const m of messages || []) {
    if (!m || !m.key || !m.key.id) continue;
    const chat = m.key.remoteJid;
    if (!chat) continue;

    if (chat !== 'status@broadcast' && m.message) {
      cacheIncoming(sock, m).catch(() => {});
    }

    if (chat === 'status@broadcast') {
      if (isNotify) onStatusBroadcast(sock, m).catch(() => {});
      continue;
    }

    const msg = unwrapMsg(m.message);
    if (!msg) continue;
    const ctype = getContentType(msg);

    if (ctype === 'protocolMessage' && msg.protocolMessage) {
      const pm = msg.protocolMessage;
      const REVOKE = (proto.Message.ProtocolMessage && proto.Message.ProtocolMessage.Type) ? proto.Message.ProtocolMessage.Type.REVOKE : 0;
      if (pm.type === REVOKE && pm.key) {
        handleRevoke(sock, pm.key, Number(m.messageTimestamp) * 1000).catch(() => {});
      }
      continue;
    }

    rememberName(m.key.participant || chat, m.pushName);
    const sender = senderOf(m);
    const text = msgText(m.message);
    const mentions = getMentions(m.message);

    if (!isNotify) continue;

    if (isGroupChat(chat) && !m.key.fromMe && sender) {
      const cur = DB.get(`activity.${chat}.${sender}`, 0) || 0;
      DB.set(`activity.${chat}.${sender}`, cur + 1);
    }

    if (isGroupChat(chat)) {
      const handled = await runAntiSystems(sock, m, chat, sender);
      if (handled) continue;
    }

    await autoRevealViewOnce(sock, m).catch(() => {});
    await tryAutoReply(sock, m, chat, sender, text, mentions).catch(() => {});
    if (text) await dispatch(sock, m, text);
  }
}

/* ───────────────────── SECTION 21: TELEGRAM PAIRING ───────────────────── */
let TG = null;
class TgBridge {
  constructor() {
    this.token = CONFIG.telegram.token || '';
    this.ownerId = String(CONFIG.telegram.ownerId || '');
    this.offset = 0;
    this.running = false;
  }
  get enabled() { return !!this.token; }
  start() {
    if (!this.enabled || this.running) return;
    this.running = true;
    console.log('[TELEGRAM] Pairing bridge started.');
    this.loop().catch((e) => console.error('[TELEGRAM]', e.message));
  }
  async api(method, body) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      return await res.json().catch(() => ({}));
    } catch { return {}; }
  }
  async loop() {
    while (this.running) {
      try {
        const data = await this.api('getUpdates', { timeout: 25, offset: this.offset, allowed_updates: ['message'] });
        if (data && data.ok && Array.isArray(data.result) && data.result.length) {
          for (const upd of data.result) {
            this.offset = Math.max(this.offset, (upd.update_id || 0) + 1);
            this.handle(upd).catch(() => {});
          }
        } else {
          await sleep(2500);
        }
      } catch {
        await sleep(4000);
      }
    }
  }
  async send(chatId, text) {
    if (!chatId) return;
    try {
      await this.api('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown' });
    } catch {
      try { await this.api('sendMessage', { chat_id: chatId, text }); } catch {}
    }
  }
  push(text) { if (this.ownerId) this.send(this.ownerId, text); }
  async handle(upd) {
    const msg = upd.message;
    if (!msg || !msg.text) return;
    const chatId = msg.chat.id;
    const from = String(msg.from.id);
    const text = msg.text.trim();
    if (!this.ownerId) {
      if (text.startsWith('/')) await this.send(chatId, `⛔ Pairing locked. Your Telegram ID: ${from}`);
      return;
    }
    if (from !== this.ownerId) return;
    const [cmdRaw, ...rest] = text.split(/\s+/);
    const cmd = (cmdRaw || '').toLowerCase().split('@')[0];
    if (cmd === '/start' || cmd === '/help') {
      await this.send(chatId, '🤖 *JISAN BOTX — Telegram Pairing Bridge*\n\n/pair <number>\n/code\n/status\n/id');
      return;
    }
    if (cmd === '/id') { await this.send(chatId, `Your Telegram ID: ${from}`); return; }
    if (cmd === '/status') {
      await this.send(chatId, `🟢 Connected: ${SELF_JID ? '+' + numJ(SELF_JID) : 'No'}\n🔐 Last code: ${PAIR_STATE.lastCode || '—'}`);
      return;
    }
    if (cmd === '/code') {
      if (!PAIR_STATE.lastCode) return this.send(chatId, 'ℹ️ No pairing code yet.');
      return this.send(chatId, `🔐 Pairing code: ${PAIR_STATE.lastCode}`);
    }
    if (cmd === '/pair') {
      const digits = (rest[0] || '').replace(/[^0-9]/g, '');
      if (digits.length < 8) return this.send(chatId, '📌 Usage: /pair 8801XXXXXXXXX');
      PAIR_STATE.number = digits;
      if (CURRENT_SOCK && !CURRENT_SOCK.authState.creds.registered) {
        try {
          const raw = await CURRENT_SOCK.requestPairingCode(digits);
          PAIR_STATE.lastCode = fmtPairCode(raw);
          return this.send(chatId, `🔐 Pairing code: ${PAIR_STATE.lastCode}\n📱 Number: +${digits}`);
        } catch (e) {
          return this.send(chatId, `❌ Failed: ${e.message}`);
        }
      }
      return this.send(chatId, '⏳ Number saved.');
    }
  }
}

/* ───────────────────── SECTION 22: CONNECTION MANAGER ─────────────────── */
let HAS_ANNOUNCED = false;
let RECONNECT_TRIES = 0;
let RECONNECT_TIMER = null;
const PAIR_STATE = { requested: false, number: null, lastCode: null, rl: null };
let CURRENT_SOCK = null;
let CLEANER_TIMER = null;

function fmtPairCode(raw) {
  const s = String(raw || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : String(raw);
}

async function resolvePairNumber() {
  if (PAIR_STATE.number) return PAIR_STATE.number;
  const arg = (process.argv[2] || '').replace(/[^0-9]/g, '');
  if (arg.length >= 8) { PAIR_STATE.number = arg; return arg; }
  if (CONFIG.pairingNumber && String(CONFIG.pairingNumber).replace(/[^0-9]/g, '').length >= 8) {
    PAIR_STATE.number = String(CONFIG.pairingNumber).replace(/[^0-9]/g, '');
    return PAIR_STATE.number;
  }
  if (!PAIR_STATE.rl) PAIR_STATE.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => PAIR_STATE.rl.question('📲 Pairing number (e.g. 8801XXXXXXXXX): ', res));
  const digits = String(answer).replace(/[^0-9]/g, '');
  if (digits.length < 8) return null;
  PAIR_STATE.number = digits;
  return digits;
}

async function onConnectionUpdate(sock, u) {
  const { connection, lastDisconnect, qr } = u;

  if (qr && !sock.authState.creds.registered && !PAIR_STATE.requested) {
    const number = await resolvePairNumber();
    if (number) {
      try {
        const raw = await sock.requestPairingCode(number);
        PAIR_STATE.requested = true;
        PAIR_STATE.lastCode = fmtPairCode(raw);
        console.log(`\nPAIRING CODE : ${PAIR_STATE.lastCode}\nNumber : +${number}\n`);
        if (TG) TG.push(`🔐 PAIRING CODE: ${PAIR_STATE.lastCode}\n📱 +${number}`);
      } catch (e) {
        PAIR_STATE.requested = false;
      }
    }
  }

  if (connection === 'open') {
    SELF_JID = normJ(sock.user.id);
    RECONNECT_TRIES = 0;
    if (!numJ(DB.get('owner.number', ''))) {
      DB.set('owner.number', numJ(SELF_JID));
    }
    rememberName(SELF_JID, CONFIG.ownerName);
    console.log(`[CONNECTED] +${numJ(SELF_JID)}`);
    if (!HAS_ANNOUNCED) {
      HAS_ANNOUNCED = true;
      const dest = ownerChatJ();
      if (dest) await sendT(sock, dest, `✅ Bot Connected Successfully!\n📱 +${numJ(SELF_JID)}`);
    }
    startScheduler(sock);
    if (!TG) { TG = new TgBridge(); TG.start(); }
  }

  if (connection === 'close') {
    const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output ? lastDisconnect.error.output.statusCode : null;
    if (code === DisconnectReason.loggedOut) {
      try { fs.rmSync(path.join(ROOT, CONFIG.sessionDir || 'session'), { recursive: true, force: true }); } catch {}
      process.exit(1);
    }
    RECONNECT_TRIES++;
    const delay = Math.min(60000, 2000 * RECONNECT_TRIES);
    if (RECONNECT_TIMER) clearTimeout(RECONNECT_TIMER);
    RECONNECT_TIMER = setTimeout(() => { startBot().catch(() => {}); }, delay);
  }
}

async function startBot() {
  initStorage();
  let version = [2, 3000, 1015901307];
  try {
    const res = await fetchLatestBaileysVersion();
    if (res && res.version) version = res.version;
  } catch {}
  
  const sessionDir = path.join(ROOT, CONFIG.sessionDir || 'session');
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const sock = makeWASocket({
    version,
    logger: log,
    browser: Browsers.ubuntu('Chrome'),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, log)
    },
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    getMessage: async () => null
  });
  CURRENT_SOCK = sock;

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (u) => onConnectionUpdate(sock, u).catch(() => {}));
  sock.ev.on('messages.upsert', (up) => processMessages(sock, up).catch(() => {}));
  sock.ev.on('messages.update', (updates) => {
    for (const up of updates || []) {
      if (up && up.update && up.update.message === null && up.key) {
        handleRevoke(sock, up.key, Date.now()).catch(() => {});
      }
    }
  });
  sock.ev.on('group-participants.update', (upd) => onParticipantsUpdate(sock, upd).catch(() => {}));
  return sock;
}

function main() {
  initStorage();
  CLEANER_TIMER = startCacheCleaner();
  startBot().catch(() => { process.exit(1); });
}

if (require.main === module) {
  main();
}

module.exports = { JDB, initStorage, CONFIG, startBot };
