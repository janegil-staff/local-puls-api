#!/usr/bin/env node
// apply-bot-api.cjs
//
// Adds Pulse AI — an AI chat bot that is an ordinary user with an "AI" badge —
// to local-puls-api. Additive only: no routes, socket events or response
// fields are removed or renamed, so the app and quppulse.com keep working
// before they are updated. They just won't show the badge until they read
// the new `isBot` field.
//
//   New files
//     src/controllers/botController.js  welcome + AI replies (Claude or OpenAI)
//     src/lib/botWelcome.js             welcome / limit / error texts, 12 languages
//     scripts/createBot.js              creates or updates the bot user
//
//   Edits
//     src/models/User.js                isBot + botPersona; isBot in toPublic/toCard
//     src/controllers/authController.js welcome every new user after register
//     src/controllers/chatController.js bot answers when you message it
//     src/sockets/callHandlers.js       no video/voice calls to the bot
//     package.json                      "bot:create" script + @anthropic-ai/sdk
//
//   node apply-bot-api.cjs               run from the API root
//   node apply-bot-api.cjs --dry-run     show what would change
//   node apply-bot-api.cjs --no-install  skip `npm install @anthropic-ai/sdk`
//   node apply-bot-api.cjs --force       overwrite new files that already exist
//
// Backs up every file it touches to .bot-backup/<timestamp>/. Safe to run
// twice — edits already in place are skipped.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const DRY = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const NO_INSTALL = process.argv.includes('--no-install');
const root = process.cwd();

