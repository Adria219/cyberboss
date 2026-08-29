const SCHEMA_VERSION = 1;
const TAU_SECONDS = 1_800;
const GAIN = 0.20;
const CHARGED = 0.40;
const EDGE = 0.88;
const POINT_OF_NO_RETURN = 0.96;
const PASSIVE_CONTACT_CAP = 0.72;
const RESERVE_RECOVERY_SECONDS = 10_800;
const REFRACTORY_MIN_SECONDS = 60;
const REFRACTORY_MAX_SECONDS = 120;
const RECENT_DIGEST_LIMIT = 256;

const STATE_KEYS = [
  "schema_version",
  "initialized",
  "quarantined",
  "value",
  "at",
  "refractory_until",
  "reserve",
  "reserve_at",
  "release_gate",
  "processed_event_ids",
  "processed_control_event_ids",
  "processed_release_candidate_event_ids",
  "completed_release_effect_ids",
  "pending_release_receipt",
  "last_climax_quality",
  "last_output",
  "buildup",
];

function createInitialState(now) {
  requireFiniteTime(now);
  return {
    schema_version: SCHEMA_VERSION,
    initialized: true,
    quarantined: false,
    value: 0,
    at: now,
    refractory_until: 0,
    reserve: 1,
    reserve_at: now,
    release_gate: {
      locked: false,
      generation: 0,
      release_once_generation: null,
    },
    processed_event_ids: [],
    processed_control_event_ids: [],
    processed_release_candidate_event_ids: [],
    completed_release_effect_ids: [],
    pending_release_receipt: null,
    last_climax_quality: null,
    last_output: null,
    buildup: emptyBuildup(),
  };
}

function createQuarantinedState(now) {
  const safeNow = Number.isFinite(now) && now >= 0 ? now : 0;
  const state = createInitialState(safeNow);
  state.quarantined = true;
  state.release_gate.locked = true;
  return state;
}

function applyUserEvent(state, {
  eventDigest,
  now,
  stimulus = emptyStimulus(),
  libido = 1,
  releaseEffectId = "",
  releaseTargets = emptyReleaseTargets(),
} = {}) {
  if (!isValidDigest(eventDigest)) {
    return failClosedResult(state, now, "invalid_event_digest");
  }
  if (!isValidState(state)) {
    return failClosedResult(state, now, "invalid_user_state");
  }
  if (state?.processed_event_ids?.includes(eventDigest)) {
    return { state, duplicate: true, accepted: true, released: false, receipt: null };
  }
  if (!isFiniteUnit(libido) || !isValidStimulus(stimulus)) {
    return failClosedResult(state, now, "invalid_user_event");
  }

  const advanced = advanceState(state, now);
  if (advanced.quarantined) {
    return { state: advanced, duplicate: false, accepted: false, released: false, receipt: null };
  }
  const next = applyStimulus(advanced, stimulus, libido, now);
  next.processed_event_ids = appendBounded(next.processed_event_ids, eventDigest);
  if (stimulus.stopped) {
    return { state: next, duplicate: false, accepted: true, released: false, receipt: null };
  }
  return maybeRelease(next, {
    now,
    intent: false,
    effectId: releaseEffectId,
    targets: releaseTargets,
    cause: "threshold",
  });
}

