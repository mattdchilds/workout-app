# Tumble Trainer v2 — Feature Spec (Claude Code handoff)

## Context
Existing app: single-file PWA (index.html = all logic/styles, sw.js offline cache,
manifest.webmanifest). State in localStorage key "tumbleTrainer.v1":
{session, skill, core, wts, mach, cool, aerial, checks, lastFinished}.
Sessions alternate A/B by parity. Variety slots rotate by session index.
Aerial flag swaps tags/descriptions on dual-purpose exercises and filters
aerial-only items from rotation pools.

Constraints that must survive v2:
- Dependency-free vanilla JS, offline-first, mobile-first
- Bump CACHE name in sw.js on every index.html change
- May split into index.html + app.js + styles.css if single-file gets unwieldy,
  but no build step and no framework

## Build order (each phase ships independently)

### Phase 1 — Structured doses + intensity controls
Convert every exercise dose from string to:
  dose: { sets: 3, amount: 30, unit: "sec" | "reps" | "reps/side" | "min" }
Render as before ("3 × 30 sec"). Add per-exercise +/- steppers (long-press or
expand-on-tap to avoid cluttering cards): adjust sets (±1) and amount
(±5 sec / ±1 rep / ±2 reps for high-rep). Persist per-exercise overrides in
state.intensity = { [exerciseName]: {sets, amount} }. Overrides survive sessions
(that IS the progression). "Reset to default" per exercise.

### Phase 2 — Session logging (the memory)
On "Finish session", append to state.log[]:
  { session, date: ISO, day: "A"|"B", settings: {skill, core, wts, mach, cool, aerial},
    exercises: [{ name, category, dose: {sets, amount, unit}, done: bool }],
    note?: string }
Optional free-text note field on the finish flow ("elbow felt off", etc.).
Add Settings screen with:
- Export state as JSON file download / Import from file (full backup/restore)
- Clear data (with confirm)
Migrate storage key to "tumbleTrainer.v2" with one-time migration from v1.
localStorage is sufficient (~1KB/session); revisit IndexedDB only if notes get long.

### Phase 3 — Routine as data (prerequisite for LLM editing)
Move the entire routine out of code into state.routine (JSON):
  { version: int,
    goals: [{ name: "Backflip power", weight: 100, active: true }, ...],
    categories: { flip: {label, colorId}, ... },  // colorIds from fixed palette
    blocks: {
      skill:   { staples: [exercise...], varietyPool: [exercise...] },
      core:    { staples: [...], varietyPool: [...] },
      weightsA: [exercise...], weightsB: [exercise...],
      machinesA: [...], machinesB: [...],
      cooldown: [...] } }
  exercise = { name, dose, category, why, aerialAlt?: {category, why},
               aerialOnly?: bool, dayLock?: "A"|"B" }
App renders whatever routine JSON says. The seed/default routine is provided
verbatim in routine-seed.json in this repo — load it as the initial
state.routine and do NOT re-derive or "improve" it; every dose, staple
assignment, dayLock, and why-string is intentional. Keep state.routineHistory = last 10 versions with timestamps
and one-tap rollback in settings. Raw-JSON editor in settings as the
no-API-key fallback for manual edits (validate on save).
Write a schema validator (plain JS, no deps) used by BOTH the manual editor
and the LLM flow: required fields, known categories, dose sanity (sets 1-6,
amount > 0), at least one staple per block, no duplicate names within a pool.

### Phase 4 — Habit heuristics (no LLM; deterministic, offline)
Compute from state.log on app open:
1. Volume nudge: if last 3 finished sessions all had 100% completion at current
   slider values → banner: "You've cleared everything 3 sessions running — raise
   weights to 3?" One-tap apply or dismiss (remember dismissals, don't nag).
   Inverse: if completion < 60% for 2 straight sessions → suggest lowering the
   least-completed block.
2. Skip detection: same exercise skipped in 2+ of its last 3 appearances →
   offer swap to another exercise of the same category from the pools.
3. Variety guarantee: variety slots pick the least-recently-COMPLETED eligible
   exercise (from log) instead of pure session-index rotation. Falls back to
   index rotation when log is empty. This guarantees baseline variety even with
   skipped sessions.
4. Progression hint: if an exercise was completed at same intensity 4+ times →
   subtle "ready to add?" marker next to its stepper.
All heuristics are suggestions, never silent changes.

### Phase 5 — Coach (LLM chat + staged routine edits)  [SHIPPED in v3.9]
A single "Coach" tab: a chat that (1) answers training questions and (2) edits the
routine through **function/tool calls**, staged for explicit user approval. This
supersedes the original 2023-era design below (single-shot "return the whole routine
as JSON" over the Anthropic API) — it was never built, then removed in v3.2. The
shipped v3.9 design:

Provider / transport
- OpenAI, model `gpt-5.6-sol` at `reasoning_effort: "medium"`, direct browser `fetch` to
  `https://api.openai.com/v1/responses` (OpenAI allows CORS). NOT chat completions:
  gpt-5.6-sol rejects function tools + reasoning_effort on `/v1/chat/completions`.
  Uses Responses-style tool calling: flat `tools: [{type:"function", name, ...}]`, reads
  `function_call` items from `output[]`, re-sends the model's output items (incl.
  reasoning items — required) plus `function_call_output` items. Does NOT send
  `temperature` (gpt-5.x rejects it); caps output with `max_output_tokens` (shared with
  reasoning tokens, so the cap is generous).
- API key: password field in Settings, stored in its OWN localStorage slot
  (`tumbleTrainer.openaiKey`), NEVER in `state` — so export/import backups never carry
  it. Settings shows a "set / not set" indicator and a Remove button. Never hardcode or
  commit a key.
- Chat history is ephemeral: `ui.coach.messages` (memory only), resets on reload. The
  request replays prior user/assistant text plus a freshly built system prompt (which
  already reflects the current, applied routine), so past tool-call plumbing is not
  re-sent.

System prompt (`coachSystemPrompt`) carries every turn: the full `state.routine` JSON,
current generation settings (training-goal weights, tag priorities, superset bias,
moves/session), a move schema description mirroring `validateRoutine`, and the editable
`state.settings.coachProfile` athlete profile.

