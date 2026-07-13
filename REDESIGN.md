# Tumble Trainer v4 — Redesign

Response to the Coach-tab design critique (2026-07). This document is the
plan of record for retooling the generator from a *weighted exercise
lottery* into a *capacity-and-load planner*. It is a long-term, phased
project; each phase ships independently and keeps the app working.

Design constraints preserved from SPEC.md — these are non-negotiable:

- Vanilla JS, single `app.js`, no build step, no dependencies.
- Offline-first PWA; heuristics must work with no API key.
- The generator is **deterministic**: no RNG, no Date in selection. Same
  state → same session (the day-preview simulation depends on this).
  New inputs (readiness, feedback, intent) enter as *state*, never as
  hidden randomness.
- `routine-seed.json` is authoritative; schema changes ship as gated,
  idempotent `migrateRoutineV*` migrations plus a seed version bump.
- Every asset change bumps `CACHE` in sw.js.
- The athlete approves all Coach edits (Apply/Discard); nothing silent.

---

## 1. Criticism triage — what's already fixed vs what's real

The critique was written against a stale view of the app. Reconciled:

| Criticism | Status |
|---|---|
| jointStress array vs joint-stress tags mismatch | **Already fixed in code** (v3.7 tag-priority system replaced the toggles; migration maps legacy state). Only SPEC.md's older sections are stale → docs fix, Phase 1. |
| Superset bias 10 too coarse / needs headroom | **Already fixed** (range 0–30 since v3.7). Compatibility rules still missing → Phase 2. |
| Goal weights create a narrow generator | **Partially mitigated** (SECTION_DECAY 0.85 per-section diminishing returns; +10%/session recency boost) but there is no *pattern-level* diversity: one session can still pick hollow hold + hollow rocks + V-ups + tuck-ups. → Phases 1–2. |
| Redundancy clusters need family caps | **Real.** → Phases 1–2. |
| No load metadata (impact, per-joint, lumbar, fatigue) | **Real.** → Phase 1. |
| Generation is score-only; needs filters → budgets → slots → diversity → ordering | **Real.** → Phase 2. |
| No weekly-gymnastics-class input driving impact allowance | **Real.** → Phase 2. |
| No readiness check-in | **Real.** → Phase 3. |
| No 24-hour green/yellow/red feedback loop | **Real** (athlete-added requirement). → Phase 4. |
| Skill outcomes (backflip, aerial) compete numerically with capacities (core, shins) | **Real.** `flip` weight 1 vs `core` weight 10 is exactly the math problem described. → Phase 7. |
| Skill practice mixed into conditioning pool | **Mostly avoided today** (no tumbling skills in the move pool) but there is no first-class place to *track* skills, stop-rules, or class work. → Phase 7. |
| Flexibility buried under care goals | **Real.** → Phase 8. |
| Progression only reps→weight; should progress by tolerance | **Partially real** (ladder handles sec/holds and double progression, but nothing gates on how the body responded). → Phase 4/8. |
| 17-item warm-up is long | **Promoted** (2026-07, athlete request): static list → session-aware warm-up engine. Pinned care (plantar, nerves) never rotates; the rest gets smarter. → Phase 5, see §6. |
| Cool-down is a static 3-item list | **Promoted** (2026-07, athlete request): same module treatment as the warm-up. The athlete's front-split routine is pinned everywhere; the rest becomes context-aware. → Phase 6, see §7. |
| Daily tab's middle is one hardcoded move | **Promoted** (2026-07, athlete request): the single `DAILY_TUCK_JUMPS` constant → a real module engine (stim / skill / armor), adding daily tibialis armor for the shin volume-limiter and a daily handstand touch. Stays unlogged. → Phase 7, see §8. |

---

## 2. Target data model (final state, reached incrementally)

### 2.1 Moves gain functional metadata (Phase 1)

