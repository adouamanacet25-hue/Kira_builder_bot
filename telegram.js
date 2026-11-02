// telegram.js — ҜIRΔ βUILDΣR βΩT
// Bot Telegram "mère" : crée et lance des bots Telegram ENFANTS indépendants
// (chacun avec son propre token BotFather), qui gèrent eux-mêmes le pairing WhatsApp.

const { Telegraf, Markup } = require('telegraf');

function initTelegramBot(dbApi, waManager) {
  const {
    CONFIG,
    getUser,
    userBotCount,
    isUserPremiumActive,
    createBot,
    getBot,
    userBots,
    deleteBot,
    createPromoCode,
    redeemPromoCode,
    saveDB,
    db
  } = dbApi;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN manquant dans les variables d\'environnement.');

  const bot = new Telegraf(token);

  // botId -> instance Telegraf du bot ENFANT (chacun a son propre token/polling)
  const childBots = new Map();

  // État de saisie en cours, par utilisateur Telegram (en mémoire)
  const userState = new Map();
  function setState(id, state) { userState.set(String(id), state); }
  function getState(id) { return userState.get(String(id)); }
  function clearState(id) { userState.delete(String(id)); }

  function fmtDate() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} / ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  }

  // ─────────────────────────────────────
  // CLAVIERS
  // ─────────────────────────────────────
  const linksRows = [
    [Markup.button.url('🔵 📢 Suivre la chaîne Telegram', CONFIG.LINKS.channelTG)],
    [Markup.button.url('🟢 1️⃣ Rejoindre le groupe 1', CONFIG.LINKS.group1TG)],
    [Markup.button.url('🟢 2️⃣ Rejoindre le groupe 2', CONFIG.LINKS.group2TG)],
    [Markup.button.url('🟣 📢 Suivre la chaîne WhatsApp', CONFIG.LINKS.channelWA)],
    [Markup.button.url('🟠 🌐 Rejoindre le groupe WhatsApp', CONFIG.LINKS.groupWA)]
  ];
  const linksKeyboard = Markup.inlineKeyboard([...linksRows, [Markup.button.callback('🟡 ✅ Déjà rejoint', 'joined')]]);
  const linksKeyboardPlain = Markup.inlineKeyboard(linksRows);

  const afterJoinKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔵 ✍️ Créer un bot', 'create_bot')],
    [Markup.button.callback('🟢 🤖 Liste de mes bots', 'my_bots')]
  ]);

  // ═══════════════════════════════════════════════════════════
  // BOT MÈRE
  // ═══════════════════════════════════════════════════════════

  bot.start(async (ctx) => {
    getUser(ctx.from.id, { username: ctx.from.username, firstName: ctx.from.first_name });
    const text =
      `═══════════════════════════════════════════\n` +
      `✦  ☠︎︎༒︎ ${CONFIG.BOT_NAME} ༒︎☠︎︎ ✦\n` +
      `═══════════════════════════════════════════\n` +
      `CREATOR : ${CONFIG.AUTHOR}\n\n` +
      `👋 Bienvenue sur Kira Builder Bot\n` +
      `Rejoins nos canaux & groupes pour continuer.`;
    await ctx.replyWithPhoto(CONFIG.IMAGES.start, { caption: text, ...linksKeyboard });
  });

  bot.action('joined', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Création de bot personnalisé ♻️', afterJoinKeyboard);
  });

  bot.action('my_bots', async (ctx) => {
    await ctx.answerCbQuery();
    await sendMyBots(ctx);
  });

  bot.command('link', async (ctx) => {
    await ctx.replyWithPhoto(CONFIG.IMAGES.link, { caption: '🔗 Nos liens officiels', ...linksKeyboardPlain });
  });

  bot.command('help', async (ctx) => {
    const text =
      `1️⃣ tapez /pair 242….\n` +
      `2️⃣ récupérer le code pair ( xxxx-xxxx )\n` +
      `3️⃣ allez sur whatsapp\n` +
      `4️⃣ tapez sur trois points ( Android ) / paramètres ( iPhone )\n` +
      `5️⃣ tapez appareil connecté\n` +
      `6️⃣ saisir le code\n` +
      `7️⃣ et tapez .menu`;
    await ctx.replyWithPhoto(CONFIG.IMAGES.profile, { caption: text });
  });

  bot.command('menu', async (ctx) => {
    const text =
      `📜 Menu ${CONFIG.BOT_NAME}\n\n` +
      `/start /link /help /mybot /bot /everybot /premium /code /shop /user /kira`;
    await ctx.replyWithPhoto(CONFIG.IMAGES.profile, { caption: text });
  });

  bot.command('bot', async (ctx) => {
    await ctx.reply(`🤖 ${CONFIG.BOT_LINK}`);
  });

  // ─────────────────────────────────────
  // CRÉATION D'UN BOT — state machine
  // name → image → description → commandes → token BotFather → lancement
  // ─────────────────────────────────────
  bot.action('create_bot', async (ctx) => {
    await ctx.answerCbQuery();
    const count = userBotCount(ctx.from.id);
    const premium = isUserPremiumActive(ctx.from.id);
    if (count >= CONFIG.FREE_BOT_LIMIT && !premium) {
      return ctx.reply(`🚫 Limite atteinte (${CONFIG.FREE_BOT_LIMIT}/${CONFIG.FREE_BOT_LIMIT}). Passe en premium avec /premium pour en créer d'autres.`);
    }
    setState(ctx.from.id, { step: 'name', data: { selectedCommands: [] } });
    await ctx.reply('1️⃣ Quel est le nom de votre bot ? (Ex: Kira bot)');
  });

  function commandSelectionKeyboard(selected) {
    const rows = [];
    for (const [category, cmds] of Object.entries(waManager.AVAILABLE_COMMANDS)) {
      rows.push([Markup.button.callback(`── ${category} ──`, 'noop')]);
      let line = [];
      for (const c of cmds) {
        const checked = selected.includes(c) ? '✅' : '◻️';
        line.push(Markup.button.callback(`${checked} ${c}`, `toggle_cmd:${c}`));
        if (line.length === 2) { rows.push(line); line = []; }
      }
      if (line.length) rows.push(line);
    }
    rows.push([Markup.button.callback(`✅ Valider la sélection (${selected.length})`, 'validate_cmds')]);
    return Markup.inlineKeyboard(rows);
  }

  bot.action('noop', async (ctx) => ctx.answerCbQuery());

  bot.action(/toggle_cmd:(.+)/, async (ctx) => {
    const state = getState(ctx.from.id);
    if (!state || state.step !== 'commands') return ctx.answerCbQuery();
    const cmd = ctx.match[1];
    const idx = state.data.selectedCommands.indexOf(cmd);
    if (idx >= 0) state.data.selectedCommands.splice(idx, 1);
    else state.data.selectedCommands.push(cmd);
    await ctx.answerCbQuery(idx >= 0 ? `❌ ${cmd} retirée` : `✅ ${cmd} ajoutée`);
    try {
      await ctx.editMessageReplyMarkup(commandSelectionKeyboard(state.data.selectedCommands).reply_markup);
    } catch (_) { /* message inchangé, ignore */ }
  });

  bot.action('validate_cmds', async (ctx) => {
    const state = getState(ctx.from.id);
    if (!state || state.step !== 'commands') return ctx.answerCbQuery();
    await ctx.answerCbQuery();

    if (state.data.editing) {
      // édition des commandes d'un bot existant (pas de token à redemander)
      const b = getBot(state.data.botId);
      if (b) { b.commands = state.data.selectedCommands; saveDB(); }
      clearState(ctx.from.id);
      return ctx.reply('✅ Commandes mises à jour.');
    }

    state.step = 'token';
    await ctx.reply(
      `5️⃣ Dernière étape : va sur @BotFather, tape /newbot, suis les instructions, ` +
      `puis colle ici le token qu'il te donne (ex: 123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx).\n\n` +
      `⚠️ Ce token donne le contrôle total de ton bot — ne le partage avec personne d'autre que moi.`
    );
  });

  async function finalizeNewBot(ctx, state, tokenValue) {
    let me;
    try {
      const tmp = new Telegraf(tokenValue);
      me = await tmp.telegram.getMe();
    } catch (e) {
      return ctx.reply('❌ Ce token est invalide ou déjà révoqué. Vérifie-le sur @BotFather et réessaie, ou envoie /bot pour annuler.');
    }

    // Empêche de réutiliser un token déjà lié à un autre bot de la plateforme
    const already = Object.values(db().bots).find((b) => b.telegramToken === tokenValue);
    if (already) {
      return ctx.reply('❌ Ce token est déjà utilisé par un autre bot sur la plateforme.');
    }

    const newBot = createBot({
      ownerTelegramId: ctx.from.id,
      ownerUsername: ctx.from.username,
      name: state.data.name,
      description: state.data.description,
      imageUrl: state.data.imageUrl,
      commands: state.data.selectedCommands,
      telegramToken: tokenValue,
      telegramUsername: me.username
    });

    clearState(ctx.from.id);

    const recap =
      `📝 Nom : ${newBot.name}\n` +
      `✅ BOT → 🔓\n` +
      `🟢 STATUS → OPEN\n` +
      `📅 DATE → ${fmtDate()}\n` +
      `👤 Auteur : @${ctx.from.username || ctx.from.id}\n` +
      `🔑 Prefix : ${CONFIG.PREFIX}\n` +
      `📦 Total Cmds : ${newBot.commands.length}\n` +
      `🔗 lien du bot : @${me.username}\n\n` +
      `⚡ Power by Mr Kira Tech 🌐`;

    await ctx.replyWithPhoto(newBot.imageUrl, { caption: recap });
    await ctx.reply(`✅ Ton bot @${me.username} est en ligne ! Va lui parler et tape /pair <numéro> sur CE bot (pas ici) pour connecter WhatsApp.`);

    launchChildBot(newBot).catch((e) => console.error(`[CHILD:${newBot.id}] échec de lancement :`, e.message));
  }

  bot.on('text', async (ctx, next) => {
    const state = getState(ctx.from.id);
    if (!state) return next();

    const text = ctx.message.text.trim();

    if (state.step === 'name') {
      state.data.name = text;
      state.step = 'image';
      return ctx.reply("2️⃣ Envoie l'image du bot WhatsApp (ou tape 'skip' pour utiliser l'image par défaut).");
    }

    if (state.step === 'image') {
      if (text.toLowerCase() === 'skip') {
        state.data.imageUrl = CONFIG.IMAGES.profile;
        state.step = 'desc';
        return ctx.reply('3️⃣ Description du bot ?');
      }
      return ctx.reply("📷 Envoie une photo (pas du texte), ou tape 'skip'.");
    }

    if (state.step === 'desc') {
      state.data.description = text;
      state.step = 'commands';
      return ctx.reply(
        '4️⃣ Sélectionne les commandes à rajouter (clique pour cocher ✅, reclique pour décocher) :',
        commandSelectionKeyboard(state.data.selectedCommands)
      );
    }

    if (state.step === 'token') {
      return finalizeNewBot(ctx, state, text);
    }

    if (state.step === 'kira_code') {
      if (text === CONFIG.KIRA_DEV_CODE) {
        clearState(ctx.from.id);
        await ctx.reply('*BIENVENU MR KIRA TECH*\nvous voulez ?', {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔴 Créer un code promo', 'kira_promo')],
            [Markup.button.callback('🟡 Modifier les bots créés', 'kira_editbots')]
          ])
        });
      } else {
        clearState(ctx.from.id);
        await ctx.reply('❌ Code incorrect.');
      }
      return;
    }

    if (state.step === 'kira_promo_code') {
      const code = text.toUpperCase();
      createPromoCode(code);
      clearState(ctx.from.id);
      return ctx.reply(`✅ Code promo "${code}" créé (valable 10 minutes, utilisable par n'importe qui).`);
    }

    if (state.step === 'redeem_code') {
      const result = redeemPromoCode(text.toUpperCase(), ctx.from.id);
      clearState(ctx.from.id);
      if (result.ok) return ctx.reply('✅ Code valide ! +3 essais gratuits et accès premium activé (10 min).');
      return ctx.reply('❌ Code invalide.');
    }

    if (state.step === 'rename_bot') {
      const b = getBot(state.data.botId);
      if (b) { b.name = text; saveDB(); }
      clearState(ctx.from.id);
      return ctx.reply('✅ Nom mis à jour.');
    }

    if (state.step === 'redesc_bot') {
      const b = getBot(state.data.botId);
      if (b) { b.description = text; saveDB(); }
      clearState(ctx.from.id);
      return ctx.reply('✅ Description mise à jour.');
    }

    return next();
  });

  bot.on('photo', async (ctx, next) => {
    const state = getState(ctx.from.id);
    if (!state || state.step !== 'image') return next();
    const photos = ctx.message.photo;
    const fileId = photos[photos.length - 1].file_id;
    const fileLink = await ctx.telegram.getFileLink(fileId);
    state.data.imageUrl = fileLink.href;
    state.step = 'desc';
    return ctx.reply('3️⃣ Description du bot ?');
  });

  // ─────────────────────────────────────
  // /mybot — gestion des bots existants
  // ─────────────────────────────────────
  bot.command('mybot', async (ctx) => sendMyBots(ctx));
  async function sendMyBots(ctx) {
    const bots = userBots(ctx.from.id);
    if (!bots.length) return ctx.reply("Tu n'as encore créé aucun bot. Tape /start pour commencer.");
    const rows = bots.map((b) => [Markup.button.callback(`🤖 ${b.name}`, `bot_edit:${b.id}`)]);
    await ctx.reply('📋 Tes bots :', Markup.inlineKeyboard(rows));
  }

  bot.action(/bot_edit:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const b = getBot(ctx.match[1]);
    if (!b) return ctx.reply('Bot introuvable (peut-être supprimé).');
    await ctx.reply(
      `🤖 ${b.name} (@${b.telegramUsername || '?'})\n📦 ${b.commands.length} commande(s)\n🔌 WhatsApp : ${b.waSession.paired ? 'Connecté' : 'Non connecté'}\n${childBots.has(b.id) ? '🟢 Bot Telegram actif' : '🔴 Bot Telegram arrêté'}`,
      Markup.inlineKeyboard([
        [Markup.button.callback('✏️ Modifier le nom', `edit_name:${b.id}`)],
        [Markup.button.callback('📝 Modifier la description', `edit_desc:${b.id}`)],
        [Markup.button.callback('⚙️ Modifier les commandes', `edit_cmds:${b.id}`)],
        [Markup.button.callback('🗑️ Supprimer le bot', `del_bot:${b.id}`)]
      ])
    );
  });

  bot.action(/edit_name:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    setState(ctx.from.id, { step: 'rename_bot', data: { botId: ctx.match[1] } });
    await ctx.reply('✏️ Envoie le nouveau nom du bot :');
  });

  bot.action(/edit_desc:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    setState(ctx.from.id, { step: 'redesc_bot', data: { botId: ctx.match[1] } });
    await ctx.reply('📝 Envoie la nouvelle description du bot :');
  });

  bot.action(/edit_cmds:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const b = getBot(ctx.match[1]);
    if (!b) return;
    setState(ctx.from.id, { step: 'commands', data: { botId: b.id, selectedCommands: [...b.commands], editing: true } });
    await ctx.reply('⚙️ Modifie les commandes :', commandSelectionKeyboard(b.commands));
  });

  bot.action(/del_bot:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const b = getBot(ctx.match[1]);
    if (!b) return;
    await waManager.unpairBot(b.id);
    stopChildBot(b.id);
    deleteBot(b.id);
    await ctx.reply(`🗑️ Bot "${b.name}" supprimé.`);
  });

  // ─────────────────────────────────────
  // /everybot /premium /code /user /shop /kira
  // ─────────────────────────────────────
  bot.command('everybot', async (ctx) => {
    const all = Object.values(db().bots);
    if (!all.length) {
      return ctx.replyWithPhoto(CONFIG.IMAGES.everybot, { caption: 'Aucun bot créé pour le moment.' });
    }
    const list = all.map((b, i) => `${i + 1}• ${b.name} —> @${b.telegramUsername || b.id}`).join('\n');
    const text =
      `╔══════════════════════════╗\n` +
      `👥 TOUS LES BOTS : (${all.length}) 🤖\n` +
      `${list}\n` +
      `╚══════════════════════════╝`;
    await ctx.replyWithPhoto(CONFIG.IMAGES.everybot, { caption: text });
  });

  bot.command('premium', async (ctx) => {
    await ctx.reply(
      `💎 Passe Premium\n✅ 3 mois gratuits\n📲 Paiement via : [ ⭐️ start]`,
      Markup.inlineKeyboard([
        [Markup.button.callback('💳 Payer', 'premium_pay')],
        [Markup.button.callback('🔐 Code promo', 'premium_code')]
      ])
    );
  });

  bot.action('premium_pay', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
      `Réaliser un paiement de :\n• 10 ⭐️ / mois au bot\n• 20 ⭐️ / 3 mois au bot`,
      Markup.inlineKeyboard([
        [Markup.button.callback('⭐️ 10 (1 mois)', 'buy_stars:10:1')],
        [Markup.button.callback('⭐️ 20 (3 mois)', 'buy_stars:20:3')]
      ])
    );
  });

  bot.action(/buy_stars:(\d+):(\d+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const stars = parseInt(ctx.match[1], 10);
    const months = parseInt(ctx.match[2], 10);
    await ctx.replyWithInvoice({
      title: `Premium Kira Builder (${months} mois)`,
      description: `Accès premium : création illimitée de bots pendant ${months} mois.`,
      payload: JSON.stringify({ months, telegramId: ctx.from.id }),
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: `Premium ${months} mois`, amount: stars }]
    });
  });

  bot.on('pre_checkout_query', async (ctx) => {
    await ctx.answerPreCheckoutQuery(true).catch(() => {});
  });

  bot.on('message', async (ctx, next) => {
    if (ctx.message && ctx.message.successful_payment) {
      const payload = JSON.parse(ctx.message.successful_payment.invoice_payload);
      const u = getUser(payload.telegramId);
      u.isPremium = true;
      u.premiumUntil = Date.now() + payload.months * 30 * 24 * 60 * 60 * 1000;
      saveDB();
      await ctx.reply(`✅ Paiement reçu ! Premium activé pour ${payload.months} mois.`);
      return;
    }
    return next();
  });

  bot.action('premium_code', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Tape /code puis ton code.');
  });

  bot.command('code', async (ctx) => {
    setState(ctx.from.id, { step: 'redeem_code', data: {} });
    await ctx.reply('🔐 Entre ton code promo :');
  });

  bot.command('user', async (ctx) => {
    await ctx.reply(`👥 Nombre d'utilisateurs : ${Object.keys(db().users).length}`);
  });

  const SHOP_ITEMS = [
    { id: 'support_ban', label: 'Support ban Puissant 🔱', price: '1000 f' },
    { id: 'ban_bot', label: 'Ban Bot tech 🚫', price: '3000 f' },
    { id: 'fichier_bot', label: 'Fichier bot 🗂', price: '1500 f' },
    { id: 'fichier_bug', label: 'Fichier bug bot 🗂', price: '2500 f' },
    { id: 'fichier_ban', label: 'Fichier ban bot 🗂', price: '4000 f' },
    { id: 'fichier_site', label: 'Fichier site 📰', price: '1500 f' },
    { id: 'tg_premium', label: 'Telegram premium ⭐️', price: '3500 f' },
    { id: 'check_ban', label: 'Check ban personnalisable 📌', price: '1000 f' }
  ];

  bot.command('shop', async (ctx) => {
    const lines = SHOP_ITEMS.map((it) => `• ${it.label} — [ ${it.price} ]`).join('\n');
    const rows = SHOP_ITEMS.map((it) => [Markup.button.callback(`${it.label} - ${it.price}`, `shop_item:${it.id}`)]);
    await ctx.reply(`🛒 BOUTIQUE KIRA TECH 🌐\n─────────────────\n${lines}\nClique sur un produit pour l'acheter.`, Markup.inlineKeyboard(rows));
  });

  bot.action(/shop_item:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const item = SHOP_ITEMS.find((it) => it.id === ctx.match[1]);
    if (!item) return;
    await ctx.reply(`🛍 ${item.label} — ${item.price}`, Markup.inlineKeyboard([
      [Markup.button.callback('🛍 Acheter', `buy_item:${item.id}`)],
      [Markup.button.callback('📩 Support', 'shop_support')]
    ]));
  });

  bot.action(/buy_item:(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Demande envoyée !');
    const item = SHOP_ITEMS.find((it) => it.id === ctx.match[1]);
    if (!item) return;
    const msg =
      `🛒 Nouvelle demande d'achat\n` +
      `Utilisateur : @${ctx.from.username || ctx.from.id} (${ctx.from.id})\n` +
      `Produit : ${item.label}\n` +
      `Prix : ${item.price}`;
    if (CONFIG.GROUP2_ID) {
      await ctx.telegram.sendMessage(CONFIG.GROUP2_ID, msg).catch((e) => console.error('[SHOP] envoi groupe échoué :', e.message));
    }
    await ctx.reply('✅ Ta demande a été transmise. Un administrateur te contactera.');
  });

  bot.action('shop_support', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(CONFIG.LINKS.support);
  });

  bot.command('kira', async (ctx) => {
    setState(ctx.from.id, { step: 'kira_code', data: {} });
    await ctx.reply("Code d'accès :");
  });

  bot.action('kira_promo', async (ctx) => {
    await ctx.answerCbQuery();
    setState(ctx.from.id, { step: 'kira_promo_code', data: {} });
    await ctx.reply('Entre le code à créer :');
  });

  bot.action('kira_editbots', async (ctx) => {
    await ctx.answerCbQuery();
    const all = Object.values(db().bots);
    if (!all.length) return ctx.reply('Aucun bot à modifier.');
        const rows = all.map((b) => [Markup.button.callback(`${b.banned ? '⛔' : '🤖'} ${b.name}`, `kira_bot:${b.id}`)]);
    await ctx.reply('📋 Tous les bots :', Markup.inlineKeyboard(rows));
  });

  bot.action(/kira_bot:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const b = getBot(ctx.match[1]);
    if (!b) return;
    await ctx.reply(`🤖 ${b.name} (par @${b.ownerUsername || 'inconnu'})`, Markup.inlineKeyboard([
      [Markup.button.callback(b.banned ? '✅ Débannir' : '⛔ Bannir', `kira_toggleban:${b.id}`)],
      [Markup.button.callback('🗑️ Supprimer', `del_bot:${b.id}`)]
    ]));
  });

  bot.action(/kira_toggleban:(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const b = getBot(ctx.match[1]);
    if (!b) return;
    b.banned = !b.banned;
    saveDB();
    if (b.banned) stopChildBot(b.id);
    else launchChildBot(b).catch((e) => console.error(`[CHILD:${b.id}] relance échouée :`, e.message));
    await ctx.reply(`${b.banned ? '⛔ Bot banni.' : '✅ Bot débanni.'}`);
  });

  bot.catch((err, ctx) => {
    console.error(`[TELEGRAM:MÈRE] Erreur sur update ${ctx.updateType} :`, err);
  });

  // ═══════════════════════════════════════════════════════════
  // FABRIQUE DE BOTS ENFANTS — chacun a son propre token BotFather
  // ═══════════════════════════════════════════════════════════

  async function doPair(ctx, botRecord, number) {
    if (!number || !/^\d{8,15}$/.test(number)) {
      return ctx.reply(
        `⚠️❌ ERREUR : NUMÉRO ERRONÉ ❌⚠️\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🚫 Le numéro que tu as tapé est invalide.\n` +
        `📲 Format correct : 242XXXXXXXX\n` +
        `⛔ Sans le (+) devant.\n` +
        `✅ Exemple : 242XXXXXXXX\n\n` +
        `🔁 Réessaie : ➜ /pair 242XXXXXXXX\n` +
        `━━━━━━━━━━━━━━━━━━━\n\n` +
        `power by Mr kira tech 🌐`
      );
    }

    if (botRecord.banned) return ctx.reply('⚠️ Erreur : ce bot a été banni du serveur. Contacte le support : ' + CONFIG.LINKS.support);

    await ctx.reply(`📡 Demande en cours pour ${number}… 🔄`);

    try {
      const code = await waManager.requestPairing(botRecord.id, number);
      const text =
        `━━━━━━━━━━━━━━━━━━━\n` +
        `🌐 Bot : ${botRecord.name}\n\n` +
        `📲 PAIRING CODE pour ${number} ☑️\n\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `╔══════════════════════════╗\n` +
        `🔑 CODE DE JUMELAGE : ${code}\n` +
        `╚══════════════════════════╝\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `👉 INSTRUCTIONS :\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `1️⃣ Envoie ce code au numéro à connecter 📱\n` +
        `2️⃣ Appareils liés 🔗 ➜ Lier un appareil ➕\n` +
        `3️⃣ Entre ce code pour associer ce bot 🤖\n\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `✅ Une fois connecté, tape .menu pour continuer 📜\n` +
        `━━━━━━━━━━━━━━━━━━━\n\n` +
        `power by Mr Kira tech 🌐`;

      await ctx.replyWithPhoto(botRecord.imageUrl, {
        caption: text,
        ...Markup.inlineKeyboard([[Markup.button.callback('📄 Copier le code', `copy_code:${code}`)]])
      });

      waManager.onceConnected(botRecord.id, async () => {
        const successText =
          `✨━━━━━━━━━━━━━━━━━━━━✨\n` +
          `🎊🎉 CONGRATULATIONS ! 🎉🎊\n` +
          `✨━━━━━━━━━━━━━━━━━━━━✨\n\n` +
          `╔══════════════════════════╗\n` +
          `✅ BOT ➜ Connecté 🤖\n` +
          `🟢 STATUS ➜ OPEN\n` +
          `📅 DATE ➜ ${fmtDate()}\n` +
          `⚜️ BY ➜ Mr Kira Tech ⚜️\n` +
          `╚══════════════════════════╝`;
        await ctx.replyWithPhoto(botRecord.imageUrl, { caption: successText }).catch(() => {});
        await waManager.sendWelcomeMessage(botRecord.id);
      });
    } catch (e) {
      console.error(`[PAIR:${botRecord.id}] erreur :`, e);
      await ctx.reply(
        `❌ Impossible de générer le code de jumelage.\n\n` +
        `🔎 Détail technique : ${e.message}\n\n` +
        `Réessaie avec /pair ${number}.`
      );
    }
  }

  function childLinksKeyboard() {
    return Markup.inlineKeyboard(linksRows);
  }

  async function launchChildBot(botRecord) {
    if (!botRecord.telegramToken) return;
    if (childBots.has(botRecord.id)) {
      try { childBots.get(botRecord.id).stop('relaunch'); } catch (_) { /* ignore */ }
      childBots.delete(botRecord.id);
    }

    const childBot = new Telegraf(botRecord.telegramToken);

    childBot.start(async (ctx) => {
      const current = getBot(botRecord.id);
      if (!current) return;
      const text =
        `═══════════════════════════════════════════\n` +
        ` ✦  WELCOME IN KIRA TECH HOUSE  🌐 ✦\n` +
        `═══════════════════════════════════════════\n\n` +
        `NAME       : ${current.name}\n` +
        `CREATOR    : @${current.ownerUsername || 'inconnu'}\n\n` +
        `───────────────────────────────────────────\n` +
        `  DESCRIPTION\n` +
        `───────────────────────────────────────────\n` +
        `${current.description || 'THE BEST FOR CONNECT A ACCOUNT FOR OFF'}\n` +
        `───────────────────────────────────────────\n` +
        `Tape /menu pour voir le menu\n` +
        `───────────────────────────────────────────`;
      await ctx.replyWithPhoto(current.imageUrl, { caption: text, ...childLinksKeyboard() });
    });

    childBot.command('link', async (ctx) => {
      await ctx.replyWithPhoto(CONFIG.IMAGES.link, { caption: '🔗 Nos liens officiels', ...childLinksKeyboard() });
    });

    childBot.command('help', async (ctx) => {
      const current = getBot(botRecord.id);
      const text =
        `1️⃣ tapez /pair 242….\n` +
        `2️⃣ récupérer le code pair ( xxxx-xxxx )\n` +
        `3️⃣ allez sur whatsapp\n` +
        `4️⃣ tapez sur trois points ( Android ) / paramètres ( iPhone )\n` +
        `5️⃣ tapez appareil connecté\n` +
        `6️⃣ saisir le code\n` +
        `7️⃣ et tapez .menu`;
      await ctx.replyWithPhoto((current || botRecord).imageUrl, { caption: text });
    });

    childBot.command('menu', async (ctx) => {
      const current = getBot(botRecord.id);
      const text =
        `📜 Menu de ce bot\n\n` +
        `/start /link /help /pair /unpair /bot /menu\n\n` +
        `👉 Une fois connecté à WhatsApp, tape .menu directement dans WhatsApp pour voir les ${current ? current.commands.length : 0} commandes activées.`;
      await ctx.replyWithPhoto((current || botRecord).imageUrl, { caption: text });
    });

    childBot.command('bot', async (ctx) => {
      await ctx.reply(`🤖 Bot créé avec : ${CONFIG.BOT_LINK}`);
    });

    childBot.command('pair', async (ctx) => {
      const current = getBot(botRecord.id);
      if (!current) return ctx.reply('❌ Ce bot a été supprimé.');
      const number = ctx.message.text.trim().split(/\s+/)[1];
      await doPair(ctx, current, number);
    });

    childBot.command('unpair', async (ctx) => {
      const current = getBot(botRecord.id);
      if (!current || !current.waSession.paired) return ctx.reply('Aucun numéro connecté à déconnecter.');
      await waManager.unpairBot(botRecord.id);
      await ctx.reply('🔌 WhatsApp déconnecté de ce bot.');
    });

    childBot.action(/copy_code:(.+)/, async (ctx) => {
      await ctx.answerCbQuery(ctx.match[1], { show_alert: true });
    });

    childBot.catch((err, ctx) => {
      console.error(`[TELEGRAM:${botRecord.id}] Erreur sur update ${ctx.updateType} :`, err);
    });

    await childBot.launch();
    childBots.set(botRecord.id, childBot);
    console.log(`[CHILD:${botRecord.id}] Bot enfant "@${botRecord.telegramUsername}" lancé.`);
  }

  function stopChildBot(botId) {
    const instance = childBots.get(botId);
    if (instance) {
      try { instance.stop('deleted_or_banned'); } catch (_) { /* ignore */ }
      childBots.delete(botId);
    }
  }

  // Relance tous les bots enfants déjà créés (au redémarrage du serveur)
  async function reconnectAllChildBots() {
    const all = Object.values(db().bots).filter((b) => b.telegramToken && !b.banned);
    for (const b of all) {
      launchChildBot(b).catch((e) => console.error(`[CHILD:${b.id}] reconnexion échouée :`, e.message));
    }
  }
  reconnectAllChildBots();

  return bot;
}

module.exports = { initTelegramBot };