Tools exposed (JSON schemas, `COACH_TOOLS`) — operate on `blocks.moves` (NEVER
warmup/cooldown), tags, goals, and settings:
`add_move`, `update_move`, `delete_move`, `set_move_disabled`, `add_tag`,
`set_tag_priority`, `add_goal`, `set_goal_weight`.

Edit flow (the safety mechanism), `coachRun` — an agentic loop (≤ 6 iterations):
1. Send instructions + input + tools. If the reply has `function_call` items, apply each to a **trial** deep
   clone of `{ routine, settings-slice(tagPriority) }`, then run
   `validateRoutine(trialRoutine)` after the batch.
2. Invalid (or a tool errored, e.g. name not found) → roll the trial back, reply to the
   tool calls with the errors, let the model retry ONCE; a second failure surfaces the
   error in chat and changes nothing.
3. Valid → stage `ui.coach.pending = { routine, settingsPatch, deletedNames, summary[] }`,
   reply "staged for user approval", and keep looping so the model writes its closing text.
4. The pending changeset renders as a card (summary lines + Apply / Discard). **Apply**:
   `pushHistory(state.routine)` → swap in the new routine → apply the settings patch →
   tombstone deleted moves + clear their per-move state → `saveState()` → `render()`.
   **Discard** drops it. A new user message also discards a stale pending. NEVER
   auto-applied — the model proposes; the user approves. Each staged batch replaces the
   previous pending.

