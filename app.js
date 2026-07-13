/* ============================================================================
 * Tumble Trainer v2 — app.js
 * Dependency-free, offline-first PWA logic.
 *
 * Section map:
 *   1. Constants & tiny helpers
 *   2. State: load / migrate / save / normalize
 *   3. Routine schema validator  (validateRoutine — Phase 3, reused by Phase 5)
 *   4. Session selection  (buildSession + helpers — the Phase 4 hook)
 *   5. Doses & intensity overrides  (Phase 1)
 *   6. Rendering  (Today view, Settings view, header, tabs)
 *   7. Event handling & mutations  (checks, steppers, finish, settings, editor)
 *   8. Import / export / clear / history  (Phase 2 & 3)
 *  10. Heuristics  (Phase 4 — volume nudge, skip swap, progression hint;
 *                   variety guarantee is in section 4's selectVariety)
 *   9. Service worker + init
 *
 * Phase 4 implementers: the two clean seams are
 *   - selectVariety()  — swap in "least-recently-completed" logic from state.log
 *   - validateRoutine() — the routine schema validator
 * Both are exposed on window.TumbleTrainer at the bottom of this file.
 * ==========================================================================*/

'use strict';

/* --- 1. Constants & tiny helpers ----------------------------------------- */

const V1_KEY = 'tumbleTrainer.v1';
const V2_KEY = 'tumbleTrainer.v2';
// v3.9 Coach: the OpenAI API key lives in its OWN localStorage slot — NEVER inside
// `state` — so export/import backups never carry the secret off-device.
const OPENAI_KEY = 'tumbleTrainer.openaiKey';
const OPENAI_MODEL = 'gpt-5.6-sol';             // gpt-5.x: no `temperature`; tools+reasoning need /v1/responses
const OPENAI_REASONING_EFFORT = 'medium';
const COACH_MAX_ITERS = 6;                      // agentic loop cap (tool round-trips per send)

// Seeded athlete profile — editable in Settings (state.settings.coachProfile).
const DEFAULT_COACH_PROFILE =
  '34M, child gymnast, getting back into it as an adult.\n\n' +
  'Current moves: Backtuck, Backhandspring, Roundoff, Front handspring, ' +
  'Handstand w/ walk, Bridge, Rolls, Frontflip (off springboard)';

// colorId palette (mirrors styles.css c-* classes) — add_goal picks the first unused one.
const GOAL_COLORS = ['purple', 'teal', 'coral', 'pink', 'gray', 'green', 'amber', 'blue', 'slate', 'orange', 'lime'];

// Amount units the app understands. "sec/side" behaves like "sec".
const UNITS = ['sec', 'sec/side', 'reps', 'reps/side', 'min', 'steps'];

// Fallback slider ranges if the routine omits structure.sliders (v3.0: one
// unified "moves" slider replaces the four per-block sliders).
const DEFAULT_RANGES = { moves: [3, 15], cool: [1, 2] };

// v1 category id -> new goal id(s), for migrating LLM-added / hand-edited moves
// that don't match a seed move by name (Feature A migration, step 2).
const CATEGORY_TO_GOALS = {
  gen: ['core'], flip: ['flip'], aerial: ['aerial'], str: ['str'], health: ['recovery']
};

// Generic tab registry. Later phases just push more entries.
const TABS = [
  { id: 'today', label: 'Gym' },
  { id: 'daily', label: 'Daily' },    // warm-up + cool-down + the daily jumping stim
  { id: 'moves', label: 'Moves' },    // browse / add / delete the moves the generator picks from
  { id: 'coach', label: 'Coach' },    // v3.9: LLM chat that answers questions + stages routine edits
  { id: 'settings', label: 'Settings' }
];

