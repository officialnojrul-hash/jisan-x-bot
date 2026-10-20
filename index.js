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
/**
 * Lightweight atomic JSON storage.
 * - Debounced saves (many rapid changes -> one disk write)
 * - Atomic writes (tmp file + rename) so a crash never corrupts data
 * - Corrupt file is backed up, not deleted
 */
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

  /** dotted path get: db.get('groups.123.anti.antilink.mode', 'off') */
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

  /** Keep the N most recently inserted keys of an object (bounded storage). */
  trimObj(obj, max) {
    const keys = Object.keys(obj);
    if (keys.length <= max) return;
    for (const k of keys.slice(0, keys.length - max)) delete obj[k];
  }
}

let DB = null;          // main settings DB (data/settings.json)
let MSGDB = null;       // antidelete message cache (data/msgcache.json)
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
    warns: {},        // manual .warn: warns[gid][user] = {count, reasons:[]}
    warnAnti: {},     // per-category: warnAnti[gid][user][cat] = n
    activity: {},     // activity[gid][user] = message count
    names: {}         // jid -> last seen pushName
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

/** Get (and lazily create) per-group settings. */
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
/** Normalized bare JID (strips :device and @server leftovers). */
function normJ(jid) {
  if (!jid || typeof jid !== 'string') return '';
  try { return jidNormalizedUser(jid); } catch { return jid.split(':')[0].split('@')[0] + '@s.whatsapp.net'; }
}
function numJ(jid) {
  if (!jid) return '';
  return String(jid).split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}
function isGroupChat(jid) { return !!jid && jid.endsWith('@g.us'); }

let SELF_JID = null; // bot's own account jid (set on connection open)

function isOwnerJ(jid) {
  if (!jid) return false;
  const n = normJ(jid);
  if (SELF_JID && n === SELF_JID) return true;                 // authenticated account = owner
  const own = DB && DB.get('owner.number', '');
  if (own && numJ(n) === numJ(own)) return true;               // explicitly configured owner ID
  return false;
}
function isSudoJ(jid) {
  if (!DB || !jid) return false;
  if (isOwnerJ(jid)) return true;
  const list = DB.get('sudo', []);
  return list.some((s) => numJ(s) === numJ(jid));
}
/** Chat the owner receives private reports in (own chat if owner == bot account). */
function ownerChatJ() {
  const own = DB && DB.get('owner.number', '');
  if (own) return `${numJ(own)}@s.whatsapp.net`;
  return SELF_JID || null;
}

/* ── group metadata cache (refreshed every 5 min, avoids API spam) ─────── */
const META_CACHE = new Map(); // gid -> {data, ts}
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

/* ── pushName memory (library has no contact store; best-effort names) ── */
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
/** Strip view-once / ephemeral wrappers to reach the real content object. */
function unwrapMsg(message) {
  let m = message;
  const WRAPPERS = ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'ephemeralMessage', 'documentWithCaptionMessage', 'editedMessage'];
  let guard = 0;
  while (m && guard++ < 6) {
    const t = getContentType(m);
    if (t && WRAPPERS.includes(t) && m[t] && m[t].message) {
      m = m[t].message;
      if (t === 'editedMessage') continue; // editedMessage.message is the new body wrapper
    } else break;
  }
  return m || message;
}

/** Human-readable text/caption of a message (best effort). */
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

/** Friendly media type label for reports. */
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

/** Quoted/replied message info: {jid, id, message, text} or null. */
function getQuoted(m) {
  const msg = unwrapMsg(m.message);
  const t = msg && getContentType(msg);
  const c = t && msg[t];
  const ci = c && c.contextInfo;
  if (!ci || !ci.quotedMessage) return null;
  return {
    jid: ci.participant ? normJ(ci.participant) : null,
    id: ci.stanzaId || null,
    remoteJid: ci.remoteJid || null, // 'status@broadcast' when the quoted msg came from a status
    message: ci.quotedMessage,
    text: msgText(ci.quotedMessage)
  };
}

/**
 * Resolve a target user from: @mention > reply-to > bare number argument.
 * Returns normalized jid (user@s.whatsapp.net) or null.
 */
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

/** Sender of an incoming message (normalized). fromMe => bot account itself. */
function senderOf(m) {
  if (m.key.fromMe) return SELF_JID || normJ(m.key.remoteJid);
  if (isGroupChat(m.key.remoteJid)) return normJ(m.key.participant || m.key.remoteJid);
  return normJ(m.key.remoteJid);
}

/** Attempt to delete a message (needs bot admin in groups). Returns {ok, err}. */
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

/**
 * Kick a user. If the target is an admin and adminaction is enabled the bot
 * demotes first (WhatsApp never lets a bot remove an active admin directly).
 * Returns {ok, code, err}.
 */
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

/** Honest failure-code explanations for participant actions. */
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

/* ═══════════════════ SECTION 7: ANTIDELETE ENGINE ═══════════════════════
   Strategy (honest, bounded):
   - Every permitted incoming message's metadata (chat, sender, time, type,
     text/caption, quoted context) is stored in data/msgcache.json.
   - When media caching is ON, media the bot legitimately received is saved
     to media_cache/ (size-capped, TTL-limited) so a later deletion report
     can attach it.
   - WhatsApp exposes revocations as protocol REVOKE events. On a revoke we
     look up the cache and report to the owner's own chat.
   - If the original was never received/cached we report the deletion EVENT
     without inventing content. WhatsApp does not return deleted payloads. */
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

/** Download any media content object -> Buffer (or null).
 *  Primary: Baileys' standalone downloadMediaMessage (handles re-upload
 *  requests for expired media). Fallback: raw downloadContentFromMessage. */
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

/** Persist a media buffer to media_cache/. Returns absolute path or null. */
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

/** Store incoming message metadata (and optionally media) for antidelete. */
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

  // media caching (only when antidelete is active and enabled by owner)
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

/** Periodic cleanup: TTL + total size cap for media_cache/, prune cache. */
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
      // prune stale message metadata
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

/** Build + send the antidelete report to the owner's own chat. */
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

  // attach recovered media if we legitimately stored it
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

/** Handle a detected revocation event. */
async function handleRevoke(sock, delKey, eventTs) {
  if (!sock || !delKey || !delKey.id) return;
  const ad = DB.get('settings.antidelete', {});
  if (!ad.enabled) return;
  const chat = delKey.remoteJid;
  if (!chat || chat === 'status@broadcast') return;
  if (delKey.fromMe && !isGroupChat(chat)) return; // owner deleting own private msg — not interesting
  if (!markRevokeProcessed(delKey.id)) return;     // dedup
  try {
    await sendAntideleteReport(sock, delKey, eventTs);
  } catch (e) {
    console.error('[ANTIDELETE] report failed:', e.message);
  }
}

/** Find view-once content in a message. Returns {type, content} or null. */
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

/** Extract quoted view-once media -> {buf, mimetype, type} or null. */
async function extractQuotedViewOnce(sock, m) {
  const q = getQuoted(m);
  if (!q || !q.message) return null;
  const vo = findViewOnce(q.message);
  if (!vo) return null;
  const buf = await downloadBuffer(sock, q.message, vo.content, vo.type);
  if (!buf) return null;
  return { buf, mimetype: vo.content.mimetype || '', type: vo.type, isVoice: !!(vo.content.ptt) };
}

/** .antivvvw auto-forward: any view-once received in PRIVATE chat -> owner. */
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

/* ═══════════════════ SECTION 8: ANTI-SYSTEM ENGINE ══════════════════════
   Modes per group + category: off | warn | delete | kick
   warn  : 3 warnings with per-user/per-group/per-category counters,
           removal attempted on the 4th violation.
   delete: delete + notify, no warn count, never kicks.
   kick  : delete + immediate removal (only success produces a removal msg).
   Admins are exempt while adminaction is OFF; the owner is always exempt. */
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

/** Throttled "I need admin" notice so the bot doesn't spam the group. */
async function notifyNoAdmin(sock, gid) {
  const g = getGroupCfg(gid);
  const now = Date.now();
  if (now - (g.noAdminNotice || 0) < 5 * 60 * 1000) return;
  g.noAdminNotice = now;
  DB.scheduleSave();
  await sendT(sock, gid, '⚠️ I need *admin* rights in this group to enforce the configured protection. Please promote me and try again.');
}

/**
 * Apply the configured anti action for a detected violation.
 * Returns true when a punitive action was triggered (caller stops checking).
 */
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
        DB.set(`warnAnti.${chat}.${user}.${cat}`, 3); // keep at 3, retry next violation
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

/* ── spam detection: sliding window in memory (chat|user -> timestamps) ── */
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

/* ── link + whitelist detection ────────────────────────────────────────── */
const URL_RE = /((https?:\/\/)|(www\.))[^\s]+|([a-z0-9-]+\.)+(com|net|org|io|me|xyz|info|link|site|app|gg|tv|co|in|bd)(\/[^\s]*)?/i;
const WA_INVITE_RE = /chat\.whatsapp\.com\/[A-Za-z0-9]{10,}/i;

let ownInviteCache = { gid: null, code: null, ts: 0 };
async function getOwnInviteCode(sock, gid) {
  if (ownInviteCache.gid === gid && ownInviteCache.code && Date.now() - ownInviteCache.ts < 10 * 60 * 1000) return ownInviteCache.code;
  try {
    const code = await sock.groupInviteCode(gid);
    ownInviteCache = { gid, code, ts: Date.now() };
    return code;
  } catch { return null; }
}

function textHasLink(text, whitelist) {
  if (!text) return false;
  if (!URL_RE.test(text)) return false;
  const lower = text.toLowerCase();
  for (const w of whitelist || []) {
    if (w && lower.includes(String(w).toLowerCase())) return false;
  }
  return true;
}

/** Map a message to the first matching anti category (null = no match). */
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
    // forwarded status into the group (context shows status origin)
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
    // Heuristic detection ONLY (honest): Meta-style bot JIDs and raw
    // interactive/template UI messages that normal users do not send.
    if (/@bot$/.test(senderOf(m)) || /@bot\.net$/.test(senderOf(m))) return 'antibot';
    if (type === 'templateMessage' || type === 'interactiveMessage' || type === 'buttonsResponseMessage') return 'antibot';
  }
  return null;
}

/** Full anti pipeline for one group message. Returns true if handled. */
async function runAntiSystems(sock, m, chat, user) {
  if (!isGroupChat(chat)) return false;
  if (!user || isOwnerJ(user) || user === SELF_JID) return false; // protect owner & bot
  const adminaction = DB.get('settings.adminaction.enabled', false);
  const userIsAdmin = await isAdminJ(sock, chat, user);
  if (userIsAdmin && !adminaction) return false; // admin exemption policy
  const cat = await detectAntiCategory(sock, m, chat);
  if (!cat) return false;
  return handleAntiViolation(sock, m, cat, {
    user,
    demoteFirst: userIsAdmin && adminaction
  });
}

