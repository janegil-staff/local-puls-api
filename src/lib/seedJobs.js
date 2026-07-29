// localpulse/server/src/lib/seedJobs.js

// In-memory job registry for long-running seed operations.
//
// Deliberately not persisted. These jobs are dev tooling: they do not survive a
// restart, and with more than one API instance a job started on instance A is
// invisible to a status poll that lands on instance B. Both are acceptable for
// seeding and neither is worth a queue dependency. If this ever needs to work
// against a scaled deployment, back it with a Mongo collection — the interface
// below would not change.

import { randomUUID } from "node:crypto";

const MAX_RETAINED_JOBS = 20;
const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour

const jobs = new Map();

export class JobConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "JobConflictError";
    this.status = 409;
  }
}

export class JobCancelledError extends Error {
  constructor() {
    super("Job cancelled.");
    this.name = "JobCancelledError";
  }
}

function isTerminal(status) {
  return (
    status === "succeeded" || status === "failed" || status === "cancelled"
  );
}

// Drop finished jobs once they are old or once there are too many of them, so a
// long-lived process does not accumulate logs forever.
function pruneJobs() {
  const now = Date.now();

  for (const [id, job] of jobs) {
    if (
      isTerminal(job.status) &&
      job.finishedAt &&
      now - job.finishedAt > JOB_TTL_MS
    ) {
      jobs.delete(id);
    }
  }

  if (jobs.size <= MAX_RETAINED_JOBS) return;

  const finished = [...jobs.values()]
    .filter((job) => isTerminal(job.status))
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));

  while (jobs.size > MAX_RETAINED_JOBS && finished.length > 0) {
    jobs.delete(finished.shift().id);
  }
}

export function getRunningJob() {
  for (const job of jobs.values()) {
    if (job.status === "running") return job;
  }
  return null;
}

// Starts a job and returns immediately. The runner is invoked detached — the
// caller must not await it, and any rejection is captured onto the job rather
// than escaping as an unhandled rejection.
//
// The runner receives:
//   log(message)      append a line, mirrored to console
//   checkCancelled()  throws JobCancelledError if a cancel was requested
//   setStep(label)    set the human-readable current step
export function startJob(type, runner) {
  pruneJobs();

  const running = getRunningJob();
  if (running) {
    throw new JobConflictError(
      `A "${running.type}" job (${running.id}) is already running. Wait for it to finish or cancel it.`,
    );
  }

  const job = {
    id: randomUUID(),
    type,
    status: "running",
    step: null,
    log: [],
    result: null,
    error: null,
    cancelRequested: false,
    createdAt: Date.now(),
    finishedAt: null,
  };

  jobs.set(job.id, job);

  const log = (message = "") => {
    const text = String(message);
    job.log.push(text);
    console.log(`[seed:${job.type}:${job.id.slice(0, 8)}] ${text}`);
  };
  log.lines = job.log;

  const checkCancelled = () => {
    if (job.cancelRequested) throw new JobCancelledError();
  };

  const setStep = (label) => {
    job.step = label;
  };

  // Detached on purpose. Do not await.
  Promise.resolve()
    .then(() => runner({ log, checkCancelled, setStep }))
    .then((result) => {
      job.result = result ?? null;
      job.status = job.cancelRequested ? "cancelled" : "succeeded";
    })
    .catch((error) => {
      if (error instanceof JobCancelledError) {
        job.status = "cancelled";
        job.error = "Cancelled.";
        log("Cancelled.");
        return;
      }
      job.status = "failed";
      job.error = error?.message || "Job failed.";
      log(`FAILED: ${job.error}`);
      console.error(`[seed:${job.type}:${job.id.slice(0, 8)}]`, error);
    })
    .finally(() => {
      job.step = null;
      job.finishedAt = Date.now();
    });

  return job;
}

// `since` is a line index, so a polling client fetches only what it has not
// seen. Returns the full log when `since` is 0 or omitted.
export function serialiseJob(job, since = 0) {
  const from = Number.isFinite(Number(since)) ? Math.max(0, Number(since)) : 0;

  return {
    id: job.id,
    type: job.type,
    status: job.status,
    step: job.step,
    logFrom: from,
    log: job.log.slice(from),
    logLength: job.log.length,
    result: job.result,
    error: job.error,
    cancelRequested: job.cancelRequested,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    durationMs: (job.finishedAt ?? Date.now()) - job.createdAt,
  };
}

export function getJob(id) {
  return jobs.get(id) ?? null;
}

export function listJobs() {
  return [...jobs.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((job) => ({
      id: job.id,
      type: job.type,
      status: job.status,
      step: job.step,
      logLength: job.log.length,
      error: job.error,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
    }));
}

// Cooperative. The orchestrator checks between steps, so a cancel takes effect
// at the next boundary rather than interrupting an in-flight Cloudinary upload.
export function requestCancel(id) {
  const job = jobs.get(id);
  if (!job) return null;
  if (isTerminal(job.status)) return job;
  job.cancelRequested = true;
  return job;
}