Guardrails (system prompt): never touch warmup/cooldown (tools can't anyway); be
conservative with pain / rehab / `care` items and defer to a professional on symptoms;
keep move names unique; prefer small targeted edits; when the user is only asking a
question, just answer — don't force an edit.

UI (`renderCoach`): scrollable message list (user right / coach left), markdown-lite
rendering (paragraphs, `**bold**`, `` `code` ``, line breaks — no libs), textarea + Send,
a busy/typing state (`ui.coach.busy`) that disables input, a "New chat" button, inline
error display (401 → point at Settings; network fail → readable message), and — when no
key is set — a setup notice linking to Settings. Settings gains a "Coach" panel (key
field + athlete-profile textarea). The service worker ignores non-GET requests, so the
cross-origin OpenAI POST passes through untouched.

## v2.3 — Goal tags, slots, ladders, set tracking
Shipped on top of Phases 1–5. Storage stays `tumbleTrainer.v2`; a one-time
migration (`normalizeState` / `migrateRoutine`) upgrades old routines in place.
`routine.version` is now 2; `sw.js` CACHE is `tumble-trainer-v2.3.0`.

- **Unified goal tags** replace both `categories` and aerial mode.
  `routine.goals` is now `[{ id, name, weight, active, colorId }]` and every move
  carries `goals: [<goalId>, ...]` (non-empty; first id drives the card
  color/label, all ids render as chips). A move is eligible only if at least one
  of its goal tags is active. `routine.categories`, `ex.category`,
  `ex.aerialOnly`, and `ex.aerialAlt` are gone. Aerial is just a goal (off by
  default); the old "Aerial mode" toggle is replaced by a per-goal checklist in
  Settings. Migration: name-match moves against the seed to adopt goals, else map
  old category (`gen→core, flip→flip, aerial→aerial, str→str, health→recovery`),
  honoring old `aerialOnly`/`aerialAlt`; `settings.aerial→aerial goal active`.

- **Skill/Core slots = TOTAL items** (was a variety add-on). The slider is the
  total count; day/goal-eligible staples fill first, variety picks fill the rest.
  Slider ranges are `[1,5]`; defaults 4/4. Old slider values migrate `+2`
  (clamped 1–5).

- **Real warm-up block** with the Coach's prescribed moves, grouped via an
  optional `group` field (sub-headers render inside the block). The
  slow-eccentric calf raise moved here from machinesA. Warm-up is now ordinary
  editable data (no `userManaged`, no rest timer, no progression UI); the LLM
  only edits it when explicitly asked. New unit `sec/side` (behaves like `sec`).

- **Prebuilt progression ladders** replace free sets/reps steppers. Optional
  `progression: { step, max, maxSets }` per move (defaults computed from the base
  dose). `progressionLadder(ex)` generates the `{sets, amount}` ladder;
  `state.intensity[name]` is now `{ level }` (index into the ladder). The card
  shows ▼ Easier / ▲ Progress / Reset and the ladder position; the Phase-4
  "ready to add?" hint decorates the ▲ button. Old `{sets, amount}` overrides
  migrate to the nearest ladder level.

- **Per-set tracking + rest clock.** Each card renders one tappable circle per
  set (`state.setsDone`); completing the last set auto-checks the move. Tapping a
  set (outside warm-up/cooldown) starts a single global count-up rest clock
  (`state.rest`) toward an optional `rest` (seconds) target — defaults core 60,
  skill/weights/machines 90. A lone 1s ticker updates only the `#rest-timer`
  node; both fields persist across refreshes and clear on finish.

## v2.4 — Weights + splits goal
Shipped on top of v2.3. Storage stays `tumbleTrainer.v2`; a version-gated
migration (`migrateRoutineV3`, run from `normalizeState` on `routine.version < 3`)
upgrades stored routines in place. `routine.version` is now 3; `sw.js` CACHE is
`tumble-trainer-v2.4.0`.

- **Physical weight on doses.** Optional `dose.weight` (lb, > 0) and optional
  `progression.weightStep` (lb, > 0) extend the schema (validator enforces both;
  `weightStep` is ignored when `weight` is absent). `formatDose` appends
  " @ 180 lb" everywhere a dose renders (cards, ladder position, LLM diff). The
  logged/effective dose carries `weight` through.

- **Weight-aware ladders (double progression).** For a move with `dose.weight`,
  `progressionLadder` builds a 2-D ladder flattened to levels: reps climb from
  base `amount` to `max` by `step` at the base set count (maxSets ignored), then
  weight rises by `weightStep` and reps reset — five weight tiers total (base + 4),
  so length = repLevels × 5. Default `weightStep` is 5 (base < 100 lb) else 10.
  Each entry is `{ sets, amount, weight }`. Non-weighted moves keep the old
  sets/reps ladder unchanged. The Phase-4 "ready to add?" hint compares weight
  too, so a weight bump resets the streak. Stored `intensity` levels are clamped
  to the current ladder length in `normalizeState`.

- **Splits goal + Coach edits.** New `splits` goal (colorId `orange`, a new
  palette entry). Tagged onto the splits routine (splits leads) and the Bulgarian
  split squat. New moves: Cossack squat (skill variety), Couch stretch (cooldown),
  Leg extension (machinesA). Real weights + progression seeded on hex-bar
  deadlift, overhead press, leg press, Bulgarian split squat, and both leg curls.

- **v3 migration.** Adopts `dose.weight` + weight-aware progression by name
  (keeping user sets/amount overrides), adds the splits goal + tags, inserts the
  three new moves, and — fixing a v2.3 gap — adopts the real warm-up block when a
  device still shows the old placeholder and drops the slow-eccentric calf raise
  from the machine pools (it lives in the warm-up now). Runs for any
  `routine.version < 3`, including a routine already stamped version 2.

- **v2.4.1 — grouped warm-up cards** (`sw.js` CACHE `tumble-trainer-v2.4.1`). The
  warm-up block's *rendering* collapses to one card per contiguous `group` (title
  = group name, body = a compact "Name — dose[, tempoNote]" line per move, chips =
  union of the moves' goals, one checkbox per group); the data model is untouched
  (moves stay individual and LLM-visible). The session check unit and log entry
  become the group card (`state.checks['warmup:' + group]`; log `{ name: group,
  category: 'warmup', done }`), so the progress denominator counts group cards.
  Warm-up group "Feet" renamed to "Plantar fasciitis" in the seed and, idempotently
  by group value, in `normalizeState` (`renameWarmupGroups`).

## v2.5 — Ranges out, cards decluttered
Shipped on top of v2.4. Storage stays `tumbleTrainer.v2`; a version-gated
migration (`migrateRoutineV4`, run from `normalizeState` on `routine.version < 4`)
upgrades stored routines in place. `routine.version` is now 5 (see the v2.5.1
note under Auto Superset); `sw.js` CACHE is `tumble-trainer-v2.5.2` (see the v2.5.2
note for the superset rounds + per-member progression additions).

- **Dose ranges removed.** The optional `dose.range` band is gone from the schema
  and from every seed move. `formatDose` renders a single amount ("3 × 30 sec"),
  `effectiveDose` no longer passes a range through, and `progressionParams` no
  longer uses `range` as its `max` fallback (moves rely on an explicit
  `progression.max` or the computed default). The three moves that carried a range
  (Handstand wall hold, Hollow body hold, L-sit or tuck sit hold) drop it; the
  L-sit gains an explicit `progression` (`{ step: 5, max: 20, maxSets: 4 }`) so its
  old 20-sec ceiling survives. The `why` field stays in the data model, validator,
  and LLM diff/edit flow.

- **Cue text off the cards.** The Today view no longer renders the grey `why`
  line under each move (display-only removal; the `why` data stays as LLM context).

- **"Couch stretch" retired.** Removed from the cooldown block and from the
  `migrateRoutineV3` seed-insert list.

- **v4 migration.** Over every move in every block, deletes `dose.range` and (for
  the L-sit) adopts the seed's explicit `progression` when the move lacks a `max`;
  removes any cooldown move named "Couch stretch". Idempotent; runs for any
  `routine.version < 4`, including a routine already stamped version 3.

### Auto Superset
Groups same-location skill/core moves into one combined card so they're trained as
alternating rounds. Rendering-only (like the warm-up group card) — the routine data
model still stores every move individually, and session logging is unchanged.

- **New per-move fields.** Every skill and core move (staples + variety pools) gains
  `muscle` (coarse main muscle group) and `location`. As of v2.5.1 every seed
  skill/core move is `"floor"` — the field still supports other values, but the
  wall location was retired so wall moves can superset with floor moves.
  An optional `largeEquipment` string is also recognised (no seed move sets one yet).
  These live only on skill/core moves — warm-up, weights, machines and cool-down
  moves never carry them and never superset.

- **Qualification rules** (all hold within a group): every member shares one
  `location`; no two members share a `muscle`; at most one member has
  `largeEquipment`. Only skill- and core-block moves that carry both `muscle` and
  `location` ever qualify.

- **Grouping (`groupSupersets` / `supersetPlan`).** When `state.autoSuperset` is on,
  the session's skill then core exercises (session order, only those with `muscle` +
  `location`) are greedily bucketed by location: each move joins the first existing
  group it doesn't clash with (same muscle, or a second `largeEquipment`), else
  starts a new group. **No size cap** — giant sets are allowed. A group of size 1
  renders as a normal individual card in its own block.

- **Rendering.** A group of ≥ 2 renders as ONE combined card (mirroring the warm-up
  group card) placed at its earliest member's position, in that member's block;
  later members are dropped from their own blocks' rendering (a block that loses all
  its cards this way renders no section header). The card shows a **Superset** label
  (**Giant set** at ≥ 3 moves), union goal chips, one `name — sets × dose` row per
  member (each keeps its own per-move progression via `effectiveDose`), an
  "Alternate moves, rest after each round" hint, a row of round dots (v2.5.2), and a
  single check-off. Expanding the card (v2.5.2) reveals per-member progression
  controls.

- **Rounds & rest (v2.5.2).** The card shows one round dot per round, where
  `rounds = supersetRounds(card)` = the most sets any member does (`renderRoundDots`,
  reusing the `.set-dot` styles). Tapping the next dot (`roundDone`) bumps the card's
  round counter — stored in `state.setsDone[card.name]`, the same synthetic key the
  checkbox uses — and each member's `setsDone` capped at that member's own sets, then
  restarts the shared rest clock aimed at the card (`target = max` of the members'
  `restTarget`). Tapping the last-filled dot undoes: it decrements the counter and
  every member whose `setsDone` equals the round being undone (exact reverse of the
  cap-aware bump). Completing the final round auto-checks the whole card (as the
  checkbox would; no post-round clock); dropping below unchecks it. The card's rest
  clock hides once all rounds are done (mirrors `renderRestClock`).

