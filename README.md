# dantonio-pi-meter

One subtle line above the Pi editor.

```text
in 93.6k · out 3.1k · cacheR 80k · cacheW 1.2k · 42 tok/s · avg 31 · +2 sa
```

- `in` is the full prompt volume: uncached input plus `cacheR` plus `cacheW`. This is the same number `/session-info` prints as **Input** for the orchestrator session file, so the line reconciles with that panel by construction.
- `cacheR` / `cacheW` are the cached split of `in`: tokens served from cache and tokens written to cache.
- `out` is provider-reported output. `in` `out` `cacheR` `cacheW` cover the orchestrator plus every settled subagent.
- `tok/s` is the live decode rate of the current orchestrator response. It is a character-stream estimate (about 4 characters per token), shown only while text is arriving.
- `avg` is the session average: reported orchestrator output tokens divided by measured orchestrator generation time.
- `+N sa` counts settled subagents folded into the totals.

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

Subagent events report tokens but not generation duration, so subagent time cannot move `avg`. Their tokens are included in the totals when the task settles. The relay may omit `cacheWrite`; an absent field renders as 0, never as a guess.

## Install

```bash
pi install git:github.com/dantoniomarte/dantonio-pi-meter
```

Restart Pi or run `/reload`.

