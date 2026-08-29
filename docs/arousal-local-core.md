# Local Arousal Core

Cyberboss can run an opt-in, local-only body-state unit. It derives a qualitative state from canonical WeChat user messages and completed assistant replies. Scheduled system wakeups, streaming deltas, tool events, failed turns, and incomplete turns do not enter the state machine. A proactive check-in may read the current qualitative status as optional pacing context, but that read does not create an event or require contacting the user; ordinary system tasks do not receive it.

## Enable it

Copy `examples/arousal-lexicon.example.json` to:

```text
~/.cyberboss/arousal/lexicon.private.json
```

Replace the placeholder tokens locally, then configure:

```dotenv
CYBERBOSS_ENABLE_AROUSAL=true
CYBERBOSS_AROUSAL_PORT=4321
CYBERBOSS_AROUSAL_TOKEN=
CYBERBOSS_AROUSAL_ALLOWED_ORIGINS=
```

The feature is completely inactive unless `CYBERBOSS_ENABLE_AROUSAL=true`. The HTTP server always binds to `127.0.0.1`; its bind host is not configurable. Set a bearer token before allowing a browser origin. Origins are a comma-separated exact allowlist.

## Data boundary

Private state lives under `~/.cyberboss/arousal/` as a byte-identical primary/backup pair plus a content-free initialization anchor. The envelope contains state plus digest-only long ledgers. Event IDs are stored only as SHA-256 digests. Message text and private lexicon terms are not stored in the state envelope.

The runtime prompt receives at most one qualitative status line. Numeric state, JSON, event digests, control generations, and release receipts do not enter the prompt. This unit has no connection to Moon Memory, summaries, activity streams, proposals, or formal memories.

Missing or invalid lexicon data contributes zero stimulation and emits only a management log. Missing, mismatched, corrupt, contradictory, or time-rollback state enters a persistent locked/quarantined state.

## Read-only browser contract

`GET http://127.0.0.1:4321/api/arousal/state` returns exactly:

```text
reserve
reserve_label
phase
phase_label
refractory
last_climax_quality
last_climax_quality_label
last_output
last_output_label
```

The response is `no-store`. Unknown fields, missing fields, invalid phases, and out-of-range numbers fail the whole response instead of being normalized.

## Local control contract

The service implements persistent structured `lock`, `release_once`, and `unlock` events. Each event carries a monotonic generation and an idempotent event ID. Public phase is derived from the internal lock state. Control operations are not exposed through the read-only browser endpoint.

## Verification

Run the focused fault-injection suite:

```bash
npm run check:arousal
```
