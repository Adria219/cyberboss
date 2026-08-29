const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const {
  applyAssistantEvent,
  applyControlEvent,
  applyUserEvent,
  createInitialState,
  publicSnapshot,
} = require("../src/arousal/arousal-core");
const { parseArousalStimulus } = require("../src/arousal/context-parser");

const ZERO_TARGETS = { somatic: false, drive: false };

test("canonical user event is byte-stable on replay", () => {
  const eventDigest = digest("user-1");
  const first = applyUserEvent(createInitialState(100), {
    eventDigest,
    now: 100,
    stimulus: stimulus(0.5),
    releaseEffectId: digest("effect-1"),
    releaseTargets: ZERO_TARGETS,
  });
  const before = JSON.stringify(first.state);
  const replay = applyUserEvent(first.state, {
    eventDigest,
    now: 999,
    stimulus: stimulus(1),
    releaseEffectId: digest("effect-2"),
    releaseTargets: ZERO_TARGETS,
  });
  assert.equal(replay.duplicate, true);
  assert.equal(JSON.stringify(replay.state), before);
});

test("incomplete assistant final does not consume its event id", () => {
  const userDigest = digest("user-parent");
  const user = applyUserEvent(createInitialState(100), {
    eventDigest: userDigest,
    now: 100,
    releaseEffectId: digest("effect-parent"),
    releaseTargets: ZERO_TARGETS,
  });
  const assistantDigest = digest("assistant-1");
  const incomplete = applyAssistantEvent(user.state, {
    eventDigest: assistantDigest,
    sourceUserEventDigest: userDigest,
    complete: false,
    now: 101,
  });
  assert.equal(incomplete.accepted, false);
  assert.equal(incomplete.state.processed_event_ids.includes(assistantDigest), false);
  const complete = applyAssistantEvent(incomplete.state, {
    eventDigest: assistantDigest,
    sourceUserEventDigest: userDigest,
    complete: true,
    now: 101,
    releaseEffectId: digest("effect-assistant"),
    releaseTargets: ZERO_TARGETS,
  });
  assert.equal(complete.accepted, true);
  assert.equal(complete.state.processed_event_ids.includes(assistantDigest), true);
});

test("assistant final requires a canonical user parent or long-ledger proof", () => {
  const state = createInitialState(100);
  const rejected = applyAssistantEvent(state, {
    eventDigest: digest("assistant-orphan"),
    sourceUserEventDigest: digest("missing-parent"),
    now: 101,
  });
  assert.equal(rejected.accepted, false);
  const accepted = applyAssistantEvent(state, {
    eventDigest: digest("assistant-old-parent"),
    sourceUserEventDigest: digest("old-parent"),
    sourceUserSeen: true,
    now: 101,
    releaseEffectId: digest("old-effect"),
    releaseTargets: ZERO_TARGETS,
  });
  assert.equal(accepted.accepted, true);
});

test("lock, release-once, and unlock persist through generations", () => {
  let state = createInitialState(100);
  const locked = applyControlEvent(state, {
    eventDigest: digest("lock"), type: "lock", generation: 1, now: 101,
  });
  assert.equal(publicSnapshot(locked.state, 101).phase, "locked");
  const releasedOnce = applyControlEvent(locked.state, {
    eventDigest: digest("once"), type: "release_once", generation: 2, now: 102,
  });
  assert.equal(releasedOnce.state.release_gate.release_once_generation, 2);
  const unlocked = applyControlEvent(releasedOnce.state, {
    eventDigest: digest("unlock"), type: "unlock", generation: 3, now: 103,
  });
  assert.equal(unlocked.state.release_gate.locked, false);
  assert.equal(publicSnapshot(unlocked.state, 103).phase, "idle");
});

test("generation mismatch and clock rollback quarantine the state", () => {
  const mismatch = applyControlEvent(createInitialState(100), {
    eventDigest: digest("bad-generation"), type: "lock", generation: 2, now: 101,
  });
  assert.equal(mismatch.state.quarantined, true);
  assert.equal(publicSnapshot(mismatch.state, 101).phase, "locked");

  const rollback = applyUserEvent(createInitialState(100), {
    eventDigest: digest("rollback"),
    now: 99,
    stimulus: stimulus(1),
    releaseEffectId: digest("rollback-effect"),
    releaseTargets: ZERO_TARGETS,
  });
  assert.equal(rollback.state.quarantined, true);
  assert.equal(publicSnapshot(rollback.state, 100).phase, "locked");
});

test("malformed and NaN state cannot pass through a duplicate-shaped event", () => {
  const eventDigest = digest("duplicate-shaped");
  const malformed = createInitialState(100);
  malformed.value = Number.NaN;
  malformed.processed_event_ids.push(eventDigest);
  const result = applyUserEvent(malformed, {
    eventDigest,
    now: 100,
    releaseEffectId: digest("malformed-effect"),
    releaseTargets: ZERO_TARGETS,
  });
  assert.equal(result.duplicate, false);
  assert.equal(result.state.quarantined, true);
  assert.equal(result.state.release_gate.locked, true);
});

