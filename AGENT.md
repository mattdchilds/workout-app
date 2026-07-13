# AGENT.md — Tumble Trainer orientation for AI agents

Read this first. It replaces most exploratory reading of app.js.

## What this is

Single-user vanilla-JS PWA workout coach (gymnastics / tumbling / joint care) for Matthew.
No build step, no dependencies, no framework. Deployed to GitHub Pages
(https://mattdchilds.github.io/workout-app/) — a `git push` deploys in ~1 min, but phones
only pick it up if the service-worker cache name was bumped.

## Files

| File | Role |
|---|---|
| `app.js` | ALL logic, ~5.5k lines, single file. Section map below. |
| `routine-seed.json` | The data seed: goals, tags, families, main move pool, warm-up/cool-down/daily modules, prose `structure` notes that document the selection rules. Carries the data-schema `"version"`. |
| `index.html` | Static shell only; app.js renders everything into it. |
| `styles.css` | All styling. |
| `sw.js` | Service worker. `const CACHE = 'tumble-trainer-vX.Y.Z'` is the human-facing release version. |
| `SPEC.md` | Running changelog/spec. Append one `## vX.Y — Title` section per release (match prior sections' style). |
| `REDESIGN.md` | v4 architecture plan of record. Only touch when the plan itself changes. |
| `HOW-TO-RUN.txt` | Serving, phone install, cache-refresh instructions. |
| `todo.txt` | The user's own list — clear out finished todos, but only add to it if explicitly asked. |

## Two independent version numbers

1. **Release version** — `sw.js` `CACHE` string. Bump on every shipped change or installed
   PWAs serve stale assets forever.
2. **Data-schema version** — `routine-seed.json` `"version": N` plus a matching
   `migrateRoutineVN(routine, seed)` in app.js, dispatched in `normalizeState`.
   Each migration is version-gated and idempotent (`if ((routine.version||0) >= N) return`).

### Release checklist
1. Edit `routine-seed.json` (bump `version` if data changed).
2. Add `migrateRoutineV{N}` + dispatch line in `normalizeState` — seed edits do NOT reach
   existing installs otherwise (see gotchas).
3. app.js feature work.
4. Bump `sw.js` CACHE.
5. Append `## vX.Y` section to SPEC.md.
6. Verify (see below). Commit message style: `Short description - vX.Y.Z`.

## app.js section map (search these identifiers; line numbers drift)

- **Constants/state**: `V1_KEY`/`V2_KEY` (localStorage `tumbleTrainer.v2` holds everything;
  OpenAI key separate under `tumbleTrainer.openaiKey`, excluded from backup export),
  transient `ui` object, `READINESS_LEVELS`, `defaultReadiness`/`normalizeReadiness`,
  `freshState(routine)`.
- **Migrations**: `migrateRoutineV7`…`V19` chain, then `normalizeState` (dispatch + settings
  repair + `saveState`).
- **Move metadata**: `LOAD_KEYS = ['impact','shin','knee','foot','wrist','elbow','lumbar']`,
  `moveLoad`, `moveFatigue`, `isArmSupport`, `GENERATOR_BUDGETS`.
- **Readiness engine**: `readinessCaps` (light → cap 1, skip → cap 0; back→lumbar; wrist
  light→wrist1+elbow1, skip→wrist0+elbow1), `passesReadiness` (hard filter: any capped key
  where moveLoad > cap drops the move), `sessionBudgets`, `bustsBudget`. Care promotion
  (v4.8): `readinessLightKeys`/`moveHelps` + move `helps` metadata — a light region
  pre-picks its best helper in `selectMoves` and boosts a possible second (×2, max 2);
  `READINESS_CARE_MODULES` pins prep modules into the warm-up. Light only, never skip.
- **Generators**: `selectMoves` (scored pool picking: goalScores × goal weights × tag
  priority multipliers, recency boost, section diminishing returns), `buildWarmup`,
  `buildCooldown`, `buildDaily`, `buildSession`, `buildFutureSession`. All apply
  `passesReadiness`; module-based builders drop modules emptied by gating.
- **Rendering**: Gym/Today tab (readiness panel `renderReadinessPanel`, adjust-session
  panel, block cards), cool-down/daily cards, Settings, Coach (OpenAI chat; context
  builders summarize state into prose).
- **Action dispatch**: one delegated click handler switching on `data-action`.
- **Mutations**: `setReadiness`/`resetReadiness`, mode cyclers, `finishSession` (logging,
  progression tally, readiness reset).
- **Bootstrap + test hook**: localStorage load at the bottom; `module.exports` exposes pure
  functions for Node smoke tests — add to it freely.

## Domain model in one paragraph

Moves carry `loads` (0–3 per LOAD_KEY — the biomechanical gating data), `fatigue`,
`goalScores` (per training goal), optional `tags`, `family`, `dose`, optional
`progression` ladder. The pre-session **readiness check-in** (`state.readiness`) is a set
of per-region session dials — shins/knee/foot/back/wrist, each `good`/`light`/`skip`, plus
`energy` and `classSoon` — transient, reset by `finishSession`, repaired by
`normalizeReadiness` on load. Dials are NOT injuries or chronic conditions; the coach
prose says so explicitly. Gating = loads vs `readinessCaps`. Persistent per-move state
(progression level, disabled) is keyed by move NAME — renaming a move needs migration care.

## Gotchas

- **Two similarly-named jump moves**: `"Jump tucks"` (main pool, day-B plyo) and
  `"Tuck jumps"` (daily stim module) — plus warm-up `"Tuck jumps (crisp)"`. Check which
  one a bug report means.
- **Seed modules are installed by migration, then never re-synced.** Editing
  warmup/cooldown/daily modules or move metadata in routine-seed.json only affects fresh
  installs; existing installs need a `migrateRoutineVN` stamping the same change (find
  moves by name — see V13/V19 for the pattern).
- The `"Misc"` warm-up shoulder move is intentional (user's own entry) — not a bug.
- `state.readiness` and settings fields are NOT schema-versioned — they're repaired on
  every load by `normalizeReadiness` / `normalizeState`. Only `routine` uses migrations.
- Tag `gym-only` + `settings.tagPriority` (1 = hard-exclude … 5 = ×2.5) is how at-home
  sessions drop equipment moves. Day A/B tags are soft auto tags, never sliders.
- Files are LF; git warns about CRLF on Windows — harmless, ignore.

## Verification

```
node --check app.js                  # syntax (project's own convention)
node <scratchpad>/smoke.js           # require app.js via module.exports, assert engine fns
```
Headless boot check (renders real DOM; init failure shows an error page instead of the app):
```powershell
Start-Process python -ArgumentList '-m','http.server','8123' -WorkingDirectory 'h:\Projects\Workout App' -PassThru -WindowStyle Hidden
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless=new --disable-gpu --virtual-time-budget=8000 --dump-dom http://localhost:8123/index.html
```
Note: collapsed panels (readiness, adjust-session) don't render their bodies until expanded.

## Recent history (details in SPEC.md)

- v4.0–v4.2: generator v2 (loads/families/budgets), readiness check-in, 24h feedback loop.
- v4.3–v4.5: warm-up engine, cool-down engine, daily practice engine (module/mode/role model).
- v4.6: readiness overhaul — levels renamed good/light/skip (session dials, not injuries),
  all five regions 3-level, `arms`→`wrist`, joint-stress tags removed (loads+readiness
  replace them), 24h feedback / regionStatus feature REMOVED (readiness supersedes it),
  daily Tuck jumps given full leg loads so leg readiness gates it.
- v4.7: gym-only slider → hardcoded At gym / At home toggle (`settings.atGym`); readiness +
  adjust panels on the Daily tab (`dailyMovePassesGoals`).
- v4.8: readiness care promotion — `helps` move metadata, light regions guarantee+boost
  their low-load helpers in `selectMoves`, warm-up pins prep modules, two new wrist
  capacity moves (`wrist-forearm` family).
