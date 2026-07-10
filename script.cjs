// localpulse/app/scripts/add-forgot-pin-i18n.cjs
//
// Adds the eight ForgotPinScreen keys to all 12 language objects in
// src/i18n/translations.js. Idempotent: a locale that already has a key is
// skipped, so re-running after a partial edit is safe.
//
//   node scripts/add-forgot-pin-i18n.cjs
//
// The file is a flat `const <lang> = { ... };` per language. Babel AST edit
// rather than regex, because the strings contain apostrophes and braces.

const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const FILE = path.join(__dirname, '..', 'src', 'i18n', 'translations.js');

// Keyed by language, then by string key. Every language is present.
const STRINGS = {
  no: {
    forgotPinExplain: 'Skriv inn e-posten din, så sender vi en 4-sifret kode for å tilbakestille PIN-koden.',
    sendCode: 'Send kode',
    resetCodeSent: 'Hvis e-posten er registrert, er en kode på vei. Skriv den inn under sammen med ny PIN.',
    resetCode: 'Tilbakestillingskode',
    resetCodeFourDigits: 'Koden er 4 siffer.',
    newPin: 'Ny PIN',
    resetPin: 'Tilbakestill PIN',
    resendCode: 'Send ny kode',
  },
  en: {
    forgotPinExplain: "Enter your email and we'll send you a 4-digit code to reset your PIN.",
    sendCode: 'Send code',
    resetCodeSent: 'If that email is registered, a code is on its way. Enter it below with your new PIN.',
    resetCode: 'Reset code',
    resetCodeFourDigits: 'The code is 4 digits.',
    newPin: 'New PIN',
    resetPin: 'Reset PIN',
    resendCode: 'Send a new code',
  },
  de: {
    forgotPinExplain: 'Gib deine E-Mail ein, und wir senden dir einen 4-stelligen Code, um deine PIN zurückzusetzen.',
    sendCode: 'Code senden',
    resetCodeSent: 'Wenn diese E-Mail registriert ist, ist ein Code unterwegs. Gib ihn unten mit deiner neuen PIN ein.',
    resetCode: 'Zurücksetzungscode',
    resetCodeFourDigits: 'Der Code hat 4 Ziffern.',
    newPin: 'Neue PIN',
    resetPin: 'PIN zurücksetzen',
    resendCode: 'Neuen Code senden',
  },
  da: {
    forgotPinExplain: 'Indtast din e-mail, så sender vi en 4-cifret kode til at nulstille din PIN.',
    sendCode: 'Send kode',
    resetCodeSent: 'Hvis e-mailen er registreret, er en kode på vej. Indtast den nedenfor sammen med din nye PIN.',
    resetCode: 'Nulstillingskode',
    resetCodeFourDigits: 'Koden er 4 cifre.',
    newPin: 'Ny PIN',
    resetPin: 'Nulstil PIN',
    resendCode: 'Send en ny kode',
  },
  sv: {
    forgotPinExplain: 'Ange din e-post, så skickar vi en 4-siffrig kod för att återställa din PIN.',
    sendCode: 'Skicka kod',
    resetCodeSent: 'Om e-postadressen är registrerad är en kod på väg. Ange den nedan tillsammans med din nya PIN.',
    resetCode: 'Återställningskod',
    resetCodeFourDigits: 'Koden är 4 siffror.',
    newPin: 'Ny PIN',
    resetPin: 'Återställ PIN',
    resendCode: 'Skicka en ny kod',
  },
  fi: {
    forgotPinExplain: 'Anna sähköpostisi, niin lähetämme 4-numeroisen koodin PIN-koodin nollaamiseen.',
    sendCode: 'Lähetä koodi',
    resetCodeSent: 'Jos sähköposti on rekisteröity, koodi on matkalla. Syötä se alle uuden PIN-koodin kanssa.',
    resetCode: 'Nollauskoodi',
    resetCodeFourDigits: 'Koodi on 4 numeroa.',
    newPin: 'Uusi PIN',
    resetPin: 'Nollaa PIN',
    resendCode: 'Lähetä uusi koodi',
  },
  fr: {
    forgotPinExplain: 'Saisissez votre e-mail et nous vous enverrons un code à 4 chiffres pour réinitialiser votre PIN.',
    sendCode: 'Envoyer le code',
    resetCodeSent: "Si cet e-mail est enregistré, un code est en route. Saisissez-le ci-dessous avec votre nouveau PIN.",
    resetCode: 'Code de réinitialisation',
    resetCodeFourDigits: 'Le code comporte 4 chiffres.',
    newPin: 'Nouveau PIN',
    resetPin: 'Réinitialiser le PIN',
    resendCode: 'Envoyer un nouveau code',
  },
  es: {
    forgotPinExplain: 'Introduce tu correo y te enviaremos un código de 4 dígitos para restablecer tu PIN.',
    sendCode: 'Enviar código',
    resetCodeSent: 'Si ese correo está registrado, un código está en camino. Introdúcelo abajo con tu nuevo PIN.',
    resetCode: 'Código de restablecimiento',
    resetCodeFourDigits: 'El código tiene 4 dígitos.',
    newPin: 'Nuevo PIN',
    resetPin: 'Restablecer PIN',
    resendCode: 'Enviar un código nuevo',
  },
  it: {
    forgotPinExplain: 'Inserisci la tua email e ti invieremo un codice a 4 cifre per reimpostare il PIN.',
    sendCode: 'Invia codice',
    resetCodeSent: "Se l'email è registrata, un codice è in arrivo. Inseriscilo qui sotto insieme al nuovo PIN.",
    resetCode: 'Codice di reimpostazione',
    resetCodeFourDigits: 'Il codice ha 4 cifre.',
    newPin: 'Nuovo PIN',
    resetPin: 'Reimposta PIN',
    resendCode: 'Invia un nuovo codice',
  },
  nl: {
    forgotPinExplain: 'Voer je e-mail in en we sturen je een 4-cijferige code om je pincode te resetten.',
    sendCode: 'Code versturen',
    resetCodeSent: 'Als dat e-mailadres bekend is, is een code onderweg. Voer die hieronder in met je nieuwe pincode.',
    resetCode: 'Resetcode',
    resetCodeFourDigits: 'De code is 4 cijfers.',
    newPin: 'Nieuwe pincode',
    resetPin: 'Pincode resetten',
    resendCode: 'Nieuwe code versturen',
  },
  pl: {
    forgotPinExplain: 'Podaj swój e-mail, a wyślemy 4-cyfrowy kod do zresetowania PIN-u.',
    sendCode: 'Wyślij kod',
    resetCodeSent: 'Jeśli ten e-mail jest zarejestrowany, kod jest w drodze. Wpisz go poniżej wraz z nowym PIN-em.',
    resetCode: 'Kod resetujący',
    resetCodeFourDigits: 'Kod ma 4 cyfry.',
    newPin: 'Nowy PIN',
    resetPin: 'Zresetuj PIN',
    resendCode: 'Wyślij nowy kod',
  },
  pt: {
    forgotPinExplain: 'Introduz o teu e-mail e enviamos-te um código de 4 dígitos para repor o PIN.',
    sendCode: 'Enviar código',
    resetCodeSent: 'Se esse e-mail estiver registado, um código está a caminho. Introduz-o abaixo com o teu novo PIN.',
    resetCode: 'Código de reposição',
    resetCodeFourDigits: 'O código tem 4 dígitos.',
    newPin: 'Novo PIN',
    resetPin: 'Repor PIN',
    resendCode: 'Enviar um novo código',
  },
};

