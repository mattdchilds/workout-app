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

// Amount units the app understands. "sec/side" behaves like "sec".
const UNITS = ['sec', 'sec/side', 'reps', 'reps/side', 'min'];

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
  adjustOpen: false               // v3.4: Gym-tab "Adjust session" panel open/collapsed (transient)
};

function freshState(routine) {
  return {
    version: 2,
    session: 1,                   // Session 1 = Day A (A on odd sessions)
    view: 'today',
    // v3.0: ONE "moves" slider = total goal-weighted moves per session; the four
    // per-block sliders (skill/core/wts/mach) collapsed into it. Default 10.
    // v3.4/v3.6: two independent joint-friendly toggles restrict generation — legs
    // (knees/ankles) and arms (shoulders/elbows/wrists), each default off. See selectMoves.
    // v3.5: supersetBias 0–10 nudges the generator toward moves that pair into
    // supersets (default 5; 0 = old behavior). See selectMoves.
    settings: { moves: 10, cool: 2, jointFriendlyLegs: false, jointFriendlyArms: false, supersetBias: 5 },
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
    view: ['today', 'daily', 'moves', 'settings'].indexOf(obj.view) >= 0 ? obj.view : 'today'
  });
  delete merged.settings.aerial;   // obsolete — aerial is now a goal

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
  // v3.4/v3.6: joint-friendly is now two independent session toggles (legs / arms), each
  // default off. Migrate the old single boolean: jointFriendly:true -> both on; then drop
  // the retired key.
  if (typeof merged.settings.jointFriendly === 'boolean') {
    if (merged.settings.jointFriendly) {
      merged.settings.jointFriendlyLegs = true;
      merged.settings.jointFriendlyArms = true;
    }
    delete merged.settings.jointFriendly;
  }
  merged.settings.jointFriendlyLegs = !!merged.settings.jointFriendlyLegs;
  merged.settings.jointFriendlyArms = !!merged.settings.jointFriendlyArms;
  // v3.5: superset bias — integer 0–10 (default 5). Missing / non-number → 5; clamp + int.
  merged.settings.supersetBias = typeof merged.settings.supersetBias === 'number'
    ? clamp(merged.settings.supersetBias | 0, 0, 10) : 5;

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
 * map (trainingGoalId -> integer 0..10), and an optional `care` array of care-goal
 * ids. warmup/cooldown entries keep a `goals` tag array. Extra fields (group,
 * rest, progression, dayLock, tempoNote, alwaysInShort, muscle) are allowed.
 */
