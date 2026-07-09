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
  dose: { sets: 3, amount: 30, unit: "sec" | "reps" | "reps/side" | "min", range?: 45 }
Render as before ("3 × 30–45 sec"). Add per-exercise +/- steppers (long-press or
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

### Phase 5 — LLM integration (BYO Anthropic API key)
PRIMARY PURPOSE: natural-language routine editing. The user types things like
"I want to add layout as a goal", "swap leg press for something posterior
chain", "I tweaked my shoulder, make A days shoulder-light for a while" —
and the LLM restructures state.routine.

Settings screen: password-type field for API key. Store in localStorage only.
NEVER hardcode a key, never commit one, key never leaves the device except to
api.anthropic.com. Show a note recommending a spend limit in the Anthropic Console.

Direct browser call (CORS-enabled by header):
  fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": state.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [...]
    })
  })
Handle: network fail (offline → queue nothing, just show "needs connection"),
401 (bad key → point to settings), 429/overloaded (retry once, then message).

Feature 5a — Routine editing (the core feature):
"Edit routine" screen: free-text input + send.
Request payload: system prompt (below) + user message containing:
  - the full current state.routine JSON
  - active goals and constraints blurb (2-3x/week, A/B structure, PF /
    cubital tunnel / posture / sciatic care, joint recovery, stims by jumping)
  - compact log summary (last ~10 sessions: completion %, skips, notes)
  - the user's instruction
System prompt requires the model to return ONLY JSON:
  { routine: <complete new routine object, same schema>,
    changes: [ "Added goal: layout (weight 40)",
               "New core staple: straight-body hollow hold 3×20 sec",
               "Replaced X with Y because ..." ],
    warnings: [ "..." ]  // anything the user should double-check
  }
Flow: parse (strip markdown fences) → run the Phase 3 schema validator →
if invalid, one automatic retry with the validator errors appended → if still
invalid, show raw output and change nothing.
If valid: render a DIFF screen — changes[] list plus computed added/removed/
modified exercises (old vs new side by side). Buttons: Apply / Discard.
Apply pushes old routine onto routineHistory, swaps in the new one.
NEVER auto-apply. The model proposes; the user approves.

System prompt guardrails:
  - Preserve the A/B day structure and block shapes unless explicitly asked
  - Never remove health/rehab items (slow calf work, nerve care, row, tibialis)
    unless the user explicitly names them for removal; flag it in warnings if
    they do
  - Respect known issues: no aggressive elbow-lockout pressing volume
    (cubital tunnel), keep impact volume conservative (plantar fasciitis,
    joint recovery), warmup is user-managed — never add warmup items
  - Goal weights: new goals get an explicit weight; rebalance variety pools
    to roughly match active goal weights
  - Anything symptom/pain-related: adjust conservatively and add a warning
    recommending a PT rather than prescribing rehab

Model: start with "claude-haiku-4-5-20251001"; if edits are structurally
sloppy, add a settings toggle for "claude-sonnet-4-6" (routine edits are rare,
so per-edit cost is irrelevant — correctness wins).

Feature 5b — Ask tab (secondary):
Simple chat: question + context (current routine, today's list, recent log
notes, goals) → free-text answer. In-memory history only. Technique/planning
assistant, not medical advice. If the model suggests a routine change here,
offer a button that forwards it to the 5a edit flow rather than applying.

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
