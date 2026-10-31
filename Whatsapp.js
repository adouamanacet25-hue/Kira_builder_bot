// whatsapp.js — ҜIRΔ βUILDΣR βΩT
// Gère les bots WhatsApp enfants (Baileys) : pairing code, connexion, commandes.

const path = require('path');
const fs = require('fs');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');

const BAILEYS_BROWSER = ['Kira Builder', 'Chrome', '1.0.0'];

function initWhatsAppManager(dbApi) {
  const { CONFIG, SESSIONS_DIR, getBot, saveDB, db } = dbApi;

  // botId -> { sock, saveCreds, pairingResolvers: [] }
  const sockets = new Map();
  // botId -> telegramId du créateur en attente de notification de connexion
  const pendingNotify = new Map();

  function fmtDate() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} / ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  }

  // ─────────────────────────────────────
  // CRÉATION / CONNEXION D'UN SOCKET BOT
  // ─────────────────────────────────────
  async function startBotSocket(botId, { onPairingCode, onConnected, onDisconnected } = {}) {
    const sessionPath = path.join(SESSIONS_DIR, botId);
    if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: BAILEYS_BROWSER,
      logger: pino({ level: 'silent' })
    });

    sockets.set(botId, { sock, saveCreds });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        const botRecord = getBot(botId);
        if (botRecord) {
          botRecord.waSession.paired = true;
          botRecord.waSession.phone = sock.user && sock.user.id ? sock.user.id.split(':')[0] : null;
          botRecord.waSession.connectedAt = Date.now();
          db().stats.totalPairs += 1;
          saveDB();
        }
        if (onConnected) onConnected(botId);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect && lastDisconnect.error
          ? new Boom(lastDisconnect.error).output.statusCode
          : null;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        if (loggedOut) {
          const botRecord = getBot(botId);
          if (botRecord) {
            botRecord.waSession.paired = false;
            botRecord.waSession.phone = null;
            saveDB();
          }
          sockets.delete(botId);
          if (onDisconnected) onDisconnected(botId, 'loggedout');
        } else {
          // reconnexion avec backoff simple
          sockets.delete(botId);
          setTimeout(() => {
            startBotSocket(botId, { onPairingCode, onConnected, onDisconnected }).catch((e) =>
              console.error(`[WA:${botId}] reconnexion échouée :`, e.message)
            );
          }, 3000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;
      await handleIncomingMessage(botId, sock, msg).catch((e) =>
        console.error(`[WA:${botId}] erreur handler message :`, e.message)
      );
    });

    // Déclenche le pairing code si pas encore enregistré
    if (!sock.authState.creds.registered && onPairingCode) {
      await new Promise((r) => setTimeout(r, 1500));
      onPairingCode(sock);
    }

    return sock;
  }

  async function requestPairing(botId, phoneNumber) {
    return new Promise((resolve, reject) => {
      startBotSocket(botId, {
        onPairingCode: async (sock) => {
          try {
            const code = await sock.requestPairingCode(phoneNumber);
            resolve(code);
          } catch (e) {
            reject(e);
          }
        },
        onConnected: (id) => {
          const cb = pendingNotify.get(id);
          if (cb) {
            cb();
            pendingNotify.delete(id);
          }
        }
      }).catch(reject);
    });
  }

  function onceConnected(botId, callback) {
    pendingNotify.set(botId, callback);
  }

  async function unpairBot(botId) {
    const entry = sockets.get(botId);
    if (entry) {
      try {
        await entry.sock.logout();
      } catch (_) {
        /* ignore */
      }
      sockets.delete(botId);
    }
    const botRecord = getBot(botId);
    if (botRecord) {
      botRecord.waSession.paired = false;
      botRecord.waSession.phone = null;
      saveDB();
    }
    const sessionPath = path.join(SESSIONS_DIR, botId);
    if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
  }

  function isConnected(botId) {
    return sockets.has(botId) && getBot(botId) && getBot(botId).waSession.paired;
  }

  async function reconnectAllPairedBots() {
    const all = Object.values(db().bots).filter((b) => b.waSession.paired);
    for (const b of all) {
      startBotSocket(b.id).catch((e) =>
        console.error(`[WA:${b.id}] reconnexion au démarrage échouée :`, e.message)
      );
    }
  }
  reconnectAllPairedBots();

  // ─────────────────────────────────────
  // COMMANDES WHATSAPP (handlers réels)
  // ─────────────────────────────────────
  // Chaque handler reçoit (ctx) = { sock, msg, jid, sender, args, text, isGroup, botRecord, botId }
  const commandHandlers = {
    // 📘 GÉNÉRAL
    menu: async (ctx) => sendChildMenu(ctx),
    help: async (ctx) => sendChildMenu(ctx),
    ping: async (ctx) => {
      const start = Date.now();
      const sent = await ctx.sock.sendMessage(ctx.jid, { text: '🏓 Calcul...' });
      const latency = Date.now() - start;
      await ctx.sock.sendMessage(ctx.jid, { text: `🏓 Pong ! Latence : ${latency} ms` }, { quoted: sent });
    },
    uptime: async (ctx) => {
      const s = Math.floor(process.uptime());
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      await ctx.sock.sendMessage(ctx.jid, { text: `⏱️ Uptime : ${h}h ${m}m ${sec}s` });
    },
    runtime: async (ctx) => commandHandlers.uptime(ctx),
    owner: async (ctx) => {
      await ctx.sock.sendMessage(ctx.jid, {
        text: `👤 Auteur du bot : @${ctx.botRecord.ownerUsername || 'inconnu'}`
      });
    },
    about: async (ctx) => {
      await ctx.sock.sendMessage(ctx.jid, {
        text: `🤖 ${ctx.botRecord.name}\n${ctx.botRecord.description || ''}\n⚡ Propulsé par Mr Kira Tech 🌐`
      });
    },
    id: async (ctx) => ctx.sock.sendMessage(ctx.jid, { text: `🆔 ${ctx.sender}` }),
    myid: async (ctx) => commandHandlers.id(ctx),
    status: async (ctx) => ctx.sock.sendMessage(ctx.jid, { text: '🟢 STATUS ➜ OPEN' }),

    // 👥 GROUPE
    tagall: async (ctx) => {
      if (!ctx.isGroup) return ctx.sock.sendMessage(ctx.jid, { text: '⚠️ Commande réservée aux groupes.' });
      const meta = await ctx.sock.groupMetadata(ctx.jid);
      const mentions = meta.participants.map((p) => p.id);
      const text = '📢 ' + mentions.map((id) => '@' + id.split('@')[0]).join(' ');
      await ctx.sock.sendMessage(ctx.jid, { text, mentions });
    },
    groupinfo: async (ctx) => {
      if (!ctx.isGroup) return ctx.sock.sendMessage(ctx.jid, { text: '⚠️ Commande réservée aux groupes.' });
      const meta = await ctx.sock.groupMetadata(ctx.jid);
      await ctx.sock.sendMessage(ctx.jid, {
        text: `👥 ${meta.subject}\n📝 ${meta.desc || 'Aucune description'}\n👤 Membres : ${meta.participants.length}`
      });
    },
    kick: async (ctx) => {
      if (!ctx.isGroup) return;
      const target = extractMentionedOrQuoted(ctx.msg);
      if (!target) return ctx.sock.sendMessage(ctx.jid, { text: '⚠️ Mentionne ou réponds à la personne à expulser.' });
      await ctx.sock.groupParticipantsUpdate(ctx.jid, [target], 'remove');
    },
    promote: async (ctx) => {
      if (!ctx.isGroup) return;
      const target = extractMentionedOrQuoted(ctx.msg);
      if (!target) return ctx.sock.sendMessage(ctx.jid, { text: '⚠️ Mentionne la personne à promouvoir.' });
      await ctx.sock.groupParticipantsUpdate(ctx.jid, [target], 'promote');
    },
    demote: async (ctx) => {
      if (!ctx.isGroup) return;
      const target = extractMentionedOrQuoted(ctx.msg);
      if (!target) return ctx.sock.sendMessage(ctx.jid, { text: '⚠️ Mentionne la personne à rétrograder.' });
      await ctx.sock.groupParticipantsUpdate(ctx.jid, [target], 'demote');
    },
    mute: async (ctx) => {
      if (!ctx.isGroup) return;
      await ctx.sock.groupSettingUpdate(ctx.jid, 'announcement');
      await ctx.sock.sendMessage(ctx.jid, { text: '🔇 Groupe mis en mode "admins seulement".' });
    },
    unmute: async (ctx) => {
      if (!ctx.isGroup) return;
      await ctx.sock.groupSettingUpdate(ctx.jid, 'not_announcement');
      await ctx.sock.sendMessage(ctx.jid, { text: '🔊 Tout le monde peut à nouveau écrire.' });
    },
    setname: async (ctx) => {
      if (!ctx.isGroup || !ctx.text) return;
      await ctx.sock.groupUpdateSubject(ctx.jid, ctx.text);
    },
    setdesc: async (ctx) => {
      if (!ctx.isGroup || !ctx.text) return;
      await ctx.sock.groupUpdateDescription(ctx.jid, ctx.text);
    },
    linkgc: async (ctx) => {
      if (!ctx.isGroup) return;
      const code = await ctx.sock.groupInviteCode(ctx.jid);
      await ctx.sock.sendMessage(ctx.jid, { text: `🔗 https://chat.whatsapp.com/${code}` });
    },
    revoke: async (ctx) => {
      if (!ctx.isGroup) return;
      await ctx.sock.groupRevokeInvite(ctx.jid);
      await ctx.sock.sendMessage(ctx.jid, { text: '♻️ Lien du groupe réinitialisé.' });
    },

    // 🎉 FUN
    dice: async (ctx) => ctx.sock.sendMessage(ctx.jid, { text: `🎲 ${Math.floor(Math.random() * 6) + 1}` }),
    coin: async (ctx) => ctx.sock.sendMessage(ctx.jid, { text: Math.random() < 0.5 ? '🪙 Pile' : '🪙 Face' }),
    '8ball': async (ctx) => {
      const answers = ['Oui', 'Non', 'Peut-être', 'Sans aucun doute', 'Je ne sais pas', 'Demande plus tard'];
      await ctx.sock.sendMessage(ctx.jid, { text: '🎱 ' + answers[Math.floor(Math.random() * answers.length)] });
    },
    truth: async (ctx) => {
      const list = [
        "Quel est ton plus grand secret ?",
        "Qui est ton crush actuel ?",
        "Quelle est la chose la plus gênante que tu aies faite ?"
      ];
      await ctx.sock.sendMessage(ctx.jid, { text: '🧠 Vérité : ' + list[Math.floor(Math.random() * list.length)] });
    },
    dare: async (ctx) => {
      const list = [
        "Envoie un emoji au hasard dans le groupe.",
        "Raconte une blague.",
        "Change ta photo de profil pour 10 minutes."
      ];
      await ctx.sock.sendMessage(ctx.jid, { text: '🎯 Action : ' + list[Math.floor(Math.random() * list.length)] });
    },
    joke: async (ctx) => {
      const list = [
        "Pourquoi les plongeurs plongent-ils toujours en arrière ? Parce que sinon ils tombent dans le bateau.",
        "Qu'est-ce qu'un crocodile qui surveille la pharmacie ? Un Lacoste garde."
      ];
      await ctx.sock.sendMessage(ctx.jid, { text: '😂 ' + list[Math.floor(Math.random() * list.length)] });
    }
  };

  function extractMentionedOrQuoted(msg) {
    const ctxInfo = msg.message?.extendedTextMessage?.contextInfo;
    if (ctxInfo?.mentionedJid?.length) return ctxInfo.mentionedJid[0];
    if (ctxInfo?.participant) return ctxInfo.participant;
    return null;
  }

  async function sendChildMenu(ctx) {
    const b = ctx.botRecord;
    const header =
      `▉ ${b.name} 🌹▉\n` +
      `✅ BOT ➜ Connecté 🤖\n` +
      `🟢 STATUS ➜ OPEN\n` +
      `📅 DATE ➜ ${fmtDate()}\n` +
      `▰▰▰▰▰▰▰▰▰▰\n` +
      `➠ Auteur : @${b.ownerUsername || 'inconnu'}\n` +
      `➠ Préfixe : [ ${CONFIG.PREFIX} ]\n` +
      `➠ Total Cmds : [ ${b.commands.length} ]\n`;

    const list = b.commands.length
      ? b.commands.map((c) => `• ${CONFIG.PREFIX}${c}`).join('\n')
      : '(aucune commande sélectionnée)';

    const footer = `\n\nEND…… 🌐\n\nPowered by Mr Kira Tech 🌐`;

    await ctx.sock.sendMessage(ctx.jid, { image: { url: b.imageUrl }, caption: header });
    await ctx.sock.sendMessage(ctx.jid, { text: list + footer });
    await ctx.sock.sendMessage(ctx.jid, { text: CONFIG.LINKS.channelWA });
  }

  // ─────────────────────────────────────
  // RÉCEPTION D'UN MESSAGE WHATSAPP
  // ─────────────────────────────────────
  async function handleIncomingMessage(botId, sock, msg) {
    const botRecord = getBot(botId);
    if (!botRecord) return;

    if (botRecord.banned) {
      const jid = msg.key.remoteJid;
      await sock.sendMessage(jid, {
        text: '⚠️ Erreur : ce bot a été banni du serveur. Contacte le support : ' + CONFIG.LINKS.support
      });
      return;
    }

    const jid = msg.key.remoteJid;
    const isGroup = jid.endsWith('@g.us');
    const sender = isGroup ? msg.key.participant : jid;

    const body =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      '';

    if (!body.startsWith(CONFIG.PREFIX)) return;

    const withoutPrefix = body.slice(CONFIG.PREFIX.length).trim();
    const [cmdRaw, ...args] = withoutPrefix.split(/\s+/);
    const cmd = (cmdRaw || '').toLowerCase();

    if (!botRecord.commands.includes(cmd)) return; // commande non activée pour ce bot
    const handler = commandHandlers[cmd];
    if (!handler) return;

    db().stats.totalMessages += 1;
    saveDB();

    await sock.sendMessage(jid, { react: { text: '📋', key: msg.key } }).catch(() => {});

    const ctx = {
      sock,
      msg,
      jid,
      sender,
      args,
      text: args.join(' '),
      isGroup,
      botRecord,
      botId
    };

    try {
      await handler(ctx);
    } catch (e) {
      console.error(`[WA:${botId}] erreur commande .${cmd} :`, e.message);
    }
  }

  // Liste des commandes disponibles (affichée lors de la sélection à la création)
  const AVAILABLE_COMMANDS = {
    'Général': ['menu', 'help', 'ping', 'uptime', 'runtime', 'owner', 'about', 'id', 'myid', 'status'],
    'Groupe': ['tagall', 'groupinfo', 'kick', 'promote', 'demote', 'mute', 'unmute', 'setname', 'setdesc', 'linkgc', 'revoke'],
    'Fun': ['dice', 'coin', '8ball', 'truth', 'dare', 'joke']
  };

  async function sendWelcomeMessage(botId) {
    const botRecord = getBot(botId);
    const entry = sockets.get(botId);
    if (!botRecord || !entry || !botRecord.waSession.phone) return;
    const jid = botRecord.waSession.phone + '@s.whatsapp.net';
    const text =
      `╔══════════════════════════╗\n` +
      `✅ BOT ➜ Connecté 🤖\n` +
      `🟢 STATUS ➜ OPEN\n` +
      `📅 DATE ➜ ${fmtDate()}\n` +
      `👤 Nom ➜ ${botRecord.name}\n` +
      `⚜️ Auteur ➜ @${botRecord.ownerUsername || 'inconnu'}\n` +
      `Tape : .menu pour continuer\n\n` +
      `⚜️ BY ➜ Mr Kira Tech ⚜️\n` +
      `╚══════════════════════════╝`;
    await entry.sock.sendMessage(jid, { image: { url: CONFIG.IMAGES.welcome }, caption: text }).catch(() => {});
  }

  return {
    requestPairing,
    onceConnected,
    unpairBot,
    isConnected,
    AVAILABLE_COMMANDS,
    sendWelcomeMessage
  };
}

module.exports = { initWhatsAppManager };
