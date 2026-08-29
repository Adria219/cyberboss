const LEXICON_KEYS = ["schema_version", "actions", "body_parts", "postures", "release_terms"];
const ACTION_KEYS = ["token", "weight", "passive"];
const BODY_KEYS = ["token", "sensitivity"];
const POSTURE_KEYS = ["token", "multiplier"];

function parseArousalStimulus({ text, actor, lexicon } = {}) {
  if (!["user", "assistant"].includes(actor)) {
    return emptyStimulus();
  }
  const raw = currentMessageText(text);
  if (/(?:不要|停止|停下|别继续|不可以继续|STOP_ALPHA|STOP_BETA)/u.test(raw)) {
    return { ...emptyStimulus(), stopped: true };
  }
  if (!validateLexicon(lexicon)) return emptyStimulus();
  const candidate = filterCandidateText(raw, actor);
  if (!candidate) return emptyStimulus();

  const actions = lexicon.actions
    .filter((entry) => candidate.includes(entry.token))
    .sort((left, right) => right.weight - left.weight);
  const bodies = lexicon.body_parts.filter((entry) => candidate.includes(entry.token));
  const postures = lexicon.postures.filter((entry) => candidate.includes(entry.token));
  const strongest = actions[0];
  const second = actions[1];
  if (!strongest) {
    return emptyStimulus();
  }
  const sensitivity = bodies.length
    ? Math.max(...bodies.map((entry) => entry.sensitivity))
    : 1;
  const posture = postures.length
    ? Math.max(...postures.map((entry) => entry.multiplier))
    : 1;
  const amount = Math.min(1, (strongest.weight + (second?.weight || 0) * 0.25) * sensitivity * posture);
  const releaseIntent = actor === "assistant"
    && hasAny(candidate, lexicon.release_terms)
    && /(?:我|SELF_ALPHA|SELF_BETA)/u.test(candidate);
  return {
    amount,
    passive_contact: strongest.passive,
    stopped: false,
    release_intent: releaseIntent,
  };
}

function currentMessageText(value) {
  const text = String(value || "").trim();
  if (!text.startsWith("[Quoted:")) return text;
  const lineBreak = text.indexOf("\n");
  return lineBreak >= 0 ? text.slice(lineBreak + 1).trim() : "";
}

function filterCandidateText(value, actor) {
  const text = String(value || "").trim();
  if (!text || text.length > 20_000) return "";
  if (/https?:\/\//iu.test(text) || /```/u.test(text)) return "";
  if (/[?？]\s*$/u.test(text)
    || /(?:吗|么|呢)\s*$/u.test(text)
    || /(?:以后|下次|等会|如果|假设|打算|准备|想象|PLAN_ALPHA)/u.test(text)
    || /(?:没有|没在|不要|别|不会|不能|不想|并未|NEGATE_ALPHA)/u.test(text)
    || /(?:曾经|回忆|之前说|刚才说|RECALL_ALPHA)/u.test(text)
    || /(?:他|她|他们|她们|别人|THIRD_PARTY_ALPHA)/u.test(text)
    || hasAny(text, ["QUESTION_ALPHA", "QUOTE_ALPHA"])) {
    return "";
  }
  if (actor === "assistant" && !/(?:我|SELF_ALPHA|SELF_BETA)/u.test(text)) {
    return "";
  }
  return text;
}

function validateLexicon(value) {
  if (!hasExactKeys(value, LEXICON_KEYS) || value.schema_version !== 1) return false;
  if (!Array.isArray(value.actions) || !Array.isArray(value.body_parts)
    || !Array.isArray(value.postures) || !Array.isArray(value.release_terms)) return false;
  return value.actions.every((entry) => hasExactKeys(entry, ACTION_KEYS)
      && isToken(entry.token) && isUnit(entry.weight) && typeof entry.passive === "boolean")
    && value.body_parts.every((entry) => hasExactKeys(entry, BODY_KEYS)
      && isToken(entry.token) && isUnit(entry.sensitivity))
    && value.postures.every((entry) => hasExactKeys(entry, POSTURE_KEYS)
      && isToken(entry.token) && Number.isFinite(entry.multiplier)
      && entry.multiplier >= 0.5 && entry.multiplier <= 1.5)
    && value.release_terms.every(isToken);
}

function emptyStimulus() {
  return { amount: 0, passive_contact: false, stopped: false, release_intent: false };
}

function hasAny(text, tokens) {
  return tokens.some((token) => text.includes(token));
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && expected.slice().sort().every((key, index) => key === actual[index]);
}

function isToken(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 80;
}

function isUnit(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

module.exports = { emptyStimulus, parseArousalStimulus, validateLexicon };
