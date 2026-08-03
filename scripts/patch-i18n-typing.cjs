// server/scripts/patch-i18n-typing.cjs
//
// Idempotent: adds the three typing keys to every locale file, skipping any
// that already exist. Safe to re-run. No .bak files — git is the safety net.
//
// Run: node scripts/patch-i18n-typing.cjs

const fs = require("fs");
const path = require("path");

const LOCALES_DIR = path.join(__dirname, "..", "src", "i18n", "locales");

const KEYS = {
  no: {
    chatTyping: "Skriver …",
    chatTypingNamed: "{name} skriver …",
    chatTypingSeveral: "Flere skriver …",
  },
  en: {
    chatTyping: "Typing …",
    chatTypingNamed: "{name} is typing …",
    chatTypingSeveral: "Several people are typing …",
  },
  nl: {
    chatTyping: "Aan het typen …",
    chatTypingNamed: "{name} is aan het typen …",
    chatTypingSeveral: "Meerdere mensen typen …",
  },
  fr: {
    chatTyping: "En train d'écrire …",
    chatTypingNamed: "{name} est en train d'écrire …",
    chatTypingSeveral: "Plusieurs personnes écrivent …",
  },
  de: {
    chatTyping: "Schreibt …",
    chatTypingNamed: "{name} schreibt …",
    chatTypingSeveral: "Mehrere Personen schreiben …",
  },
  it: {
    chatTyping: "Sta scrivendo …",
    chatTypingNamed: "{name} sta scrivendo …",
    chatTypingSeveral: "Più persone stanno scrivendo …",
  },
  sv: {
    chatTyping: "Skriver …",
    chatTypingNamed: "{name} skriver …",
    chatTypingSeveral: "Flera skriver …",
  },
  da: {
    chatTyping: "Skriver …",
    chatTypingNamed: "{name} skriver …",
    chatTypingSeveral: "Flere skriver …",
  },
  fi: {
    chatTyping: "Kirjoittaa …",
    chatTypingNamed: "{name} kirjoittaa …",
    chatTypingSeveral: "Useat kirjoittavat …",
  },
  es: {
    chatTyping: "Escribiendo …",
    chatTypingNamed: "{name} está escribiendo …",
    chatTypingSeveral: "Varias personas están escribiendo …",
  },
  pl: {
    chatTyping: "Pisze …",
    chatTypingNamed: "{name} pisze …",
    chatTypingSeveral: "Kilka osób pisze …",
  },
  pt: {
    chatTyping: "A escrever …",
    chatTypingNamed: "{name} está a escrever …",
    chatTypingSeveral: "Várias pessoas estão a escrever …",
  },
};

let touched = 0;
let skipped = 0;

Object.keys(KEYS).forEach((lang) => {
  const file = path.join(LOCALES_DIR, `${lang}.json`);
  if (!fs.existsSync(file)) {
    console.warn(`  ! missing locale file: ${lang}.json`);
    return;
  }

  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  let changed = false;

  Object.keys(KEYS[lang]).forEach((key) => {
    if (json[key] === undefined) {
      json[key] = KEYS[lang][key];
      changed = true;
    }
  });

  if (changed) {
    fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, "utf8");
    console.log(`  ✓ ${lang}.json updated`);
    touched += 1;
  } else {
    skipped += 1;
  }
});

console.log(`\nDone. ${touched} updated, ${skipped} already current.`);