/* ═════════════ SECTION 9: WELCOME / GOODBYE / PROMOTE / DEMOTE ══════════ */
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
      const st = DB.get(`settings.ant${action.slice(1)}`, {}); // antipromote / antidemote
      if (!st.enabled) return;
      const target = users[0];
      const actorRaw = upd.author || upd.actor || null;
      const actor = actorRaw ? normJ(actorRaw) : null;
      // don't spam owner about actions the bot performed itself via commands
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

/**
 * antistatus: WhatsApp exposes OTHER users' Status broadcasts to the bot as
 * status@broadcast messages. That is the only status-related event Baileys
 * provides — the bot CANNOT monitor every private Status invisibly, and it
 * cannot punish anyone inside the Status section. When enabled we simply
 * notify the owner that a contact posted a status. Throttled.
 */
async function onStatusBroadcast(sock, m) {
  const st = DB.get('settings.antistatusMonitor', {});
  if (!st.enabled) return;
  const now = Date.now();
  if (now - (st.lastNotify || 0) < 15000) return; // throttle: 1 notification / 15s
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

/* ═════════════ SECTION 10: BOTMANAGE — SCHEDULED AUTOMATION ══════════════
   Default daily schedule (all times in CONFIG.timezone):
     00:00 -> close group to ordinary members (announcement mode)
     10:00 -> reopen
   Prayer breaks (durations from config): Dhuhr/Asr/Maghrib 30m, Isha 50m.
   Prayer times come from the free AlAdhan API (city/country configurable,
   cached daily, non-hardcoded). If the API is unreachable the last cached
   times are reused; with no cache at all prayer breaks are skipped and
   reported honestly in .botmanage status.
   Priority policy: manual .close/.open sets a manual override until the
   next scheduled transition; prayer breaks override the night window. */
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
    if (cache.times) return cache.times; // stale but usable
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

/** Desired group state from the schedule rules. Returns {closed, reason} */
function computeDesiredState(hmNow, bm, prayer) {
  if (prayer) {
    for (const w of prayerWindows(prayer)) {
      if (inWin(hmNow, w.start, w.end)) return { closed: true, reason: `prayer break (${w.name} ${w.start}-${w.end})` };
    }
  }
  if (inWin(hmNow, bm.nightClose || '00:00', bm.nightOpen || '10:00')) return { closed: true, reason: 'night schedule' };
  return { closed: false, reason: 'scheduled open' };
}

/** Timestamp of the next schedule boundary (for manual override expiry). */
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
      if (Date.now() < ov) continue; // manual override active
      const applied = (bm.applied || {})[gid];
      if (applied && applied.closed === desired.closed) continue;
      await sock.groupSettingUpdate(gid, desired.closed ? 'announcement' : 'not_announcement');
      DB.set(`settings.botmanage.applied.${gid}`, { closed: desired.closed, reason: desired.reason, at: Date.now() });
      console.log(`[SCHEDULER] ${gid} -> ${desired.closed ? 'CLOSED' : 'OPEN'} (${desired.reason})`);
    } catch (e) {
      console.error(`[SCHEDULER] ${gid} failed:`, e.message);
      // honest failure note (bot removed / not admin / group gone)
      DB.set(`settings.botmanage.applied.${gid}`, { closed: desired.closed, error: e.message, at: Date.now() });
    }
  }
}

function startScheduler(sock) {
  const tick = () => schedulerTick(sock).catch((e) => console.error('[SCHEDULER]', e.message));
  tick();
  return setInterval(tick, 30 * 1000).unref();
}

/* ═════════════ SECTION 11: AUTOREPLY — BENGALI RESPONSES ════════════════
   100% original Bengali lines (no copyrighted dialogues). Categories:
   funny / emotional / attitude / dramatic / friendly / playful. */
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

const AR_RECENT = new Map();  // chat -> [recent line indices]
const AR_COOLDOWN = new Map(); // chat -> last reply ts

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

/* ═══════════════════ SECTION 12: COMMAND REGISTRY ═══════════════════════
   Every command is registered here. The menu is generated FROM this
   registry, so the displayed command count and list always reflect what
   is actually implemented. */
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
    adminOk: false,   // true => group admins may also use this owner command
    group: false,     // true => group-only
    ...info
  };
  for (const a of info.aliases || []) REG_ALIASES[a] = info.name;
}

/** Owner commands a sudo user may NOT use (config-sensitive). */
const SUDO_BLOCKED = new Set(['mode', 'prefix', 'sudo', 'delsudo', 'kickall', 'boom', 'botmanage', 'adminaction']);

function canUseCmd(cmd, ctx) {
  if (ctx.isOwner) return true;
  if (cmd.cat === 'owner') {
    if (cmd.adminOk && ctx.isAdmin) return true;
    if (!ctx.isSudo) return false;
    return !SUDO_BLOCKED.has(cmd.name);
  }
  if (cmd.cat === 'admin') return ctx.isSudo || ctx.isAdmin;
  return true; // member commands
}

