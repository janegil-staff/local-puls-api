// localpulse/api/src/socket/index.js
//
// Socket.IO setup: authentication, rooms, and chat handlers.
//
// Sockets are an OPTIMISATION here, not the transport of record. Every
// action below must also exist as a REST endpoint, because mobile sockets
// drop constantly — Android suspends them on background, iOS kills them on
// network change, and a user walking from wifi to cellular loses the
// connection mid-sentence. If a message can only be sent over a socket,
// it will sometimes not be sent at all.

import jwt from "jsonwebtoken";
import { Server } from "socket.io";

// A user may have several devices connected at once, so messages are
// emitted to a per-user room rather than to a single socket id.
const userRoom = (userId) => `user:${userId}`;

export function attachSockets(httpServer) {
  const io = new Server(httpServer, {
    path: process.env.SOCKET_PATH || "/socket.io",

    cors: {
      origin: (process.env.CLIENT_ORIGINS || "").split(",").filter(Boolean),
      credentials: true,
    },

    // Mobile keepalive. The defaults (25s interval, 20s timeout) are tuned
    // for desktop browsers and are too aggressive for phones: a backgrounded
    // app misses one heartbeat and gets dropped, which is the "ping timeout"
    // in the logs. Longer windows mean a briefly backgrounded app survives.
    //
    // The ceiling is your proxy's idle timeout — pingInterval must stay
    // comfortably below it or the proxy closes a connection the app still
    // believes is alive.
    pingInterval: 25_000,
    pingTimeout: 60_000,

    // Lets a client that reconnects within this window resume its session
    // and receive the packets it missed, instead of starting cold and
    // silently losing messages that arrived while it was backgrounded.
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      skipMiddlewares: false,
    },

    // Allow the polling fallback. Some corporate and mobile networks block
    // WebSocket upgrades outright, and polling is slower but works.
    transports: ["websocket", "polling"],

    maxHttpBufferSize: 1e6,
  });

  // -------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------
  //
  // The client must pass the token as a FUNCTION, not a static object:
  //
  //   io(url, { auth: (cb) => cb({ token: getToken() }) })
  //
  // With a static { token }, the value is captured once at connect time and
  // reused on every reconnect — so after a token refresh the socket keeps
  // presenting the old one and reconnects fail silently while REST keeps
  // working. That mismatch is miserable to debug from the client side.
  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace(/^Bearer /, "");

    if (!token) return next(new Error("unauthorized"));

    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      socket.data.userId = String(payload.userId || payload.id);
      socket.data.role = payload.role;
      next();
    } catch {
      // Distinct message so the client can tell "log in again" apart from
      // "network is down" and avoid an infinite reconnect loop.
      next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const { userId } = socket.data;

    socket.join(userRoom(userId));

    console.log(
      `[socket] connected ${socket.id} user ${userId}` +
        (socket.recovered ? " (recovered)" : ""),
    );

    // ---------------------------------------------------------------
    // Conversations
    // ---------------------------------------------------------------

    // Joining a conversation room is presence only — it must never be the
    // authority on who may read it. Membership is checked server-side on
    // every send, because a client can emit any conversation id it likes.
    socket.on("conversation:join", (conversationId) => {
      if (typeof conversationId !== "string") return;
      socket.join(`conversation:${conversationId}`);
    });

    socket.on("conversation:leave", (conversationId) => {
      if (typeof conversationId !== "string") return;
      socket.leave(`conversation:${conversationId}`);
    });

    // ---------------------------------------------------------------
    // Chat
    // ---------------------------------------------------------------
    //
    // The handler is deliberately thin: it validates, delegates to the same
    // service the REST endpoint uses, and acknowledges. Duplicating send
    // logic between socket and REST is how the two drift apart and start
    // disagreeing about what was delivered.
    socket.on("chat:send", async (payload, ack) => {
      try {
        const { conversationId, body, clientId } = payload || {};

        if (typeof conversationId !== "string" || !String(body || "").trim()) {
          return ack?.({ ok: false, error: "invalid_payload" });
        }

        // TODO: wire to the shared service, e.g.
        //   const message = await sendMessage({
        //     senderId: userId, conversationId, body, clientId,
        //   });
        // It must verify the sender is a participant and enforce the
        // pending-request limit before writing.
        const message = null;

        if (!message) return ack?.({ ok: false, error: "not_implemented" });

        io.to(`conversation:${conversationId}`).emit("chat:message", message);

        for (const participantId of message.participantIds || []) {
          if (String(participantId) === userId) continue;
          io.to(userRoom(participantId)).emit("chat:notify", {
            conversationId,
            messageId: message._id,
          });
        }

        // clientId is echoed back so the app can match this against its
        // optimistic local message and de-duplicate. Without it, a message
        // sent over the socket and then retried over REST appears twice.
        ack?.({ ok: true, message, clientId });
      } catch (error) {
        console.error("[socket] chat:send failed", error);
        ack?.({ ok: false, error: "server_error" });
      }
    });

    socket.on("chat:read", async ({ conversationId } = {}, ack) => {
      try {
        if (typeof conversationId !== "string") {
          return ack?.({ ok: false, error: "invalid_payload" });
        }

        // TODO: mark read via the shared service, then broadcast so the
        // sender's unread badge clears on their other devices too.
        socket.to(`conversation:${conversationId}`).emit("chat:read", {
          conversationId,
          userId,
        });

        ack?.({ ok: true });
      } catch (error) {
        console.error("[socket] chat:read failed", error);
        ack?.({ ok: false, error: "server_error" });
      }
    });

    // Typing indicators are fire-and-forget. Never persist them and never
    // acknowledge them — they are worthless a second later.
    socket.on("chat:typing", ({ conversationId, typing } = {}) => {
      if (typeof conversationId !== "string") return;
      socket.to(`conversation:${conversationId}`).emit("chat:typing", {
        conversationId,
        userId,
        typing: !!typing,
      });
    });

    socket.on("disconnect", (reason) => {
      console.log(`[socket] disconnect ${socket.id} ${reason}`);
    });
  });

  return io;
}

// Lets REST controllers push to sockets after a write, so a message sent
// over REST still arrives instantly for anyone who is connected.
//
//   import { emitToUser } from '../socket/index.js';
//   emitToUser(req.app.get('io'), recipientId, 'chat:notify', payload);
export function emitToUser(io, userId, event, payload) {
  if (!io) return;
  io.to(userRoom(String(userId))).emit(event, payload);
}

export { userRoom };