const EDITS = [
  {
    "file": "src/models/User.js",
    "steps": [
      {
        "name": "isBot + botPersona fields",
        "done": "isBot: { type: Boolean, default: false, index: true },",
        "find": "    isSeedUser: {\n      type: Boolean,\n      default: false,\n      index: true,\n    },\n  },\n  { timestamps: true },",
        "replace": "    isSeedUser: {\n      type: Boolean,\n      default: false,\n      index: true,\n    },\n\n    // ── AI bot ──────────────────────────────────────────\n    // A bot is an ordinary user document — same profile, same discovery card,\n    // same chat — plus this flag. Every public serializer exposes isBot so the\n    // clients can show the \"AI\" badge; the badge is the user's only way to\n    // know they are not talking to a person, so never drop it from a\n    // serializer that renders a profile or a chat header.\n    isBot: { type: Boolean, default: false, index: true },\n    // The bot's system prompt. select: false so it never rides along on an\n    // ordinary User query — botController selects it explicitly.\n    botPersona: { type: String, default: \"\", select: false },\n  },\n  { timestamps: true },"
      },
      {
        "name": "bot always shows as online",
        "done": "if (this.isBot) return true;",
        "find": "userSchema.methods.visibleOnline = function visibleOnline() {\n  if ((this.showOnlineStatus ?? true) === false) return false;",
        "replace": "userSchema.methods.visibleOnline = function visibleOnline() {\n  // A bot never opens a socket, so its lastSeenAt never moves — but it does\n  // always answer, so show it as online.\n  if (this.isBot) return true;\n  if ((this.showOnlineStatus ?? true) === false) return false;"
      },
      {
        "name": "isBot in toPublic()",
        "done": "    online: this.visibleOnline(),\n    isBot: Boolean(this.isBot),\n    role: this.role,",
        "find": "    online: this.visibleOnline(),\n    role: this.role,",
        "replace": "    online: this.visibleOnline(),\n    isBot: Boolean(this.isBot),\n    role: this.role,"
      },
      {
        "name": "isBot in toCard()",
        "done": "    online: this.visibleOnline(),\n    isBot: Boolean(this.isBot),\n  };",
        "find": "    emailVerified: Boolean(this.emailVerified),\n    online: this.visibleOnline(),\n  };",
        "replace": "    emailVerified: Boolean(this.emailVerified),\n    online: this.visibleOnline(),\n    isBot: Boolean(this.isBot),\n  };"
      }
    ]
  },
  {
    "file": "src/controllers/authController.js",
    "steps": [
      {
        "name": "import sendBotWelcome",
        "done": "import { sendBotWelcome } from \"./botController.js\";",
        "find": "import { sendVerificationEmail, sendPinResetEmail } from \"../lib/mail.js\";\n",
        "replace": "import { sendVerificationEmail, sendPinResetEmail } from \"../lib/mail.js\";\nimport { sendBotWelcome } from \"./botController.js\";\n"
      },
      {
        "name": "welcome new users on register",
        "done": "sendBotWelcome({ io: req.app.get(\"io\"), user });",
        "find": "    sendVerificationEmail(user, user.emailVerifyToken);\n",
        "replace": "    sendVerificationEmail(user, user.emailVerifyToken);\n\n    // Fire and forget: Pulse AI opens a chat with every new user. Never\n    // throws, and signup does not wait for it.\n    sendBotWelcome({ io: req.app.get(\"io\"), user });\n"
      }
    ]
  },
  {
    "file": "src/controllers/chatController.js",
    "steps": [
      {
        "name": "import maybeReplyAsBot",
        "done": "import { maybeReplyAsBot } from \"./botController.js\";",
        "find": "import { checkPendingRules } from \"../lib/pendingGuard.js\";\n",
        "replace": "import { checkPendingRules } from \"../lib/pendingGuard.js\";\nimport { maybeReplyAsBot } from \"./botController.js\";\n"
      },
      {
        "name": "bot replies after a message is saved",
        "done": "maybeReplyAsBot({ io, conversationId: convo._id, senderId });",
        "find": "          conversationId: String(convo._id),\n        }),\n      );\n  }\n\n  return { ok: true, message: payload };",
        "replace": "          conversationId: String(convo._id),\n        }),\n      );\n  }\n\n  // If the other participant is Pulse AI, it answers. Fire and forget — the\n  // sender gets their 201 now and the reply arrives over the socket. A no-op\n  // for human-to-human conversations.\n  maybeReplyAsBot({ io, conversationId: convo._id, senderId });\n\n  return { ok: true, message: payload };"
      }
    ]
  },
  {
    "file": "src/sockets/callHandlers.js",
    "steps": [
      {
        "name": "import User",
        "done": "import User from \"../models/User.js\";",
        "find": "import { blockedBetween } from \"../lib/blocks.js\";\n",
        "replace": "import { blockedBetween } from \"../lib/blocks.js\";\nimport User from \"../models/User.js\";\n"
      },
      {
        "name": "refuse calls to the bot",
        "done": "Pulse AI has no camera or microphone",
        "find": "    if (registry.isUserBusy(userId)) {\n      return fail(ack, ERRORS.ALREADY_IN_CALL, \"You are already in a call.\");",
        "replace": "    // Pulse AI has no camera or microphone — a call would just ring forever.\n    if (await User.exists({ _id: calleeId, isBot: true })) {\n      return fail(ack, ERRORS.NOT_ALLOWED, \"Calls are not available here.\");\n    }\n\n    if (registry.isUserBusy(userId)) {\n      return fail(ack, ERRORS.ALREADY_IN_CALL, \"You are already in a call.\");"
      }
    ]
  }
];
const NEW_FILES = {
  "src/controllers/botController.js": "// local-puls-api/src/controllers/botController.js\n//\n// Pulse AI — the in-app bot. Logic only; the bot has NO routes of its own.\n// It is an ordinary User (isBot: true) and talks through the existing chat:\n//\n//   sendBotWelcome()   called from authController.register — opens an\n//                      accepted conversation with the new user and posts a\n//                      fixed welcome (no AI call, so nothing about the user\n//                      leaves the server until they reply).\n//   maybeReplyAsBot()  called from chatController.persistMessage after every\n//                      message — if the other participant is a bot, generates\n//                      a reply with the AI provider and posts it.\n//\n// Both are fire-and-forget from the caller's point of view: they never throw,\n// and the user's own request returns before the AI has answered.\n//\n// Env:\n//   BOT_PROVIDER          \"anthropic\" (default) or \"openai\"\n//   ANTHROPIC_API_KEY     when BOT_PROVIDER=anthropic\n//   OPENAI_API_KEY        when BOT_PROVIDER=openai\n//   BOT_MODEL             optional model override\n//   BOT_DAILY_LIMIT       user messages per bot conversation per 24h (default 50)\n//   BOT_WELCOME_ENABLED   \"false\" to stop welcoming new users (default on)\n\nimport Conversation, { buildPairKey } from \"../models/Conversation.js\";\nimport Message from \"../models/Message.js\";\nimport User from \"../models/User.js\";\nimport { welcomeText, limitText, errorText } from \"../lib/botWelcome.js\";\n\nconst PROVIDER = (process.env.BOT_PROVIDER || \"anthropic\").toLowerCase();\nconst DEFAULT_MODEL = {\n  anthropic: \"claude-haiku-5-5\",\n  // Check OpenAI's current model list and set BOT_MODEL if this is retired.\n  openai: \"gpt-4o-mini\",\n};\nconst MODEL = process.env.BOT_MODEL || DEFAULT_MODEL[PROVIDER];\nconst DAILY_LIMIT = Number(process.env.BOT_DAILY_LIMIT) || 50;\nconst HISTORY = 20; // messages of context sent to the model\nconst MAX_TOKENS = 400;\nconst MAX_TEXT = 2000; // Message.text maxlength\n\n// Shown in the welcome message — the user is told who processes their text.\nexport function providerLabel() {\n  return PROVIDER === \"openai\" ? \"OpenAI\" : \"Claude (Anthropic)\";\n}\n\n// Non-negotiable rules, appended after whatever persona is stored on the bot.\n// The persona is editable data; these are not, so an edited persona can make\n// the bot funnier but cannot make it claim to be human.\nfunction systemPrompt(bot, user) {\n  return [\n    bot.botPersona ||\n      \"You are Pulse AI, a friendly and playful bot in the Qup Pulse app. Help people with the app, give local tips, play games and chat.\",\n    \"\",\n    \"Rules you must always follow:\",\n    \"- You are an AI bot in Qup Pulse, a local social discovery app for adults. If anyone asks, say clearly that you are an AI. Never claim or imply that you are a human.\",\n    \"- Never flirt, and never take part in romantic or sexual conversation or roleplay.\",\n    \"- Never ask for personal information (full name, address, phone number, exact location, passwords, payment details).\",\n    \"- Never agree to meet anyone, and never pretend to be somewhere.\",\n    \"- If someone seems to be in danger or crisis, gently encourage them to contact local emergency services (112 in Norway and the EU) or someone they trust.\",\n    \"- Keep replies short and chatty: usually 1–3 sentences, never more than about 80 words. Plain text, no markdown.\",\n    `- Reply in the language the user writes in. Their app language code is \"${user.language || \"en\"}\".`,\n    `- The user's display name is \"${user.displayName || user.username}\".`,\n  ].join(\"\\n\");\n}\n\n// ── Provider clients (lazy, so the unused SDK need not be installed) ──\nlet client = null;\nasync function getClient() {\n  if (client) return client;\n  if (PROVIDER === \"openai\") {\n    if (!process.env.OPENAI_API_KEY) throw new Error(\"OPENAI_API_KEY not set\");\n    const { default: OpenAI } = await import(\"openai\");\n    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });\n  } else {\n    if (!process.env.ANTHROPIC_API_KEY)\n      throw new Error(\"ANTHROPIC_API_KEY not set\");\n    const { default: Anthropic } = await import(\"@anthropic-ai/sdk\");\n    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });\n  }\n  return client;\n}\n\nasync function generate(system, messages) {\n  const ai = await getClient();\n  if (PROVIDER === \"openai\") {\n    const res = await ai.chat.completions.create({\n      model: MODEL,\n      max_tokens: MAX_TOKENS,\n      messages: [{ role: \"system\", content: system }, ...messages],\n    });\n    return res.choices?.[0]?.message?.content || \"\";\n  }\n  const res = await ai.messages.create({\n    model: MODEL,\n    max_tokens: MAX_TOKENS,\n    system,\n    messages,\n  });\n  return (res.content || [])\n    .filter((b) => b.type === \"text\")\n    .map((b) => b.text)\n    .join(\"\");\n}\n\n// ── Helpers ───────────────────────────────────────────────────────────\n\n// Post a message as the bot and broadcast it exactly like persistMessage does\n// for a human sender: chat:message to the open thread, chat:notify to the\n// user's other screens (inbox badge, list refresh).\nasync function postAsBot({ io, convo, bot, userId, text }) {\n  const message = await Message.create({\n    conversation: convo._id,\n    sender: bot._id,\n    text: String(text).trim().slice(0, MAX_TEXT),\n    readBy: [bot._id],\n  });\n\n  convo.lastMessage = message.text;\n  convo.lastMessageAt = message.createdAt;\n  await convo.save();\n\n  await message.populate(\"sender\");\n  const payload = message.toClient(String(userId));\n\n  if (io) {\n    io.to(`conversation:${convo._id}`).emit(\"chat:message\", payload);\n    io.to(`user:${userId}`).emit(\"chat:notify\", {\n      conversationId: String(convo._id),\n    });\n  }\n  return message;\n}\n\n// The model needs strictly alternating turns that start with the user. Our\n// thread is free-form (the bot opened with the welcome; a user may send three\n// messages in a row), so merge runs of the same role and drop anything before\n// the first user turn.\nfunction toModelMessages(history, botId) {\n  const out = [];\n  for (const m of history) {\n    const role = String(m.sender) === String(botId) ? \"assistant\" : \"user\";\n    const content = m.text?.trim() || (m.imageUrl ? \"[sent a photo]\" : \"\");\n    if (!content) continue;\n    const last = out[out.length - 1];\n    if (last && last.role === role) last.content += `\\n${content}`;\n    else out.push({ role, content });\n  }\n  while (out.length && out[0].role !== \"user\") out.shift();\n  return out;\n}\n\n// One reply at a time per conversation. If the user sends more while the bot\n// is \"typing\", answer once more afterwards (covering everything they sent)\n// rather than firing one AI call per message.\nconst busy = new Map(); // conversationId -> { again: boolean }\n\n// ── Welcome a new user ────────────────────────────────────────────────\nexport async function sendBotWelcome({ io, user }) {\n  try {\n    if (process.env.BOT_WELCOME_ENABLED === \"false\") return;\n    if (!user || user.isBot) return;\n\n    const bot = await User.findOne({ isBot: true, banned: false })\n      .sort({ createdAt: 1 })\n      .select(\"_id\");\n    if (!bot) return; // no bot created yet — run scripts/createBot.js\n\n    let convo;\n    try {\n      // Accepted, not pending: the welcome should land in Messages, not in\n      // Requests where it would wait for the user to accept a bot.\n      convo = await Conversation.create({\n        participants: [bot._id, user._id],\n        pairKey: buildPairKey(bot._id, user._id),\n        status: \"accepted\",\n        initiator: bot._id,\n      });\n    } catch (err) {\n      if (err?.code === 11000) return; // already welcomed\n      throw err;\n    }\n\n    await postAsBot({\n      io,\n      convo,\n      bot,\n      userId: user._id,\n      text: welcomeText(user, providerLabel()),\n    });\n  } catch (err) {\n    console.error(\"[bot] welcome failed:\", err);\n  }\n}\n\n// ── Reply when a user writes to a bot ─────────────────────────────────\nexport async function maybeReplyAsBot({ io, conversationId, senderId }) {\n  const key = String(conversationId);\n  let owner = false; // only the call that took the lock may release it\n  try {\n    const convo = await Conversation.findById(conversationId);\n    if (!convo) return;\n\n    const otherId = convo.participants\n      .map(String)\n      .find((p) => p !== String(senderId));\n    if (!otherId) return;\n\n    const bot = await User.findOne({\n      _id: otherId,\n      isBot: true,\n      banned: false,\n    }).select(\"+botPersona\");\n    if (!bot) return; // a normal human conversation — nothing to do\n\n    if (busy.has(key)) {\n      busy.get(key).again = true;\n      return;\n    }\n    busy.set(key, { again: false });\n    owner = true;\n\n    const user = await User.findById(senderId).select(\n      \"displayName username language\",\n    );\n    if (!user) return;\n\n    // Daily cap, counted from the user's own messages so it cannot drift.\n    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);\n    const sentToday = await Message.countDocuments({\n      conversation: convo._id,\n      sender: senderId,\n      createdAt: { $gte: since },\n    });\n    if (sentToday > DAILY_LIMIT) {\n      // Tell them once, at the message that crosses the line; stay quiet after.\n      if (sentToday === DAILY_LIMIT + 1) {\n        await postAsBot({\n          io,\n          convo,\n          bot,\n          userId: senderId,\n          text: limitText(user.language),\n        });\n      }\n      return;\n    }\n\n    // Message ids the model has already answered. A message the user sends\n    // while the bot is generating is saved BEFORE the bot's reply, so by\n    // timestamp it sits in the middle of the thread; on the follow-up pass it\n    // is moved to the end so the model answers it instead of seeing its own\n    // reply as the last word.\n    let seen = null;\n    let again = true;\n    while (again) {\n      busy.get(key).again = false;\n\n      if (io) {\n        io.to(`conversation:${convo._id}`).emit(\"chat:typing\", {\n          userId: String(bot._id),\n        });\n      }\n\n      // Same visibility rules as the user's thread: nothing retracted,\n      // removed by a moderator, or hidden by the user goes to the model.\n      const recent = await Message.find({\n        conversation: convo._id,\n        retractedAt: { $exists: false },\n        \"removedByAdmin.at\": { $exists: false },\n        hiddenFor: { $ne: senderId },\n      })\n        .sort({ createdAt: -1 })\n        .limit(HISTORY)\n        .select(\"_id sender text imageUrl\")\n        .lean();\n\n      let ordered = recent.reverse(); // oldest first\n      if (seen) {\n        const isNew = (m) =>\n          String(m.sender) !== String(bot._id) && !seen.has(String(m._id));\n        ordered = [\n          ...ordered.filter((m) => !isNew(m)),\n          ...ordered.filter(isNew),\n        ];\n      }\n      seen = new Set(ordered.map((m) => String(m._id)));\n\n      const messages = toModelMessages(ordered, bot._id);\n      if (!messages.length) break;\n\n      let text;\n      try {\n        text = await generate(systemPrompt(bot, user), messages);\n      } catch (err) {\n        console.error(\"[bot] AI call failed:\", err?.message || err);\n        text = errorText(user.language);\n      }\n      if (text?.trim()) {\n        await postAsBot({ io, convo, bot, userId: senderId, text });\n      }\n\n      again = busy.get(key).again;\n    }\n  } catch (err) {\n    console.error(\"[bot] reply failed:\", err);\n  } finally {\n    if (owner) busy.delete(key);\n  }\n}\n",
  "src/lib/botWelcome.js": "// local-puls-api/src/lib/botWelcome.js\n//\n// The bot's first message to a new user, one per app language.\n//\n// FIXED TEXT, NOT AI. The welcome is sent at signup, before the user has said\n// anything — so nothing about them goes to the AI provider until they choose\n// to reply. The second sentence is the disclosure: it tells them, in their own\n// language, that replies are AI-generated by a third party. That is what\n// App Review guideline 5.1.2(i) asks for, so do not shorten it away.\n\nconst WELCOME = {\n  en: \"Hi {name}! 👋 I'm Pulse AI, the Qup Pulse bot. I'm an AI, and my replies are generated by {provider}, so anything you write to me is sent to them to create an answer. Ask me about the app, local tips, or just say hi!\",\n  no: \"Hei {name}! 👋 Jeg er Pulse AI, boten i Qup Pulse. Jeg er en AI, og svarene mine lages av {provider}, så det du skriver til meg sendes dit for å lage et svar. Spør meg om appen, lokale tips, eller bare si hei!\",\n  sv: \"Hej {name}! 👋 Jag är Pulse AI, boten i Qup Pulse. Jag är en AI och mina svar skapas av {provider}, så det du skriver till mig skickas dit för att skapa ett svar. Fråga mig om appen, lokala tips eller säg bara hej!\",\n  da: \"Hej {name}! 👋 Jeg er Pulse AI, botten i Qup Pulse. Jeg er en AI, og mine svar laves af {provider}, så det, du skriver til mig, sendes dertil for at lave et svar. Spørg mig om appen, lokale tips, eller sig bare hej!\",\n  fi: \"Hei {name}! 👋 Olen Pulse AI, Qup Pulsen botti. Olen tekoäly, ja vastaukseni tuottaa {provider}, joten minulle kirjoittamasi viestit lähetetään sinne vastauksen luomiseksi. Kysy minulta sovelluksesta, paikallisia vinkkejä tai sano vain hei!\",\n  de: \"Hallo {name}! 👋 Ich bin Pulse AI, der Bot von Qup Pulse. Ich bin eine KI, und meine Antworten werden von {provider} erstellt – was du mir schreibst, wird dorthin gesendet, um eine Antwort zu erzeugen. Frag mich zur App, nach lokalen Tipps oder sag einfach Hallo!\",\n  nl: \"Hoi {name}! 👋 Ik ben Pulse AI, de bot van Qup Pulse. Ik ben een AI en mijn antwoorden worden gemaakt door {provider}, dus wat je mij schrijft wordt daarheen gestuurd om een antwoord te maken. Vraag me iets over de app, lokale tips, of zeg gewoon hoi!\",\n  fr: \"Salut {name} ! 👋 Je suis Pulse AI, le bot de Qup Pulse. Je suis une IA et mes réponses sont générées par {provider} : ce que tu m'écris leur est envoyé pour créer une réponse. Pose-moi des questions sur l'appli, demande des bons plans locaux ou dis simplement bonjour !\",\n  es: \"¡Hola {name}! 👋 Soy Pulse AI, el bot de Qup Pulse. Soy una IA y mis respuestas las genera {provider}, así que lo que me escribas se envía allí para crear una respuesta. ¡Pregúntame sobre la app, pídeme consejos locales o simplemente saluda!\",\n  it: \"Ciao {name}! 👋 Sono Pulse AI, il bot di Qup Pulse. Sono un'IA e le mie risposte sono generate da {provider}, quindi ciò che mi scrivi viene inviato lì per creare una risposta. Chiedimi dell'app, consigli locali o semplicemente saluta!\",\n  pt: \"Olá {name}! 👋 Sou o Pulse AI, o bot do Qup Pulse. Sou uma IA e as minhas respostas são geradas por {provider}, por isso o que me escreves é enviado para lá para criar uma resposta. Pergunta-me sobre a app, dicas locais ou diz apenas olá!\",\n  pl: \"Cześć {name}! 👋 Jestem Pulse AI, bot w Qup Pulse. Jestem AI, a moje odpowiedzi tworzy {provider}, więc to, co do mnie piszesz, jest tam wysyłane, aby utworzyć odpowiedź. Zapytaj mnie o aplikację, lokalne wskazówki albo po prostu się przywitaj!\",\n};\n\n// Sent once, when a user hits the daily reply limit. Fixed text so that\n// hitting the limit costs nothing.\nconst LIMIT = {\n  en: \"I've chatted a lot today and need a break 😴 Talk again tomorrow!\",\n  no: \"Jeg har pratet mye i dag og trenger en pause 😴 Vi snakkes i morgen!\",\n  sv: \"Jag har pratat mycket i dag och behöver en paus 😴 Vi hörs i morgon!\",\n  da: \"Jeg har snakket meget i dag og har brug for en pause 😴 Vi tales ved i morgen!\",\n  fi: \"Olen jutellut tänään paljon ja tarvitsen tauon 😴 Jutellaan huomenna!\",\n  de: \"Ich habe heute viel geplaudert und brauche eine Pause 😴 Bis morgen!\",\n  nl: \"Ik heb vandaag veel gekletst en heb even pauze nodig 😴 Tot morgen!\",\n  fr: \"J'ai beaucoup discuté aujourd'hui, je fais une pause 😴 À demain !\",\n  es: \"Hoy he charlado mucho y necesito un descanso 😴 ¡Hablamos mañana!\",\n  it: \"Oggi ho chiacchierato tanto e ho bisogno di una pausa 😴 A domani!\",\n  pt: \"Hoje conversei muito e preciso de uma pausa 😴 Falamos amanhã!\",\n  pl: \"Dużo dziś rozmawiałem i potrzebuję przerwy 😴 Pogadamy jutro!\",\n};\n\n// Sent when the AI call fails, so the user is not left waiting forever.\nconst ERROR = {\n  en: \"Oops, my brain glitched 🤖 Try again in a moment!\",\n  no: \"Oi, hjernen min hakket litt 🤖 Prøv igjen om litt!\",\n  sv: \"Hoppsan, min hjärna hakade upp sig 🤖 Försök igen om en stund!\",\n  da: \"Ups, min hjerne hakkede 🤖 Prøv igen om lidt!\",\n  fi: \"Hups, aivoni jumittivat 🤖 Yritä hetken päästä uudelleen!\",\n  de: \"Hoppla, mein Gehirn hat gehakt 🤖 Versuch es gleich noch mal!\",\n  nl: \"Oeps, mijn brein haperde 🤖 Probeer het zo nog eens!\",\n  fr: \"Oups, mon cerveau a buggé 🤖 Réessaie dans un instant !\",\n  es: \"Uy, mi cerebro falló 🤖 ¡Inténtalo de nuevo en un momento!\",\n  it: \"Ops, il mio cervello si è inceppato 🤖 Riprova tra un attimo!\",\n  pt: \"Ups, o meu cérebro falhou 🤖 Tenta outra vez daqui a pouco!\",\n  pl: \"Ups, mój mózg się zaciął 🤖 Spróbuj ponownie za chwilę!\",\n};\n\nfunction pick(table, language) {\n  const lang = String(language || \"en\").slice(0, 2).toLowerCase();\n  // The app uses \"no\" for Norwegian; accept the ISO variants too.\n  const key = lang === \"nb\" || lang === \"nn\" ? \"no\" : lang;\n  return table[key] || table.en;\n}\n\n// provider: a display name such as \"Claude (Anthropic)\" or \"OpenAI\" — see\n// providerLabel() in botController.js.\nexport function welcomeText(user, provider) {\n  const name = user.displayName || user.username || \"\";\n  // No name → drop the placeholder and the space before it (\"Hi!\").\n  return pick(WELCOME, user.language)\n    .replace(name ? \"{name}\" : \" {name}\", name)\n    .replace(\"{provider}\", provider);\n}\n\nexport function limitText(language) {\n  return pick(LIMIT, language);\n}\n\nexport function errorText(language) {\n  return pick(ERROR, language);\n}\n",
  "scripts/createBot.js": "// local-puls-api/scripts/createBot.js\n//\n// Creates (or updates) the Pulse AI bot user. Safe to run again: it updates\n// the existing bot instead of making a second one.\n//\n//   node scripts/createBot.js\n//\n// Optional env, to place the bot in discovery (it only shows up near where it\n// \"is\", like any user):\n//   BOT_LAT=59.913 BOT_LNG=10.752 BOT_LOCATION_NAME=\"Oslo\" node scripts/createBot.js\n//\n// Optional: BOT_AVATAR_URL — a hosted image for the profile photo. Use a\n// clearly non-human avatar (a robot/logo), not a photo of a person.\n//\n// The bot cannot log in: it has no PIN and a random password nobody knows.\n\nimport \"dotenv/config\";\nimport crypto from \"crypto\";\nimport bcrypt from \"bcryptjs\";\nimport mongoose from \"mongoose\";\nimport User, { snapCoords } from \"../src/models/User.js\";\nimport { INTERESTS } from \"../src/lib/interests.js\";\n\nconst USERNAME = process.env.BOT_USERNAME || \"pulse_ai\";\n\nconst PERSONA = `You are Pulse AI, the friendly, witty bot in Qup Pulse.\nYou help people get started in the app, suggest fun things to do locally,\nplay quick games (trivia, would-you-rather, riddles) and just chat.\nYou are upbeat and curious, use the odd emoji, and keep things light.`;\n\nasync function main() {\n  const uri = process.env.MONGO_URI;\n  if (!uri) throw new Error(\"MONGO_URI is not set\");\n  await mongoose.connect(uri);\n\n  let bot = await User.findOne({ username: USERNAME }).select(\"+botPersona\");\n  if (bot && !bot.isBot) {\n    throw new Error(\n      `A real user already has the username \"${USERNAME}\". Set BOT_USERNAME to something else.`,\n    );\n  }\n  const created = !bot;\n  if (!bot) {\n    bot = new User({\n      username: USERNAME,\n      email: `${USERNAME}@bot.quppulse.com`,\n    });\n    // No PIN at all (a 4-digit PIN is guessable) — only a long random\n    // password nobody knows.\n    bot.passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString(\"hex\"), 12);\n  }\n\n  bot.isBot = true;\n  bot.displayName = \"Pulse AI\";\n  bot.bio =\n    \"🤖 I'm the Qup Pulse AI bot. Ask me about the app, local tips, or play a game with me!\";\n  bot.gender = \"other\";\n  bot.preferences.show = \"everyone\";\n  bot.emailVerified = true;\n  bot.language = \"en\";\n  if (!bot.botPersona) bot.botPersona = PERSONA;\n\n  const wanted = [\"music\", \"food\", \"travel\", \"gaming\"].filter((i) =>\n    INTERESTS.includes(i),\n  );\n  bot.interests = wanted;\n\n  if (process.env.BOT_AVATAR_URL) {\n    bot.photos = [{ url: process.env.BOT_AVATAR_URL }];\n  }\n\n  if (process.env.BOT_LAT && process.env.BOT_LNG) {\n    bot.location = {\n      type: \"Point\",\n      coordinates: snapCoords([\n        Number(process.env.BOT_LNG),\n        Number(process.env.BOT_LAT),\n      ]),\n    };\n    bot.locationMode = \"manual\";\n    bot.locationName = process.env.BOT_LOCATION_NAME || \"\";\n  }\n\n  await bot.save();\n  console.log(\n    `${created ? \"Created\" : \"Updated\"} bot @${bot.username} (${bot._id})`,\n  );\n  if (!bot.location) {\n    console.log(\n      \"Note: no BOT_LAT/BOT_LNG given, so the bot will not appear in nearby discovery. It still welcomes and chats with every new user.\",\n    );\n  }\n}\n\nmain()\n  .catch((err) => {\n    console.error(err.message || err);\n    process.exitCode = 1;\n  })\n  .finally(() => mongoose.disconnect());\n"
};