// The "Daily" tab shows the static warm-up and cool-down plus this fixed daily
// plyometric stim (the user stims by jumping). It is NOT part of the generated Gym
// session — it renders only on the Daily tab, right after the warm-up.
const DAILY_TUCK_JUMPS = {
  name: 'Tuck jumps',
  dose: { sets: 3, amount: 10, unit: 'reps' },
  goals: ['flip', 'recovery'],
  why: 'Daily plyometric stim — light, springy jumps through the feet'
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const deepClone = (o) => JSON.parse(JSON.stringify(o));

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* --- 2. State ------------------------------------------------------------- */

// Runtime globals (module-scoped). ui.* is in-memory only (not persisted).
let state = null;
let SEED_ROUTINE = null;
let renderedExercises = [];       // flat list built each render; handlers index into it
let renderedSuggestions = [];     // Phase 4 suggestion banners built each render; handlers index into it
let renderedMoves = [];           // Move-viewer rows built each render; mv handlers index into it
// v3.1 day preview: how many sessions ahead the Today view is peeking. TRANSIENT —
// never persisted, never migrated; reset to 0 on finish. 0 = today (live, editable).
let previewOffset = 0;
const PREVIEW_MAX = 13;            // cap: peek up to ~2 weeks ahead
function inPreview() { return previewOffset > 0; }
const ui = {
  expanded: new Set(),
  finishing: false,
  adjustOpen: false,              // v3.4: Gym-tab "Adjust session" panel open/collapsed (transient)
  readinessOpen: false,           // v4.1: Gym-tab "Readiness check-in" panel open/collapsed (transient)
  feedbackPick: null,             // v4.2: transient 'yellow'|'red' — the 24h prompt's region step
  feedbackFor: null,              // v4.2: session number the pick was made for — a pick never
                                  // carries over to a different entry's prompt (stale-pick guard)
  // v3.9 Coach: ALL transient / in-memory. messages = [{ role:'user'|'assistant', text }]
  // (ephemeral chat — never persisted, resets on reload). pending = a staged changeset
  // awaiting the user's Apply/Discard. busy = a request is in flight. error = last error.
  coach: { messages: [], busy: false, pending: null, error: null }
};

// v3.7: default tag-priority map for a routine — every non-auto tag starts at 3
// ("No effect"). Auto (day) tags are never included. Pure.
function defaultTagPriority(routine) {
  const tp = {};
  ((routine && routine.tags) || []).forEach((t) => { if (t && t.id && !t.auto) tp[t.id] = 3; });
  return tp;
}

// v4.1 (Phase 3): per-session readiness check-in. NOT part of settings or the routine
// (no schema bump) — a transient body-state the generator reads as *state* (deterministic,
// no RNG/Date). Allowed values per region; unknown → the region's default. Pure.
const READINESS_LEVELS = {
  shins: ['good', 'caution', 'stop'],
  knee: ['good', 'caution', 'stop'],
  foot: ['good', 'caution', 'stop'],
  back: ['good', 'sensitive'],
  arms: ['good', 'caution'],
  energy: ['low', 'normal', 'high']
};
// The all-good default readiness object. Used by freshState, normalizeState, the
// clear-on-finish reset, the Reset button, and future-preview neutralization. Pure.
function defaultReadiness() {
  return { shins: 'good', knee: 'good', foot: 'good', back: 'good', arms: 'good', energy: 'normal', classSoon: false };
}
// Repair a stored/loaded readiness object: each region snaps to a known value (else its
// default), classSoon coerces to a strict boolean. Pure — returns a fresh object.
function normalizeReadiness(r) {
  const out = defaultReadiness();
  if (!r || typeof r !== 'object') return out;
  Object.keys(READINESS_LEVELS).forEach((k) => {
    if (READINESS_LEVELS[k].indexOf(r[k]) >= 0) out[k] = r[k];
  });
  out.classSoon = r.classSoon === true;
  return out;
}
// True when a readiness object is indistinguishable from the all-good default. Pure.
function readinessIsDefault(r) {
  const d = defaultReadiness();
  const n = normalizeReadiness(r);
  return Object.keys(d).every((k) => n[k] === d[k]);
}

// v4.2 (Phase 4): the 24-hour green/yellow/red feedback loop. After a session settles the
// athlete answers "how did that settle?"; a yellow/red answer parks a body region in
// `state.regionStatus`, a PERSISTENT map that the deterministic generator reads as *state*
// (never RNG/Date). Green = the absence of an entry. Each region maps to the load keys a
// move can carry; a yellow region eases its work for a couple of sessions, a red region is
// paused until cleared in Settings. See readinessCaps / sessionBudgets / moveImplicated.
const REGION_KEYS = { shins: ['shin'], knee: ['knee'], foot: ['foot'], back: ['lumbar'], arms: ['wrist', 'elbow'] };
const FEEDBACK_DELAY_MS = 12 * 3600 * 1000;   // wait ≥12 h after finish before prompting (UI gate only)
const YELLOW_SESSIONS = 2;                     // sessions a yellow region stays parked (decayed in finishSession)
const DOSE_CUT = 0.8;                          // ~20% dose cut for implicated moves (snapped to a real ladder step)
// Repair a stored/loaded regionStatus map: drop unknown regions and unknown lights; a red
// entry is bare {light:'red'}; a yellow entry carries an integer sessionsLeft clamped 1..2
// (default 2). Non-object → {}. Pure — returns a fresh object.
function normalizeRegionStatus(rs) {
  const out = {};
  if (!rs || typeof rs !== 'object') return out;
  Object.keys(rs).forEach((region) => {
    if (!REGION_KEYS[region]) return;                 // unknown region → drop
    const s = rs[region];
    if (!s || typeof s !== 'object') return;
    if (s.light === 'red') { out[region] = { light: 'red' }; return; }   // red carries no sessionsLeft
    if (s.light !== 'yellow') return;                 // unknown light → drop
    const raw = s.sessionsLeft;
    const n = (typeof raw === 'number' && isFinite(raw)) ? Math.round(raw) : YELLOW_SESSIONS;
    out[region] = { light: 'yellow', sessionsLeft: clamp(n, 1, 2) };
  });
  return out;
}

function freshState(routine) {
  return {
    version: 2,
    session: 1,                   // Session 1 = Day A (A on odd sessions)
    view: 'today',
    // v3.0: ONE "moves" slider = total goal-weighted moves per session; the four
    // per-block sliders (skill/core/wts/mach) collapsed into it. Default 10.
    // v3.7: tagPriority maps each non-auto routine tag id → integer 1–5 (default 3);
    // 1 hard-avoids, 3 is neutral. Auto (day) tags never appear here. See selectMoves.
    // v3.5/v3.7: supersetBias 0–30 nudges the generator toward moves that pair into
    // supersets (default 5; 0 = old behavior). See selectMoves.
    // v4.0: weeklyClasses (0|1|2, default 1) = gymnastics classes expected this week; scales the impact budget.
    settings: { moves: 10, cool: 2, supersetBias: 5, weeklyClasses: 1, tagPriority: defaultTagPriority(routine), coachProfile: DEFAULT_COACH_PROFILE },
    checks: {},                   // { [exerciseName]: true } — cleared on finish
    collapsed: {},                // v3.6: { [blockKey]: true } — collapsed session blocks; cleared on finish
    intensity: {},                // { [exerciseName]: { level } } — ladder index; survives sessions
    setsDone: {},                 // Feature E: { [exerciseName]: int } — per-session, cleared on finish
    rest: { name: null, startedAt: null }, // Feature E: single global rest clock
    routine: routine,
    routineHistory: [],           // [{ timestamp, routine }] most-recent first, max 10
    log: [],                      // Phase 2 session log
    lastFinished: null,
    dismissed: {},                // Phase 4: { [suggestionKey]: sessionIndexWhenDismissed }
    swaps: {},                    // Phase 4: { [exerciseName]: replacementName } — per-session, cleared on finish
    autoSuperset: true,           // v2.5: group same-location skill/core moves into supersets (default ON)
    // v4.1 (Phase 3): per-session readiness + intent (cleared on finish). Not in settings /
    // routine — a transient body-state the generator filters/budgets against. See selectMoves.
    sessionIntent: 'default',     // 'default'|'gym-prep'|'recovery'|'low-impact'|'short'|'upper'
    readiness: defaultReadiness(),
    // v4.2 (Phase 4): persistent region status from the 24h feedback loop. Keys from
    // shins|knee|foot|back|arms → {light:'yellow', sessionsLeft} or {light:'red'}; absence = green.
    regionStatus: {},
    deletedMoves: []              // Move viewer tombstones — deleted moves never return via a seed migration
  };
}

// One-time v1 -> v2 migration: carry session index, slider settings, aerial goal.
function migrateFromV1(v1, routine) {
  const s = freshState(routine);
  if (v1 && typeof v1.session === 'number') s.session = v1.session;
  if (v1 && typeof v1.cool === 'number') s.settings.cool = v1.cool;
  // v3.0: collapse the old per-block counts into ONE "moves" total. v1 skill/core
  // were VARIETY counts, so add 2 apiece (matching the historic +2 TOTAL rule).
  const skill = (v1 && typeof v1.skill === 'number') ? v1.skill + 2 : 4;
  const core = (v1 && typeof v1.core === 'number') ? v1.core + 2 : 4;
  const wts = (v1 && typeof v1.wts === 'number') ? v1.wts : 2;
  const mach = (v1 && typeof v1.mach === 'number') ? v1.mach : 1;
  s.settings.moves = clamp(skill + core + wts + mach, 3, 15);
  if (v1 && v1.aerial === true) {
    const a = (s.routine.goals || []).find((g) => g && g.id === 'aerial');
    if (a) a.weight = 10;                 // v3.0: aerial is a weighted training goal
  }
  return s;
}

// Detect a pre-v2.3 routine (v1 goals/categories/category tags).
function isLegacyRoutine(routine) {
  if (!routine || typeof routine !== 'object') return false;
  if (routine.version == null || routine.version < 2) return true;
  if ('categories' in routine) return true;
  const goals = routine.goals;
  if (Array.isArray(goals) && goals.length && goals[0] && goals[0].id == null) return true; // old goals had no id
  return collectPools(routine).some((pool) => pool.some((ex) => ex && 'category' in ex));
}

// Feature A migration, step 1/2: retag one move by name-match against the new
// seed, else map its old category (+ aerialAlt/aerialOnly) to goal ids.
function migrateMove(ex, seedMap) {
  if (!ex || typeof ex !== 'object') return;
  const seedEx = ex.name && seedMap[ex.name];
  if (seedEx && Array.isArray(seedEx.goals)) {
    ex.goals = seedEx.goals.slice();
    if (seedEx.progression) ex.progression = deepClone(seedEx.progression);
    if (typeof seedEx.rest === 'number') ex.rest = seedEx.rest;
    if (seedEx.group) ex.group = seedEx.group;
  } else if (!Array.isArray(ex.goals)) {
    let goals;
    if (ex.aerialOnly) {
      goals = ['aerial'];
    } else {
      goals = (CATEGORY_TO_GOALS[ex.category] || ['core']).slice();
      if (ex.aerialAlt && ex.aerialAlt.category) {
        (CATEGORY_TO_GOALS[ex.aerialAlt.category] || []).forEach((id) => {
          if (!goals.includes(id)) goals.push(id);
        });
      }
    }
    ex.goals = goals;
  }
  delete ex.category;
  delete ex.aerialOnly;
  delete ex.aerialAlt;
}

// Feature A migration, step 3: rebuild routine.goals from the seed, carrying
// over active flags matched by name plus the old settings.aerial flag.
function buildMigratedGoals(seed, oldGoals, oldSettings) {
  const base = deepClone((seed && seed.goals) || []);
  const oldByName = {};
  (oldGoals || []).forEach((g) => { if (g && g.name) oldByName[g.name] = g; });
  base.forEach((g) => {
    const og = oldByName[g.name];
    if (og && typeof og.active === 'boolean') g.active = og.active;
  });
  if (oldSettings && oldSettings.aerial === true) {
    const a = base.find((g) => g.id === 'aerial');
    if (a) a.active = true;
  }
  return base;
}

/*
 * Feature A migration (pure, exported for the smoke test). Converts a pre-v2.3
 * routine (categories + category/aerialOnly/aerialAlt tags) into the unified
 * goal-tag schema, using `seed` as the source of truth for goals and for
 * retagging known moves by name. Returns a new routine object.
 */
function migrateRoutine(routine, seed, oldSettings) {
  if (!routine || typeof routine !== 'object') return routine;
  if (!isLegacyRoutine(routine)) return routine;
  const r = deepClone(routine);
  const seedMap = {};
  collectPools(seed).forEach((pool) => pool.forEach((ex) => {
    if (ex && ex.name) seedMap[ex.name] = ex;
  }));
  collectPools(r).forEach((pool) => pool.forEach((ex) => migrateMove(ex, seedMap)));
  r.goals = buildMigratedGoals(seed, routine.goals, oldSettings);
  delete r.categories;
  r.version = 2;
  return r;
}

// Insert a named seed move into a pool if it isn't already present by name.
// blockPath is ['machinesA'] for a flat block or ['skill','varietyPool'] for a
// staple/variety sub-pool.
function insertSeedMove(routine, seed, name, blockPath) {
  if (findExerciseByName(routine, name)) return;
  const seedEx = findExerciseByName(seed, name);
  if (!seedEx) return;
  const b = routine.blocks || (routine.blocks = {});
  let target;
  if (blockPath.length === 2) {
    b[blockPath[0]] = b[blockPath[0]] || {};
    target = b[blockPath[0]][blockPath[1]] = b[blockPath[0]][blockPath[1]] || [];
  } else {
    target = b[blockPath[0]] = b[blockPath[0]] || [];
  }
  target.push(deepClone(seedEx));
}

/*
 * v2.3 -> v2.4 migration (Feature: weights + splits goal). Runs on any stored
 * routine whose version is < 3 — including a v2.3 routine already stamped
 * version 2 — because seed edits alone never reach devices that persist their
 * own routine. Pure; returns a new routine object with version 3.
 *
 * Steps: adopt dose.weight + weightStep progression from the seed by name
 * (keeping any user sets/amount override), add the splits goal + its tags,
 * insert the three new seed moves, adopt the real warm-up block if the device
 * still has the old placeholder, and drop the slow-eccentric calf raise from
 * the machine pools (it lives in the warm-up now).
 */
function migrateRoutineV3(routine, seed) {
  if (!routine || typeof routine !== 'object') return routine;
  if (typeof routine.version === 'number' && routine.version >= 3) return routine;
  const r = deepClone(routine);
  const seedMap = {};
  collectPools(seed).forEach((pool) => pool.forEach((ex) => {
    if (ex && ex.name) seedMap[ex.name] = ex;
  }));

  // Moves the seed now loads get the seed's full dose — the v3 seed encodes the
  // user's actual gym numbers, and stored doses on these moves are just stale
  // pre-v3 defaults (in-app progression lives in intensity levels, not here).
  // A dose that already carries a weight was set post-v3; leave it alone.
  collectPools(r).forEach((pool) => pool.forEach((ex) => {
    const seedEx = ex && ex.name && seedMap[ex.name];
    if (!seedEx || !seedEx.dose) return;
    if (typeof seedEx.dose.weight === 'number' && ex.dose && typeof ex.dose.weight !== 'number') {
      ex.dose = deepClone(seedEx.dose);
      if (seedEx.progression) ex.progression = deepClone(seedEx.progression);
    }
  }));

  // Add the splits goal if the device predates it.
  const goals = r.goals || (r.goals = []);
  if (!goals.some((g) => g && g.id === 'splits')) {
    const seedSplits = (seed.goals || []).find((g) => g && g.id === 'splits');
    if (seedSplits) goals.push(deepClone(seedSplits));
  }

  // Retag the two moves the seed now associates with splits (first id drives the
  // card color, so splits leads on the splits routine).
  const tagSplits = (name, first) => {
    const ex = findExerciseByName(r, name);
    if (!ex) return;
    ex.goals = ex.goals || [];
    if (!ex.goals.includes('splits')) { first ? ex.goals.unshift('splits') : ex.goals.push('splits'); }
  };
  tagSplits('Splits routine (incl. sciatic floss)', true);
  tagSplits('Bulgarian split squat', false);

  // Insert the three new seed moves into their pools if absent by name.
  insertSeedMove(r, seed, 'Cossack squat', ['skill', 'varietyPool']);
  insertSeedMove(r, seed, 'Leg extension', ['machinesA']);

  // Adopt the real warm-up block if the device still shows the old placeholder
  // (the pre-v2.3 single-card warmup). A customized new-style warmup (which has
  // the Chin tucks staple) is left untouched.
  const b = r.blocks || (r.blocks = {});
  const warmup = b.warmup;
  const hasNewWarmup = Array.isArray(warmup) && warmup.some((ex) => ex && ex.name === 'Chin tucks');
  if (!hasNewWarmup && (!Array.isArray(warmup) || warmup.length <= 2)) {
    b.warmup = deepClone((seed.blocks && seed.blocks.warmup) || []);
  }

  // The slow-eccentric calf raise moved to the warm-up; drop any stale copy from
  // the machine pools (tolerant of minor naming variants).
  const isSlowCalf = (ex) => {
    const n = (ex && ex.name || '').toLowerCase();
    return n.indexOf('calf raise') !== -1 && n.indexOf('eccentric') !== -1;
  };
  ['machinesA', 'machinesB'].forEach((k) => {
    if (Array.isArray(b[k])) b[k] = b[k].filter((ex) => !isSlowCalf(ex));
  });

  r.version = 3;
  return r;
}

/*
 * v2.4 -> v2.5 migration (dose ranges removed, "Couch stretch" retired). Runs on
 * any stored routine whose version is < 4 — seed edits alone never reach devices
 * that persist their own routine. Pure; returns a new routine object with
 * version 4. Idempotent.
 *
 * Steps: drop the now-gone dose.range band from every move (moves rely on
 * explicit progression.max or the computed default instead); give the L-sit hold
 * an explicit progression preserving its old range ceiling if it lacks one;
 * remove the retired "Couch stretch" from the cooldown block; and adopt the new
 * Auto Superset fields (muscle / location / optional largeEquipment) onto stored
 * skill & core moves from the seed by name.
 */
function migrateRoutineV4(routine, seed) {
  if (!routine || typeof routine !== 'object') return routine;
  if (typeof routine.version === 'number' && routine.version >= 4) return routine;
  const r = deepClone(routine);

  // Strip the retired range band from every move in every block.
  collectPools(r).forEach((pool) => pool.forEach((ex) => {
    if (ex && ex.dose && 'range' in ex.dose) delete ex.dose.range;
  }));

  // The L-sit hold used its range as a progression ceiling; adopt the seed's
  // explicit progression so that ceiling survives (only if it lacks one).
  const lsit = findExerciseByName(r, 'L-sit or tuck sit hold');
  if (lsit && (!lsit.progression || typeof lsit.progression.max !== 'number')) {
    const seedLsit = seed && findExerciseByName(seed, 'L-sit or tuck sit hold');
    if (seedLsit && seedLsit.progression) lsit.progression = deepClone(seedLsit.progression);
  }

  // Remove the retired "Couch stretch" from the cooldown block.
  const b = r.blocks || (r.blocks = {});
  if (Array.isArray(b.cooldown)) {
    b.cooldown = b.cooldown.filter((ex) => !(ex && ex.name === 'Couch stretch'));
  }

  // v2.5 Auto Superset: adopt muscle / location (+ optional largeEquipment) onto
  // stored skill & core moves from the seed by name. Only fills fields the stored
  // move is missing, so a user's own value survives; idempotent.
  if (seed && seed.blocks) {
    const sMap = {};
    ['skill', 'core'].forEach((bk) => {
      const sb = seed.blocks[bk];
      if (!sb) return;
      [].concat(sb.staples || [], sb.varietyPool || []).forEach((ex) => {
        if (ex && ex.name) sMap[ex.name] = ex;
      });
    });
    ['skill', 'core'].forEach((bk) => {
      const rb = b[bk];
      if (!rb) return;
      [].concat(rb.staples || [], rb.varietyPool || []).forEach((ex) => {
        const s = ex && ex.name && sMap[ex.name];
        if (!s) return;
        if (s.muscle && ex.muscle == null) ex.muscle = s.muscle;
        if (s.location && ex.location == null) ex.location = s.location;
        if (s.largeEquipment && ex.largeEquipment == null) ex.largeEquipment = s.largeEquipment;
      });
    });
  }

  r.version = 4;
  return r;
}

/*
 * v2.5.1 Auto Superset: the "wall" location is merged into "floor" so the three
 * wall-tagged skill/core moves (Handstand wall hold, Wall handstand shoulder
 * taps, Wall-sit hollow press) can superset with floor moves. Over every move in
 * every pool, rewrites location "wall" -> "floor". Idempotent; runs for any
 * routine.version < 5, including a routine already stamped version 4 (which is
 * where the loaded app currently sits, with location "wall" in localStorage).
 */
function migrateRoutineV5(routine) {
  if (!routine || typeof routine !== 'object') return routine;
  if (typeof routine.version === 'number' && routine.version >= 5) return routine;
  const r = deepClone(routine);

  collectPools(r).forEach((pool) => pool.forEach((ex) => {
    if (ex && ex.location === 'wall') ex.location = 'floor';
  }));

  r.version = 5;
  return r;
}

/*
 * v2.5 -> v3.0 migration (goal-weighted generator). Runs for any stored routine
 * whose version is < 6. Pure; returns a NEW routine object stamped version 6.
 * Migrates GENERICALLY so user edits survive (the caller falls back to the seed
 * wholesale if this throws — see normalizeState).
 *
 *  - goals: rebuild as four training goals (flip/aerial/core/gym with 0–10
 *    weights) + the six care goals. Old "str" is dropped; "gym" is added.
 *    Training weight = its default (flip 8 / core 6 / gym 5) when the old goal was
 *    active, else 0; aerial stays 0. Care goals keep names/colours.
 *  - blocks: flatten skill/core -> section "floor", weightsA/B -> "weights",
 *    machinesA/B -> "machines" (dedupe by name, prefer the A copy; drop dayLock
 *    when a name appeared in BOTH A and B). Each move's old goal tags become
 *    goalScores (flip->{flip:3}, aerial->{aerial:3}, core->{core:2},
 *    str->{flip:2,gym:1}); care tags (splits/plantar/cubital/posture/sciatic/
 *    recovery) become `care`. A move known to the seed by name adopts the seed's
 *    hand-authored goalScores/care instead (so an untouched routine gets the real
 *    scoring matrix). Empty goalScores -> {gym:1}. `location` is removed.
 *  - structure: one { moves:[3,15], cool:[1,2] } slider set.
 */
const TRAINING_WEIGHT_DEFAULTS = { flip: 8, core: 6, gym: 5, aerial: 0 };
const CARE_GOAL_IDS = ['splits', 'plantar', 'cubital', 'posture', 'sciatic', 'recovery'];
const OLD_TAG_TO_SCORES = {
  flip: { flip: 3 }, aerial: { aerial: 3 }, core: { core: 2 }, str: { flip: 2, gym: 1 }
};

function migrateRoutineV6(routine, seed) {
  if (!routine || typeof routine !== 'object') return routine;
  if (typeof routine.version === 'number' && routine.version >= 6) return routine;
  const src = deepClone(routine);

  // Seed lookup by name for adopting hand-authored scores + the canonical goals.
  const seedByName = {};
  collectPools(seed).forEach((pool) => pool.forEach((ex) => {
    if (ex && ex.name) seedByName[ex.name] = ex;
  }));

  // --- goals -------------------------------------------------------------
  const oldById = {};
  (src.goals || []).forEach((g) => { if (g && g.id) oldById[g.id] = g; });
  const goals = deepClone(seed.goals || []).map((g) => {
    const ng = Object.assign({}, g);
    if (ng.kind === 'training') {
      const def = TRAINING_WEIGHT_DEFAULTS[ng.id] != null ? TRAINING_WEIGHT_DEFAULTS[ng.id] : 0;
      const old = oldById[ng.id];
      // Use the goal's default weight (gym 5, flip 8, core 6, aerial 0) unless the
      // old goal was EXPLICITLY inactive. Missing `active` (e.g. goals injected by
      // the v1-legacy migrateRoutine step, which carry no active flag) counts as
      // on, so a legacy routine never migrates to an all-zero (empty) session.
      ng.weight = (old && old.active === false) ? 0 : def;
    }
    return ng;
  });

  // --- moves -------------------------------------------------------------
  const b = src.blocks || {};
  const flatten = (arr) => Array.isArray(arr) ? arr : [];
  const skillMoves = flatten(b.skill && b.skill.staples).concat(flatten(b.skill && b.skill.varietyPool));
  const coreMoves = flatten(b.core && b.core.staples).concat(flatten(b.core && b.core.varietyPool));
  const floorSrc = skillMoves.concat(coreMoves);

  const convert = (ex, section) => {
    const m = deepClone(ex);
    delete m.location;
    delete m.goals;
    const seedEx = seedByName[m.name];
    if (seedEx && seedEx.goalScores) {
      m.goalScores = deepClone(seedEx.goalScores);
      if (seedEx.care) m.care = deepClone(seedEx.care);
    } else {
      const scores = {};
      const care = [];
      (ex.goals || []).forEach((id) => {
        if (OLD_TAG_TO_SCORES[id]) {
          Object.keys(OLD_TAG_TO_SCORES[id]).forEach((gid) => {
            scores[gid] = Math.max(scores[gid] || 0, OLD_TAG_TO_SCORES[id][gid]);
          });
        } else if (CARE_GOAL_IDS.indexOf(id) !== -1) {
          if (care.indexOf(id) === -1) care.push(id);
        }
      });
      if (!Object.keys(scores).length) scores.gym = 1;
      m.goalScores = scores;
      if (care.length) m.care = care;
    }
    m.section = section;
    return m;
  };

  // Dedupe weights/machines by name across A and B and SYNTHESIZE the A/B parity
  // v5 encoded as whole-block alternation (there were no per-move dayLocks there):
  // a move only in the A block gets dayLock "A", only in B gets "B", and a name in
  // BOTH (e.g. Leg curl) gets none (shown every day). A dayLock already on the move
  // wins as-is. Prefers the A copy of a duplicate.
  const dedupe = (aArr, bArr, section) => {
    const out = [];
    const seen = {};
    const bNames = {};
    flatten(bArr).forEach((ex) => { if (ex && ex.name) bNames[ex.name] = true; });
    const aNames = {};
    flatten(aArr).forEach((ex) => { if (ex && ex.name) aNames[ex.name] = true; });
    const take = (arr, day) => flatten(arr).forEach((ex) => {
      if (!ex || !ex.name || seen[ex.name]) return;
      seen[ex.name] = true;
      const m = convert(ex, section);
      if (m.dayLock == null && !(aNames[ex.name] && bNames[ex.name])) m.dayLock = day;
      out.push(m);
    });
    take(aArr, 'A');
    take(bArr, 'B');
    return out;
  };

  const moves = floorSrc.map((ex) => convert(ex, 'floor'))
    .concat(dedupe(b.weightsA, b.weightsB, 'weights'))
    .concat(dedupe(b.machinesA, b.machinesB, 'machines'));

  const blocks = {
    warmup: flatten(b.warmup),
    moves: moves,
    cooldown: flatten(b.cooldown)
  };

  const structure = Object.assign({}, src.structure);
  structure.sliders = { moves: [3, 15], cool: [1, 2] };
  if (seed.structure) {
    if (seed.structure.selection) structure.selection = seed.structure.selection;
    if (seed.structure.notes) structure.notes = deepClone(seed.structure.notes);
  }
  delete structure.varietySlotIndex;

  return { version: 6, goals: goals, blocks: blocks, structure: structure };
}

/*
 * v3.1 -> v3.2 migration: add the "Shoulders" warm-up group (Shoulder lifts +
 * Misc). Runs for any stored routine whose version is < 7 — seed edits alone never
 * reach devices that persist their own routine. Pure; returns a new routine object
 * stamped version 7. Idempotent (adds only the shoulder moves it is missing by
 * name), and places them after the existing "Circles" group to match the seed.
 */
function migrateRoutineV7(routine, seed) {
  if (!routine || typeof routine !== 'object') return routine;
  if (typeof routine.version === 'number' && routine.version >= 7) return routine;
  const r = deepClone(routine);
  const b = r.blocks || (r.blocks = {});
  const wu = Array.isArray(b.warmup) ? b.warmup : (b.warmup = []);
  const seedWU = (seed && seed.blocks && seed.blocks.warmup) || [];
  const shoulders = seedWU.filter((ex) => ex && ex.group === 'Shoulders');
  const have = {};
  wu.forEach((ex) => { if (ex && ex.name) have[ex.name] = true; });
  const toAdd = shoulders.filter((ex) => !have[ex.name]).map((ex) => deepClone(ex));
  if (toAdd.length) {
    let at = -1;
    wu.forEach((ex, i) => { if (ex && ex.group === 'Circles') at = i; });
    if (at === -1) wu.push.apply(wu, toAdd);
    else wu.splice.apply(wu, [at + 1, 0].concat(toAdd));
  }
  r.version = 7;
  return r;
}

/*
 * v3.2 -> v3.3 migration: rescale goal scores from the old 0–3 band to the new
 * 0–10 band. Users have not hand-edited scores, so every seed-known move adopts the
 * seed's new goalScores wholesale by name; user-added moves (absent from the seed)
 * keep their own scores. Runs for any stored routine whose version is < 8. Pure;
 * returns a new routine stamped version 8. Idempotent.
 */
function migrateRoutineV8(routine, seed) {
  if (!routine || typeof routine !== 'object') return routine;
  if (typeof routine.version === 'number' && routine.version >= 8) return routine;
  const r = deepClone(routine);
  const seedByName = {};
  ((seed && seed.blocks && seed.blocks.moves) || []).forEach((ex) => {
    if (ex && ex.name) seedByName[ex.name] = ex;
  });
  const moves = (r.blocks && r.blocks.moves) || [];
  moves.forEach((m) => {
    const s = m && m.name && seedByName[m.name];
    if (s && s.goalScores) m.goalScores = deepClone(s.goalScores);
  });
  r.version = 8;
  return r;
}

/*
 * v3.3 -> v3.4 migration: stamp the per-move `jointFriendly` boolean (added to the
 * schema in v3.4) onto stored routines. Every seed-known move adopts the seed's
 * hand-authored flag by name (only when the stored move lacks its own boolean, so a
 * user edit survives). User-added moves (absent from the seed) get NO flag — and a
 * move with no flag is ALLOWED by joint-friendly mode, so the feature never silently
 * hides a move the user created themselves; only an explicit jointFriendly:false is
 * filtered out. Runs for any stored routine whose version is < 9. Pure; returns a new
 * routine stamped version 9. Idempotent.
 */
function migrateRoutineV9(routine, seed) {
  if (!routine || typeof routine !== 'object') return routine;
  if (typeof routine.version === 'number' && routine.version >= 9) return routine;
  const r = deepClone(routine);
  const seedByName = {};
  ((seed && seed.blocks && seed.blocks.moves) || []).forEach((ex) => {
    if (ex && ex.name) seedByName[ex.name] = ex;
  });
  const moves = (r.blocks && r.blocks.moves) || [];
  moves.forEach((m) => {
    const s = m && m.name && seedByName[m.name];
    if (s && typeof s.jointFriendly === 'boolean' && typeof m.jointFriendly !== 'boolean') {
      m.jointFriendly = s.jointFriendly;
    }
  });
  r.version = 9;
  return r;
}

/*
 * v3.4 -> v3.6 migration: split the per-move `jointFriendly` boolean into a
 * `jointStress` array (subset of ['legs','arms'] — legs = knees/ankles, arms =
 * shoulders/elbows/wrists; absent/empty = safe both ways). Seed-known moves adopt the
 * seed's hand-authored jointStress by name (unless the stored move already carries its
 * own — a user edit survives). A user-created move that was explicitly excluded before
 * (jointFriendly:false) but gets no seed jointStress migrates to ['legs','arms'] —
 * conservative: it was hidden under the old single toggle, so it stays hidden under
 * either new toggle. Moves with jointFriendly:true or no flag get no jointStress (safe).
 * The retired `jointFriendly` boolean is then removed from every move. Runs for any
 * stored routine whose version is < 10. Pure; returns a new routine stamped version 10.
 * Idempotent (once jointFriendly is gone there is nothing left to convert).
 */
function migrateRoutineV10(routine, seed) {
  if (!routine || typeof routine !== 'object') return routine;
  if (typeof routine.version === 'number' && routine.version >= 10) return routine;
  const r = deepClone(routine);
  const seedByName = {};
  ((seed && seed.blocks && seed.blocks.moves) || []).forEach((ex) => {
    if (ex && ex.name) seedByName[ex.name] = ex;
  });
  const moves = (r.blocks && r.blocks.moves) || [];
  moves.forEach((m) => {
    if (!m) return;
    const s = m.name && seedByName[m.name];
    if (s && Array.isArray(s.jointStress) && !Array.isArray(m.jointStress)) {
      m.jointStress = s.jointStress.slice();
    }
    if (!Array.isArray(m.jointStress) && m.jointFriendly === false) {
      m.jointStress = ['legs', 'arms'];   // was excluded before → stays excluded
    }
    delete m.jointFriendly;               // the per-move boolean is retired in v3.6
  });
  r.version = 10;
  return r;
}

/*
 * v3.6 -> v3.7 migration: convert the per-move `jointStress` array and `dayLock`
 * string into the generic `tags` system. The routine adopts the seed's tag catalog
 * (joint-stress-legs / joint-stress-arms / day-a / day-b, plus any the seed adds), and
 * every move in the stored routine — seed-known OR user-created — has its jointStress /
 * dayLock rewritten to the matching tag ids, after which the retired fields are removed:
 *   jointStress ['legs']  -> tag "joint-stress-legs"
 *   jointStress ['arms']  -> tag "joint-stress-arms"
 *   dayLock "A" / "B"     -> tag "day-a" / "day-b"
 * Runs for any stored routine whose version is < 11. Pure; returns a new routine stamped
 * version 11. Idempotent (once jointStress/dayLock are gone there is nothing to convert;
 * an existing tag id is never duplicated).
 *
 * NOTE the seed's routine version is 11 even though the previous migration already
 * stamped 10 — version 10 was taken by the jointStress split, so the tag conversion is
 * the next link (11). routineHistory snapshots are left untouched, matching every prior
 * migration (normalizeState never rewrites history snapshots).
 */
function migrateRoutineV11(routine, seed) {
  if (!routine || typeof routine !== 'object') return routine;
  if (typeof routine.version === 'number' && routine.version >= 11) return routine;
  const r = deepClone(routine);
  // Adopt the seed's tag catalog. Pre-v11 routines carry no tags; union defensively so a
  // routine that somehow already has tags keeps them (seed tags fill in what's missing).
  const seedTags = deepClone((seed && seed.tags) || []);
  const have = {};
  const tags = Array.isArray(r.tags) ? r.tags.slice() : [];
  tags.forEach((t) => { if (t && t.id) have[t.id] = true; });
  seedTags.forEach((t) => { if (t && t.id && !have[t.id]) { tags.push(t); have[t.id] = true; } });
  r.tags = tags;
  const moves = (r.blocks && r.blocks.moves) || [];
  moves.forEach((m) => {
    if (!m) return;
    const mtags = Array.isArray(m.tags) ? m.tags.slice() : [];
    const add = (id) => { if (mtags.indexOf(id) === -1) mtags.push(id); };
    if (Array.isArray(m.jointStress)) {
      if (m.jointStress.indexOf('legs') !== -1) add('joint-stress-legs');
      if (m.jointStress.indexOf('arms') !== -1) add('joint-stress-arms');
    }
    if (m.dayLock === 'A') add('day-a');
    else if (m.dayLock === 'B') add('day-b');
    if (mtags.length) m.tags = mtags;
    delete m.jointStress;
    delete m.dayLock;
  });
  r.version = 11;
  return r;
}

/*
 * v3.7 -> v3.8 migration (coach data update). Runs for any stored routine whose
 * version is < 12. Pure; returns a new routine stamped version 12. Idempotent.
 * Applies the coach-approved edits to existing installs by NAME (matching the v8
 * precedent), so seed-known moves adopt the change while user-added moves are left
 * alone, and user-raised scores/lowered doses are never clobbered:
 *   - adds the "shins" training goal (copied from the seed) if absent;
 *   - adds the "gym-only" tag to the catalog and to every seed weights/machines move
 *     by name (settings.tagPriority for it is auto-filled to 3 by normalizeState);
 *   - replaces "Wall-sit hollow press" wholesale with the seed "Arch rocks" (skipped
 *     if the move was deleted — then it's simply absent — or if "Arch rocks" exists);
 *   - Hollow rocks: dose.amount -> 12 only if currently > 12, add progression, new why;
 *   - Arch (superman) hold core -> 7 and Hex bar deadlift core -> 4 (upward only);
 *   - Tibialis raises: drop the day-b tag, add shins:8, add progression;
 *   - inserts the three home-friendly shin moves (tombstones filtered by normalizeState);
 *   - warm-up "Shin raises (back against wall)": add the shins goal if absent.
 */
function migrateRoutineV12(routine, seed) {
  if (!routine || typeof routine !== 'object') return routine;
  if (typeof routine.version === 'number' && routine.version >= 12) return routine;
  const r = deepClone(routine);

  // 1. Add the shins training goal (copy from seed) if the install predates it.
  const goals = r.goals || (r.goals = []);
  if (!goals.some((g) => g && g.id === 'shins')) {
    const seedShins = ((seed && seed.goals) || []).find((g) => g && g.id === 'shins');
    if (seedShins) goals.push(deepClone(seedShins));
  }

  // 2. Add the gym-only tag to the catalog if missing (normalizeState fills its
  //    tagPriority default of 3 — no settings work needed here).
  const tags = Array.isArray(r.tags) ? r.tags : (r.tags = []);
  if (!tags.some((t) => t && t.id === 'gym-only')) {
    const seedTag = ((seed && seed.tags) || []).find((t) => t && t.id === 'gym-only');
    tags.push(seedTag ? deepClone(seedTag) : { id: 'gym-only', name: 'Gym only' });
  }

  const moves = (r.blocks && r.blocks.moves) || [];
  const findMove = (name) => moves.find((m) => m && m.name === name) || null;

  // 3. Replace Wall-sit hollow press -> Arch rocks, wholesale, in place. If the move
  //    was deleted it isn't here (so Arch rocks isn't added); if Arch rocks already
  //    exists, skip to avoid a duplicate name.
  if (!findMove('Arch rocks')) {
    const idx = moves.findIndex((m) => m && m.name === 'Wall-sit hollow press');
    if (idx !== -1) {
      const seedArch = ((seed && seed.blocks && seed.blocks.moves) || [])
        .find((m) => m && m.name === 'Arch rocks');
      if (seedArch) moves[idx] = deepClone(seedArch);
    }
  }

  // 4. Hollow rocks: lower dose to 12 only if the user hasn't already gone lower,
  //    add the progression if absent, refresh the why.
  const hollow = findMove('Hollow rocks');
  if (hollow) {
    if (hollow.dose && typeof hollow.dose.amount === 'number' && hollow.dose.amount > 12) {
      hollow.dose.amount = 12;
    }
    if (!hollow.progression) hollow.progression = { step: 1, max: 15, maxSets: 3 };
    hollow.why = 'Staple A — hollow under momentum (1 rep = one full back-and-forth)';
  }

  // 5. Lower-back rescoring — bump upward only (never lower a user-raised score).
  const bumpCore = (name, to) => {
    const ex = findMove(name);
    if (!ex) return;
    ex.goalScores = ex.goalScores || {};
    if (typeof ex.goalScores.core !== 'number' || ex.goalScores.core < to) ex.goalScores.core = to;
  };
  bumpCore('Arch (superman) hold', 7);
  bumpCore('Hex bar deadlift', 4);

  // 6. Tibialis raises: drop the day-b tag, add the shins score, add the progression.
  const tib = findMove('Tibialis raises');
  if (tib) {
    if (Array.isArray(tib.tags)) {
      tib.tags = tib.tags.filter((t) => t !== 'day-b');
      if (!tib.tags.length) delete tib.tags;
    }
    tib.goalScores = tib.goalScores || {};
    if (typeof tib.goalScores.shins !== 'number') tib.goalScores.shins = 8;
    if (!tib.progression) tib.progression = { step: 1, max: 20, maxSets: 3 };
  }

  // 7. Tag every seed weights/machines move (by name) gym-only. User-created moves in
  //    those sections are the user's call and are left untouched.
  ['Hex bar deadlift', 'Overhead press', 'Face pulls or band pull-aparts',
    'Bulgarian split squat', 'Chest-supported or cable row', 'Leg press (light-moderate)',
    'Leg curl', 'Leg extension', 'Tibialis raises'].forEach((name) => {
    const ex = findMove(name);
    if (!ex) return;
    const t = Array.isArray(ex.tags) ? ex.tags : (ex.tags = []);
    if (t.indexOf('gym-only') === -1) t.push('gym-only');
  });

  // 8. Insert the three home-friendly shin moves. insertSeedMove skips a name that is
  //    already present; a name the user has tombstoned is re-filtered by normalizeState
  //    after all migrations, so a deleted move never resurrects.
  insertSeedMove(r, seed, 'Heel walks', ['moves']);
  insertSeedMove(r, seed, 'Bent-knee (soleus) calf raises', ['moves']);
  insertSeedMove(r, seed, 'Toe walks', ['moves']);

  // 9. Warm-up Shin raises: add the shins goal if absent (keep plantar/recovery).
  const wu = (r.blocks && r.blocks.warmup) || [];
  const shinRaises = wu.find((ex) => ex && ex.name === 'Shin raises (back against wall)');
  if (shinRaises) {
    shinRaises.goals = shinRaises.goals || [];
    if (shinRaises.goals.indexOf('shins') === -1) shinRaises.goals.unshift('shins');
  }

  r.version = 12;
  return r;
}

/*
 * v3.8 -> v3.8.1 migration (moveset audit). Runs for any stored routine whose
 * version is < 13. Pure; returns a new routine stamped version 13. Idempotent.
 * The audit found two moves that load the arms heavily but were missing the
 * joint-stress-arms tag (their bodyweight peers — handstands, bridge push-ups —
 * already carry it): Overhead press (shoulder/elbow pressing) and L-sit or tuck
 * sit hold (full bodyweight through the wrists on floor). Stamped by NAME on
 * seed-known moves only, matching the v12 precedent; user-added moves untouched.
 */
function migrateRoutineV13(routine) {
  if (!routine || typeof routine !== 'object') return routine;
  if (typeof routine.version === 'number' && routine.version >= 13) return routine;
  const r = deepClone(routine);
  const moves = (r.blocks && r.blocks.moves) || [];
  ['Overhead press', 'L-sit or tuck sit hold'].forEach((name) => {
    const ex = moves.find((m) => m && m.name === name);
    if (!ex) return;
    const t = Array.isArray(ex.tags) ? ex.tags : (ex.tags = []);
    if (t.indexOf('joint-stress-arms') === -1) t.unshift('joint-stress-arms');
  });
  r.version = 13;
  return r;
}

/*
 * v3.8.1 -> v3.9.1 migration (audit gap-fill). Runs for any stored routine whose
 * version is < 14. Pure; returns a new routine stamped version 14. Idempotent.
 * Inserts the seven researched moves that fill the audit's coverage gaps — home
 * pulling (posture), anti-rotation core, adductor strength, home hamstring/quad
 * eccentrics, lateral-plane plyo, one-leg hinge. insertSeedMove skips names
 * already present, and tombstoned (user-deleted) names are re-filtered by
 * normalizeState after all migrations, so nothing resurrects or duplicates.
 */
function migrateRoutineV14(routine, seed) {
  if (!routine || typeof routine !== 'object') return routine;
  if (typeof routine.version === 'number' && routine.version >= 14) return routine;
  const r = deepClone(routine);
  ['Prone Y-T-W raises', 'Copenhagen plank', 'Nordic hamstring curl',
    'Reverse Nordic curl', 'Lateral bound (stick landing)', 'Single-leg RDL',
    'Pallof press'].forEach((name) => insertSeedMove(r, seed, name, ['moves']));
  r.version = 14;
  return r;
}

/*
 * v3.9.5 -> v4.0 migration (Phase 1 — move metadata foundation). Runs for any stored
 * routine whose version is < 15. Pure; returns a new routine stamped version 15.
 * Idempotent. (a) copies the seed's `families` catalog onto the stored routine;
 * (b) for each stored move whose name matches a seed move, copies the functional
 * metadata (family/loads/fatigue/qualitySensitive) from the seed — but never
 * overwrites a field the stored move somehow already carries (a user/coach edit
 * survives); (c) stamps version 15. No generator behavior change — the fields are
 * data the Phase 2 pipeline will reason over. Uses the seed the same way V14 does.
 */
function migrateRoutineV15(routine, seed) {
  if (!routine || typeof routine !== 'object') return routine;
  if (typeof routine.version === 'number' && routine.version >= 15) return routine;
  const r = deepClone(routine);
  if (seed && Array.isArray(seed.families)) r.families = deepClone(seed.families);
  const moves = (r.blocks && r.blocks.moves) || [];
  moves.forEach((ex) => {
    const seedEx = ex && ex.name && findExerciseByName(seed, ex.name);
    if (!seedEx) return;
    ['family', 'loads', 'fatigue', 'qualitySensitive'].forEach((k) => {
      if (k in seedEx && !(k in ex)) ex[k] = deepClone(seedEx[k]);
    });
  });
  r.version = 15;
  return r;
}

/*
 * v2.4.1 warm-up group rename. Applied UNCONDITIONALLY and idempotently in
 * normalizeState — gated on the group VALUE, not routine.version, because some
 * devices were already stamped version 3 before this rename existed. Mutates the
 * routine in place. "Feet" -> "Plantar fasciitis".
 */
function renameWarmupGroups(routine) {
  const wu = routine && routine.blocks && routine.blocks.warmup;
  if (!Array.isArray(wu)) return;
  wu.forEach((ex) => { if (ex && ex.group === 'Feet') ex.group = 'Plantar fasciitis'; });
}

// Feature D migration: old { sets, amount } overrides -> ladder { level }.
function migrateIntensity(oldIntensity, routine) {
  const out = {};
  Object.keys(oldIntensity || {}).forEach((name) => {
    const ov = oldIntensity[name];
    if (!ov) return;
    if (typeof ov.level === 'number') { out[name] = { level: ov.level }; return; }
    const ex = findExerciseByName(routine, name);
    if (!ex || typeof ov.sets !== 'number' || typeof ov.amount !== 'number') return;
    const ladder = progressionLadder(ex);
    let best = 0, bestDist = Infinity;
    ladder.forEach((entry, i) => {
      const dist = Math.abs(entry.sets - ov.sets) * 1000 + Math.abs(entry.amount - ov.amount);
      if (dist < bestDist) { bestDist = dist; best = i; }
    });
    if (best > 0) out[name] = { level: best };
  });
  return out;
}

// Fill in any missing fields so old/imported states can't crash the renderer,
// and run the one-time v2 -> v2.3 migration (goals, slots, ladders).
function normalizeState(obj) {
  const seed = SEED_ROUTINE ? deepClone(SEED_ROUTINE) : null;
  let routine = obj.routine || (seed ? deepClone(seed) : {});
  const legacy = isLegacyRoutine(routine);
  if (legacy && seed) routine = migrateRoutine(routine, seed, obj.settings);
  // v2.3 -> v2.4: runs whenever the stored routine.version is < 3, so a routine
  // already stamped version 2 by the v2.3 migration still picks up weights, the
  // splits goal, the real warm-up block, and the calf-raise cleanup.
  if (seed) routine = migrateRoutineV3(routine, seed);
  // v2.4 -> v2.5: runs whenever the stored routine.version is < 4, so a routine
  // already stamped version 3 still drops dose ranges and the retired
  // "Couch stretch".
  if (seed) routine = migrateRoutineV4(routine, seed);
  // v2.5 -> v2.5.1: runs whenever the stored routine.version is < 5, so a routine
  // already stamped version 4 (with location "wall" stored) merges wall into floor.
  routine = migrateRoutineV5(routine);
  // v2.5 -> v3.0: goal-weighted generator. Migrate generically so user edits
  // survive; if anything about the stored shape trips the migration, fall back
  // to the fresh seed wholesale (per spec).
  if (seed) {
    try { routine = migrateRoutineV6(routine, seed); }
    catch (e) { routine = deepClone(seed); }
  }
  // v3.1 -> v3.2: add the "Shoulders" warm-up group (Shoulder lifts + Misc). Runs
  // for any stored routine.version < 7 so existing users get the new section.
  if (seed) routine = migrateRoutineV7(routine, seed);
  // v3.2 -> v3.3: rescale goal scores 0–3 -> 0–10. Seed-known moves adopt the seed's
  // new scores by name; user-added moves keep theirs. Runs for any version < 8.
  if (seed) routine = migrateRoutineV8(routine, seed);
  // v3.3 -> v3.4: stamp per-move jointFriendly from the seed by name (seed-known moves
  // only; user-added moves stay flag-less and are allowed by joint-friendly mode).
  if (seed) routine = migrateRoutineV9(routine, seed);
  // v3.4 -> v3.6: split jointFriendly into a jointStress array (['legs','arms']). Stamp
  // seed-known moves by name; a user move that was excluded before stays excluded. Runs
  // for any stored routine.version < 10.
  if (seed) routine = migrateRoutineV10(routine, seed);
  // v3.6 -> v3.7: convert per-move jointStress arrays + dayLock into the generic tag
  // system (routine gains a `tags` catalog; moves gain `tags` ids). Runs for any stored
  // routine.version < 11. See migrateRoutineV11 for the field mapping.
  if (seed) routine = migrateRoutineV11(routine, seed);
  // v3.7 -> v3.8: coach data update (shins goal + shin moves, gym-only tag, arch rocks
  // replaces wall-sit hollow press, hollow-rocks 3×12, lower-back rescoring, tibialis
  // un-day-locked). Runs for any stored routine.version < 12. See migrateRoutineV12.
  if (seed) routine = migrateRoutineV12(routine, seed);
  // v3.8 -> v3.8.1: moveset audit — stamp joint-stress-arms on Overhead press and
  // L-sit or tuck sit hold (seed-known, by name). Runs for any version < 13.
  // Doesn't use the seed, but is gated on it like the others so a failed seed
  // load can never stamp the version past the seed-dependent migrations above.
  if (seed) routine = migrateRoutineV13(routine);
  // v3.8.1 -> v3.9.1: audit gap-fill — insert the seven researched moves (home
  // pull, anti-rotation, adductor, hamstring/quad eccentrics, lateral plyo,
  // one-leg hinge). Runs for any version < 14. See migrateRoutineV14.
  if (seed) routine = migrateRoutineV14(routine, seed);
  // v3.9.5 -> v4.0: Phase 1 metadata foundation — copy the families catalog and stamp
  // family/loads/fatigue/qualitySensitive onto seed-known moves by name (no overwrite of
  // existing fields). Runs for any version < 15. See migrateRoutineV15.
  if (seed) routine = migrateRoutineV15(routine, seed);
  // Move-viewer tombstones: a move the user deleted must never be resurrected by a
  // migration or a re-inserted seed move — filter deleted names after all migrations.
  const tombstones = Array.isArray(obj.deletedMoves) ? obj.deletedMoves.slice() : [];
  if (tombstones.length && routine.blocks && Array.isArray(routine.blocks.moves)) {
    routine.blocks.moves = routine.blocks.moves.filter((m) => tombstones.indexOf(m && m.name) === -1);
  }
  renameWarmupGroups(routine);   // v2.4.1 warm-up group rename (see below)

  const base = freshState(routine);
  const merged = Object.assign(base, obj, {
    settings: Object.assign({}, base.settings, obj.settings || {}),
    checks: obj.checks || {},
    // v3.6: collapsed session blocks — tolerate the field being absent in older saves.
    collapsed: obj.collapsed && typeof obj.collapsed === 'object' ? obj.collapsed : {},
    intensity: obj.intensity || {},
    setsDone: obj.setsDone || {},
    rest: obj.rest && typeof obj.rest === 'object' ? obj.rest : { name: null, startedAt: null },
    routineHistory: obj.routineHistory || [],
    log: obj.log || [],
    dismissed: obj.dismissed || {},
    swaps: obj.swaps || {},
    // v2.5 Auto Superset — state-level toggle, default ON (NOT part of the routine migration).
    autoSuperset: typeof obj.autoSuperset === 'boolean' ? obj.autoSuperset : true,
    deletedMoves: tombstones,
    routine: routine,
    view: ['today', 'daily', 'moves', 'coach', 'settings'].indexOf(obj.view) >= 0 ? obj.view : 'today'
  });
  delete merged.settings.aerial;   // obsolete — aerial is now a goal
  // v3.9: seed the editable athlete profile on installs that predate the Coach.
  if (typeof merged.settings.coachProfile !== 'string') merged.settings.coachProfile = DEFAULT_COACH_PROFILE;

  // v3.0: collapse the old four per-block sliders into one "moves" total. When any
  // legacy slider is stored, moves = clamp(skill+core+wts+mach, 3, 15); then drop
  // the old keys. (For legacy v2 routines the raw counts, not the +2 form, are
  // summed — near enough, and the value is user-adjustable afterwards.)
  const osettings = obj.settings || {};
  if (['skill', 'core', 'wts', 'mach'].some((k) => typeof osettings[k] === 'number')) {
    const sum = (osettings.skill || 0) + (osettings.core || 0) +
      (osettings.wts || 0) + (osettings.mach || 0);
    merged.settings.moves = clamp(sum, 3, 15);
  }
  ['skill', 'core', 'wts', 'mach'].forEach((k) => delete merged.settings[k]);
  if (typeof merged.settings.moves !== 'number') merged.settings.moves = base.settings.moves;
  merged.settings.moves = clamp(merged.settings.moves, 3, 15);
  // v3.7: joint-friendly toggles are gone — map them onto the per-tag priority map.
  // A recovering-region toggle that was ON (true) becomes priority 1 ("hard avoid") for
  // that region's tag; OFF (or absent) becomes 3 ("no effect"). Then drop the retired
  // keys. The old single v3.4 jointFriendly boolean, if still present, seeds BOTH.
  // Read the STORED tagPriority (obj), not merged — merged already carries base's
  // default-3 fill, which would otherwise pre-empt the toggle→priority mapping below.
  const storedTP = (obj.settings && obj.settings.tagPriority && typeof obj.settings.tagPriority === 'object' &&
    !Array.isArray(obj.settings.tagPriority)) ? obj.settings.tagPriority : {};
  const tp = Object.assign({}, storedTP);
  const legacyBoth = merged.settings.jointFriendly === true;
  if (('jointFriendlyLegs' in merged.settings || 'jointFriendly' in merged.settings) &&
      tp['joint-stress-legs'] == null) {
    tp['joint-stress-legs'] = (merged.settings.jointFriendlyLegs === true || legacyBoth) ? 1 : 3;
  }
  if (('jointFriendlyArms' in merged.settings || 'jointFriendly' in merged.settings) &&
      tp['joint-stress-arms'] == null) {
    tp['joint-stress-arms'] = (merged.settings.jointFriendlyArms === true || legacyBoth) ? 1 : 3;
  }
  delete merged.settings.jointFriendly;
  delete merged.settings.jointFriendlyLegs;
  delete merged.settings.jointFriendlyArms;
  // Every non-auto tag gets a priority (default 3); existing entries clamp to int 1–5.
  // Auto (day) tags never appear here; orphaned/auto ids are dropped.
  const validTag = {};
  ((routine && routine.tags) || []).forEach((t) => {
    if (!t || !t.id || t.auto) return;
    validTag[t.id] = true;
    tp[t.id] = (typeof tp[t.id] === 'number') ? clamp(tp[t.id] | 0, 1, 5) : 3;
  });
  Object.keys(tp).forEach((id) => { if (!validTag[id]) delete tp[id]; });
  merged.settings.tagPriority = tp;
  // v3.5/v3.7: superset bias — integer 0–30 (default 5). Missing / non-number → 5; clamp + int.
  merged.settings.supersetBias = typeof merged.settings.supersetBias === 'number'
    ? clamp(merged.settings.supersetBias | 0, 0, 30) : 5;
  // v4.0: weeklyClasses — integer 0–2 (default 1). Missing / non-number → 1; clamp + int.
  merged.settings.weeklyClasses = typeof merged.settings.weeklyClasses === 'number'
    ? clamp(merged.settings.weeklyClasses | 0, 0, 2) : 1;
  // v4.1 (Phase 3): per-session readiness + intent (survive a mid-session reload; cleared on
  // finish). Any unknown/garbage value snaps back to its default. Not in settings/routine.
  merged.sessionIntent = sessionIntent(merged);   // reads merged.sessionIntent; unknown → 'default'
  merged.readiness = normalizeReadiness(merged.readiness);
  // v4.2 (Phase 4): persistent regionStatus survives reloads; repair any garbage (unknown
  // region/light dropped, yellow sessionsLeft clamped 1..2, red stripped of sessionsLeft).
  merged.regionStatus = normalizeRegionStatus(merged.regionStatus);

  if (legacy) {
    merged.intensity = migrateIntensity(obj.intensity || {}, routine);
    merged.routineHistory = [];   // old history is v1-shaped; clearing is acceptable per spec
  }

  // Clamp stored ladder levels to the current ladder length — a routine edit (or
  // the v2.4 weight reshape) can change a ladder's size under a saved override.
  Object.keys(merged.intensity || {}).forEach((name) => {
    const ov = merged.intensity[name];
    if (!ov || typeof ov.level !== 'number') return;
    const ex = findExerciseByName(routine, name);
    if (!ex) return;
    const lvl = clamp(ov.level, 0, progressionLadder(ex).length - 1);
    if (lvl <= 0) delete merged.intensity[name];
    else merged.intensity[name] = { level: lvl };
  });
  return merged;
}

function saveState() {
  try { localStorage.setItem(V2_KEY, JSON.stringify(state)); }
  catch (e) { /* quota / private-mode: fail quietly, app still works this session */ }
}

async function loadSeed() {
  const res = await fetch('routine-seed.json');
  if (!res.ok) throw new Error('seed fetch ' + res.status);
  return res.json();
}

/* --- 3. Routine schema validator (Phase 3, rewritten v3.0) ---------------- *
 * Standalone, no deps. Returns { valid, errors[] } with human-readable paths.
 * Reused by the manual JSON editor and the LLM edit flow.
 *
 * v3.0 schema: goals have a `kind` ("training" | "care"); training goals carry a
 * numeric weight, care goals do not. blocks = { warmup[], moves[], cooldown[] }.
 * A `moves` entry has a `section` ("floor"|"weights"|"machines"), a `goalScores`
 * map (trainingGoalId -> integer 0..10), an optional `care` array of care-goal ids,
 * and (v3.7) an optional `tags` array of ids from the routine's top-level `tags`
 * catalog. warmup/cooldown entries keep a `goals` tag array. Extra fields (group,
 * rest, progression, tempoNote, alwaysInShort, muscle) are allowed.
 */
const SECTIONS = ['floor', 'weights', 'machines'];
// v4.0 (Phase 1): family `phase` ordering ranks and the load-region keys a move's
// `loads` object may carry. Both are data facts the Phase 2 generator reasons over.
const FAMILY_PHASES = ['power', 'strength', 'skill-strength', 'trunk', 'accessory'];
const LOAD_KEYS = ['impact', 'shin', 'knee', 'foot', 'wrist', 'elbow', 'lumbar'];

function validateRoutine(routine) {
  const errors = [];
  if (!routine || typeof routine !== 'object' || Array.isArray(routine)) {
    return { valid: false, errors: ['Routine must be a JSON object'] };
  }

  ['version', 'goals', 'blocks'].forEach((f) => {
    if (!(f in routine)) errors.push('Missing required top-level field: ' + f);
  });
  if ('version' in routine && typeof routine.version !== 'number') {
    errors.push('version must be a number');
  }

  const trainingIds = [];
  const careIds = [];
  if (!Array.isArray(routine.goals)) {
    errors.push('goals must be an array of { id, name, kind, colorId, weight? }');
  } else {
    routine.goals.forEach((g, i) => {
      if (!g || typeof g !== 'object' || Array.isArray(g)) {
        errors.push('goals[' + i + '] must be an object'); return;
      }
      if (typeof g.id !== 'string' || !g.id) errors.push('goals[' + i + '] missing string "id"');
      if (typeof g.name !== 'string' || !g.name) errors.push('goals[' + i + '] missing string "name"');
      if (g.kind !== 'training' && g.kind !== 'care') {
        errors.push('goals[' + i + '] (' + (g.id || i) + ') "kind" must be "training" or "care"');
      }
      if (g.kind === 'training') {
        if (typeof g.weight !== 'number' || g.weight < 0) {
          errors.push('goals[' + i + '] (' + (g.id || i) + ') training goal "weight" must be a number >= 0');
        }
        if (typeof g.id === 'string') trainingIds.push(g.id);
      } else if (g.kind === 'care' && typeof g.id === 'string') {
        careIds.push(g.id);
      }
    });
  }
  const knownGoals = trainingIds.concat(careIds);

  // v3.7: optional top-level `tags` catalog — [{ id, name, auto? }]. ids unique;
  // `auto`, when present, must be "day". Move `tags` are validated against these ids.
  const tagIds = [];
  if ('tags' in routine) {
    if (!Array.isArray(routine.tags)) {
      errors.push('tags must be an array of { id, name, auto? }');
    } else {
      const seenTag = new Set();
      routine.tags.forEach((t, i) => {
        if (!t || typeof t !== 'object' || Array.isArray(t)) {
          errors.push('tags[' + i + '] must be an object'); return;
        }
        if (typeof t.id !== 'string' || !t.id) errors.push('tags[' + i + '] missing string "id"');
        if (typeof t.name !== 'string' || !t.name) errors.push('tags[' + i + '] missing string "name"');
        if ('auto' in t && t.auto !== 'day') {
          errors.push('tags[' + i + '] (' + (t.id || i) + ') "auto" must be "day" when present');
        }
        if (typeof t.id === 'string' && t.id) {
          if (seenTag.has(t.id)) errors.push('tags: duplicate tag id "' + t.id + '"');
          seenTag.add(t.id); tagIds.push(t.id);
        }
      });
    }
  }

  // v4.0 (Phase 1): optional top-level `families` catalog — [{ id, name, phase, maxPerSession? }].
  // ids unique; `phase` one of the five ordering ranks; `maxPerSession` a positive integer when
  // present (defaults to 1). Move `family` is validated against these ids. Mirrors `tags` above.
  const familyIds = [];
  if ('families' in routine) {
    if (!Array.isArray(routine.families)) {
      errors.push('families must be an array of { id, name, phase, maxPerSession? }');
    } else {
      const seenFam = new Set();
      routine.families.forEach((f, i) => {
        if (!f || typeof f !== 'object' || Array.isArray(f)) {
          errors.push('families[' + i + '] must be an object'); return;
        }
        if (typeof f.id !== 'string' || !f.id) errors.push('families[' + i + '] missing string "id"');
        if (typeof f.name !== 'string' || !f.name) errors.push('families[' + i + '] missing string "name"');
        if (FAMILY_PHASES.indexOf(f.phase) === -1) {
          errors.push('families[' + i + '] (' + (f.id || i) + ') "phase" must be one of ' + FAMILY_PHASES.join(', '));
        }
        if ('maxPerSession' in f && !(Number.isInteger(f.maxPerSession) && f.maxPerSession > 0)) {
          errors.push('families[' + i + '] (' + (f.id || i) + ') "maxPerSession" must be a positive integer');
        }
        if (typeof f.id === 'string' && f.id) {
          if (seenFam.has(f.id)) errors.push('families: duplicate family id "' + f.id + '"');
          seenFam.add(f.id); familyIds.push(f.id);
        }
      });
    }
  }

  const blocks = routine.blocks;
  if (!blocks || typeof blocks !== 'object' || Array.isArray(blocks)) {
    errors.push('blocks must be an object');
    return { valid: errors.length === 0, errors };
  }

  function validateDose(ex, path, label) {
    const d = ex.dose;
    if (!d || typeof d !== 'object') {
      errors.push(path + ' (' + label + '): dose must be an object'); return;
    }
    if (!Number.isInteger(d.sets) || d.sets < 1 || d.sets > 6) {
      errors.push(path + ' (' + label + '): dose.sets must be an integer 1–6 (got ' + JSON.stringify(d.sets) + ')');
    }
    if (typeof d.amount !== 'number' || !(d.amount > 0)) {
      errors.push(path + ' (' + label + '): dose.amount must be a number > 0 (got ' + JSON.stringify(d.amount) + ')');
    }
    if ('unit' in d && !UNITS.includes(d.unit)) {
      errors.push(path + ' (' + label + '): unknown unit "' + d.unit + '" (allowed: ' + UNITS.join(', ') + ')');
    }
    if ('weight' in d && !(typeof d.weight === 'number' && d.weight > 0)) {
      errors.push(path + ' (' + label + '): dose.weight must be a number > 0 (got ' + JSON.stringify(d.weight) + ')');
    }
  }

  function validateCommon(ex, path, label) {
    if ('rest' in ex && !(Number.isInteger(ex.rest) && ex.rest > 0)) {
      errors.push(path + ' (' + label + '): rest must be a positive integer (seconds)');
    }
    if ('muscle' in ex && (typeof ex.muscle !== 'string' || !ex.muscle)) {
      errors.push(path + ' (' + label + '): muscle must be a non-empty string');
    }
    if ('progression' in ex) {
      const p = ex.progression;
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        errors.push(path + ' (' + label + '): progression must be an object');
      } else {
        ['step', 'max', 'maxSets', 'weightStep'].forEach((k) => {
          if (k in p && !(typeof p[k] === 'number' && p[k] > 0)) {
            errors.push(path + ' (' + label + '): progression.' + k + ' must be a number > 0');
          }
        });
      }
    }
  }

  // A "moves" entry: section + goalScores (+ optional care).
  function validateMove(ex, path) {
    if (!ex || typeof ex !== 'object' || Array.isArray(ex)) {
      errors.push(path + ': move must be an object'); return;
    }
    const label = ex.name ? '"' + ex.name + '"' : path;
    ['name', 'dose', 'why', 'section', 'goalScores'].forEach((f) => {
      if (!(f in ex)) errors.push(path + ' (' + label + '): missing required field "' + f + '"');
    });
    if ('section' in ex && SECTIONS.indexOf(ex.section) === -1) {
      errors.push(path + ' (' + label + '): section must be one of ' + SECTIONS.join(', ') + ' (got ' + JSON.stringify(ex.section) + ')');
    }
    if ('goalScores' in ex) {
      const gs = ex.goalScores;
      if (!gs || typeof gs !== 'object' || Array.isArray(gs)) {
        errors.push(path + ' (' + label + '): goalScores must be an object of trainingGoalId -> 0..10');
      } else {
        Object.keys(gs).forEach((id) => {
          if (trainingIds.indexOf(id) === -1) {
            errors.push(path + ' (' + label + '): goalScores references unknown training goal "' + id + '"');
          }
          const v = gs[id];
          if (!Number.isInteger(v) || v < 0 || v > 10) {
            errors.push(path + ' (' + label + '): goalScores.' + id + ' must be an integer 0–10 (got ' + JSON.stringify(v) + ')');
          }
        });
      }
    }
    if ('care' in ex) {
      if (!Array.isArray(ex.care)) {
        errors.push(path + ' (' + label + '): care must be an array of care-goal ids');
      } else {
        ex.care.forEach((id) => {
          if (careIds.indexOf(id) === -1) errors.push(path + ' (' + label + '): care references unknown care goal "' + id + '"');
        });
      }
    }
    // v3.4: optional per-move `disabled` boolean keeps a move out of the generator pool
    // (Moves tab toggle). v3.7: optional `tags` array of ids from the routine's top-level
    // `tags` catalog; absent = no tags. Reject a non-array or an unknown id (same as
    // goalScores ids are checked).
    if ('disabled' in ex && typeof ex.disabled !== 'boolean') {
      errors.push(path + ' (' + label + '): disabled must be a boolean');
    }
    if ('tags' in ex) {
      if (!Array.isArray(ex.tags)) {
        errors.push(path + ' (' + label + '): tags must be an array of tag ids');
      } else {
        ex.tags.forEach((id) => {
          if (tagIds.indexOf(id) === -1) {
            errors.push(path + ' (' + label + '): tags references unknown tag "' + id + '"');
          }
        });
      }
    }
    // v4.0 (Phase 1): optional functional metadata. All OPTIONAL so user-/coach-added moves
    // without them stay valid. `family` — a string id resolving into routine.families (when a
    // families catalog exists). `loads` — an object of load-region -> integer 0..3 (keys ⊆
    // LOAD_KEYS). `fatigue` — integer 1..5. `qualitySensitive` — boolean.
    if ('family' in ex) {
      if (typeof ex.family !== 'string' || !ex.family) {
        errors.push(path + ' (' + label + '): family must be a non-empty string');
      } else if (familyIds.indexOf(ex.family) === -1) {
        errors.push(path + ' (' + label + '): family references unknown family id "' + ex.family + '"');
      }
    }
    if ('loads' in ex) {
      const ld = ex.loads;
      if (!ld || typeof ld !== 'object' || Array.isArray(ld)) {
        errors.push(path + ' (' + label + '): loads must be an object of load-region -> 0..3');
      } else {
        Object.keys(ld).forEach((k) => {
          if (LOAD_KEYS.indexOf(k) === -1) {
            errors.push(path + ' (' + label + '): loads has unknown region "' + k + '" (allowed: ' + LOAD_KEYS.join(', ') + ')');
          }
          const v = ld[k];
          if (!Number.isInteger(v) || v < 0 || v > 3) {
            errors.push(path + ' (' + label + '): loads.' + k + ' must be an integer 0–3 (got ' + JSON.stringify(v) + ')');
          }
        });
      }
    }
    if ('fatigue' in ex && !(Number.isInteger(ex.fatigue) && ex.fatigue >= 1 && ex.fatigue <= 5)) {
      errors.push(path + ' (' + label + '): fatigue must be an integer 1–5 (got ' + JSON.stringify(ex.fatigue) + ')');
    }
    if ('qualitySensitive' in ex && typeof ex.qualitySensitive !== 'boolean') {
      errors.push(path + ' (' + label + '): qualitySensitive must be a boolean');
    }
    if ('dose' in ex) validateDose(ex, path, label);
    validateCommon(ex, path, label);
  }

  // A static (warm-up / cool-down) entry: keeps a `goals` tag array.
  function validateStatic(ex, path) {
    if (!ex || typeof ex !== 'object' || Array.isArray(ex)) {
      errors.push(path + ': exercise must be an object'); return;
    }
    const label = ex.name ? '"' + ex.name + '"' : path;
    ['name', 'dose', 'goals', 'why'].forEach((f) => {
      if (!(f in ex)) errors.push(path + ' (' + label + '): missing required field "' + f + '"');
    });
    if ('goals' in ex) {
      if (!Array.isArray(ex.goals) || ex.goals.length === 0) {
        errors.push(path + ' (' + label + '): goals must be a non-empty array of goal ids');
      } else {
        ex.goals.forEach((id) => {
          if (knownGoals.indexOf(id) === -1) errors.push(path + ' (' + label + '): unknown goal "' + id + '"');
        });
      }
    }
    if ('dose' in ex) validateDose(ex, path, label);
    validateCommon(ex, path, label);
  }

  function validateArray(arr, path, validator) {
    if (!Array.isArray(arr)) { errors.push('blocks.' + path + ' must be an array'); return; }
    const seen = new Set();
    arr.forEach((ex, i) => {
      validator(ex, 'blocks.' + path + '[' + i + ']');
      if (ex && ex.name) {
        if (seen.has(ex.name)) errors.push('blocks.' + path + ': duplicate exercise name "' + ex.name + '"');
        seen.add(ex.name);
      }
    });
  }

  validateArray(blocks.warmup, 'warmup', validateStatic);
  validateArray(blocks.cooldown, 'cooldown', validateStatic);

  if (!Array.isArray(blocks.moves)) {
    errors.push('blocks.moves must be an array');
  } else if (blocks.moves.length < 1) {
    errors.push('blocks.moves must have at least one move');
  } else {
    validateArray(blocks.moves, 'moves', validateMove);
  }

  return { valid: errors.length === 0, errors };
}

