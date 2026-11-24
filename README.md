# dantonio-pi-meter

One subtle line above the Pi editor.

```text
in 93.6k · out 3.1k · cacheR 80k · cacheW 1.2k · 42 tok/s · avg 31 · +2 sa @14 · sa 51 tok/s
```

- `in` is the full prompt volume: uncached input plus `cacheR` plus `cacheW`. This is the same number `/session-info` prints as **Input** for the orchestrator session file, so the line reconciles with that panel by construction.
- `cacheR` / `cacheW` are the cached split of `in`: tokens served from cache and tokens written to cache.
- `out` is provider-reported output. `in` `out` `cacheR` `cacheW` cover the orchestrator plus every settled subagent.
- `tok/s` is the live decode rate of the current orchestrator response. It is a character-stream estimate (about 4 characters per token), shown only while text is arriving.
- `avg` is the session average over every timed agent: the orchestrator plus each settled subagent, as total timed output tokens divided by total measured generation time. The orchestrator's timing is appended to the session file after every timed response; each subagent's decode timing is read from its own session file on disk (per-message `durationMs`, joined through the gentle-agents task record's `sessionPath`) and rides the same persisted child snapshot, so the average also survives resume and reload. A subagent whose timing cannot be read contributes tokens but not time — the average stays over the timed subset and never guesses.
- `sa <rate> tok/s` is the live decode rate of the subagents running right now, tailing their session files incrementally. It updates at message-completion cadence (when a child finishes a response, not per character) and aggregates several running children as total windowed output over total windowed duration. It disappears when no child is measurable — never a placeholder.
- `+N sa` counts settled subagents folded into the totals. When subagent task
  throughput is measurable it rides the marker as `+N sa @R`.

## Reconciling with `/session-info`

`/session-info` reads the orchestrator session file only. The meter additionally folds every settled subagent, so its totals can legitimately exceed the panel's. To compare:

- `in` minus the subagents' prompt volume equals the panel's Input.
- `out` minus the subagents' output equals the panel's Output.
- The `+N sa` marker tells you how many subagents are inside the totals.

## Session lifecycle

- On `session_start` the meter folds the session's existing entries (assistant messages, summary tool results, compaction and branch summaries, standalone usage entries), so a resumed or reloaded session starts from its full history instead of from the moment the process came up.
- Fresh compactions fold their summary tokens as they happen (`session_compact`).
- Subagent snapshots are keyed by task id: a re-delivered snapshot replaces the stored one, and a revoked task's tokens are dropped.
- Every settled subagent is also appended to the orchestrator session file as a custom entry (`dantonio-pi-meter:child-usage/v1`: task id, tokens, wall time, and the subagent's decode timing when readable). On resume or reload the meter restores those snapshots, so `out`, `in` and the `+N sa` marker keep counting subagents across sessions instead of dropping back to orchestrator-only numbers. A revoked task persists a tombstone that drops it on restore too.
- The cumulative `avg` timing rides the same mechanism as custom entries (`dantonio-pi-meter:avg-timing/v1` for the orchestrator, `timingMs`/`timedOutput` fields inside each `dantonio-pi-meter:child-usage/v1` snapshot for subagents); the last entry wins on fold, and snapshots without timing get a one-shot disk backfill on session start.
- Wall-time windows are kept only when plausible (finite, positive, at most one day). Snapshots persisted by versions that mixed `Date.now()` with the relay's `performance.now()` launch time stored windows of ~1.8e12 ms; those windows are dropped on restore while their tokens still count, so `@R` simply stays hidden instead of showing an absurd rate.

## What the meter does not count

Known blind spots, measured against subagent ground truth on 2026-11-22 (details in the session audit): a child's compaction and branch summaries (never emitted as assistant responses), turns beyond the relay's 128-response buffer, children killed by a session shutdown or settling while another session is active, and telemetry-env vetoes (`DO_NOT_TRACK`, `CI`, `GENTLE_AI_TELEMETRY=0`). What is persisted is exactly what the relay reported at settle time.

## Render cost

The line is cached. It is rebuilt at most four times per second while the orchestrator streams, once when a response or subagent settles, and never on a clock. Pi diffs the screen by line, so an unchanged string writes nothing to the terminal. There is no sparkline, no mouse handler, and no per-token render.

## Limits

The parent's live `tok/s` stays orchestrator-only: subagents run in separate
processes and their streaming deltas never reach a parent-session extension.
The child live segment (`sa <rate> tok/s`) is child-only, built by tailing
session files, so it reads at message-completion cadence rather than per
character. The combined `avg` covers both, with one unit nuance: a child's
per-message `durationMs` includes request setup (timestamp to end), while the
parent's timing starts at the first streamed delta, so children weight the
average slightly conservatively. Two blind spots remain by source: subagent
token totals come from the relay's final-assistant snapshot, while the avg
timing comes from the child's session file, and legacy child messages without
`durationMs` stay untimed (tokens count, time does not). Subagent events also
carry task wall time (`launchedAt` to settle), feeding the `@R` beside the
count marker — still **task throughput**, a different unit: total subagent
output tokens divided by total settled task wall time. Task time includes
queueing, thinking and tool execution, so `@R` reads lower than a decode rate
and belongs to no model — it answers "how fast do my subagents finish work",
not "how fast does the model decode". The relay may omit `cacheWrite`; an
absent field renders as 0, never as a guess. All disk reads behind these
metrics are best-effort reads of files Pi writes anyway; a missing or
malformed file degrades that metric to hidden, never to a wrong number.

## Subscription usage panel (alt+u)

The meter also feeds Gentle Shell's usage panel (`alt+u` or `/gentle:usage`)
with subscription usage from the providers below. A source appears in the
panel only when the session targets that provider (the active provider or
one named by the active profile's subagent routing) and its API key is
configured in Pi; nothing is fetched otherwise.

| Provider | Usage data | Source |
| --- | --- | --- |
| Anthropic (Claude) | rate-limit windows | built into Gentle Shell |
| OpenAI Codex | rate-limit windows | built into Gentle Shell |
| nan | quota | built into Gentle Shell |
| torogoz | 7-day totals + per-model quotas | this package |
| OpenCode Go | rolling 5h / weekly / monthly windows | this package |
| OpenRouter | key credit limit + budget windows | this package |
| your router | whatever its API exposes | this package (custom, see below) |

Gemini (AI Studio / Vertex / Code Assist) and CommandCode's own plan expose
no public usage API, so no honest row exists for them; their BYOK traffic
shows up under the underlying provider (OpenRouter, etc.). OpenRouter's
deprecated `rate_limit` object is ignored on purpose.

### Custom providers

Any bearer-authenticated endpoint whose response matches one of the shipped
mapper styles can be added in settings, no code:

```json
"dantonio-pi-meter": {
  "usageProviders": [
    { "provider": "myrouter", "url": "https://api.myrouter.com/api/v1/key", "style": "openrouter" },
    { "provider": "gw", "url": "https://gw.example.org/v1/usage?days=7", "style": "usage_summary" }
  ]
}
```

- `provider` must be the session's provider id — that is how the shell
  resolves the API key and decides to show the row.
- `style` picks the response mapper: `openrouter` (the `GET /api/v1/key`
  shape, the de-facto router standard), `usage_summary` (torogoz-style
  quota rows), or `opencode-go` (rolling/weekly/monthly percent windows).
- Malformed entries are dropped; a broken custom provider never takes the
  session down.

## Install

```bash
pi install git:github.com/dantoniomarte/dantonio-pi-meter
```

Restart Pi or run `/reload`.