function applyAssistantEvent(state, {
  eventDigest,
  sourceUserEventDigest,
  sourceUserSeen = false,
  complete = true,
  now,
  stimulus = emptyStimulus(),
  libido = 1,
  releaseIntent = false,
  releaseEffectId = "",
  releaseTargets = emptyReleaseTargets(),
} = {}) {
  if (!complete) {
    return { state, duplicate: false, accepted: false, released: false, receipt: null };
  }
  if (!isValidDigest(eventDigest) || !isValidDigest(sourceUserEventDigest)) {
    return failClosedResult(state, now, "invalid_assistant_event");
  }
  if (!isValidState(state)) {
    return failClosedResult(state, now, "invalid_assistant_state");
  }
  if (state?.processed_event_ids?.includes(eventDigest)) {
    return { state, duplicate: true, accepted: true, released: false, receipt: null };
  }
  if (!sourceUserSeen && !state?.processed_event_ids?.includes(sourceUserEventDigest)) {
    return { state, duplicate: false, accepted: false, released: false, receipt: null };
  }
  if (!isFiniteUnit(libido) || !isValidStimulus(stimulus)) {
    return failClosedResult(state, now, "invalid_assistant_event");
  }

  const advanced = advanceState(state, now);
  if (advanced.quarantined) {
    return { state: advanced, duplicate: false, accepted: false, released: false, receipt: null };
  }
  const next = applyStimulus(advanced, stimulus, libido, now);
  next.processed_event_ids = appendBounded(next.processed_event_ids, eventDigest);
  next.processed_release_candidate_event_ids = appendBounded(
    next.processed_release_candidate_event_ids,
    eventDigest
  );
  if (stimulus.stopped) {
    return { state: next, duplicate: false, accepted: true, released: false, receipt: null };
  }
  return maybeRelease(next, {
    now,
    intent: Boolean(releaseIntent),
    effectId: releaseEffectId,
    targets: releaseTargets,
    cause: releaseIntent ? "voluntary" : "threshold",
  });
}

function applyControlEvent(state, { eventDigest, type, generation, now } = {}) {
  if (!isValidDigest(eventDigest) || !isValidState(state)) {
    return failClosedResult(state, now, "invalid_control_event");
  }
  if (state.processed_control_event_ids.includes(eventDigest)) {
    return { state, duplicate: true, accepted: true, released: false, receipt: null };
  }
  const validTypes = new Set(["lock", "release_once", "unlock"]);
  if (!validTypes.has(type) || !Number.isInteger(generation)) {
    return failClosedResult(state, now, "invalid_control_event");
  }
  if (generation !== state.release_gate.generation + 1) {
    return failClosedResult(state, now, "control_generation_mismatch");
  }

  const advanced = advanceState(state, now);
  if (advanced.quarantined) {
    return { state: advanced, duplicate: false, accepted: false, released: false, receipt: null };
  }
  const next = cloneState(advanced);
  next.release_gate.generation = generation;
  if (type === "lock") {
    next.release_gate.locked = true;
    next.release_gate.release_once_generation = null;
  } else if (type === "release_once") {
    if (!next.release_gate.locked) {
      return failClosedResult(next, now, "release_once_requires_lock");
    }
    next.release_gate.release_once_generation = generation;
  } else {
    next.release_gate.locked = false;
    next.release_gate.release_once_generation = null;
  }
  next.processed_control_event_ids = appendBounded(next.processed_control_event_ids, eventDigest);
  return { state: next, duplicate: false, accepted: true, released: false, receipt: null };
}

function acknowledgeReleaseEffect(state, { effectId, target } = {}) {
  if (!isValidDigest(effectId) || !isValidState(state)) {
    return { state, accepted: false, completed: false };
  }
  if (state.completed_release_effect_ids.includes(effectId)) {
    return { state, accepted: true, completed: true, duplicate: true };
  }
  const receipt = state.pending_release_receipt;
  if (!receipt || receipt.effect_id !== effectId || !["somatic", "drive"].includes(target)) {
    return { state, accepted: false, completed: false };
  }
  if (!receipt.targets[target]) {
    return { state, accepted: false, completed: false };
  }
  const next = cloneState(state);
  next.pending_release_receipt.acked[target] = true;
  const complete = Object.entries(next.pending_release_receipt.targets)
    .every(([name, required]) => !required || next.pending_release_receipt.acked[name]);
  if (complete) {
    next.completed_release_effect_ids = appendBounded(next.completed_release_effect_ids, effectId);
    next.pending_release_receipt = null;
  }
  return { state: next, accepted: true, completed: complete, duplicate: false };
}