/* ═══════════════════ SECTION 13: MEMBER COMMANDS ════════════════════════ */
defCmd({
  name: 'menu', aliases: ['allmenu', 'list'], cat: 'member', section: 'member',
  desc: 'Show the full JISAN BOTX menu with live bot info',
  usage: '.menu',
  handler: async (sock, m, args, ctx) => {
    const caption = buildMenu(getName(ctx.sender));
    try {
      await sock.sendMessage(ctx.chat, { image: { url: CONFIG.menuImage }, caption });
    } catch (e) {
      console.error('[MENU] image send failed, falling back to text:', e.message);
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
      } catch (e) { console.error('[OWNER] vcard failed:', e.message); }
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
  desc: 'Basic web page info fetcher (status, title, description) — not a full browser',
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
      const desc = (html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i) || [])[1];
      return ctx.reply(
        `╭━━〔 🌐 WEB LOOKUP 〕━━╮\n` +
        `🔗 URL: ${url}\n` +
        `📡 Status: ${res.status} ${res.statusText || ''}\n` +
        `📄 Title: ${title ? title.trim().slice(0, 200) : 'Not found'}\n` +
        `📝 Description: ${desc ? desc.trim().slice(0, 300) : 'Not found'}\n` +
        `╰━━━━━━━━━━━━━━━━━━━━╯\n` +
        `ℹ️ This is a basic info fetcher, not full web browsing.`
      );
    } catch (e) {
      return ctx.reply(`❌ Fetch failed: ${e.name === 'AbortError' ? 'timeout (10s)' : e.message}\nℹ️ Some sites block bots — that is a real failure, not a fake result.`);
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

/* ── fun content (100% original Bengali lines) ─────────────────────────── */
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

defCmd({
  name: 'fun', cat: 'member', section: 'fun',
  desc: 'Random fun line (Bengali)',
  usage: '.fun',
  handler: async (sock, m, args, ctx) => ctx.reply(pickRandom(FUN_LINES) || '😄')
});
defCmd({
  name: 'roast', cat: 'member', section: 'fun',
  desc: 'Friendly roast (mention someone or roast yourself)',
  usage: '.roast [@user]',
  handler: async (sock, m, args, ctx) => {
    const t = resolveTargetUser(m, args);
    if (t && !isOwnerJ(t)) {
      return ctx.reply(`@${numJ(t)} ${pickRandom(ROAST_LINES)}`, { mentions: [t] });
    }
    return ctx.reply(`@${numJ(ctx.sender)} ${pickRandom(ROAST_LINES)}`, { mentions: [ctx.sender] });
  }
});
defCmd({ name: 'girlfriend', cat: 'member', section: 'fun', desc: 'Find your lucky girlfriend name 😄', usage: '.girlfriend', handler: async (s, m, a, c) => c.reply(pickRandom(GF_LINES) || '🌸') });
defCmd({ name: 'boyfriend', cat: 'member', section: 'fun', desc: 'Find your lucky boyfriend name 😄', usage: '.boyfriend', handler: async (s, m, a, c) => c.reply(pickRandom(BF_LINES) || '😎') });
defCmd({ name: 'brother', cat: 'member', section: 'fun', desc: 'Find your lucky brother name 😄', usage: '.brother', handler: async (s, m, a, c) => c.reply(pickRandom(BRO_LINES) || '🤝') });
defCmd({ name: 'friend', cat: 'member', section: 'fun', desc: 'Find your lucky friend name 😄', usage: '.friend', handler: async (s, m, a, c) => c.reply(pickRandom(FRIEND_LINES) || '🤝') });
defCmd({
  name: 'syster', aliases: ['sister'], cat: 'member', section: 'fun',
  desc: 'Find your lucky sister name 😄',
  usage: '.syster',
  handler: async (s, m, a, c) => c.reply(pickRandom(SISTER_LINES) || '🌸')
});

/* ═══════════════════ SECTION 14: OWNER COMMANDS ═════════════════════════ */
defCmd({
  name: 'vv', cat: 'owner', section: 'owner', group: false,
  desc: 'Extract & resend a view-once media from a replied message (in this chat)',
  usage: '.vv (reply to view-once media)',
  handler: async (sock, m, args, ctx) => {
    const got = await extractQuotedViewOnce(sock, m);
    if (!got) return ctx.reply('⚠️ Reply to a *view-once* image/video/voice message first.\nUsage: .vv (reply)');
    let content;
    if (got.type === 'imageMessage') content = { image: got.buf };
    else if (got.type === 'videoMessage') content = { video: got.buf };
    else content = { audio: got.buf, ptt: got.isVoice };
    try { await sock.sendMessage(ctx.chat, content); }
    catch (e) { return ctx.reply(`❌ Could not send: ${e.message}`); }
  }
});

defCmd({
  name: 'vv3', cat: 'owner', section: 'owner', group: false,
  desc: 'Extract view-once media from a replied message and send it to the owner chat (private)',
  usage: '.vv3 (reply to view-once media)',
  handler: async (sock, m, args, ctx) => {
    const got = await extractQuotedViewOnce(sock, m);
    if (!got) return ctx.reply('⚠️ Reply to a *view-once* image/video/voice message first.\nUsage: .vv3 (reply)');
    const dest = ownerChatJ();
    if (!dest) return ctx.reply('❌ Owner chat is not available yet.');
    let content;
    if (got.type === 'imageMessage') content = { image: got.buf };
    else if (got.type === 'videoMessage') content = { video: got.buf };
    else content = { audio: got.buf, ptt: got.isVoice };
    content.caption = `🔓 View-once extracted via .vv3\n👤 From: ${getName(ctx.sender)} (@${numJ(ctx.sender)})`;
    try { await sock.sendMessage(dest, content); ctx.reply('✅ Sent to owner chat.'); }
    catch (e) { ctx.reply(`❌ Could not send: ${e.message}`); }
  }
});

defCmd({
  name: 'mode', cat: 'owner', section: 'owner', group: false,
  desc: 'Bot mode: public (everyone) / private (private chats) / self (owner only)',
  usage: '.mode <public|private|self>  |  .mode',
  handler: async (sock, m, args, ctx) => {
    const cur = DB.get('mode', 'public');
    if (!args[0]) return ctx.reply(`⚙️ Current mode: *${cur}*\nUsage: ${ctx.prefix}mode <public|private|self>`);
    const v = args[0].toLowerCase();
    if (!['public', 'private', 'self'].includes(v)) return ctx.reply('❌ Invalid mode. Use: public | private | self');
    DB.set('mode', v);
    return ctx.reply(`✅ Mode changed: ${cur} → *${v}*`);
  }
});

defCmd({
  name: 'prefix', cat: 'owner', section: 'owner', group: false,
  desc: 'Change the command prefix (persists after restart)',
  usage: '.prefix <new prefix>',
  handler: async (sock, m, args, ctx) => {
    if (!args[0]) return ctx.reply(`📌 Current prefix: *${ctx.prefix}*\nUsage: ${ctx.prefix}prefix <new prefix> (1-4 characters)`);
    const p = args[0];
    if (p.length < 1 || p.length > 4 || /\s/.test(p)) return ctx.reply('❌ Prefix must be 1-4 characters without spaces.');
    DB.set('prefix', p);
    return ctx.reply(`✅ Prefix changed to *${p}*\nExample: ${p}menu\n(Persists after restart.)`);
  }
});

defCmd({
  name: 'sudo', cat: 'owner', section: 'owner', group: false,
  desc: 'Grant sudo (extra) permissions to a user',
  usage: '.sudo @user | .sudo <number>',
  handler: async (sock, m, args, ctx) => {
    const t = resolveTargetUser(m, args);
    if (!t) return ctx.reply(`📌 Usage: ${ctx.prefix}sudo @user | <number>  (or reply to their message)`);
    const list = DB.get('sudo', []);
    const n = numJ(t);
    if (list.some((x) => numJ(x) === n)) return ctx.reply(`ℹ️ @${n} is already a sudo user.`, { mentions: [t] });
    list.push(`${n}@s.whatsapp.net`);
    DB.set('sudo', list);
    return ctx.reply(`✅ @${n} is now a *sudo* user (admin-level access, limited owner commands).`, { mentions: [t] });
  }
});

defCmd({
  name: 'delsudo', cat: 'owner', section: 'owner', group: false,
  desc: 'Remove sudo permissions from a user',
  usage: '.delsudo @user | <number>',
  handler: async (sock, m, args, ctx) => {
    const t = resolveTargetUser(m, args);
    if (!t) return ctx.reply(`📌 Usage: ${ctx.prefix}delsudo @user | <number>`);
    const list = DB.get('sudo', []);
    const n = numJ(t);
    const next = list.filter((x) => numJ(x) !== n);
    if (next.length === list.length) return ctx.reply(`ℹ️ @${n} was not a sudo user.`, { mentions: [t] });
    DB.set('sudo', next);
    return ctx.reply(`✅ Sudo removed: @${n}`, { mentions: [t] });
  }
});

defCmd({
  name: 'sudolist', cat: 'owner', section: 'owner', group: false, adminOk: true,
  desc: 'List all sudo users',
  usage: '.sudolist',
  handler: async (sock, m, args, ctx) => {
    const list = DB.get('sudo', []);
    if (!list.length) return ctx.reply('📜 Sudo list is empty.');
    const lines = list.map((j, i) => `${i + 1}. @${numJ(j)} (${getName(j)})`);
    return ctx.reply(`╭━━〔 📜 SUDO LIST 〕━━╮\n${lines.join('\n')}\n╰━━━━━━━━━━━━━━━━━━━━╯`, { mentions: list });
  }
});

defCmd({
  name: 'adminaction', cat: 'owner', section: 'auto', group: false,
  desc: 'When ON, anti rules also apply to group admins',
  usage: '.adminaction on | off | status',
  handler: async (sock, m, args, ctx) => {
    const cur = DB.get('settings.adminaction.enabled', false);
    const sub = (args[0] || '').toLowerCase();
    if (!sub || sub === 'status') {
      return ctx.reply(`🛡️ AdminAction: *${cur ? 'ON' : 'OFF'}*\n${cur ? 'Anti rules apply to admins too.' : 'Admins are exempt from anti rules.'}\n${ctx.prefix}adminaction on|off`);
    }
    if (sub === 'on' || sub === 'off') {
      DB.set('settings.adminaction.enabled', sub === 'on');
      return ctx.reply(`✅ AdminAction ${sub === 'on' ? 'ON — anti rules now apply to admins (owner is always protected).' : 'OFF — admins are exempt.'}`);
    }
    return ctx.reply(`📌 Usage: ${ctx.prefix}adminaction on|off|status`);
  }
});

defCmd({
  name: 'kickall', cat: 'owner', section: 'group', group: true,
  desc: 'Remove ALL ordinary members (admins/owner/bot excluded) — needs explicit confirmation',
  usage: '.kickall confirm',
  handler: async (sock, m, args, ctx) => {
    if (args[0] !== 'confirm') {
      return ctx.reply(
        `⚠️ *DANGER ZONE* ⚠️\nThis removes every ordinary member from the group (admins, the owner and the bot are excluded).\n` +
        `To confirm, type exactly:\n${ctx.prefix}kickall confirm`
      );
    }
    if (!(await isBotAdminJ(sock, ctx.chat))) return ctx.reply('❌ I must be a group admin to remove members.');
    const meta = await getMeta(sock, ctx.chat);
    const targets = meta.participants
      .filter((p) => {
        const j = normJ(p.id);
        return j !== SELF_JID && !isOwnerJ(j) && p.admin !== 'admin' && p.admin !== 'superadmin';
      })
      .map((p) => normJ(p.id));
    if (!targets.length) return ctx.reply('ℹ️ No ordinary members to remove.');
    await ctx.reply(`⏳ Removing ${targets.length} member(s)…`);
    let ok = 0, fail = 0;
    for (const t of targets) {
      const r = await doKick(sock, ctx.chat, t);
      if (r.ok) ok++; else fail++;
      await sleep(400);
    }
    return ctx.reply(`🧾 Kickall finished.\n✅ Removed: ${ok}\n❌ Failed: ${fail}${fail ? '\n(Failures are usually privacy settings or permission limits — reported honestly, not faked.)' : ''}`);
  }
});

defCmd({
  name: 'boom', cat: 'owner', section: 'group', group: true,
  desc: 'Group LOCKDOWN: close group for members, lock info edits, revoke the invite link',
  usage: '.boom',
  handler: async (sock, m, args, ctx) => {
    if (!(await isBotAdminJ(sock, ctx.chat))) return ctx.reply('❌ I must be a group admin to lockdown the group.');
    const results = [];
    try { await sock.groupSettingUpdate(ctx.chat, 'announcement'); results.push('✅ Group closed for ordinary members'); }
    catch (e) { results.push('❌ Close failed: ' + e.message); }
    try { await sock.groupSettingUpdate(ctx.chat, 'locked'); results.push('✅ Group info locked (admins only)'); }
    catch (e) { results.push('❌ Info lock failed: ' + e.message); }
    if (typeof sock.groupRevokeInvite === 'function') {
      try { await sock.groupRevokeInvite(ctx.chat); results.push('✅ Invite link revoked'); }
      catch (e) { results.push('❌ Invite revoke failed: ' + e.message); }
    } else {
      results.push('⚠️ Invite revoke is not available in this library version.');
    }
    return ctx.reply(`╭━━〔 💥 BOOM — LOCKDOWN 〕━━╮\n${results.join('\n')}\n╰━━━━━━━━━━━━━━━━━━━━╯`);
  }
});

defCmd({
  name: 'gstatus', cat: 'owner', section: 'group', group: true,
  desc: 'Show detailed group information the library provides',
  usage: '.gstatus',
  handler: async (sock, m, args, ctx) => {
    let meta;
    try { meta = await getMeta(sock, ctx.chat); }
    catch (e) { return ctx.reply(`❌ Could not load group info: ${e.message}`); }
    const botAdmin = await isBotAdminJ(sock, ctx.chat);
    let invite = '— (need admin)';
    if (botAdmin) { try { invite = 'https://chat.whatsapp.com/' + await sock.groupInviteCode(ctx.chat); } catch {} }
    const ownerTxt = meta.owner ? `${getName(meta.owner)} (@${numJ(meta.owner)})` : 'Unknown';
    return ctx.reply(
      `╭━━〔 📊 GROUP STATUS 〕━━╮\n` +
      `👥 Name: ${meta.subject || 'Unknown'}\n` +
      `🆔 ID: ${ctx.chat}\n` +
      `👤 Creator: ${ownerTxt}\n` +
      `🧮 Members: ${meta.participants.length}\n` +
      `🔒 Messages: ${meta.announce ? 'Admins only (closed)' : 'Everyone (open)'}\n` +
      `✏️ Info edit: ${meta.restrict ? 'Admins only' : 'Everyone'}\n` +
      ` Communities: ${meta.isCommunity ? 'Yes' : 'No'}\n` +
      `🤖 Bot is admin: ${botAdmin ? 'Yes ✅' : 'No ❌'}\n` +
      `🔗 Invite: ${invite}\n` +
      (meta.desc ? `\n📝 Description:\n${String(meta.desc).slice(0, 300)}\n` : '') +
      `╰━━━━━━━━━━━━━━━━━━━━╯`
    );
  }
});

defCmd({
  name: 'add', cat: 'owner', section: 'group', group: true,
  desc: 'Add a member by number (reports failures honestly)',
  usage: '.add 8801XXXXXXXXX',
  handler: async (sock, m, args, ctx) => {
    const raw = (args[0] || '').replace(/[^0-9]/g, '');
    if (raw.length < 7) return ctx.reply(`📌 Usage: ${ctx.prefix}add 8801XXXXXXXXX\n(country code, no + sign)`);
    if (!(await isBotAdminJ(sock, ctx.chat))) return ctx.reply('❌ I must be a group admin to add members.');
    const jid = `${raw}@s.whatsapp.net`;
    try {
      const res = await sock.groupParticipantsUpdate(ctx.chat, [jid], 'add');
      const r = Array.isArray(res) ? res[0] : null;
      const code = r && r.code ? String(r.code) : 'unknown';
      if (code === '200') return ctx.reply(`✅ Added @${raw}`, { mentions: [jid] });
      if (code === '403') {
        let link = '';
        if (await isBotAdminJ(sock, ctx.chat)) {
          try { link = `\n🔗 Invite link instead: https://chat.whatsapp.com/${await sock.groupInviteCode(ctx.chat)}`; } catch {}
        }
        return ctx.reply(`❌ Could not add @${raw}: the user's privacy settings or permissions block direct add.${link}`, { mentions: [jid] });
      }
      return ctx.reply(`❌ Could not add @${raw}: ${participantErrText(code, 'add') || 'unknown error (' + code + ')'}`, { mentions: [jid] });
    } catch (e) {
      return ctx.reply(`❌ Add failed: ${e.message}`);
    }
  }
});

defCmd({
  name: 'antidelete', cat: 'owner', section: 'auto', group: false,
  desc: 'Deleted-message monitor — reports revocations to the owner chat',
  usage: '.antidelete on | off | status | media on|off | retention <hours>',
  handler: async (sock, m, args, ctx) => {
    const sub = (args[0] || 'status').toLowerCase();
    const enabled = DB.get('settings.antidelete.enabled', false);
    if (sub === 'on' || sub === 'off') {
      DB.set('settings.antidelete.enabled', sub === 'on');
      return ctx.reply(`✅ Antidelete *${sub === 'on' ? 'ON' : 'OFF'}*.\n${sub === 'on' ? 'Deleted messages in private chats & groups will now be reported to the owner chat (within library limits).' : 'No more deletion reports.'}`);
    }
    if (sub === 'media') {
      const v = (args[1] || '').toLowerCase();
      if (!['on', 'off'].includes(v)) return ctx.reply(`📌 Usage: ${ctx.prefix}antidelete media on|off`);
      DB.set('settings.antidelete.mediaCache', v === 'on');
      return ctx.reply(`✅ Media caching for antidelete: *${v.toUpperCase()}*${v === 'on' ? ` (max ${CONFIG.antidelete.maxMediaMB}MB/file, ${CONFIG.antidelete.maxCacheMB}MB total, ${DB.get('settings.antidelete.retentionHours', 12)}h retention)` : ''}`);
    }
    if (sub === 'retention') {
      const h = clampInt(args[1], 12, 1, 720);
      DB.set('settings.antidelete.retentionHours', h);
      return ctx.reply(`✅ Message/media retention set to *${h} hour(s)*. Older cached data is cleaned automatically.`);
    }
    const mc = DB.get('settings.antidelete.mediaCache', true);
    const cached = MSGDB ? Object.keys(MSGDB.data.msgs).length : 0;
    return ctx.reply(
      `╭━━〔 🗑️ ANTIDELETE 〕━━╮\n` +
      `🟢 Status: ${enabled ? 'ON' : 'OFF'}\n` +
      `🖼️ Media cache: ${mc ? 'ON' : 'OFF'}\n` +
      `⏳ Retention: ${DB.get('settings.antidelete.retentionHours', 12)}h\n` +
      `💾 Cached messages: ${cached}\n` +
      `📤 Reports go to: owner chat (${ownerChatJ() ? 'ready' : 'not ready'})\n` +
      `╰━━━━━━━━━━━━━━━━━━━━╯\n` +
      `ℹ️ Honest limits: WhatsApp does not deliver the content of messages the bot never received. Deleted media can only be re-attached if it was cached before deletion.`
    );
  }
});

defCmd({
  name: 'antipromote', cat: 'owner', section: 'auto', group: false,
  desc: 'Notify the owner when someone is promoted to group admin',
  usage: '.antipromote on | off | status | groupnotify on|off',
  handler: async (sock, m, args, ctx) => {
    const sub = (args[0] || 'status').toLowerCase();
    if (sub === 'groupnotify') {
      const v = (args[1] || '').toLowerCase();
      if (!['on', 'off'].includes(v)) return ctx.reply(`📌 Usage: ${ctx.prefix}antipromote groupnotify on|off`);
      DB.set('settings.antipromote.groupNotify', v === 'on');
      return ctx.reply(`✅ Promotion group notifications: ${v.toUpperCase()}`);
    }
    if (sub === 'on' || sub === 'off') {
      DB.set('settings.antipromote.enabled', sub === 'on');
      return ctx.reply(`✅ Promotion notifications: *${sub.toUpperCase()}*${sub === 'on' ? ' (owner gets a private report with actor + target)' : ''}`);
    }
    const st = DB.get('settings.antipromote', {});
    return ctx.reply(`👑 Antipromote: ${st.enabled ? 'ON' : 'OFF'} | Group notify: ${st.groupNotify ? 'ON' : 'OFF'}\nℹ️ If WhatsApp does not reveal the actor, the report says "Actor unknown" — never a guess.`);
  }
});

defCmd({
  name: 'antidemote', cat: 'owner', section: 'auto', group: false,
  desc: 'Notify the owner when an admin is demoted',
  usage: '.antidemote on | off | status | groupnotify on|off',
  handler: async (sock, m, args, ctx) => {
    const sub = (args[0] || 'status').toLowerCase();
    if (sub === 'groupnotify') {
      const v = (args[1] || '').toLowerCase();
      if (!['on', 'off'].includes(v)) return ctx.reply(`📌 Usage: ${ctx.prefix}antidemote groupnotify on|off`);
      DB.set('settings.antidemote.groupNotify', v === 'on');
      return ctx.reply(`✅ Demotion group notifications: ${v.toUpperCase()}`);
    }
    if (sub === 'on' || sub === 'off') {
      DB.set('settings.antidemote.enabled', sub === 'on');
      return ctx.reply(`✅ Demotion notifications: *${sub.toUpperCase()}*${sub === 'on' ? ' (owner gets a private report with actor + target)' : ''}`);
    }
    const st = DB.get('settings.antidemote', {});
    return ctx.reply(`⚠️ Antidemote: ${st.enabled ? 'ON' : 'OFF'} | Group notify: ${st.groupNotify ? 'ON' : 'OFF'}`);
  }
});

defCmd({
  name: 'antivvvw', cat: 'owner', section: 'auto', group: false,
  desc: 'Auto-reveal: view-once media received in PRIVATE chats is forwarded to the owner chat',
  usage: '.antivvvw on | off | status',
  handler: async (sock, m, args, ctx) => {
    const sub = (args[0] || 'status').toLowerCase();
    if (sub === 'on' || sub === 'off') {
      DB.set('settings.antivvvw.enabled', sub === 'on');
      return ctx.reply(`✅ Anti-ViewOnce auto-reveal: *${sub.toUpperCase()}*`);
    }
    return ctx.reply(
      `🔓 Anti-ViewOnce: ${DB.get('settings.antivvvw.enabled', false) ? 'ON' : 'OFF'}\n` +
      `ℹ️ Exact behaviour: when ON, every view-once image/video/voice the bot's account *receives in private chats* is automatically copied to the owner chat.\n` +
      `⚠️ Honest limits: it works only on media the bot account actually receives (it must be in the chat). It cannot intercept other people's private view-once messages.`
    );
  }
});

defCmd({
  name: 'autoreply', cat: 'owner', section: 'auto', group: false,
  desc: 'Configure the Bengali auto-reply system',
  usage: '.autoreply on | off | status | cooldown <sec> | trigger add|del <word> | list',
  handler: async (sock, m, args, ctx) => {
    const sub = (args[0] || 'status').toLowerCase();
    if (sub === 'on' || sub === 'off') {
      DB.set('settings.autoreply.enabled', sub === 'on');
      return ctx.reply(`✅ AutoReply: *${sub.toUpperCase()}*${sub === 'on' ? ' — triggers: "jisan", "bot", "botx", owner mention' : ''}`);
    }
    if (sub === 'cooldown') {
      const sec = clampInt(args[1], 60, 10, 3600);
      DB.set('settings.autoreply.cooldownSec', sec);
      return ctx.reply(`✅ AutoReply cooldown: *${sec}s* per chat (prevents reply loops).`);
    }
    if (sub === 'trigger') {
      const op = (args[1] || '').toLowerCase();
      const word = (args.slice(2).join(' ') || '').trim().toLowerCase();
      if (!['add', 'del'].includes(op) || !word) return ctx.reply(`📌 Usage: ${ctx.prefix}autoreply trigger add|del <word>`);
      const list = DB.get('settings.autoreply.extraTriggers', []);
      if (op === 'add') {
        if (list.includes(word)) return ctx.reply('ℹ️ Trigger already exists.');
        list.push(word);
        DB.set('settings.autoreply.extraTriggers', list);
        return ctx.reply(`✅ Trigger added: "${word}"`);
      }
      const next = list.filter((w) => w !== word);
      if (next.length === list.length) return ctx.reply('ℹ️ Trigger not found.');
      DB.set('settings.autoreply.extraTriggers', next);
      return ctx.reply(`✅ Trigger removed: "${word}"`);
    }
    if (sub === 'list') {
      const list = DB.get('settings.autoreply.extraTriggers', []);
      return ctx.reply(`📜 Extra triggers: ${list.length ? list.map((w) => `"${w}"`).join(', ') : '(none)'}\nBuilt-in: "jisan", "botx", "bot", owner mention`);
    }
    const st = DB.get('settings.autoreply', {});
    return ctx.reply(
      `╭━━〔 💬 AUTOREPLY 〕━━╮\n` +
      `🟢 Status: ${st.enabled ? 'ON' : 'OFF'}\n` +
      `⏳ Cooldown: ${st.cooldownSec || 60}s per chat\n` +
      `🧠 Lines: 36 original Bengali lines (6 moods) + owner-mention lines\n` +
      `🔁 Anti-loop: recent lines avoided, per-chat cooldown\n` +
      `╰━━━━━━━━━━━━━━━━━━━━╯`
    );
  }
});

/* ═════════════ SECTION 15: BOTMANAGE COMMAND (owner) ════════════════════ */
defCmd({
  name: 'botmanage', cat: 'owner', section: 'auto', group: false,
  desc: 'Scheduled group automation: daily close/open + prayer breaks (AlAdhan API, configurable city)',
  usage: '.botmanage on | off | status | schedule <close> <open> | group add|del|list | prayer on|off | city <name> | country <name>',
  handler: async (sock, m, args, ctx) => {
    const sub = (args[0] || 'status').toLowerCase();

    if (sub === 'on' || sub === 'off') {
      DB.set('settings.botmanage.enabled', sub === 'on');
      return ctx.reply(`✅ BotManage automation *${sub.toUpperCase()}*.${sub === 'on' ? '\nℹ️ It only manages groups registered via: .botmanage group add' : ''}`);
    }

    if (sub === 'schedule') {
      const close = args[1], open = args[2];
      if (!close || !open || parseHM(close) === null || parseHM(open) === null) {
        return ctx.reply(`📌 Usage: ${ctx.prefix}botmanage schedule <HH:MM> <HH:MM>\nExample: ${ctx.prefix}botmanage schedule 00:00 10:00\n(closes at 00:00, reopens at 10:00)`);
      }
      DB.set('settings.botmanage.nightClose', close);
      DB.set('settings.botmanage.nightOpen', open);
      return ctx.reply(`✅ Daily schedule saved: close *${close}* → open *${open}* (time zone: ${CONFIG.timezone}).`);
    }

    if (sub === 'group') {
      const op = (args[1] || '').toLowerCase();
      const groups = DB.get('settings.botmanage.groups', []);
      if (op === 'add') {
        let gid = isGroupChat(ctx.chat) ? ctx.chat : (args[2] || '');
        if (!isGroupChat(gid)) return ctx.reply(`📌 Run inside the target group, or: ${ctx.prefix}botmanage group add <groupId@g.us>`);
        if (groups.includes(gid)) return ctx.reply('ℹ️ This group is already managed.');
        groups.push(gid);
        DB.set('settings.botmanage.groups', groups);
        return ctx.reply(`✅ Group registered for automation (${groups.length} total).`);
      }
      if (op === 'del') {
        const gid = args[2] && isGroupChat(args[2]) ? args[2] : (isGroupChat(ctx.chat) ? ctx.chat : null);
        if (!gid) return ctx.reply(`📌 Usage: ${ctx.prefix}botmanage group del  (inside the group)`);
        const next = groups.filter((g) => g !== gid);
        if (next.length === groups.length) return ctx.reply('ℹ️ That group was not registered.');
        DB.set('settings.botmanage.groups', next);
        return ctx.reply(`✅ Group removed from automation.`);
      }
      if (op === 'list') {
        if (!groups.length) return ctx.reply('📜 No groups registered. Add one: .botmanage group add (inside a group)');
        const lines = groups.map((g, i) => `${i + 1}. ${g}`);
        return ctx.reply(`📜 Managed groups:\n${lines.join('\n')}`);
      }
      return ctx.reply(`📌 Usage: ${ctx.prefix}botmanage group add|del|list`);
    }

    if (sub === 'prayer') {
      const v = (args[1] || '').toLowerCase();
      if (!['on', 'off'].includes(v)) return ctx.reply(`📌 Usage: ${ctx.prefix}botmanage prayer on|off`);
      DB.set('settings.botmanage.prayerEnabled', v === 'on');
      return ctx.reply(`✅ Prayer breaks: *${v.toUpperCase()}*${v === 'on' ? ` (source: AlAdhan API — ${DB.get('settings.botmanage.prayerCity', CONFIG.prayer.city)}, ${DB.get('settings.botmanage.prayerCountry', CONFIG.prayer.country)})` : ''}`);
    }

    if (sub === 'city' || sub === 'country') {
      const val = args.slice(1).join(' ').trim();
      if (!val) return ctx.reply(`📌 Usage: ${ctx.prefix}botmanage ${sub} <name>`);
      DB.set(`settings.botmanage.prayer${sub === 'city' ? 'City' : 'Country'}`, val);
      DB.set('prayerCache', { date: '', times: null, fetchedAt: 0 }); // force refetch
      return ctx.reply(`✅ Prayer ${sub} set to *${val}*. Times will refresh on the next tick.`);
    }

    // STATUS (default)
    const bm = DB.get('settings.botmanage', {});
    const hm = nowHMInTZ();
    const prayer = bm.prayerEnabled ? await fetchPrayer() : null;
    const desired = computeDesiredState(hm, bm, prayer);
    const prayerTxt = !bm.prayerEnabled
      ? 'OFF'
      : prayer
        ? `ON (source: ${DB.get('settings.botmanage.prayerCity', CONFIG.prayer.city)}, ${DB.get('settings.botmanage.prayerCountry', CONFIG.prayer.country)} — ${DB.get('prayerCache.date', todayStr())}: Dhuhr ${prayer.Dhuhr}, Asr ${prayer.Asr}, Maghrib ${prayer.Maghrib}, Isha ${prayer.Isha})`
        : 'ON but times unavailable (API unreachable, no cache) — prayer breaks paused, will retry';
    const groups = bm.groups || [];
    const applied = bm.applied || {};
    const appliedTxt = Object.entries(applied).slice(-3).map(([gid, v]) =>
      `┃ ${gid.split('@')[0]}: ${v.closed ? 'CLOSED' : 'OPEN'}${v.error ? ' (error: ' + String(v.error).slice(0, 60) + ')' : ' ✓'}`).join('\n');
    return ctx.reply(
      `╭━━〔 ⚙️ BOTMANAGE 〕━━╮\n` +
      `🟢 Automation: ${bm.enabled ? 'ON' : 'OFF'}\n` +
      `🕒 Daily: close ${bm.nightClose} → open ${bm.nightOpen} (${CONFIG.timezone})\n` +
      `🕌 Prayer: ${prayerTxt}\n` +
      ` muslim Breaks: Dhuhr/Asr/Maghrib ${CONFIG.botmanage.breaks.dhuhr}m, Isha ${CONFIG.botmanage.breaks.isha}m\n` +
      `👥 Groups: ${groups.length ? groups.length + ' registered' : 'none (use: .botmanage group add)'}\n` +
      `🧭 Now (${hm}): desired = ${desired.closed ? 'CLOSED' : 'OPEN'} (${desired.reason})\n` +
      (appliedTxt ? `📊 Last applied:\n${appliedTxt}\n` : '') +
      `ℹ️ Manual .close/.open overrides automation until the next scheduled transition.\n` +
      `╰━━━━━━━━━━━━━━━━━━━━╯`
    );
  }
});

/* ═════════════ SECTION 16: ANTI-CONFIG COMMANDS (admin) ═════════════════ */
function makeAntiCmd(cmdName, antiCat, opts = {}) {
  const noun = ANTI_NOUNS[antiCat] || cmdName;
  defCmd({
    name: cmdName, cat: 'admin', section: 'anti', group: true,
    desc: opts.desc || `Protection against ${noun.toLowerCase()} — modes: on/warn/delete/kick/off`,
    usage: `.${cmdName} on|warn|delete|kick|off|status` + (opts.extraUsage || ''),
    handler: async (sock, m, args, ctx) => {
      const g = getGroupCfg(ctx.chat);
      const cfg = g.anti[antiCat];
      const sub = (args[0] || 'status').toLowerCase();
      const p = ctx.prefix;

      if (sub === 'status') {
        return ctx.reply(`🚫 *${noun}* protection in this group: *${cfg.mode}*\nModes: on (= warn), warn (3 strikes → removal), delete, kick, off`);
      }

      // category-specific subcommands
      if (antiCat === 'antilink' && ['whitelist'].includes(sub)) {
        const op = (args[1] || '').toLowerCase();
        const val = args.slice(2).join(' ').trim();
        if (!['add', 'del', 'list'].includes(op)) return ctx.reply(`📌 Usage: ${p}antilink whitelist add|del|list <text>`);
        const wl = cfg.whitelist || [];
        if (op === 'list') return ctx.reply(`📜 Link whitelist: ${wl.length ? wl.map((w) => `"${w}"`).join(', ') : '(empty)'}`);
        if (!val) return ctx.reply(`📌 Usage: ${p}antilink whitelist ${op} <text>`);
        if (op === 'add') {
          if (wl.includes(val)) return ctx.reply('ℹ️ Already whitelisted.');
          wl.push(val);
        } else {
          const idx = wl.indexOf(val);
          if (idx === -1) return ctx.reply('ℹ️ Not in whitelist.');
          wl.splice(idx, 1);
        }
        cfg.whitelist = wl; DB.scheduleSave();
        return ctx.reply(`✅ Whitelist ${op === 'add' ? 'added' : 'removed'}: "${val}" (${wl.length} total)`);
      }
      if (antiCat === 'antigroupmention' && sub === 'limit') {
        const n = clampInt(args[1], 5, 2, 100);
        cfg.limit = n; DB.scheduleSave();
        return ctx.reply(`✅ Mention threshold: *${n}* mentions (triggers above this).`);
      }
      if (antiCat === 'antibadword' && ['add', 'del', 'list'].includes(sub)) {
        const words = cfg.words || [];
        const val = args.slice(1).join(' ').trim().toLowerCase();
        if (sub === 'list') return ctx.reply(`📜 Bad words: ${words.length ? words.join(', ') : '(empty)'}`);
        if (!val) return ctx.reply(`📌 Usage: ${p}antibadword add|del <word>`);
        if (sub === 'add') {
          if (words.includes(val)) return ctx.reply('ℹ️ Word already added.');
          words.push(val);
        } else {
          const idx = words.indexOf(val);
          if (idx === -1) return ctx.reply('ℹ️ Word not found.');
          words.splice(idx, 1);
        }
        cfg.words = words; DB.scheduleSave();
        return ctx.reply(`✅ Bad word list ${sub === 'add' ? 'added' : 'removed'}: "${val}" (${words.length} total)`);
      }
      if (antiCat === 'antispam' && sub === 'limit') {
        const maxMsgs = clampInt(args[1], 8, 3, 100);
        const perSec = clampInt(args[2], 10, 2, 120);
        cfg.maxMsgs = maxMsgs; cfg.perSec = perSec; DB.scheduleSave();
        return ctx.reply(`✅ Spam limit: *${maxMsgs} messages / ${perSec}s*.`);
      }

      const valid = ['on', 'warn', 'delete', 'kick', 'off'];
      if (!valid.includes(sub)) return ctx.reply(`📌 Usage: ${p}${cmdName} on|warn|delete|kick|off|status${opts.extraUsage || ''}`);
      cfg.mode = sub === 'on' ? 'warn' : sub;
      DB.scheduleSave();
      const modeTxt = cfg.mode === 'warn' ? 'WARN — 3 warnings, removal on the 4th violation'
        : cfg.mode === 'delete' ? 'DELETE — message deleted + sender notified (no warnings)'
        : cfg.mode === 'kick' ? 'KICK — immediate removal attempt' : 'OFF';
      return ctx.reply(`✅ *${noun}* protection: *${cfg.mode.toUpperCase()}*\n${modeTxt}${cfg.mode !== 'off' ? '\nℹ️ I need admin rights to delete/remove. Warnings are counted per user, per group, per category.' : ''}`);
    }
  });
}

makeAntiCmd('antisticker', 'antisticker');
makeAntiCmd('antilink', 'antilink', { extraUsage: ' | .antilink whitelist add|del|list <text>', desc: 'Blocks links & WhatsApp invite links (owner-manageable whitelist)' });
makeAntiCmd('antiimage', 'antiimage');
makeAntiCmd('antivideo', 'antivideo');
makeAntiCmd('antivoice', 'antivoice', { desc: 'Blocks voice notes & audio messages' });
makeAntiCmd('antigif', 'antigif', { desc: 'Blocks GIFs (animated media arriving as video)' });
makeAntiCmd('antigroupmention', 'antigroupmention', { extraUsage: ' | .antigroupmention limit <n>', desc: 'Blocks mass mentions above a configurable threshold' });
makeAntiCmd('antigroupstatus', 'antistatus', { desc: 'Blocks status updates forwarded into this group', extraUsage: '' });
makeAntiCmd('antibadword', 'antibadword', { extraUsage: ' | .antibadword add|del|list <word>' });
makeAntiCmd('antispam', 'antispam', { extraUsage: ' | .antispam limit <msgs> <seconds>', desc: 'Rate-limit protection with configurable threshold' });
makeAntiCmd('antinfc', 'antinfc', { desc: 'Blocks contact card (vCard) messages' });
makeAntiCmd('antibot', 'antibot', { desc: 'Heuristic bot-activity detection (bot JIDs / bot-style UI messages)' });

defCmd({
  name: 'antistatus', cat: 'owner', section: 'anti', group: false,
  desc: 'Status monitor: notify the owner when contacts post WhatsApp Status broadcasts',
  usage: '.antistatus on | off | status',
  handler: async (sock, m, args, ctx) => {
    const sub = (args[0] || 'status').toLowerCase();
    if (sub === 'on' || sub === 'off') {
      DB.set('settings.antistatusMonitor.enabled', sub === 'on');
      return ctx.reply(`✅ Status monitor: *${sub.toUpperCase()}*`);
    }
    return ctx.reply(
      `🔵 Status monitor: ${DB.get('settings.antistatusMonitor.enabled', false) ? 'ON' : 'OFF'}\n` +
      `ℹ️ Honest limitation: WhatsApp only exposes Status broadcasts that the bot's own account can see, one notification at a time.\n` +
      `The bot CANNOT silently monitor every private Status, and nobody can be punished inside the Status section.`
    );
  }
});

/* ═════════════ SECTION 17: ADMIN GROUP COMMANDS ═════════════════════════ */
defCmd({
  name: 'kick', cat: 'admin', section: 'admin', group: true,
  desc: 'Remove a member (mention, reply, or number)',
  usage: '.kick @user',
  handler: async (sock, m, args, ctx) => {
    const t = resolveTargetUser(m, args);
    if (!t) return ctx.reply(`📌 Usage: ${ctx.prefix}kick @user — or reply to their message with ${ctx.prefix}kick`);
    if (t === SELF_JID) return ctx.reply('😅 I will not kick myself.');
    if (isOwnerJ(t)) return ctx.reply('⛔ The owner cannot be kicked.');
    if (!(await isBotAdminJ(sock, ctx.chat))) return ctx.reply('❌ I must be a group admin to kick members.');
    const tAdmin = await isAdminJ(sock, ctx.chat, t);
    const adminaction = DB.get('settings.adminaction.enabled', false);
    if (tAdmin && !adminaction) return ctx.reply('⛔ I cannot remove an admin while AdminAction is OFF (owner: .adminaction on).');
    const r = await doKick(sock, ctx.chat, t, { demoteFirst: tAdmin });
    if (r.ok) return ctx.reply(`✅ @${numJ(t)} has been removed from this group.\nReason: Kicked by admin.`, { mentions: [t] });
    return ctx.reply(`❌ Kick failed: ${participantErrText(r.code, 'remove') || r.err || 'unknown error'}`);
  }
});

defCmd({
  name: 'warn', cat: 'admin', section: 'admin', group: true,
  desc: 'Warn a member (persistent per-group counter, 3 warns → removal attempt)',
  usage: '.warn @user [reason]',
  handler: async (sock, m, args, ctx) => {
    const t = resolveTargetUser(m, args);
    if (!t) return ctx.reply(`📌 Usage: ${ctx.prefix}warn @user [reason] — or reply to their message`);
    if (t === SELF_JID) return ctx.reply('😅 I will not warn myself.');
    if (isOwnerJ(t)) return ctx.reply('⛔ The owner cannot be warned.');
    const adminaction = DB.get('settings.adminaction.enabled', false);
    const tAdmin = await isAdminJ(sock, ctx.chat, t);
    if (tAdmin && !adminaction) return ctx.reply('⛔ I cannot warn an admin while AdminAction is OFF.');
    const reason = args.slice(1).join(' ') || 'Rule break';
    if (!DB.data.warns[ctx.chat]) DB.data.warns[ctx.chat] = {};
    if (!DB.data.warns[ctx.chat][t]) DB.data.warns[ctx.chat][t] = { count: 0, reasons: [] };
    const w = DB.data.warns[ctx.chat][t];
    w.count += 1;
    w.reasons.push(reason.slice(0, 100));
    DB.trimObj(DB.data.warns[ctx.chat], 500);
    DB.scheduleSave();

    if (w.count >= 3) {
      if (!(await isBotAdminJ(sock, ctx.chat))) {
        return ctx.reply(`⚠️ @${numJ(t)} reached 3/3 warnings, but I need admin rights to remove them.`, { mentions: [t] });
      }
      const r = await doKick(sock, ctx.chat, t, { demoteFirst: tAdmin });
      if (r.ok) {
        DB.del(`warns.${ctx.chat}.${t}`);
        return ctx.reply(`@${numJ(t)} has been removed from this group.\nReason: Reached 3/3 warnings. Last reason: ${reason}`, { mentions: [t] });
      }
      return ctx.reply(`⚠️ @${numJ(t)} reached 3/3 warnings, but removal failed: ${participantErrText(r.code, 'remove') || 'unknown error'}`, { mentions: [t] });
    }
    return ctx.reply(
      `⚠️ @${numJ(t)} You have been warned by an admin!\n📝 Reason: ${reason}\n⚠️ Warning ${w.count}/3\n\n` +
      (w.count === 2 ? '⚠️ One more warning and you will be removed!' : ''), { mentions: [t] }
    );
  }
});

async function promoteDemoteHandler(sock, m, args, ctx, action) {
  const t = resolveTargetUser(m, args);
  if (!t) return ctx.reply(`📌 Usage: ${ctx.prefix}${action} @user — or reply to their message`);
  if (t === SELF_JID) return ctx.reply('😅 I will not change my own role.');
  if (!(await isBotAdminJ(sock, ctx.chat))) return ctx.reply('❌ I must be a group admin to do that.');
  try {
    const res = await sock.groupParticipantsUpdate(ctx.chat, [t], action);
    const r = Array.isArray(res) ? res[0] : null;
    const code = r && r.code ? String(r.code) : 'unknown';
    if (code === '200') {
      invalidateMeta(ctx.chat);
      return ctx.reply(
        action === 'promote'
          ? `👑 @${numJ(t)} has been promoted to *admin*.`
          : `👤 @${numJ(t)} is no longer an *admin*.`, { mentions: [t] });
    }
    return ctx.reply(`❌ ${action} failed: ${participantErrText(code, action) || 'unknown error (' + code + ')'}\nℹ️ Note: WhatsApp may block this for the group creator/owner.`);
  } catch (e) {
    return ctx.reply(`❌ ${action} failed: ${e.message}`);
  }
}
defCmd({
  name: 'promote', cat: 'admin', section: 'admin', group: true,
  desc: 'Promote a member to admin', usage: '.promote @user',
  handler: (sock, m, args, ctx) => promoteDemoteHandler(sock, m, args, ctx, 'promote')
});
defCmd({
  name: 'demote', cat: 'admin', section: 'admin', group: true,
  desc: 'Demote an admin to member', usage: '.demote @user',
  handler: (sock, m, args, ctx) => promoteDemoteHandler(sock, m, args, ctx, 'demote')
});

async function closeOpenHandler(sock, m, args, ctx, close) {
  if (!(await isBotAdminJ(sock, ctx.chat))) return ctx.reply('❌ I must be a group admin to change group settings.');
  try {
    await sock.groupSettingUpdate(ctx.chat, close ? 'announcement' : 'not_announcement');
    // manual override: scheduler will not touch this group until next transition
    const hm = nowHMInTZ();
    const bm = DB.get('settings.botmanage', {});
    const prayer = bm.prayerEnabled ? await fetchPrayer() : null;
    DB.set(`settings.botmanage.overrides.${ctx.chat}`, nextTransitionMs(hm, prayer));
    return ctx.reply(close
      ? '🔒 Group *closed* — only admins can send messages now.\nℹ️ BotManage automation will not override this until the next scheduled transition.'
      : '🔓 Group *opened* — everyone can send messages now.\nℹ️ BotManage automation will not override this until the next scheduled transition.');
  } catch (e) {
    return ctx.reply(`❌ Failed to ${close ? 'close' : 'open'} the group: ${e.message}\nℹ️ This usually means I am not an admin.`);
  }
}
defCmd({
  name: 'close', cat: 'admin', section: 'admin', group: true,
  desc: 'Close the group (only admins can send)', usage: '.close',
  handler: (sock, m, args, ctx) => closeOpenHandler(sock, m, args, ctx, true)
});
defCmd({
  name: 'open', cat: 'admin', section: 'admin', group: true,
  desc: 'Open the group (everyone can send)', usage: '.open',
  handler: (sock, m, args, ctx) => closeOpenHandler(sock, m, args, ctx, false)
});

defCmd({
  name: 'tagall', cat: 'admin', section: 'admin', group: true,
  desc: 'Tag all members with an optional message',
  usage: '.tagall [message]',
  handler: async (sock, m, args, ctx) => {
    let meta;
    try { meta = await getMeta(sock, ctx.chat); } catch (e) { return ctx.reply('❌ Could not load group members.'); }
    const users = meta.participants.map((p) => normJ(p.id)).slice(0, 400);
    const custom = args.join(' ') || 'Attention everyone!';
    const text =
      `╭━━〔 📣 TAGALL 〕━━╮\n` +
      `💬 ${custom}\n\n` +
      users.map((u) => `@${numJ(u)}`).join(' ') +
      `\n╰━━━━━━━━━━━━━━━━━━━━╯`;
    return ctx.reply(text, { mentions: users });
  }
});

defCmd({
  name: 'admintag', cat: 'admin', section: 'admin', group: true,
  desc: 'Tag only the group admins',
  usage: '.admintag [message]',
  handler: async (sock, m, args, ctx) => {
    let meta;
    try { meta = await getMeta(sock, ctx.chat); } catch (e) { return ctx.reply('❌ Could not load group admins.'); }
    const admins = meta.participants
      .filter((p) => p.admin === 'admin' || p.admin === 'superadmin')
      .map((p) => normJ(p.id));
    if (!admins.length) return ctx.reply('ℹ️ No admins found.');
    const custom = args.join(' ') || 'Message for the admins!';
    const text =
      `╭━━〔 🛡️ ADMINTAG 〕━━╮\n` +
      `💬 ${custom}\n\n` +
      admins.map((u) => `@${numJ(u)}`).join(' ') +
      `\n╰━━━━━━━━━━━━━━━━━━━━╯`;
    return ctx.reply(text, { mentions: admins });
  }
});

function topRankingHandler(sock, m, args, ctx) {
  const act = DB.get(`activity.${ctx.chat}`, {});
  const entries = Object.entries(act).sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (!entries.length) {
    return ctx.reply(`📊 No activity recorded yet.\nℹ️ Metric: message counts the bot has actually seen in this group (persistent).`);
  }
  const medals = ['🥇', '🥈', '🥉'];
  const lines = entries.map(([u, n], i) => `${medals[i] || ` ${i + 1}.`} @${numJ(u)} — ${n} msgs`);
  return ctx.reply(
    `╭━━〔 🏆 TOP CHATTERS 〕━━╮\n` +
    lines.join('\n') +
    `\n╰━━━━━━━━━━━━━━━━━━━━╯\n` +
    `ℹ️ Metric: messages the bot has seen here since tracking started.`, { mentions: entries.map(([u]) => u) });
}
defCmd({
  name: 'top', cat: 'admin', section: 'admin', group: true,
  desc: 'Top 10 most active members (by messages the bot has seen)', usage: '.top',
  handler: topRankingHandler
});
defCmd({
  name: 'ranking', aliases: ['rank'], cat: 'admin', section: 'admin', group: true,
  desc: 'Alias of .top — activity ranking', usage: '.ranking',
  handler: topRankingHandler
});

defCmd({
  name: 'gcowner', cat: 'admin', section: 'group', group: true,
  desc: 'Show the group creator/owner', usage: '.gcowner',
  handler: async (sock, m, args, ctx) => {
    let meta;
    try { meta = await getMeta(sock, ctx.chat); } catch (e) { return ctx.reply('❌ Could not load group info.'); }
    if (!meta.owner) return ctx.reply('ℹ️ The library did not expose the group creator for this group.');
    return ctx.reply(`👑 Group owner: ${getName(meta.owner)}\n📱 @${numJ(meta.owner)}\n👥 Group: ${meta.subject}`, { mentions: [meta.owner] });
  }
});

defCmd({
  name: 'welcome', cat: 'admin', section: 'auto', group: true,
  desc: 'Toggle welcome messages for this group', usage: '.welcome on | off | status',
  handler: async (sock, m, args, ctx) => {
    const g = getGroupCfg(ctx.chat);
    const sub = (args[0] || 'status').toLowerCase();
    if (sub === 'on' || sub === 'off') {
      g.welcome.enabled = sub === 'on';
      DB.scheduleSave();
      return ctx.reply(`✅ Welcome messages: *${sub.toUpperCase()}*${sub === 'on' ? '\nℹ️ Customize: ' + ctx.prefix + 'setwelcome <text> (placeholders: @user @group @count)' : ''}`);
    }
    return ctx.reply(`👋 Welcome: ${g.welcome.enabled ? 'ON' : 'OFF'}\n📝 Message: ${g.welcome.message}`);
  }
});

defCmd({
  name: 'goodbye', cat: 'admin', section: 'auto', group: true,
  desc: 'Toggle goodbye messages for this group', usage: '.goodbye on | off | status',
  handler: async (sock, m, args, ctx) => {
    const g = getGroupCfg(ctx.chat);
    const sub = (args[0] || 'status').toLowerCase();
    if (sub === 'on' || sub === 'off') {
      g.goodbye.enabled = sub === 'on';
      DB.scheduleSave();
      return ctx.reply(`✅ Goodbye messages: *${sub.toUpperCase()}*${sub === 'on' ? '\nℹ️ Customize: ' + ctx.prefix + 'setgoodbye <text> (placeholders: @user @group @count)' : ''}`);
    }
    return ctx.reply(`👋 Goodbye: ${g.goodbye.enabled ? 'ON' : 'OFF'}\n📝 Message: ${g.goodbye.message}`);
  }
});

defCmd({
  name: 'setwelcome', cat: 'admin', section: 'auto', group: true,
  desc: 'Set this group welcome text (placeholders: @user @group @count)',
  usage: '.setwelcome <message>',
  handler: async (sock, m, args, ctx) => {
    const g = getGroupCfg(ctx.chat);
    if (!args.length) {
      return ctx.reply(`📝 Current welcome message:\n─────────────\n${g.welcome.message}\n─────────────\n📌 Usage: ${ctx.prefix}setwelcome <message>\nPlaceholders: @user @group @count\nExample: ${ctx.prefix}setwelcome Welcome @user! Have fun in @group. Members: @count`);
    }
    const text = args.join(' ').slice(0, 1000);
    g.welcome.message = text;
    DB.scheduleSave();
    return ctx.reply(`✅ Welcome message saved for this group.\n─────────────\n${replacePlaceholders(text, { userNum: numJ(ctx.sender), groupName: 'This Group', count: 'N' })}\n─────────────\nℹ️ Make sure .welcome is ON.`);
  }
});

defCmd({
  name: 'setgoodbye', cat: 'admin', section: 'auto', group: true,
  desc: 'Set this group goodbye text (placeholders: @user @group @count)',
  usage: '.setgoodbye <message>',
  handler: async (sock, m, args, ctx) => {
    const g = getGroupCfg(ctx.chat);
    if (!args.length) {
      return ctx.reply(`📝 Current goodbye message:\n─────────────\n${g.goodbye.message}\n─────────────\n📌 Usage: ${ctx.prefix}setgoodbye <message>\nPlaceholders: @user @group @count`);
    }
    const text = args.join(' ').slice(0, 1000);
    g.goodbye.message = text;
    DB.scheduleSave();
    return ctx.reply(`✅ Goodbye message saved for this group.\n─────────────\n${replacePlaceholders(text, { userNum: numJ(ctx.sender), groupName: 'This Group', count: 'N' })}\n─────────────\nℹ️ Make sure .goodbye is ON.`);
  }
});

/* ═════════════ SECTION 18: MENU (auto-synced with the registry) ═════════ */
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
    `┃ 🔗 Pair Bot: ${String(CONFIG.pairingSite).replace('https://', '')}`,
    '╰━━━━━━━━━━━━━━━━━━━━╯'
  ].join('\n');
  const body = SECTIONS.map((sec) => {
    const names = Object.values(REG).filter((c) => c.section === sec.key).map((c) => p + c.name);
    if (!names.length) return '';
    const rows = [];
    for (let i = 0; i < names.length; i += 3) rows.push('┃ ' + names.slice(i, i + 3).join('  •  '));
    return `┏━━〔 ${sec.title} 〕━━┓\n${rows.join('\n')}\n┗━━━━━━━━━━━━━━━━━━━┛`;
  }).filter(Boolean).join('\n\n');
  const foot = `\nℹ️ কমান্ড ডিটেইলস: ${p}help <command>\n💡 AutoReply চালু করতে (owner): ${p}autoreply on`;
  return `${head}\n\n${body}\n${foot}`;
}

