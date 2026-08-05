// local-pulse-api/src/services/callRegistry.js

/**
 * Process-local bookkeeping for in-flight calls.
 *
 * Deliberately NOT the source of truth — Mongo is. This only holds things that
 * are meaningless after a restart: ring timeouts and "which user is on which
 * call right now". If the process restarts mid-call the clients detect the
 * dropped socket and tear down on their own.
 *
 * NOTE ON SCALING: this is single-process state. The moment local-pulse-api
 * runs more than one instance behind the DigitalOcean load balancer, ring
 * timeouts still work (any instance can fire them for calls it owns) but
 * `isUserBusy` becomes unreliable across instances. At that point the busy
 * check should move to the Call collection query (Call.findActiveForUser)
 * which is already implemented, and this file keeps only the timers.
 */

const RING_TIMEOUT_MS = 45 * 1000;
const CONNECT_TIMEOUT_MS = 30 * 1000;

// callId -> { callerId, calleeId, ringTimer, connectTimer }
const activeCalls = new Map();

// userId -> callId
const userToCall = new Map();

export function register({ callId, callerId, calleeId }) {
  const entry = {
    callId: String(callId),
    callerId: String(callerId),
    calleeId: String(calleeId),
    ringTimer: null,
    connectTimer: null,
  };

  activeCalls.set(entry.callId, entry);
  userToCall.set(entry.callerId, entry.callId);
  userToCall.set(entry.calleeId, entry.callId);

  return entry;
}

export function get(callId) {
  return activeCalls.get(String(callId)) || null;
}

export function getCallIdForUser(userId) {
  return userToCall.get(String(userId)) || null;
}

export function isUserBusy(userId) {
  return userToCall.has(String(userId));
}

export function startRingTimeout(callId, onTimeout, ms = RING_TIMEOUT_MS) {
  const entry = get(callId);
  if (!entry) return;

  clearTimeout(entry.ringTimer);
  entry.ringTimer = setTimeout(() => {
    entry.ringTimer = null;
    onTimeout(String(callId));
  }, ms);
}

export function clearRingTimeout(callId) {
  const entry = get(callId);
  if (!entry) return;
  clearTimeout(entry.ringTimer);
  entry.ringTimer = null;
}

/**
 * Started once the callee accepts. If ICE never reaches a connected state
 * within the window we tear the call down rather than leaving both clients
 * staring at a spinner.
 */
export function startConnectTimeout(
  callId,
  onTimeout,
  ms = CONNECT_TIMEOUT_MS,
) {
  const entry = get(callId);
  if (!entry) return;

  clearTimeout(entry.connectTimer);
  entry.connectTimer = setTimeout(() => {
    entry.connectTimer = null;
    onTimeout(String(callId));
  }, ms);
}

export function clearConnectTimeout(callId) {
  const entry = get(callId);
  if (!entry) return;
  clearTimeout(entry.connectTimer);
  entry.connectTimer = null;
}

export function release(callId) {
  const entry = get(callId);
  if (!entry) return null;

  clearTimeout(entry.ringTimer);
  clearTimeout(entry.connectTimer);

  activeCalls.delete(entry.callId);

  if (userToCall.get(entry.callerId) === entry.callId) {
    userToCall.delete(entry.callerId);
  }
  if (userToCall.get(entry.calleeId) === entry.callId) {
    userToCall.delete(entry.calleeId);
  }

  return entry;
}

export function stats() {
  return {
    activeCalls: activeCalls.size,
    busyUsers: userToCall.size,
  };
}

export default {
  register,
  get,
  getCallIdForUser,
  isUserBusy,
  startRingTimeout,
  clearRingTimeout,
  startConnectTimeout,
  clearConnectTimeout,
  release,
  stats,
  RING_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
};