const LANGS = Object.keys(STRINGS);

if (!fs.existsSync(FILE)) {
  console.error(`missing: ${FILE}`);
  process.exit(1);
}

const src = fs.readFileSync(FILE, 'utf8');
const ast = parser.parse(src, { sourceType: 'module' });

// Collect the `const <lang> = { ... }` object literals by declarator name.
const objects = {};
traverse(ast, {
  VariableDeclarator(p) {
    const name = t.isIdentifier(p.node.id) ? p.node.id.name : null;
    if (name && LANGS.includes(name) && t.isObjectExpression(p.node.init)) {
      objects[name] = p.node.init;
    }
  },
});

const missingLangs = LANGS.filter((l) => !objects[l]);
if (missingLangs.length) {
  console.error(`no object literal found for: ${missingLangs.join(', ')}`);
  process.exit(1);
}

let changed = 0;

for (const lang of LANGS) {
  const obj = objects[lang];
  const existing = new Set(
    obj.properties
      .filter((p) => t.isObjectProperty(p))
      .map((p) => (t.isIdentifier(p.key) ? p.key.name : p.key.value)),
  );

  const added = [];
  for (const [key, value] of Object.entries(STRINGS[lang])) {
    if (existing.has(key)) continue;
    obj.properties.push(t.objectProperty(t.identifier(key), t.stringLiteral(value)));
    added.push(key);
  }

  if (added.length) {
    changed += added.length;
    console.log(`  ${lang}: +${added.length} (${added.join(', ')})`);
  } else {
    console.log(`  ${lang}: up to date`);
  }
}

if (changed === 0) {
  console.log('\nNothing to do.');
  process.exit(0);
}

// jsescOption.minimal keeps æøå and accented characters as literal UTF-8
// rather than \uXXXX escapes.
const { code } = generate(ast, { jsescOption: { minimal: true } }, src);
fs.writeFileSync(FILE, code.endsWith('\n') ? code : `${code}\n`, 'utf8');

console.log(`\n${changed} key(s) added to ${path.relative(process.cwd(), FILE)}`);