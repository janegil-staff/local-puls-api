// local-pulse-api/src/services/turnService.js

import crypto from "crypto";

/**
 * Ephemeral TURN credentials using coturn's "REST API" auth scheme
 * (use-auth-secret / static-auth-secret in turnserver.conf).
 *
 *   username   = "<unix-expiry-timestamp>:<opaque-user-id>"
 *   credential = base64(HMAC-SHA1(username, STATIC_AUTH_SECRET))
 *
 * The same scheme is accepted by most hosted TURN vendors (Metered, Xirsys,
 * Twilio NTS) so swapping providers is a config change, not a code change.
 *
 * Required env:
 *   TURN_URLS               comma separated, e.g.
 *                           "turn:turn.qup.no:3478?transport=udp,turns:turn.qup.no:5349?transport=tcp"
 *   TURN_STATIC_AUTH_SECRET shared secret configured in turnserver.conf
 * Optional env:
 *   STUN_URLS               defaults to Google's public STUN servers
 *   TURN_CREDENTIAL_TTL     seconds, default 3600
 */

const DEFAULT_STUN_URLS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
];

const DEFAULT_TTL_SECONDS = 3600;

function parseList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function getStunServers() {
  const urls = parseList(process.env.STUN_URLS);
  return [{ urls: urls.length ? urls : DEFAULT_STUN_URLS }];
}

export function isTurnConfigured() {
  return Boolean(
    process.env.TURN_STATIC_AUTH_SECRET &&
    parseList(process.env.TURN_URLS).length,
  );
}

/**
 * Build the full iceServers array handed to RTCPeerConnection on the client.
 *
 * @param {string} userId  Used only to make credentials traceable in coturn logs.
 * @returns {{ iceServers: Array, ttl: number, expiresAt: string, relayAvailable: boolean }}
 */
export function createIceServers(userId) {
  const ttl = Number(process.env.TURN_CREDENTIAL_TTL) || DEFAULT_TTL_SECONDS;
  const iceServers = getStunServers();

  if (!isTurnConfigured()) {
    // Calls will still connect on friendly networks, but symmetric-NAT mobile
    // carriers will fail. Loudly flag it so this is never a silent prod issue.
    if (process.env.NODE_ENV === "production") {
      // eslint-disable-next-line no-console
      console.warn(
        "[turnService] TURN is not configured. A significant share of mobile " +
          "calls will fail to connect. Set TURN_URLS and TURN_STATIC_AUTH_SECRET.",
      );
    }
    return {
      iceServers,
      ttl,
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      relayAvailable: false,
    };
  }

  const expiry = Math.floor(Date.now() / 1000) + ttl;
  const username = `${expiry}:${userId}`;
  const credential = crypto
    .createHmac("sha1", process.env.TURN_STATIC_AUTH_SECRET)
    .update(username)
    .digest("base64");

  iceServers.push({
    urls: parseList(process.env.TURN_URLS),
    username,
    credential,
  });

  return {
    iceServers,
    ttl,
    expiresAt: new Date(expiry * 1000).toISOString(),
    relayAvailable: true,
  };
}

export default { createIceServers, getStunServers, isTurnConfigured };
