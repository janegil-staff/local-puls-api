// local-puls-api/src/controllers/botController.js
//
// Pulse AI — the in-app bot. Logic only; the bot has NO routes of its own.
// It is an ordinary User (isBot: true) and talks through the existing chat:
//
//   sendBotWelcome()   called from authController.register — opens an
//                      accepted conversation with the new user and posts a
//                      fixed welcome (no AI call, so nothing about the user
//                      leaves the server until they reply).
//   maybeReplyAsBot()  called from chatController.persistMessage after every
//                      message — if the other participant is a bot, generates
//                      a reply with the AI provider and posts it.
//
// Both are fire-and-forget from the caller's point of view: they never throw,
// and the user's own request returns before the AI has answered.
//
// Env:
//   BOT_PROVIDER          "anthropic" (default) or "openai"
//   ANTHROPIC_API_KEY     when BOT_PROVIDER=anthropic
//   OPENAI_API_KEY        when BOT_PROVIDER=openai
//   BOT_MODEL             optional model override
//   BOT_DAILY_LIMIT       user messages per bot conversation per 24h (default 50)
//   BOT_WELCOME_ENABLED   "false" to stop welcoming new users (default on)

import Conversation, { buildPairKey } from "../models/Conversation.js";
import Message from "../models/Message.js";
import User from "../models/User.js";
import { welcomeText, limitText, errorText } from "../lib/botWelcome.js";

const PROVIDER = (process.env.BOT_PROVIDER || "anthropic").toLowerCase();
const DEFAULT_MODEL = {
  anthropic: "claude-haiku-5-5",
  // Check OpenAI's current model list and set BOT_MODEL if this is retired.
  openai: "gpt-4o-mini",
};
const MODEL = process.env.BOT_MODEL || DEFAULT_MODEL[PROVIDER];
const DAILY_LIMIT = Number(process.env.BOT_DAILY_LIMIT) || 50;
const HISTORY = 20; // messages of context sent to the model
const MAX_TOKENS = 400;
const MAX_TEXT = 2000; // Message.text maxlength

// Shown in the welcome message — the user is told who processes their text.
export function providerLabel() {
  return PROVIDER === "openai" ? "OpenAI" : "Claude (Anthropic)";
}

// Non-negotiable rules, appended after whatever persona is stored on the bot.
// The persona is editable data; these are not, so an edited persona can make
// the bot funnier but cannot make it claim to be human.
function systemPrompt(bot, user) {
  return [
    bot.botPersona ||
      "You are Pulse AI, a friendly and playful bot in the Qup Pulse app. Help people with the app, give local tips, play games and chat.",
    "",
    "Rules you must always follow:",
    "- You are an AI bot in Qup Pulse, a local social discovery app for adults. If anyone asks, say clearly that you are an AI. Never claim or imply that you are a human.",
    "- Never flirt, and never take part in romantic or sexual conversation or roleplay.",
    "- Never ask for personal information (full name, address, phone number, exact location, passwords, payment details).",
    "- Never agree to meet anyone, and never pretend to be somewhere.",
    "- If someone seems to be in danger or crisis, gently encourage them to contact local emergency services (112 in Norway and the EU) or someone they trust.",
    "- Keep replies short and chatty: usually 1–3 sentences, never more than about 80 words. Plain text, no markdown.",
    `- Reply in the language the user writes in. Their app language code is "${user.language || "en"}".`,
    `- The user's display name is "${user.displayName || user.username}".`,
  ].join("\n");
}

