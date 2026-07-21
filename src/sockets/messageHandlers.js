// local-pulse-api/src/sockets/messageHandlers.js
export function registerMessageHandlers(io, socket) {
  socket.on('message:send', async ({ conversationId, text }) => {
    if (!text?.trim()) return;
    const msg = await saveMessage({ conversationId, senderId: socket.userId, text: text.trim() });
    io.to(conversationId).emit('message:new', msg.toPublic());
  });
}