/* --- 4. Session selection (the Phase 4 hook) ------------------------------ */

// A on odd sessions, B on even.
function currentDay(session) { return (session % 2 === 1) ? 'A' : 'B'; }

// Goal lookups for rendering (color chip + label) and scoring.
function goalById(id) {
  const goals = (state && state.routine && state.routine.goals) || [];
  return goals.find((g) => g && g.id === id) || null;
}
function goalColor(id) { const g = goalById(id); return (g && g.colorId) || 'gray'; }
function goalName(id) { const g = goalById(id); return (g && g.name) || id; }

// v3.0: care goals are always on; a training goal is "active" iff weight > 0.
function goalActive(id) {
  const g = goalById(id);
  if (!g) return false;
  return g.kind === 'care' ? true : (typeof g.weight === 'number' && g.weight > 0);
}

// The routine's training goals (kind === "training"). Reads state.routine to
// stay consistent with buildSession(state); tests inject state via _set.
function trainingGoals() {
  return ((state && state.routine && state.routine.goals) || [])
    .filter((g) => g && g.kind === 'training');
}

// Index of a goal id within routine.goals (stable tie-break for chips/top-goal).
function goalOrderIndex(id) {
  const goals = (state && state.routine && state.routine.goals) || [];
  const i = goals.findIndex((g) => g && g.id === id);
  return i < 0 ? 999 : i;
}

// v3.7: generic tag system (replaces the joint-friendly toggles AND the dayLock
// filter). A routine carries a top-level `tags` list [{ id, name, auto? }]; a move
// carries an optional `tags` array of those ids. Each tag resolves to a 1–5 priority
// that either drops the move (1) or scales its score (see tagMultiplier).

// Index the routine's tags by id (for O(1) lookup in the scorer). Pure.
function tagIndex(routine) {
  const out = {};
  ((routine && routine.tags) || []).forEach((t) => { if (t && t.id) out[t.id] = t; });
  return out;
}

function tagById(id) {
  return ((state && state.routine && state.routine.tags) || []).find((t) => t && t.id === id) || null;
}

// v4.0 (Phase 1): resolve a move's family id to its catalog entry (for the Moves-tab chip).
// Delegates to the pure moveFamilyEntry so the catalog lookup lives in one place.
function familyById(id) {
  return moveFamilyEntry(state && state.routine, { family: id });
}

/* --- v4.0 (Phase 2): move-metadata accessors with defaults ----------------- *
 * User/coach-added moves may lack the Phase-1 metadata. These centralise the
 * defaults (loads 0 per key; fatigue 3; missing/unknown family → no cap, no
 * coverage match, ordering rank "strength"). All pure. */
function moveLoad(move, key) {
  const v = move && move.loads && move.loads[key];
  return (typeof v === 'number' && v > 0) ? v : 0;
}
function moveFatigue(move) {
  const f = move && move.fatigue;
  return (typeof f === 'number' && f >= 1) ? f : 3;
}
// A move's family id, or null if missing (used for caps/coverage/ordering).
function moveFamilyId(move) {
  return (move && typeof move.family === 'string' && move.family) ? move.family : null;
}
// A move's family catalog entry against a routine (pure — no global state). null if unknown.
function moveFamilyEntry(routine, move) {
  const id = moveFamilyId(move);
  if (!id) return null;
  return ((routine && routine.families) || []).find((f) => f && f.id === id) || null;
}
// Ordering rank of a move's family phase (power 0 … accessory 4; unknown/missing → strength 1).
function moveFamilyRank(routine, move) {
  const fam = moveFamilyEntry(routine, move);
  const idx = fam ? FAMILY_PHASES.indexOf(fam.phase) : -1;
  return idx === -1 ? 1 : idx;
}
// Per-session cap for a move's family (default 1). Missing/unknown family → no cap (Infinity).
function moveMaxPerFamily(routine, move) {
  const fam = moveFamilyEntry(routine, move);
  if (!fam) return Infinity;
  return (typeof fam.maxPerSession === 'number' && fam.maxPerSession >= 1) ? fam.maxPerSession : 1;
}
// "Arm-support" load: wrist OR elbow ≥ 2 (a budget category and a superset incompatibility).
function isArmSupport(move) {
  return moveLoad(move, 'wrist') >= 2 || moveLoad(move, 'elbow') >= 2;
}

/* --- v4.0 (Phase 2): generator budgets & coverage template ----------------- *
 * Data facts kept as code constants (no schema change this phase). Note: a move
 * whose single-key load already exceeds a session budget can never be selected
 * with that budget — e.g. an impact-3 move is excluded outright at weeklyClasses 2
 * (impact budget 2). That is intended: the classes supply that week's impact. */
const HIGH_FATIGUE = 4;                       // "high-fatigue" threshold (fatigue ≥ 4)
const GENERATOR_BUDGETS = {
  impactByClasses: { 0: 4, 1: 3, 2: 2 },      // Σ moveLoad(impact) over the session, by weeklyClasses
  highFatigue: 2,                             // max moves with fatigue ≥ 4
  armSupport: 2,                              // max arm-support moves (wrist∨elbow ≥ 2)
  lumbar: 2                                    // max moves with lumbar ≥ 2
};
// Ordered coverage slots (soft). Each lists the families that satisfy it; while an
// active slot is unfilled, candidates in its families get a ×COVERAGE_BOOST nudge.
const COVERAGE_SLOTS = [
  ['trunk-anti-extension', 'gymnastics-shape'],               // 1 trunk control
  ['trunk-anti-rotation'],                                    // 2 anti-rotation
  ['shin-dorsiflexion', 'calf-soleus'],                       // 3 shin/ankle
  ['squat-knee', 'single-leg'],                               // 4 squat/single-leg
  ['hinge-hamstring'],                                        // 5 hinge
  ['horizontal-pull', 'posture-accessory'],                   // 6 pull
  ['gymnastics-shape', 'handstand-support']                   // 7 gymnastics-specific
];
const COVERAGE_BOOST = 1.5;

// weeklyClasses is 0|1|2 (default 1). Pure reader with the default baked in.
function weeklyClasses(settings) {
  const v = settings && settings.weeklyClasses;
  return (v === 0 || v === 1 || v === 2) ? v : 1;
}

/* --- v4.1 (Phase 3): readiness caps + session intents ---------------------- *
 * Per-session body-state (state.readiness) and one intent (state.sessionIntent)
 * enter the generator as extra HARD FILTERS and BUDGET MODIFIERS. Deterministic:
 * they are read from state, never RNG/Date. Budgets only tighten (compose over the
 * weeklyClasses base via Math.min); readiness/intent caps only remove candidates. */
const SESSION_INTENTS = ['default', 'gym-prep', 'recovery', 'low-impact', 'short', 'upper'];
const INTENT_LABELS = {
  'default': 'Default', 'gym-prep': 'Gym prep', 'recovery': 'Recovery',
  'low-impact': 'Low impact', 'short': 'Short', 'upper': 'Upper'
};
// Normalized session intent for a state (unknown/missing → 'default'). Pure — also
// tolerates being handed a bare settings object (has no sessionIntent → 'default').
function sessionIntent(st) {
  const v = st && st.sessionIntent;
  return SESSION_INTENTS.indexOf(v) >= 0 ? v : 'default';
}
// Per-load-key caps this session, from readiness regions + intent. Only capped keys are
// present; value = the max allowed load for that key (a move with load > cap is out).
//   region caution → 1 · region stop → 0 · back sensitive → lumbar 1 · arms caution →
//   wrist & elbow 1 · intent 'upper' → impact/shin/knee/foot all 0 (a legs-off day).
// When two sources cap the same key, the more restrictive (min) wins. Pure given state.
function readinessCaps(st) {
  const r = (st && st.readiness && typeof st.readiness === 'object') ? st.readiness : {};
  const caps = {};
  const cap = (key, v) => { caps[key] = (key in caps) ? Math.min(caps[key], v) : v; };
  const region = (val, key) => {
    if (val === 'caution') cap(key, 1);
    else if (val === 'stop') cap(key, 0);
  };
  region(r.shins, 'shin');
  region(r.knee, 'knee');
  region(r.foot, 'foot');
  if (r.back === 'sensitive') cap('lumbar', 1);
  if (r.arms === 'caution') { cap('wrist', 1); cap('elbow', 1); }
  if (sessionIntent(st) === 'upper') { cap('impact', 0); cap('shin', 0); cap('knee', 0); cap('foot', 0); }
  // v4.2: a RED region (persistent 24h-feedback status) pauses all its load keys — cap each
  // at 0. Composes with readiness caution/stop via the same min() helper. Yellow adds NO cap.
  const rs = (st && st.regionStatus && typeof st.regionStatus === 'object') ? st.regionStatus : {};
  Object.keys(rs).forEach((region) => {
    if (rs[region] && rs[region].light === 'red') (REGION_KEYS[region] || []).forEach((k) => cap(k, 0));
  });
  return caps;
}
// Does `move` respect every readiness cap (its load on each capped key ≤ the cap)? Pure.
function passesReadiness(move, caps) {
  const keys = Object.keys(caps || {});
  for (let i = 0; i < keys.length; i++) {
    if (moveLoad(move, keys[i]) > caps[keys[i]]) return false;
  }
  return true;
}
// v4.2: is `move` implicated by the current region status? True iff some yellow OR red region
// carries a load ≥ 1 on any of its keys. (Red-implicated moves are already filtered out of
// generation, but a red move can still be on screen mid-session, so dose-cut + pip suppression
// treat yellow and red uniformly here.) Pure given (move, regionStatus).
function moveImplicated(move, regionStatus) {
  const rs = (regionStatus && typeof regionStatus === 'object') ? regionStatus : {};
  const regions = Object.keys(rs);
  for (let i = 0; i < regions.length; i++) {
    const s = rs[regions[i]];
    if (!s || (s.light !== 'yellow' && s.light !== 'red')) continue;
    const keys = REGION_KEYS[regions[i]] || [];
    for (let j = 0; j < keys.length; j++) {
      if (moveLoad(move, keys[j]) >= 1) return true;
    }
  }
  return false;
}
// v4.2: pick the ladder level to display for an implicated move — a ~20% volume cut snapped
// DOWN to a real ladder step. Level 0 (base) is the floor. Otherwise target volume =
// DOSE_CUT × (sets × amount) at `level`; walk down from level-1 and return the first (highest)
// step at or under it; if none qualifies, step down one anyway (always ≥1 step). Ignores weight.
function doseCutLevel(ladder, level) {
  if (level === 0) return 0;
  const vol = (e) => e.sets * e.amount;
  const target = DOSE_CUT * vol(ladder[level]);
  for (let l = level - 1; l >= 0; l--) {
    if (vol(ladder[l]) <= target) return l;
  }
  return level - 1;
}
// Effective move-count budget for the session: intent 'short' trims two moves (floor 3);
// every other intent leaves settings.moves untouched. Pure given state.
function effectiveMoveBudget(st) {
  const moves = Math.max((st && st.settings && st.settings.moves) || 0, 0);
  return sessionIntent(st) === 'short' ? Math.max(3, moves - 2) : moves;
}
// This session's load budgets. Accepts EITHER a full state (applies readiness/intent
// modifiers) or a bare settings object (Phase-2 callers: base budgets only). Modifiers
// COMPOSE over the weeklyClasses base by taking the minimum — budgets only tighten. Pure.
function sessionBudgets(stateOrSettings) {
  const st = stateOrSettings || {};
  const settings = st.settings || st;               // full state carries .settings; else it IS settings
  const r = (st.readiness && typeof st.readiness === 'object') ? st.readiness : {};
  const intent = sessionIntent(st);
  let impact = GENERATOR_BUDGETS.impactByClasses[weeklyClasses(settings)];
  if (r.classSoon || intent === 'gym-prep') impact = Math.min(impact, 1);
  if (intent === 'low-impact' || intent === 'upper') impact = Math.min(impact, 0);
  let highFatigue = GENERATOR_BUDGETS.highFatigue;
  if (intent === 'recovery' || r.energy === 'low') highFatigue = Math.min(highFatigue, 1);
  let armSupport = GENERATOR_BUDGETS.armSupport;
  if (r.arms === 'caution') armSupport = Math.min(armSupport, 1);
  let lumbar = GENERATOR_BUDGETS.lumbar;
  if (r.back === 'sensitive') lumbar = Math.min(lumbar, 1);
  // v4.2: a YELLOW region eases its budget by one step (cumulative per region; floored at 0).
  // shins/knee/foot → impact (a leg region loses a landing), back → lumbar, arms → armSupport.
  // Budgets only ever tighten; a bare settings object (no regionStatus) is left unchanged.
  const rs = (st.regionStatus && typeof st.regionStatus === 'object') ? st.regionStatus : {};
  Object.keys(rs).forEach((region) => {
    if (!rs[region] || rs[region].light !== 'yellow') return;
    if (region === 'shins' || region === 'knee' || region === 'foot') impact = Math.max(0, impact - 1);
    else if (region === 'back') lumbar = Math.max(0, lumbar - 1);
    else if (region === 'arms') armSupport = Math.max(0, armSupport - 1);
  });
  return { impact: impact, highFatigue: highFatigue, armSupport: armSupport, lumbar: lumbar };
}
// Would adding `move` to a session whose running `totals` are as given bust any
// `budgets`? Pure. totals = { impact, highFatigue, armSupport, lumbar }.
function bustsBudget(move, totals, budgets) {
  if (totals.impact + moveLoad(move, 'impact') > budgets.impact) return true;
  if (moveFatigue(move) >= HIGH_FATIGUE && totals.highFatigue + 1 > budgets.highFatigue) return true;
  if (isArmSupport(move) && totals.armSupport + 1 > budgets.armSupport) return true;
  if (moveLoad(move, 'lumbar') >= 2 && totals.lumbar + 1 > budgets.lumbar) return true;
  return false;
}
// Fold `move` into the running `totals` (mutates). Pure otherwise.
function addToBudgetTotals(totals, move) {
  totals.impact += moveLoad(move, 'impact');
  if (moveFatigue(move) >= HIGH_FATIGUE) totals.highFatigue += 1;
  if (isArmSupport(move)) totals.armSupport += 1;
  if (moveLoad(move, 'lumbar') >= 2) totals.lumbar += 1;
}
// Soft coverage multiplier for `move` given the per-family pick counts so far and how
// many leading slots are active: ×COVERAGE_BOOST if the move's family belongs to an
// active slot that has no chosen family yet, else ×1. Applied once. Pure.
function coverageBoost(move, famCount, activeSlots) {
  const fam = moveFamilyId(move);
  if (!fam) return 1;
  for (let s = 0; s < activeSlots && s < COVERAGE_SLOTS.length; s++) {
    const slot = COVERAGE_SLOTS[s];
    if (slot.indexOf(fam) === -1) continue;
    if (!slot.some((f) => (famCount[f] || 0) > 0)) return COVERAGE_BOOST;   // slot unfilled → boost
  }
  return 1;
}
// Number of leading coverage slots that apply for a given move count. Pure.
function activeSlotCount(moveCount) {
  return Math.min(COVERAGE_SLOTS.length, Math.max(3, (moveCount | 0) - 2));
}
// Stable-sort moves by family phase rank (power → strength → skill-strength → trunk →
// accessory; unknown → strength). Preserves prior order within a rank. Pure.
function orderByPhase(routine, moves) {
  return (moves || [])
    .map((m, i) => ({ m: m, i: i, rank: moveFamilyRank(routine, m) }))   // rank once per move
    .sort((a, b) => (a.rank - b.rank) || (a.i - b.i))
    .map((o) => o.m);
}
// Shared superset pairing predicate (v4.0) — the SINGLE rule used directly by render
// grouping (groupSupersets) and transitively by the bias scorer (wouldSuperset, which
// delegates to groupSupersets) so the two cannot drift. True iff moves `a` and `b` may
// share a superset group. Pure.
function supersetPairOk(a, b) {
  if (!a || !b) return false;
  if ((a.location || 'floor') !== (b.location || 'floor')) return false;   // existing: same location
  if (a.muscle && b.muscle && a.muscle === b.muscle) return false;         // existing: no shared muscle
  const fa = moveFamilyId(a), fb = moveFamilyId(b);
  if (fa && fb && fa === fb) return false;                                 // different family (missing = compatible)
  if (moveFatigue(a) + moveFatigue(b) > 6) return false;                   // fatigue sum ≤ 6
  if (a.qualitySensitive && b.qualitySensitive) return false;             // not both quality-sensitive
  if (isArmSupport(a) && isArmSupport(b)) return false;                    // not both arm-support
  if (moveLoad(a, 'impact') >= 1 && moveLoad(b, 'impact') >= 1) return false; // not both impact ≥ 1
  return true;
}

// Tag priority (1–5) → score multiplier. ONE tunable table. Priority 1 is handled
// upstream as pool exclusion (never multiplied); anything outside 2–5 is neutral (×1).
const TAG_PRIORITY_MULT = { 2: 0.6, 3: 1, 4: 1.5, 5: 2.5 };
function tagMultiplier(priority) {
  return Object.prototype.hasOwnProperty.call(TAG_PRIORITY_MULT, priority) ? TAG_PRIORITY_MULT[priority] : 1;
}

