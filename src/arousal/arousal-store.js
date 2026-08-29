const fs = require("fs");
const path = require("path");
const { createInitialState, createQuarantinedState, isValidState } = require("./arousal-core");

const ENVELOPE_KEYS = ["schema_version", "state", "ledger", "updated_at"];
const LEDGER_KEYS = ["user", "assistant", "control", "release_effect"];

class ArousalStore {
  constructor({ primaryFile, backupFile, markerFile = `${primaryFile}.initialized` }) {
    this.primaryFile = primaryFile;
    this.backupFile = backupFile;
    this.markerFile = markerFile;
  }

  load(now) {
    const primaryExists = fs.existsSync(this.primaryFile);
    const backupExists = fs.existsSync(this.backupFile);
    const markerExists = fs.existsSync(this.markerFile);
    if (!primaryExists && !backupExists) {
      if (markerExists) {
        return { kind: "quarantined", envelope: createQuarantinedEnvelope(now), reason: "initialized_state_missing" };
      }
      return { kind: "new", envelope: createEnvelope(now) };
    }
    if (!primaryExists || !backupExists || !markerExists) {
      return { kind: "quarantined", envelope: createQuarantinedEnvelope(now), reason: "state_pair_incomplete" };
    }
    try {
      if (fs.readFileSync(this.markerFile, "utf8") !== "arousal-state-initialized-v1\n") {
        return { kind: "quarantined", envelope: createQuarantinedEnvelope(now), reason: "state_marker_invalid" };
      }
      const primary = fs.readFileSync(this.primaryFile);
      const backup = fs.readFileSync(this.backupFile);
      if (!primary.equals(backup)) {
        return { kind: "quarantined", envelope: createQuarantinedEnvelope(now), reason: "state_pair_mismatch" };
      }
      const envelope = JSON.parse(primary.toString("utf8"));
      if (!isValidEnvelope(envelope)) {
        return { kind: "quarantined", envelope: createQuarantinedEnvelope(now), reason: "state_invalid" };
      }
      return { kind: "ready", envelope };
    } catch {
      return { kind: "quarantined", envelope: createQuarantinedEnvelope(now), reason: "state_unreadable" };
    }
  }

  save(envelope) {
    if (!isValidEnvelope(envelope)) throw new Error("invalid arousal envelope");
    const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
    fs.mkdirSync(path.dirname(this.primaryFile), { recursive: true });
    atomicWrite(this.primaryFile, bytes);
    atomicWrite(this.backupFile, bytes);
    atomicWrite(this.markerFile, Buffer.from("arousal-state-initialized-v1\n", "utf8"));
  }
}

function createEnvelope(now) {
  return {
    schema_version: 1,
    state: createInitialState(now),
    ledger: { user: [], assistant: [], control: [], release_effect: [] },
    updated_at: now,
  };
}

function createQuarantinedEnvelope(now) {
  const envelope = createEnvelope(safeTime(now));
  envelope.state = createQuarantinedState(safeTime(now));
  return envelope;
}

function isValidEnvelope(value) {
  return hasExactKeys(value, ENVELOPE_KEYS)
    && value.schema_version === 1
    && isValidState(value.state)
    && isValidLedger(value.ledger)
    && Number.isFinite(value.updated_at)
    && value.updated_at >= 0
    && value.updated_at >= value.state.at
    && value.updated_at >= value.state.reserve_at;
}

function isValidLedger(value) {
  return hasExactKeys(value, LEDGER_KEYS)
    && LEDGER_KEYS.every((key) => Array.isArray(value[key]) && value[key].every(isDigest));
}

function atomicWrite(filePath, bytes) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let handle;
  try {
    handle = fs.openSync(tempPath, "w", 0o600);
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
  }
  fs.renameSync(tempPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Windows does not implement Unix mode bits; the file remains under the private state directory.
  }
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && expected.slice().sort().every((key, index) => key === actual[index]);
}

function isDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function safeTime(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

module.exports = {
  ArousalStore,
  createEnvelope,
  createQuarantinedEnvelope,
  isValidEnvelope,
};
