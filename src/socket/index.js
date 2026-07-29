// localpulse/server/src/socket/index.js
//
// Socket.IO setup: authentication, rooms, and live relays.
//
// THE ONLY SOCKET FILE. socket/chat.js was a second registration with its own
// io.use() and connection handler — two auth middlewares, two joins, two
// disconnect logs, and one of them reading the wrong JWT claim. Delete it.
//
// Sockets are an OPTIMISATION here, not the transport of record. Persistence
// lives in chatController.js: the client sends over REST, the controller
// persists and then broadcasts. There is deliberately no chat:send handler —
// it was a second, divergent write path, and emit() into a disconnected socket
// is silently dropped, which is how Android lost messages.

import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import Conversation from "../models/Conversation.js";
import { config } from "../config/index.js";

// A user may have several devices connected at once, so events are emitted to
// a per-user room rather than to a single socket id.
const userRoom = (userId) => `user:${userId}`;

export function attachSockets(httpServer) {
  const io = new Server(httpServer, {
    path: process.env.SOCKET_PATH || "/socket.io",

    cors: {
      origin: config.clientOrigins,
      credentials: true,
    },

    // Mobile keepalive. The defaults (25s interval, 20s timeout) are tuned for
    // desktop browsers and are too aggressive for phones: a backgrounded app
    // misses one heartbeat and gets dropped — the "ping timeout" in the logs.
    //
    // The ceiling is the proxy's idle timeout; pingInterval must stay
    // comfortably below it or the proxy closes a connection the app still
    // believes is alive.
    pingInterval: 25_000,
    pingTimeout: 60_000,

    // Lets a client reconnecting within this window resume and receive the
    // packets it missed, instead of starting cold and silently losing whatever
    // arrived while it was backgrounded.
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000,
      skipMiddlewares: false,
    },

    // Polling fallback: some mobile and corporate networks block WebSocket
    // upgrades outright.
    transports: ["websocket", "polling"],

    maxHttpBufferSize: 1e6,
  });

  // -------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------
  //
  // signToken() in middleware/auth.js puts the id in the standard `sub`
  // claim. Reading only payload.userId or payload.id yields undefined — the
  // socket then joins `user:undefined`, looks perfectly connected, and never
  // receives anything addressed to that user. That single line broke the
  // unread badge, the message-request badge, chat:accepted and follow
  // notifications simultaneously, with no error anywhere.
  //
  // Hence the explicit guard: a socket with no resolvable user is rejected
  // rather than allowed to sit in a room nobody can reach.
  //
  // Client note: pass the token as a FUNCTION, not a static object —
  //   io(url, { auth: (cb) => cb({ token: getToken() }) })
  // A static { token } is captured once at connect time and reused on every
  // reconnect, so after a token refresh the socket keeps presenting the old
  // one and reconnects fail while REST carries on working.
  io.use((socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      socket.handshake.headers?.authorization?.replace(/^Bearer /, "");

    if (!token) return next(new Error("unauthorized"));

    try {
      const payload = jwt.verify(token, config.jwtSecret);
      const userId = payload.sub || payload.id || payload.userId;

      if (!userId) {
        console.error("[socket auth] token has no user id claim");
        return next(new Error("unauthorized"));
      }

      socket.userId = String(userId);
      socket.data.userId = socket.userId; // both, so either style reads it
      return next();
    } catch (err) {
      // Distinct message so the client can tell "log in again" apart from
      // "network is down" and avoid an infinite reconnect loop.
      console.error("[socket auth] failed:", err.message);
      return next(new Error("unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.userId;

    socket.join(userRoom(userId));

    console.log(
      `[socket] connected ${socket.id} user ${userId}` +
        (socket.recovered ? " (recovered)" : ""),
    );

    // ---------------------------------------------------------------
    // Conversation rooms
    // ---------------------------------------------------------------
    //
    // Membership is verified against the database. Joining is presence only
    // and must never be the authority on who may read a thread — a client can
    // emit any conversation id it likes — but an unverified join would let
    // someone receive every message and typing event in a thread they are not
    // part of.
    async function joinConversation(conversationId, ack) {
      try {
        if (!conversationId) return ack?.({ error: "Missing conversation ID" });

        const convo = await Conversation.findOne({
          _id: conversationId,
          participants: userId,
        }).select("_id");

        if (!convo) {
          return ack?.({ error: "Conversation not found or access denied" });
        }

        await socket.join(`conversation:${conversationId}`);
        return ack?.({ ok: true });
      } catch (err) {
        console.error("[socket join] failed:", err);
        return ack?.({ error: "Server error" });
      }
    }

    function leaveConversation(conversationId) {
      if (conversationId) socket.leave(`conversation:${conversationId}`);
    }

    // Two event names for the same thing: the app emits chat:join, and
    // conversation:join exists for anything written against the other
    // convention. Keeping both costs nothing and avoids a silent no-op if a
    // client uses the name this file does not implement.
    socket.on("chat:join", ({ conversationId } = {}, ack) =>
      joinConversation(conversationId, ack),
    );
    socket.on("conversation:join", (arg, ack) =>
      joinConversation(
        typeof arg === "string" ? arg : arg?.conversationId,
        ack,
      ),
    );

    socket.on("chat:leave", ({ conversationId } = {}) =>
      leaveConversation(conversationId),
    );
    socket.on("conversation:leave", (arg) =>
      leaveConversation(typeof arg === "string" ? arg : arg?.conversationId),
    );

    // ---------------------------------------------------------------
    // Typing
    // ---------------------------------------------------------------
    //
    // Fire-and-forget: never persisted, never acknowledged. It is worthless a
    // second later and an ack would double the traffic for nothing.
    //
    // `typing` defaults to TRUE when absent. The app's emitTyping() sends only
    // { conversationId }, so reading `!!typing` from that payload gives false
    // and relays "stopped typing" on every keystroke — the indicator never
    // appears. Receivers should expire it on a timer regardless, since the
    // stop event is lost whenever a socket drops mid-sentence.
    socket.on("chat:typing", ({ conversationId, typing } = {}) => {
      if (!conversationId) return;
      socket.to(`conversation:${conversationId}`).emit("chat:typing", {
        conversationId,
        userId,
        typing: typing === undefined ? true : Boolean(typing),
      });
    });

    socket.on("disconnect", (reason) => {
      console.log(`[socket] disconnect ${socket.id} ${reason}`);
    });
  });

  return io;
}

// Lets REST controllers push to sockets after a write, so a message sent over
// REST still arrives instantly for anyone currently connected.
//
//   import { emitToUser } from '../socket/index.js';
//   emitToUser(req.app.get('io'), recipientId, 'chat:notify', payload);
export function emitToUser(io, userId, event, payload) {
  if (!io) return;
  io.to(userRoom(String(userId))).emit(event, payload);
}

export { userRoom };