function publicSnapshot(state, now) {
  if (!isValidState(state)) {
    throw new Error("invalid arousal state");
  }
  const advanced = advanceState(state, now);
  if (!isValidState(advanced)) {
    throw new Error("invalid arousal state");
  }
  const phase = derivePhase(advanced, now);
  return {
    reserve: advanced.reserve,
    reserve_label: reserveLabel(advanced.reserve),
    phase,
    phase_label: phaseLabel(phase),
    refractory: phase === "refractory",
    last_climax_quality: advanced.last_climax_quality,
    last_climax_quality_label: nullableQualityLabel(advanced.last_climax_quality),
    last_output: advanced.last_output,
    last_output_label: nullableOutputLabel(advanced.last_output),
  };
}

function statusLine(state, now) {
  if (!isValidState(state)) {
    return "射精值：状态已锁定，等待本地修复";
  }
  const phase = derivePhase(advanceState(state, now), now);
  const lines = {
    idle: "",
    charged: "射精值：正在充能",
    edge: "射精值：已经到边缘，持续接触停在这里，需要新的动作",
    locked: "射精值：被锁在边缘，不能自行释放",
    pending: "射精值：释放回执正在本地结算",
    refractory: "射精值：刚射过，短恢复中，第二轮仍可继续积累",
  };
  return lines[phase] || "";
}

function advanceState(state, now) {
  if (!isValidState(state) || !Number.isFinite(now) || now < 0) {
    return createQuarantinedState(Number.isFinite(now) ? Math.max(0, now) : 0);
  }
  if (state.quarantined) {
    return state;
  }
  if (now < state.at || now < state.reserve_at) {
    const quarantined = cloneState(state);
    quarantined.quarantined = true;
    quarantined.release_gate.locked = true;
    return quarantined;
  }
  const next = cloneState(state);
  const elapsed = now - next.at;
  const reserveElapsed = now - next.reserve_at;
  if (next.value >= EDGE) {
    const secondsUntilEdgeExit = TAU_SECONDS * Math.log(next.value / EDGE);
    next.buildup.edge_seconds += Math.min(elapsed, Math.max(0, secondsUntilEdgeExit));
  }
  next.value = next.value * Math.exp(-elapsed / TAU_SECONDS);
  next.reserve = Math.min(1, next.reserve + reserveElapsed / RESERVE_RECOVERY_SECONDS);
  next.at = now;
  next.reserve_at = now;
  return next;
}

function applyStimulus(state, stimulus, libido, now) {
  const next = cloneState(state);
  if (stimulus.stopped || stimulus.amount <= 0 || now < next.refractory_until) {
    return next;
  }
  let delta;
  if (stimulus.passive_contact) {
    delta = next.value < PASSIVE_CONTACT_CAP
      ? Math.min(PASSIVE_CONTACT_CAP - next.value, stimulus.amount * GAIN * 0.08)
      : 0;
  } else {
    delta = stimulus.amount * libido * GAIN;
  }
  if (!(delta > 0)) {
    return next;
  }
  next.value = Math.min(1, next.value + delta);
  next.buildup.valid_shots += 1;
  next.buildup.active_since = next.buildup.active_since ?? now;
  next.buildup.peak_value = Math.max(next.buildup.peak_value, next.value);
  next.buildup.stimulus_delta += delta;
  return next;
}

