// localpulse/server/scripts/dedupe-conversations.cjs
//
// ONE-TIME migration. Run BEFORE the unique pairKey index can build, because
// the DB currently holds duplicate conversations for the same participant pair
// (created by the openConversation race). Steps:
//   1. Group conversations by sorted participant pair.
//   2. For each group, keep the OLDEST conversation as canonical.
//   3. Repoint every message from the duplicates to the canonical one.
//   4. Recompute the canonical's lastMessage/lastMessageAt/status.
//   5. Delete the now-empty duplicates.
//   6. Backfill pairKey on every surviving conversation.
//
// Idempotent: re-running after a clean pass finds no duplicates and only
// ensures pairKey is set. Usage:
//   MONGO_URI="mongodb+srv://..." node scripts/dedupe-conversations.cjs
//
// After this completes cleanly, deploy the model with the unique index.

const mongoose = require('mongoose');

const URI = "mongodb+srv://janstovr:fooBar83@cluster0.3dwqjjw.mongodb.net/local-pulse";
if (!URI) {
  console.error('Set MONGO_URI'); process.exit(1);
}

const pairKeyOf = (parts) => parts.map(String).sort().join('_');

(async () => {
  await mongoose.connect(URI);
  const db = mongoose.connection.db;
  const Conversations = db.collection('conversations');
  const Messages = db.collection('messages');

  const all = await Conversations.find({}).toArray();
  console.log(`Loaded ${all.length} conversations`);

  // Group by participant pair.
  const groups = new Map();
  for (const c of all) {
    const key = pairKeyOf(c.participants || []);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }

  let merged = 0;
  let deleted = 0;

  for (const [key, convos] of groups) {
    // Canonical = oldest by _id (creation order).
    convos.sort((a, b) => (a._id > b._id ? 1 : -1));
    const canonical = convos[0];
    const dupes = convos.slice(1);

    if (dupes.length > 0) {
      const dupeIds = dupes.map((d) => d._id);
      // Repoint messages from duplicates to canonical.
      const r = await Messages.updateMany(
        { conversation: { $in: dupeIds } },
        { $set: { conversation: canonical._id } },
      );
      merged += r.modifiedCount || 0;

      // Any accepted duplicate makes the merged conversation accepted.
      const anyAccepted = convos.some((c) => c.status === 'accepted');

      // Newest message across the merged set drives lastMessage*.
      const last = await Messages.find({ conversation: canonical._id })
        .sort({ createdAt: -1 }).limit(1).toArray();

      await Conversations.updateOne(
        { _id: canonical._id },
        {
          $set: {
            pairKey: key,
            status: anyAccepted ? 'accepted' : canonical.status,
            ...(last[0]
              ? { lastMessage: last[0].text || '📷', lastMessageAt: last[0].createdAt }
              : {}),
          },
        },
      );

      await Conversations.deleteMany({ _id: { $in: dupeIds } });
      deleted += dupeIds.length;
      console.log(`pair ${key}: kept ${canonical._id}, merged ${dupes.length} dupe(s), moved ${r.modifiedCount} msg(s)`);
    } else {
      // No duplicate — just ensure pairKey is set.
      if (canonical.pairKey !== key) {
        await Conversations.updateOne({ _id: canonical._id }, { $set: { pairKey: key } });
      }
    }
  }

  console.log(`\nDone. Repointed ${merged} messages, deleted ${deleted} duplicate conversations.`);
  console.log('You can now deploy the model with the unique pairKey index.');
  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
