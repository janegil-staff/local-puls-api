// localpulse/server/src/controllers/chatController.sendMessage.js
//
// ⚠️ SCAFFOLD — merge this function into your existing chatController.js and
// export `sendMessage` alongside the others. Field names marked TODO must match
// your Conversation / Message schemas.
//
import mongoose from 'mongoose';
import Conversation from '../models/Conversation.js'; // TODO: confirm path/name
import Message from '../models/Message.js';           // TODO: confirm path/name

export async function sendMessage(req, res) {
  try {
    const { id } = req.params;          // conversation id
    const { text } = req.body;
    const me = req.user.id;             // TODO: confirm requireAuth sets req.user.id

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: 'Invalid conversation id' });
    }

    const convo = await Conversation.findById(id);
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });

    // Gate: sender must be a participant.
    // TODO: confirm participants field name (participants / members / users).
    const participants = (convo.participants || []).map((p) => String(p));
    if (!participants.includes(String(me))) {
      return res.status(403).json({ error: 'Not a participant' });
    }

    // Persist the message. THIS is the write that was missing.
    const message = await Message.create({
      conversation: convo._id,   // TODO: confirm FK field name
      sender: me,                // TODO: confirm sender field name
      text: text.trim(),
    });

    // Update conversation denormalized fields for list previews.
    convo.lastMessage = message._id;         // TODO: confirm field
    convo.lastMessageAt = message.createdAt; // TODO: confirm field
    convo.updatedAt = new Date();
    await convo.save();

    // Broadcast over socket to the conversation room. `io` is attached in server.js.
    const io = req.app.get('io');
    if (io) {
      io.to(`conversation:${convo._id}`).emit('message:new', {
        conversationId: String(convo._id),
        message: message.toJSON ? message.toJSON() : message,
      });
    }

    return res.status(201).json({ message });
  } catch (err) {
    // Do NOT swallow silently — this was likely the original bug.
    console.error('[sendMessage] failed:', err);
    return res.status(500).json({ error: 'Failed to send message' });
  }
}