// Human-readable meaning of each 1–5 level (shared by the settings sliders).
const TAG_LEVEL_LABEL = { 1: 'Hard avoid', 2: 'Lower priority', 3: 'No effect', 4: 'Slight priority', 5: 'Higher priority' };

// Effective 1–5 priority of a tag for scoring. Auto "day" tags are a SOFT preference
// derived from the session's A/B day (today's day → 4, the other → 2) — never a hard
// lock. Every other tag reads settings.tagPriority (default 3). Pure.
function tagEffectivePriority(tag, settings, day) {
  if (!tag) return 3;
  if (tag.auto === 'day') {
    const isToday = (day === 'A' && tag.id === 'day-a') || (day === 'B' && tag.id === 'day-b');
    return isToday ? 4 : 2;
  }
  const p = settings && settings.tagPriority && settings.tagPriority[tag.id];
  return (typeof p === 'number') ? p : 3;
}

// Resolve a move's tags into { excluded, mult }: any tag at effective priority 1
// excludes the move from the pool; otherwise the per-tag multipliers multiply
// together. A move with no tags is neutral. Pure given (move, routine, settings, day).
function tagScoreFactor(move, routine, settings, day) {
  const ids = (move && Array.isArray(move.tags)) ? move.tags : [];
  if (!ids.length) return { excluded: false, mult: 1 };
  const byId = tagIndex(routine);
  let mult = 1;
  for (let i = 0; i < ids.length; i++) {
    const tag = byId[ids[i]];
    if (!tag) continue;                 // unknown id — ignore (validator rejects on save)
    const p = tagEffectivePriority(tag, settings, day);
    if (p <= 1) return { excluded: true, mult: 0 };
    mult *= tagMultiplier(p);
  }
  return { excluded: false, mult: mult };
}

// Base goal-weighted score of a move: Σ over training goals of weight × score.
// Pure given (move, goals). A move scoring 0 is off for the current weights.
function scoreMove(move, goals) {
  const gs = (move && move.goalScores) || {};
  let total = 0;
  goals.forEach((g) => {
    const s = gs[g.id];
    if (s) total += (g.weight || 0) * s;
  });
  return total;
}

// The training goal id a move leans on most (ties -> earliest in routine.goals);
// null when the move has no positive score. Drives the primary chip + rest target.
function topGoalId(move) {
  const gs = (move && move.goalScores) || {};
  let best = null;
  Object.keys(gs).forEach((id) => {
    if (!(gs[id] > 0)) return;
    if (best == null || gs[id] > gs[best] ||
        (gs[id] === gs[best] && goalOrderIndex(id) < goalOrderIndex(best))) {
      best = id;
    }
  });
  return best;
}

// Ordered goal ids for a move's chips: positive-scored training goals (score
// desc, then routine order) followed by care ids. Used by the card renderers.
function moveChipIds(move) {
  const gs = (move && move.goalScores) || {};
  const scored = Object.keys(gs).filter((id) => gs[id] > 0)
    .sort((a, b) => (gs[b] - gs[a]) || (goalOrderIndex(a) - goalOrderIndex(b)));
  const ids = scored.slice();
  (move.care || []).forEach((id) => { if (ids.indexOf(id) === -1) ids.push(id); });
  return ids;
}

// Chip ids for any card: v3.0 moves use goalScores + care; static warm-up/
// cool-down entries keep their `goals` tag array; synthetic cards pass `goals`.
function cardGoalIds(ex) {
  if (ex && (ex.goalScores || ex.care)) {
    const ids = moveChipIds(ex);
    return ids.length ? ids : ['gym'];
  }
  return (ex && ex.goals && ex.goals.length) ? ex.goals : ['recovery'];
}

// Index of the most recent log entry in which `name` was COMPLETED (done),
// or -1 if it was never completed.
function lastCompletedIndex(name, log) {
  for (let i = log.length - 1; i >= 0; i--) {
    const hit = (log[i].exercises || []).some((e) => e.name === name && e.done);
    if (hit) return i;
  }
  return -1;
}

// Order `elig` least-recently-completed first; never-completed (-1) lead the
// list; ties preserve pool order. Pure — same (elig, log) => same order.
function leastRecentlyCompleted(elig, log) {
  return elig
    .map((ex, i) => ({ ex, i, rec: lastCompletedIndex(ex.name, log) }))
    .sort((a, b) => (a.rec - b.rec) || (a.i - b.i))
    .map((o) => o.ex);
}

// Per-section diminishing returns: each move already chosen in a section discounts
// that section's remaining candidates, so a strong section (usually Floor) can't
// starve Weights/Machines out of the session. Applied multiplicatively per pick.
const SECTION_DECAY = 0.85;

/*
 * v3.2 "number of moves" budget cost of a chosen set of moves. With Auto Superset
 * on, Floor moves that group into a superset (a group of >= 2) each count as HALF a
 * move — so a superset pair costs one whole move toward the slider — while every
 * other move costs one. v4.0: grouping mirrors supersetPlan exactly by phase-ordering
 * the Floor moves (orderByPhase, the render order) before groupSupersets, so the
 * selection budget and the rendered cards agree. Pure given (moves, routine).
 */
function sessionMoveCost(moves, autoSuperset, routine) {
  if (!autoSuperset) return (moves || []).length;
  const floorMoves = orderByPhase(routine, (moves || [])
    .filter((ex) => ex && (ex.section || 'floor') === 'floor' && ex.muscle));
  const grouped = new Set();
  groupSupersets(floorMoves.map((ex) => ({ ex: ex, block: 'floor' }))).forEach((g) => {
    if (g.members.length >= 2) g.members.forEach((m) => grouped.add(m.ex));
  });
  let cost = 0;
  (moves || []).forEach((ex) => { cost += grouped.has(ex) ? 0.5 : 1; });
  return cost;
}

/*
 * v3.0 move selection (replaces the staple/variety machinery). Pure given `st`.
 *   1. Pool = blocks.moves, minus disabled moves and any move a tag hard-avoids.
 *   2. baseScore = Σ training goal weight × goalScore; drop moves scoring 0.
 *   3. Recency boost: sessionsSince = sessions since the move was last completed
 *      (never -> 6, capped at 6); effective = base × (1 + 0.1 × sessionsSince).
 *   4. Greedily take `moves` picks: each pick maximizes
 *      effective × SECTION_DECAY^(already-picked in that move's section),
 *      deterministic tie-break by pool order. The decay keeps the session from
 *      flooding with one section's moves so every populated section stays present.
 * Returns the selected move objects in their original pool order.
 */
function selectMoves(st) {
  const b = (st.routine && st.routine.blocks) || {};
  // v3.7: drop moves the user disabled in the Moves tab, and any move a tag hard-avoids
  // (a tag at effective priority 1). Surviving moves keep a per-tag score multiplier
  // (mult) — priority 2→×0.6, 3→×1, 4→×1.5, 5→×2.5. Day A/B are auto tags: a SOFT
  // same-day preference (no hard lock), so a B-tagged move can appear on an A day.
  const day = currentDay(st.session);
  const settings = st.settings || {};
  // v4.1 (Phase 3): readiness/intent hard-filter caps — a move exceeding a capped load
  // key (shins/knee/foot caution|stop, back sensitive, arms caution, intent 'upper') is
  // out of today's pool, right alongside the disabled / tag-priority-1 exclusions.
  const caps = readinessCaps(st);
  const pool = [];
  const tagMults = [];
  (b.moves || []).forEach((ex) => {
    if (!ex || ex.disabled) return;
    if (!passesReadiness(ex, caps)) return;
    const f = tagScoreFactor(ex, st.routine, settings, day);
    if (f.excluded) return;
    pool.push(ex);
    tagMults.push(f.mult);
  });
  const goals = ((st.routine && st.routine.goals) || []).filter((g) => g && g.kind === 'training');
  const log = st.log || [];
  // v4.1: intent 'short' trims the move budget by two (floor 3); otherwise settings.moves.
  const count = effectiveMoveBudget(st);

  const scored = [];
  pool.forEach((move, i) => {
    const base = scoreMove(move, goals);
    if (base <= 0) return;
    const last = lastCompletedIndex(move.name, log);
    const sessionsSince = last < 0 ? 6 : Math.min(log.length - last, 6);
    scored.push({ move, i, section: move.section || 'floor', effective: base * (1 + 0.1 * sessionsSince) * tagMults[i] });
  });

  const remaining = scored.slice();
  const sectionCount = {};
  const chosen = [];
  // v4.0 (Phase 2): hard family caps + hard load budgets + soft coverage slots.
  // Family caps: once maxPerSession picks from a family, its candidates are ineligible.
  // Load budgets (session totals): a candidate whose addition busts a budget is skipped
  // this pass. Coverage: while a leading slot is unfilled, candidates in its families get
  // a ×1.5 nudge — a preference, never a quota. All deterministic (no RNG/Date).
  const budgets = sessionBudgets(st);   // v4.1: readiness/intent modifiers compose over the base
  const budgetTotals = { impact: 0, highFatigue: 0, armSupport: 0, lumbar: 0 };
  const famCount = {};
  const activeSlots = activeSlotCount(count);
  // v3.2: superset members each cost half a move toward the budget (see sessionMoveCost),
  // so a supersetting session pulls in more actual moves. Cost is measured over the chosen
  // moves in pool order, which sessionMoveCost then phase-orders exactly as they render.
  const autoSuperset = st.autoSuperset !== false;
  // v3.5/v3.7: superset bias (settings.supersetBias, 0–30, default 5). While Auto superset
  // is on, a candidate Floor move that would land in a superset group (>= 2) with the
  // already-chosen moves has its score multiplied by (1 + 0.1 * bias) — bias 10 = 2x,
  // bias 0 just disables this multiplier (the family caps / budgets / coverage of Generator
  // v2 still apply, so bias 0 no longer reproduces pre-v3.5 selection). The pair test
  // (wouldSuperset) phase-orders the floor moves to mirror render-time grouping exactly;
  // O(n^2) over the small move pool is fine.
  const bias = (st.settings && typeof st.settings.supersetBias === 'number') ? st.settings.supersetBias : 5;
  const biasOn = autoSuperset && bias > 0;
  const underBudget = () =>
    sessionMoveCost(chosen.slice().sort((a, b2) => a.i - b2.i).map((o) => o.move), autoSuperset, st.routine) < count;
  while (underBudget() && remaining.length) {
    let best = -1, bestVal = -Infinity;
    for (let k = 0; k < remaining.length; k++) {
      const c = remaining[k];
      const fam = moveFamilyId(c.move);
      // Hard: family cap reached, or this pick would bust a load budget → ineligible.
      if (fam && (famCount[fam] || 0) >= moveMaxPerFamily(st.routine, c.move)) continue;
      if (bustsBudget(c.move, budgetTotals, budgets)) continue;
      let val = c.effective * Math.pow(SECTION_DECAY, sectionCount[c.section] || 0);
      if (biasOn && wouldSuperset(chosen, c, st.routine)) val *= (1 + 0.1 * bias);
      val *= coverageBoost(c.move, famCount, activeSlots);   // soft coverage nudge
      // Strictly-greater wins; exact ties fall to the earlier pool index (stable).
      if (best === -1 || val > bestVal || (val === bestVal && c.i < remaining[best].i)) { bestVal = val; best = k; }
    }
    if (best === -1) break;   // no eligible candidate remains (family caps/budgets) — terminate cleanly
    const pick = remaining.splice(best, 1)[0];
    sectionCount[pick.section] = (sectionCount[pick.section] || 0) + 1;
    const pfam = moveFamilyId(pick.move);
    if (pfam) famCount[pfam] = (famCount[pfam] || 0) + 1;
    addToBudgetTotals(budgetTotals, pick.move);
    chosen.push(pick);
  }

  chosen.sort((a, b2) => a.i - b2.i);           // back to pool order for stable render
  return chosen.map((o) => o.move);
}

/*
 * Cooldown interpretation: the seed marks two items `alwaysInShort` and the
 * slider range is [1,2] over three items, so a count doesn't map cleanly.
 * Choice: cool === 1 -> "short" (only alwaysInShort items); cool >= 2 -> full list.
 */
function buildCooldown(arr, cool, day) {
  let list = (arr || []).slice();
  if (cool <= 1) list = list.filter((ex) => ex.alwaysInShort);
  return list;
}

// Section -> block title. Order here is the on-page order of the move blocks.
const MOVE_SECTIONS = [
  { key: 'floor', title: 'Floor' },
  { key: 'weights', title: 'Weights' },
  { key: 'machines', title: 'Machines' }
];

// Produce the ordered blocks for a session. Pure given `st`.
// Order: Warm-up, Floor, Weights, Machines, Cool-down (empty blocks skipped).
function buildSession(st) {
  const r = st.routine;
  const s = st.settings;
  const session = st.session;
  const day = currentDay(session);
  const b = r.blocks || {};
  const blocks = [];

  if (b.warmup && b.warmup.length) {
    blocks.push({ key: 'warmup', title: 'Warm-up',
      exercises: (b.warmup || []).slice() });
  }

  const selected = selectMoves(st);
  MOVE_SECTIONS.forEach((sec) => {
    // v4.0 (Phase 2): within each section, stable-sort by family phase rank so power /
    // quality-sensitive work lands while fresh and low-fatigue accessories close.
    const exercises = orderByPhase(r, selected.filter((ex) => (ex.section || 'floor') === sec.key));
    if (exercises.length) blocks.push({ key: sec.key, title: sec.title, exercises: exercises });
  });

  const cooldown = buildCooldown(b.cooldown, s.cool, day);
  if (cooldown.length) blocks.push({ key: 'cooldown', title: 'Cool-down', exercises: cooldown });

  return { session, day, blocks: applySwaps(blocks, st) };
}

/*
 * v3.1 day preview. Build the session `offset` days in the FUTURE, honestly
 * simulating rotation so the recency boost is right. Pure — never mutates `st`.
 * offset 0 returns exactly buildSession(st). Otherwise we walk forward on a COPY:
 * each step builds that session, appends a simulated "completed" log entry (the
 * same shape finishSession writes, minus dose/intensity — recency only reads
 * name + done), and advances the session index; the target session is built from
 * the simulated state. Per-session swaps are dropped in the copy (applySwaps only
 * applies at offset 0), and intensity levels are NOT advanced (preview doses show
 * at current intensity — see SPEC.md v3.1).
 */
function simulatedLogEntry(sim, build) {
  const exercises = [];
  build.blocks.forEach((bl) => {
    if (bl.key === 'warmup' || bl.key === 'cooldown') return;   // recency only tracks moves
    bl.exercises.forEach((ex) => exercises.push({ name: ex.name, done: true }));
  });
  return { session: sim.session, day: build.day, exercises: exercises };
}

function buildFutureSession(st, offset) {
  offset = Math.max(0, offset | 0);
  if (!offset) return buildSession(st);
  const sim = deepClone(st);
  sim.swaps = {};                       // preview ignores per-session swaps
  // v4.1 (Phase 3): a future day must NOT inherit today's readiness/intent — those are
  // a "how do I feel right now" input. Previews generate the neutral, all-good session.
  sim.readiness = defaultReadiness();
  sim.sessionIntent = 'default';
  sim.log = sim.log ? sim.log.slice() : [];
  for (let step = 0; step < offset; step++) {
    const build = buildSession(sim);
    sim.log.push(simulatedLogEntry(sim, build));
    sim.session += 1;
  }
  return buildSession(sim);
}

// Find an exercise object anywhere in the routine by name (base, unresolved).
function findExerciseByName(routine, name) {
  for (const pool of collectPools(routine)) {
    const f = pool.find((ex) => ex && ex.name === name);
    if (f) return f;
  }
  return null;
}

// All exercise arrays in the routine. Handles BOTH the v3.0 shape (warmup /
// moves / cooldown) and the pre-v3.0 shape (skill/core staples + variety pools,
// weightsA/B, machinesA/B) so migration-time lookups and runtime both work.
function collectPools(routine) {
  const b = (routine && routine.blocks) || {};
  const pools = [];
  ['warmup', 'moves', 'weightsA', 'weightsB', 'machinesA', 'machinesB', 'cooldown']
    .forEach((k) => { if (Array.isArray(b[k])) pools.push(b[k]); });
  ['skill', 'core'].forEach((k) => {
    if (b[k]) {
      if (Array.isArray(b[k].staples)) pools.push(b[k].staples);
      if (Array.isArray(b[k].varietyPool)) pools.push(b[k].varietyPool);
    }
  });
  return pools;
}

/*
 * Phase 4, heuristic #2 (apply side): substitute skip-swapped exercises into
 * the rendered session only. state.routine is NEVER edited — this maps a
 * display copy. Swaps are cleared on finish (see finishSession), so a swap is
 * a one-session trial; if the skip pattern persists the suggestion returns.
 */
function applySwaps(blocks, st) {
  const swaps = st.swaps || {};
  if (!Object.keys(swaps).length) return blocks;
  return blocks.map((bl) => ({
    key: bl.key, title: bl.title,
    exercises: bl.exercises.map((ex) => {
      const repName = swaps[ex.name];
      if (!repName) return ex;
      const rep = findExerciseByName(st.routine, repName);
      return rep || ex;
    })
  }));
}

/* --- 5. Doses & intensity overrides (Phase 1) ----------------------------- */

/*
 * Progression ladder (Feature D). Each move has an implicit ladder of
 * { sets, amount } steps. Params come from ex.progression when present, else
 * are computed from the base dose:
 *   step: sec/sec/side -> 5, min -> 1, reps-type -> (base >= 12 ? 2 : 1)
 *   max:  sec-type -> base+30; reps-type ->
 *         max(round(base*1.5), base + step*2); min -> base+3
 *   maxSets: dose.sets + 1, clamped to 6
 * Weighted moves (dose.weight present) additionally carry:
 *   weight:     the base physical load (lb)
 *   weightStep: progression.weightStep, else 5 if base weight < 100 else 10
 */
function progressionParams(ex) {
  const d = ex.dose || {};
  const u = d.unit;
  const base = d.amount;
  const p = ex.progression || {};
  const isSec = (u === 'sec' || u === 'sec/side');
  const isMin = (u === 'min');
  let step;
  if (typeof p.step === 'number') step = p.step;
  else if (isSec) step = 5;
  else if (isMin) step = 1;
  else step = base >= 12 ? 2 : 1;
  let max;
  if (typeof p.max === 'number') max = p.max;
  else if (isSec) max = base + 30;
  else if (isMin) max = base + 3;
  else max = Math.max(Math.round(base * 1.5), base + step * 2);
  let maxSets;
  if (typeof p.maxSets === 'number') maxSets = p.maxSets;
  else maxSets = clamp(d.sets + 1, 1, 6);
  const out = { step: step, max: max, maxSets: maxSets };
  if (typeof d.weight === 'number' && d.weight > 0) {
    out.weight = d.weight;
    out.weightStep = (typeof p.weightStep === 'number' && p.weightStep > 0)
      ? p.weightStep : (d.weight < 100 ? 5 : 10);
  }
  return out;
}

/*
 * Build the ordered ladder of { sets, amount } pairs. Starts at the base dose,
 * climbs amount by `step` until it reaches `max`, then adds a set and resets
 * the amount to base, repeating until { maxSets, max }. Pure. Exported.
 *
 * Weighted moves use DOUBLE progression instead: reps climb from base amount to
 * `max` by `step` at a fixed set count, then the weight bumps by `weightStep`
 * and reps reset — four weight tiers beyond the base (five total, so ladder
 * length = repLevels × 5). Sets stay at the base count (maxSets is ignored).
 * Each entry is { sets, amount, weight }.
 */
function progressionLadder(ex) {
  const d = ex.dose || {};
  const startAmt = d.amount;
  const params = progressionParams(ex);
  const { step, max } = params;

  if (params.weight != null) {
    const ladder = [];
    for (let tier = 0; tier < 5; tier++) {
      const weight = params.weight + tier * params.weightStep;
      let amount = startAmt;
      ladder.push({ sets: d.sets, amount: amount, weight: weight });
      while (amount < max && step > 0) {
        amount = Math.min(max, amount + step);
        ladder.push({ sets: d.sets, amount: amount, weight: weight });
      }
    }
    return ladder;
  }

  const maxSets = params.maxSets;
  const ladder = [];
  let sets = d.sets;
  const topSets = Math.max(sets, maxSets);
  while (true) {
    let amount = startAmt;
    ladder.push({ sets: sets, amount: amount });
    while (amount < max && step > 0) {
      amount = Math.min(max, amount + step);
      ladder.push({ sets: sets, amount: amount });
    }
    if (sets >= topSets) break;
    sets += 1;
  }
  return ladder;
}

// Current ladder level for a move (0 = base).
function currentLevel(ex) {
  const ov = state.intensity[ex.name];
  return ov && typeof ov.level === 'number' ? ov.level : 0;
}

/*
 * Effective dose = ladder[level]. Level 0 shows the base dose; any higher level
 * shows a single concrete pair and flags overridden.
 */
function effectiveDose(ex) {
  const d = ex.dose;
  const level = currentLevel(ex);
  // v4.2: when a yellow/red region implicates this move, ease the dose ~20% down the ladder.
  // Reduced doses log automatically (finishSession logs effectiveDose). Base is always the floor.
  const reduced = moveImplicated(ex, (state && state.regionStatus) || {});
  if (!level && !reduced) return { sets: d.sets, amount: d.amount, unit: d.unit, weight: d.weight };
  const ladder = progressionLadder(ex);
  const clamped = clamp(level, 0, ladder.length - 1);
  const useLevel = reduced ? doseCutLevel(ladder, clamped) : clamped;
  const entry = ladder[useLevel];
  const out = { sets: entry.sets, amount: entry.amount, unit: d.unit, weight: entry.weight };
  if (useLevel > 0) out.overridden = true;
  if (reduced) out.reduced = true;
  return out;
}

// "3 × 30 sec" / "3 × 15 reps/side" / "1 × 20 sec/side" / "3 × 8 reps @ 180 lb".
function formatDose(eff) {
  return eff.sets + ' × ' + eff.amount + ' ' + eff.unit +
    (eff.weight != null ? ' @ ' + eff.weight + ' lb' : '');
}
// v4.2: subtle "· eased" tag appended after a reduced (region-implicated) dose line.
function easedTag(eff) {
  return (eff && eff.reduced) ? ' <span class="dose-eased">· eased</span>' : '';
}

// Move up (dir +1 = harder) or down the ladder; level 0 clears the override.
function stepLevel(ex, dir) {
  const ladder = progressionLadder(ex);
  // Clamp the stored level first so a stale out-of-range override (from a
  // routine edit that shortened the ladder) doesn't swallow the first press.
  const cur = clamp(currentLevel(ex), 0, ladder.length - 1);
  const next = clamp(cur + dir, 0, ladder.length - 1);
  if (next <= 0) delete state.intensity[ex.name];
  else state.intensity[ex.name] = { level: next };
  saveState();
  render();
}

function resetOverride(ex) {
  delete state.intensity[ex.name];
  saveState();
  render();
}

/*
 * Rest-clock target seconds (Feature E). Explicit ex.rest wins; else per-block
 * defaults (v3.0): weights/machines 90; floor 90 unless the move's top goal is
 * core (short abs rest, 60); warm-up/cool-down have no timer.
 */
function restTarget(ex, blockKey) {
  if (blockKey === 'warmup' || blockKey === 'cooldown') return null;
  if (typeof ex.rest === 'number') return ex.rest;
  if (blockKey === 'weights' || blockKey === 'machines') return 90;
  if (blockKey === 'floor') return topGoalId(ex) === 'core' ? 60 : 90;
  return null;
}

/* --- 6. Rendering --------------------------------------------------------- */

function render() {
  if (typeof document === 'undefined') return;   // no-op under Node (smoke tests call mutators directly)
  const y = window.scrollY;
  renderTabs();
  const view = document.getElementById('view');
  if (state.view === 'settings') {
    renderedExercises = [];
    view.innerHTML = renderSettings();
    renderHeader(null, 'Settings');
  } else if (state.view === 'daily') {
    view.innerHTML = renderDaily();   // populates renderedExercises
    renderHeader(null, 'Daily');
  } else if (state.view === 'moves') {
    renderedExercises = [];
    view.innerHTML = renderMoves();   // populates renderedMoves
    renderHeader(null, 'Moves');
  } else if (state.view === 'coach') {
    renderedExercises = [];
    view.innerHTML = renderCoach();
    renderHeader(null, 'Coach');
    coachScrollToBottom();
  } else {
    const build = buildFutureSession(state, previewOffset);   // offset 0 = today
    view.innerHTML = renderToday(build);   // populates renderedExercises
    renderHeader(build, inPreview());
  }
  view.classList.toggle('is-preview', state.view === 'today' && inPreview());
  syncRestTicker();
  window.scrollTo(0, y);
}

/* --- Rest clock ticker (Feature E) --------------------------------------- *
 * A single 1s interval that ONLY rewrites the #rest-timer text node — never a
 * full re-render. The element carries data-started / data-target so the tick
 * needs no state lookup; render() starts/stops the interval by presence. */
let restTicker = null;

function tickRest() {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('rest-timer');
  if (!el) { stopRestTicker(); return; }
  const started = +el.dataset.started;
  const target = +el.dataset.target;
  const elapsed = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const done = elapsed >= target;
  el.className = 'rest-clock' + (done ? ' rest-done' : '');
  el.textContent = restClockText(elapsed, target, done);
}

function startRestTicker() { if (!restTicker) restTicker = setInterval(tickRest, 1000); }
function stopRestTicker() { if (restTicker) { clearInterval(restTicker); restTicker = null; } }

function syncRestTicker() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('rest-timer')) startRestTicker();
  else stopRestTicker();
}

// m:ss formatting and the "Rest 0:47 / 1:30" / "Go 1:35 / 1:30" label.
function mmss(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return m + ':' + (s < 10 ? '0' + s : s);
}
function restClockText(elapsed, target, done) {
  return (done ? 'Go ' : 'Rest ') + mmss(elapsed) + ' / ' + mmss(target);
}

function renderHeader(build, subtitleOrPreview) {
  const h = document.getElementById('app-header');
  if (!build) {
    h.innerHTML = '<div class="title">Tumble Trainer</div><div class="sub">' +
      escapeHtml(subtitleOrPreview || 'Settings') + '</div>';
    return;
  }
  // Preview mode: session/day only, no live progress bar (read-only future peek).
  if (subtitleOrPreview === true) {
    h.innerHTML =
      '<div class="title">Tumble Trainer</div>' +
      '<div class="sub">Preview · Session ' + build.session + ' · Day ' + build.day + '</div>';
    return;
  }
  const total = renderedExercises.length;
  const done = renderedExercises.filter((ex) => state.checks[ex.name]).length;
  const pct = total ? (done / total * 100) : 0;
  h.innerHTML =
    '<div class="title">Tumble Trainer</div>' +
    '<div class="sub">Session ' + build.session + ' · Day ' + build.day + '</div>' +
    '<div class="progress"><div class="progress-bar" style="width:' + pct + '%"></div></div>' +
    '<div class="progress-text">' + done + '/' + total + ' done</div>';
}

// v3.1: the day-preview control row at the very top of the Today view.
function renderPreviewBar(build) {
  const off = previewOffset;
  const label = off === 0 ? 'Today'
    : 'Preview — Session ' + build.session + ' · Day ' + build.day;
  return '<div class="preview-bar">' +
    '<button class="btn small ghost prev-day" data-action="prev-day"' +
      (off <= 0 ? ' disabled' : '') + ' aria-label="Previous day">◀</button>' +
    '<span class="preview-label">' + escapeHtml(label) + '</span>' +
    '<button class="btn small ghost next-day" data-action="next-day"' +
      (off >= PREVIEW_MAX ? ' disabled' : '') + ' aria-label="Next day">▶</button>' +
    (off > 0 ? '<button class="btn small back-today" data-action="back-to-today">Back to today</button>' : '') +
    '</div>';
}

function renderTabs() {
  document.getElementById('tabs').innerHTML = TABS.map((t) =>
    '<button class="tab' + (state.view === t.id ? ' active' : '') +
    '" data-action="tab" data-view="' + t.id + '">' + escapeHtml(t.label) + '</button>'
  ).join('');
}

/*
 * v3.4: the Gym tab's collapsible "Adjust session" panel. Default collapsed
 * (ui.adjustOpen, transient/in-memory). Reuses the shared session-tuning controls so
 * it's one source of truth with Settings. Changing any control fires the existing
 * onChange handlers (setting / goal-weight / tag-priority), each of which
 * re-renders — regenerating the visible session live; ui.adjustOpen keeps the panel
 * open across those re-renders.
 */
function renderAdjustPanel() {
  const open = ui.adjustOpen;
  let h = '<section class="adjust-panel' + (open ? ' is-open' : '') + '">';
  h += '<button class="adjust-toggle" data-action="toggle-adjust" aria-expanded="' + (open ? 'true' : 'false') + '">' +
    '<span>Adjust session</span><span class="adjust-caret">' + (open ? '▾' : '▸') + '</span></button>';
  if (open) {
    h += '<div class="adjust-body">' +
      renderSettingSlider('moves', 'Number of moves') +
      renderSettingSlider('cool', 'Cool-down (1 = short, 2 = full)') +
      renderWeeklyClassesField() +
      renderTagPriorityFields() +
      renderSupersetBiasField() +
      '<div class="adjust-goals-head">Goal weights</div>' +
      renderGoalWeightSliders() +
      '</div>';
  }
  return h + '</section>';
}

/*
 * v4.1 (Phase 3): the Gym tab's collapsible "Readiness check-in" panel. Default
 * collapsed (ui.readinessOpen, transient). One segmented row per region + a session
 * intent selector; every tap writes state.readiness/state.sessionIntent, saves, and
 * re-renders — regenerating the visible session live (the same live-regenerate pattern
 * as the Adjust panel). A summary chip on the collapsed header keeps any active filter
 * visible. Copy is non-diagnostic: it filters today's session, it does not assess injury.
 */