test("release produces one no-op receipt and enters refractory", () => {
  let state = createInitialState(100);
  let result;
  for (let index = 0; index < 5; index += 1) {
    result = applyUserEvent(state, {
      eventDigest: digest(`shot-${index}`),
      now: 100,
      stimulus: stimulus(1),
      releaseEffectId: digest(`effect-${index}`),
      releaseTargets: ZERO_TARGETS,
    });
    state = result.state;
  }
  assert.equal(result.released, true);
  assert.equal(result.receipt.targets.somatic, false);
  assert.equal(result.receipt.targets.drive, false);
  assert.equal(state.pending_release_receipt, null);
  assert.equal(state.completed_release_effect_ids.includes(result.receipt.effect_id), true);
  assert.equal(publicSnapshot(state, 100).phase, "refractory");
});

test("release-once is consumed by one release while the persistent lock remains", () => {
  let state = applyControlEvent(createInitialState(100), {
    eventDigest: digest("locked-release"), type: "lock", generation: 1, now: 100,
  }).state;
  state = applyControlEvent(state, {
    eventDigest: digest("one-release"), type: "release_once", generation: 2, now: 100,
  }).state;
  let result;
  for (let index = 0; index < 5; index += 1) {
    result = applyUserEvent(state, {
      eventDigest: digest(`locked-shot-${index}`),
      now: 100,
      stimulus: stimulus(1),
      releaseEffectId: digest(`locked-effect-${index}`),
      releaseTargets: ZERO_TARGETS,
    });
    state = result.state;
  }
  assert.equal(result.released, true);
  assert.equal(state.release_gate.locked, true);
  assert.equal(state.release_gate.release_once_generation, null);
  assert.equal(publicSnapshot(state, 100).phase, "locked");
});

test("passive contact cannot cross the passive cap", () => {
  let state = createInitialState(100);
  for (let index = 0; index < 100; index += 1) {
    state = applyUserEvent(state, {
      eventDigest: digest(`passive-${index}`),
      now: 100,
      stimulus: { ...stimulus(1), passive_contact: true },
      releaseEffectId: digest(`passive-effect-${index}`),
      releaseTargets: ZERO_TARGETS,
    }).state;
  }
  assert.ok(state.value <= 0.72);
});

test("context parser rejects plans, questions, third-party text and honors stop first", () => {
  const lexicon = fixtureLexicon();
  assert.equal(parseArousalStimulus({ text: "如果 ACTION_ALPHA", actor: "user", lexicon }).amount, 0);
  assert.equal(parseArousalStimulus({ text: "ACTION_ALPHA？", actor: "user", lexicon }).amount, 0);
  assert.equal(parseArousalStimulus({ text: "他 ACTION_ALPHA", actor: "user", lexicon }).amount, 0);
  assert.equal(parseArousalStimulus({ text: "停止 ACTION_ALPHA", actor: "user", lexicon }).stopped, true);
  assert.equal(parseArousalStimulus({ text: "停止", actor: "user", lexicon: null }).stopped, true);
  assert.equal(parseArousalStimulus({
    text: "[Quoted: 停止 ACTION_ALPHA]\nACTION_ALPHA",
    actor: "user",
    lexicon,
  }).stopped, false);
  assert.ok(parseArousalStimulus({ text: "ACTION_ALPHA PART_ALPHA", actor: "user", lexicon }).amount > 0);
  assert.equal(parseArousalStimulus({ text: "ACTION_ALPHA", actor: "assistant", lexicon }).amount, 0);
  assert.ok(parseArousalStimulus({ text: "我 ACTION_ALPHA", actor: "assistant", lexicon }).amount > 0);
});

test("a current stop event cannot trigger threshold release", () => {
  let state = applyControlEvent(createInitialState(100), {
    eventDigest: digest("stop-lock"), type: "lock", generation: 1, now: 100,
  }).state;
  for (let index = 0; index < 5; index += 1) {
    state = applyUserEvent(state, {
      eventDigest: digest(`stop-build-${index}`),
      now: 100,
      stimulus: stimulus(1),
      releaseEffectId: digest(`stop-build-effect-${index}`),
      releaseTargets: ZERO_TARGETS,
    }).state;
  }
  state = applyControlEvent(state, {
    eventDigest: digest("stop-unlock"), type: "unlock", generation: 2, now: 100,
  }).state;
  const stopped = applyUserEvent(state, {
    eventDigest: digest("stop-now"),
    now: 100,
    stimulus: { amount: 0, passive_contact: false, stopped: true, release_intent: false },
    releaseEffectId: digest("stop-effect"),
    releaseTargets: ZERO_TARGETS,
  });
  assert.equal(stopped.released, false);
  assert.equal(stopped.state.value, 1);
});

function stimulus(amount) {
  return { amount, passive_contact: false, stopped: false, release_intent: false };
}

function fixtureLexicon() {
  return {
    schema_version: 1,
    actions: [{ token: "ACTION_ALPHA", weight: 0.6, passive: false }],
    body_parts: [{ token: "PART_ALPHA", sensitivity: 0.8 }],
    postures: [{ token: "POSTURE_ALPHA", multiplier: 1.1 }],
    release_terms: ["RELEASE_ALPHA"],
  };
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
