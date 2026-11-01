// server.js — ҜIRΔ βUILDΣR βΩT
// Point d'entrée : DB JSON, serveur Express (keep-alive), démarrage du bot Telegram mère.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const crypto = require('crypto');
const axios = require('axios');

// ───────────────────────────────────────────
// CONFIG
// ───────────────────────────────────────────
const CONFIG = {
  BOT_NAME: 'ҜIRΔ βUILDΣR βΩT 🌐',
  AUTHOR: '⫸ 𝐌𝐫 𝐊𝐈𝐑𝐀 ┃ 𝗧𝗘𝗖𝗛 🌐 ⫷',
  BOT_USERNAME: '@Kira_builder_bot',
  BOT_LINK: 'https://t.me/Kira_builder_bot',
  PREFIX: '.',
  IMAGES: {
    profile: 'https://i.ibb.co/mVsjwmyP/3-E8645-DC-2-F6-D-4537-B20-A-7-AB8-E05-ED051.jpg',
    start: 'https://i.ibb.co/bj7PZsvr/5-F3656-DB-0-E7-A-4-DD4-91-D3-3-FC863-AF546-C.jpg',
    link: 'https://i.ibb.co/DDBk2NNT/56824-E08-B4-EF-450-E-AAD6-CCFA986-D906-C.jpg',
    everybot: 'https://i.ibb.co/wFbVFkwX/79-E7-F3-CE-4060-4-F2-B-9-F87-28-BA712-ACBF7.jpg',
    welcome: 'https://i.ibb.co/23r50Phd/99-AA005-F-5704-483-C-AFB9-89-EFD1887138.jpg'
  },
  LINKS: {
    channelTG: 'https://t.me/+mQ3aQpCsEqI0YmY0',
    group1TG: 'https://t.me/+2JDC_Be4_ww1N2Vk',
    group2TG: 'https://t.me/+Z-P_xjUgJjU0MjM0',
    channelWA: 'https://whatsapp.com/channel/0029Vb7WJzp84OmBD0fEEJ2X',
    groupWA: 'https://chat.whatsapp.com/IP0nFB79rMDF0nvFSMXtDR',
    support: '@KIRA_SUPPORT_HUB'
  },
  KIRA_DEV_CODE: process.env.KIRA_DEV_CODE || 'Kira25',
  GROUP2_ID: process.env.GROUP2_ID || null,
  FREE_BOT_LIMIT: 2,
  TRIES_DEFAULT: 3
};

// ───────────────────────────────────────────
// DB (JSON file, chargée en mémoire + sauvegardée à chaque écriture)
// ───────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'data', 'db.json');
const SESSIONS_DIR = path.join(__dirname, 'sessions');

function ensureDirs() {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function defaultDB() {
  return {
    users: {},
    bots: {},
    promoCodes: {},
    stats: { totalMessages: 0, totalBots: 0, totalPairs: 0 }
  };
}

let db;
function loadDB() {
  ensureDirs();
  if (!fs.existsSync(DB_PATH)) {
    db = defaultDB();
    saveDB();
  } else {
    try {
      db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
    } catch (e) {
      console.error('[DB] Fichier corrompu, recréation :', e.message);
      db = defaultDB();
      saveDB();
    }
  }
  return db;
}

let saveTimer = null;
function saveDB() {
  // debounce léger pour éviter d'écrire sur disque à chaque micro-opération
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
  }, 150);
}

function getUser(telegramId, meta = {}) {
  const id = String(telegramId);
  if (!db.users[id]) {
    db.users[id] = {
      username: meta.username || null,
      firstName: meta.firstName || null,
      triesLeft: CONFIG.TRIES_DEFAULT,
      isPremium: false,
      premiumUntil: null,
      createdAt: Date.now()
    };
    saveDB();
  } else if (meta.username || meta.firstName) {
    db.users[id].username = meta.username || db.users[id].username;
    db.users[id].firstName = meta.firstName || db.users[id].firstName;
  }
  return db.users[id];
}

function userBotCount(telegramId) {
  return Object.values(db.bots).filter(b => b.ownerTelegramId === String(telegramId)).length;
}

function isUserPremiumActive(telegramId) {
  const u = getUser(telegramId);
  if (!u.isPremium) return false;
  if (u.premiumUntil && Date.now() > u.premiumUntil) {
    u.isPremium = false;
    u.premiumUntil = null;
    saveDB();
    return false;
  }
  return true;
}