/* ═════════════ SECTION 19: COMMAND DISPATCHER (security core) ═══════════
   Permission checks happen HERE, before any handler runs. Hiding commands
   from the menu is never the security mechanism. */
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
  if (!cmd) {
    if (!isGroupChat(chat)) {
      await sendT(sock, chat, `❌ Unknown command: ${prefix}${typed}\nSee the full list: ${prefix}menu`);
    }
    return;
  }

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

  // 1) MODE gate — self: owner only; private: private chats (owner exempt)
  const mode = DB.get('mode', 'public');
  if (mode === 'self' && !ctx.isOwner) return;
  if (mode === 'private' && isGrp && !ctx.isOwner) return;

  // 2) ROLE gate — real enforcement, not menu-hiding
  if (!canUseCmd(cmd, ctx)) {
    await ctx.reply('⛔ You do not have permission to use this command.');
    return;
  }

  // 3) GROUP-ONLY gate — never silently pick an arbitrary group
  if (cmd.group && !isGrp) {
    await ctx.reply(`ℹ️ *${prefix}${cmd.name}* works inside a group.\nOpen the target group and send it there.`);
    return;
  }

  try {
    await cmd.handler(sock, m, args, ctx);
  } catch (e) {
    console.error(`[CMD] ${resolved} failed:`, e.message);
    await ctx.reply(`❌ Command error: ${e.message}`).catch(() => {});
  }
}

