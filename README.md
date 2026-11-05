# dantonio-pi-meter

One subtle line above the Pi editor.

```text
in 93.6k · out 3.1k · cacheR 80k · cacheW 1.2k · 42 tok/s · avg 31 · +2 sa @14
```

- `in` is the full prompt volume: uncached input plus `cacheR` plus `cacheW`. This is the same number `/session-info` prints as **Input** for the orchestrator session file, so the line reconciles with that panel by construction.
- `cacheR` / `cacheW` are the cached split of `in`: tokens served from cache and tokens written to cache.
- `out` is provider-reported output. `in` `out` `cacheR` `cacheW` cover the orchestrator plus every settled subagent.
- `tok/s` is the live decode rate of the current orchestrator response. It is a character-stream estimate (about 4 characters per token), shown only while text is arriving.
- `avg` is the session average: reported orchestrator output tokens divided by measured orchestrator generation time.
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

## Render cost

The line is cached. It is rebuilt at most four times per second while the orchestrator streams, once when a response or subagent settles, and never on a clock. Pi diffs the screen by line, so an unchanged string writes nothing to the terminal. There is no sparkline, no mouse handler, and no per-token render.

## Limits

Subagent events report tokens and task wall time (`launchedAt` to settle) but
no generation duration, so the two decode metrics stay orchestrator-only: live
tok/s and `avg` never include subagents. The `@R` beside the count marker is
**task throughput**, a different unit: total subagent output tokens divided by
total settled task wall time. Task time includes queueing, thinking and tool
execution, so `@R` reads lower than a decode rate and belongs to no model — it
answers "how fast do my subagents finish work", not "how fast does the model
decode". The relay may omit `cacheWrite`; an absent field renders as 0, never
as a guess.

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