// ── Provider clients (lazy, so the unused SDK need not be installed) ──
let client = null;
async function getClient() {
  if (client) return client;
  if (PROVIDER === "openai") {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
    const { default: OpenAI } = await import("openai");
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  } else {
    if (!process.env.ANTHROPIC_API_KEY)
      throw new Error("ANTHROPIC_API_KEY not set");
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

async function generate(system, messages) {
  const ai = await getClient();
  if (PROVIDER === "openai") {
    const res = await ai.chat.completions.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: "system", content: system }, ...messages],
    });
    return res.choices?.[0]?.message?.content || "";
  }
  const res = await ai.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system,
    messages,
  });
  return (res.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// ── Helpers ───────────────────────────────────────────────────────────

// Post a message as the bot and broadcast it exactly like persistMessage does
// for a human sender: chat:message to the open thread, chat:notify to the
// user's other screens (inbox badge, list refresh).
async function postAsBot({ io, convo, bot, userId, text }) {
  const message = await Message.create({
    conversation: convo._id,
    sender: bot._id,
    text: String(text).trim().slice(0, MAX_TEXT),
    readBy: [bot._id],
  });

  convo.lastMessage = message.text;
  convo.lastMessageAt = message.createdAt;
  await convo.save();

  await message.populate("sender");
  const payload = message.toClient(String(userId));

  if (io) {
    io.to(`conversation:${convo._id}`).emit("chat:message", payload);
    io.to(`user:${userId}`).emit("chat:notify", {
      conversationId: String(convo._id),
    });
  }
  return message;
}

// The model needs strictly alternating turns that start with the user. Our
// thread is free-form (the bot opened with the welcome; a user may send three
// messages in a row), so merge runs of the same role and drop anything before
// the first user turn.
function toModelMessages(history, botId) {
  const out = [];
  for (const m of history) {
    const role = String(m.sender) === String(botId) ? "assistant" : "user";
    const content = m.text?.trim() || (m.imageUrl ? "[sent a photo]" : "");
    if (!content) continue;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n${content}`;
    else out.push({ role, content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

// One reply at a time per conversation. If the user sends more while the bot
// is "typing", answer once more afterwards (covering everything they sent)
// rather than firing one AI call per message.
const busy = new Map(); // conversationId -> { again: boolean }

// ── Welcome a new user ────────────────────────────────────────────────
export async function sendBotWelcome({ io, user }) {
  try {
    if (process.env.BOT_WELCOME_ENABLED === "false") return;
    if (!user || user.isBot) return;

    const bot = await User.findOne({ isBot: true, banned: false })
      .sort({ createdAt: 1 })
      .select("_id");
    if (!bot) return; // no bot created yet — run scripts/createBot.js

    let convo;
    try {
      // Accepted, not pending: the welcome should land in Messages, not in
      // Requests where it would wait for the user to accept a bot.
      convo = await Conversation.create({
        participants: [bot._id, user._id],
        pairKey: buildPairKey(bot._id, user._id),
        status: "accepted",
        initiator: bot._id,
      });
    } catch (err) {
      if (err?.code === 11000) return; // already welcomed
      throw err;
    }

    await postAsBot({
      io,
      convo,
      bot,
      userId: user._id,
      text: welcomeText(user, providerLabel()),
    });
  } catch (err) {
    console.error("[bot] welcome failed:", err);
  }
}

// ── Reply when a user writes to a bot ─────────────────────────────────
export async function maybeReplyAsBot({ io, conversationId, senderId }) {
  const key = String(conversationId);
  let owner = false; // only the call that took the lock may release it
  try {
    const convo = await Conversation.findById(conversationId);
    if (!convo) return;

    const otherId = convo.participants
      .map(String)
      .find((p) => p !== String(senderId));
    if (!otherId) return;

    const bot = await User.findOne({
      _id: otherId,
      isBot: true,
      banned: false,
    }).select("+botPersona");
    if (!bot) return; // a normal human conversation — nothing to do

    if (busy.has(key)) {
      busy.get(key).again = true;
      return;
    }
    busy.set(key, { again: false });
    owner = true;

    const user = await User.findById(senderId).select(
      "displayName username language",
    );
    if (!user) return;

    // Daily cap, counted from the user's own messages so it cannot drift.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const sentToday = await Message.countDocuments({
      conversation: convo._id,
      sender: senderId,
      createdAt: { $gte: since },
    });
    if (sentToday > DAILY_LIMIT) {
      // Tell them once, at the message that crosses the line; stay quiet after.
      if (sentToday === DAILY_LIMIT + 1) {
        await postAsBot({
          io,
          convo,
          bot,
          userId: senderId,
          text: limitText(user.language),
        });
      }
      return;
    }

    // Message ids the model has already answered. A message the user sends
    // while the bot is generating is saved BEFORE the bot's reply, so by
    // timestamp it sits in the middle of the thread; on the follow-up pass it
    // is moved to the end so the model answers it instead of seeing its own
    // reply as the last word.
    let seen = null;
    let again = true;
    while (again) {
      busy.get(key).again = false;

      // "Typing…" while the AI works. Re-sent every 2.5 s because the clients
      // hide the dots after a few seconds and a reply can take longer.
      const typing = () =>
        io?.to(`conversation:${convo._id}`).emit("chat:typing", {
          userId: String(bot._id),
        });
      typing();
      const typingTimer = setInterval(typing, 2500);

      // Same visibility rules as the user's thread: nothing retracted,
      // removed by a moderator, or hidden by the user goes to the model.
      const recent = await Message.find({
        conversation: convo._id,
        retractedAt: { $exists: false },
        "removedByAdmin.at": { $exists: false },
        hiddenFor: { $ne: senderId },
      })
        .sort({ createdAt: -1 })
        .limit(HISTORY)
        .select("_id sender text imageUrl")
        .lean();

      let ordered = recent.reverse(); // oldest first
      if (seen) {
        const isNew = (m) =>
          String(m.sender) !== String(bot._id) && !seen.has(String(m._id));
        ordered = [
          ...ordered.filter((m) => !isNew(m)),
          ...ordered.filter(isNew),
        ];
      }
      seen = new Set(ordered.map((m) => String(m._id)));

      const messages = toModelMessages(ordered, bot._id);
      if (!messages.length) {
        clearInterval(typingTimer);
        break;
      }

      let text;
      try {
        text = await generate(systemPrompt(bot, user), messages);
      } catch (err) {
        console.error("[bot] AI call failed:", err?.message || err);
        text = errorText(user.language);
      } finally {
        clearInterval(typingTimer);
      }
      if (text?.trim()) {
        await postAsBot({ io, convo, bot, userId: senderId, text });
      }

      again = busy.get(key).again;
    }
  } catch (err) {
    console.error("[bot] reply failed:", err);
  } finally {
    if (owner) busy.delete(key);
  }
}