- **Check-off & rest.** One check marks every member complete in `state.checks`
  (and syncs `setsDone`), exactly as checking each card individually would, plus a
  synthetic card key so the progress bar counts it as one unit; it also sets/clears
  the round counter (`state.setsDone[card.name]`) so the dots and checkbox never
  disagree. On check-off the single global rest clock starts with `target = max` of
  the members' `restTarget` values. `finishSession` is untouched — it logs each
  member by name from the raw build (synthetic card keys never enter the log).

- **Per-member progression (v2.5.2).** The superset card is expandable (keyed by the
  synthetic `card.name`, like an individual card keys `ui.expanded` by move name).
  When open, each member row gets the same `renderProgression` controls as its
  individual card (▼ Easier / ▲ Progress with ready-pip / Reset + "Step X of Y").
  Members aren't in `renderedExercises` (only the synthetic card is), so member
  buttons carry `data-member`; the shared `prog`/`reset` handlers resolve the member
  via `card.members[i].ex`. Changing a level re-renders that row's dose via `render()`.

- **Toggle.** `state.autoSuperset` (default ON), defaulted in `normalizeState` at
  the state level (not in the routine migration). A switch lives in Settings →
  Session. When off, the Today view renders every move as its own card, as before.

- **Migration & schema.** `migrateRoutineV4` also adopts `muscle` / `location`
  (+ `largeEquipment` if present) onto stored skill/core moves from the seed by
  name (fills missing fields only; idempotent). The validator documents and
  type-checks the three fields; the LLM edit schema lists them and asks the model to
  preserve them; `exerciseEqual` compares them so an edit that changes them surfaces
  as a modification.

- **v2.5.1 — wall merged into floor.** The three wall-tagged moves (Handstand wall
  hold, Wall handstand shoulder taps, Wall-sit hollow press) are now `location:
  "floor"` so they can superset with the other floor moves. A version-gated
  migration (`migrateRoutineV5`, run from `normalizeState` on `routine.version < 5`,
  immediately after the V4 call) rewrites `location: "wall"` → `"floor"` over every
  move in every pool and stamps `routine.version` 5. Idempotent; needed because an
  already-loaded routine is stored at version 4 with `"wall"`, so a seed edit alone
  would not reach it. `sw.js` CACHE bumps to `tumble-trainer-v2.5.1`.

- **v2.5.2 — superset rounds + per-member progression.** The combined superset card
  gains a row of round dots (`renderRoundDots` / `roundDone`, reusing the `.set-dot`
  styles) that track whole-superset rounds and drive the shared rest clock per round,
  and becomes expandable to reveal each member's own progression ladder controls
  (`renderSupersetProgression` reusing `renderProgression` with a `data-member`
  index). No data-model or `finishSession` change. `sw.js` CACHE bumps to
  `tumble-trainer-v2.5.2`.

## v3.0 — goal-weighted generator
Shipped on top of v2.5. Storage stays `tumbleTrainer.v2`; a version-gated
migration (`migrateRoutineV6`, run from `normalizeState` on `routine.version < 6`)
upgrades stored routines in place. `routine.version` is now 6; `sw.js` CACHE is
`tumble-trainer-v3.0.0`.

- **Two kinds of goal.** `routine.goals` entries gain a `kind`. **Training** goals
  (`flip`, `aerial`, `core`, `gym`) carry a 0–10 `weight` (0 = off) set by a slider
  in Settings; the old per-goal checkboxes and the `active` field are gone. **Care**
  goals (`splits`, `plantar`, `cubital`, `posture`, `sciatic`, `recovery`) are always
  on, have no slider, and live in the static warm-up / cool-down. The old `str` goal
  is removed; `gym` (general gymnastics — handstands, bridges, handspring shapes,
  rolls) is added.

- **One unified `moves` block.** `blocks` becomes `{ warmup[], moves[], cooldown[] }`.
  Every former skill/core/weights/machines exercise now lives in `moves`, each with a
  `section` (`"floor"|"weights"|"machines"`), a `goalScores` map (trainingGoalId → 0..10
  as of v3.3; was 0..3, zero entries omitted), and an optional `care` id array (display
  chips). `location` is
  dropped (Floor is implicitly one location); `muscle` stays on Floor moves for Auto
  Superset. Warm-up / cool-down entries keep their `goals` tag array.

- **Goal-weighted selection (`scoreMove` / `selectMoves`).** Pure, deterministic, no
  RNG/Date. Pool = `blocks.moves` minus disabled moves and any move a tag hard-avoids
  (see v3.7 tags — the old hard `dayLock` filter is gone). `baseScore = Σ trainingGoal.weight
  × goalScore`; moves scoring 0 are excluded. Surviving moves keep a per-tag score
  multiplier applied to the recency-boosted score. A recency boost `effective = base ×
  (1 + 0.1 × min(sessionsSince, 6))` (never-completed → 6) favours variety. `settings.moves`
  picks are then taken **greedily with per-section diminishing returns**: each pick maximizes
  `effective × SECTION_DECAY^(already-picked in that move's section)` (`SECTION_DECAY = 0.85`),
  tie-broken by pool order. The decay stops the highest-scoring section (usually Floor) from
  flooding the session so every populated section stays represented. Picks are grouped by
  `section`; page order: **Warm-up, Floor, Weights, Machines, Cool-down** (empty skipped).

- **Settings.** The four block sliders collapse into one **Number of moves** slider
  (`settings.moves`, range `[3,15]`, default 10) beside the cool-down slider and Auto
  Superset toggle (and, as of v3.5, a **Superset bias** slider). Goals panel shows a 0–10
  weight slider per training goal; a static panel lists the six care chips. `restTarget`
  for Floor is 90 s unless the move's top goal is `core` (60 s); weights/machines 90 s.