const SECTIONS = ['floor', 'weights', 'machines'];

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
    // (Moves tab toggle). v3.6: optional `jointStress` array marks which joint region(s)
    // a move loads ('legs' and/or 'arms'); absent/empty = safe both ways. Accept the
    // field absent; reject a non-array or an unknown region value.
    if ('disabled' in ex && typeof ex.disabled !== 'boolean') {
      errors.push(path + ' (' + label + '): disabled must be a boolean');
    }
    if ('jointStress' in ex) {
      if (!Array.isArray(ex.jointStress)) {
        errors.push(path + ' (' + label + '): jointStress must be an array of "legs"/"arms"');
      } else {
        ex.jointStress.forEach((v) => {
          if (v !== 'legs' && v !== 'arms') {
            errors.push(path + ' (' + label + '): jointStress has unknown region "' + v + '"');
          }
        });
      }
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

// v3.0 eligibility for the STATIC blocks (warm-up / cool-down): dayLock only.
// Their care tags are always active, and training moves are filtered by score.
function eligible(ex, day) {
  return !ex.dayLock || ex.dayLock === day;
}

// v3.6: does a move load the given joint region? `jointStress` is an optional array of
// 'legs' (knees/ankles) and/or 'arms' (shoulders/elbows/wrists); absent/empty = safe.
function jointStresses(ex, region) {
  return !!(ex && Array.isArray(ex.jointStress) && ex.jointStress.indexOf(region) !== -1);
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
 * other move costs one. Grouping mirrors supersetPlan (groupSupersets over the Floor
 * moves that carry a `muscle`, in pool order), so selection and rendering agree. Pure.
 */
function sessionMoveCost(moves, autoSuperset) {
  if (!autoSuperset) return (moves || []).length;
  const floorMembers = (moves || [])
    .filter((ex) => ex && (ex.section || 'floor') === 'floor' && ex.muscle)
    .map((ex) => ({ ex: ex, block: 'floor' }));
  const grouped = new Set();
  groupSupersets(floorMembers).forEach((g) => {
    if (g.members.length >= 2) g.members.forEach((m) => grouped.add(m.ex));
  });
  let cost = 0;
  (moves || []).forEach((ex) => { cost += grouped.has(ex) ? 0.5 : 1; });
  return cost;
}

/*
 * v3.0 move selection (replaces the staple/variety machinery). Pure given `st`.
 *   1. Pool = blocks.moves eligible for the day (dayLock).
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
  // v3.4/v3.6: drop moves the user disabled in the Moves tab, and — per the two
  // joint-friendly toggles — any move that stresses a region whose toggle is on (a move
  // that stresses neither, e.g. most moves, is always allowed). Then apply the day
  // (dayLock) filter as before.
  const sfLegs = !!(st.settings && st.settings.jointFriendlyLegs);
  const sfArms = !!(st.settings && st.settings.jointFriendlyArms);
  const pool = (b.moves || []).filter((ex) =>
    ex && !ex.disabled &&
    !(sfLegs && jointStresses(ex, 'legs')) &&
    !(sfArms && jointStresses(ex, 'arms')) &&
    eligible(ex, currentDay(st.session)));
  const goals = ((st.routine && st.routine.goals) || []).filter((g) => g && g.kind === 'training');
  const log = st.log || [];
  const count = Math.max(st.settings.moves || 0, 0);

  const scored = [];
  pool.forEach((move, i) => {
    const base = scoreMove(move, goals);
    if (base <= 0) return;
    const last = lastCompletedIndex(move.name, log);
    const sessionsSince = last < 0 ? 6 : Math.min(log.length - last, 6);
    scored.push({ move, i, section: move.section || 'floor', effective: base * (1 + 0.1 * sessionsSince) });
  });

  const remaining = scored.slice();
  const sectionCount = {};
  const chosen = [];
  // v3.2: superset members each cost half a move toward the budget (see
  // sessionMoveCost), so a supersetting session pulls in more actual moves. Cost is
  // measured over the chosen moves in pool order (matching how they render).
  const autoSuperset = st.autoSuperset !== false;
  // v3.5: superset bias (settings.supersetBias, 0–10, default 5). While Auto superset
  // is on, a candidate Floor move that would land in a superset group (>= 2) with the
  // already-chosen moves has its score multiplied by (1 + 0.1 * bias) — bias 10 = 2x,
  // bias 0 = no change (so bias 0 reproduces pre-v3.5 selection byte-for-byte). The
  // pair test (wouldSuperset) mirrors render-time grouping exactly; O(n^2) over the
  // small move pool is fine.
  const bias = (st.settings && typeof st.settings.supersetBias === 'number') ? st.settings.supersetBias : 5;
  const biasOn = autoSuperset && bias > 0;
  const underBudget = () =>
    sessionMoveCost(chosen.slice().sort((a, b2) => a.i - b2.i).map((o) => o.move), autoSuperset) < count;
  while (underBudget() && remaining.length) {
    let best = -1, bestVal = -Infinity;
    for (let k = 0; k < remaining.length; k++) {
      const c = remaining[k];
      let val = c.effective * Math.pow(SECTION_DECAY, sectionCount[c.section] || 0);
      if (biasOn && wouldSuperset(chosen, c)) val *= (1 + 0.1 * bias);
      // Strictly-greater wins; exact ties fall to the earlier pool index (stable).
      if (val > bestVal || (val === bestVal && c.i < remaining[best].i)) { bestVal = val; best = k; }
    }
    const pick = remaining.splice(best, 1)[0];
    sectionCount[pick.section] = (sectionCount[pick.section] || 0) + 1;
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
  let list = (arr || []).filter((ex) => eligible(ex, day));
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
      exercises: (b.warmup || []).filter((ex) => eligible(ex, day)) });
  }

  const selected = selectMoves(st);
  MOVE_SECTIONS.forEach((sec) => {
    const exercises = selected.filter((ex) => (ex.section || 'floor') === sec.key);
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
  if (!level) return { sets: d.sets, amount: d.amount, unit: d.unit, weight: d.weight };
  const ladder = progressionLadder(ex);
  const entry = ladder[clamp(level, 0, ladder.length - 1)];
  return { sets: entry.sets, amount: entry.amount, unit: d.unit, weight: entry.weight, overridden: true };
}

// "3 × 30 sec" / "3 × 15 reps/side" / "1 × 20 sec/side" / "3 × 8 reps @ 180 lb".
function formatDose(eff) {
  return eff.sets + ' × ' + eff.amount + ' ' + eff.unit +
    (eff.weight != null ? ' @ ' + eff.weight + ' lb' : '');
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
 * onChange handlers (setting / goal-weight / toggle-joint-friendly), each of which
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
      renderJointFriendlyField() +
      renderSupersetBiasField() +
      '<div class="adjust-goals-head">Goal weights</div>' +
      renderGoalWeightSliders() +
      '</div>';
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
  // Suggestions (incl. swap chips) are interactive — hide them while previewing.
  if (!preview) html += renderSuggestions(build);
  // v3.4: collapsible "Adjust session" — the same sliders/toggles as Settings, live in
  // the Gym tab so tuning immediately re-generates the session below. Hidden in preview.
  if (!preview) html += renderAdjustPanel();

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
      if (g.members.some((x) => x.ex.muscle === m.ex.muscle)) continue;          // muscle clash
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
 * it in a superset group of >= 2? Mirrors render-time grouping: the chosen floor+muscle
 * moves plus the candidate, ordered by pool index, mapped to { ex, block:'floor' } and
 * run through groupSupersets; true iff the candidate's resulting group has >= 2 members.
 * Non-Floor / muscle-less candidates never pair (return false).
 */
function wouldSuperset(entries, cand) {
  if (!cand || !cand.move || (cand.move.section || 'floor') !== 'floor' || !cand.move.muscle) return false;
  const floor = (entries || [])
    .filter((o) => o && o.move && (o.move.section || 'floor') === 'floor' && o.move.muscle)
    .concat([cand])
    .sort((a, b) => a.i - b.i)
    .map((o) => ({ ex: o.move, block: 'floor' }));
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
    return '<li class="ss-move">' +
      '<span class="ss-move-name">' + escapeHtml(ex.name) +
        (over ? ' <span class="mod">modified</span>' : '') + '</span>' +
      '<span class="ss-move-dose">' + escapeHtml(formatDose(effectiveDose(ex))) + '</span>' +
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
          '<div class="dose">' + escapeHtml(formatDose(eff)) + '</div>' +
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
  const ready = progressionReady(ex.name, effectiveDose(ex), state.log || []);
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
  if (m.muscle) meta.push('muscle: ' + escapeHtml(m.muscle));
  if (m.dayLock) meta.push('day ' + escapeHtml(m.dayLock));
  // v3.6: flag which joint region(s) a move loads — it drops out when that toggle is on.
  if (jointStresses(m, 'legs')) meta.push('<span class="mv-flag-warn">stresses knees/ankles</span>');
  if (jointStresses(m, 'arms')) meta.push('<span class="mv-flag-warn">stresses shoulders/elbows/wrists</span>');
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
    '<div class="field"><label for="mv-daylock">Day</label><select id="mv-daylock">' +
      '<option value="">Both</option><option value="A">A only</option><option value="B">B only</option>' +
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
  // v3.6: polarity flip vs the old single "is friendly" checkbox — each box now marks a
  // region the move STRESSES (both off = jointStress omitted, i.e. safe both ways).
  h += '<div class="field toggle"><label for="mv-joint-legs">Stresses knees/ankles</label>' +
    '<input type="checkbox" id="mv-joint-legs"></div>';
  h += '<div class="field toggle"><label for="mv-joint-arms">Stresses shoulders/elbows/wrists</label>' +
    '<input type="checkbox" id="mv-joint-arms"></div>';
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
  const day = g('mv-daylock').value;
  if (day === 'A' || day === 'B') move.dayLock = day;
  // v3.6: the two "stresses X" checkboxes write the jointStress array; both off omits it.
  const stress = [];
  const jLegs = g('mv-joint-legs');
  const jArms = g('mv-joint-arms');
  if (jLegs && jLegs.checked) stress.push('legs');
  if (jArms && jArms.checked) stress.push('arms');
  if (stress.length) move.jointStress = stress;

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

// Joint-friendly toggles (v3.4; split legs/arms in v3.6). Each hides moves that stress
// its region from generation. data-region tells the shared onChange which toggle fired.
function renderJointFriendlyField() {
  return '<div class="field toggle">' +
    '<label for="joint-friendly-legs">Joint-friendly: legs (knees/ankles)</label>' +
    '<input type="checkbox" id="joint-friendly-legs" data-action="toggle-joint-friendly" data-region="legs"' +
      (state.settings.jointFriendlyLegs ? ' checked' : '') + '>' +
    '</div>' +
    '<div class="field toggle">' +
    '<label for="joint-friendly-arms">Joint-friendly: arms (shoulders/elbows/wrists)</label>' +
    '<input type="checkbox" id="joint-friendly-arms" data-action="toggle-joint-friendly" data-region="arms"' +
      (state.settings.jointFriendlyArms ? ' checked' : '') + '>' +
    '</div>';
}

// Auto-superset toggle.
function renderAutoSupersetField() {
  return '<div class="field toggle">' +
    '<label for="auto-superset">Auto superset</label>' +
    '<input type="checkbox" id="auto-superset" data-action="toggle-superset"' +
      (state.autoSuperset ? ' checked' : '') + '>' +
    '</div>';
}

// Superset-bias slider (v3.5): 0–10, higher = the generator prefers moves that pair
// into supersets (applies only while Auto superset is on). Range is hard-coded 0–10 —
// NOT sourced from routine.structure.sliders — and shows its value like a goal slider.
function renderSupersetBiasField() {
  const val = clamp(typeof state.settings.supersetBias === 'number' ? state.settings.supersetBias : 5, 0, 10);
  return '<div class="field">' +
    '<label>Superset bias <span class="val">' + val + '</span></label>' +
    '<input type="range" data-action="setting" data-key="supersetBias" min="0" max="10" step="1" value="' + val + '">' +
    '</div>';
}

/* --- Settings view -------------------------------------------------------- */

function renderSettings() {
  let html = '<div class="settings">';

  // Session knobs (v3.0: one unified "moves" slider + cool-down; v3.4 adds the
  // joint-friendly toggle beside auto superset).
  html += '<section class="panel"><h3>Session</h3>' +
    renderSettingSlider('moves', 'Number of moves') +
    renderSettingSlider('cool', 'Cool-down (1 = short, 2 = full)') +
    renderJointFriendlyField() +
    renderAutoSupersetField() +
    renderSupersetBiasField() +
    '<p class="muted">Joint-friendly mode limits the session to moves that are easy on ' +
      'recovering joints. Auto superset groups same-muscle-free Floor moves into supersets — ' +
      'one card, alternate the moves, rest after each round. ' +
      'Higher superset bias makes the generator prefer moves that pair into supersets; ' +
      'it only applies while Auto superset is on.</p>' +
    '</section>';

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
    case 'toggle-block': toggleBlock(el.dataset.block); break;               // v3.6 collapse a session block
    case 'export': exportState(); break;
    case 'clear': clearData(); break;
    case 'rollback': rollback(+el.dataset.hidx); break;
    case 'save-routine': saveRoutineFromEditor(); break;
    case 'suggest-apply': applySuggestion(+el.dataset.sidx); break;
    case 'suggest-dismiss': dismissSuggestion(+el.dataset.sidx); break;
    case 'mv-delete': deleteMove(+el.dataset.idx); break;   // idx into renderedMoves
    case 'mv-add': addMove(); break;
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
  } else if (action === 'toggle-joint-friendly') {
    // v3.6: one handler for both region toggles; data-region says which one fired.
    if (el.dataset.region === 'legs') state.settings.jointFriendlyLegs = el.checked;
    else if (el.dataset.region === 'arms') state.settings.jointFriendlyArms = el.checked;
    saveState();
    render();
  } else if (action === 'mv-toggle') {
    toggleMoveDisabled(+el.dataset.idx);         // v3.4 Moves-tab enable/disable
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
      entry.exercises.push({
        name: ex.name,
        goals: (ex.goals || []).slice(),
        dose: dose,
        done: !!state.checks[ex.name]
      });
    });
  });
  if (note) entry.note = note;

  state.log.push(entry);
  state.session += 1;
  state.checks = {};
  state.collapsed = {};          // v3.6: a fresh session starts with every block expanded
  state.swaps = {};              // Phase 4: swaps are per-session trials — clear on finish
  state.setsDone = {};           // Feature E: per-session, cleared on finish
  state.rest = { name: null, startedAt: null };
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
 */