```jsonc
{
  "name": "Hollow body hold",
  "section": "floor",
  "family": "gymnastics-shape",        // NEW — one per move, from routine.families
  "loads": {                            // NEW — 0..3 each; omit zeros
    "impact": 0, "shin": 0, "knee": 0, "foot": 0,
    "wrist": 0, "elbow": 0, "lumbar": 1
  },
  "fatigue": 3,                         // NEW — 1..5 session-fatigue cost
  "qualitySensitive": true,             // NEW — degrades badly under fatigue
  "tags": [...], "dose": {...}, "goalScores": {...}, "care": [...],
  "muscle": "core", "why": "...", "progression": {...}
}
```

`routine.families[]` is a new catalog: `{ id, name, maxPerSession?, phase }`.
`maxPerSession` defaults to 1. `phase` is the ordering rank (see 3.4).

Family taxonomy (seeded; the Coach can add more via a new tool):

- `landing-impact`, `jump-power` — phase `power`
- `squat-knee`, `single-leg`, `hinge-hamstring`, `horizontal-pull`,
  `vertical-pull`, `push` — phase `strength`
- `gymnastics-shape`, `handstand-support` — phase `skill-strength`
- `trunk-flexion`, `trunk-anti-extension`, `trunk-anti-rotation`,
  `trunk-extension` — phase `trunk`
- `shin-dorsiflexion`, `calf-soleus`, `grip-forearm`, `hip-lateral`,
  `posture-accessory` — phase `accessory`

Why this beats one broad `joint-stress-legs` tag: a tibialis raise, a
split squat, and a lateral bound all load "legs", but with completely
different impact/knee/shin profiles. Tags remain for *user-steerable
preferences* (gym-only, day A/B, joint-stress avoidance); `loads` are
*facts about the move* the generator reasons over.

### 2.2 Goals split into capacities / skills / care (Phase 7)

`goal.kind` grows from `"training" | "care"` to
`"capacity" | "skill" | "care"` (`training` migrates to `capacity`).

- **Capacities** keep 0–10 weights and drive `goalScores` scoring:
  trunk control & back tolerance (renamed from "Stronger core"),
  shin & landing capacity, general strength & gymnastics, active
  flexibility (Phase 8), power.
- **Skills** (back tuck, aerial, RO–BHS–BT) get `priority:
  "off" | "maintain" | "build"` and `capacityLinks: { capacityId: 0..1 }`.
  They never score moves directly. Effective capacity weight =
  own weight + Σ (skill priority factor × link × 10). Turning "aerial"
  to *build* raises single-leg and flexibility work automatically —
  the easy priority-shifting the app was built for, minus the broken math.
- **Care** goals stay as labels/modules, never weighted.

Skills also carry the coach-style tracking fields: `environment`,
`stopRules[]`, `doseNote` — displayed, not generated.

### 2.3 Session-level state (Phases 2–4)

```jsonc
// settings
"weeklyClasses": 0 | 1 | 2,        // gymnastics classes expected this week
// per-session, cleared on finish
"sessionIntent": "default" | "gym-prep" | "recovery" | "low-impact" | "short" | "upper",
"readiness": { "shins": "good|caution|stop", "knee": ..., "foot": ...,
               "back": "good|sensitive", "arms": "good|caution",
               "energy": "low|normal|high", "classSoon": bool },
// persistent region status from the 24h feedback loop
"regionStatus": { "shins": {"light": "green|yellow|red", "sessionsLeft": n}, ... }
```

---

## 3. Generator v2 (Phase 2): filters → budgets → coverage → score → order

Replaces the single greedy score loop in `selectMoves`. Still greedy,
still deterministic, but constrained. Pipeline per selection:

### 3.1 Hard filters (extends existing tag-priority-1 exclusion)
- Existing: `disabled`, tag at effective priority 1, base score ≤ 0.
- New: readiness caps — `caution` on a region caps that load key at 1,
  `stop`/`no-impact` caps it at 0; back `sensitive` caps `lumbar` at 1.
  Any move exceeding a cap is out of the pool *today*.

### 3.2 Load budgets (session totals, checked inside the greedy loop)
A candidate that would bust a budget is skipped this pass.

