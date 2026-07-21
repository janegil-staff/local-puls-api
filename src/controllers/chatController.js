// localpulse/server/src/controllers/chatController.acceptConversation.js
//
// ⚠️ SCAFFOLD — merge this into your existing chatController.js, replacing the
// current acceptConversation export. Only the RECIPIENT (not the initiator) can
// accept, and only a pending conversation. On success, status flips to
// 'accepted' and both participants are notified over the socket so their UI
// unlocks without a manual refresh.
//
import mongoose from 'mongoose';
import Conversation from '../models/Conversation.js';

export async function acceptConversation(req, res) {
  try {
    const { id } = req.params;
    const me = String(req.user.id || req.user.sub); // requireAuth sets one of these

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: 'Invalid conversation id' });
    }

    const convo = await Conversation.findById(id);
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });

    const participants = convo.participants.map((p) => String(p));
    if (!participants.includes(me)) {
      return res.status(403).json({ error: 'Not a participant' });
    }

    // The initiator can't accept their own request — only the recipient can.
    if (String(convo.initiator) === me) {
      return res.status(400).json({ error: 'Cannot accept your own request' });
    }

    // Idempotent: accepting an already-accepted convo is a no-op success, so a
    // double-tap or retry doesn't 400.
    if (convo.status !== 'accepted') {
      convo.status = 'accepted';
      await convo.save();
    }

    // Notify both sides so the input unlocks live. The client listens on
    // chat:accepted and clears its "Venter på godkjenning" gate.
    const io = req.app.get('io');
    if (io) {
      participants.forEach((p) =>
        io.to(`user:${p}`).emit('chat:accepted', { conversationId: String(convo._id) })
      );
    }

    return res.json({ ok: true, status: convo.status, conversationId: String(convo._id) });
  } catch (err) {
    console.error('[acceptConversation] failed:', err);
    return res.status(500).json({ error: 'Failed to accept conversation' });
  }
}


export async function acceptConversation(req, res) {
  try {
    const { id } = req.params;
    const me = String(req.user.id || req.user.sub); // requireAuth sets one of these
 
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: 'Invalid conversation id' });
    }
 
    const convo = await Conversation.findById(id);
    if (!convo) return res.status(404).json({ error: 'Conversation not found' });
 
    const participants = convo.participants.map((p) => String(p));
    if (!participants.includes(me)) {
      return res.status(403).json({ error: 'Not a participant' });
    }
 
    // The initiator can't accept their own request — only the recipient can.
    if (String(convo.initiator) === me) {
      return res.status(400).json({ error: 'Cannot accept your own request' });
    }
 
    // Idempotent: accepting an already-accepted convo is a no-op success, so a
    // double-tap or retry doesn't 400.
    if (convo.status !== 'accepted') {
      convo.status = 'accepted';
      await convo.save();
    }
 
    // Notify both sides so the input unlocks live. The client listens on
    // chat:accepted and clears its "Venter på godkjenning" gate.
    const io = req.app.get('io');
    if (io) {
      participants.forEach((p) =>
        io.to(`user:${p}`).emit('chat:accepted', { conversationId: String(convo._id) })
      );
    }
 
    return res.json({ ok: true, status: convo.status, conversationId: String(convo._id) });
  } catch (err) {
    console.error('[acceptConversation] failed:', err);
    return res.status(500).json({ error: 'Failed to accept conversation' });
  }
}