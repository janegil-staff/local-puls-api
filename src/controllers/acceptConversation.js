// localpulse/server/src/controllers/acceptConversation — in chatController.js

// Recipient accepts a pending conversation → moves it to the main inbox.
export async function acceptConversation(req, res) {
  try {
    const { convo, status, error } = await loadVisibleConversation(req.params.id, req.userId);
    if (!convo) return res.status(status).json({ error });

    // Only the recipient (not the initiator) can accept.
    if (String(convo.initiator) === String(req.userId)) {
      return res.status(400).json({ error: 'You started this conversation' });
    }
    convo.status = 'accepted';
    await convo.save();

    // Tell the INITIATOR their request went through. Without this their open
    // thread page sits on a stale status: the composer stays locked and images
    // stay disabled until they happen to reload. Sent to the personal room, so
    // it reaches them on whatever page they're on, not just the thread.
    const io = req.app.get('io');
    if (io) {
      io.to(`user:${convo.initiator}`).emit('chat:accepted', {
        conversationId: String(convo._id),
        status: convo.status,
      });
    }

    return res.json({ ok: true, conversationId: convo._id, status: convo.status });
  } catch (err) {
    console.error('acceptConversation error', err);
    return res.status(500).json({ error: 'Could not accept conversation' });
  }
}