- **v6 migration.** Generic so user edits survive: rebuilds goals (drops `str`, adds `gym`;
  training weight = its default flip 8 / core 6 / gym 5 unless the old goal was *explicitly*
  inactive — missing `active` counts as on, so a v1-legacy routine never migrates to an
  all-zero empty session; aerial 0), flattens skill/core → Floor, weightsA/B → Weights,
  machinesA/B → Machines (dedupe by name, prefer A). Since v5 alternated whole weight/machine
  blocks (no per-move dayLock), the A/B parity is **synthesized**: an A-only move gets
  `dayLock:"A"`, a B-only move `"B"`, a name in both (Leg curl) none; an existing dayLock
  wins. Old tags → goalScores (`flip→{flip:3}`, `aerial→{aerial:3}`, `core→{core:2}`,
  `str→{flip:2,gym:1}`) or the seed's hand-authored scores by name; care tags → `care`;
  empty → `{gym:1}`. `settings.moves` = clamp(skill+core+wts+mach, 3, 15). Falls back to the
  fresh seed wholesale if it throws.

## v3.1 — day preview
Shipped on top of v3.0. No storage or schema change; `sw.js` CACHE is
`tumble-trainer-v3.1.0`.

- **Peek ahead from Today.** A control row (◀ / label / ▶ + "Back to today") at the top
  of the Today view steps a transient `previewOffset` (module-level, 0–13; **never
  persisted, never migrated**). 0 = today (live, editable); ◀ is disabled at 0 (no past
  preview). A refresh or finishing a session resets the offset to 0 (`finishSession`).

- **Honest rotation (`buildFutureSession(st, offset)`).** Pure, no mutation of real state.
  `offset 0` returns exactly `buildSession(st)`. Otherwise it walks a deep-cloned state
  forward: each step builds the session, appends a *simulated* completed-log entry (same
  shape `finishSession` writes, marking that session's selected moves done — recency only
  reads name + done), and advances the session index, so the recency boost that drives
  `selectMoves` is correct for the target day. Per-session swaps are dropped in the copy
  (`applySwaps` only applies at offset 0). Exported on `module.exports` and
  `window.TumbleTrainer`.

- **Read-only rendering.** In preview the normal block/card rendering is reused with all
  interaction suppressed: no checkboxes, set/round dots, rest timers, expand/progression,
  swap-suggestion chips, or Finish button; the header shows "Preview · Session N · Day X"
  with no progress bar, and `#view` gets an `is-preview` class. Preview doses render at the
  **current** intensity level — the forward simulation does not advance progression ladders,
  so a previewed weighted move shows today's load, not a projected one.

## v3.2 — supersets as half-moves, LLM removed, warm-up + tabs
Storage stays `tumbleTrainer.v2`; `routine.version` is now 7; `sw.js` CACHE is
`tumble-trainer-v3.2.0`. A version-gated `migrateRoutineV7` (run from `normalizeState`
on `routine.version < 7`) upgrades stored routines in place.

- **Supersets count as half a move.** The "number of moves" slider is now a *weighted*
  budget: with Auto Superset on, each Floor move that pairs into a superset (a group of
  ≥ 2, per `groupSupersets`) counts as **0.5** toward `settings.moves`, so a superset pair
  costs one whole move and a supersetting session pulls in more actual moves. `selectMoves`
  keeps picking (same greedy score × section-decay) while `sessionMoveCost(chosen)` (the new
  pure helper, grouping the chosen Floor moves in pool order to mirror rendering) is under the
  slider value. Auto Superset off → cost = move count (unchanged).

- **LLM integration removed.** All of Phase 5 is gone — `callClaude`, the Edit/Ask tabs and
  flows, prompts, diff/validate-retry machinery, the API-key + model Settings panel,
  `state.apiKey` / `state.model`, `ui.llm`, and the LLM CSS. `validateRoutine` and the schema
  stay (used by the raw JSON editor and now the Move viewer).

- **"Shoulders" warm-up group** ("Shoulder lifts", "Misc") added to the seed after the
  "Circles" group; `migrateRoutineV7` inserts it (by name, idempotent) into stored routines.

- **"Today" tab renamed "Gym"; new "Daily" tab** (`renderDaily`) shows just the static
  warm-up and cool-down (reusing the grouped warm-up card + cool-down rendering/check-off,
  sharing `state.checks`) plus a fixed daily **Tuck jumps** stim (`DAILY_TUCK_JUMPS`, not part
  of the generated session) after the warm-up. The tab id stays `today` (only the label
  changed); `state.view` is validated against the known views on load.

## v3.3 — goal-score fidelity 0–10 + Move viewer
Storage stays `tumbleTrainer.v2`; `routine.version` is now 8; `sw.js` CACHE is
`tumble-trainer-v3.3.0`. A version-gated `migrateRoutineV8` (run on `routine.version < 8`)
upgrades stored routines in place.

- **Goal scores rescaled 0–3 → 0–10.** The seed's `goalScores` are re-authored across the
  wider band (best-in-class moves reach 8–10 — e.g. Hollow body hold `core:10`, Handstand wall
  hold `gym:10`, Hex bar deadlift `flip:9`; solid 4–7; supportive 2–3; unrelated omitted) so
  the generator strongly favours moves that match the user's goals. `scoreMove` math is
  unchanged (linear Σ weight × score); only the validator bound (now integer 0–10) moved.
  `migrateRoutineV8` replaces each **seed-known** move's `goalScores` wholesale by name (users
  hadn't hand-edited them); user-added moves keep theirs.

- **Move viewer (new "Moves" tab).** `renderMoves` lists every `blocks.moves` entry grouped by
  section with its dose, muscle, dayLock, 0–10 goal-score chips, care chips, and why, plus an
  **Add a move** form (name, section, day, dose incl. optional weight, muscle, why, and a 0–10
  input per training goal). `addMove` validates the whole routine via `validateRoutine` before
  persisting into `state.routine.blocks.moves`; `deleteMove` confirms, removes the move, and
  **tombstones** its name in `state.deletedMoves`. Added/deleted moves persist and are
  respected by the generator immediately.

