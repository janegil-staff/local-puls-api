// localpulse/server/src/app.js
//
// Builds and exports the configured Express app. Does not connect to Mongo,
// attach Socket.IO, or listen — that is server.js. All routes come from the
// single aggregator in routes/index.js.

import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

import { config } from "./config/index.js";
import routes from "./routes/index.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";

const app = express();

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------
//
// ETags off, globally and deliberately.
//
// Every response here is user-specific and small, so conditional requests
// buy almost nothing. What they cost is a whole class of bug: Express puts
// a weak ETag on JSON, iOS NSURLSession sends If-None-Match without the app
// asking, and res.send() short-circuits to a bodiless 304 before any of our
// own headers matter.
//
// The visible symptom was GET /api/me returning 304 straight after login, so
// the client kept a stale profile and a freshly completed account still
// looked incomplete. Cache-Control: no-store does NOT fix it — that
// instructs the client, while the 304 comes from the server's own freshness
// check.
app.set("etag", false);

// Behind DigitalOcean's proxy, so req.ip is the proxy address without this —
// which would put every user in one rate-limit bucket.
app.set("trust proxy", 1);

app.use(helmet());

app.use(
  cors({
    origin: config.clientOrigins,
    credentials: true,
  }),
);

if (!config.isProd) {
  app.use(morgan("dev"));
} else {
  app.use(morgan("tiny"));
}

app.use(express.json({ limit: "1mb" }));

// ---------------------------------------------------------------------------
// Rate limits
// ---------------------------------------------------------------------------
//
// A 4-digit PIN is only 10,000 possibilities, so the auth routes need a
// tighter limit than everything else.
app.use(
  "/api/auth",
  rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.authMax,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

app.use(
  "/api",
  rateLimit({
    windowMs: config.rateLimit.windowMs,
    max: config.rateLimit.max,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get("/api/health", (req, res) =>
  res.json({ ok: true, uptime: process.uptime() }),
);

app.use("/api", routes);

app.use(notFound);
app.use(errorHandler); // must be last

export default app;