| Budget | Default | Modifiers |
|---|---|---|
| Σ impact points | 3 | weeklyClasses 2 → 2 · classes 0 → 4 · `classSoon`/gym-prep → 1 · low-impact intent → 0 |
| moves with fatigue ≥ 4 | 2 | recovery intent or low energy → 1 |
| moves with wrist∨elbow ≥ 2 (arm-support) | 2 | arms caution → 1 |
| moves with lumbar ≥ 2 | 2 | back sensitive → 1 |

### 3.3 Coverage template + family caps
- **Family cap (hard):** once `maxPerSession` picks from a family, the
  rest of that family is excluded. Kills hollow-hold+hollow-rocks
  sessions structurally instead of via score tuning.
- **Coverage slots (soft):** a template keyed to `settings.moves`:
  trunk control → trunk anti-rotation/lateral → shin/ankle →
  squat/single-leg → hinge/hamstring → pull → gymnastics-specific →
  free. Each unfilled slot gives matching candidates a ×1.5 boost.
  Slots are *preferences*, not quotas — a slot with no eligible move
  is skipped, and the sliders still decide *which* move fills a slot.
  Below 6 moves only the top slots apply.

### 3.4 Scoring (unchanged core, now scoped)
`Σ(goal.weight × goalScores) × recency × tagMult × sectionDecay ×
supersetBias × coverageBoost`. The sliders keep their meaning; they
choose among valid candidates instead of defining session structure.

### 3.5 Superset compatibility (replaces "bias pairs anything")
A candidate only counts as pairable (for both the bias multiplier and
render grouping) if, versus the would-be partner:
- different `family`, no shared `muscle` (existing rule),
- fatigue sum ≤ 6, not both `qualitySensitive`,
- not both arm-support (wrist∨elbow ≥ 2),
- not both impact ≥ 1.

Known v4.0 behaviors (accepted trade-offs, revisit in later phases):

- **Family caps can undershoot the moves slider.** With every family
  capped at 1, a home session (gym-only excluded) tops out around the
  number of distinct eligible families; the loop ends cleanly rather
  than double-filling a family. The volume-nudge heuristic may suggest
  a `moves` value the pool can't reach.
- **A move whose single load exceeds the session budget is excluded
  outright** — e.g. at 2 weekly classes (impact budget 2) the impact-3
  broad-jump landing never generates. Intended: classes supply that
  impact.
- **Coverage is soft, and extreme goal weights still win.** With
  core 10 / shins 10 / gym 2, pull work rarely beats boosted trunk
  moves. The fix is rebalancing the *weights* (the Coach suggested
  gym ≈ 4), not hardening the slots.

### 3.6 Ordering pass
Within each section block, stable-sort selected moves by family phase:
`power → strength → skill-strength → trunk → accessory`. Power and
quality-sensitive work lands while fresh; low-fatigue accessories close.

---

## 4. Readiness & feedback (Phases 3–4)

### Phase 3 — pre-session check-in
Optional quick panel on the Gym tab (collapsed by default, one tap per
region). Writes `state.readiness`; generator re-runs live. Copy stays
non-diagnostic: the app filters *today's session*, it does not assess
injuries; persistent/worsening/neurological symptoms → clinician.

### Phase 4 — 24-hour traffic-light loop
On the first app open ≥ 12 h after a finished session, a one-tap
prompt: *"How did that session settle?"* — Green / Yellow (+ which
region) / Red (+ region).

- **Green:** dose was tolerable; nothing changes; clears any yellow.
- **Yellow (region):** `regionStatus[region] = yellow, sessionsLeft: 2` —
  the next comparable sessions reduce that region's load budget by one
  step and cut impact-move dose ~20% (round down to a real ladder step).
  Progression pips for implicated moves are suppressed.
- **Red (region):** region load cap → 0 until the athlete clears it in
  Settings; banner suggests qualified assessment for persistent,
  worsening, or neurological symptoms.

Answers are appended to the session's log entry, so the existing
heuristics (skip detection, volume nudge) and future dashboard can read
them. This is a keyless offline heuristic, consistent with app policy.

