# child-decode-metrics

Subagent decode metrics for the meter line: fold child generation time into `avg`
and show a live tokens/second for running children — all inside pi-meter, reading
only files Pi itself writes (child session JSONL, gentle-agents task records).

## Specs

S1: User asked "dejar avg con el promedio de todos los agentes (tanto agente principa como sub agentes)". `avg` must be the decode average across the orchestrator AND every settled subagent: sum(timed output tokens) / sum(generation ms), each agent contributing assistant messages with a real generation duration. Subagents whose timing is unavailable contribute tokens but not timing.

S2: User asked "tok/s para cuando un sub agente esté en cola procesando o varios" (live rate while subagents process). While one or more children are running, the line shows a live child decode segment (`sa <rate> tok/s`), built from each running child's session JSONL via incremental tail: completed assistant messages' output over their `durationMs`. Updates at message-completion cadence, not per char.

S3: User constraint: "quiero una opción sin tocar gentle shell... porque eso no es nuestro, sino que es un repo que otro equipo mantiente. pi meter es nuestro y va sobre gentle shell como un plugin o una extensión". No gentle-pi/gentle-shell source changes. Only reads of files Pi writes anyway: agent home resolution `GENTLE_PI_AGENT_HOME || PI_CODING_AGENT_DIR || ~/.pi/agent`, task records at `<agentHome>/gentle-agents/tasks/<taskId>.json` (field `sessionPath`), child sessions at `<agentHome>/gentle-agents/sessions/*.jsonl`. Bus topics consumed: existing `gentle:runtime-metrics:child/v1` / `revoked/v1` plus `gentle-pi:notification:source` (statuses queued/running/waiting/completed/failed/cancelled/timed_out).

S4: Honest degradation, measured not invented: a child without a readable session path or without `durationMs` entries contributes tokens only; `avg` falls back to the timed subset (parent-only when no child timing exists). No fake rates: the child live segment appears only with measured durations. Known unit nuance, documented: child `durationMs` includes request setup (timestamp → end), the parent's live timing starts at the first delta, so the combined average reads slightly conservative.

## Tasks

T1 (S1, S3, S4): child timing collection — parse child session JSONL (`parseTimedMessages`), per-child timing fold/replace/drop in state, persisted inside the child snapshot entry (`timingMs`/`timedOutput`), combined `avg` in `rates()`; RED tests first. Commit: de1c34c.

T2 (S2, S3, S4): live child rate — notification subscription, per-running-child JSONL tail (offset-tracked incremental read), aggregate live rate into render (`sa <rate> tok/s`), cleanup on settle/revoke/shutdown. Commit: (this slice).

T3 (S1-S4): README update (avg semantics, sa live segment, blind spots: relay final-only `out` vs decode base, message-completion cadence, legacy untimed children). Commit: (this slice, with package version 0.4.2 -> 0.5.0).

### Log (work notes)

- T1 slice was 495 authored lines — past the ~400-line boundary, recorded here per delivery policy.
- T1 review note: commit message documented a bounded settle-race retry that the code did not implement (`readChildTimingRetried` missing from child-sessions.ts; tests never import meter.ts). Fixed at the start of T2 along with the T2 wiring; keep meter.ts wiring covered by a smoke import check in future slices.
- T2: truncation detection needs mtime comparison, not just size < offset (truncate-and-rewrite at equal size would be missed).
- Verification boundary: disk-reading paths are unit-tested against the real on-disk shapes (task record and child JSONL verified 2026-11-24); the meter.ts live wiring (notification subscription, tail drive at render cadence) passed syntax and full-suite checks only — end-to-end confirmation needs a real session running subagents after /reload.
- T2 shipped a stray `}` at meter.ts:168 (Gitea issue #2): the entry file did not parse and every pi process in the agent home exited 1 at startup — shell and subagents down until the package was removed. No test imported the entry, so the suite was green on a fatal file. Fixed in 2cfa1a2 (brace removed) with test/extensions-syntax.test.ts: stripTypeScriptTypes over every extensions/*.ts, manifest entries included; `node --check` is not a valid TS gate (false pass on the broken file). Load check before install is now mandatory (R3).

## Log

L1: "ok. Hay opción de agregar tok/s para cuando un sub agente esté en cola procesando o varios? y dejar avg con el promedio de todos los agentes (tanto agente principa como sub agentes) es posible?" — feasibility confirmed by relay exploration: the child metrics event fires once at settle with timing structurally forced unavailable; child session JSONL carries per-message `timestamp`+`durationMs`; task records carry `sessionPath`.

L2: "osea, quiero una opción sin tocar gentle shell... porque eso no es nuestro, sino que es un repo que otro equipo mantiente. pi meter es nuestro y va sobre gentle shell como un plugin o una extensión" — design fixed: disk-only reads inside pi-meter; the internal RPC seam (agents-service) was rejected as undocumented.

L3: "issue 2 , trabajalo con el workflow y no vuelvas a cometer una cagada así. Me arruinaste gentle shell." — Gitea issue #2 (gitea-vigil forensics): 822b73b introduced an extra `}` at meter.ts:168, the entry file failed to parse, pi exited 1 at startup in the agent home, 4 of 4 subagent tasks failed before their first turn, recovery required removing the package. Remediation per the issue: R1 brace deleted (2cfa1a2), R2 syntax gate added over all eleven extension files (2cfa1a2, RED first against the broken tip), R3 load check before reinstall (this session), R4 pin the installed source to master/tag instead of the moving branch tip — operational, owner's decision.