function volumeNudge(st) {
  const log = st.log || [];
  const s = st.settings;
  const ranges = sliderRanges(st.routine);

  if (log.length >= 3) {
    const last3 = log.slice(-3);
    const all100 = last3.every((e) => sessionCompletion(e) >= 1);
    const sameLoad = last3.every((e) => sameKnobs(e.settings, s, ALL_KNOBS));
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
    if (last2.every((e) => sessionCompletion(e) < 0.6)) {
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
 * share at least one goal/care id with the skipped move, are day-eligible, have a
 * positive goal-weighted score, and aren't already shown/proposed/itself. Ranked
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
    if (!eligible(ex, day)) return;
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
  let n = 0;
  (log || []).forEach((entry) => (entry.exercises || []).forEach((e) => {
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
    eligible, jointStresses, goalActive, trainingGoals, scoreMove, selectMoves, topGoalId,
    cardGoalIds, moveChipIds, moveGoalIds, buildCooldown,
    progressionParams, progressionLadder, currentLevel, restTarget,
    migrateRoutine, migrateRoutineV3, migrateRoutineV4, migrateRoutineV5, migrateRoutineV6, migrateRoutineV7, migrateRoutineV8, migrateRoutineV9, migrateRoutineV10, insertSeedMove, renameWarmupGroups, warmupGroups, isLegacyRoutine, migrateIntensity, normalizeState,
    // v2.5 Auto Superset (pure grouping + plan); v3.5 adds the bias predicate
    groupSupersets, supersetPlan, supersetRestTarget, wouldSuperset,
    // Phase 4 heuristics (pure — take log/state as args)
    leastRecentlyCompleted, lastCompletedIndex, sessionCompletion, buildKnobMap,
    volumeNudge, pickRaiseKnob, pickLowerKnob, skippedRecently, skipSuggestions,
    pickReplacement, progressionReady, isDismissed, computeSuggestions,
    findExerciseByName, collectPools, recentAppearances,
    _ui: ui,
    _set: (s) => { state = s; },
    _setSeed: (s) => { SEED_ROUTINE = s; }
  };
}