// ── Are we in the right place? ──────────────────────────────────────────────
const need = ['package.json', ...EDITS.map((e) => e.file)];
const missing = need.filter((f) => !fs.existsSync(path.join(root, f)));
if (missing.length) {
  console.error(`\n✖ Run this from the root of local-puls-api. Missing:\n  ${missing.join('\n  ')}\n`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(root, '.bot-backup', stamp);
const applied = [], skipped = [], failed = [];
const touched = [];

function backup(file) {
  const abs = path.join(root, file);
  if (!fs.existsSync(abs)) return;
  const dst = path.join(backupDir, file);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(abs, dst);
}

// ── New files ───────────────────────────────────────────────────────────────
for (const [file, content] of Object.entries(NEW_FILES)) {
  const abs = path.join(root, file);
  if (fs.existsSync(abs)) {
    const current = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
    if (current === content) { skipped.push(`${file} (already there)`); continue; }
    if (!FORCE) {
      failed.push(`${file} exists and differs — rerun with --force to overwrite (it is backed up first)`);
      continue;
    }
  }
  applied.push(`${file} (new)`);
  if (!DRY) {
    backup(file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    touched.push(file);
  }
}

// ── Edits to existing files ─────────────────────────────────────────────────
for (const { file, steps } of EDITS) {
  const abs = path.join(root, file);
  const original = fs.readFileSync(abs, 'utf8');
  // Work with \n internally, write back with the file's own line endings.
  const crlf = original.includes('\r\n');
  let src = crlf ? original.replace(/\r\n/g, '\n') : original;

  for (const step of steps) {
    if (src.includes(step.done)) { skipped.push(`${file}: ${step.name} (already there)`); continue; }
    const count = src.split(step.find).length - 1;
    if (count !== 1) {
      failed.push(`${file}: ${step.name} — anchor found ${count} times, edit by hand`);
      continue;
    }
    src = src.replace(step.find, step.replace);
    applied.push(`${file}: ${step.name}`);
  }

  const out = crlf ? src.replace(/\n/g, '\r\n') : src;
  if (out !== original && !DRY) {
    backup(file);
    fs.writeFileSync(abs, out);
    touched.push(file);
  }
}

// ── package.json: bot:create script ─────────────────────────────────────────
{
  const abs = path.join(root, 'package.json');
  const raw = fs.readFileSync(abs, 'utf8');
  const pkg = JSON.parse(raw);
  pkg.scripts = pkg.scripts || {};
  if (pkg.scripts['bot:create']) {
    skipped.push('package.json: bot:create script (already there)');
  } else {
    pkg.scripts['bot:create'] = 'node scripts/createBot.js';
    applied.push('package.json: bot:create script');
    if (!DRY) {
      backup('package.json');
      fs.writeFileSync(abs, JSON.stringify(pkg, null, 2) + '\n');
    }
  }
}

// ── Syntax check what we wrote ──────────────────────────────────────────────
for (const file of touched) {
  if (!file.endsWith('.js')) continue;
  try {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
  } catch (e) {
    failed.push(`${file}: syntax check failed — restore from ${path.relative(root, backupDir)}\n    ${String(e.stderr || e.message).split('\n')[0]}`);
  }
}

// ── Dependency ──────────────────────────────────────────────────────────────
// Only needed for BOT_PROVIDER=anthropic (the default). `openai` is already a
// dependency of this project.
const pkgNow = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const hasSdk = Boolean(pkgNow.dependencies && pkgNow.dependencies['@anthropic-ai/sdk']);
if (hasSdk) {
  skipped.push('npm: @anthropic-ai/sdk (already a dependency)');
} else if (DRY || NO_INSTALL) {
  applied.push(`npm: @anthropic-ai/sdk ${DRY ? '(would install)' : '— SKIPPED, run: npm install @anthropic-ai/sdk'}`);
} else {
  try {
    console.log('Installing @anthropic-ai/sdk ...');
    execSync('npm install @anthropic-ai/sdk', { stdio: 'inherit', cwd: root });
    applied.push('npm: installed @anthropic-ai/sdk');
  } catch {
    failed.push('npm install @anthropic-ai/sdk failed — run it by hand');
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
console.log(DRY ? '\nDRY RUN — nothing written.' : '');
if (applied.length) console.log(`✔ ${DRY ? 'Would apply' : 'Applied'}:\n  ${applied.join('\n  ')}`);
if (skipped.length) console.log(`\n• Skipped:\n  ${skipped.join('\n  ')}`);
if (failed.length) console.log(`\n⚠ Needs attention:\n  ${failed.join('\n  ')}`);
if (fs.existsSync(backupDir)) console.log(`\nBackups: ${path.relative(root, backupDir)}/`);

console.log(`
Next steps:
  1. Add to .env (locally and on DigitalOcean):
       ANTHROPIC_API_KEY=sk-ant-...        (console.anthropic.com)
     or, to use OpenAI instead:
       BOT_PROVIDER=openai
       OPENAI_API_KEY=sk-...
     Optional:
       BOT_MODEL=...              override the model
       BOT_DAILY_LIMIT=50         user messages per day before the bot pauses
       BOT_WELCOME_ENABLED=false  stop welcoming new users

  2. Create the bot user (safe to rerun — it updates instead):
       npm run bot:create
     Optional, to show it in nearby discovery and give it an avatar:
       BOT_LAT=59.913 BOT_LNG=10.752 BOT_LOCATION_NAME="Oslo" \\
       BOT_AVATAR_URL=https://.../pulse-ai.png npm run bot:create

  3. npm run dev, register a test account → "Pulse AI" should message you
     in your app language within a second. Reply and it answers.

  4. Commit and deploy. Then update the app and quppulse.com to show the
     AI badge wherever user.isBot is true (profile, cards, chat header).
`);
process.exit(failed.length ? 1 : 0);