// Human-readable list of the CURRENTLY non-default readiness regions (excludes intent).
// Drives the collapsed-header chip and the Coach context line. Reads global state.
function readinessSummary() {
  const r = state.readiness || defaultReadiness();
  const out = [];
  if (r.shins !== 'good') out.push('shins ' + r.shins);
  if (r.knee !== 'good') out.push('knee ' + r.knee);
  if (r.foot !== 'good') out.push('foot ' + r.foot);
  if (r.back !== 'good') out.push('back ' + r.back);
  if (r.arms !== 'good') out.push('arms ' + r.arms);
  if (r.energy !== 'normal') out.push(r.energy + ' energy');
  if (r.classSoon) out.push('class < 24h');
  return out;
}
/* --- v4.2 (Phase 4): 24-hour green/yellow/red feedback loop ---------------- */
// The log entry the "how did that settle?" prompt should ask about, or null. Only ever the
// LAST entry, and only when it is un-answered (no feedback / feedbackSkipped) and ≥12 h old.
// Date.now() here is a UI gate, not the generator — deterministic selection never reads it.
function feedbackPromptEntry() {
  const log = (state && state.log) || [];
  if (!log.length) return null;
  const e = log[log.length - 1];
  if (!e || e.feedback || e.feedbackSkipped || !e.date) return null;
  if (Date.now() - Date.parse(e.date) < FEEDBACK_DELAY_MS) return null;
  return e;
}
// The 24h prompt card. Step 1 = three lights; tapping Yellow/Red opens step 2 = a region row.
function renderFeedbackCard(entry) {
  // A pick only opens the region step for the entry it was made on. If the athlete left the
  // step open, finished ANOTHER session, and this prompt is for the newer entry, the stale
  // pick must not skip its light choice (or it would stamp a judgment they never made).
  const pick = (ui.feedbackFor === entry.session) ? ui.feedbackPick : null;
  const when = 'Day ' + escapeHtml(entry.day || '?') + ' · ' + escapeHtml(new Date(entry.date).toLocaleDateString());
  let h = '<div class="feedback-card">' +
    '<div class="feedback-head">' +
      '<span class="feedback-title">How did that session settle?</span>' +
      '<button class="feedback-x" data-action="feedback-skip" aria-label="Dismiss">✕</button>' +
    '</div>' +
    '<div class="feedback-when">' + when + '</div>';
  if (!pick) {
    h += '<div class="feedback-btns">' +
      '<button class="feedback-btn fb-green" data-action="feedback-light" data-light="green">Felt fine</button>' +
      '<button class="feedback-btn fb-yellow" data-action="feedback-light" data-light="yellow">A bit stirred up</button>' +
      '<button class="feedback-btn fb-red" data-action="feedback-light" data-light="red">Something’s wrong</button>' +
      '</div>';
  } else {
    const regions = [['shins', 'Shins'], ['knee', 'Knee'], ['foot', 'Foot'], ['back', 'Back'], ['arms', 'Arms']];
    h += '<div class="feedback-region-label">Which region?</div>' +
      '<div class="feedback-btns feedback-regions">' + regions.map((rr) =>
        '<button class="feedback-btn fb-' + pick + '" data-action="feedback-region" data-region="' + rr[0] + '">' +
        escapeHtml(rr[1]) + '</button>').join('') + '</div>';
    if (pick === 'red') {
      h += '<p class="muted feedback-note">Red pauses that region’s work until you clear it in Settings. ' +
        'Persistent, worsening, or neurological symptoms → clinician.</p>';
    }
    h += '<div class="row"><button class="btn small ghost" data-action="feedback-cancel">Cancel</button></div>';
  }
  return h + '</div>';
}
// Compact "Settling: …" strip + (when any region red) a clinician notice. Gym tab, live only.
function renderRegionStatusStrip() {
  const rs = state.regionStatus || {};
  const regions = Object.keys(rs);
  if (!regions.length) return '';
  const items = regions.map((r) => {
    const s = rs[r];
    if (s.light === 'red') return '<span class="region-chip region-chip-red">' + escapeHtml(r + ' red — cleared in Settings') + '</span>';
    const n = s.sessionsLeft;
    return '<span class="region-chip region-chip-yellow">' +
      escapeHtml(r + ' yellow · ' + n + ' session' + (n === 1 ? '' : 's') + ' left') + '</span>';
  });
  let h = '<div class="region-strip"><span class="region-strip-label">Settling:</span> ' + items.join(' ') + '</div>';
  if (regions.some((r) => rs[r].light === 'red')) {
    h += '<div class="notice region-notice">Red pauses that region’s work until you clear it in Settings. ' +
      'Persistent, worsening, or neurological symptoms → clinician.</div>';
  }
  return h;
}

// One segmented row: a label + a group of one-tap buttons that set `region` to a level.
function renderSegRow(label, region, current, opts) {
  const btns = opts.map((o) =>
    '<button class="seg-btn' + (current === o.v ? ' is-active' : '') +
    '" data-action="readiness-set" data-region="' + region + '" data-level="' + o.v + '">' +
    escapeHtml(o.label) + '</button>').join('');
  return '<div class="seg-row"><span class="seg-label">' + escapeHtml(label) +
    '</span><span class="seg-btns">' + btns + '</span></div>';
}
function renderReadinessPanel() {
  const open = ui.readinessOpen;
  const r = state.readiness || defaultReadiness();
  const intent = sessionIntent(state);
  const chips = readinessSummary().concat(intent !== 'default' ? [INTENT_LABELS[intent].toLowerCase()] : []);
  let h = '<section class="adjust-panel readiness-panel' + (open ? ' is-open' : '') + '">';
  h += '<button class="adjust-toggle" data-action="toggle-readiness" aria-expanded="' + (open ? 'true' : 'false') + '">' +
    '<span>Readiness check-in' +
    (chips.length ? ' <span class="readiness-chip">' + escapeHtml(chips.join(' · ')) + '</span>' : '') +
    '</span><span class="adjust-caret">' + (open ? '▾' : '▸') + '</span></button>';
  if (open) {
    h += '<div class="adjust-body">';
    const tri = [{ v: 'good', label: 'Good' }, { v: 'caution', label: 'Caution' }, { v: 'stop', label: 'Stop' }];
    h += renderSegRow('Shins', 'shins', r.shins, tri);
    h += renderSegRow('Knee', 'knee', r.knee, tri);
    h += renderSegRow('Foot', 'foot', r.foot, tri);
    h += renderSegRow('Back', 'back', r.back, [{ v: 'good', label: 'Good' }, { v: 'sensitive', label: 'Sensitive' }]);
    h += renderSegRow('Arms', 'arms', r.arms, [{ v: 'good', label: 'Good' }, { v: 'caution', label: 'Caution' }]);
    h += renderSegRow('Energy', 'energy', r.energy, [{ v: 'low', label: 'Low' }, { v: 'normal', label: 'Normal' }, { v: 'high', label: 'High' }]);
    // classSoon: a two-segment No/Yes toggle (data-val 0/1), styled like the rows above.
    h += '<div class="seg-row"><span class="seg-label">Class within 24 h</span><span class="seg-btns">' +
      '<button class="seg-btn' + (!r.classSoon ? ' is-active' : '') + '" data-action="readiness-classsoon" data-val="0">No</button>' +
      '<button class="seg-btn' + (r.classSoon ? ' is-active' : '') + '" data-action="readiness-classsoon" data-val="1">Yes</button>' +
      '</span></div>';
    // Session intent selector (segmented, wraps).
    const intentBtns = SESSION_INTENTS.map((v) =>
      '<button class="seg-btn' + (intent === v ? ' is-active' : '') +
      '" data-action="readiness-intent" data-intent="' + v + '">' + escapeHtml(INTENT_LABELS[v]) + '</button>').join('');
    h += '<div class="seg-row seg-row-intent"><span class="seg-label">Session intent</span>' +
      '<span class="seg-btns">' + intentBtns + '</span></div>';
    h += '<p class="muted readiness-note">Filters today’s session only — it doesn’t assess injuries. ' +
      'Persistent, worsening, or neurological symptoms → clinician.</p>';
    h += '<div class="row"><button class="btn small ghost" data-action="readiness-reset">Reset</button></div>';
    h += '</div>';
  }
  return h + '</section>';
}

/*
 * v3.6: wrap a session block so its title toggles collapse. The <h2> is the tap
 * target (data-action="toggle-block", keyed by the block key) — collapse state
 * lives in state.collapsed, NOT the DOM, so it survives the app's re-render on
 * every check-off. `units` is this block's slice of renderedExercises (one entry
 * per rendered card, incl. warm-up group / superset synthetics), so the collapsed
 * header's done/total count reads the exact same state.checks data the cards do.
 * The count is skipped in preview, where state.checks reflects today, not the peek.
 */
function renderBlock(key, title, inner, units) {
  const collapsed = !!(state.collapsed && state.collapsed[key]);
  let countHtml = '';
  if (!inPreview() && units && units.length) {
    const done = units.filter((u) => u && state.checks[u.name]).length;
    countHtml = ' <span class="block-count">' + done + '/' + units.length + '</span>';
  }
  return '<section class="block' + (collapsed ? ' is-collapsed' : '') + '">' +
    '<h2 class="block-title" data-action="toggle-block" data-block="' + escapeHtml(key) + '">' +
    '<span class="block-chevron" aria-hidden="true"></span>' +
    '<span class="block-name">' + escapeHtml(title) + '</span>' + countHtml + '</h2>' +
    '<div class="block-cards">' + inner + '</div></section>';
}

function renderToday(build) {
  renderedExercises = [];
  const preview = inPreview();
  let html = renderPreviewBar(build);
  // v4.2: the 24h "how did that settle?" prompt sits above everything else — live only, and
  // not while the finish sheet is up. feedbackPromptEntry gates on the ≥12 h delay.
  if (!preview && !ui.finishing) {
    const fbEntry = feedbackPromptEntry();
    if (fbEntry) html += renderFeedbackCard(fbEntry);
  }
  // Suggestions (incl. swap chips) are interactive — hide them while previewing.
  if (!preview) html += renderSuggestions(build);
  // v3.4: collapsible "Adjust session" — the same sliders/toggles as Settings, live in
  // the Gym tab so tuning immediately re-generates the session below. Hidden in preview.
  if (!preview) html += renderAdjustPanel();
  // v4.2: compact region-status strip (+ clinician notice when any region is red), above the
  // readiness panel. Hidden in preview (persistent status still applies to preview generation).
  if (!preview) html += renderRegionStatusStrip();
  // v4.1: collapsible "Readiness check-in" — per-region caution/stop + session intent that
  // hard-filter/tighten today's session. Hidden in preview (previews are neutral by design).
  if (!preview) html += renderReadinessPanel();

  // v3.0 safety note: warn when goal weights leave no scored moves to select.
  const hasMoves = build.blocks.some((bl) =>
    (bl.key === 'floor' || bl.key === 'weights' || bl.key === 'machines') && bl.exercises.length);
  if (!hasMoves) {
    html += '<p class="muted skill-empty">No moves selected — raise a goal weight in Settings.</p>';
  }

  // v2.5: when Auto Superset is on, plan the Floor supersets up front so a grouped
  // move renders once (as a combined card at its group's earliest member) and its
  // other members are skipped.
  const ssMap = state.autoSuperset ? supersetPlan(build) : null;

  build.blocks.forEach((bl) => {
    if (!bl.exercises.length) return;   // skip empty blocks (e.g. machines at count 0)
    const startIdx = renderedExercises.length;   // v3.6: this block's slice, for the collapsed count
    let inner = '';
    if (bl.key === 'warmup') {
      // v2.4.1: collapse the warm-up block's RENDERING to one card per contiguous
      // group (data model is untouched — moves still live individually in the
      // routine). A move with no group renders as its own card, unchanged.
      warmupGroups(bl.exercises).forEach((item) => {
        const idx = renderedExercises.length;
        if (item.kind === 'group') {
          renderedExercises.push(item.card);
          inner += renderWarmupGroupCard(item.card, idx);
        } else {
          renderedExercises.push(item.ex);
          inner += renderCard(item.ex, idx, bl.key);
        }
      });
    } else if (ssMap && bl.key === 'floor') {
      // v2.5: grouped moves collapse into one superset card at the anchor
      // (members[0]); non-anchor members are skipped here (rendered at the
      // anchor's block). Ungrouped moves render as normal individual cards.
      bl.exercises.forEach((ex) => {
        const card = ssMap.get(ex);
        if (card) {
          if (card.members[0].ex !== ex) return;      // already rendered at the anchor
          const idx = renderedExercises.length;
          renderedExercises.push(card);
          inner += renderSupersetCard(card, idx);
        } else {
          const idx = renderedExercises.length;
          renderedExercises.push(ex);
          inner += renderCard(ex, idx, bl.key);
        }
      });
    } else {
      bl.exercises.forEach((ex) => {
        const idx = renderedExercises.length;
        renderedExercises.push(ex);
        inner += renderCard(ex, idx, bl.key);
      });
    }
    if (!inner) return;   // every move here was absorbed into a superset anchored elsewhere
    html += renderBlock(bl.key, bl.title, inner, renderedExercises.slice(startIdx));
  });
  if (!preview) html += renderFinish();   // no finishing a future preview
  return html;
}

/*
 * v2.4.1: fold the warm-up block's moves into render items — one per contiguous
 * run of moves sharing a `group`, plus standalone items for ungrouped moves.
 * Pure; exported for tests. Each group item carries a synthetic `card` object
 * whose stable key is 'warmup:' + group (so state.checks / progress key off the
 * group, not the individual moves) and whose goals are the union of its moves'
 * tags (first-appearance order; first tag drives the card color).
 */
function warmupGroups(exercises) {
  const items = [];
  let cur = null;
  (exercises || []).forEach((ex) => {
    const g = ex && ex.group;
    if (!g) { cur = null; items.push({ kind: 'single', ex: ex }); return; }
    if (cur && cur.groupName === g) { cur.moves.push(ex); return; }
    cur = { kind: 'group', groupName: g, moves: [ex] };
    items.push(cur);
  });
  items.forEach((it) => {
    if (it.kind !== 'group') return;
    const goals = [];
    it.moves.forEach((m) => (m.goals || []).forEach((id) => { if (!goals.includes(id)) goals.push(id); }));
    it.card = { name: 'warmup:' + it.groupName, isWarmupGroup: true, groupName: it.groupName, moves: it.moves, goals: goals };
  });
  return items;
}

// One card for a whole warm-up group: union chips, group name as the title, a
// compact "Name — dose[, tempoNote]" line per move, and a single group checkbox.
// No steppers/set-circles (warm-up has no progression UI); no expand affordance.
function renderWarmupGroupCard(card, idx) {
  const preview = inPreview();
  const goals = card.goals.length ? card.goals : ['recovery'];
  const mainColor = goalColor(goals[0]);
  const done = !preview && !!state.checks[card.name];
  const chips = goals.map((id, i) =>
    '<span class="' + (i === 0 ? 'tag' : 'chip') + ' c-' + escapeHtml(goalColor(id)) + '">' +
      escapeHtml(goalName(id)) + '</span>').join('');
  const list = card.moves.map((m) => {
    const tempo = (m.dose && m.dose.tempoNote) ? ', ' + escapeHtml(m.dose.tempoNote) : '';
    return '<li class="wu-move">' + escapeHtml(m.name) + ' — ' +
      escapeHtml(formatDose(effectiveDose(m))) + tempo + '</li>';
  }).join('');
  const check = preview ? '' :
    '<input type="checkbox" class="check" data-action="check" data-idx="' + idx + '"' +
      (done ? ' checked' : '') + ' aria-label="Mark ' + escapeHtml(card.groupName) + ' done">';

  return '' +
    '<div class="card cat-' + escapeHtml(mainColor) + (done ? ' is-done' : '') + '">' +
      '<div class="card-main">' +
        '<div class="card-body">' +
          '<div class="chips">' + chips + '</div>' +
          '<div class="card-name">' + escapeHtml(card.groupName) + '</div>' +
          '<ul class="wu-list">' + list + '</ul>' +
        '</div>' +
        check +
      '</div>' +
    '</div>';
}

/* --- v2.5 Auto Superset -------------------------------------------------- *
 * Group same-location Floor moves into one combined "superset" card so they're
 * trained as alternating rounds. Toggle: state.autoSuperset (default ON; when off
 * the Today view renders every move as its own card, unchanged). Only Floor moves
 * that carry a `muscle` ever qualify — weights, machines, warm-up and cool-down
 * moves have no `muscle` and never superset.
 */

/*
 * Greedy grouping (pure; exported for tests). `members` is an ordered list of
 * { ex, block } — Floor moves in session order, pre-filtered to those with a
 * `muscle`. Within a group, all enforced:
 *   - every member shares the same `location` (defaults to "floor"),
 *   - no two members share the same `muscle`,
 *   - at most one member carries `largeEquipment`.
 * Each move joins the FIRST existing group it doesn't conflict with, else starts
 * a new group. No size cap (giant sets allowed). Size-1 groups are returned too;
 * the caller renders those as normal individual cards.
 */
function groupSupersets(members) {
  const groups = [];
  (members || []).forEach((m) => {
    if (!m || !m.ex || !m.ex.muscle) return;
    const loc = m.ex.location || 'floor';
    let target = null;
    for (let gi = 0; gi < groups.length; gi++) {
      const g = groups[gi];
      if (g.location !== loc) continue;
      // v4.0 (Phase 2): the candidate must be pair-compatible with EVERY existing member
      // (supersetPairOk folds in the old muscle-clash + location rules plus family / fatigue
      // / quality-sensitive / arm-support / impact incompatibilities).
      if (!g.members.every((x) => supersetPairOk(x.ex, m.ex))) continue;
      const large = g.members.filter((x) => x.ex.largeEquipment).length + (m.ex.largeEquipment ? 1 : 0);
      if (large > 1) continue;                                                   // >1 large equipment
      target = g; break;
    }
    if (target) target.members.push(m);
    else groups.push({ location: loc, members: [m] });
  });
  return groups;
}

/*
 * v3.5 superset-bias predicate (pure; exported for tests). Would adding `cand` (a
 * greedy pick { move, i }) to the already-chosen picks `entries` ({ move, i }) place
 * it in a superset group of >= 2? v4.0: mirrors render-time grouping exactly — the chosen
 * floor+muscle moves plus the candidate are pool-ordered (matching selectMoves' returned
 * order) and then phase-ordered with orderByPhase (the order the Floor block renders) before
 * groupSupersets; true iff the candidate's resulting group has >= 2 members. Non-Floor /
 * muscle-less candidates never pair (return false). Pure given (entries, cand, routine).
 */
function wouldSuperset(entries, cand, routine) {
  if (!cand || !cand.move || (cand.move.section || 'floor') !== 'floor' || !cand.move.muscle) return false;
  const poolOrdered = (entries || [])
    .filter((o) => o && o.move && (o.move.section || 'floor') === 'floor' && o.move.muscle)
    .concat([cand])
    .sort((a, b) => a.i - b.i)
    .map((o) => o.move);
  const floor = orderByPhase(routine, poolOrdered).map((ex) => ({ ex: ex, block: 'floor' }));
  const groups = groupSupersets(floor);
  for (let gi = 0; gi < groups.length; gi++) {
    if (groups[gi].members.some((m) => m.ex === cand.move)) return groups[gi].members.length >= 2;
  }
  return false;
}

/*
 * Render plan for the Floor block when Auto Superset is on. Returns a Map from
 * each grouped exercise OBJECT to its superset card, ONLY for groups of size >= 2
 * (size-1 groups are omitted so those moves render as normal cards). The card
 * carries a stable synthetic `name` (state.checks / progress / the single global
 * rest clock all key off it), its ordered members with their block (needed for
 * restTarget), the union of member goal chips, and a Superset/Giant-set label.
 * The card renders once, at its earliest member (members[0], the anchor).
 */
function supersetPlan(build) {
  const members = [];
  (build.blocks || []).forEach((bl) => {
    if (bl.key !== 'floor') return;
    bl.exercises.forEach((ex) => {
      if (ex && ex.muscle) members.push({ ex: ex, block: bl.key });
    });
  });
  const map = new Map();
  groupSupersets(members).forEach((g) => {
    if (g.members.length < 2) return;
    const moves = g.members.map((m) => m.ex);
    const goals = [];
    moves.forEach((ex) => cardGoalIds(ex).forEach((id) => { if (!goals.includes(id)) goals.push(id); }));
    const card = {
      name: 'superset:' + moves.map((ex) => ex.name).join('|'),
      isSuperset: true,
      location: g.location,
      members: g.members,                                   // [{ ex, block }] ordered; anchor = members[0]
      moves: moves,
      goals: goals,
      label: moves.length >= 3 ? 'Giant set' : 'Superset'
    };
    g.members.forEach((m) => map.set(m.ex, card));
  });
  return map;
}

// Max of the members' individual rest targets (each in its own block's terms).
// null if none of the members carry a rest target.
function supersetRestTarget(card) {
  let max = null;
  card.members.forEach((m) => {
    const t = restTarget(m.ex, m.block);
    if (typeof t === 'number' && (max == null || t > max)) max = t;
  });
  return max;
}

// Rounds for a superset card = the most sets any member does (members may differ,
// e.g. a 2× move paired with two 3× moves). One round taps every member once.
function supersetRounds(card) {
  let max = 0;
  card.moves.forEach((ex) => { const s = effectiveDose(ex).sets; if (s > max) max = s; });
  return max;
}

// Live rest clock owned by a superset card (mirrors renderRestClock). The single
// global rest clock is aimed at the card's synthetic name on each round tap.
function renderSupersetRestClock(card) {
  if (inPreview()) return '';                // read-only preview: no rest timer
  const r = state.rest;
  if (!r || r.name !== card.name || !r.startedAt) return '';
  if ((state.setsDone[card.name] || 0) >= supersetRounds(card)) return '';   // hide once all rounds done
  const target = supersetRestTarget(card);
  if (target == null) return '';
  const elapsed = Math.max(0, Math.floor((Date.now() - r.startedAt) / 1000));
  const done = elapsed >= target;
  return '<div class="rest-clock' + (done ? ' rest-done' : '') + '" id="rest-timer" ' +
    'data-started="' + r.startedAt + '" data-target="' + target + '">' +
    escapeHtml(restClockText(elapsed, target, done)) + '</div>';
}

// One combined card for a superset group (mirrors renderWarmupGroupCard): union
// chips, a Superset/Giant-set label, one "Name — dose" row per member (each
// carries its own per-move progression via effectiveDose), an alternate-rounds
// hint, and a single group check-off. No steppers/set-circles (like warm-up).
function renderSupersetCard(card, idx) {
  const preview = inPreview();
  const goals = card.goals.length ? card.goals : ['gym'];
  const mainColor = goalColor(goals[0]);
  const done = !preview && !!state.checks[card.name];
  const expanded = !preview && ui.expanded.has(card.name);
  const chips = goals.map((id, i) =>
    '<span class="' + (i === 0 ? 'tag' : 'chip') + ' c-' + escapeHtml(goalColor(id)) + '">' +
      escapeHtml(goalName(id)) + '</span>').join('');
  const rows = card.moves.map((ex) => {
    const over = currentLevel(ex) > 0;
    const meff = effectiveDose(ex);
    return '<li class="ss-move">' +
      '<span class="ss-move-name">' + escapeHtml(ex.name) +
        (over ? ' <span class="mod">modified</span>' : '') + '</span>' +
      '<span class="ss-move-dose">' + escapeHtml(formatDose(meff)) + easedTag(meff) + '</span>' +
      '</li>';
  }).join('');
  const mainAttrs = preview ? '' : ' data-action="expand" data-idx="' + idx + '"';
  const check = preview ? '' :
    '<input type="checkbox" class="check" data-action="check" data-idx="' + idx + '"' +
      (done ? ' checked' : '') + ' aria-label="Mark ' + escapeHtml(card.label) + ' done">';

  return '' +
    '<div class="card ss-card cat-' + escapeHtml(mainColor) +
      (done ? ' is-done' : '') + (expanded ? ' is-open' : '') + '">' +
      '<div class="card-main"' + mainAttrs + '>' +
        '<div class="card-body">' +
          '<div class="chips">' + chips + '</div>' +
          '<div class="card-name"><span class="ss-label">' + escapeHtml(card.label) + '</span></div>' +
          '<ul class="ss-list">' + rows + '</ul>' +
          '<div class="ss-hint">Alternate moves, rest after each round</div>' +
          renderRoundDots(card, idx) +
          renderSupersetRestClock(card) +
        '</div>' +
        check +
      '</div>' +
      (expanded ? renderSupersetProgression(card, idx) : '') +
    '</div>';
}

// Whole-superset round dots (mirror renderSetCircles): one tappable dot per round,
// filled up to the card's round counter (state.setsDone[card.name]).
function renderRoundDots(card, idx) {
  if (inPreview()) return '';               // read-only preview: no set/round tracking
  const total = supersetRounds(card);
  if (total < 1) return '';
  const done = state.setsDone[card.name] || 0;
  let dots = '';
  for (let k = 0; k < total; k++) {
    dots += '<button class="set-dot' + (k < done ? ' filled' : '') + '" ' +
      'data-action="round-done" data-idx="' + idx + '" data-round="' + k + '" ' +
      'aria-label="Round ' + (k + 1) + '"></button>';
  }
  return '<div class="sets-row">' + dots + '</div>';
}

// Per-member progression controls, shown when the superset card is expanded.
// Reuses renderProgression (with a member index so the shared prog/reset handlers
// resolve the member off the card), one indented block per member.
function renderSupersetProgression(card, idx) {
  return '<div class="ss-prog">' + card.members.map((m, i) =>
    '<div class="ss-prog-move">' +
      '<div class="ss-prog-name">' + escapeHtml(m.ex.name) + '</div>' +
      renderProgression(m.ex, idx, i) +
    '</div>').join('') + '</div>';
}

function renderCard(ex, idx, blockKey) {
  const preview = inPreview();
  const eff = effectiveDose(ex);
  const goals = cardGoalIds(ex);
  const mainColor = goalColor(goals[0]);
  const done = !preview && !!state.checks[ex.name];
  const overridden = currentLevel(ex) > 0;
  const expanded = !preview && ui.expanded.has(ex.name);
  const showProg = expanded && blockKey !== 'warmup' && blockKey !== 'cooldown' && blockKey !== 'daily';

  const chips = goals.map((id, i) =>
    '<span class="' + (i === 0 ? 'tag' : 'chip') + ' c-' + escapeHtml(goalColor(id)) + '">' +
      escapeHtml(goalName(id)) + '</span>').join('');
  const mainAttrs = preview ? '' : ' data-action="expand" data-idx="' + idx + '"';
  const check = preview ? '' :
    '<input type="checkbox" class="check" data-action="check" data-idx="' + idx + '"' +
      (done ? ' checked' : '') + ' aria-label="Mark done">';

  return '' +
    '<div class="card cat-' + escapeHtml(mainColor) +
      (done ? ' is-done' : '') + (expanded ? ' is-open' : '') + '">' +
      '<div class="card-main"' + mainAttrs + '>' +
        '<div class="card-body">' +
          '<div class="chips">' + chips + '</div>' +
          '<div class="card-name">' + escapeHtml(ex.name) +
            (overridden ? ' <span class="mod">modified</span>' : '') + '</div>' +
          '<div class="dose">' + escapeHtml(formatDose(eff)) + easedTag(eff) + '</div>' +
          renderSetCircles(ex, idx, blockKey, eff) +
          renderRestClock(ex, blockKey, eff) +
        '</div>' +
        check +
      '</div>' +
      (showProg ? renderProgression(ex, idx) : '') +
    '</div>';
}

// Per-set tracking circles (Feature E). Warm-up shows them only for multi-set
// moves (e.g. the slow-eccentric calf raise); single-set warm-ups just check.
function renderSetCircles(ex, idx, blockKey, eff) {
  if (inPreview()) return '';               // read-only preview: no set tracking
  const total = eff.sets;
  if (blockKey === 'warmup' && total <= 1) return '';
  if (total < 1) return '';
  const done = state.setsDone[ex.name] || 0;
  let dots = '';
  for (let k = 0; k < total; k++) {
    dots += '<button class="set-dot' + (k < done ? ' filled' : '') + '" ' +
      'data-action="set-done" data-idx="' + idx + '" data-set="' + k + '" ' +
      'data-block="' + escapeHtml(blockKey) + '" aria-label="Set ' + (k + 1) + '"></button>';
  }
  return '<div class="sets-row">' + dots + '</div>';
}

// Live rest clock — only on the card that owns the active global rest timer.
function renderRestClock(ex, blockKey, eff) {
  if (inPreview()) return '';                // read-only preview: no rest timer
  const r = state.rest;
  if (!r || r.name !== ex.name || !r.startedAt) return '';
  if ((state.setsDone[ex.name] || 0) >= eff.sets) return '';
  const target = restTarget(ex, blockKey);
  if (target == null) return '';
  const elapsed = Math.max(0, Math.floor((Date.now() - r.startedAt) / 1000));
  const done = elapsed >= target;
  return '<div class="rest-clock' + (done ? ' rest-done' : '') + '" id="rest-timer" ' +
    'data-started="' + r.startedAt + '" data-target="' + target + '">' +
    escapeHtml(restClockText(elapsed, target, done)) + '</div>';
}

// Progression ladder controls (Feature D) — behind expand, hidden for warmup/cooldown.
function renderProgression(ex, idx, memberIdx) {
  const ladder = progressionLadder(ex);
  const level = clamp(currentLevel(ex), 0, ladder.length - 1);
  const atTop = level >= ladder.length - 1;
  const atBottom = level <= 0;
  // v4.2: suppress the ready-pip (not the manual ▲ button) while a yellow/red region eases this move.
  const ready = !moveImplicated(ex, state.regionStatus || {}) && progressionReady(ex.name, effectiveDose(ex), state.log || []);
  const upReady = ready && !atTop;
  // On a superset card the buttons carry the member index so the shared prog/reset
  // handlers resolve the member off the card (members aren't in renderedExercises).
  const mAttr = memberIdx != null ? ' data-member="' + memberIdx + '"' : '';

  let h = '<div class="progression">';
  h += '<div class="prog-controls">';
  h += '<button class="btn small prog-btn" data-action="prog" data-idx="' + idx + '"' + mAttr + ' data-dir="-1"' +
    (atBottom ? ' disabled' : '') + '>▼ Easier</button>';
  h += '<button class="btn small prog-btn prog-up' + (upReady ? ' ready' : '') + '" ' +
    'data-action="prog" data-idx="' + idx + '"' + mAttr + ' data-dir="1"' + (atTop ? ' disabled' : '') + '>' +
    '▲ Progress' + (upReady ? '<span class="ready-pip" title="Completed 4+ times at this intensity"></span>' : '') +
    '</button>';
  if (!atBottom) h += '<button class="btn small ghost reset" data-action="reset" data-idx="' + idx + '"' + mAttr + '>Reset</button>';
  h += '</div>';
  // For weighted moves, echo the effective dose so weight bumps are visible as
  // you step (non-weighted keeps the plain "Step X of Y" position line).
  const weighted = ex.dose && typeof ex.dose.weight === 'number';
  h += '<div class="prog-pos">' + (atTop
    ? 'Ladder complete — ask Coach for the next move'
    : 'Step ' + (level + 1) + ' of ' + ladder.length +
      (weighted ? ' · ' + escapeHtml(formatDose(effectiveDose(ex))) : '')) + '</div>';
  return h + '</div>';
}

// Render the suggestion banners (Phase 4) at the very top of the Today view.
function renderSuggestions(build) {
  renderedSuggestions = computeSuggestions(state, build);
  if (!renderedSuggestions.length) return '';
  return '<div class="suggests">' + renderedSuggestions.map((s, i) =>
    '<div class="suggest suggest-' + escapeHtml(s.kind) + '">' +
      '<div class="suggest-text">' + escapeHtml(s.text) + '</div>' +
      '<div class="suggest-actions">' +
        '<button class="btn small ghost" data-action="suggest-dismiss" data-sidx="' + i + '">Dismiss</button>' +
        '<button class="btn small primary" data-action="suggest-apply" data-sidx="' + i + '">' + escapeHtml(s.applyLabel) + '</button>' +
      '</div>' +
    '</div>'
  ).join('') + '</div>';
}