function maybeRelease(state, { now, intent, effectId, targets, cause }) {
  if (state.quarantined || state.pending_release_receipt || now < state.refractory_until) {
    return { state, duplicate: false, accepted: true, released: false, receipt: null };
  }
  const thresholdReached = state.value >= POINT_OF_NO_RETURN;
  const voluntaryReady = intent && state.value >= CHARGED;
  if (!thresholdReached && !voluntaryReady) {
    return { state, duplicate: false, accepted: true, released: false, receipt: null };
  }
  const oneShotAllowed = state.release_gate.locked
    && state.release_gate.release_once_generation === state.release_gate.generation;
  if (state.release_gate.locked && !oneShotAllowed) {
    return { state, duplicate: false, accepted: true, released: false, receipt: null };
  }
  if (!isValidDigest(effectId) || !isValidReleaseTargets(targets)) {
    return failClosedResult(state, now, "invalid_release_receipt");
  }

  const next = cloneState(state);
  const reserveBefore = next.reserve;
  const activeDuration = next.buildup.active_since == null ? 0 : Math.max(0, now - next.buildup.active_since);
  const pathScore = boundedPathScore(next, activeDuration);
  const quality = unit(0.40 * reserveBefore + 0.60 * pathScore);
  const output = unit(0.80 * reserveBefore + 0.20 * pathScore);
  next.last_climax_quality = quality;
  next.last_output = output;
  next.reserve = unit(reserveBefore * (0.28 + 0.17 * pathScore));
  next.reserve_at = now;
  next.value = 0;
  next.at = now;
  next.refractory_until = now + interpolateRefractorySeconds(reserveBefore);
  next.buildup = emptyBuildup();
  if (oneShotAllowed) {
    next.release_gate.release_once_generation = null;
  }

  const receipt = {
    payload_version: 1,
    effect_id: effectId,
    cause,
    created_at: now,
    targets: { somatic: targets.somatic, drive: targets.drive },
    acked: { somatic: false, drive: false },
  };
  const hasTargets = receipt.targets.somatic || receipt.targets.drive;
  if (hasTargets) {
    next.pending_release_receipt = receipt;
  } else {
    next.completed_release_effect_ids = appendBounded(next.completed_release_effect_ids, effectId);
  }
  return { state: next, duplicate: false, accepted: true, released: true, receipt };
}

function derivePhase(state, now) {
  if (state.quarantined || state.release_gate.locked) return "locked";
  if (state.pending_release_receipt) return "pending";
  if (now < state.refractory_until) return "refractory";
  if (state.value >= EDGE) return "edge";
  if (state.value >= CHARGED) return "charged";
  return "idle";
}

function boundedPathScore(state, activeDuration) {
  const shotScore = unit(state.buildup.valid_shots / 10);
  const durationScore = unit(activeDuration / 600);
  const edgeScore = unit(state.buildup.edge_seconds / 120);
  const deltaScore = unit(state.buildup.stimulus_delta);
  return unit(
    0.27 * state.value
    + 0.13 * state.buildup.peak_value
    + 0.18 * durationScore
    + 0.18 * edgeScore
    + 0.14 * shotScore
    + 0.10 * deltaScore
  );
}

function interpolateRefractorySeconds(reserveBefore) {
  return REFRACTORY_MIN_SECONDS
    + (1 - reserveBefore) * (REFRACTORY_MAX_SECONDS - REFRACTORY_MIN_SECONDS);
}

function emptyStimulus() {
  return { amount: 0, passive_contact: false, stopped: false, release_intent: false };
}

function emptyReleaseTargets() {
  return { somatic: false, drive: false };
}

function emptyBuildup() {
  return {
    valid_shots: 0,
    active_since: null,
    peak_value: 0,
    edge_seconds: 0,
    stimulus_delta: 0,
  };
}

function isValidState(state) {
  if (!hasExactKeys(state, STATE_KEYS)) return false;
  if (state.schema_version !== SCHEMA_VERSION || state.initialized !== true) return false;
  if (typeof state.quarantined !== "boolean") return false;
  if (!isFiniteUnit(state.value) || !isFiniteUnit(state.reserve)) return false;
  if (![state.at, state.refractory_until, state.reserve_at].every((value) => Number.isFinite(value) && value >= 0)) return false;
  if (!hasExactKeys(state.release_gate, ["locked", "generation", "release_once_generation"])) return false;
  if (typeof state.release_gate.locked !== "boolean" || !Number.isInteger(state.release_gate.generation) || state.release_gate.generation < 0) return false;
  if (state.release_gate.release_once_generation !== null
    && (!Number.isInteger(state.release_gate.release_once_generation)
      || !state.release_gate.locked
      || state.release_gate.release_once_generation !== state.release_gate.generation)) return false;
  if (state.quarantined && !state.release_gate.locked) return false;
  const digestLists = [
    state.processed_event_ids,
    state.processed_control_event_ids,
    state.processed_release_candidate_event_ids,
    state.completed_release_effect_ids,
  ];
  if (!digestLists.every((list) => Array.isArray(list) && list.length <= RECENT_DIGEST_LIMIT && list.every(isValidDigest))) return false;
  if (!isNullableUnit(state.last_climax_quality) || !isNullableUnit(state.last_output)) return false;
  if (!isValidBuildup(state.buildup)) return false;
  if (state.pending_release_receipt === null) return true;
  return isValidReceipt(state.pending_release_receipt)
    && !state.completed_release_effect_ids.includes(state.pending_release_receipt.effect_id);
}

