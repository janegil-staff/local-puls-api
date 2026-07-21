// localpulse/server/scripts/inspect-conversation.cjs
//
// Inspect one conversation's status/initiator/participants + its message count
// per sender. Use to debug the "still pending after accept" bug.
//
// Run:  node scripts/inspect-conversation.cjs <conversationId>
//
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  const id = process.argv[2];
  if (!id) { console.error('Usage: node scripts/inspect-conversation.cjs <conversationId>'); process.exit(1); }

  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error('No MONGO_URI in env'); process.exit(1); }
  await mongoose.connect(uri);

  const db = mongoose.connection.db;
  let _id;
  try { _id = new mongoose.Types.ObjectId(id); }
  catch { console.error('Invalid conversation id'); process.exit(1); }

  const convo = await db.collection('conversations').findOne({ _id });
  if (!convo) { console.log('No conversation with that id.'); await mongoose.disconnect(); return; }

  console.log('\n=== Conversation ===');
  console.log('id:          ', String(convo._id));
  console.log('status:      ', convo.status, convo.status === 'pending' ? '  <-- STILL PENDING' : '');
  console.log('initiator:   ', String(convo.initiator));
  console.log('participants:', (convo.participants || []).map(String));

  // Who is the recipient (non-initiator)?
  const recipient = (convo.participants || []).map(String).find((p) => p !== String(convo.initiator));
  console.log('recipient:   ', recipient, '(this is who must accept)');

  // Message count per sender.
  const msgs = await db.collection('messages')
    .find({ conversation: _id }).project({ sender: 1 }).toArray();
  const perSender = {};
  for (const m of msgs) { const k = String(m.sender); perSender[k] = (perSender[k] || 0) + 1; }
  console.log('\n=== Messages per sender ===');
  console.log(perSender);
  console.log('total messages:', msgs.length);

  console.log('\n=== Diagnosis ===');
  if (convo.status === 'pending') {
    console.log('Conversation is PENDING. If the recipient already tapped Accept,');
    console.log('the accept call FAILED or hit the wrong conversation — status never saved.');
    console.log('Check: does the accept API return 200? Is the recipient (not initiator) accepting?');
  } else {
    console.log('Conversation is ACCEPTED. The pending gate should be skipped on send.');
    console.log('If sends are still blocked, the client is holding stale state or hitting');
    console.log('an old server build. Restart the app / confirm the deploy.');
  }

  await mongoose.disconnect();
}

main().catch((err) => { console.error('Inspect failed:', err); process.exit(1); });
