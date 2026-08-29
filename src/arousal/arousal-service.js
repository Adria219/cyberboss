const crypto = require("crypto");
const fs = require("fs");
const {
  acknowledgeReleaseEffect,
  applyAssistantEvent,
  applyControlEvent,
  applyUserEvent,
  publicSnapshot,
  statusLine,
} = require("./arousal-core");
const { parseArousalStimulus, validateLexicon } = require("./context-parser");
const { ArousalStore } = require("./arousal-store");

class ArousalService {
  constructor({ primaryFile, backupFile, lexiconFile, logger = console, now = () => Date.now() / 1000 }) {
    this.store = new ArousalStore({ primaryFile, backupFile });
    this.lexiconFile = lexiconFile;
    this.logger = logger;
    this.now = now;
  }

  recordUserFinal({ eventId, text }) {
    return this.applyCanonicalEvent({ actor: "user", eventId, text, complete: true });
  }

  recordAssistantFinal({ eventId, sourceUserEventId, text, complete = true }) {
    if (!complete) return { accepted: false, duplicate: false, released: false };
    return this.applyCanonicalEvent({ actor: "assistant", eventId, sourceUserEventId, text, complete });
  }

  recordControl({ eventId, type, generation }) {
    const now = this.now();
    const loaded = this.store.load(now);
    if (loaded.kind === "quarantined") return unavailable(loaded.reason);
    if (!this.ensureClock(loaded.envelope, now)) return unavailable("clock_rollback");
    const digest = hashId(eventId);
    if (!digest) return unavailable("invalid_event_id");
    if (loaded.envelope.ledger.control.includes(digest)) return duplicateResult();
    const result = applyControlEvent(loaded.envelope.state, { eventDigest: digest, type, generation, now });
    return this.commitResult(loaded.envelope, result, "control", digest, now);
  }

  acknowledgeEffect({ effectId, target }) {
    const now = this.now();
    const loaded = this.store.load(now);
    if (loaded.kind === "quarantined") return unavailable(loaded.reason);
    if (!this.ensureClock(loaded.envelope, now)) return unavailable("clock_rollback");
    if (loaded.envelope.ledger.release_effect.includes(effectId)) {
      return { accepted: true, completed: true, duplicate: true };
    }
    const result = acknowledgeReleaseEffect(loaded.envelope.state, { effectId, target });
    if (!result.accepted || result.duplicate) return result;
    loaded.envelope.state = result.state;
    loaded.envelope.updated_at = Math.max(loaded.envelope.updated_at, now);
    if (result.completed && !loaded.envelope.ledger.release_effect.includes(effectId)) {
      loaded.envelope.ledger.release_effect.push(effectId);
    }
    this.store.save(loaded.envelope);
    return result;
  }

  getPublicSnapshot() {
    const now = this.now();
    const loaded = this.store.load(now);
    if (loaded.kind === "quarantined") throw new Error("arousal state unavailable");
    if (!this.ensureClock(loaded.envelope, now)) throw new Error("arousal clock rollback");
    return publicSnapshot(loaded.envelope.state, now);
  }

  getStatusLine() {
    const now = this.now();
    const loaded = this.store.load(now);
    if (loaded.kind === "quarantined") return "射精值：状态已锁定，等待本地修复";
    if (!this.ensureClock(loaded.envelope, now)) {
      return "射精值：状态已锁定，等待本地修复";
    }
    return statusLine(loaded.envelope.state, now);
  }

  applyCanonicalEvent({ actor, eventId, sourceUserEventId = "", text, complete }) {
    const now = this.now();
    const loaded = this.store.load(now);
    if (loaded.kind === "quarantined") return unavailable(loaded.reason);
    if (!this.ensureClock(loaded.envelope, now)) return unavailable("clock_rollback");
    const digest = hashId(eventId);
    if (!digest) return unavailable("invalid_event_id");
    const ledgerKey = actor === "user" ? "user" : "assistant";
    if (loaded.envelope.ledger[ledgerKey].includes(digest)) return duplicateResult();

    const lexicon = this.readLexicon();
    const stimulus = parseArousalStimulus({ text, actor, lexicon });
    const effectId = hashId(`release:${digest}:${loaded.envelope.state.release_gate.generation}`);
    const common = {
      eventDigest: digest,
      now,
      stimulus,
      libido: 1,
      releaseEffectId: effectId,
      releaseTargets: { somatic: false, drive: false },
    };
    let result;
    if (actor === "user") {
      result = applyUserEvent(loaded.envelope.state, common);
    } else {
      const sourceDigest = hashId(sourceUserEventId);
      if (!sourceDigest || !loaded.envelope.ledger.user.includes(sourceDigest)) {
        return unavailable("source_user_event_missing");
      }
      result = applyAssistantEvent(loaded.envelope.state, {
        ...common,
        sourceUserEventDigest: sourceDigest,
        sourceUserSeen: true,
        complete,
        releaseIntent: stimulus.release_intent,
      });
    }
    return this.commitResult(loaded.envelope, result, ledgerKey, digest, now);
  }

  commitResult(envelope, result, ledgerKey, digest, now) {
    if (!result.accepted) {
      if (result.state?.quarantined) {
        envelope.state = result.state;
        envelope.updated_at = Math.max(envelope.updated_at, now);
        this.store.save(envelope);
      }
      return result;
    }
    if (result.duplicate) return result;
    envelope.state = result.state;
    envelope.ledger[ledgerKey].push(digest);
    if (result.released && result.receipt && !result.receipt.targets.somatic && !result.receipt.targets.drive) {
      envelope.ledger.release_effect.push(result.receipt.effect_id);
    }
    envelope.updated_at = Math.max(envelope.updated_at, now);
    this.store.save(envelope);
    return result;
  }

  ensureClock(envelope, now) {
    if (now >= envelope.updated_at && now >= envelope.state.at && now >= envelope.state.reserve_at) return true;
    envelope.state = JSON.parse(JSON.stringify(envelope.state));
    envelope.state.quarantined = true;
    envelope.state.release_gate.locked = true;
    this.store.save(envelope);
    return false;
  }

  readLexicon() {
    try {
      if (process.platform !== "win32") fs.chmodSync(this.lexiconFile, 0o600);
      const parsed = JSON.parse(fs.readFileSync(this.lexiconFile, "utf8"));
      if (!validateLexicon(parsed)) throw new Error("invalid lexicon schema");
      return parsed;
    } catch (error) {
      this.logger.error?.(`[cyberboss] arousal lexicon unavailable: ${error.message}`);
      return null;
    }
  }
}

function hashId(value) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 512) return "";
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

function unavailable(reason) {
  return { accepted: false, duplicate: false, released: false, unavailable: true, reason };
}

function duplicateResult() {
  return { accepted: true, duplicate: true, released: false, receipt: null };
}

module.exports = { ArousalService, hashId };
