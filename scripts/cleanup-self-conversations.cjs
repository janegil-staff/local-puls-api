// localpulse/server/scripts/cleanup-self-conversations.cjs
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) { console.error('No MONGO_URI in env'); process.exit(1); }
  await mongoose.connect(uri);
  console.log('Connected.');

  const db = mongoose.connection.db;
  const convos = db.collection('conversations');
  const messages = db.collection('messages');

  const all = await convos.find({}).toArray();
  const selfChats = all.filter((c) => {
    const ids = (c.participants || []).map((p) => String(p));
    return ids.length > 0 && new Set(ids).size === 1;
  });

  if (selfChats.length === 0) {
    console.log('No self-conversations found. Nothing to do.');
    await mongoose.disconnect();
    return;
  }

  console.log(`Found ${selfChats.length} self-conversation(s):`);
  selfChats.forEach((c) => console.log('  -', String(c._id), 'user', String(c.participants[0])));

  const convoIds = selfChats.map((c) => c._id);
  const msgResult = await messages.deleteMany({ conversation: { $in: convoIds } });
  console.log(`Deleted ${msgResult.deletedCount} message(s).`);
  const convoResult = await convos.deleteMany({ _id: { $in: convoIds } });
  console.log(`Deleted ${convoResult.deletedCount} conversation(s).`);

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch((err) => { console.error('Cleanup failed:', err); process.exit(1); });