function createBot({ ownerTelegramId, ownerUsername, name, description, imageUrl, commands }) {
  const id = crypto.randomBytes(6).toString('hex');
  db.bots[id] = {
    id,
    ownerTelegramId: String(ownerTelegramId),
    ownerUsername: ownerUsername || null,
    name,
    description: description || '',
    imageUrl: imageUrl || CONFIG.IMAGES.profile,
    commands: commands || [],
    banned: false,
    waSession: { paired: false, phone: null, connectedAt: null },
    createdAt: Date.now()
  };
  db.stats.totalBots += 1;
  saveDB();
  return db.bots[id];
}

function getBot(botId) {
  return db.bots[botId];
}

function userBots(telegramId) {
  return Object.values(db.bots).filter(b => b.ownerTelegramId === String(telegramId));
}

function deleteBot(botId) {
  delete db.bots[botId];
  const sessPath = path.join(SESSIONS_DIR, botId);
  if (fs.existsSync(sessPath)) fs.rmSync(sessPath, { recursive: true, force: true });
  saveDB();
}

function createPromoCode(code, { usesLeft = Infinity, ttlMs = 10 * 60 * 1000 } = {}) {
  db.promoCodes[code] = {
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    usedBy: [],
    usesLeft,
    premiumGranted: true
  };
  saveDB();
  return db.promoCodes[code];
}

function redeemPromoCode(code, telegramId) {
  const entry = db.promoCodes[code];
  if (!entry) return { ok: false, reason: 'notfound' };
  if (Date.now() > entry.expiresAt) return { ok: false, reason: 'expired' };
  if (entry.usedBy.includes(String(telegramId))) return { ok: false, reason: 'already' };
  if (entry.usesLeft <= 0) return { ok: false, reason: 'exhausted' };

  entry.usedBy.push(String(telegramId));
  if (entry.usesLeft !== Infinity) entry.usesLeft -= 1;

  const u = getUser(telegramId);
  u.triesLeft += 3;
  u.isPremium = true;
  u.premiumUntil = Date.now() + 10 * 60 * 1000; // 10 min comme spécifié
  saveDB();
  return { ok: true };
}

// ───────────────────────────────────────────
// BOOTSTRAP
// ───────────────────────────────────────────
loadDB();

const dbApi = {
  CONFIG,
  SESSIONS_DIR,
  db: () => db,
  saveDB,
  getUser,
  userBotCount,
  isUserPremiumActive,
  createBot,
  getBot,
  userBots,
  deleteBot,
  createPromoCode,
  redeemPromoCode
};

const { initTelegramBot } = require('./telegram.js');
const { initWhatsAppManager } = require('./whatsapp.js');

const waManager = initWhatsAppManager(dbApi);
const bot = initTelegramBot(dbApi, waManager);

// ───────────────────────────────────────────
// EXPRESS (keep-alive pour Render/VPS)
// ───────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    bot: CONFIG.BOT_NAME,
    totalBots: Object.keys(db.bots).length,
    totalUsers: Object.keys(db.users).length,
    uptime: process.uptime()
  });
});

app.listen(PORT, () => {
  console.log(`[HTTP] Serveur keep-alive actif sur le port ${PORT}`);
});

// ───────────────────────────────────────────
// SELF-PING — empêche Render Free de mettre le service en veille.
// RENDER_EXTERNAL_URL est injectée automatiquement par Render.
// En local / autre hébergeur, définis SELF_URL dans .env pour activer ça.
// ───────────────────────────────────────────
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL;
if (SELF_URL) {
  const PING_INTERVAL_MS = 10 * 60 * 1000; // 10 min (Render endort après 15 min d'inactivité)
  setInterval(() => {
    axios.get(SELF_URL).catch((e) => console.error('[PING] self-ping échoué :', e.message));
  }, PING_INTERVAL_MS);
  console.log(`[PING] Self-ping activé toutes les ${PING_INTERVAL_MS / 60000} min vers ${SELF_URL}`);
} else {
  console.warn('[PING] Aucune URL détectée (RENDER_EXTERNAL_URL/SELF_URL) — le service va s\'endormir sur Render Free.');
}

bot.launch().then(() => {
  console.log(`[TELEGRAM] ${CONFIG.BOT_NAME} démarré.`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
    