function renderFinish() {
  if (ui.finishing) {
    return '<div class="finish-panel">' +
      '<label for="note">Session note (optional)</label>' +
      '<textarea id="note" placeholder="e.g. elbow felt off"></textarea>' +
      '<div class="row">' +
        '<button class="btn ghost" data-action="cancel-finish">Cancel</button>' +
        '<button class="btn primary" data-action="confirm-finish">Confirm finish</button>' +
      '</div></div>';
  }
  return '<button class="btn primary big" data-action="finish">Finish session</button>';
}

/*
 * The "Daily" tab: the static warm-up and cool-down (reusing the Gym view's grouped
 * warm-up card + cool-down rendering and check-off) plus the daily Tuck jumps stim
 * after the warm-up. Shares state.checks with the Gym view for the same warm-up /
 * cool-down items, so a daily item stays checked across both tabs.
 */
function renderDaily() {
  renderedExercises = [];
  const b = (state.routine && state.routine.blocks) || {};
  let html = '';

  // Warm-up — same grouped-card rendering / check-off as the Gym view.
  const warmup = (b.warmup || []);
  if (warmup.length) {
    const startIdx = renderedExercises.length;
    let inner = '';
    warmupGroups(warmup).forEach((item) => {
      const idx = renderedExercises.length;
      if (item.kind === 'group') {
        renderedExercises.push(item.card);
        inner += renderWarmupGroupCard(item.card, idx);
      } else {
        renderedExercises.push(item.ex);
        inner += renderCard(item.ex, idx, 'warmup');
      }
    });
    html += renderBlock('warmup', 'Warm-up', inner, renderedExercises.slice(startIdx));
  }

  // Tuck jumps — the daily jumping stim, placed right after the warm-up.
  {
    const idx = renderedExercises.length;
    renderedExercises.push(DAILY_TUCK_JUMPS);
    html += renderBlock('daily', 'Jumps', renderCard(DAILY_TUCK_JUMPS, idx, 'daily'),
      renderedExercises.slice(idx));
  }

  // Cool-down — full list, same rendering / check-off as the Gym view.
  const cooldown = (b.cooldown || []);
  if (cooldown.length) {
    const startIdx = renderedExercises.length;
    let inner = '';
    cooldown.forEach((ex) => {
      const idx = renderedExercises.length;
      renderedExercises.push(ex);
      inner += renderCard(ex, idx, 'cooldown');
    });
    html += renderBlock('cooldown', 'Cool-down', inner, renderedExercises.slice(startIdx));
  }

  return html;
}

/* --- Move viewer (browse / add / delete the generator's move pool) -------- */

// The full pool of selectable moves, grouped by section, each with its 0–10 goal
// scores; plus an add-move form. Deleting tombstones the move (see deleteMove) so a
// seed migration can't resurrect it; adding pushes straight into routine.blocks.moves.
function renderMoves() {
  renderedMoves = [];
  const training = (state.routine.goals || []).filter((g) => g && g.kind === 'training');
  const moves = (state.routine.blocks && state.routine.blocks.moves) || [];
  let html = '<div class="moves-viewer">';

  html += '<section class="panel"><h3>Moves (' + moves.length + ')</h3>' +
    '<p class="muted">Everything the session generator can pick from, with its 0–10 goal scores. ' +
    'Delete removes a move for good (it won\'t come back on updates); Add creates a new one.</p>';
  MOVE_SECTIONS.forEach((sec) => {
    const inSec = moves.filter((m) => (m.section || 'floor') === sec.key);
    if (!inSec.length) return;
    html += '<h4 class="mv-sec">' + escapeHtml(sec.title) + '</h4>';
    inSec.forEach((m) => {
      const idx = renderedMoves.length;
      renderedMoves.push(m);
      html += renderMoveRow(m, idx, training);
    });
  });
  if (!moves.length) html += '<p class="muted">No moves yet — add one below.</p>';
  html += '</section>';

  html += renderAddMoveForm(training);
  return html + '</div>';
}

function renderMoveRow(m, idx, training) {
  const gs = m.goalScores || {};
  const scoreChips = training.filter((g) => gs[g.id] > 0)
    .sort((a, b) => gs[b.id] - gs[a.id])
    .map((g) => '<span class="mv-score c-' + escapeHtml(g.colorId || 'gray') + '">' +
      escapeHtml(g.name) + ' ' + gs[g.id] + '</span>').join(' ');
  const careChips = (m.care || []).map((id) =>
    '<span class="chip c-' + escapeHtml(goalColor(id)) + '">' + escapeHtml(goalName(id)) + '</span>').join(' ');
  const meta = [escapeHtml(formatDose(m.dose || { sets: 0, amount: 0, unit: '' }))];
  // v4.0 (Phase 1): show the move's functional family as a subtle muted chip.
  if (m.family) {
    const fam = familyById(m.family);
    meta.push('<span class="mv-family">' + escapeHtml(fam ? fam.name : m.family) + '</span>');
  }
  if (m.muscle) meta.push('muscle: ' + escapeHtml(m.muscle));
  // v3.7: show the move's tags (auto day tags and priority-1 tags both matter to
  // generation; the tag's own name explains what it is).
  (m.tags || []).forEach((id) => {
    const t = tagById(id);
    meta.push('<span class="mv-tag">' + escapeHtml(t ? t.name : id) + '</span>');
  });
  const disabled = !!m.disabled;
  return '<div class="mv-row' + (disabled ? ' mv-row-disabled' : '') + '">' +
    '<div class="mv-row-head">' +
      '<span class="mv-name">' + escapeHtml(m.name) +
        (disabled ? ' <span class="mv-off">disabled</span>' : '') + '</span>' +
      '<div class="mv-row-actions">' +
        '<label class="mv-enable" title="Include this move in generated sessions">' +
          '<input type="checkbox" data-action="mv-toggle" data-idx="' + idx + '"' +
            (disabled ? '' : ' checked') + ' aria-label="Enable ' + escapeHtml(m.name) + '">' +
          '<span>' + (disabled ? 'Off' : 'On') + '</span></label>' +
        '<button class="btn small danger" data-action="mv-delete" data-idx="' + idx + '">Delete</button>' +
      '</div>' +
    '</div>' +
    '<div class="mv-meta">' + meta.join(' · ') + '</div>' +
    (scoreChips ? '<div class="mv-scores">' + scoreChips + '</div>' : '') +
    (careChips ? '<div class="mv-scores">' + careChips + '</div>' : '') +
    (m.why ? '<div class="mv-why">' + escapeHtml(m.why) + '</div>' : '') +
    '</div>';
}

function renderAddMoveForm(training) {
  let h = '<section class="panel add-move"><h3>Add a move</h3>';
  h += '<div class="field"><label for="mv-name">Name</label>' +
    '<input type="text" id="mv-name" placeholder="e.g. Pike push-up"></div>';
  h += '<div class="row wrap">' +
    '<div class="field"><label for="mv-section">Section</label><select id="mv-section">' +
      MOVE_SECTIONS.map((s) => '<option value="' + s.key + '">' + escapeHtml(s.title) + '</option>').join('') +
      '</select></div>' +
    '</div>';
  h += '<div class="row wrap">' +
    '<div class="field"><label for="mv-sets">Sets</label><input type="number" id="mv-sets" min="1" max="6" step="1" value="3"></div>' +
    '<div class="field"><label for="mv-amount">Amount</label><input type="number" id="mv-amount" min="1" step="1" value="10"></div>' +
    '<div class="field"><label for="mv-unit">Unit</label><select id="mv-unit">' +
      UNITS.map((u) => '<option value="' + escapeHtml(u) + '">' + escapeHtml(u) + '</option>').join('') + '</select></div>' +
    '<div class="field"><label for="mv-weight">Weight lb</label><input type="number" id="mv-weight" min="0" step="1" placeholder="—"></div>' +
    '</div>';
  h += '<div class="row wrap">' +
    '<div class="field"><label for="mv-muscle">Muscle (Floor supersets)</label><input type="text" id="mv-muscle" placeholder="optional, e.g. core"></div>' +
    '<div class="field"><label for="mv-why">Why</label><input type="text" id="mv-why" placeholder="optional purpose"></div>' +
    '</div>';
  // v3.7: tag chips — every routine tag (including the auto Day A/B tags) is a toggle on
  // the new move. Plus a "new tag" affordance: typing a name adds a tag to the routine
  // (id slugified, collision-safe) and gives it a settings slider at 3.
  const tags = (state.routine && state.routine.tags) || [];
  h += '<div class="field"><label>Tags</label><div class="mv-tags">' +
    (tags.length ? tags.map((t) =>
      '<label class="mv-tag-chip"><input type="checkbox" data-mv-tag="' + escapeHtml(t.id) + '"> ' +
        escapeHtml(t.name) + '</label>').join('')
      : '<span class="muted">No tags yet.</span>') +
    '</div>' +
    '<div class="row"><input type="text" id="mv-new-tag" placeholder="New tag name"> ' +
      '<button class="btn small" data-action="mv-add-tag">Add tag</button></div>' +
    '</div>';
  h += '<div class="field"><label>Goal scores (0–10)</label><div class="mv-goal-scores">' +
    training.map((g) =>
      '<div class="mv-goal-field"><span class="chip c-' + escapeHtml(g.colorId || 'gray') + '">' +
        escapeHtml(g.name) + '</span>' +
        '<input type="number" id="mv-score-' + escapeHtml(g.id) + '" min="0" max="10" step="1" value="0">' +
      '</div>').join('') +
    '</div></div>';
  h += '<div id="mv-errors" class="errors"></div>';
  h += '<div class="row"><button class="btn primary" data-action="mv-add">Add move</button></div>';
  return h + '</section>';
}

// v3.4: enable/disable a move without deleting it. A disabled move stays listed in
// the Moves tab (dimmed) but is excluded from the generator pool (see selectMoves).
// Stored as `disabled: true` on the move (the flag is omitted when enabled). `m` is a
// live reference into state.routine.blocks.moves, so mutating it persists.
function toggleMoveDisabled(i) {
  const m = renderedMoves[i];
  if (!m) return;
  if (m.disabled) delete m.disabled;
  else m.disabled = true;
  saveState();
  render();
}

// Delete (with confirm) + tombstone so no future seed migration brings it back.
function deleteMove(i) {
  const m = renderedMoves[i];
  if (!m) return;
  if (typeof confirm === 'function' &&
      !confirm('Delete "' + m.name + '"? It won\'t come back on future updates.')) return;
  const moves = (state.routine.blocks && state.routine.blocks.moves) || [];
  const at = moves.indexOf(m);
  if (at !== -1) moves.splice(at, 1);
  state.deletedMoves = state.deletedMoves || [];
  if (m.name && state.deletedMoves.indexOf(m.name) === -1) state.deletedMoves.push(m.name);
  // Drop any per-move session state so a stale key can't linger.
  delete state.intensity[m.name];
  delete state.checks[m.name];
  delete state.setsDone[m.name];
  if (ui.expanded.has(m.name)) ui.expanded.delete(m.name);
  saveState();
  render();
}

// Build a move from the add form, validate the whole routine with it, then persist.
function addMove() {
  if (typeof document === 'undefined') return;
  const g = (id) => document.getElementById(id);
  const errBox = g('mv-errors');
  const showErr = (msgs) => { if (errBox) { errBox.innerHTML = msgs.map(escapeHtml).join('<br>'); errBox.classList.add('show'); } };

  const name = ((g('mv-name') && g('mv-name').value) || '').trim();
  if (!name) { showErr(['Give the move a name.']); return; }

  const move = {
    name: name,
    section: g('mv-section').value,
    dose: { sets: Math.round(+g('mv-sets').value), amount: +g('mv-amount').value, unit: g('mv-unit').value },
    goalScores: {},
    why: ((g('mv-why') && g('mv-why').value) || '').trim() || 'Added in the Move viewer'
  };
  const w = parseFloat(g('mv-weight').value);
  if (!isNaN(w) && w > 0) move.dose.weight = w;
  const muscle = ((g('mv-muscle') && g('mv-muscle').value) || '').trim();
  if (muscle) move.muscle = muscle;
  // v3.7: collect the checked tag chips into the move's `tags` array.
  const tags = [];
  if (typeof document.querySelectorAll === 'function') {
    document.querySelectorAll('[data-mv-tag]').forEach((cb) => {
      if (cb.checked) tags.push(cb.getAttribute('data-mv-tag'));
    });
  }
  if (tags.length) move.tags = tags;

  (state.routine.goals || []).filter((x) => x && x.kind === 'training').forEach((gg) => {
    const el = g('mv-score-' + gg.id);
    const v = el ? Math.round(+el.value) : 0;
    if (v > 0) move.goalScores[gg.id] = clamp(v, 0, 10);
  });

  const trial = deepClone(state.routine);
  trial.blocks.moves = (trial.blocks.moves || []).concat([move]);
  const v = validateRoutine(trial);
  if (!v.valid) { showErr(v.errors); return; }

  state.routine.blocks = state.routine.blocks || {};
  state.routine.blocks.moves = state.routine.blocks.moves || [];
  state.routine.blocks.moves.push(move);
  // If this name was previously tombstoned, adding it back un-tombstones it.
  state.deletedMoves = (state.deletedMoves || []).filter((n) => n !== name);
  saveState();
  render();
}

// v3.7: slugify a free-text tag name into a lowercase-hyphen id.
function slugify(name) {
  return String(name == null ? '' : name).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Collision-safe tag id: append -2, -3, … if the base is already taken. Pure.
function uniqueTagId(base, tags) {
  const ids = new Set((tags || []).map((t) => t && t.id));
  base = base || 'tag';
  if (!ids.has(base)) return base;
  let n = 2;
  while (ids.has(base + '-' + n)) n++;
  return base + '-' + n;
}

// v3.7: create a routine tag from the "new tag" field, give it a settings slider at 3,
// and re-render so it appears as a move chip. (Re-render clears the add-move form — an
// accepted trade-off for adding a tag mid-edit.)
function addTag() {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('mv-new-tag');
  const name = ((el && el.value) || '').trim();
  if (!name) return;
  state.routine.tags = state.routine.tags || [];
  const id = uniqueTagId(slugify(name), state.routine.tags);
  if (!id) return;
  state.routine.tags.push({ id: id, name: name });
  state.settings.tagPriority = state.settings.tagPriority || {};
  state.settings.tagPriority[id] = 3;
  saveState();
  render();
}

/* --- Shared session-tuning controls (rendered in Settings AND the Gym tab) --
 * v3.4: one source of truth for the moves/cool sliders, the training-goal weight
 * sliders, and the joint-friendly + auto-superset toggles. Settings composes them
 * into its panels; the Gym tab's collapsible "Adjust session" panel reuses the same
 * markup so both stay in sync. All read live state and carry the same data-action
 * hooks, so onChange's existing handlers re-generate the session either place. */

// One session slider (moves / cool). Range comes from routine.structure.sliders.
function renderSettingSlider(key, label) {
  const ranges = (state.routine.structure && state.routine.structure.sliders) || DEFAULT_RANGES;
  const [lo, hi] = ranges[key] || DEFAULT_RANGES[key];
  const val = clamp(state.settings[key], lo, hi);
  return '<div class="field">' +
    '<label>' + escapeHtml(label) + ' <span class="val">' + val + '</span></label>' +
    '<input type="range" data-action="setting" data-key="' + escapeHtml(key) + '" min="' + lo + '" max="' + hi + '" step="1" value="' + val + '">' +
    '</div>';
}

// A 0–10 weight slider per TRAINING goal (0 = off).
function renderGoalWeightSliders() {
  const training = (state.routine.goals || []).filter((g) => g && g.kind === 'training');
  return training.map((g) => {
    const w = clamp(typeof g.weight === 'number' ? g.weight : 0, 0, 10);
    return '<div class="field">' +
      '<label>' +
        '<span class="chip c-' + escapeHtml(g.colorId || 'gray') + '">' + escapeHtml(g.name) + '</span> ' +
        '<span class="val">' + w + '</span></label>' +
      '<input type="range" data-action="goal-weight" data-goal="' + escapeHtml(g.id) + '" ' +
        'min="0" max="10" step="1" value="' + w + '">' +
    '</div>';
  }).join('');
}

// v3.7: one 1–5 priority slider per non-auto routine tag (auto "day" tags get none).
// 1 hard-avoids the move, 3 is neutral, 5 boosts it — the label shows the current
// level's meaning. data-tag carries the tag id to the shared onChange handler.
function renderTagPriorityFields() {
  const tags = ((state.routine && state.routine.tags) || []).filter((t) => t && t.id && !t.auto);
  if (!tags.length) return '';
  return tags.map((t) => {
    const raw = state.settings.tagPriority && state.settings.tagPriority[t.id];
    const val = clamp(typeof raw === 'number' ? raw : 3, 1, 5);
    return '<div class="field">' +
      '<label>' + escapeHtml(t.name) +
        ' <span class="val">' + escapeHtml(TAG_LEVEL_LABEL[val] || String(val)) + '</span></label>' +
      '<input type="range" data-action="tag-priority" data-tag="' + escapeHtml(t.id) + '" ' +
        'min="1" max="5" step="1" value="' + val + '">' +
    '</div>';
  }).join('');
}

// Auto-superset toggle.
function renderAutoSupersetField() {
  return '<div class="field toggle">' +
    '<label for="auto-superset">Auto superset</label>' +
    '<input type="checkbox" id="auto-superset" data-action="toggle-superset"' +
      (state.autoSuperset ? ' checked' : '') + '>' +
    '</div>';
}

// Superset-bias slider (v3.5; range widened to 0–30 in v3.7): higher = the generator
// prefers moves that pair into supersets (applies only while Auto superset is on). Range
// is hard-coded 0–30 — NOT sourced from routine.structure.sliders. The formula is
// unchanged (×(1 + 0.1×bias)), so 10 feels as before and 30 reaches 4×.
function renderSupersetBiasField() {
  const val = clamp(typeof state.settings.supersetBias === 'number' ? state.settings.supersetBias : 5, 0, 30);
  return '<div class="field">' +
    '<label>Superset bias <span class="val">' + val + '</span></label>' +
    '<input type="range" data-action="setting" data-key="supersetBias" min="0" max="30" step="1" value="' + val + '">' +
    '</div>';
}

// v4.0 (Phase 2): a 3-stop slider (0/1/2) for gymnastics classes expected this week.
// More classes → a smaller session impact budget (fewer landing/jump moves). Reuses the
// generic "setting" onChange handler (data-key="weeklyClasses").
function renderWeeklyClassesField() {
  const val = weeklyClasses(state.settings);
  return '<div class="field">' +
    '<label>Gymnastics classes this week <span class="val">' + val + '</span></label>' +
    '<input type="range" data-action="setting" data-key="weeklyClasses" min="0" max="2" step="1" value="' + val + '">' +
    '</div>';
}

/* --- Settings view -------------------------------------------------------- */

// v4.2: Settings "Region status" block — one row per active region with a per-row Clear
// (the only way to clear a red region). Rendered only when at least one region is active.
function renderRegionStatusSettings() {
  const rs = state.regionStatus || {};
  const regions = Object.keys(rs);
  if (!regions.length) return '';
  const label = { shins: 'Shins', knee: 'Knee', foot: 'Foot', back: 'Back', arms: 'Arms' };
  let h = '<section class="panel"><h3>Region status</h3>';
  regions.forEach((r) => {
    const s = rs[r];
    const desc = s.light === 'red' ? 'red' :
      'yellow · ' + s.sessionsLeft + ' session' + (s.sessionsLeft === 1 ? '' : 's') + ' left';
    h += '<div class="region-row">' +
      '<span class="region-row-label">' + escapeHtml(label[r] || r) + '</span>' +
      '<span class="region-row-light region-light-' + escapeHtml(s.light) + '">' + escapeHtml(desc) + '</span>' +
      '<button class="btn small ghost" data-action="region-clear" data-region="' + escapeHtml(r) + '">Clear</button>' +
      '</div>';
  });
  h += '<p class="muted">Set by the 24-hour "how did that settle?" check-in. Yellow eases the ' +
    'region and clears itself over a couple of sessions (or with a green check-in); red pauses it ' +
    'until cleared here. This tracks how a session settled — it doesn’t assess injuries; ' +
    'persistent, worsening, or neurological symptoms → clinician.</p>';
  return h + '</section>';
}

function renderSettings() {
  let html = '<div class="settings">';

  // Session knobs (v3.0: one unified "moves" slider + cool-down; v3.4 adds the
  // joint-friendly toggle beside auto superset).
  html += '<section class="panel"><h3>Session</h3>' +
    renderSettingSlider('moves', 'Number of moves') +
    renderSettingSlider('cool', 'Cool-down (1 = short, 2 = full)') +
    renderWeeklyClassesField() +
    renderTagPriorityFields() +
    renderAutoSupersetField() +
    renderSupersetBiasField() +
    '<p class="muted">Each tag slider tunes how its moves are picked: 1 hard-avoids them, ' +
      '3 is neutral, 5 favours them (e.g. drop joint-stress: legs to 1 to spare recovering ' +
      'knees/ankles). Day A/B are automatic — the current day is softly preferred, not locked. ' +
      'Auto superset groups same-muscle-free Floor moves into supersets — one card, alternate ' +
      'the moves, rest after each round. Higher superset bias makes the generator prefer moves ' +
      'that pair into supersets; it only applies while Auto superset is on.</p>' +
    '</section>';

  // v4.2: region status from the 24h feedback loop (only when any region is active).
  html += renderRegionStatusSettings();

  // Goals (v3.0) — a 0–10 weight slider per TRAINING goal (0 = off). Care goals
  // are always on (they live in the static warm-up / cool-down) and get no slider.
  const care = (state.routine.goals || []).filter((g) => g && g.kind === 'care');
  html += '<section class="panel"><h3>Goals</h3>' +
    renderGoalWeightSliders() +
    '<p class="muted">Higher weight pulls a goal\'s moves in more often. 0 turns it off.</p>' +
    '</section>';

  // Care goals — always covered in the static warm-up & cool-down (no controls).
  html += '<section class="panel"><h3>Always covered in warm-up &amp; cool-down</h3>' +
    '<div class="care-chips">' + care.map((g) =>
      '<span class="chip c-' + escapeHtml(g.colorId || 'gray') + '">' + escapeHtml(g.name) + '</span>'
    ).join(' ') + '</div>' +
    '<p class="muted">These are always on — no need to weight them.</p>' +
    '</section>';

  // Coach (v3.9) — OpenAI key (own localStorage slot, never in state/backups) + the
  // editable athlete profile the Coach reads as context.
  const hasKey = !!getOpenAIKey();
  html += '<section class="panel"><h3>Coach</h3>' +
    '<div class="field">' +
      '<label>OpenAI API key ' +
        (hasKey ? '<span class="val" style="color:var(--green)">set</span>' : '<span class="val" style="color:var(--muted)">not set</span>') +
      '</label>' +
      '<input type="password" id="coach-key" class="coach-key-input" autocomplete="off" spellcheck="false" placeholder="' +
        (hasKey ? '•••••••• (stored on this device)' : 'sk-...') + '">' +
      '<div class="row wrap">' +
        '<button class="btn small primary" data-action="coach-save-key">Save key</button>' +
        (hasKey ? '<button class="btn small danger" data-action="coach-clear-key">Remove key</button>' : '') +
      '</div>' +
    '</div>' +
    '<p class="muted">Uses OpenAI\'s <code>' + escapeHtml(OPENAI_MODEL) + '</code> via a direct browser call. ' +
      'The key is stored only on this device (separate from your routine data, so it is never in a backup export). ' +
      'Set a spend limit in your OpenAI account. Chat history is not saved — it clears on reload.</p>' +
    '<div class="field">' +
      '<label for="coach-profile">Athlete profile</label>' +
      '<textarea id="coach-profile" data-action="coach-profile" spellcheck="false">' +
        escapeHtml(state.settings.coachProfile || '') + '</textarea>' +
    '</div>' +
    '<p class="muted">The Coach reads this plus your full routine and generation settings as context.</p>' +
    '</section>';

  // Data
  html += '<section class="panel"><h3>Data</h3>' +
    '<div class="row wrap">' +
      '<button class="btn" data-action="export">Export backup</button>' +
      '<label class="btn file">Import backup<input type="file" accept="application/json,.json" data-action="import" hidden></label>' +
      '<button class="btn danger" data-action="clear">Clear all data</button>' +
    '</div>' +
    '<p class="muted">' + state.log.length + ' logged session' + (state.log.length === 1 ? '' : 's') + '.</p>' +
    '</section>';

  // Routine history (Phase 3 rollback)
  html += '<section class="panel"><h3>Routine history</h3>';
  if (!state.routineHistory.length) {
    html += '<p class="muted">No previous versions yet.</p>';
  } else {
    html += '<ul class="history">';
    state.routineHistory.forEach((h, i) => {
      html += '<li>' +
        '<span>v' + (h.routine && h.routine.version != null ? h.routine.version : '?') +
          ' · ' + escapeHtml(new Date(h.timestamp).toLocaleString()) + '</span>' +
        '<button class="btn small" data-action="rollback" data-hidx="' + i + '">Roll back</button>' +
        '</li>';
    });
    html += '</ul>';
  }
  html += '</section>';

  // Raw JSON editor (Phase 3)
  html += '<section class="panel"><h3>Routine editor (raw JSON)</h3>' +
    '<textarea id="routine-json" spellcheck="false">' +
      escapeHtml(JSON.stringify(state.routine, null, 2)) + '</textarea>' +
    '<div id="routine-errors" class="errors"></div>' +
    '<div class="row"><button class="btn primary" data-action="save-routine">Validate &amp; save</button></div>' +
    '</section>';

  html += '</div>';
  return html;
}

/* --- 6b. Coach (LLM chat + staged routine edits, v3.9) -------------------- *
 * A chat tab backed by OpenAI (gpt-5.6-sol at medium reasoning effort, the
 * user's own key). The model answers
 * training questions AND proposes routine edits through function/tool calls.
 * EVERY edit is applied to a throwaway trial clone, validated with the existing
 * validateRoutine(), and staged as ui.coach.pending — never auto-applied. The
 * user reviews a summary and taps Apply (pushHistory → swap routine) or Discard.
 * Chat is ephemeral (ui.coach.messages, memory only); the API key lives in its
 * own localStorage slot (OPENAI_KEY), never in `state`, so backups never leak it.
 */

function getOpenAIKey() {
  try { return localStorage.getItem(OPENAI_KEY) || ''; } catch (e) { return ''; }
}
function setOpenAIKey(v) {
  try { if (v) localStorage.setItem(OPENAI_KEY, v); else localStorage.removeItem(OPENAI_KEY); } catch (e) { /* ignore */ }
}

// Markdown-lite: escape, then **bold**, `code`, blank-line paragraphs, single \n → <br>.
function coachMarkdown(text) {
  const esc = escapeHtml(String(text == null ? '' : text));
  return esc.split(/\n{2,}/).map((block) => {
    const inline = block
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
    return '<p>' + inline + '</p>';
  }).join('');
}

function coachScrollToBottom() {
  if (typeof document === 'undefined') return;
  const list = document.getElementById('coach-messages');
  if (list) list.scrollTop = list.scrollHeight;
}

/* --- Tool schemas exposed to the model --- */
const COACH_MOVE_SCHEMA = {
  type: 'object',
  description: 'A generator move (blocks.moves entry).',
  properties: {
    name: { type: 'string' },
    section: { type: 'string', enum: SECTIONS },
    why: { type: 'string', description: 'one-line rationale shown on the card' },
    dose: {
      type: 'object',
      properties: {
        sets: { type: 'integer', minimum: 1, maximum: 6 },
        amount: { type: 'number', description: '> 0' },
        unit: { type: 'string', enum: UNITS },
        weight: { type: 'number', description: 'optional load in lb (> 0)' }
      },
      required: ['sets', 'amount', 'unit']
    },
    goalScores: {
      type: 'object',
      description: 'map of training-goal id -> integer 0..10 (omit goals scoring 0)',
      additionalProperties: { type: 'integer', minimum: 0, maximum: 10 }
    },
    care: { type: 'array', items: { type: 'string' }, description: 'care-goal ids this move also serves' },
    tags: { type: 'array', items: { type: 'string' }, description: 'tag ids from routine.tags' },
    family: { type: 'string', description: 'functional family id — must match an existing family id in routine.families (add_family first if a new one is needed). One per move; drives Phase-2 diversity/ordering.' },
    loads: {
      type: 'object',
      description: 'per-region load facts about the move, 0..3 each; omit zero regions',
      properties: {
        impact: { type: 'integer', minimum: 0, maximum: 3 },
        shin: { type: 'integer', minimum: 0, maximum: 3 },
        knee: { type: 'integer', minimum: 0, maximum: 3 },
        foot: { type: 'integer', minimum: 0, maximum: 3 },
        wrist: { type: 'integer', minimum: 0, maximum: 3 },
        elbow: { type: 'integer', minimum: 0, maximum: 3 },
        lumbar: { type: 'integer', minimum: 0, maximum: 3 }
      },
      additionalProperties: false
    },
    fatigue: { type: 'integer', minimum: 1, maximum: 5, description: 'session-fatigue cost 1 (trivial) .. 5 (very taxing)' },
    qualitySensitive: { type: 'boolean', description: 'true when the move degrades badly under fatigue (skill/power holds)' },
    muscle: { type: 'string' },
    rest: { type: 'integer', description: 'rest seconds (> 0)' },
    progression: { type: 'object' },
    disabled: { type: 'boolean' }
  },
  required: ['name', 'section', 'why', 'dose', 'goalScores']
};

// Responses-API tool format: flat { type, name, description, parameters }
// (the older chat-completions format nested these under a `function` key).
const COACH_TOOLS = [
  { type: 'function',
    name: 'add_move',
    description: 'Add a new generator move to blocks.moves.',
    parameters: { type: 'object', properties: { move: COACH_MOVE_SCHEMA }, required: ['move'] }
  },
  { type: 'function',
    name: 'update_move',
    description: 'Shallow-merge a patch onto the move matched by exact name. dose, goalScores, progression, tags, care and loads are replaced wholesale when present in the patch.',
    parameters: { type: 'object', properties: {
      name: { type: 'string' },
      patch: { type: 'object', description: 'partial move fields to overwrite' }
    }, required: ['name', 'patch'] }
  },
  { type: 'function',
    name: 'delete_move',
    description: 'Remove the move with this exact name (also tombstoned so seed updates never revive it).',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
  },
  { type: 'function',
    name: 'set_move_disabled',
    description: 'Keep a move in the list but in/exclude it from the generator pool.',
    parameters: { type: 'object', properties: {
      name: { type: 'string' }, disabled: { type: 'boolean' }
    }, required: ['name', 'disabled'] }
  },
  { type: 'function',
    name: 'add_tag',
    description: 'Create a routine tag ("bool") and seed its priority slider to 3 (neutral).',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
  },
  { type: 'function',
    name: 'add_family',
    description: 'Create a functional move family (id slugified from name) so moves can reference it via move.family.',
    parameters: { type: 'object', properties: {
      name: { type: 'string' },
      phase: { type: 'string', enum: FAMILY_PHASES, description: 'ordering rank: power → strength → skill-strength → trunk → accessory' },
      maxPerSession: { type: 'integer', minimum: 1, description: 'optional; how many of this family one session may pick (default 1)' }
    }, required: ['name', 'phase'] }
  },
  { type: 'function',
    name: 'set_tag_priority',
    description: 'Set a tag\'s selection priority (1 hard-avoid, 3 neutral, 5 favour).',
    parameters: { type: 'object', properties: {
      tagId: { type: 'string' }, priority: { type: 'integer', minimum: 1, maximum: 5 }
    }, required: ['tagId', 'priority'] }
  },
  { type: 'function',
    name: 'add_goal',
    description: 'Add a goal. training goals carry a 0..10 weight and can be scored by moves; care goals are always-on (warm-up/cool-down) and take no weight.',
    parameters: { type: 'object', properties: {
      name: { type: 'string' },
      kind: { type: 'string', enum: ['training', 'care'] },
      weight: { type: 'integer', minimum: 0, maximum: 10, description: 'training only; default 5' }
    }, required: ['name', 'kind'] }
  },
  { type: 'function',
    name: 'set_goal_weight',
    description: 'Set a training goal\'s weight 0..10 (0 turns it off).',
    parameters: { type: 'object', properties: {
      goalId: { type: 'string' }, weight: { type: 'integer', minimum: 0, maximum: 10 }
    }, required: ['goalId', 'weight'] }
  }
];

// Fresh trial the tool calls mutate: a deep clone of the routine plus the one
// settings slice tools can touch (tagPriority) and a list of names deleted this run.
function coachTrialBase() {
  return {
    routine: deepClone(state.routine),
    settings: { tagPriority: deepClone(state.settings.tagPriority || {}) },
    deletedMoves: []
  };
}

// Apply one tool call to `trial`. Returns { ok:true, summary } or { ok:false, error }.
function applyCoachTool(name, args, trial) {
  const ok = (summary) => ({ ok: true, summary: summary });
  const err = (msg) => ({ ok: false, error: msg });
  args = args || {};
  const moves = () => (trial.routine.blocks && trial.routine.blocks.moves) || [];
  const findMove = (n) => moves().find((x) => x && x.name === n);

  switch (name) {
    case 'add_move': {
      const m = args.move;
      if (!m || typeof m !== 'object') return err('add_move: missing "move" object');
      if (!m.name) return err('add_move: move.name is required');
      trial.routine.blocks = trial.routine.blocks || {};
      trial.routine.blocks.moves = trial.routine.blocks.moves || [];
      if (findMove(m.name)) return err('add_move: a move named "' + m.name + '" already exists');
      trial.routine.blocks.moves.push(deepClone(m));
      return ok('Add move: ' + m.name);
    }
    case 'update_move': {
      if (!args.name) return err('update_move: "name" is required');
      if (!args.patch || typeof args.patch !== 'object') return err('update_move: "patch" object is required');
      const mv = findMove(args.name);
      if (!mv) return err('update_move: no move named "' + args.name + '"');
      Object.assign(mv, deepClone(args.patch));   // dose/goalScores/progression/tags/care/loads replace wholesale
      return ok('Update move: ' + args.name + ' (' + Object.keys(args.patch).join(', ') + ')');
    }
    case 'delete_move': {
      if (!args.name) return err('delete_move: "name" is required');
      const arr = moves();
      const at = arr.findIndex((x) => x && x.name === args.name);
      if (at === -1) return err('delete_move: no move named "' + args.name + '"');
      arr.splice(at, 1);
      if (trial.deletedMoves.indexOf(args.name) === -1) trial.deletedMoves.push(args.name);
      return ok('Delete move: ' + args.name);
    }
    case 'set_move_disabled': {
      if (!args.name) return err('set_move_disabled: "name" is required');
      const mv = findMove(args.name);
      if (!mv) return err('set_move_disabled: no move named "' + args.name + '"');
      if (args.disabled === true) mv.disabled = true; else delete mv.disabled;
      return ok((args.disabled === true ? 'Disable' : 'Enable') + ' move: ' + args.name);
    }
    case 'add_tag': {
      if (!args.name) return err('add_tag: "name" is required');
      trial.routine.tags = trial.routine.tags || [];
      const id = uniqueTagId(slugify(args.name), trial.routine.tags);
      trial.routine.tags.push({ id: id, name: args.name });
      trial.settings.tagPriority[id] = 3;
      return ok('Add tag: ' + args.name + ' (id ' + id + ', priority 3)');
    }
    case 'add_family': {
      if (!args.name) return err('add_family: "name" is required');
      if (FAMILY_PHASES.indexOf(args.phase) === -1) return err('add_family: "phase" must be one of ' + FAMILY_PHASES.join(', '));
      trial.routine.families = trial.routine.families || [];
      const id = uniqueTagId(slugify(args.name), trial.routine.families);
      const fam = { id: id, name: args.name, phase: args.phase };
      if (Number.isInteger(args.maxPerSession) && args.maxPerSession > 0) fam.maxPerSession = args.maxPerSession;
      trial.routine.families.push(fam);
      return ok('Add family: ' + args.name + ' (id ' + id + ', phase ' + args.phase +
        (fam.maxPerSession ? ', max ' + fam.maxPerSession + '/session' : '') + ')');
    }
    case 'set_tag_priority': {
      if (!args.tagId) return err('set_tag_priority: "tagId" is required');
      const tag = (trial.routine.tags || []).find((t) => t && t.id === args.tagId && !t.auto);
      if (!tag) return err('set_tag_priority: no editable tag "' + args.tagId + '"');
      if (typeof args.priority !== 'number' || !isFinite(args.priority)) return err('set_tag_priority: "priority" must be a number 1-5');
      trial.settings.tagPriority[args.tagId] = clamp(Math.round(args.priority), 1, 5);
      return ok('Set tag priority: ' + args.tagId + ' → ' + trial.settings.tagPriority[args.tagId]);
    }
    case 'add_goal': {
      if (!args.name) return err('add_goal: "name" is required');
      if (args.kind !== 'training' && args.kind !== 'care') return err('add_goal: "kind" must be "training" or "care"');
      trial.routine.goals = trial.routine.goals || [];
      const id = uniqueTagId(slugify(args.name), trial.routine.goals);
      const used = new Set(trial.routine.goals.map((g) => g && g.colorId));
      const colorId = GOAL_COLORS.find((c) => !used.has(c)) || 'gray';
      const goal = { id: id, name: args.name, kind: args.kind, colorId: colorId };
      if (args.kind === 'training') {
        goal.weight = (typeof args.weight === 'number' && isFinite(args.weight)) ? clamp(Math.round(args.weight), 0, 10) : 5;
      }
      trial.routine.goals.push(goal);
      return ok('Add ' + args.kind + ' goal: ' + args.name + (args.kind === 'training' ? ' (weight ' + goal.weight + ')' : ''));
    }
    case 'set_goal_weight': {
      if (!args.goalId) return err('set_goal_weight: "goalId" is required');
      const g = (trial.routine.goals || []).find((x) => x && x.id === args.goalId);
      if (!g) return err('set_goal_weight: no goal "' + args.goalId + '"');
      if (g.kind !== 'training') return err('set_goal_weight: "' + args.goalId + '" is a care goal and has no weight');
      if (typeof args.weight !== 'number' || !isFinite(args.weight)) return err('set_goal_weight: "weight" must be a number 0-10');
      g.weight = clamp(Math.round(args.weight), 0, 10);
      return ok('Set goal weight: ' + args.goalId + ' → ' + g.weight);
    }
    default:
      return err('Unknown tool: ' + name);
  }
}

function coachStagePending(trial, summary) {
  ui.coach.pending = {
    routine: deepClone(trial.routine),
    settingsPatch: { tagPriority: deepClone(trial.settings.tagPriority) },
    deletedNames: trial.deletedMoves.slice(),
    summary: summary.slice()
  };
}

// Compact human-readable settings snapshot for the system prompt.
function coachSettingsContext() {
  const training = (state.routine.goals || []).filter((g) => g && g.kind === 'training')
    .map((g) => g.id + '=' + (typeof g.weight === 'number' ? g.weight : 0));
  const tp = state.settings.tagPriority || {};
  const tags = ((state.routine.tags || []).filter((t) => t && t.id && !t.auto))
    .map((t) => t.id + '=' + (typeof tp[t.id] === 'number' ? tp[t.id] : 3));
  // v4.1: readiness + intent are per-session, athlete-only inputs — surface the current
  // (non-default) values compactly so the Coach knows what filtered today's session.
  const rParts = readinessSummary();
  const intent = sessionIntent(state);
  // v4.2: persistent region status from the 24h feedback loop (athlete-only; non-empty only).
  const rs = state.regionStatus || {};
  const rsKeys = Object.keys(rs);
  const rsLine = rsKeys.length ? '\nRegion status (24h feedback): ' + rsKeys.map((r) => {
    const s = rs[r];
    return r + ' ' + s.light + (s.light === 'yellow'
      ? ' (' + s.sessionsLeft + ' session' + (s.sessionsLeft === 1 ? '' : 's') + ' left)' : '');
  }).join(', ') : '';
  return 'Training goal weights (0-10): ' + (training.join(', ') || '(none)') + '\n' +
    'Tag priorities (1 avoid … 3 neutral … 5 favour): ' + (tags.join(', ') || '(none)') + '\n' +
    'Superset bias: ' + (state.settings.supersetBias != null ? state.settings.supersetBias : 5) +
    ' · moves/session: ' + state.settings.moves +
    ' · gymnastics classes this week: ' + weeklyClasses(state.settings) + '\n' +
    'Readiness (today, athlete-set): ' + (rParts.length ? rParts.join(', ') : 'all good') + '\n' +
    'Session intent: ' + (intent === 'default' ? 'default' : INTENT_LABELS[intent]) + rsLine;
}

function coachSystemPrompt() {
  return [
    'You are the in-app training coach for "Tumble Trainer", a gymnastics-and-strength workout PWA.',
    'You do two things: (1) answer the athlete\'s training questions (form checks, rep definitions,',
    'programming advice) directly and briefly, and (2) edit their routine through the provided tools.',
    '',
    'HOW EDITS WORK — read carefully:',
    '- Your tool calls do NOT take effect immediately. They are collected, validated, and STAGED for the',
    '  athlete, who must tap "Apply" before anything changes. Nothing you do is applied until they approve.',
    '- If a batch of tool calls fails validation you will get the errors back — fix them and resend the',
    '  whole batch. After staging, briefly explain in chat what you proposed and why.',
    '- When the athlete is only asking a question, just answer. Do not force an edit.',
    '',
    'SCOPE OF TOOLS:',
    '- Tools edit ONLY blocks.moves (the generator pool), routine.tags, routine.goals, tag priorities and',
    '  goal weights. You CANNOT and MUST NOT touch the warm-up or cool-down — they are athlete-managed.',
    '- A valid move needs: name, section (one of ' + SECTIONS.join(', ') + '), why, dose',
    '  { sets 1-6 integer, amount > 0, unit one of ' + UNITS.join(', ') + ' }, and goalScores',
    '  (map of training-goal id -> integer 0-10; omit goals scoring 0). Optional: care[] (care-goal ids),',
    '  tags[] (ids from routine.tags), muscle, rest (seconds), progression, dose.weight (lb), disabled, and',
    '  the functional metadata family (a routine.families id), loads (per-region 0-3, omit zeros),',
    '  fatigue (1-5), qualitySensitive (bool) — data the session planner reasons over.',
    '- goalScores keys must be existing TRAINING goal ids; care[] must be existing CARE goal ids; tags[]',
    '  must be existing tag ids; family must be an existing family id. Create a goal, tag or family first',
    '  (add_goal / add_tag / add_family) if you need a new one.',
    '- Move names are unique. update_move/delete_move/set_move_disabled match by EXACT name.',
    '',
    'GUARDRAILS:',
    '- Be conservative with anything touching pain, rehab, or care items (plantar fasciitis, cubital',
    '  tunnel, posture, sciatic, joint recovery, splits). Do not remove care-serving work casually, and',
    '  for symptom/pain topics advise seeing a professional rather than prescribing rehab.',
    '- Prefer small, targeted edits over sweeping rewrites. Keep names unique. Explain reasoning briefly.',
    '- The session planner now enforces family caps (≤1 move per family), load budgets (Σ impact scaled by',
    '  weekly gymnastics classes, plus caps on fatigue≥4 / arm-support / lumbar≥2 moves) and coverage slots.',
    '  So structure/diversity is handled by the generator — do not try to fix it purely by nudging scores.',
    '- A pre-session readiness check-in (per-region good/caution/stop, back sensitive, arms caution, energy,',
    '  class-soon) and a session intent (gym prep, recovery, low-impact, short, upper) further filter and',
    '  budget today\'s session — the athlete sets these on the Gym tab; you cannot and must not set them.',
    '- A 24-hour traffic-light feedback loop (green/yellow/red per region) parks a persistent region status',
    '  that eases (yellow) or pauses (red) that region\'s work. Like readiness, this is an athlete-only input',
    '  you can SEE (below) but never set or clear — advise, do not attempt to change it via tools.',
    '',
    'CURRENT GENERATION SETTINGS:',
    coachSettingsContext(),
    '',
    'ATHLETE PROFILE:',
    (state.settings.coachProfile || '(none provided)'),
    '',
    'CURRENT ROUTINE (JSON — warm-up/cool-down included for context only, not editable):',
    JSON.stringify(state.routine)
  ].join('\n');
}

// Responses API, not chat completions: gpt-5.6-sol rejects function tools +
// reasoning_effort on /v1/chat/completions ("use /v1/responses").
async function coachFetch(key, instructions, input, tools) {
  let res;
  try {
    res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        instructions: instructions,
        input: input,
        tools: tools,
        tool_choice: 'auto',
        reasoning: { effort: OPENAI_REASONING_EFFORT },   // Responses API nests it (chat used reasoning_effort)
        max_output_tokens: 12000          // shared with reasoning tokens; no `temperature` — gpt-5.x rejects it
      })
    });
  } catch (e) { throw { coachKind: 'network' }; }
  if (res.status === 401) throw { coachKind: 'auth' };
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = (j && j.error && j.error.message) || ''; } catch (e2) { /* non-JSON */ }
    throw { coachKind: 'http', status: res.status, detail: detail };
  }
  return res.json();
}