function isValidBuildup(value) {
  return hasExactKeys(value, ["valid_shots", "active_since", "peak_value", "edge_seconds", "stimulus_delta"])
    && Number.isInteger(value.valid_shots) && value.valid_shots >= 0
    && (value.active_since === null || (Number.isFinite(value.active_since) && value.active_since >= 0))
    && isFiniteUnit(value.peak_value)
    && Number.isFinite(value.edge_seconds) && value.edge_seconds >= 0
    && Number.isFinite(value.stimulus_delta) && value.stimulus_delta >= 0;
}

function isValidReceipt(value) {
  const shapeValid = hasExactKeys(value, ["payload_version", "effect_id", "cause", "created_at", "targets", "acked"])
    && value.payload_version === 1
    && isValidDigest(value.effect_id)
    && ["threshold", "voluntary"].includes(value.cause)
    && Number.isFinite(value.created_at) && value.created_at >= 0
    && isValidReleaseTargets(value.targets)
    && isValidReleaseTargets(value.acked);
  if (!shapeValid || (!value.targets.somatic && !value.targets.drive)) return false;
  return (!value.acked.somatic || value.targets.somatic)
    && (!value.acked.drive || value.targets.drive);
}

function isValidStimulus(value) {
  return hasExactKeys(value, ["amount", "passive_contact", "stopped", "release_intent"])
    && isFiniteUnit(value.amount)
    && typeof value.passive_contact === "boolean"
    && typeof value.stopped === "boolean"
    && typeof value.release_intent === "boolean";
}

function isValidReleaseTargets(value) {
  return hasExactKeys(value, ["somatic", "drive"])
    && typeof value.somatic === "boolean"
    && typeof value.drive === "boolean";
}

function failClosedResult(state, now, reason) {
  const next = isValidState(state) ? cloneState(state) : createQuarantinedState(Number.isFinite(now) ? Math.max(0, now) : 0);
  next.quarantined = true;
  next.release_gate.locked = true;
  return { state: next, duplicate: false, accepted: false, released: false, receipt: null, reason };
}

function appendBounded(list, digest) {
  return [...list, digest].slice(-RECENT_DIGEST_LIMIT);
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isValidDigest(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isFiniteUnit(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNullableUnit(value) {
  return value === null || isFiniteUnit(value);
}

function requireFiniteTime(value) {
  if (!Number.isFinite(value) || value < 0) throw new Error("now must be a non-negative finite number");
}

function unit(value) {
  return Math.max(0, Math.min(1, value));
}

function reserveLabel(value) {
  if (value >= 0.75) return "充足";
  if (value >= 0.40) return "平衡";
  return "偏低";
}

function nullableQualityLabel(value) {
  if (value === null) return null;
  if (value >= 0.75) return "很深";
  if (value >= 0.45) return "充实";
  return "偏浅";
}

function nullableOutputLabel(value) {
  if (value === null) return null;
  if (value >= 0.75) return "充足";
  if (value >= 0.45) return "适中";
  return "偏少";
}

function phaseLabel(phase) {
  return ({
    refractory: "恢复中",
    pending: "待结算",
    locked: "锁定",
    edge: "临界",
    charged: "充能中",
    idle: "平静",
  })[phase];
}

module.exports = {
  CHARGED,
  EDGE,
  POINT_OF_NO_RETURN,
  acknowledgeReleaseEffect,
  applyAssistantEvent,
  applyControlEvent,
  applyUserEvent,
  createInitialState,
  createQuarantinedState,
  derivePhase,
  emptyReleaseTargets,
  emptyStimulus,
  isValidState,
  publicSnapshot,
  statusLine,
};
