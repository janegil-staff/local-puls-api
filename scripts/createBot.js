// local-puls-api/scripts/createBot.js
//
// Creates (or updates) the Pulse AI bot user. Safe to run again: it updates
// the existing bot instead of making a second one.
//
//   node scripts/createBot.js
//
// Optional env, to place the bot in discovery (it only shows up near where it
// "is", like any user):
//   BOT_LAT=59.913 BOT_LNG=10.752 BOT_LOCATION_NAME="Oslo" node scripts/createBot.js
//
// Optional: BOT_BIO — profile description (max 300 characters).
//
// Optional: BOT_AVATAR_URL — a hosted image for the profile photo. Use a
// clearly non-human avatar (a robot/logo), not a photo of a person.
//
// The bot cannot log in: it has no PIN and a random password nobody knows.

import "dotenv/config";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import User, { snapCoords } from "../src/models/User.js";
import { INTERESTS } from "../src/lib/interests.js";

const USERNAME = process.env.BOT_USERNAME || "pulse_ai";

const DEFAULT_BIO =
  "🤖 Hi, I'm Pulse AI, the AI here in Qup Pulse. Ask me anything about the app, get tips on what's happening around you, or just chat when you're bored. I love good questions, bad jokes and late-night conversations. Always online, always an AI. ✨";

const PERSONA = `You are Pulse AI, the friendly, witty bot in Qup Pulse.
You help people get started in the app, suggest fun things to do locally,
play quick games (trivia, would-you-rather, riddles) and just chat.
You are upbeat and curious, use the odd emoji, and keep things light.`;

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI is not set");
  await mongoose.connect(uri);

  let bot = await User.findOne({ username: USERNAME }).select("+botPersona");
  if (bot && !bot.isBot) {
    throw new Error(
      `A real user already has the username "${USERNAME}". Set BOT_USERNAME to something else.`,
    );
  }
  const created = !bot;
  if (!bot) {
    bot = new User({
      username: USERNAME,
      email: `${USERNAME}@bot.quppulse.com`,
    });
    // No PIN at all (a 4-digit PIN is guessable) — only a long random
    // password nobody knows.
    bot.passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);
  }

  bot.isBot = true;
  bot.displayName = "Pulse AI";
  // Max 300 characters (User.bio). Override without editing: BOT_BIO="..."
  bot.bio = (process.env.BOT_BIO || DEFAULT_BIO).slice(0, 300);
  bot.gender = "other";
  bot.preferences.show = "everyone";
  bot.emailVerified = true;
  bot.language = "en";
  if (!bot.botPersona) bot.botPersona = PERSONA;

  const wanted = ["music", "food", "travel", "gaming"].filter((i) =>
    INTERESTS.includes(i),
  );
  bot.interests = wanted;

  if (process.env.BOT_AVATAR_URL) {
    bot.photos = [{ url: process.env.BOT_AVATAR_URL }];
  }

  if (process.env.BOT_LAT && process.env.BOT_LNG) {
    bot.location = {
      type: "Point",
      coordinates: snapCoords([
        Number(process.env.BOT_LNG),
        Number(process.env.BOT_LAT),
      ]),
    };
    bot.locationMode = "manual";
    bot.locationName = process.env.BOT_LOCATION_NAME || "";
  }

  await bot.save();
  console.log(
    `${created ? "Created" : "Updated"} bot @${bot.username} (${bot._id})`,
  );
  if (!bot.location) {
    console.log(
      "Note: no BOT_LAT/BOT_LNG given, so the bot will not appear in nearby discovery. It still welcomes and chats with every new user.",
    );
  }
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
