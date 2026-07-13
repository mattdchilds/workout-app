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
| Skill outcomes (backflip, aerial) compete numerically with capacities (core, shins) | **Real.** `flip` weight 1 vs `core` weight 10 is exactly the math problem described. → Phase 5. |
| Skill practice mixed into conditioning pool | **Mostly avoided today** (no tumbling skills in the move pool) but there is no first-class place to *track* skills, stop-rules, or class work. → Phase 5. |
| Flexibility buried under care goals | **Real.** → Phase 6. |
| Progression only reps→weight; should progress by tolerance | **Partially real** (ladder handles sec/holds and double progression, but nothing gates on how the body responded). → Phase 4/6. |
| 17-item warm-up is long | Deliberate (established PT work). Layered warm-up modules → Phase 6, low priority. |

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

### 2.2 Goals split into capacities / skills / care (Phase 5)

`goal.kind` grows from `"training" | "care"` to
`"capacity" | "skill" | "care"` (`training` migrates to `capacity`).

- **Capacities** keep 0–10 weights and drive `goalScores` scoring:
  trunk control & back tolerance (renamed from "Stronger core"),
  shin & landing capacity, general strength & gymnastics, active
  flexibility (Phase 6), power.
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

## 5. Skills & dashboard (Phase 5) and capacity extras (Phase 6)

- **Skills panel** (Moves tab section or its own card on Gym): the
  skill goals from 2.2 with priority selector, stop-rules, environment
  note ("coach + sprung floor"), and a per-skill log ("attempted at
  class, quality good"). Never enters the generator pool.
- **Dashboard strip** on the Gym tab: capacity weights as they resolve
  today (own + skill-linked), this week's impact tally (sessions +
  `weeklyClasses`), region status lights.
- **Flexibility capacity** (Phase 6): `active-flexibility` capacity,
  `hip-lateral`/split-support moves scored to it; passive-vs-active
  noted per move (`why` copy). Roundoff/flexibility stays recorded as a
  *hypothesis* — a skill note: "ask coach to assess hurdle length,
  shoulder opening, hand placement, turn timing, snap-down."
- **Warm-up modules** (Phase 6): `group`s gain `module: "core" |
  "plantar" | "cubital" | "splits" | ...`; care toggles show/hide
  modules; a "short prep" mode keeps only `core`. Default = everything
  on (the PT work is established and stays).

---

## 6. Phase plan

| Phase | Release | Schema | Contents |
|---|---|---|---|
| **1. Metadata foundation** | v4.0 ✅ | routine v15 | `families` catalog; `family`/`loads`/`fatigue`/`qualitySensitive` on all pool moves (seed + migration V15); validator; Coach move-schema + `add_family` tool; SPEC.md stale-section fixes (jointStress note, v3.9.3–4 gaps, CACHE drift). **No generator behavior change.** |
| **2. Generator v2** | v4.0 ✅ | — | Pipeline of §3 (ships with Phase 1); `settings.weeklyClasses`; budgets/coverage as code constants (moving them into `structure.generator` as data is deferred to Phase 3, when readiness modifiers compose over them); superset compatibility; ordering pass. |
| **3. Readiness** | v4.1 ✅ | — | Check-in panel; readiness → filters/budgets; session intents. Data-driven `structure.generator` budgets considered and **deferred again to Phase 5's schema bump** — no schema change ships in v4.1, so the readiness/intent modifiers compose over the Phase-2 code constants in-code via `min()` (`sessionBudgets(state)`, `readinessCaps(state)`). |
| **4. Feedback loop** | v4.2 ✅ | — | 24 h green/yellow/red prompt; `regionStatus`; dose reduction; progression gating; contact logging. |
| **5. Goals restructure** | v4.3 | v16 | capacity/skill/care kinds; `capacityLinks`; rename core → "Trunk control & back tolerance"; skills panel; Coach tools for skills; dashboard strip. |
| **6. Capacity extras** | v4.4 | v17 | Active-flexibility capacity; warm-up modules; tolerance progression types (ROM/assistance/quality). |

Each phase: gated migration if schema changes, `node --check` +
Node-required smoke tests over the pure exports, SPEC.md version
section, CACHE bump, separate commit.

## 7. What deliberately stays the same

Priorities shift via sliders; moves carry multi-goal scores; care ≠
training; equipment sections; A/B via auto tags; disable/tombstone;
recency from the log; Coach edits staged behind Apply. The one-line
summary of the whole redesign:

> Sliders choose among candidates inside a safe, balanced session
> template; they no longer define the structure of the session.