function coachErrorText(e) {
  if (e && e.coachKind === 'auth') return 'OpenAI rejected the API key (401). Check or replace it in Settings.';
  if (e && e.coachKind === 'network') return 'Network error — the Coach needs a connection. Check you are online and try again.';
  if (e && e.coachKind === 'http') return 'OpenAI error ' + e.status + (e.detail ? ': ' + e.detail : '') + '.';
  return 'Something went wrong: ' + (e && e.message ? e.message : String(e));
}

// The agentic loop: send messages+tools; apply/validate/stage any tool calls;
// let the model retry once on invalid, then produce its closing text.
async function coachRun() {
  const key = getOpenAIKey();
  if (!key) { ui.coach.busy = false; ui.coach.error = 'Add an OpenAI API key in Settings first.'; render(); return; }

  const instructions = coachSystemPrompt();
  const input = ui.coach.messages.map((m) => ({ role: m.role, content: m.text }));

  let trial = coachTrialBase();
  let invalidRetries = 0;
  let closed = false;
  try {
    for (let iter = 0; iter < COACH_MAX_ITERS; iter++) {
      const data = await coachFetch(key, instructions, input, COACH_TOOLS);
      const output = (data && data.output) || [];
      // Re-send everything the model produced (incl. reasoning items — required
      // for reasoning models when returning function_call_output).
      output.forEach((item) => input.push(item));
      const calls = output.filter((it) => it && it.type === 'function_call');
      if (!calls.length) {
        const text = output.filter((it) => it && it.type === 'message')
          .map((m) => ((m.content || []).filter((c) => c && c.type === 'output_text')
            .map((c) => c.text).join('')))
          .join('\n\n').trim();
        ui.coach.messages.push({ role: 'assistant', text: text || '(no reply)' });
        closed = true;
        break;
      }

      const snapshot = deepClone(trial);                    // roll back cleanly if the batch is invalid
      const results = calls.map((tc) => {
        let args = {};
        try { args = JSON.parse(tc.arguments || '{}'); }
        catch (e) { return { id: tc.call_id, error: 'Invalid JSON arguments' }; }
        const r = applyCoachTool(tc.name || '', args, trial);
        return { id: tc.call_id, summary: r.ok ? r.summary : null, error: r.ok ? null : r.error };
      });
      const anyErr = results.some((r) => r.error);
      const v = validateRoutine(trial.routine);

      if (anyErr || !v.valid) {
        trial = snapshot;                                   // discard the bad batch
        const errLines = results.filter((r) => r.error).map((r) => r.error).concat(v.valid ? [] : v.errors);
        calls.forEach((tc) => {
          const own = results.find((r) => r.id === tc.call_id);
          const content = (own && own.error) ? own.error
            : 'Batch rejected — fix and resend ALL edits together:\n' + errLines.join('\n');
          input.push({ type: 'function_call_output', call_id: tc.call_id, output: content });
        });
        invalidRetries++;
        if (invalidRetries > 1) {
          ui.coach.messages.push({ role: 'assistant',
            text: 'I could not build a valid change:\n' + errLines.join('\n') + '\n\nNothing was changed.' });
          closed = true;
          break;
        }
        continue;                                           // one retry
      }

      // Valid batch → stage it (replacing any earlier pending) and report back.
      coachStagePending(trial, results.filter((r) => r.summary).map((r) => r.summary));
      calls.forEach((tc) => {
        const own = results.find((r) => r.id === tc.call_id);
        input.push({ type: 'function_call_output', call_id: tc.call_id,
          output: 'Staged for user approval: ' + (own && own.summary ? own.summary : 'ok') });
      });
      // loop again so the model can add its closing explanation
    }
  } catch (e) {
    ui.coach.error = coachErrorText(e);
  }
  if (!closed && !ui.coach.error) {
    ui.coach.messages.push({ role: 'assistant',
      text: ui.coach.pending ? 'I\'ve staged the changes above — review and tap Apply when ready.'
        : 'I ran out of steps before finishing. Try rephrasing.' });
  }
  ui.coach.busy = false;
  render();
}

function coachSend() {
  if (typeof document === 'undefined') return;
  if (ui.coach.busy) return;
  const ta = document.getElementById('coach-input');
  const text = ((ta && ta.value) || '').trim();
  if (!text) return;
  if (!getOpenAIKey()) { ui.coach.error = 'Add an OpenAI API key in Settings first.'; render(); return; }
  ui.coach.pending = null;                 // a new message discards any stale staged edit
  ui.coach.error = null;
  ui.coach.messages.push({ role: 'user', text: text });
  ui.coach.busy = true;
  render();
  coachRun();
}

function coachApplyPending() {
  const p = ui.coach.pending;
  if (!p) return;
  pushHistory(state.routine);
  state.routine = deepClone(p.routine);
  if (p.settingsPatch && p.settingsPatch.tagPriority) state.settings.tagPriority = deepClone(p.settingsPatch.tagPriority);
  (p.deletedNames || []).forEach((name) => {
    state.deletedMoves = state.deletedMoves || [];
    if (state.deletedMoves.indexOf(name) === -1) state.deletedMoves.push(name);
    delete state.intensity[name];
    delete state.checks[name];
    delete state.setsDone[name];
    if (ui.expanded.has(name)) ui.expanded.delete(name);
  });
  state.swaps = {};                        // a routine change can invalidate per-session keys (mirrors rollback)
  state.dismissed = {};
  ui.coach.pending = null;
  ui.coach.messages.push({ role: 'assistant', text: 'Applied — your routine is updated. (Undo via Settings → Routine history.)' });
  saveState();
  render();
}

function coachDiscardPending() {
  ui.coach.pending = null;
  render();
}

function coachNewChat() {
  ui.coach.messages = [];
  ui.coach.pending = null;
  ui.coach.error = null;
  ui.coach.busy = false;
  render();
}

function coachSaveKey() {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('coach-key');
  const v = ((el && el.value) || '').trim();
  if (!v) return;
  setOpenAIKey(v);
  ui.coach.error = null;
  render();
}

function coachClearKey() {
  setOpenAIKey('');
  render();
}

function coachSaveProfile(el) {
  state.settings.coachProfile = (el && el.value) || '';
  saveState();
}

function renderCoach() {
  if (!getOpenAIKey()) {
    return '<div class="coach"><div class="coach-setup">' +
      '<h3>Set up the Coach</h3>' +
      '<p class="muted">The Coach uses OpenAI (<code>' + escapeHtml(OPENAI_MODEL) + '</code>) to answer training ' +
        'questions and propose routine edits you approve. Add your OpenAI API key to get started.</p>' +
      '<button class="btn primary" data-action="tab" data-view="settings">Open Settings</button>' +
      '</div></div>';
  }
  const c = ui.coach;
  let msgs;
  if (!c.messages.length) {
    msgs = '<div class="coach-empty muted">Ask about form, rep definitions, or programming — or tell me how to ' +
      'change your routine. I stage edits for you to review; nothing changes until you tap Apply.</div>';
  } else {
    msgs = c.messages.map((m) =>
      '<div class="coach-msg coach-' + (m.role === 'user' ? 'user' : 'bot') + '">' + coachMarkdown(m.text) + '</div>'
    ).join('');
  }
  let pending = '';
  if (c.pending) {
    pending = '<div class="coach-pending">' +
      '<div class="coach-pending-title">Proposed routine changes</div>' +
      '<ul>' + (c.pending.summary.length
        ? c.pending.summary.map((s) => '<li>' + escapeHtml(s) + '</li>').join('')
        : '<li>(no summary)</li>') + '</ul>' +
      '<div class="row">' +
        '<button class="btn primary" data-action="coach-apply">Apply</button>' +
        '<button class="btn ghost" data-action="coach-discard">Discard</button>' +
      '</div></div>';
  }
  const err = c.error ? '<div class="errors show">' + escapeHtml(c.error) + '</div>' : '';
  const busy = c.busy;
  return '<div class="coach">' +
    '<div class="coach-head">' +
      '<span class="muted">Ephemeral chat · edits need your Apply</span>' +
      '<button class="btn small ghost" data-action="coach-new"' + (busy ? ' disabled' : '') + '>New chat</button>' +
    '</div>' +
    '<div id="coach-messages" class="coach-messages">' + msgs +
      (busy ? '<div class="coach-msg coach-bot coach-typing"><span></span><span></span><span></span></div>' : '') +
    '</div>' +
    pending + err +
    '<div class="coach-compose">' +
      '<textarea id="coach-input" placeholder="Ask the coach…"' + (busy ? ' disabled' : '') + '></textarea>' +
      '<button class="btn primary" data-action="coach-send"' + (busy ? ' disabled' : '') + '>' +
        (busy ? 'Sending…' : 'Send') + '</button>' +
    '</div></div>';
}

/* --- 7. Event handling & mutations ---------------------------------------- */

function onClick(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  const idx = el.dataset.idx != null ? +el.dataset.idx : null;
  const ex = idx != null ? renderedExercises[idx] : null;
  // Superset member actions carry data-member; resolve the member off the card
  // (members aren't in renderedExercises — only the synthetic card is).
  const memberIdx = el.dataset.member != null ? +el.dataset.member : null;
  const progEx = (memberIdx != null && ex && ex.members) ? ex.members[memberIdx].ex : ex;

  switch (action) {
    case 'check': return;                       // handled by onChange
    case 'expand': toggleExpand(ex); break;
    case 'prog': stepLevel(progEx, +el.dataset.dir); break;
    case 'set-done': setDone(ex, el.dataset.block, +el.dataset.set); break;
    case 'round-done': roundDone(ex, +el.dataset.round); break;
    case 'reset': resetOverride(progEx); break;
    case 'finish': ui.finishing = true; render(); break;
    case 'cancel-finish': ui.finishing = false; render(); break;
    case 'confirm-finish': doFinish(); break;
    case 'tab': setView(el.dataset.view); break;
    // v3.1 day preview (transient — never persisted).
    case 'prev-day': setPreviewOffset(previewOffset - 1); break;
    case 'next-day': setPreviewOffset(previewOffset + 1); break;
    case 'back-to-today': setPreviewOffset(0); break;
    case 'toggle-adjust': ui.adjustOpen = !ui.adjustOpen; render(); break;   // v3.4 Gym panel
    case 'toggle-readiness': ui.readinessOpen = !ui.readinessOpen; render(); break;   // v4.1 check-in panel
    case 'readiness-set': setReadiness(el.dataset.region, el.dataset.level); break;    // v4.1 one region
    case 'readiness-classsoon': setClassSoon(el.dataset.val === '1'); break;
    case 'readiness-intent': setSessionIntent(el.dataset.intent); break;
    case 'readiness-reset': resetReadiness(); break;
    // v4.2: 24h feedback loop. Green applies immediately; yellow/red open the region step.
    case 'feedback-light': feedbackLight(el.dataset.light); break;
    case 'feedback-region': applyFeedback(ui.feedbackPick, el.dataset.region); break;
    case 'feedback-cancel': ui.feedbackPick = null; ui.feedbackFor = null; render(); break;
    case 'feedback-skip': feedbackSkip(); break;
    case 'region-clear': clearRegionStatus(el.dataset.region); break;   // v4.2 Settings row
    case 'toggle-block': toggleBlock(el.dataset.block); break;               // v3.6 collapse a session block
    case 'export': exportState(); break;
    case 'clear': clearData(); break;
    case 'rollback': rollback(+el.dataset.hidx); break;
    case 'save-routine': saveRoutineFromEditor(); break;
    case 'suggest-apply': applySuggestion(+el.dataset.sidx); break;
    case 'suggest-dismiss': dismissSuggestion(+el.dataset.sidx); break;
    case 'mv-delete': deleteMove(+el.dataset.idx); break;   // idx into renderedMoves
    case 'mv-add': addMove(); break;
    case 'mv-add-tag': addTag(); break;                     // v3.7 create a routine tag
    case 'coach-send': coachSend(); break;                  // v3.9 Coach
    case 'coach-new': coachNewChat(); break;
    case 'coach-apply': coachApplyPending(); break;
    case 'coach-discard': coachDiscardPending(); break;
    case 'coach-save-key': coachSaveKey(); break;
    case 'coach-clear-key': coachClearKey(); break;
    default: break;
  }
}

function onChange(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'check') {
    const ex = renderedExercises[+el.dataset.idx];
    // v2.5: a superset card is one check-off covering every member — replicate a
    // per-move check for each, then (on check) start the shared rest clock.
    if (ex && ex.isSuperset) {
      toggleSuperset(ex, el.checked);
      saveState();
      render();
      return;
    }
    // v2.4.1: warm-up group cards are a single check unit with no set circles —
    // skip the setsDone/rest bookkeeping (and don't call effectiveDose on the
    // doseless synthetic card).
    if (el.checked) {
      state.checks[ex.name] = true;
      if (!ex.isWarmupGroup) {
        state.setsDone[ex.name] = effectiveDose(ex).sets;  // sync circles with the manual check
        if (state.rest && state.rest.name === ex.name) state.rest = { name: null, startedAt: null };
      }
    } else {
      delete state.checks[ex.name];
      if (!ex.isWarmupGroup) {
        state.setsDone[ex.name] = 0;                // un-checking resets set progress
        if (state.rest && state.rest.name === ex.name) state.rest = { name: null, startedAt: null };
      }
    }
    saveState();
    render();
  } else if (action === 'setting') {
    state.settings[el.dataset.key] = +el.value;
    saveState();
    render();
  } else if (action === 'goal-weight') {
    const g = (state.routine.goals || []).find((x) => x && x.id === el.dataset.goal);
    if (g && g.kind === 'training') g.weight = clamp(+el.value, 0, 10);
    saveState();
    render();
  } else if (action === 'toggle-superset') {
    state.autoSuperset = el.checked;   // v2.5 Auto Superset on/off
    saveState();
    render();
  } else if (action === 'tag-priority') {
    // v3.7: one 1–5 priority slider per non-auto tag; data-tag says which one fired.
    const id = el.dataset.tag;
    if (id) {
      state.settings.tagPriority = state.settings.tagPriority || {};
      state.settings.tagPriority[id] = clamp(+el.value, 1, 5);
    }
    saveState();
    render();
  } else if (action === 'mv-toggle') {
    toggleMoveDisabled(+el.dataset.idx);         // v3.4 Moves-tab enable/disable
  } else if (action === 'coach-profile') {
    coachSaveProfile(el);                        // v3.9 persist the athlete profile on edit (no re-render)
  } else if (action === 'import') {
    importFile(el.files && el.files[0]);
  }
}

/*
 * v2.5: check/uncheck a whole superset card. Replicates a normal card check-off
 * for EACH member (state.checks + setsDone sync + clearing that member's rest
 * clock), and keeps the synthetic card key in state.checks so the progress bar
 * and the card's own done state count it as one unit. finishSession still logs
 * each member individually by name (it reads the raw build, not the card). On
 * check-off it (re)starts the single global rest clock aimed at the card, with
 * target = max of the members' rest targets (Feature E; "rest after each round").
 */
function toggleSuperset(card, checked) {
  const clearIf = (name) => {
    if (state.rest && state.rest.name === name) state.rest = { name: null, startedAt: null };
  };
  if (checked) {
    state.checks[card.name] = true;
    state.setsDone[card.name] = supersetRounds(card);      // round dots all filled
    card.moves.forEach((ex) => {
      state.checks[ex.name] = true;
      state.setsDone[ex.name] = effectiveDose(ex).sets;   // sync set circles as a manual check does
      clearIf(ex.name);
    });
    const target = supersetRestTarget(card);
    if (target != null && target > 0) state.rest = { name: card.name, startedAt: Date.now() };
  } else {
    delete state.checks[card.name];
    state.setsDone[card.name] = 0;                         // clear round counter
    card.moves.forEach((ex) => {
      delete state.checks[ex.name];
      state.setsDone[ex.name] = 0;                         // un-checking resets set progress
      clearIf(ex.name);
    });
    clearIf(card.name);
  }
}

/*
 * Tap a whole-superset round dot (mirrors setDone). Tapping the next dot completes
 * a round: bumps the card's round counter and each member's setsDone (capped at
 * that member's own sets), then (re)starts the shared rest clock aimed at the card.
 * Tapping the last-filled dot undoes: decrements the counter and every member whose
 * setsDone equals the round being undone (exact reverse of the cap-aware bump).
 * Completing the final round auto-checks the whole card (as the checkbox would);
 * dropping below complete unchecks it.
 */