- **Deletion tombstones.** `state.deletedMoves` (a name list) is applied in `normalizeState`
  **after** all migrations, filtering `blocks.moves` so a deleted move can never be resurrected
  by a migration or a re-inserted seed move. Re-adding a move with a tombstoned name clears its
  tombstone. User-added moves survive migrations because no post-v6 migration rebuilds the pool.

## v3.4 — enable/disable moves, Gym-tab tuning, joint-friendly mode
Storage stays `tumbleTrainer.v2`; `routine.version` is now 9; `sw.js` CACHE is
`tumble-trainer-v3.4.0`. A version-gated `migrateRoutineV9` (run on `routine.version < 9`)
upgrades stored routines in place.

- **Enable / disable moves in the Moves tab.** Each move row gains an On/Off toggle
  (`mv-toggle` → `toggleMoveDisabled`). Disabling stamps `disabled: true` on the move
  object in `state.routine.blocks.moves` (the flag is **omitted when enabled**); the row
  stays listed but dims (`.mv-row-disabled`) and shows a "disabled" badge. `selectMoves`
  drops `ex.disabled` moves from the pool up front, so a disabled move is completely
  excluded from generation (Gym session and day preview) immediately and across reloads
  (it lives on the routine). The toggle mutates the live move reference (like `deleteMove`)
  and `saveState()`s. The validator accepts an optional boolean `disabled` on a move.
  Post-v6 migrations never rebuild the move pool, so the flag survives updates.

- **Goal + session controls in the Gym tab.** The moves/cool sliders and the training-goal
  weight sliders — plus the joint-friendly toggle — are extracted into shared helpers
  (`renderSettingSlider`, `renderGoalWeightSliders`, `renderJointFriendlyField`,
  `renderAutoSupersetField`) that are the **single source of truth**, composed into both the
  Settings panels and a new collapsible **"Adjust session"** panel (`renderAdjustPanel`) at the
  top of the Gym view. The panel is **default collapsed** (`ui.adjustOpen`, transient
  in-memory; `toggle-adjust` flips it) and hidden in day-preview. The controls carry the same
  `data-action` hooks (`setting` / `goal-weight` / `toggle-joint-friendly`), so the existing
  `onChange` handlers re-render and **live-regenerate the visible session** on release;
  `ui.adjustOpen` keeps the panel open across those re-renders.

- **Joint-friendly mode.** A new boolean session toggle `settings.jointFriendly` (default
  off), rendered next to the sliders in **both** the Gym Adjust panel and Settings. When on,
  `selectMoves` restricts the pool to moves whose `jointFriendly` is **not `false`**. Every
  seed move carries an explicit boolean `jointFriendly`: `false` on the high-impact /
  plyometric / deep-wrist-loading moves (Handstand wall hold, Jump tucks, Bridge push-ups,
  Wall handstand shoulder taps, Broad jump stick landing, Straight jump to fast tuck), `true`
  on the rest (holds, controlled-tempo lifts, machine work, core). The validator accepts an
  optional boolean `jointFriendly` on a move; the Add-a-move form has a joint-friendly
  checkbox (default checked), so user-added moves get an explicit flag. **Default for a
  flag-less move: allowed.** A move with no `jointFriendly` field (e.g. a user move added
  before v3.4) passes the filter — joint-friendly mode never silently hides a move the user
  created; only an explicit `jointFriendly: false` is excluded. The generated session and day
  preview react immediately.

- **v9 migration.** `migrateRoutineV9` stamps `jointFriendly` onto each **seed-known** move by
  name (only when the stored move lacks its own boolean, so a user edit survives); user-added
  moves stay flag-less (and thus allowed). Runs for any `routine.version < 9`, immediately
  after the v8 call; idempotent. `disabled` needs no migration (absent = enabled).

## v3.5 — superset bias
No storage or schema change; `routine.version` stays 9. `sw.js` CACHE is
`tumble-trainer-v3.5.0`. Adds one session knob to `state.settings`.

- **Setting.** `settings.supersetBias`, an **integer 0–10, default 5**. Defaulted in
  `freshState` and normalized in `normalizeState` beside `jointFriendly` (missing / non-number
  → 5, then `clamp(value | 0, 0, 10)`). Not part of the routine — it lives on `state.settings`
  like `moves` / `cool`, and its 0–10 range is hard-coded in the UI (**not** in
  `routine.structure.sliders`).

- **Effect on selection.** In `selectMoves`' greedy loop, when Auto superset is on **and**
  `bias > 0`, each candidate that is a Floor move carrying a `muscle` is tested with the new
  pure `wouldSuperset(chosen, cand)`: it mirrors render-time grouping exactly — the
  already-chosen floor+muscle moves plus the candidate, ordered by pool index, mapped to
  `{ ex, block:'floor' }` and run through `groupSupersets` — and returns true iff the
  candidate lands in a group of **>= 2**. When it would pair, the candidate's score is
  multiplied by **`(1 + 0.1 * bias)`** (bias 10 = 2×, bias 5 = 1.5×). The existing
  strictly-greater / earlier-pool-index tie-break is unchanged, and the O(n²) pair test per
  pick is fine over the small move pool. **`bias 0` (or Auto superset off) reproduces pre-v3.5
  selection byte-for-byte** — the multiplier is never applied, so no score changes.

- **UI.** A **Superset bias** slider (0–10, step 1, shows its value) renders right after the
  Auto superset toggle in the shared session-controls group (`renderSupersetBiasField`),
  wired through the existing `data-action="setting"` / `data-key="supersetBias"` handler, so
  it live-regenerates the session. It appears in **both** the Settings Session panel and the
  Gym **"Adjust session"** panel. The Session panel's help text notes that higher bias makes
  the generator prefer moves that pair into supersets and that it only applies while Auto
  superset is on. The slider always renders (even with Auto superset off).

## v3.6 — collapsible blocks, storage persistence, split joint-friendly
Storage stays `tumbleTrainer.v2`; `routine.version` is now **10**; `sw.js` CACHE is
`tumble-trainer-v3.6.0`. A version-gated `migrateRoutineV10` (run on `routine.version < 10`)
upgrades stored routines in place.