/* ═════════════ SECTION 20: INCOMING MESSAGE PIPELINE ════════════════════ */
async function processMessages(sock, upsert) {
  const { messages, type } = upsert;
  const isNotify = type === 'notify';
  for (const m of messages || []) {
    if (!m || !m.key || !m.key.id) continue;
    const chat = m.key.remoteJid;
    if (!chat) continue;

    // antidelete: cache everything the bot legitimately receives (not status)
    if (chat !== 'status@broadcast' && m.message) {
      cacheIncoming(sock, m).catch((e) => console.error('[CACHE]', e.message));
    }

    if (chat === 'status@broadcast') {
      if (isNotify) onStatusBroadcast(sock, m).catch(() => {});
      continue;
    }

    const msg = unwrapMsg(m.message);
    if (!msg) continue;
    const ctype = getContentType(msg);

    // revocation delivered as a protocol message inside upsert
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

    if (!isNotify) continue; // history-sync 'append' messages: cache only, no actions

    // activity tracking (groups, everyone except the bot itself)
    if (isGroupChat(chat) && !m.key.fromMe && sender) {
      const cur = DB.get(`activity.${chat}.${sender}`, 0) || 0;
      DB.set(`activity.${chat}.${sender}`, cur + 1);
    }

    // anti systems (group only; owner/bot protected inside; admin policy inside)
    if (isGroupChat(chat)) {
      const handled = await runAntiSystems(sock, m, chat, sender);
      if (handled) continue;
    }

    await autoRevealViewOnce(sock, m).catch(() => {});
    await tryAutoReply(sock, m, chat, sender, text, mentions).catch(() => {});
    if (text) await dispatch(sock, m, text);
  }
}