function roundDone(card, k) {
  if (!card || !card.isSuperset) return;
  const rounds = supersetRounds(card);
  const cur = state.setsDone[card.name] || 0;
  if (k === cur) {
    state.setsDone[card.name] = cur + 1;
    card.moves.forEach((ex) => {
      const s = effectiveDose(ex).sets;
      if ((state.setsDone[ex.name] || 0) < s) state.setsDone[ex.name] = (state.setsDone[ex.name] || 0) + 1;
    });
    const target = supersetRestTarget(card);
    if (target != null) state.rest = { name: card.name, startedAt: Date.now() };
  } else if (k === cur - 1) {
    state.setsDone[card.name] = cur - 1;
    card.moves.forEach((ex) => {
      if ((state.setsDone[ex.name] || 0) === cur) state.setsDone[ex.name] = cur - 1;
    });
  } else {
    return;
  }
  const now = state.setsDone[card.name];
  if (now >= rounds) {
    // Final round done — behave exactly as a manual check-off, but no post-round
    // rest clock (matching setDone stopping the clock on the final set).
    state.checks[card.name] = true;
    card.moves.forEach((ex) => { state.checks[ex.name] = true; state.setsDone[ex.name] = effectiveDose(ex).sets; });
    if (state.rest && state.rest.name === card.name) state.rest = { name: null, startedAt: null };
  } else if (state.checks[card.name]) {
    delete state.checks[card.name];                        // dropped below complete — unmark
    card.moves.forEach((ex) => { delete state.checks[ex.name]; });
  }
  saveState();
  render();
}

function toggleExpand(ex) {
  if (!ex) return;
  if (ui.expanded.has(ex.name)) ui.expanded.delete(ex.name);
  else ui.expanded.add(ex.name);
  render();
}

/*
 * Feature E: tap a set circle. Tapping the next unfilled circle completes a set
 * and (re)starts the single global rest clock aimed at this move; tapping the
 * last-filled circle undoes it. Completing the final set auto-checks the move
 * and stops its clock.
 */
function setDone(ex, blockKey, k) {
  if (!ex) return;
  const eff = effectiveDose(ex);
  const cur = state.setsDone[ex.name] || 0;
  if (k === cur) {
    state.setsDone[ex.name] = cur + 1;
    const target = restTarget(ex, blockKey);   // warmup/cooldown => null => no clock
    if (target != null) state.rest = { name: ex.name, startedAt: Date.now() };
  } else if (k === cur - 1) {
    state.setsDone[ex.name] = cur - 1;
  } else {
    return;
  }
  const now = state.setsDone[ex.name];
  if (now >= eff.sets) {
    state.checks[ex.name] = true;
    if (state.rest && state.rest.name === ex.name) state.rest = { name: null, startedAt: null };
  } else if (state.checks[ex.name]) {
    delete state.checks[ex.name];               // dropped below complete — unmark
  }
  saveState();
  render();
}

function setView(v) {
  state.view = v;
  previewOffset = 0;               // day preview is a Today-only transient — reset on tab change
  saveState();
  render();
}

// v3.1 day preview: clamp to [0, PREVIEW_MAX] and re-render. Transient — never
// saved (no saveState), so a refresh returns to today.
function setPreviewOffset(n) {
  previewOffset = clamp(n, 0, PREVIEW_MAX);
  render();
}

// v3.6: collapse/expand a session block by key. State lives in state.collapsed (not
// the DOM) so it survives the re-render on every check-off, and is saved so it also
// survives reload. Reset to {} on finish, so each new session starts fully expanded.
function toggleBlock(key) {
  if (!key) return;
  if (!state.collapsed || typeof state.collapsed !== 'object') state.collapsed = {};
  if (state.collapsed[key]) delete state.collapsed[key];
  else state.collapsed[key] = true;
  saveState();
  render();
}

/* --- v4.1 (Phase 3): readiness check-in mutations. Each writes state, saves, and
 * re-renders — regenerating the visible session live (like the Adjust panel). ------- */
function ensureReadiness() {
  if (!state.readiness || typeof state.readiness !== 'object') state.readiness = defaultReadiness();
  return state.readiness;
}
function setReadiness(region, level) {
  if (!region || !READINESS_LEVELS[region] || READINESS_LEVELS[region].indexOf(level) === -1) return;
  ensureReadiness()[region] = level;
  saveState();
  render();
}
function setClassSoon(on) {
  ensureReadiness().classSoon = !!on;
  saveState();
  render();
}
function setSessionIntent(intent) {
  if (SESSION_INTENTS.indexOf(intent) === -1) return;
  state.sessionIntent = intent;
  saveState();
  render();
}
function resetReadiness() {
  state.readiness = defaultReadiness();
  state.sessionIntent = 'default';
  saveState();
  render();
}

/* --- v4.2 (Phase 4): 24-hour feedback loop mutations ----------------------- */
// Green answers immediately; yellow/red open a transient region step (re-renders the card).
function feedbackLight(light) {
  if (light === 'green') { applyFeedback('green', null); return; }
  if (light === 'yellow' || light === 'red') {
    const entry = feedbackPromptEntry();
    if (!entry) return;
    ui.feedbackPick = light;
    ui.feedbackFor = entry.session;   // pin the pick to this entry (see renderFeedbackCard)
    render();
  }
}
// Stamp the light (and region) on the prompted log entry, then update persistent regionStatus:
//   green → clear every yellow region (red persists; only Settings clears red);
//   yellow(region) → park it yellow for YELLOW_SESSIONS unless it is already red (keep red);
//   red(region) → pause it (light 'red', no sessionsLeft).
function applyFeedback(light, region) {
  const entry = feedbackPromptEntry();
  if (!entry) { ui.feedbackPick = null; ui.feedbackFor = null; render(); return; }
  if (light !== 'green' && !REGION_KEYS[region]) { ui.feedbackPick = null; ui.feedbackFor = null; render(); return; }
  if (!state.regionStatus || typeof state.regionStatus !== 'object') state.regionStatus = {};
  const rs = state.regionStatus;
  if (light === 'green') {
    entry.feedback = { light: 'green' };
    Object.keys(rs).forEach((r) => { if (rs[r] && rs[r].light === 'yellow') delete rs[r]; });
  } else if (light === 'yellow') {
    entry.feedback = { light: 'yellow', region: region };
    if (!(rs[region] && rs[region].light === 'red')) rs[region] = { light: 'yellow', sessionsLeft: YELLOW_SESSIONS };
  } else if (light === 'red') {
    entry.feedback = { light: 'red', region: region };
    rs[region] = { light: 'red' };
  } else { ui.feedbackPick = null; ui.feedbackFor = null; render(); return; }
  ui.feedbackPick = null;
  ui.feedbackFor = null;
  saveState();
  render();
}
// Dismiss (✕): mark the entry answered-but-skipped so it never re-prompts (counts as benign).
function feedbackSkip() {
  const entry = feedbackPromptEntry();
  if (entry) entry.feedbackSkipped = true;
  ui.feedbackPick = null;
  ui.feedbackFor = null;
  saveState();
  render();
}
// Settings "Clear" — remove a region entry (the only way to clear a red region).
function clearRegionStatus(region) {
  if (state.regionStatus && state.regionStatus[region]) delete state.regionStatus[region];
  saveState();
  render();
}

// Finish: log the session (Phase 2), advance index, clear checks.
function finishSession(note) {
  const built = buildSession(state);
  const entry = {
    session: state.session,
    date: new Date().toISOString(),
    day: built.day,
    settings: Object.assign({}, state.settings),
    exercises: []
  };
  built.blocks.forEach((bl) => {
    // v2.4.1: the warm-up logs one entry per group card (name = group, no dose),
    // matching how it now renders/checks. Ungrouped warm-up moves log per move.
    if (bl.key === 'warmup') {
      warmupGroups(bl.exercises).forEach((item) => {
        if (item.kind === 'group') {
          entry.exercises.push({ name: item.groupName, category: 'warmup', done: !!state.checks[item.card.name] });
        } else {
          entry.exercises.push({ name: item.ex.name, goals: (item.ex.goals || []).slice(), done: !!state.checks[item.ex.name] });
        }
      });
      return;
    }
    bl.exercises.forEach((ex) => {
      const eff = effectiveDose(ex);
      const dose = { sets: eff.sets, amount: eff.amount, unit: eff.unit };  // EFFECTIVE dose
      if (eff.weight != null) dose.weight = eff.weight;                     // carry physical load
      const logged = {
        name: ex.name,
        goals: (ex.goals || []).slice(),
        dose: dose,
        done: !!state.checks[ex.name]
      };
      // v4.2: log contacts for impact families so weekly impact can be tallied against classes.
      // sets × reps ('reps'); doubled for 'reps/side'. Only when done and rep-based.
      const fam = moveFamilyId(ex);
      if (logged.done && (fam === 'landing-impact' || fam === 'jump-power') &&
          (eff.unit === 'reps' || eff.unit === 'reps/side')) {
        logged.contacts = eff.sets * eff.amount * (eff.unit === 'reps/side' ? 2 : 1);
      }
      entry.exercises.push(logged);
    });
  });
  if (note) entry.note = note;
  // v4.1: stamp non-default readiness/intent so the volume nudge (and the Phase 4
  // feedback loop) can tell a deliberately modified session from a normal one.
  if (state.sessionIntent && state.sessionIntent !== 'default') entry.intent = state.sessionIntent;
  if (!readinessIsDefault(state.readiness)) entry.readiness = normalizeReadiness(state.readiness);

  // v4.2: snapshot the active region status onto the entry (region → light), then decay yellow
  // regions the finished session ACTUALLY loaded — a done, non-warmup move carrying that region's
  // key ≥ 1. (A shins-yellow 'upper' day that never touched shins must not burn a session.)
  // regionStatus is persistent, so it is NOT reset with the per-session state below.
  const rs = (state.regionStatus && typeof state.regionStatus === 'object') ? state.regionStatus : {};
  const activeRegions = Object.keys(rs);
  if (activeRegions.length) {
    const snap = {};
    activeRegions.forEach((region) => { snap[region] = rs[region].light; });
    entry.regionStatus = snap;
    const loaded = {};   // region → did some done, non-warmup move load it this session?
    built.blocks.forEach((bl) => {
      if (bl.key === 'warmup') return;
      bl.exercises.forEach((ex) => {
        if (!state.checks[ex.name]) return;
        activeRegions.forEach((region) => {
          if ((REGION_KEYS[region] || []).some((k) => moveLoad(ex, k) >= 1)) loaded[region] = true;
        });
      });
    });
    activeRegions.forEach((region) => {
      const s = rs[region];
      if (s.light !== 'yellow' || !loaded[region]) return;   // red never decays; unloaded regions untouched
      s.sessionsLeft = (typeof s.sessionsLeft === 'number' ? s.sessionsLeft : YELLOW_SESSIONS) - 1;
      if (s.sessionsLeft <= 0) delete rs[region];
    });
  }

  state.log.push(entry);
  state.session += 1;
  state.checks = {};
  state.collapsed = {};          // v3.6: a fresh session starts with every block expanded
  state.swaps = {};              // Phase 4: swaps are per-session trials — clear on finish
  state.setsDone = {};           // Feature E: per-session, cleared on finish
  state.rest = { name: null, startedAt: null };
  state.sessionIntent = 'default';        // v4.1: readiness/intent are a per-session input — reset
  state.readiness = defaultReadiness();
  state.lastFinished = entry.date;
  previewOffset = 0;             // v3.1: finishing returns the Today view to today
  saveState();
}

function doFinish() {
  const ta = document.getElementById('note');
  const note = ta ? ta.value.trim() : '';
  finishSession(note);
  ui.finishing = false;
  ui.expanded.clear();
  render();
}

/* --- 8. Import / export / clear / history --------------------------------- */

function exportState() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tumble-trainer-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function importFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let parsed;
    try { parsed = JSON.parse(reader.result); }
    catch (e) { alert('That file is not valid JSON.'); return; }
    // Plausible-shape check before validating the routine within.
    if (!parsed || typeof parsed !== 'object' || !parsed.settings || !parsed.routine) {
      alert('That does not look like a Tumble Trainer backup.'); return;
    }
    const v = validateRoutine(parsed.routine);
    if (!v.valid) { alert('Backup routine failed validation:\n\n' + v.errors.join('\n')); return; }
    if (!confirm('Importing will overwrite ALL current data. Continue?')) return;
    state = normalizeState(parsed);
    ui.expanded.clear();
    ui.finishing = false;
    saveState();
    render();
  };
  reader.readAsText(file);
}

async function clearData() {
  if (!confirm('Erase all data and reset to the default routine?')) return;
  localStorage.removeItem(V2_KEY);
  localStorage.removeItem(V1_KEY);
  if (!SEED_ROUTINE) SEED_ROUTINE = await loadSeed();
  state = freshState(deepClone(SEED_ROUTINE));
  ui.expanded.clear();
  ui.finishing = false;
  saveState();
  render();
}

function pushHistory(routine) {
  state.routineHistory.unshift({ timestamp: new Date().toISOString(), routine: deepClone(routine) });
  state.routineHistory = state.routineHistory.slice(0, 10);
}

function rollback(hidx) {
  const entry = state.routineHistory[hidx];
  if (!entry) return;
  if (!confirm('Roll back to this routine version?')) return;
  pushHistory(state.routine);            // current becomes undoable
  state.routine = deepClone(entry.routine);
  state.swaps = {};                      // a routine change may invalidate swap/dismissed keys
  state.dismissed = {};
  saveState();
  render();
}

function saveRoutineFromEditor() {
  const ta = document.getElementById('routine-json');
  const errBox = document.getElementById('routine-errors');
  let parsed;
  try { parsed = JSON.parse(ta.value); }
  catch (e) { errBox.textContent = 'JSON parse error: ' + e.message; errBox.classList.add('show'); return; }
  const v = validateRoutine(parsed);
  if (!v.valid) {
    errBox.innerHTML = v.errors.map(escapeHtml).join('<br>');
    errBox.classList.add('show');
    return;
  }
  pushHistory(state.routine);
  state.routine = parsed;
  saveState();
  render();   // re-renders settings with the new pretty-printed JSON + cleared errors
}

/* --- 10. Heuristics (Phase 4 — deterministic, offline, no LLM) ------------ *
 * All suggestions, never silent changes. Every function here is pure (takes
 * log/state as args) so the smoke test can exercise them directly.
 * Heuristic #3 (variety guarantee) lives in section 4 (selectVariety).
 *
 * Dismissal / re-show policy: dismissing a suggestion records the current
 * session index in state.dismissed[key]. The SAME key stays suppressed until
 * DISMISS_COOLDOWN more sessions have been finished (session index advances by
 * one per finish). If the underlying condition changes the key itself changes
 * (keys embed the target knob/value or the skipped name), so a genuinely new
 * suggestion always shows immediately regardless of cooldown.
 */

const DISMISS_COOLDOWN = 3;                    // sessions to suppress an identical dismissed key
// v3.0: two knobs remain — the unified moves count and the cool-down length.
const ALL_KNOBS = ['moves', 'cool'];
// Only "moves" is an effort knob the nudge raises; cool-down is structural.
const RAISE_KNOBS = ['moves'];
const KNOB_LABEL = { moves: 'number of moves', cool: 'cool-down' };

function sliderRanges(routine) {
  return (routine && routine.structure && routine.structure.sliders) || DEFAULT_RANGES;
}

// Fraction (0..1) of an entry's exercises marked done. Empty entry => 0.
function sessionCompletion(entry) {
  const ex = (entry && entry.exercises) || [];
  if (!ex.length) return 0;
  return ex.filter((e) => e.done).length / ex.length;
}

// name -> knob map, derived from the routine so old logs still resolve. v3.0:
// every selectable move maps to the single "moves" knob; cool-down to "cool".
function buildKnobMap(routine) {
  const b = (routine && routine.blocks) || {};
  const map = {};
  const add = (arr, knob) => (arr || []).forEach((ex) => { if (ex && ex.name) map[ex.name] = knob; });
  add(b.moves, 'moves');
  add(b.cooldown, 'cool');   // warmup intentionally omitted (static, no knob)
  // Tolerate pre-v3.0 logs whose names still live under the old block shape.
  if (b.skill) { add(b.skill.staples, 'moves'); add(b.skill.varietyPool, 'moves'); }
  if (b.core) { add(b.core.staples, 'moves'); add(b.core.varietyPool, 'moves'); }
  add(b.weightsA, 'moves'); add(b.weightsB, 'moves');
  add(b.machinesA, 'moves'); add(b.machinesB, 'moves');
  return map;
}

function sameKnobs(a, b, keys) {
  return !!a && !!b && keys.every((k) => a[k] === b[k]);
}

// v4.1/v4.2: a session finished under a non-default intent, readiness, OR an active region
// status (all stamped on the entry by finishSession) was deliberately lighter/filtered — it
// says nothing about whether the base sliders fit, so the volume nudge skips it both ways.
function unmodifiedEntry(e) {
  return !!e && !e.intent && !e.readiness && !e.regionStatus;
}

// Lowest-value raisable knob (most room to grow); tie-break by RAISE_KNOBS order.
function pickRaiseKnob(settings, ranges) {
  const cands = RAISE_KNOBS.filter((k) => settings[k] < (ranges[k] || DEFAULT_RANGES[k])[1]);
  if (!cands.length) return null;
  cands.sort((x, y) => (settings[x] - settings[y]) || (RAISE_KNOBS.indexOf(x) - RAISE_KNOBS.indexOf(y)));
  return cands[0];
}

// Least-completed lowerable block's knob across the given entries; tie-break by ALL_KNOBS order.
function pickLowerKnob(entries, routine, settings, ranges) {
  const knobMap = buildKnobMap(routine);
  const agg = {};   // knob -> { done, total }
  entries.forEach((e) => (e.exercises || []).forEach((ex) => {
    const knob = knobMap[ex.name];
    if (!knob) return;
    agg[knob] = agg[knob] || { done: 0, total: 0 };
    agg[knob].total++;
    if (ex.done) agg[knob].done++;
  }));
  const cands = Object.keys(agg).filter((k) => settings[k] > (ranges[k] || DEFAULT_RANGES[k])[0]);
  if (!cands.length) return null;
  cands.sort((x, y) =>
    (agg[x].done / agg[x].total) - (agg[y].done / agg[y].total) ||
    (ALL_KNOBS.indexOf(x) - ALL_KNOBS.indexOf(y)));
  return cands[0];
}

/*
 * Heuristic #1 — volume nudge. Returns a suggestion object or null.
 *   RAISE: last 3 logged sessions all 100% AND all logged at the CURRENT slider
 *          values (so the streak really reflects today's load) -> raise a knob.
 *   LOWER: last 2 logged sessions both < 60% complete -> lower the least-
 *          completed block's knob.
 *   Sessions stamped with a non-default intent/readiness are excluded from both
 *   (a cleared "short" session is not a mandate to raise the base slider).
 */
function volumeNudge(st) {
  const log = st.log || [];
  const s = st.settings;
  const ranges = sliderRanges(st.routine);

  if (log.length >= 3) {
    const last3 = log.slice(-3);
    const all100 = last3.every((e) => sessionCompletion(e) >= 1);
    const sameLoad = last3.every((e) => sameKnobs(e.settings, s, ALL_KNOBS) && unmodifiedEntry(e));
    if (all100 && sameLoad) {
      const knob = pickRaiseKnob(s, ranges);
      if (knob) {
        const target = s[knob] + 1;
        return {
          kind: 'raise', knob: knob, target: target,
          key: 'raise:' + knob + ':' + target,
          text: "You've cleared everything 3 sessions running — raise " + KNOB_LABEL[knob] + ' to ' + target + '?',
          applyLabel: 'Raise to ' + target
        };
      }
    }
  }

  if (log.length >= 2) {
    const last2 = log.slice(-2);
    if (last2.every((e) => unmodifiedEntry(e) && sessionCompletion(e) < 0.6)) {
      const knob = pickLowerKnob(last2, st.routine, s, ranges);
      if (knob) {
        const target = s[knob] - 1;
        return {
          kind: 'lower', knob: knob, target: target,
          key: 'lower:' + knob + ':' + target,
          text: 'Only partly finishing lately — ease ' + KNOB_LABEL[knob] + ' down to ' + target + '?',
          applyLabel: 'Lower to ' + target
        };
      }
    }
  }
  return null;
}

// The most-recent `k` appearances of `name` in the log (most-recent first).
function recentAppearances(name, log, k) {
  const apps = [];
  for (let i = log.length - 1; i >= 0 && apps.length < k; i--) {
    const e = (log[i].exercises || []).find((x) => x.name === name);
    if (e) apps.push(e);
  }
  return apps;
}

// Heuristic #2 predicate: skipped in 2+ of its last 3 appearances (needs >=2 appearances).
function skippedRecently(name, log) {
  const apps = recentAppearances(name, log, 3);
  if (apps.length < 2) return false;
  return apps.filter((a) => !a.done).length >= 2;
}

// All goal/care ids a move touches — training goals it scores on, plus care tags.
function moveGoalIds(ex) {
  return Object.keys((ex && ex.goalScores) || {}).concat((ex && ex.care) || []);
}

/*
 * Pick a replacement for a skipped move (v3.0). Candidates come from blocks.moves,
 * share at least one goal/care id with the skipped move, aren't hard-avoided by a tag,
 * have a positive goal-weighted score, and aren't already shown/proposed/itself. Ranked
 * least-recently-completed (consistent with the variety guarantee), pool order.
 */
function pickReplacement(name, st, shownNames, proposed, day) {
  const routine = st.routine;
  const base = findExerciseByName(routine, name);
  if (!base) return null;
  const baseIds = moveGoalIds(base);
  const log = st.log || [];
  const goals = ((routine && routine.goals) || []).filter((g) => g && g.kind === 'training');
  const pool = (routine.blocks && routine.blocks.moves) || [];
  const cands = [];
  pool.forEach((ex) => {
    if (!ex || ex.name === name) return;
    if (!moveGoalIds(ex).some((g) => baseIds.indexOf(g) !== -1)) return;
    if (tagScoreFactor(ex, routine, st.settings || {}, day).excluded) return;
    if (scoreMove(ex, goals) <= 0) return;
    if (shownNames.has(ex.name) || proposed.has(ex.name)) return;
    if (!cands.some((c) => c.name === ex.name)) cands.push(ex);
  });
  if (!cands.length) return null;
  return leastRecentlyCompleted(cands, log)[0].name;
}

// Heuristic #2 — one swap suggestion per currently-shown, recently-skipped exercise.
function skipSuggestions(st, build) {
  const log = st.log || [];
  if (!build || !log.length) return [];
  const shownNames = new Set();
  build.blocks.forEach((bl) => bl.exercises.forEach((ex) => shownNames.add(ex.name)));

  const out = [];
  const proposed = new Set();   // don't propose the same replacement for two skips
  build.blocks.forEach((bl) => {
    if (bl.key === 'warmup') return;
    bl.exercises.forEach((ex) => {
      if (st.swaps && st.swaps[ex.name]) return;      // already swapped this session
      if (!skippedRecently(ex.name, log)) return;
      const rep = pickReplacement(ex.name, st, shownNames, proposed, build.day);
      if (!rep) return;
      proposed.add(rep);
      out.push({
        kind: 'swap', name: ex.name, replacement: rep,
        key: 'swap:' + ex.name,
        text: 'You keep skipping ' + ex.name + '. Swap in ' + rep + ' instead?',
        applyLabel: 'Swap in ' + rep
      });
    });
  });
  return out;
}

/*
 * Heuristic #4 predicate: exercise completed 4+ times at the CURRENT effective
 * intensity (sets+amount+unit+weight). Bumping reps OR weight changes `cur`, so
 * the count naturally resets at the new level.
 */
function progressionReady(name, cur, log) {
  const entries = log || [];
  // v4.2: the most recent session that actually completed this move gates progression — if
  // the athlete flagged that session yellow/red (24h feedback), hold the pip. Green, a
  // dismissed prompt, or an unanswered session leaves progression unaffected.
  for (let i = entries.length - 1; i >= 0; i--) {
    if ((entries[i].exercises || []).some((e) => e.name === name && e.done)) {
      const fb = entries[i].feedback;
      if (fb && (fb.light === 'yellow' || fb.light === 'red')) return false;
      break;   // only the most-recent completing session counts
    }
  }
  let n = 0;
  entries.forEach((entry) => (entry.exercises || []).forEach((e) => {
    if (e.name === name && e.done && e.dose &&
        e.dose.sets === cur.sets && e.dose.amount === cur.amount && e.dose.unit === cur.unit &&
        (e.dose.weight || null) === (cur.weight || null)) {
      n++;
    }
  }));
  return n >= 4;
}

// Is `key` currently suppressed by a recent dismissal? (see policy note above)
function isDismissed(key, st) {
  const d = st.dismissed || {};
  if (!(key in d)) return false;
  return (st.session - d[key]) < DISMISS_COOLDOWN;
}

// The suggestion banners to show for the current session, minus dismissed ones.
function computeSuggestions(st, build) {
  const list = [];
  const vol = volumeNudge(st);
  if (vol && !isDismissed(vol.key, st)) list.push(vol);
  skipSuggestions(st, build).forEach((sg) => { if (!isDismissed(sg.key, st)) list.push(sg); });
  return list;
}

// Apply: volume nudge writes the slider (user-owned knob); swap records a
// per-session substitution (state.routine is never touched).
function applySuggestion(i) {
  const sg = renderedSuggestions[i];
  if (!sg) return;
  if (sg.kind === 'raise' || sg.kind === 'lower') {
    state.settings[sg.knob] = sg.target;
  } else if (sg.kind === 'swap') {
    state.swaps = state.swaps || {};
    state.swaps[sg.name] = sg.replacement;
  }
  saveState();
  render();
}

function dismissSuggestion(i) {
  const sg = renderedSuggestions[i];
  if (!sg) return;
  state.dismissed = state.dismissed || {};
  state.dismissed[sg.key] = state.session;
  saveState();
  render();
}

/* --- 9. Service worker + init -------------------------------------------- */

function registerSW() {
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline-first still fine */ });
  }
}

async function init() {
  // Load the seed up front so normalizeState's v2->v2.3 migration can retag
  // stored moves by name and rebuild routine.goals from it.
  SEED_ROUTINE = await loadSeed();
  const raw = localStorage.getItem(V2_KEY);
  if (raw) {
    try { state = normalizeState(JSON.parse(raw)); }
    catch (e) { state = freshState(deepClone(SEED_ROUTINE)); }
    if (!state.routine || !state.routine.blocks) {
      state.routine = deepClone(SEED_ROUTINE);
    }
  } else {
    const v1raw = localStorage.getItem(V1_KEY);
    if (v1raw) {
      try { state = migrateFromV1(JSON.parse(v1raw), deepClone(SEED_ROUTINE)); }
      catch (e) { state = freshState(deepClone(SEED_ROUTINE)); }
    } else {
      state = freshState(deepClone(SEED_ROUTINE));
    }
    saveState();
  }

  // v3.6: ask the browser to mark this origin's storage persistent so the
  // localStorage progression data isn't evicted under pressure (esp. Android).
  // Fire-and-forget, guarded — no UI, and it's a no-op where unsupported.
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  } catch (e) { /* storage API absent / blocked — app still works this session */ }

  const app = document.getElementById('app');
  app.addEventListener('click', onClick);
  app.addEventListener('change', onChange);
  render();
  registerSW();
}

// A failed init (e.g. seed fetch blocked on the file:// protocol) must show a
// message, not a blank page.
function initFailed(e) {
  const app = document.getElementById('app');
  const overFile = location.protocol === 'file:';
  app.innerHTML =
    '<div class="init-error">' +
    '<h2>Couldn’t start Tumble Trainer</h2>' +
    (overFile
      ? '<p>This app can’t run from a <code>file://</code> URL — the browser blocks loading its data files. Serve the folder over HTTP instead, e.g.</p>' +
        '<pre>python -m http.server 8080</pre>' +
        '<p>then open <code>http://localhost:8080</code>.</p>'
      : '<p>' + escapeHtml(e && e.message ? e.message : String(e)) + '</p><p>Try reloading.</p>') +
    '</div>';
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => init().catch(initFailed));
}

// Expose a small, stable API for Phase 5 (LLM flow) and testing.
if (typeof window !== 'undefined') {
  window.TumbleTrainer = {
    validateRoutine,
    buildSession: () => buildSession(state),
    buildFutureSession: (offset) => buildFutureSession(state, offset),
    getState: () => state
  };
}

// Node smoke-test hook (kept out of the browser path).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    validateRoutine, formatDose, effectiveDose, buildSession, buildFutureSession,
    migrateFromV1, freshState, currentDay,
    // v3.0 — goal-weighted generator (pure)
    goalActive, trainingGoals, scoreMove, selectMoves, topGoalId,
    // v4.0 (Phase 2) — generator v2 pure helpers (metadata accessors, budgets, coverage, ordering, pairing)
    moveLoad, moveFatigue, moveFamilyId, moveFamilyEntry, moveFamilyRank, moveMaxPerFamily, isArmSupport,
    weeklyClasses, sessionBudgets, bustsBudget, coverageBoost, activeSlotCount, orderByPhase, supersetPairOk,
    // v4.1 (Phase 3) — readiness check-in + session intents (pure)
    defaultReadiness, normalizeReadiness, readinessIsDefault, unmodifiedEntry,
    sessionIntent, readinessCaps, passesReadiness, effectiveMoveBudget,
    // v4.2 (Phase 4) — 24h feedback loop (pure)
    normalizeRegionStatus, moveImplicated, doseCutLevel, feedbackPromptEntry, REGION_KEYS,
    // v3.7 — generic tag system (pure)
    tagIndex, tagMultiplier, tagEffectivePriority, tagScoreFactor, defaultTagPriority,
    slugify, uniqueTagId,
    cardGoalIds, moveChipIds, moveGoalIds, buildCooldown,
    progressionParams, progressionLadder, currentLevel, restTarget,
    migrateRoutine, migrateRoutineV3, migrateRoutineV4, migrateRoutineV5, migrateRoutineV6, migrateRoutineV7, migrateRoutineV8, migrateRoutineV9, migrateRoutineV10, migrateRoutineV11, migrateRoutineV12, migrateRoutineV13, migrateRoutineV14, migrateRoutineV15, insertSeedMove, renameWarmupGroups, warmupGroups, isLegacyRoutine, migrateIntensity, normalizeState,
    // v2.5 Auto Superset (pure grouping + plan); v3.5 adds the bias predicate; v4.0 shares supersetPairOk (above)
    groupSupersets, supersetPlan, supersetRestTarget, wouldSuperset,
    // Phase 4 heuristics (pure — take log/state as args)
    leastRecentlyCompleted, lastCompletedIndex, sessionCompletion, buildKnobMap,
    volumeNudge, pickRaiseKnob, pickLowerKnob, skippedRecently, skipSuggestions,
    pickReplacement, progressionReady, isDismissed, computeSuggestions,
    findExerciseByName, collectPools, recentAppearances,
    // v3.9 Coach (pure-ish — applyCoachTool mutates the trial it's given)
    applyCoachTool, coachTrialBase, coachMarkdown, COACH_TOOLS,
    _ui: ui,
    _set: (s) => { state = s; },
    _setSeed: (s) => { SEED_ROUTINE = s; }
  };
}
