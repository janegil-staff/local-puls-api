// Run from local-pulse-api root: node fix-getmessages.cjs
const fs = require('fs');
const path = 'src/controllers/chatController.js';
let src = fs.readFileSync(path, 'utf8');

const oldBlock = `    const convo = await Conversation.findById(id);
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });
    if (!convo.participants.map((p) => String(p)).includes(me)) {
      return res.status(403).json({ error: 'Not a participant' });
    }

    const query = { conversation: id };
    if (before) query.createdAt = { $lt: new Date(before) };

    const docs = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 50, 100))
      .populate('sender');

    const messages = docs.reverse().map((m) => m.toClient());
    return res.json({ messages });`;

const newBlock = `    const convo = await Conversation.findById(id).populate('participants');
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });
    if (!convo.participants.map((p) => String(p._id)).includes(me)) {
      return res.status(403).json({ error: 'Not a participant' });
    }

    // The other participant — the chat header needs this to show name + avatar.
    // Deep-linking to /messages/:id doesn't load the list, so supply it here.
    const other = convo.participants.find((p) => String(p._id) !== me);
    const otherUser = other ? other.toPublic() : null;

    const query = { conversation: id };
    if (before) query.createdAt = { $lt: new Date(before) };

    const docs = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(limit) || 50, 100))
      .populate('sender');

    const messages = docs.reverse().map((m) => m.toClient());
    return res.json({
      messages,
      otherUser,
      user: otherUser,
      conversation: { id: String(convo._id), status: convo.status, initiator: String(convo.initiator) },
    });`;

if (!src.includes(oldBlock)) {
  console.error('❌ Could not find the getMessages block to replace. It may already be patched or differ.');
  process.exit(1);
}
src = src.replace(oldBlock, newBlock);
fs.writeFileSync(path, src);
console.log('✅ getMessages patched.');