/* ═════════════ SECTION 21: TELEGRAM PAIRING BRIDGE (optional) ═══════════
   Activates ONLY when telegram.token is set in config.json. Uses the
   official Bot API with long polling — no extra dependencies. */
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
            this.handle(upd).catch((e) => console.error('[TELEGRAM-H]', e.message));
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
      if (text.startsWith('/')) {
        await this.send(chatId, `⛔ Pairing is locked.\nYour Telegram ID: ${from}\nPut it into config.json → telegram.ownerId and restart the bot.`);
      }
      return;
    }
    if (from !== this.ownerId) {
      await this.send(chatId, '⛔ You are not authorized to use this pairing bot.');
      return;
    }
    const [cmdRaw, ...rest] = text.split(/\s+/);
    const cmd = (cmdRaw || '').toLowerCase().split('@')[0];
    if (cmd === '/start' || cmd === '/help') {
      await this.send(chatId, [
        '🤖 *JISAN BOTX — Telegram Pairing Bridge*',
        '',
        '/pair <number> — request a WhatsApp pairing code',
        '/code — resend the last pairing code',
        '/status — connection status',
        '/id — show your Telegram ID',
        '',
        '🔐 Only the configured owner can pair.'
      ].join('\n'));
      return;
    }
    if (cmd === '/id') { await this.send(chatId, `Your Telegram ID: ${from}`); return; }
    if (cmd === '/status') {
      const paired = !!(CURRENT_SOCK && CURRENT_SOCK.authState && CURRENT_SOCK.authState.creds && CURRENT_SOCK.authState.creds.registered);
      const conn = SELF_JID ? `Connected (+${numJ(SELF_JID)})` : (paired ? 'Registered, connecting…' : 'Not paired');
      await this.send(chatId, `🟢 WhatsApp: ${conn}\n⚡ Prefix: ${DB.get('prefix', '.')}\n📦 Version: ${VERSION}\n🔐 Last code: ${PAIR_STATE.lastCode || '—'}`);
      return;
    }
    if (cmd === '/code') {
      if (!PAIR_STATE.lastCode) return this.send(chatId, 'ℹ️ No pairing code yet. Use /pair <number>.');
      return this.send(chatId, `🔐 Pairing code: ${PAIR_STATE.lastCode}\nWhatsApp → Settings → Linked Devices → Link with phone number instead.`);
    }
    if (cmd === '/pair') {
      const digits = (rest[0] || '').replace(/[^0-9]/g, '');
      if (digits.length < 8) return this.send(chatId, '📌 Usage: /pair 8801XXXXXXXXX (country code + number, digits only)');
      if (SELF_JID) return this.send(chatId, `✅ Bot already connected as +${numJ(SELF_JID)}. Unlink that device from WhatsApp first to re-pair.`);
      PAIR_STATE.number = digits;
      PAIR_STATE.requested = false;
      if (CURRENT_SOCK && !CURRENT_SOCK.authState.creds.registered) {
        try {
          const raw = await CURRENT_SOCK.requestPairingCode(digits);
          PAIR_STATE.requested = true;
          PAIR_STATE.lastCode = fmtPairCode(raw);
          return this.send(chatId, `🔐 Pairing code: ${PAIR_STATE.lastCode}\n📱 Number: +${digits}\n\nWhatsApp → Settings → Linked Devices → Link a Device → Link with phone number instead.`);
        } catch (e) {
          return this.send(chatId, `❌ Pairing request failed: ${e.message}\nThe socket will retry automatically.`);
        }
      }
      return this.send(chatId, '⏳ Number saved. The code will be sent as soon as the WhatsApp socket is ready.');
    }
  }
}

