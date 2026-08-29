const fs = require("fs");
const path = require("path");

const POLLER_STATUSES = new Set([
  "disabled",
  "waiting",
  "queued",
  "running",
  "ready",
  "error",
  "lock_conflict",
]);
const RUN_ACTIONS = new Set(["silent", "send_message", "leave_note", "invalid"]);
const RUN_OUTCOMES = new Set(["suppressed", "sent", "held", "deferred", "dropped", "rejected", "failed"]);

class CheckinRuntimeStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = emptyState();
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      this.state = normalizeState(JSON.parse(raw));
    } catch {
      this.state = emptyState();
    }
    return this.snapshot();
  }

  save() {
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.state, null, 2));
    fs.renameSync(tempPath, this.filePath);
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  update(patch) {
    this.load();
    this.state = normalizeState({
      ...this.state,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    this.save();
    return this.snapshot();
  }

  setScheduler({ enabled, pollerStatus, senderId, workspaceRoot, nextWakeAt, errorCode }) {
    this.load();
    return this.update({
      enabled: Boolean(enabled),
      pollerStatus,
      senderId: senderId === undefined ? this.state.senderId : senderId,
      workspaceRoot: workspaceRoot === undefined ? this.state.workspaceRoot : workspaceRoot,
      nextWakeAt: nextWakeAt === undefined ? this.state.nextWakeAt : nextWakeAt,
      errorCode: errorCode === undefined ? this.state.errorCode : errorCode,
    });
  }

  markQueued({ runId, senderId, workspaceRoot, queuedAt = new Date().toISOString() }) {
    return this.update({
      pollerStatus: "queued",
      senderId,
      workspaceRoot,
      nextWakeAt: "",
      errorCode: "",
      lastRun: {
        runId,
        queuedAt,
        dispatchedAt: "",
        completedAt: "",
        threadId: "",
        action: "",
        outcome: "",
      },
    });
  }

  markDispatched({ runId, threadId, dispatchedAt = new Date().toISOString() }) {
    this.load();
    if (!runId || this.state.lastRun?.runId !== runId) {
      return this.snapshot();
    }
    return this.update({
      pollerStatus: "running",
      lastRun: {
        ...this.state.lastRun,
        threadId,
        dispatchedAt,
      },
    });
  }

  completeRun({ runId, action, outcome, completedAt = new Date().toISOString() }) {
    this.load();
    if (!runId || this.state.lastRun?.runId !== runId) {
      return this.snapshot();
    }
    return this.update({
      pollerStatus: this.state.enabled ? "ready" : "disabled",
      lastRun: {
        ...this.state.lastRun,
        completedAt,
        action,
        outcome,
      },
    });
  }
}

function emptyState() {
  return {
    enabled: false,
    pollerStatus: "disabled",
    senderId: "",
    workspaceRoot: "",
    nextWakeAt: "",
    errorCode: "",
    lastRun: null,
    updatedAt: "",
  };
}

function normalizeState(value) {
  const raw = value && typeof value === "object" ? value : {};
  return {
    enabled: raw.enabled === true,
    pollerStatus: POLLER_STATUSES.has(raw.pollerStatus) ? raw.pollerStatus : "disabled",
    senderId: normalizeText(raw.senderId),
    workspaceRoot: normalizeText(raw.workspaceRoot),
    nextWakeAt: normalizeIsoTime(raw.nextWakeAt),
    errorCode: normalizeCode(raw.errorCode),
    lastRun: normalizeRun(raw.lastRun),
    updatedAt: normalizeIsoTime(raw.updatedAt),
  };
}

function normalizeRun(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const runId = normalizeText(value.runId);
  const queuedAt = normalizeIsoTime(value.queuedAt);
  if (!runId || !queuedAt) {
    return null;
  }
  const action = RUN_ACTIONS.has(value.action) ? value.action : "";
  const outcome = RUN_OUTCOMES.has(value.outcome) ? value.outcome : "";
  return {
    runId,
    queuedAt,
    dispatchedAt: normalizeIsoTime(value.dispatchedAt),
    completedAt: normalizeIsoTime(value.completedAt),
    threadId: normalizeText(value.threadId),
    action,
    outcome,
  };
}

function normalizeIsoTime(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : "";
}

function normalizeCode(value) {
  const normalized = normalizeText(value).toLowerCase();
  return /^[a-z0-9_-]{1,64}$/.test(normalized) ? normalized : "";
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { CheckinRuntimeStore };
