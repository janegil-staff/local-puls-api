// localpulse/server/src/server.js
//
// Bootstrap only: connect the database, attach Socket.IO, listen, and shut
// down cleanly. Express wiring lives in app.js; socket behaviour lives in
// socket/index.js; configuration lives in config/index.js.

import http from "node:http";
import mongoose from "mongoose";

// config/index.js calls dotenv.config() at import time, so importing it
// first is what makes process.env available to everything below.
import { config } from "./config/index.js";
import app from "./app.js";
import { attachSockets } from "./socket/index.js";

// Express and Socket.IO share one HTTP server, so the platform only needs
// one exposed port and the WebSocket upgrade lands on the same origin as
// the REST calls. A separate socket host would need its own TLS and its own
// CORS entry.
const server = http.createServer(app);

let io;

async function start() {
  mongoose.set("strictQuery", true);
  await mongoose.connect(config.mongoUri);
  console.log("MongoDB connected");

  io = attachSockets(server);

  // REST controllers reach sockets through this, so a message sent over
  // REST still arrives instantly for anyone currently connected.
  app.set("io", io);

  server.listen(config.port, () => {
    console.log(`🌐 LocalPulse API + chat on :${config.port} [${config.env}]`);
  });
}

start().catch((error) => {
  console.error("Startup failed:", error);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------
//
// App Platform sends SIGTERM on every redeploy. Without draining, in-flight
// requests are cut mid-response and every connected socket drops without a
// close frame — which clients treat as a network error and retry against a
// server that is already gone.

let shuttingDown = false;

function shutdown(signal) {
  return async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    console.log(`${signal} received — shutting down`);

    // Sockets first: open WebSockets hold the HTTP server open, so
    // server.close() would otherwise wait for each one to time out.
    if (io) {
      io.close();
      console.log("[socket] closed");
    }

    server.close(async () => {
      await mongoose.disconnect();
      console.log("Shutdown complete");
      process.exit(0);
    });

    // Hard limit. If something is wedged, exiting non-zero beats hanging
    // until the platform kills the container anyway.
    setTimeout(() => {
      console.error("Shutdown timed out — forcing exit");
      process.exit(1);
    }, 10_000).unref();
  };
}

process.on("SIGTERM", shutdown("SIGTERM"));
process.on("SIGINT", shutdown("SIGINT"));

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

export { server, io };