/* ═════════════ SECTION 22: CONNECTION MANAGER ═══════════════════════════ */
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
  const answer = await new Promise((res) => PAIR_STATE.rl.question('📲 Pairing number (country code + number, digits only, e.g. 8801XXXXXXXXX): ', res));
  const digits = String(answer).replace(/[^0-9]/g, '');
  if (digits.length < 8) { console.error('[PAIR] Invalid number. Restart the bot to try again.'); return null; }
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
        console.log('\n════════════════════════════════════════════════');
        console.log(`  JISAN BOTX  PAIRING CODE : ${PAIR_STATE.lastCode}`);
        console.log(`  Number : +${number}`);
        console.log('  WhatsApp → Settings → Linked Devices →');
        console.log('  Link a Device → Link with phone number instead');
        console.log('════════════════════════════════════════════════\n');
        if (TG) TG.push(`🔐 JISAN BOTX pairing code: ${PAIR_STATE.lastCode}\n📱 Number: +${number}\n\nWhatsApp → Settings → Linked Devices → Link with phone number instead.`);
      } catch (e) {
        PAIR_STATE.requested = false;
        console.error('[PAIR] requestPairingCode failed:', e.message);
      }
    }
  }

  if (connection === 'open') {
    SELF_JID = normJ(sock.user.id);
    RECONNECT_TRIES = 0;
    if (!numJ(DB.get('owner.number', ''))) {
      DB.set('owner.number', numJ(SELF_JID)); // authenticated account = owner identity
    }
    rememberName(SELF_JID, CONFIG.ownerName);
    console.log(`[CONNECTED] +${numJ(SELF_JID)} | prefix: ${DB.get('prefix', '.')} | mode: ${DB.get('mode', 'public')} | commands: ${Object.keys(REG).length}`);
    if (!HAS_ANNOUNCED) {
      HAS_ANNOUNCED = true; // sent once per process — no repeated connect spam
      const dest = ownerChatJ();
      if (dest) {
        await sendT(sock, dest,
          `╭━━〔 JISAN BOTX 〕━━╮\n` +
          `✅ Bot Connected Successfully!\n` +
          `👑 Owner: ${CONFIG.ownerName}\n` +
          `📱 Connected Number: +${numJ(SELF_JID)}\n` +
          `⚡ Prefix: ${DB.get('prefix', '.')}\n` +
          `📦 Version: ${VERSION}\n` +
          `🟢 Status: Online\n` +
          `╰━━━━━━━━━━━━━━━━━━━━╯`);
      }
    }
    startScheduler(sock);
    if (!TG) { TG = new TgBridge(); TG.start(); }
  }

  if (connection === 'close') {
    const code = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output
      ? lastDisconnect.error.output.statusCode : null;
    if (code === DisconnectReason.loggedOut) {
      console.error('[SESSION] Logged out. Session cleared — restart the bot and pair again.');
      try { fs.rmSync(path.join(ROOT, CONFIG.sessionDir || 'session'), { recursive: true, force: true }); } catch {}
      process.exit(1);
    }
    if (code === DisconnectReason.connectionReplaced) {
      console.error('[SESSION] Connection replaced by a new session elsewhere. Not reconnecting.');
      return;
    }
    RECONNECT_TRIES++;
    const delay = Math.min(60000, 2000 * RECONNECT_TRIES);
    console.log(`[RECONNECT] closed (code ${code}). Retry #${RECONNECT_TRIES} in ${Math.round(delay / 1000)}s…`);
    if (RECONNECT_TIMER) clearTimeout(RECONNECT_TIMER);
    RECONNECT_TIMER = setTimeout(() => {
      startBot().catch((e) => console.error('[START]', e.message));
    }, delay);
  }
}