Progression gating: `progressionReady` additionally requires the last
comparable session's feedback to be green (or unanswered).

Impact accounting: log entries for `landing-impact`/`jump-power` moves
record **contacts** (sets × reps) alongside sets/reps, so weekly impact
can be tallied against classes.

---

## 5. Skills & dashboard (Phase 7) and capacity extras (Phase 8)

- **Skills panel** (Moves tab section or its own card on Gym): the
  skill goals from 2.2 with priority selector, stop-rules, environment
  note ("coach + sprung floor"), and a per-skill log ("attempted at
  class, quality good"). Never enters the generator pool.
- **Dashboard strip** on the Gym tab: capacity weights as they resolve
  today (own + skill-linked), this week's impact tally (sessions +
  `weeklyClasses`), region status lights.
- **Flexibility capacity** (Phase 8): `active-flexibility` capacity,
  `hip-lateral`/split-support moves scored to it; passive-vs-active
  noted per move (`why` copy). Roundoff/flexibility stays recorded as a
  *hypothesis* — a skill note: "ask coach to assess hurdle length,
  shoulder opening, hand placement, turn timing, snap-down."
- **Warm-up engine** — promoted out of this phase to Phase 5; see §6.

---

## 6. Warm-up engine (Phase 5, v4.3, schema v16)

Promoted from the old low-priority "warm-up modules" idea at the
athlete's request (2026-07). The flat 17-item list conflates two jobs:

1. **Tissue care that needs frequency** — plantar work, nerve glides,
   calf eccentrics. Daily medicine that happens to live in the warm-up.
   These are *pinned*: always present, never rotated.
2. **Preparation for what's about to happen** — should follow a
   raise → mobilize → activate → potentiate arc and change with the
   session. Rotates for weekly coverage, gates on readiness.

### 6.1 Schema (v16)

`blocks.warmup` (flat list + `group` strings) is replaced by
`blocks.warmupModules`:

```jsonc
{
  "id": "plantar", "name": "Plantar fasciitis",
  "role": "care",                     // care|raise|mobilize|activate|potentiate
  "contexts": ["gym-impact","gym-lift","daily"],  // eligible where; omit = all
  "pinnedIn": ["gym-impact","gym-lift","daily"],  // always included there; omit = none
  "pick": 2,                          // rotate n of the moves per session; omit = all
  "moves": [ /* validateStatic entries + optional progression, loads */ ]
}
```

Move entries keep the lightweight static shape (`name/dose/goals/why`);
potentiation and ankle moves may additionally carry `loads` (same 0..3
`LOAD_KEYS` as pool moves) — they are real tissue work, not just prep.

Seeded modules (existing moves keep their names/doses so user
progression state migrates by name; ★ = new move):

