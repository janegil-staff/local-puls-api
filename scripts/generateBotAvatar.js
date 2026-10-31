// local-puls-api/scripts/generateBotAvatar.js
//
// Generates profile-photo candidates for the Pulse AI bot with OpenAI's image
// model (the same one generateMissingUserPhotos.js uses), then sets the one
// you pick as the bot's photo.
//
//   1. Generate candidates (saved to ./bot-avatars/, nothing is uploaded):
//        node scripts/generateBotAvatar.js
//        node scripts/generateBotAvatar.js --count 6 --style 3d
//        node scripts/generateBotAvatar.js --extra "short silver hair"
//
//   2. Look at them, then upload your favourite and set it on the bot:
//        node scripts/generateBotAvatar.js --use bot-avatars/2026-10-31-1400-2.png
//
// Styles: painting (default) · 3d · flat
//
// Needs OPENAI_API_KEY and MONGO_URI; --use also uses your Cloudinary env
// (falls back to local uploads/ in dev, like every other upload).
//
// Cost: roughly USD 0.15–0.20 per high-quality 1024px image, so the default
// run of 4 is well under a dollar.

import "dotenv/config";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import OpenAI from "openai";
import sharp from "sharp";
import User from "../src/models/User.js";
import { uploadImage } from "../src/lib/cloudinary.js";

const OUT_DIR = path.resolve("bot-avatars");

const STYLES = {
  painting:
    "a polished semi-realistic digital painting with soft brush texture, like premium app or game character art",
  "3d": "a soft, high-quality stylized 3D character render with gentle subsurface lighting, friendly and modern",
  flat: "a clean modern vector-style illustration with smooth gradients and crisp shapes",
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function buildPrompt(style, extra) {
  return `
Profile picture for "Pulse AI", the friendly AI chat assistant inside a social app.

Subject: one androgynous adult (clearly over 25) whose face reads as neither
clearly a woman nor clearly a man — balanced features, soft but defined jaw,
calm warm eyes, a gentle closed-mouth smile. Medium-length tousled hair with a
side part, swept over one side. Simple dark crew-neck top. No makeup look, no
jewellery, no beard.

AI touch: subtle iridescent emerald-and-violet light reflections on the hair
and cheekbone, and a few very faint glowing lines near one temple, so it feels
like a digital being — tasteful, not robotic.

Style: ${STYLES[style] || STYLES.painting}. It must clearly look like an
illustration, NOT a photograph of a real person.

Composition: head and shoulders, centred, facing the viewer, face filling the
middle of the frame with space around the head so it still works when cropped
to a circle. Background: smooth gradient from emerald green (#10b981) to violet
(#7c3aed) with soft bokeh glow.
${extra ? `\nAlso: ${extra}.` : ""}

Rules: no text, letters, logos or watermarks. Not a public figure or any real,
identifiable person. Fully clothed, non-sexualised, friendly and approachable.
`.trim();
}

async function generate() {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
  const count = Math.min(Number(arg("count", 4)) || 4, 10);
  const style = arg("style", "painting");
  const prompt = buildPrompt(style, arg("extra", ""));

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");

  console.log(`Generating ${count} "${style}" candidates…`);
  // One request per image: n > 1 tends to return near-duplicates, and one
  // failure should not lose the others.
  const results = await Promise.allSettled(
    Array.from({ length: count }, () =>
      openai.images.generate({
        model: "gpt-image-1",
        prompt,
        size: "1024x1024",
        quality: "high",
        n: 1,
      }),
    ),
  );

  let saved = 0;
  results.forEach((r, i) => {
    if (r.status !== "fulfilled") {
      console.error(`  #${i + 1} failed: ${r.reason?.message || r.reason}`);
      return;
    }
    const b64 = r.value.data?.[0]?.b64_json;
    if (!b64) return console.error(`  #${i + 1} returned no image`);
    const file = path.join(OUT_DIR, `${stamp}-${i + 1}.png`);
    fs.writeFileSync(file, Buffer.from(b64, "base64"));
    console.log(`  saved ${path.relative(process.cwd(), file)}`);
    saved += 1;
  });

  if (saved) {
    console.log(
      `\nOpen the folder bot-avatars/, pick one, then:\n  node scripts/generateBotAvatar.js --use bot-avatars/${stamp}-1.png`,
    );
  }
}

async function use(file) {
  if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);
  if (!process.env.MONGO_URI) throw new Error("MONGO_URI is not set");

  // 512px JPEG: sharp enough for the largest avatar, light enough for lists.
  const buffer = await sharp(file)
    .resize(512, 512, { fit: "cover" })
    .jpeg({ quality: 88 })
    .toBuffer();

  await mongoose.connect(process.env.MONGO_URI);
  const bot = await User.findOne({ isBot: true }).sort({ createdAt: 1 });
  if (!bot) throw new Error("No bot user yet — run: npm run bot:create");

  const { url, publicId } = await uploadImage(buffer, "image/jpeg");
  bot.photos = [{ url, publicId }];
  await bot.save();
  console.log(`Set @${bot.username}'s photo:\n  ${url}`);
}

const chosen = arg("use", null);
(chosen ? use(chosen) : generate())
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