- **Collapsible session blocks.** Each session block (Warm-up / Floor / Weights / Machines /
  Jumps / Cool-down) has a tappable `<h2>` that toggles collapse. State lives in
  `state.collapsed` (`{ [blockKey]: true }`), **not** the DOM, so it survives the app's
  re-render on every check-off; `saveState()` persists it across reloads and `finishSession`
  clears it so a new session starts fully expanded. `renderBlock` wraps both render paths
  (`renderToday`, `renderDaily`); the collapsed header shows a done/total count computed from
  each block's slice of `renderedExercises` (skipped in day-preview). `normalizeState`
  tolerates the field being absent in older saves.

- **Storage persistence.** `init` makes a guarded, fire-and-forget
  `navigator.storage.persist()` call so the browser marks the origin persistent and is less
  likely to evict the localStorage progression data (esp. on Android). No UI; no-op where
  unsupported.

- **Split joint-friendly (was v3.4's single boolean).** The one `settings.jointFriendly`
  toggle becomes **two independent** ones, `settings.jointFriendlyLegs` and
  `settings.jointFriendlyArms` (each default off), rendered in both the Gym Adjust panel and
  Settings (`renderJointFriendlyField`, shared `toggle-joint-friendly` handler keyed by
  `data-region`). Per move, the boolean `jointFriendly` becomes an optional `jointStress`
  **array** of the region(s) a move loads (`'legs'` = knees/ankles, `'arms'` =
  shoulders/elbows/wrists); absent/empty = safe both ways. `selectMoves` drops a move when
  `(jointFriendlyLegs && stresses legs) || (jointFriendlyArms && stresses arms)` via the pure
  `jointStresses(ex, region)` helper. Seed reclassifies its six former high-impact moves:
  Jump tucks / Broad jump stick landing / Straight jump to fast tuck → `["legs"]`; Handstand
  wall hold / Bridge push-ups / Wall handstand shoulder taps → `["arms"]`. The validator
  accepts `jointStress` absent, rejects a non-array or an unknown region. The Add-a-move form
  swaps its single "joint-friendly" checkbox for two "Stresses …" checkboxes (**polarity
  flipped** — checked now means *loads that region*); both unchecked omits the field. The
  Moves-tab warn flag shows the region(s), e.g. "stresses knees/ankles".

- **v10 migration.** `migrateRoutineV10` stamps `jointStress` onto each **seed-known** move by
  name (unless the stored move already has its own array — a user edit survives); a user-added
  move still carrying `jointFriendly:false` and no seed match migrates to `['legs','arms']`
  (conservative — it was excluded before, so it stays excluded under either toggle); every
  move's retired `jointFriendly` boolean is then removed. Settings migrate separately in
  `normalizeState`: old `jointFriendly:true` → both new toggles on, then the old key is
  deleted. Runs for any `routine.version < 10`, right after the v9 call; idempotent.

## v3.7 — generic tags with 1–5 priority (replaces joint-friendly + dayLock)

- **One mechanism, two retired systems.** The two joint-friendly toggles AND the hard
  per-move `dayLock` filter collapse into a single **tag** system. The routine gains a
  top-level `tags` array of `{ id, name, auto? }`; each move carries an optional `tags`
  array of those ids. The seed ships four tags: `joint-stress-legs`, `joint-stress-arms`,
  and the two **auto** day tags `day-a` / `day-b` (`auto: "day"`). Seed `version` → **11**.

- **Priority + multipliers (`tagScoreFactor`, `TAG_PRIORITY_MULT`).** Each tag on a move
  resolves to an effective **1–5 priority**. For non-auto tags that's `settings.tagPriority[id]`
  (default 3). For an auto day tag it's derived from the session's A/B day — **today's day → 4,
  the other day → 2** — a *soft* preference, **not** a hard lock (a B-tagged move can appear on
  an A day if it still scores highest). Priority **1 excludes** the move from the pool;
  otherwise the base score is multiplied per tag: **2 → ×0.6, 3 → ×1, 4 → ×1.5, 5 → ×2.5**
  (one tunable table `TAG_PRIORITY_MULT`, in `app.js`, `tagMultiplier`). With every non-auto
  tag at 3 the product is 1, so selection is byte-identical to pre-v3.7 for non-day-tagged moves.

- **Settings.** `settings.tagPriority` maps each non-auto tag id → integer 1–5 (default 3).
  Auto (day) tags never appear. UI: one slider per non-auto tag (`renderTagPriorityFields`,
  `data-action="tag-priority"`), range 1–5, label shows the level meaning (1 Hard avoid,
  2 Lower priority, 3 No effect, 4 Slight priority, 5 Higher priority), rendered in both the
  Settings **Session** panel and the Gym **Adjust session** panel.

- **Move editor.** The Add-a-move form replaces its Day `<select>` and the two "Stresses …"
  checkboxes with a **tag-chip toggle per routine tag** (including `day-a`/`day-b`) plus a
  **new-tag** field: typing a name adds `{ id: slugify(name) (collision-safe), name }` to
  `routine.tags` and a `tagPriority` entry at 3 (`addTag`, `slugify`, `uniqueTagId`).

- **v11 migration (`migrateRoutineV11`).** Adopts the seed's tag catalog, then rewrites every
  move in the stored routine — seed-known **and** user-created — converting `jointStress ['legs'/'arms']`
  → `joint-stress-legs`/`joint-stress-arms` and `dayLock "A"/"B"` → `day-a`/`day-b`, deleting the
  retired fields. Runs for any `routine.version < 11`, right after v10; idempotent.
  routineHistory snapshots are left untouched (matching every prior migration). Settings migrate
  separately in `normalizeState`: `jointFriendlyLegs/Arms === true` → that region's tag priority 1,
  else 3; every non-auto tag is then filled to 3 and clamped to int 1–5; the retired
  `jointFriendly*` keys are deleted.

- **Superset-bias headroom.** `settings.supersetBias` range widens **0–10 → 0–30** (slider min 0
  step 1; clamp in `normalizeState`). The formula is unchanged (`×(1 + 0.1×bias)`), so 10 feels
  as before and 30 reaches 4×.

- **Validator.** `validateRoutine` validates the top-level `tags` array (each `{ id, name }`
  present, ids unique, `auto` — when present — must be `"day"`) and rejects a move `tags` id
  that isn't in the catalog, exactly as `goalScores` ids are checked.

## v3.8 — coach data update (shins goal, shin moves, gym-only tag)

- **New training goal `shins`** ("Stronger shins", weight 6, colorId **`lime`** — a new palette
  entry; all ten prior colorIds were taken). Goals are data-driven, so it picks up a 0–10 weight
  slider (Settings + Adjust-session) and goal-chip coloring automatically. Seed `version` → **12**.
- **`gym-only` tag** (non-auto) added to the catalog and applied to every weights/machines seed
  move (Hex bar deadlift, Overhead press, Face pulls, Bulgarian split squat, Chest-supported/cable
  row, Leg press, Leg curl, Leg extension, Tibialis raises). Its `tagPriority` default (3) is
  auto-filled by `normalizeState`; set the slider to 1 to hard-exclude gym gear for an at-home
  bodyweight session. Home-eligible floor/bodyweight moves stay untagged.
- **`steps` unit** added to `UNITS` (validator + Add-a-move unit dropdown) for the walking drills.
- **Move changes.** `Arch rocks` (floor, back; core 7 / gym 6 / flip 3) **replaces** the retired
  `Wall-sit hollow press`. `Hollow rocks` → 3×12 with the rep defined as one full back-and-forth,
  plus a progression. Three home shin drills added to the floor section: `Heel walks`,
  `Bent-knee (soleus) calf raises`, `Toe walks` (all serve the shins goal). `Tibialis raises`
  un-day-locked (drops `day-b`), gains `shins: 8` and a progression. Lower-back rescoring:
  `Arch (superman) hold` core 5 → 7; `Hex bar deadlift` core 3 → 4. Warm-up `Shin raises` adds
  the shins goal.
- **v12 migration (`migrateRoutineV12`).** Runs for any `routine.version < 12`, right after v11;
  idempotent. Applies all of the above to stored routines **by name** (v8 precedent): adds the
  shins goal + gym-only tag if absent; replaces Wall-sit hollow press wholesale with Arch rocks
  (skipped if the move was deleted or Arch rocks already exists); lowers Hollow rocks to 12 **only
  if currently >12** and raises core scores **upward only**, so user edits survive; inserts the
  three shin moves via `insertSeedMove` (tombstones re-filtered by `normalizeState`, so a deleted
  move never resurrects and duplicates aren't created).

## v3.9 — Coach (OpenAI chat + tool-call routine edits)
Storage stays `tumbleTrainer.v2`; no `routine.version` bump (no schema/migration change);
`sw.js` CACHE is `tumble-trainer-v3.9.0`. Reinstates Phase 5 (removed in v3.2) with an
entirely new design — see the rewritten Phase 5 section above.

- **New "Coach" tab** (`renderCoach`) between Moves and Settings; `coach` added to the
  `TABS` registry and to the `state.view` whitelist in `normalizeState`. A chat backed by
  OpenAI `gpt-5.6-sol` (medium reasoning effort) via a direct browser call to
  `api.openai.com/v1/responses` (tool calling; no `temperature`; `max_output_tokens`). Chat is **ephemeral** (`ui.coach.messages`,
  memory only). Markdown-lite rendering (`coachMarkdown`): paragraphs, `**bold**`,
  `` `code` ``, `<br>` — everything HTML-escaped first, no external libs.
- **API key in its own slot.** Stored at `tumbleTrainer.openaiKey` (not in `state`), so
  export/import backups never contain it. Settings → Coach has the password field
  (set/not-set indicator + Remove) plus the editable **athlete profile**
  (`state.settings.coachProfile`, seeded in `freshState` and back-filled in
  `normalizeState`).
- **Tool-call routine edits, always staged.** Eight function tools (`COACH_TOOLS`):
  `add_move`, `update_move`, `delete_move`, `set_move_disabled`, `add_tag`,
  `set_tag_priority`, `add_goal`, `set_goal_weight`. `coachRun` is an agentic loop
  (≤ 6 iters): tool calls apply to a trial clone, the batch is checked with the existing
  `validateRoutine`, invalid batches roll back and the model retries once, valid batches
  stage `ui.coach.pending`. The user Applies (`pushHistory` → swap routine → settings
  patch → tombstone deleted moves) or Discards; a new message discards a stale pending.
  Nothing is auto-applied. Goal weights live on `routine.goals[].weight`; tag priorities
  in `state.settings.tagPriority`; both edited on the trial and applied together.
- **Service worker unchanged for correctness:** its fetch handler already returns early on
  non-GET, so the cross-origin OpenAI POST is never intercepted. Only the CACHE name bumped.

## v3.9.1 — Coach moved to the Responses API
`/v1/chat/completions` returns 400 for gpt-5.6-sol when function tools are combined with
`reasoning_effort` ("use /v1/responses or set reasoning_effort to 'none'"). Rather than
dropping reasoning, `coachFetch`/`coachRun` now use `POST /v1/responses`: `instructions` +
`input` items instead of `messages`; flat tool definitions (no nested `function` key);
`function_call` items read from `output[]`; the model's output items (including reasoning
items, which reasoning models require back) are re-sent along with `function_call_output`
items; `max_output_tokens` replaces `max_completion_tokens`; reasoning effort is nested
(`reasoning: {effort}` — top-level `reasoning_effort` is chat-completions-only and 400s
here). Staging/validation flow unchanged. `sw.js` CACHE bumped to `tumble-trainer-v3.9.2`.
Note: no org verification needed — it gates only streaming, which the Coach doesn't use.

## Non-goals
- No accounts, no server, no analytics
- No LLM calls without explicit user action (cost + privacy)
- Heuristics must work fully with no API key set

## Testing checklist per phase
- Fresh install (no v1 data) and v1→v2 migration both load clean
- Airplane mode: everything except LLM features works
- Export → clear data → import restores identical state
- Routine edit: malformed LLM output changes nothing; rollback restores exactly
- sw.js CACHE bumped; old cache evicted on activate