| Module | Role | Contexts / pinned | Moves |
|---|---|---|---|
| `plantar` | care | pinned everywhere | Arch curls; Calf raise (slow eccentric, keeps its ladder); Standing calf stretch |
| `nerves` | care | pinned everywhere | Ulnar nerve glides |
| `posture` | care | pinned on `daily`; joins the mobilize rotation on gym days | Wall neck stretch; Chin tucks; Wall angels |
| `raise` | raise | gym contexts, pick 1 | ★Jumping jacks; ★Skipping / light bounce (the athlete stims by jumping — use it) |
| `shoulders` | mobilize | rotation | Arm circles; Shoulder lifts; Misc (athlete's own entry — preserved verbatim) |
| `wrists` | mobilize | **pinned on `gym-impact`** (hands take weight when tumbling/handstands) | Wrist stretch; Wrist lifts; ★Tiger claws; ★Weight-bearing wrist rocks |
| `hips` | mobilize | rotation, pick 2 | Knee clocks; ★Leg swings; ★Hip circles |
| `ankles` | mobilize | rotation, pick 2 | Shin raises (back against wall); ★Ankle circles; ★Knee-to-wall rocks |
| `thoracic` | mobilize | rotation, pick 1 | ★Cat-cow; ★Thread the needle |
| `core-activate` | activate | pinned in gym + daily, pick 2 | Curl-ups; Leg lifts; Curl + leg lift combo; ★Bird dog — the lumbar warning sign is exactly what this protects before bridges/BHS |
| `glutes` | activate | `gym-impact` only | ★Glute bridge |
| `potentiate` | potentiate | `gym-impact` only, readiness-gated | ★Ankle pogos (loads shin/impact/foot 1, progression ladder — deliberate shin-tolerance work for roundoffs); ★Tuck jumps (low dose); ★Handstand hold 20 sec |

### 6.2 Selection — `buildWarmup(state, session)`

Pure and deterministic, same contract as the generator. Inputs:

- **Context:** `gym-impact` if the generated middle sections contain any
  move with `loads.impact ≥ 1`, else `gym-lift`; `daily` for the Daily
  tab. (`buildSession` therefore runs `selectMoves` first, then
  `buildWarmup` over the result.)
- **Mode:** `settings.warmupMode` = `short | standard | long`, toggled
  on the warm-up block header (precedent: cooldown short/full).
  - *short* (~5 min): pinned care + raise + core-activate.
  - *standard* (~10 min): + wrists (pinned anyway on impact days) +
    2 rotating mobilize slots (posture joins that pool on gym days) +
    glutes and potentiate on impact days.
  - *long* (gentle): every eligible module, potentiate still gated.
- **Rotation index:** count of finished sessions in the log — advances
  only on `finishSession`, so previews stay stable. Cycles both which
  mobilize modules fill the slots and which moves a `pick: n` module
  shows.
- **Readiness gating:** reuses `readinessCaps`/`passesReadiness` with
  the exact v4.2 semantics: a warm-up move whose `loads` exceed a cap
  is dropped — shins `stop` or a red shins region (cap 0) removes the
  ankle pogos while loadless calf work stays; yellow adds no cap (it
  reduces budgets/dose elsewhere, and pogos are load 1 anyway). A
  module emptied by gating falls out; back `sensitive` drops
  `potentiate` entirely.

Output is a flat exercise list with `group` = module name, so the
existing `warmupGroups` card rendering, `'warmup:'+group` checks, and
per-group logging keep working unchanged.

### 6.3 Feedback & progression

- `finishSession`'s blanket warm-up skip becomes per-move: warm-up
  moves **with `loads`** count toward region recency/status; movement
  without `loads` (chin tucks) still doesn't.
- Warm-up moves with `progression` ladders (eccentric calf raise,
  pogos) progress through the standard gating, and the group card
  finally surfaces their ladder state.

### 6.4 Migration V16

Gated, idempotent `migrateRoutineV16` following the by-name pattern:
map old `group`s → modules; carry the user's persisted doses
(progression state) for same-name moves; user-added entries the map
doesn't recognize are preserved in the module their old group maps to
(never dropped); new seed moves added only if absent by name.
`settings.warmupMode` defaults to `standard`. Old `'warmup:'+group`
check keys are session-ephemeral — no migration needed. Warm-up stays
off-limits to the Coach LLM (selector-managed, not chat-managed).

---

## 7. Cool-down engine (Phase 6, v4.4, schema v17)

Same treatment as the warm-up, smaller, at the athlete's request
(2026-07). The anchor is the athlete's own front-split routine — a
complete, hard-earned flexibility session (front split is a major
goal). It is never rewritten, rotated, or gated: **pinned in every
context**, including `daily`, because split progress is driven by
frequency of exposure. Around it, three jobs in order:

1. **Flexibility development** (`flex`) — first, while tissue is
   warmest. The routine owns the front-split lines (hip flexor,
   hamstring, sciatic floss); the engine adds only the missing angle:
   a rotating adductor/straddle slot (aerial takes off through an open
   straddle) alternating with a knee-friendly figure-4 glute stretch.
   No duplicate hamstring/hip-flexor work — that would dilute the
   routine, not help it.
2. **Tissue care for what the session loaded** (`care`) — impact day
   pins the calf + plantar stretch; lift day pins the doorway pec +
   thoracic stretch; daily gets both.
3. **Down-regulation** (`downshift`) — last. New for an athlete who
   stims by jumping, has a leg-nerve history, and a lower back that
   signals when done: legs-up-the-wall breathing or child's pose
   breathing on gym days. Lumbar decompression + parasympathetic
   downshift, ~2 min.

Deliberately NOT added: more front-split-line stretches, deep kneeling
defaults (wonky right knee — the retired couch stretch stays retired),
anything pushing a standard cool-down past ~10–12 min. Net new moves: 4.

### 7.1 Schema (v17)

`blocks.cooldown` (flat list + `alwaysInShort`) is replaced by
`blocks.cooldownModules` — the same module shape as `warmupModules`
(`{ id, name, role, contexts?, pinnedIn?, pick?, moves[] }`) with
`COOLDOWN_ROLES = ['flex','care','downshift']` and output order
flex → care → downshift.

| Module | Role | Contexts / pinned | Moves |
|---|---|---|---|
| `splits` | flex | **pinned everywhere** (all 3 contexts, every mode incl. short) | Splits routine (incl. sciatic floss) — verbatim, keeps its 5→8 min ladder |
| `hips-extra` | flex | `gym-impact` + `daily`, pick 1 | ★Seated straddle / pancake reach; ★Figure-4 glute stretch |
| `calves-feet` | care | pinned on `gym-impact` + `daily` | Calf + plantar fascia stretch |
| `posture` | care | pinned on `gym-lift` + `daily` | Doorway pec stretch + thoracic extension |
| `downshift` | downshift | gym contexts, pick 1 | ★Legs up the wall + slow breathing; ★Child's pose breathing |

### 7.2 Selection — `buildCooldown(state, context)`

Mirrors `buildWarmup`, reusing the generic v4.3 helpers unchanged
(`warmupModuleEligible`, `warmupModulePinned`, `warmupRotatePick`, the
same rotation index = finished-session count). Context comes from the
same `warmupContext(selected)` result, so warm-up and cool-down always
agree on what kind of day it is; the Daily tab passes `daily` (and
switches from reading `blocks.cooldown` raw to calling the selector).

- **Modes:** `settings.cooldownMode` = `short | standard | long`,
  toggled on the block header exactly like the warm-up. *short* =
  pinned only (preserves today's `alwaysInShort` semantics); *standard*
  = + one rotating non-pinned flex/care slot + downshift on gym days;
  *long* = every eligible module. The `cool` slider (1/2) retires:
  Settings/Adjust lose it, `buildKnobMap`'s `cool` knob goes,
  `settings.cool` maps 1 → `short`, 2 → `standard` in the
  normalizeState backfill.
- **Readiness gating:** `passesReadiness` over any move carrying
  `loads` (the figure-4 alternative exists so nothing kneels on a red
  knee). The splits routine is loadless and pinned — never gated.
- Cool-down stays excluded from `simulatedLogEntry` recency and from
  region status (loadless; rotation is counter-based) — previews stay
  deterministic and unchanged.

### 7.3 Rendering & progression

Cards stay individual `renderCard`s (checks keyed by move name survive
the migration untouched), but the `showProg` exclusion for `'cooldown'`
is removed: the splits card becomes expandable with the standard ladder
controls, finally surfacing the existing 5→8 min progression. This is
the highest-value change for the split goal — post-session, warm, is
when the extra minutes pay off.

### 7.4 Migration V17 & Coach

Gated, idempotent `migrateRoutineV17(routine, seed)`, same by-name
pattern as V16: known names carry the user's persisted dose +
progression onto the seed modules; user-added cool-down moves are never
dropped (`alwaysInShort` ones land in their own pinned care module,
others become eligible-everywhere rotation members). Ladder *levels*
migrate free (`state.intensity` is keyed by move name; names don't
change). `structure.sliders.cool` and the "cool-down stays static"
note are rewritten.

The Coach LLM stays **fully locked out** of the cool-down (athlete
decision, 2026-07): selector-managed, not chat-managed; the splits
routine and pinned care change only on explicit request in a session
like this one.

---

## 8. Daily practice engine (Phase 7, v4.5, schema v18)

Same treatment as the warm-up and cool-down, applied to the Daily tab's
middle block. Until now that block was a single hardcoded app constant
(`DAILY_TUCK_JUMPS`) — not in the seed, not validated, no `loads`, no
progression, invisible to readiness. This phase promotes it to a real
module engine at the athlete's request (2026-07). The Daily tab stays
**unlogged**: no finish path, no `state.log`, no recency/decay
contribution — `loads` on daily moves are readiness-gating **only**
(the same rule as the cool-down).

Three jobs, in display/role order **stim → skill → armor**:

1. **Stim** (`stim`) — the tuck-jump stim the athlete already does daily
   (he stims by jumping). Kept **verbatim** (`"Tuck jumps"`, so the
   existing `state.checks` survives) and **pinned every day**. It gains
   `loads` for the first time so a sore-shins day gates it.
2. **Skill** (`skill`) — a daily touch on his strongest skill: a wall
   handstand hold. Keeps upside-down proprioception ticking between gym
   days and feeds the aerial; `armSupport`-gated (via its `wrist` load)
   so it drops when the arms say stop. Not pinned — it joins in
   standard/long.
3. **Armor** (`armor`) — the single new high-value move: **wall tibialis
   raises**. Nothing in the app trained the tibialis directly, and shins
   are *the* volume limiter for roundoffs and front flips. Pinned every
   day, loadless (it *is* the shin medicine, not a stressor), with a
   5→25 rep ladder.

Deliberately **no rotation** — daily practice thrives on sameness; the
value is in doing the same few things every day. `standard` and `long`
are therefore identical for the daily block (only three modules, no
rotating slot); both modes are kept only so the shared header toggle
cycles uniformly with the other two engines.

### 8.1 Schema (v18)

New `blocks.dailyModules`, the **same module shape** as `warmupModules`/
`cooldownModules` (`{ id, name, role, contexts?, pinnedIn?, pick?,
moves[] }`), validated by the shared `validateModuleList` helper with
`DAILY_ROLES = ['stim','skill','armor']` (also `DAILY_ROLE_ORDER`).

| Module | Role | Contexts / pinned | Moves |
|---|---|---|---|
| `jumps` | stim | `daily`, pinned | Tuck jumps (verbatim; new `loads` impact 1 / shin 1) |
| `handstand` | skill | `daily`, not pinned | ★Wall handstand hold (`loads` wrist 1, 30→60 s ladder) |
| `shin-armor` | armor | `daily`, pinned | ★Wall tibialis raises (loadless, 15→25 rep ladder) |

### 8.2 Selection — `buildDaily(state)`

A simpler cousin of `buildCooldown`, always context `daily`, reusing the
same generic helpers (`warmupModuleEligible`, `warmupModulePinned`,
`warmupRotatePick`, `readinessCaps`/`passesReadiness`). Pure and
deterministic.

- **Modes** (`settings.dailyMode` = `short|standard|long`, default
  standard, toggled on the Daily-tab practice header): `short` = pinned
  only (jump stim + shin armor); `standard`/`long` = every eligible
  module (adds the handstand). Pick-n rotation is supported for
  generality (the seed has no picks), applied before gating.
- **Readiness gating (loads are gating-only)** — `passesReadiness` over
  `readinessCaps(state)`, exactly as the other two engines: shins
  `stop`/red caps `shin ≤ 0` → the tuck-jump stim drops (jumps module
  empties); arms `stop`/red caps `wrist ≤ 0` → the handstand drops.
  Yellow adds no cap. A module emptied by gating falls out. Daily
  `loads` **never** feed `simulatedLogEntry` recency or the
  `finishSession` region-status decay (the Daily tab has no finish
  path).
- **Output** — flat, ordered stim → skill → armor (seed order within a
  role), each move stamped `group` = module name; per-move `renderCard`s
  keyed by move name.

### 8.3 UI, migration & Coach

The Daily tab now surfaces a length toggle on **all three** block
headers — `renderDailyModeToggle` on the practice block, plus the
existing `renderWarmupModeToggle`/`renderCooldownModeToggle` on the daily
warm-up/cool-down headers, which previously inherited the gym settings
with no on-tab control. `showProg` now includes daily cards so the
tibialis and handstand ladders surface behind expand.

Migration `migrateRoutineV18(routine, seed)` is gated (`version < 18`)
and idempotent; there is no legacy block to carry (the old stim was a
hardcoded constant), so it simply installs `blocks.dailyModules` from
the v18 seed. `settings.dailyMode` defaults to `standard`.

The Coach LLM stays **fully locked out** of the daily practice block
(athlete decision, consistent with warm-up/cool-down): selector-managed,
not chat-managed.

---

## 9. Phase plan

| Phase | Release | Schema | Contents |
|---|---|---|---|
| **1. Metadata foundation** | v4.0 ✅ | routine v15 | `families` catalog; `family`/`loads`/`fatigue`/`qualitySensitive` on all pool moves (seed + migration V15); validator; Coach move-schema + `add_family` tool; SPEC.md stale-section fixes (jointStress note, v3.9.3–4 gaps, CACHE drift). **No generator behavior change.** |
| **2. Generator v2** | v4.0 ✅ | — | Pipeline of §3 (ships with Phase 1); `settings.weeklyClasses`; budgets/coverage as code constants (moving them into `structure.generator` as data is deferred to Phase 3, when readiness modifiers compose over them); superset compatibility; ordering pass. |
| **3. Readiness** | v4.1 ✅ | — | Check-in panel; readiness → filters/budgets; session intents. Data-driven `structure.generator` budgets considered and **deferred again to Phase 7's schema bump** — no schema change ships in v4.1, so the readiness/intent modifiers compose over the Phase-2 code constants in-code via `min()` (`sessionBudgets(state)`, `readinessCaps(state)`). |
| **4. Feedback loop** | v4.2 ✅ | — | 24 h green/yellow/red prompt; `regionStatus`; dose reduction; progression gating; contact logging. |
| **5. Warm-up engine** | v4.3 | v16 | `blocks.warmupModules` schema + validator; `buildWarmup` selector (contexts, modes, deterministic rotation, readiness gating); potentiate `loads` feed region recency/status; warm-up-mode toggle; progression surfaced on warm-up cards; migration V16. See §6. |
| **6. Cool-down engine** | v4.4 | v17 | `blocks.cooldownModules` schema + validator; `buildCooldown` selector (shared context/rotation helpers, `cooldownMode` toggle replaces the `cool` slider); splits routine pinned everywhere with its ladder surfaced; migration V17. Coach stays locked out. See §7. |
| **7. Daily practice engine** | v4.5 | v18 | `blocks.dailyModules` schema + validator; `buildDaily` selector (short/standard≡long, no rotation, readiness-gating-only loads); wall tibialis raises + daily handstand added; `dailyMode` toggle plus the warm-up/cool-down toggles surfaced on the Daily tab; migration V18. Daily stays unlogged. Coach locked out. See §8. |
| **8. Goals restructure** | v4.6 | v19 | capacity/skill/care kinds; `capacityLinks`; rename core → "Trunk control & back tolerance"; skills panel; Coach tools for skills; dashboard strip. |
| **9. Capacity extras** | v4.7 | v20 | Active-flexibility capacity; tolerance progression types (ROM/assistance/quality). |

Each phase: gated migration if schema changes, `node --check` +
Node-required smoke tests over the pure exports, SPEC.md version
section, CACHE bump, separate commit.

## 10. What deliberately stays the same

Priorities shift via sliders; moves carry multi-goal scores; care ≠
training; equipment sections; A/B via auto tags; disable/tombstone;
recency from the log; Coach edits staged behind Apply. The one-line
summary of the whole redesign:

> Sliders choose among candidates inside a safe, balanced session
> template; they no longer define the structure of the session.
