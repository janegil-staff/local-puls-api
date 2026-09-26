#!/usr/bin/env node
// apply-calls-api.cjs
//
// Turns on 1:1 calling in local-puls-api. Additive only: existing REST routes
// and socket events are untouched, so the web and Android clients keep
// working exactly as before.
//
//   1. src/socket/index.js        register the call:* socket handlers
//   2. src/routes/index.js        mount /calls (ice-servers, recent, ...)
//   3. src/sockets/callHandlers.js  refuse calls between blocked users
//
//   node apply-calls-api.cjs            run from the API root
//   node apply-calls-api.cjs --dry-run  show what would change
//
// Backs up every file it touches to .calls-backup/<timestamp>/. Safe to run
// twice — edits already in place are skipped.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DRY = process.argv.includes('--dry-run');
const root = process.cwd();

const EDITS = [
  {
    file: 'src/socket/index.js',
    steps: [
      {
        name: 'import registerCallHandlers',
        done: 'import registerCallHandlers from "../sockets/callHandlers.js";',
        find: 'import { config } from "../config/index.js";\n',
        replace:
          'import { config } from "../config/index.js";\n' +
          'import registerCallHandlers from "../sockets/callHandlers.js";\n',
      },
      {
        name: 'register call handlers on connection',
        done: 'registerCallHandlers(io, socket);',
        find: '    socket.join(userRoom(userId));\n',
        replace:
          '    socket.join(userRoom(userId));\n' +
          '\n' +
          '    // 1:1 call signaling (call:invite / accept / offer / answer / ice / end).\n' +
          '    // Only adds new call:* events — nothing existing changes, so clients that\n' +
          "    // don't call are unaffected.\n" +
          '    registerCallHandlers(io, socket);\n',
      },
    ],
  },
  {
    file: 'src/routes/index.js',
    steps: [
      {
        name: 'mount /calls',
        done: 'router.use("/calls", callRoutes);',
        find: 'router.use("/admin", adminRoutes);\n',
        replace:
          'router.use("/admin", adminRoutes);\n' +
          'router.use("/calls", callRoutes); // /calls/ice-servers, /calls/recent, ...\n',
      },
    ],
  },
  {
    file: 'src/sockets/callHandlers.js',
    steps: [
      {
        name: 'import blockedBetween',
        done: 'import { blockedBetween } from "../lib/blocks.js";',
        find: 'import { createIceServers } from "../services/turnService.js";\n',
        replace:
          'import { createIceServers } from "../services/turnService.js";\n' +
          'import { blockedBetween } from "../lib/blocks.js";\n',
      },
      {
        name: 'refuse calls between blocked users',
        done: 'await blockedBetween(userId, calleeId)',
        find:
          '    // TODO(moderation): also reject when either side has blocked the other, or\n' +
          '    // when the conversation is under moderation hold. Wire to the same helper\n' +
          '    // the message send path uses.\n',
        replace:
          '    // Either side blocked the other → no call. Same helper as the rest of the API.\n' +
          '    if (await blockedBetween(userId, calleeId)) {\n' +
          '      return fail(ack, ERRORS.NOT_ALLOWED, "Calls are not available here.");\n' +
          '    }\n',
      },
    ],
  },
];

// ── Sanity: are we in the API? ──────────────────────────────────────────────
const need = ['package.json', 'src/socket/index.js', 'src/routes/index.js', 'src/sockets/callHandlers.js',
  'src/routes/call.routes.js', 'src/lib/blocks.js', 'src/services/turnService.js'];
const missing = need.filter((f) => !fs.existsSync(path.join(root, f)));
if (missing.length) {
  console.error(`\n✖ Run this from the root of local-puls-api. Missing:\n  ${missing.join('\n  ')}\n`);
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(root, '.calls-backup', stamp);
const applied = [], skipped = [], failed = [];
const touched = [];

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
    const dst = path.join(backupDir, file);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(abs, dst);
    fs.writeFileSync(abs, out);
    touched.push(file);
  }
}

// ── Syntax check what we wrote ──────────────────────────────────────────────
for (const file of touched) {
  try {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
  } catch (e) {
    failed.push(`${file}: syntax check failed — restore from ${path.relative(root, backupDir)}\n    ${String(e.stderr || e.message).split('\n')[0]}`);
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
console.log(DRY ? '\nDRY RUN — nothing written.' : '');
if (applied.length) console.log(`✔ ${DRY ? 'Would apply' : 'Applied'}:\n  ${applied.join('\n  ')}`);
if (skipped.length) console.log(`\n• Skipped:\n  ${skipped.join('\n  ')}`);
if (failed.length) console.log(`\n⚠ Needs attention:\n  ${failed.join('\n  ')}`);
if (touched.length) console.log(`\nBackups: ${path.relative(root, backupDir)}/`);

console.log(`
Next steps:
  1. npm run dev (or start) — on connect you should still see "[socket] connected ..."
  2. Quick check (with a real token):
       curl -H "Authorization: Bearer <token>" https://<api-host>/api/calls/ice-servers
     → { iceServers: [...], relayAvailable: false }   (true once TURN is set)
  3. Commit and deploy.
  4. Optional, for calls over mobile data — set on DigitalOcean:
       TURN_URLS=turn:<host>:3478?transport=udp,turns:<host>:5349?transport=tcp
       TURN_STATIC_AUTH_SECRET=<same secret as static-auth-secret in turnserver.conf>
`);
process.exit(failed.length ? 1 : 0);
