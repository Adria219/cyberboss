const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { ArousalService } = require("../src/arousal/arousal-service");
const { ArousalStore, createEnvelope } = require("../src/arousal/arousal-store");

test("paired state and ledger persist as identical private files", () => {
  const fixture = createPaths();
  const store = new ArousalStore(fixture);
  const envelope = createEnvelope(100);
  store.save(envelope);
  const primary = fs.readFileSync(fixture.primaryFile);
  const backup = fs.readFileSync(fixture.backupFile);
  assert.deepEqual(primary, backup);
  assert.equal(store.load(100).kind, "ready");
});

test("first use is distinct from an initialized state whose pair disappeared", () => {
  const fixture = createPaths();
  const store = new ArousalStore(fixture);
  assert.equal(store.load(100).kind, "new");
  store.save(createEnvelope(100));
  fs.unlinkSync(fixture.primaryFile);
  fs.unlinkSync(fixture.backupFile);
  const loaded = store.load(101);
  assert.equal(loaded.kind, "quarantined");
  assert.equal(loaded.reason, "initialized_state_missing");
  assert.equal(loaded.envelope.state.release_gate.locked, true);
});

test("missing, empty, corrupt, contradictory, or mismatched backup pair fails closed", () => {
  for (const mode of ["missing", "marker", "empty", "corrupt", "contradiction", "mismatch"]) {
    const fixture = createPaths();
    const store = new ArousalStore(fixture);
    store.save(createEnvelope(100));
    if (mode === "missing") fs.unlinkSync(fixture.backupFile);
    if (mode === "marker") fs.unlinkSync(`${fixture.primaryFile}.initialized`);
    if (mode === "empty") fs.writeFileSync(fixture.primaryFile, "{}");
    if (mode === "corrupt") fs.writeFileSync(fixture.primaryFile, "not-json");
    if (mode === "contradiction") {
      const value = createEnvelope(100);
      value.state.release_gate.release_once_generation = 0;
      const bytes = `${JSON.stringify(value)}\n`;
      fs.writeFileSync(fixture.primaryFile, bytes);
      fs.writeFileSync(fixture.backupFile, bytes);
    }
    if (mode === "mismatch") fs.appendFileSync(fixture.backupFile, " ");
    const loaded = store.load(101);
    assert.equal(loaded.kind, "quarantined", mode);
    assert.equal(loaded.envelope.state.quarantined, true, mode);
    assert.equal(loaded.envelope.state.release_gate.locked, true, mode);
  }
});

test("service stores only event digests and duplicate replay leaves bytes unchanged", () => {
  const fixture = createPaths();
  const lexiconFile = writeLexicon(fixture.dir);
  const service = new ArousalService({ ...fixture, lexiconFile, now: () => 100 });
  const text = "ACTION_ALPHA PART_ALPHA";
  const first = service.recordUserFinal({ eventId: "canonical-user-1", text });
  assert.equal(first.accepted, true);
  const before = fs.readFileSync(fixture.primaryFile);
  const replay = service.recordUserFinal({ eventId: "canonical-user-1", text: "ACTION_ALPHA" });
  const after = fs.readFileSync(fixture.primaryFile);
  assert.equal(replay.duplicate, true);
  assert.deepEqual(after, before);
  assert.equal(after.includes(Buffer.from(text)), false);
  const parsed = JSON.parse(after.toString("utf8"));
  assert.match(parsed.ledger.user[0], /^[a-f0-9]{64}$/u);
});

test("missing lexicon logs once, contributes zero stimulus, and does not throw to chat", () => {
  const fixture = createPaths();
  const errors = [];
  const service = new ArousalService({
    ...fixture,
    lexiconFile: path.join(fixture.dir, "missing.json"),
    now: () => 100,
    logger: { error(message) { errors.push(message); } },
  });
  const result = service.recordUserFinal({ eventId: "canonical-user-2", text: "ACTION_ALPHA" });
  assert.equal(result.accepted, true);
  assert.equal(result.state.value, 0);
  assert.equal(errors.length, 1);
});