/** Start (or restart) the bot. A NEW socket is created each time and all
 *  event listeners attach to that socket only — so reconnects can never
 *  create duplicate handlers. */
async function startBot() {
  initStorage();
  let version;
  try { version = await fetchLatestBaileysVersion(); } catch { version = undefined; }
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
    getMessage: async () => null // bounded cache; Baileys retry uses its own queue
  });
  CURRENT_SOCK = sock;

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (u) => onConnectionUpdate(sock, u).catch((e) => console.error('[CONN]', e.message)));
  sock.ev.on('messages.upsert', (up) => processMessages(sock, up).catch((e) => console.error('[MSGS]', e.message)));
  sock.ev.on('messages.update', (updates) => {
    for (const up of updates || []) {
      if (up && up.update && up.update.message === null && up.key) {
        handleRevoke(sock, up.key, Date.now()).catch((e) => console.error('[REVOKE]', e.message));
      }
    }
  });
  sock.ev.on('group-participants.update', (upd) => onParticipantsUpdate(sock, upd).catch((e) => console.error('[PART]', e.message)));
  sock.ev.on('groups.update', (ups) => { for (const _ of ups || []) { /* metadata TTL handles refresh */ } });
  return sock;
}

/* ═══════════════════ SECTION 23: STARTUP & GUARDS ═══════════════════════ */
function printBanner() {
  console.log(`
╔══════════════════════════════════════════╗
║          𝙹𝙸𝚂𝙰𝙽 𝙱𝙾𝚃𝚇  v${VERSION}            ║
║   Owner: Ahmed Jisan | Baileys MD 6.7.x   ║
╚══════════════════════════════════════════╝
Node: ${process.versions.node} | TZ: ${CONFIG.timezone} | Prefix: ${DB ? DB.get('prefix', '.') : CONFIG.prefix}
`);
}

function registerGlobalGuards() {
  process.on('uncaughtException', (e) => console.error('[UNCAUGHT]', e.message));
  process.on('unhandledRejection', (e) => console.error('[UNHANDLED]', e && e.message ? e.message : e));
}

function main() {
  const major = parseInt(process.versions.node, 10);
  if (major < 18) {
    console.error(`❌ Node.js 18+ required (20 LTS recommended). Current: ${process.versions.node}`);
    process.exit(1);
  }
  initStorage();
  printBanner();
  registerGlobalGuards();
  CLEANER_TIMER = startCacheCleaner();
  startBot().catch((e) => {
    console.error('[FATAL]', e.message);
    process.exit(1);
  });
}

if (require.main === module) {
  main();
}

/* Exports for testing / embedding (no auto-start when required) */
module.exports = {
  JDB, initStorage, CONFIG, deepMerge,
  parseHM, inWin, nowHMInTZ, minutesToHM, todayStr,
  computeDesiredState, nextTransitionMs, fetchPrayer, prayerWindows,
  replacePlaceholders, pickRandom, fmtPairCode,
  antiWarnText, ANTI_NOUNS, AUTOREPLY_LINES,
  REG, REG_ALIASES, SECTIONS, defCmd, canUseCmd, SUDO_BLOCKED,
  buildMenu, dispatch, processMessages, startBot
};