test("assistant final needs a landed user event and incomplete final is ignored", () => {
  const fixture = createPaths();
  const service = new ArousalService({
    ...fixture,
    lexiconFile: writeLexicon(fixture.dir),
    now: () => 100,
  });
  const orphan = service.recordAssistantFinal({
    eventId: "assistant-orphan", sourceUserEventId: "missing", text: "我 ACTION_ALPHA",
  });
  assert.equal(orphan.accepted, false);
  const incomplete = service.recordAssistantFinal({
    eventId: "assistant-final", sourceUserEventId: "canonical-user", text: "我 ACTION_ALPHA", complete: false,
  });
  assert.equal(incomplete.accepted, false);
  service.recordUserFinal({ eventId: "canonical-user", text: "ACTION_ALPHA" });
  const complete = service.recordAssistantFinal({
    eventId: "assistant-final", sourceUserEventId: "canonical-user", text: "我 ACTION_ALPHA", complete: true,
  });
  assert.equal(complete.accepted, true);
});

test("control generation survives restart and clock rollback locks persistently", () => {
  const fixture = createPaths();
  let currentTime = 100;
  const options = {
    ...fixture,
    lexiconFile: writeLexicon(fixture.dir),
    now: () => currentTime,
  };
  const first = new ArousalService(options);
  assert.equal(first.recordControl({ eventId: "control-lock", type: "lock", generation: 1 }).accepted, true);
  const lockedBytes = fs.readFileSync(fixture.primaryFile);
  assert.equal(first.recordControl({ eventId: "control-lock", type: "unlock", generation: 2 }).duplicate, true);
  assert.deepEqual(fs.readFileSync(fixture.primaryFile), lockedBytes);
  const restarted = new ArousalService(options);
  assert.equal(restarted.getPublicSnapshot().phase, "locked");
  assert.equal(restarted.recordControl({ eventId: "control-once", type: "release_once", generation: 2 }).accepted, true);
  assert.equal(new ArousalStore(fixture).load(100).envelope.state.release_gate.release_once_generation, 2);
  currentTime = 99;
  assert.throws(() => restarted.getPublicSnapshot(), /clock rollback/u);
  currentTime = 101;
  assert.equal(restarted.getPublicSnapshot().phase, "locked");
  const loaded = new ArousalStore(fixture).load(101);
  assert.equal(loaded.kind, "ready");
  assert.equal(loaded.envelope.state.quarantined, true);
  assert.equal(loaded.envelope.state.release_gate.locked, true);
});

test("no-op release effect is recorded once in the long ledger", () => {
  const fixture = createPaths();
  const service = new ArousalService({
    ...fixture,
    lexiconFile: writeLexicon(fixture.dir),
    now: () => 100,
  });
  for (let index = 0; index < 9; index += 1) {
    service.recordUserFinal({ eventId: `release-user-${index}`, text: "ACTION_ALPHA" });
  }
  const parsed = JSON.parse(fs.readFileSync(fixture.primaryFile, "utf8"));
  assert.equal(parsed.ledger.release_effect.length, 1);
  const before = fs.readFileSync(fixture.primaryFile);
  service.recordUserFinal({ eventId: "release-user-8", text: "ACTION_ALPHA" });
  assert.deepEqual(fs.readFileSync(fixture.primaryFile), before);
});

function createPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-arousal-test-"));
  return {
    dir,
    primaryFile: path.join(dir, "body-state-unit.json"),
    backupFile: path.join(dir, "body-state-unit.backup.json"),
  };
}

function writeLexicon(dir) {
  const filePath = path.join(dir, "lexicon.private.json");
  fs.writeFileSync(filePath, JSON.stringify({
    schema_version: 1,
    actions: [{ token: "ACTION_ALPHA", weight: 0.6, passive: false }],
    body_parts: [{ token: "PART_ALPHA", sensitivity: 0.8 }],
    postures: [{ token: "POSTURE_ALPHA", multiplier: 1.1 }],
    release_terms: ["RELEASE_ALPHA"],
  }));
  return filePath;
}
