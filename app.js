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
 *  11. LLM integration  (Phase 5 — callClaude, 5a edit flow + diff, 5b Ask)
 *   9. Service worker + init
 *
 * Phase 4/5 implementers: the two clean seams are
 *   - selectVariety()  — swap in "least-recently-completed" logic from state.log
 *   - validateRoutine() — already exported for the LLM edit flow
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
  { id: 'today', label: 'Today' },
  { id: 'edit', label: 'Edit' },      // Phase 5a — natural-language routine editing
  { id: 'ask', label: 'Ask' },        // Phase 5b — technique/planning chat
  { id: 'settings', label: 'Settings' }
];

// Phase 5 (LLM): model choice. Default is fast/cheap Haiku; Sonnet is the
// "correctness wins" toggle for structurally sloppy edits (per spec).
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MODELS = [
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — fast (default)' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 — slower, sharper' }
];

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
// v3.1 day preview: how many sessions ahead the Today view is peeking. TRANSIENT —
// never persisted, never migrated; reset to 0 on finish. 0 = today (live, editable).
let previewOffset = 0;
const PREVIEW_MAX = 13;            // cap: peek up to ~2 weeks ahead
function inPreview() { return previewOffset > 0; }
const ui = {
  expanded: new Set(),
  finishing: false,
  // Phase 5 (LLM) — all in-memory, never persisted.
  llm: {
    editInput: '',        // free-text edit instruction (survives re-render / prefill from Ask)
    editStatus: 'idle',   // 'idle' | 'loading' | 'error' | 'diff' | 'raw'
    editError: '',
    editRaw: '',          // raw model output shown when it won't validate twice
    proposal: null,       // { routine, changes[], warnings[], diff }
    ask: [],              // [{ role:'user'|'assistant', text }] — in-memory chat history
    askStatus: 'idle',    // 'idle' | 'loading'
    askError: '',
    askInput: ''
  }
};

function freshState(routine) {
  return {
    version: 2,
    session: 1,                   // Session 1 = Day A (A on odd sessions)
    view: 'today',
    // v3.0: ONE "moves" slider = total goal-weighted moves per session; the four
    // per-block sliders (skill/core/wts/mach) collapsed into it. Default 10.
    settings: { moves: 10, cool: 2 },
    checks: {},                   // { [exerciseName]: true } — cleared on finish
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
    apiKey: '',                   // Phase 5: BYO Anthropic key. Device-only; never committed, never sent anywhere but api.anthropic.com
    model: DEFAULT_MODEL          // Phase 5: model toggle
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
  renameWarmupGroups(routine);   // v2.4.1 warm-up group rename (see below)

  const base = freshState(routine);
  const merged = Object.assign(base, obj, {
    settings: Object.assign({}, base.settings, obj.settings || {}),
    checks: obj.checks || {},
    intensity: obj.intensity || {},
    setsDone: obj.setsDone || {},
    rest: obj.rest && typeof obj.rest === 'object' ? obj.rest : { name: null, startedAt: null },
    routineHistory: obj.routineHistory || [],
    log: obj.log || [],
    dismissed: obj.dismissed || {},
    swaps: obj.swaps || {},
    // v2.5 Auto Superset — state-level toggle, default ON (NOT part of the routine migration).
    autoSuperset: typeof obj.autoSuperset === 'boolean' ? obj.autoSuperset : true,
    apiKey: typeof obj.apiKey === 'string' ? obj.apiKey : base.apiKey,
    model: obj.model || base.model,
    routine: routine,
    view: obj.view || 'today'
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
 * map (trainingGoalId -> integer 0..3), and an optional `care` array of care-goal
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
        errors.push(path + ' (' + label + '): goalScores must be an object of trainingGoalId -> 0..3');
      } else {
        Object.keys(gs).forEach((id) => {
          if (trainingIds.indexOf(id) === -1) {
            errors.push(path + ' (' + label + '): goalScores references unknown training goal "' + id + '"');
          }
          const v = gs[id];
          if (!Number.isInteger(v) || v < 0 || v > 3) {
            errors.push(path + ' (' + label + '): goalScores.' + id + ' must be an integer 0–3 (got ' + JSON.stringify(v) + ')');
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
  const pool = (b.moves || []).filter((ex) => eligible(ex, currentDay(st.session)));
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
  while (chosen.length < count && remaining.length) {
    let best = -1, bestVal = -Infinity;
    for (let k = 0; k < remaining.length; k++) {
      const c = remaining[k];
      const val = c.effective * Math.pow(SECTION_DECAY, sectionCount[c.section] || 0);
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
  } else if (state.view === 'edit') {
    renderedExercises = [];
    view.innerHTML = renderEdit();
    renderHeader(null, 'Edit routine');
  } else if (state.view === 'ask') {
    renderedExercises = [];
    view.innerHTML = renderAsk();
    renderHeader(null, 'Ask');
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

function renderToday(build) {
  renderedExercises = [];
  const preview = inPreview();
  let html = renderPreviewBar(build);
  // Suggestions (incl. swap chips) are interactive — hide them while previewing.
  if (!preview) html += renderSuggestions(build);

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
    html += '<section class="block"><h2 class="block-title">' + escapeHtml(bl.title) + '</h2>' +
      inner + '</section>';
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
  const showProg = expanded && blockKey !== 'warmup' && blockKey !== 'cooldown';

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

/* --- Settings view -------------------------------------------------------- */

function renderSettings() {
  const s = state.settings;
  const ranges = (state.routine.structure && state.routine.structure.sliders) || DEFAULT_RANGES;

  const slider = (key, label) => {
    const [lo, hi] = ranges[key] || DEFAULT_RANGES[key];
    const val = clamp(s[key], lo, hi);
    return '<div class="field">' +
      '<label>' + escapeHtml(label) + ' <span class="val">' + val + '</span></label>' +
      '<input type="range" data-action="setting" data-key="' + key + '" min="' + lo + '" max="' + hi + '" step="1" value="' + val + '">' +
      '</div>';
  };

  let html = '<div class="settings">';

  // Session knobs (v3.0: one unified "moves" slider + cool-down + auto superset).
  html += '<section class="panel"><h3>Session</h3>' +
    slider('moves', 'Number of moves') +
    slider('cool', 'Cool-down (1 = short, 2 = full)') +
    '<div class="field toggle">' +
      '<label for="auto-superset">Auto superset</label>' +
      '<input type="checkbox" id="auto-superset" data-action="toggle-superset"' +
        (state.autoSuperset ? ' checked' : '') + '>' +
    '</div>' +
    '<p class="muted">Groups same-muscle-free Floor moves into supersets — ' +
      'one card, alternate the moves, rest after each round.</p>' +
    '</section>';

  // Goals (v3.0) — a 0–10 weight slider per TRAINING goal (0 = off). Care goals
  // are always on (they live in the static warm-up / cool-down) and get no slider.
  const training = (state.routine.goals || []).filter((g) => g && g.kind === 'training');
  const care = (state.routine.goals || []).filter((g) => g && g.kind === 'care');
  html += '<section class="panel"><h3>Goals</h3>' +
    training.map((g) => {
      const w = clamp(typeof g.weight === 'number' ? g.weight : 0, 0, 10);
      return '<div class="field">' +
        '<label>' +
          '<span class="chip c-' + escapeHtml(g.colorId || 'gray') + '">' + escapeHtml(g.name) + '</span> ' +
          '<span class="val">' + w + '</span></label>' +
        '<input type="range" data-action="goal-weight" data-goal="' + escapeHtml(g.id) + '" ' +
          'min="0" max="10" step="1" value="' + w + '">' +
      '</div>';
    }).join('') +
    '<p class="muted">Higher weight pulls a goal\'s moves in more often. 0 turns it off.</p>' +
    '</section>';

  // Care goals — always covered in the static warm-up & cool-down (no controls).
  html += '<section class="panel"><h3>Always covered in warm-up &amp; cool-down</h3>' +
    '<div class="care-chips">' + care.map((g) =>
      '<span class="chip c-' + escapeHtml(g.colorId || 'gray') + '">' + escapeHtml(g.name) + '</span>'
    ).join(' ') + '</div>' +
    '<p class="muted">These are always on — no need to weight them.</p>' +
    '</section>';

  // AI routine editing (Phase 5) — password key + model toggle. Optional:
  // everything else in the app works fully with no key set.
  html += '<section class="panel"><h3>AI routine editing (optional)</h3>' +
    '<div class="field">' +
      '<label for="apikey">Anthropic API key</label>' +
      '<input type="password" id="apikey" data-action="apikey" autocomplete="off" ' +
        'autocapitalize="off" spellcheck="false" placeholder="sk-ant-…" value="' +
        escapeHtml(state.apiKey || '') + '">' +
    '</div>' +
    '<div class="field">' +
      '<label for="model">Model</label>' +
      '<select id="model" data-action="model">' +
        MODELS.map((m) => '<option value="' + escapeHtml(m.id) + '"' +
          (state.model === m.id ? ' selected' : '') + '>' + escapeHtml(m.label) + '</option>').join('') +
      '</select>' +
    '</div>' +
    '<p class="muted">Your key is stored only on this device and is sent only to ' +
      'api.anthropic.com — never committed, never to any other server. ' +
      'Recommended: set a monthly spend limit in the Anthropic Console. ' +
      'The rest of the app (workouts, logging, heuristics) works fully without a key.</p>' +
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
    case 'export': exportState(); break;
    case 'clear': clearData(); break;
    case 'rollback': rollback(+el.dataset.hidx); break;
    case 'save-routine': saveRoutineFromEditor(); break;
    case 'suggest-apply': applySuggestion(+el.dataset.sidx); break;
    case 'suggest-dismiss': dismissSuggestion(+el.dataset.sidx); break;
    // Phase 5 (LLM) — all gated behind explicit user action.
    case 'llm-goto-settings': setView('settings'); break;
    case 'llm-send-edit': sendEdit(); break;
    case 'llm-apply': applyProposal(); break;
    case 'llm-discard': discardProposal(); break;
    case 'ask-send': sendAsk(); break;
    case 'ask-forward': forwardToEditor(+el.dataset.i); break;
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
  } else if (action === 'import') {
    importFile(el.files && el.files[0]);
  } else if (action === 'apikey') {
    // Persist quietly — no re-render, so focus/caret in the field is preserved.
    state.apiKey = el.value.trim();
    saveState();
  } else if (action === 'model') {
    state.model = el.value;
    saveState();
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
  saveState();
  render();
}

// v3.1 day preview: clamp to [0, PREVIEW_MAX] and re-render. Transient — never
// saved (no saveState), so a refresh returns to today.
function setPreviewOffset(n) {
  previewOffset = clamp(n, 0, PREVIEW_MAX);
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

/* --- 11. LLM integration (Phase 5 — BYO Anthropic key) -------------------- *
 * PRIMARY PURPOSE: natural-language routine editing (5a). Secondary: Ask (5b).
 * Everything here is gated behind explicit user action — no LLM call ever
 * happens on its own. Degrades gracefully with no key / offline: the UI shows
 * an inline message instead of a dead input, and the rest of the app is
 * untouched. All chat/edit UI state lives in ui.llm (in-memory only).
 * ==========================================================================*/

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
let LLM_RETRY_MS = 1500;   // delay before the single 429/529 retry (0 in tests)

// Constraints/goals blurb sent with every 5a edit (from the spec + seed).
const GOALS_BLURB =
  '2–3 sessions/week, alternating A/B day structure. Training goals are weighted: ' +
  'flip (backflip power & endurance), core (stronger core), and gym (general gymnastics) ' +
  'are the primary drivers; aerial is optional (weight 0 = off by default). Each move ' +
  'carries goalScores (a training-goal id -> 0..3), and the session picks the highest ' +
  'goal-weighted-scoring moves (with per-section diminishing returns so Floor, Weights and ' +
  'Machines each stay represented), so raising a goal\'s weight pulls its moves in. Care goals ' +
  'are always on and live in the STATIC warm-up and cool-down — splits (hip/hamstring ' +
  'end-range), plantar (plantar fasciitis: keep impact conservative, keep slow calf ' +
  'loading), cubital (cubital tunnel: no aggressive elbow-lockout pressing volume), ' +
  'posture (keep the pulling / row work), sciatic (gentle nerve mobility, lives in the ' +
  'splits routine), and recovery (joint-friendly recovery). A move may also list `care` ' +
  'ids it happens to serve (display only). The user already stims by jumping (extra daily ' +
  'impact through the feet), so added plyometric/impact volume should stay conservative. ' +
  'The warm-up and cool-down are static — only change them when the user explicitly asks.';

// 5a system prompt: ONLY-JSON output, the full schema, and every guardrail.
const EDIT_SYSTEM_PROMPT =
  'You are a strength & tumbling coach editing a workout routine stored as JSON.\n\n' +
  'Respond with ONLY a single JSON object — no markdown, no code fences, no prose ' +
  'before or after. It MUST have exactly this shape:\n' +
  '{\n' +
  '  "routine": <the COMPLETE new routine object, same schema as the input>,\n' +
  '  "changes": ["short human-readable description of each change", ...],\n' +
  '  "warnings": ["anything the user should double-check", ...]\n' +
  '}\n' +
  'Return the ENTIRE routine, not a diff. Copy every field you are not changing ' +
  'exactly as given.\n\n' +
  'ROUTINE SCHEMA:\n' +
  '- Top level: { version:int, goals:[...], blocks:{...}, structure?:{...} }\n' +
  '- goals: array of { id:string, name:string, kind:"training"|"care", colorId:string, weight?:number }. ' +
  'Training goals carry a numeric weight 0–10 (0 = off); care goals have NO weight and are always on. ' +
  'colorId is one of: purple, teal, coral, pink, gray, green, amber, blue, slate, orange.\n' +
  '- blocks: { warmup:[static...], moves:[move...], cooldown:[static...] }.\n' +
  '  `moves` is ONE unified pool; the app scores and picks from it. `moves` must be non-empty. ' +
  'No duplicate names within a block.\n' +
  '- move (an entry in blocks.moves): {\n' +
  '    name: string (unique),\n' +
  '    section: "floor" | "weights" | "machines",   // which on-page group it renders in\n' +
  '    dose: { sets:int 1-6, amount:number>0, unit: "sec"|"sec/side"|"reps"|"reps/side"|"min", weight?:number },  // weight is lb, loaded moves only\n' +
  '    goalScores: { <trainingGoalId>: 0..3, ... },  // 3 = primary driver, 2 = strong, 1 = supportive; omit zero entries; the top-scoring goal drives the card color\n' +
  '    care?: [ <careGoalId>, ... ],   // care goals this move also serves (display chips only)\n' +
  '    why: short string explaining the purpose,\n' +
  '    rest?: int,                     // rest-clock target in seconds\n' +
  '    progression?: { step:number, max:number, maxSets:number, weightStep?:number },\n' +
  '    dayLock?: "A" | "B",            // move only appears on that day\n' +
  '    muscle?: string                 // coarse muscle group; Floor moves only — drives Auto Superset grouping, preserve it\n' +
  '  }\n' +
  '- static (an entry in blocks.warmup / blocks.cooldown): { name, dose, goals:[goalId...], why, group?, progression?, alwaysInShort? }. ' +
  'These keep a plain `goals` tag array (care ids); do NOT give them goalScores.\n' +
  '  Auto Superset groups Floor moves with distinct muscles into one card — keep each Floor move\'s muscle field when you edit it.\n' +
  '  Double progression (weighted moves): reps climb from dose.amount to progression.max by step, ' +
  'then the weight rises by weightStep (lb) and reps reset — set weight + weightStep together on loaded lifts.\n\n' +
  'GUARDRAILS (follow strictly):\n' +
  '- Preserve the A/B day structure and the block shapes unless the user explicitly asks to change them.\n' +
  '- Never remove health/rehab items (slow calf work, nerve/sciatic care, rows/pulling, tibialis ' +
  'raises, plantar-fascia and posture work) unless the user explicitly names that item for removal — ' +
  'and if they do, add a warning.\n' +
  '- Respect known issues: no aggressive elbow-lockout pressing volume (cubital tunnel); keep impact / ' +
  'plyometric volume conservative (plantar fasciitis, joint recovery); the user already gets daily ' +
  'impact from jumping.\n' +
  '- The warm-up and cool-down are static — only add, edit, or remove their items when the user explicitly asks.\n' +
  '- When adding a new training goal, give it an explicit id, kind:"training", weight, and colorId, and ' +
  'set goalScores on the moves that serve it so the generator can pick them.\n' +
  '- For anything symptom- or pain-related, adjust conservatively and add a warning recommending the ' +
  'user see a physical therapist rather than prescribing rehab.\n' +
  '- Keep dayLock semantics intact on moves you keep.';

// 5b system prompt: technique/planning assistant, not medical advice.
const ASK_SYSTEM_PROMPT =
  'You are a knowledgeable tumbling and strength-training assistant helping the user plan and ' +
  'refine a workout routine. Answer questions about technique, programming, and progression ' +
  'concisely and practically. You are a technique and planning assistant, NOT a medical ' +
  'professional — for pain, injury, or symptoms, recommend seeing a physical therapist rather ' +
  'than prescribing treatment. If you suggest a concrete change to the routine, phrase it clearly ' +
  'so it can be forwarded to the routine editor, but do NOT output JSON here.';

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Attach a machine-readable kind to LLM errors so callers can pick a message.
function llmError(kind, message) {
  const e = new Error(message);
  e.kind = kind;
  return e;
}

/*
 * Shared API helper — the ONLY place that talks to Anthropic. Uses the exact
 * fetch shape from the spec (browser-direct via the dangerous-direct-browser
 * header). Error handling per spec:
 *   offline / network fail -> "needs connection" (nothing queued)
 *   401                     -> message pointing to Settings
 *   429 / 529 (overloaded)  -> retry ONCE after a short delay, then friendly msg
 * Resolves to the assistant's text; rejects with an llmError otherwise.
 */
async function callClaude({ system, messages, maxTokens }) {
  if (!state.apiKey) {
    throw llmError('no-key', 'Add your Anthropic API key in Settings to use this.');
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw llmError('offline', 'This needs an internet connection — try again when you\'re back online.');
  }

  const body = JSON.stringify({
    model: state.model || DEFAULT_MODEL,
    max_tokens: maxTokens || 1500,
    system: system,
    messages: messages
  });

  const attempt = () => fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': state.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: body
  });

  let res;
  try {
    res = await attempt();
  } catch (e) {
    throw llmError('offline', 'Couldn\'t reach the server — check your connection and try again.');
  }

  // Retry ONCE on rate-limit / overload.
  if (res.status === 429 || res.status === 529) {
    await delay(LLM_RETRY_MS);
    try { res = await attempt(); }
    catch (e) { throw llmError('offline', 'Couldn\'t reach the server — check your connection and try again.'); }
  }

  if (res.status === 401) {
    throw llmError('auth', 'That API key was rejected. Check it in Settings.');
  }
  if (res.status === 429 || res.status === 529) {
    throw llmError('overloaded', 'The service is busy right now. Give it a minute and try again.');
  }
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = (j && j.error && j.error.message) || ''; } catch (e) { /* ignore */ }
    throw llmError('http', 'Request failed (' + res.status + ')' + (detail ? ': ' + detail : '') + '.');
  }

  let data;
  try { data = await res.json(); }
  catch (e) { throw llmError('parse', 'Got an unreadable response from the server.'); }

  const text = extractText(data);
  if (!text) throw llmError('empty', 'The model returned an empty response.');
  return text;
}

// Concatenate all text blocks of an Anthropic Messages response.
function extractText(data) {
  if (!data || !Array.isArray(data.content)) return '';
  return data.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim();
}

// Strip a single ```json … ``` (or bare ```) fence if the model wrapped its output.
function stripFences(text) {
  let t = String(text == null ? '' : text).trim();
  if (t.indexOf('```') === 0) {
    t = t.replace(/^```[^\n]*\n?/, '');   // opening fence + optional language tag
    t = t.replace(/\n?```\s*$/, '');      // closing fence
  }
  return t.trim();
}

/* --- 5a: edit flow -------------------------------------------------------- */

// Compact log summary for the 5a payload: last ~10 sessions, completion %, skips, notes.
function buildLogSummary(st) {
  const log = st.log || [];
  if (!log.length) return 'No sessions logged yet.';
  return log.slice(-10).map((e) => {
    const pct = Math.round(sessionCompletion(e) * 100);
    const skipped = (e.exercises || []).filter((x) => !x.done).map((x) => x.name);
    let line = 'Session ' + e.session + ' (Day ' + e.day + '): ' + pct + '% complete';
    if (skipped.length) line += '; skipped: ' + skipped.join(', ');
    if (e.note) line += '; note: "' + e.note + '"';
    return line;
  }).join('\n');
}

function buildEditUserMessage(instruction) {
  return 'CURRENT ROUTINE (JSON):\n' + JSON.stringify(state.routine, null, 2) + '\n\n' +
    'GOALS & CONSTRAINTS:\n' + GOALS_BLURB + '\n\n' +
    'RECENT TRAINING LOG (last ~10 sessions):\n' + buildLogSummary(state) + '\n\n' +
    'MY INSTRUCTION:\n' + instruction;
}

// Strip fences -> JSON.parse -> shape check. Returns { ok, value?, errors? }.
function tryParseProposal(text) {
  const stripped = stripFences(text);
  let obj;
  try { obj = JSON.parse(stripped); }
  catch (e) { return { ok: false, errors: ['Output was not valid JSON: ' + e.message] }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !obj.routine) {
    return { ok: false, errors: ['Output was not a single JSON object with a "routine" key.'] };
  }
  return { ok: true, value: {
    routine: obj.routine,
    changes: Array.isArray(obj.changes) ? obj.changes : [],
    warnings: Array.isArray(obj.warnings) ? obj.warnings : []
  } };
}

// Wrap a parsed proposal with a COMPUTED diff against the current routine.
function buildProposal(value) {
  return {
    routine: value.routine,
    changes: value.changes,
    warnings: value.warnings,
    diff: computeDiff(state.routine, value.routine)
  };
}

// Flat name -> exercise map across every pool (staples, variety, flat blocks).
function flattenExercises(routine) {
  const map = {};
  collectPools(routine).forEach((pool) => pool.forEach((ex) => {
    if (ex && ex.name) map[ex.name] = ex;
  }));
  return map;
}

// Dose identity string for equality checks.
function doseKey(d) {
  d = d || {};
  return [d.sets, d.amount, d.unit, d.weight == null ? '' : d.weight].join('|');
}

// Order-insensitive goal-tag equality (used for static warm-up/cool-down tags).
function goalsEqual(a, b) {
  const x = (a || []).slice().sort();
  const y = (b || []).slice().sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

// Canonical string for a goalScores map (order-insensitive) and a care list.
function goalScoresKey(gs) {
  gs = gs || {};
  return Object.keys(gs).sort().map((k) => k + ':' + gs[k]).join(',');
}

// Progression identity string.
function progKey(p) {
  if (!p) return '';
  return [p.step == null ? '' : p.step, p.max == null ? '' : p.max, p.maxSets == null ? '' : p.maxSets,
    p.weightStep == null ? '' : p.weightStep].join('|');
}

// modified = same name, different dose / goalScores / care / goals / why / section /
// group / rest / progression / dayLock / muscle.
function exerciseEqual(a, b) {
  return doseKey(a.dose) === doseKey(b.dose) &&
    goalScoresKey(a.goalScores) === goalScoresKey(b.goalScores) &&
    goalsEqual(a.care, b.care) &&
    goalsEqual(a.goals, b.goals) &&
    a.why === b.why &&
    (a.section || '') === (b.section || '') &&
    (a.group || '') === (b.group || '') &&
    (a.rest == null ? '' : a.rest) === (b.rest == null ? '' : b.rest) &&
    progKey(a.progression) === progKey(b.progression) &&
    (a.dayLock || null) === (b.dayLock || null) &&
    (a.muscle || '') === (b.muscle || '');
}

function diffGoals(oldGoals, newGoals) {
  const changes = [];
  const desc = (g) => g.kind === 'care' ? 'care' : ('weight ' + (g.weight != null ? g.weight : 0));
  const o = {}; (oldGoals || []).forEach((g) => { if (g && g.name) o[g.name] = g; });
  const n = {}; (newGoals || []).forEach((g) => { if (g && g.name) n[g.name] = g; });
  Object.keys(n).forEach((name) => {
    const ng = n[name], og = o[name];
    if (!og) {
      changes.push('Added goal: ' + name + ' (' + desc(ng) + ')');
    } else if ((og.weight || 0) !== (ng.weight || 0) || (og.kind || '') !== (ng.kind || '')) {
      let c = 'Changed goal: ' + name;
      if ((og.weight || 0) !== (ng.weight || 0)) c += ' — weight ' + (og.weight || 0) + ' → ' + (ng.weight || 0);
      if ((og.kind || '') !== (ng.kind || '')) c += ' — ' + og.kind + ' → ' + ng.kind;
      changes.push(c);
    }
  });
  Object.keys(o).forEach((name) => { if (!n[name]) changes.push('Removed goal: ' + name); });
  return changes;
}

// Computed diff: added / removed / modified exercises + goal changes.
function computeDiff(oldR, newR) {
  const o = flattenExercises(oldR);
  const n = flattenExercises(newR);
  const added = [], removed = [], modified = [];
  Object.keys(n).forEach((name) => {
    if (!(name in o)) added.push(n[name]);
    else if (!exerciseEqual(o[name], n[name])) modified.push({ from: o[name], to: n[name] });
  });
  Object.keys(o).forEach((name) => { if (!(name in n)) removed.push(o[name]); });
  return {
    added: added, removed: removed, modified: modified,
    goalChanges: diffGoals(oldR && oldR.goals, newR && newR.goals)
  };
}

/*
 * Full request flow: send -> parse -> validate -> ONE automatic retry with the
 * validator errors appended -> valid ? { proposal } : { raw }. Never mutates
 * state; the caller decides what to do with the result.
 */
async function runEditRequest(messages) {
  const first = await callClaude({ system: EDIT_SYSTEM_PROMPT, messages: messages, maxTokens: 1500 });
  const parsed = tryParseProposal(first);
  if (parsed.ok) {
    const v = validateRoutine(parsed.value.routine);
    if (v.valid) return { proposal: buildProposal(parsed.value) };
    return finalizeRetry(await retryOnce(messages, first, v.errors));
  }
  return finalizeRetry(await retryOnce(messages, first, parsed.errors));
}

// Append the model's prior (bad) message + a user message listing the errors.
async function retryOnce(messages, assistantText, errors) {
  const convo = messages.concat([
    { role: 'assistant', content: assistantText },
    { role: 'user', content:
      'That did not validate. Fix these problems and resend the COMPLETE JSON object ' +
      '(routine, changes, warnings) with no other text:\n- ' + errors.join('\n- ') }
  ]);
  return callClaude({ system: EDIT_SYSTEM_PROMPT, messages: convo, maxTokens: 1500 });
}

function finalizeRetry(text) {
  const parsed = tryParseProposal(text);
  if (parsed.ok) {
    const v = validateRoutine(parsed.value.routine);
    if (v.valid) return { proposal: buildProposal(parsed.value) };
  }
  return { raw: text };
}

async function sendEdit() {
  const ta = (typeof document !== 'undefined') ? document.getElementById('edit-input') : null;
  const text = ta ? ta.value.trim() : (ui.llm.editInput || '').trim();
  if (!text) return;
  if (!state.apiKey) return;                    // gated in the UI, belt-and-suspenders here

  ui.llm.editInput = text;
  ui.llm.editStatus = 'loading';
  ui.llm.editError = '';
  render();

  const messages = [{ role: 'user', content: buildEditUserMessage(text) }];
  let result;
  try {
    result = await runEditRequest(messages);
  } catch (e) {
    ui.llm.editStatus = 'error';
    ui.llm.editError = e.message || 'Something went wrong.';
    render();
    return;
  }

  if (result.proposal) {
    ui.llm.proposal = result.proposal;
    ui.llm.editStatus = 'diff';
  } else {
    ui.llm.editRaw = result.raw;               // invalid twice — show raw, change NOTHING
    ui.llm.editStatus = 'raw';
  }
  render();
}

// Apply: pushHistory(old), swap in new, clear swaps + dismissed (keys may be stale).
function applyProposal() {
  const p = ui.llm.proposal;
  if (!p) return;
  pushHistory(state.routine);
  state.routine = deepClone(p.routine);
  state.swaps = {};
  state.dismissed = {};
  ui.llm.proposal = null;
  ui.llm.editStatus = 'idle';
  ui.llm.editInput = '';
  ui.expanded.clear();
  state.view = 'today';                          // show the freshly applied routine
  saveState();
  render();
}

// Discard: change nothing.
function discardProposal() {
  ui.llm.proposal = null;
  ui.llm.editStatus = 'idle';
  render();
}

/* --- 5b: Ask flow --------------------------------------------------------- */

// Compact routine (names only) to keep the Ask context small.
function compactRoutine(r) {
  const b = (r && r.blocks) || {};
  const names = (arr) => (arr || []).map((ex) => ex.name);
  const out = { goals: (r && r.goals) || [], blocks: {} };
  out.blocks.warmup = names(b.warmup);
  ['floor', 'weights', 'machines'].forEach((sec) => {
    out.blocks[sec] = (b.moves || []).filter((ex) => (ex.section || 'floor') === sec).map((ex) => ex.name);
  });
  out.blocks.cooldown = names(b.cooldown);
  return out;
}

function buildAskContext(st) {
  const build = buildSession(st);
  const today = [];
  build.blocks.forEach((bl) => bl.exercises.forEach((ex) => today.push(ex.name)));
  const notes = (st.log || []).slice(-5).filter((e) => e.note).map((e) => '- ' + e.note);
  const goals = (st.routine.goals || []).filter((g) => g && g.kind === 'training' && g.weight > 0)
    .map((g) => g.name + ' (w' + g.weight + ')');
  return 'CONTEXT (for your reference):\n' +
    'Active training goals: ' + (goals.join(', ') || 'none') + '\n' +
    'Today is Session ' + build.session + ', Day ' + build.day + '. Today\'s exercises: ' +
      (today.join(', ') || 'none') + '\n' +
    'Recent session notes:\n' + (notes.join('\n') || '(none)') + '\n' +
    'Compact routine: ' + JSON.stringify(compactRoutine(st.routine));
}

async function sendAsk() {
  const ta = (typeof document !== 'undefined') ? document.getElementById('ask-input') : null;
  const text = ta ? ta.value.trim() : (ui.llm.askInput || '').trim();
  if (!text) return;
  if (!state.apiKey) return;

  ui.llm.ask.push({ role: 'user', text: text });
  ui.llm.askInput = '';
  ui.llm.askStatus = 'loading';
  ui.llm.askError = '';
  render();

  // Send the in-memory history as conversation context so follow-ups work.
  const messages = ui.llm.ask.map((m) => ({ role: m.role, content: m.text }));
  const system = ASK_SYSTEM_PROMPT + '\n\n' + buildAskContext(state);

  try {
    const reply = await callClaude({ system: system, messages: messages, maxTokens: 1000 });
    ui.llm.ask.push({ role: 'assistant', text: reply });
    ui.llm.askStatus = 'idle';
  } catch (e) {
    ui.llm.askStatus = 'idle';
    ui.llm.askError = e.message || 'Something went wrong.';   // keep the user message so they can retry
  }
  render();
}

/*
 * Forward an assistant reply into the 5a edit input, then navigate there.
 * Choice (per spec): rather than trying to detect "suggestion-ish" replies, we
 * always offer this affordance on assistant bubbles and let the user decide —
 * simplest robust option, and it never applies anything on its own.
 */
function forwardToEditor(i) {
  const m = ui.llm.ask[i];
  if (!m || m.role !== 'assistant') return;
  ui.llm.editInput = m.text;
  ui.llm.editStatus = 'idle';
  ui.llm.editError = '';
  ui.llm.proposal = null;
  state.view = 'edit';
  saveState();
  render();
}

/* --- 5: rendering --------------------------------------------------------- */

function llmKeyGate(label) {
  return '<div class="llm-notice">' +
    '<p>' + escapeHtml(label) + ' needs an Anthropic API key.</p>' +
    '<button class="btn primary" data-action="llm-goto-settings">Add a key in Settings</button>' +
    '</div>';
}

function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function renderEdit() {
  const L = ui.llm;
  let html = '<div class="llm">';

  if (!state.apiKey) return html + llmKeyGate('Natural-language routine editing') + '</div>';

  // Diff/approve screen takes over the whole view.
  if (L.editStatus === 'diff' && L.proposal) return html + renderDiff(L.proposal) + '</div>';

  const offline = isOffline();
  const loading = L.editStatus === 'loading';

  html += '<section class="panel">' +
    '<h3>Edit routine</h3>' +
    '<p class="muted">Describe a change in plain English — e.g. "add layout as a goal", ' +
    '"swap leg press for something posterior chain", "make A days shoulder-light for a while".</p>' +
    '<textarea id="edit-input" placeholder="What should change?"' + (loading ? ' disabled' : '') + '>' +
      escapeHtml(L.editInput || '') + '</textarea>';

  if (offline) html += '<p class="llm-inline warn">You\'re offline — connect to send.</p>';
  if (L.editStatus === 'error') html += '<p class="llm-inline warn">' + escapeHtml(L.editError) + '</p>';

  html += '<div class="row">';
  if (loading) {
    html += '<button class="btn primary" disabled><span class="spinner"></span>Thinking…</button>';
  } else {
    html += '<button class="btn primary" data-action="llm-send-edit"' + (offline ? ' disabled' : '') + '>Send</button>';
  }
  html += '</div></section>';

  // Invalid-twice fallback: show the raw output, change nothing.
  if (L.editStatus === 'raw') {
    html += '<section class="panel">' +
      '<h3>Couldn\'t use that response</h3>' +
      '<p class="muted">The reply didn\'t validate as a routine, twice. Nothing was changed. Raw output:</p>' +
      '<pre class="raw-output">' + escapeHtml(L.editRaw) + '</pre>' +
      '</section>';
  }

  return html + '</div>';
}

function renderDiff(p) {
  let html = '<section class="panel diff"><h3>Proposed changes</h3>';

  if (p.changes && p.changes.length) {
    html += '<ul class="change-list">' + p.changes.map((c) => '<li>' + escapeHtml(c) + '</li>').join('') + '</ul>';
  } else {
    html += '<p class="muted">The model reported no specific changes.</p>';
  }

  if (p.warnings && p.warnings.length) {
    html += '<div class="warnings"><strong>Warnings — double-check these</strong><ul>' +
      p.warnings.map((w) => '<li>' + escapeHtml(w) + '</li>').join('') + '</ul></div>';
  }

  html += renderComputedDiff(p.diff);

  html += '<div class="row">' +
    '<button class="btn ghost" data-action="llm-discard">Discard</button>' +
    '<button class="btn primary" data-action="llm-apply">Apply</button>' +
    '</div></section>';
  return html;
}

function exLine(ex) {
  // v3.0 moves carry goalScores + care; static warm-up/cool-down keep `goals`.
  let tags;
  if (ex.goalScores || ex.care) {
    const scores = Object.keys(ex.goalScores || {}).map((id) => id + ' ' + ex.goalScores[id]);
    const care = (ex.care || []).map((id) => id + ' (care)');
    tags = scores.concat(care).join(', ');
  } else {
    tags = (ex.goals || []).join(', ');
  }
  const section = ex.section ? ex.section + ' · ' : '';
  return '<div class="dx-name">' + escapeHtml(ex.name) + '</div>' +
    '<div class="dx-meta">' + escapeHtml(section + formatDose(ex.dose)) + ' · ' +
      escapeHtml(tags) + '</div>' +
    '<div class="dx-why">' + escapeHtml(ex.why || '') + '</div>';
}

function renderComputedDiff(d) {
  let h = '<div class="computed-diff">';
  if (d.goalChanges.length) {
    h += '<h4>Goals</h4><ul class="diff-list">' + d.goalChanges.map((g) => '<li>' + escapeHtml(g) + '</li>').join('') + '</ul>';
  }
  if (d.added.length) {
    h += '<h4>Added exercises</h4>' + d.added.map((ex) =>
      '<div class="dx dx-add"><span class="dx-tag">added</span>' + exLine(ex) + '</div>').join('');
  }
  if (d.removed.length) {
    h += '<h4>Removed exercises</h4>' + d.removed.map((ex) =>
      '<div class="dx dx-removed"><span class="dx-tag">removed</span>' + exLine(ex) + '</div>').join('');
  }
  if (d.modified.length) {
    h += '<h4>Modified exercises</h4>' + d.modified.map((m) =>
      '<div class="dx dx-mod">' +
        '<div class="dx-col dx-old"><span class="dx-tag">was</span>' + exLine(m.from) + '</div>' +
        '<div class="dx-col dx-new"><span class="dx-tag">now</span>' + exLine(m.to) + '</div>' +
      '</div>').join('');
  }
  if (!d.added.length && !d.removed.length && !d.modified.length && !d.goalChanges.length) {
    h += '<p class="muted">No structural differences detected.</p>';
  }
  return h + '</div>';
}

function renderAsk() {
  const L = ui.llm;
  let html = '<div class="llm ask">';

  if (!state.apiKey) return html + llmKeyGate('The Ask assistant') + '</div>';

  const offline = isOffline();

  html += '<div class="chat">';
  if (!L.ask.length && L.askStatus !== 'loading') {
    html += '<p class="muted chat-empty">Ask about technique, programming, or how to progress. ' +
      'Planning assistant — not medical advice.</p>';
  }
  L.ask.forEach((m, i) => {
    html += '<div class="bubble bubble-' + m.role + '">' + escapeHtml(m.text).replace(/\n/g, '<br>') + '</div>';
    if (m.role === 'assistant') {
      html += '<div class="bubble-actions"><button class="btn small ghost" ' +
        'data-action="ask-forward" data-i="' + i + '">Send to routine editor</button></div>';
    }
  });
  if (L.askStatus === 'loading') {
    html += '<div class="bubble bubble-assistant"><span class="spinner"></span>Thinking…</div>';
  }
  html += '</div>';

  if (L.askError) html += '<p class="llm-inline warn">' + escapeHtml(L.askError) + '</p>';
  if (offline) html += '<p class="llm-inline warn">You\'re offline — connect to send.</p>';

  const busy = offline || L.askStatus === 'loading';
  html += '<div class="ask-input">' +
    '<textarea id="ask-input" placeholder="Ask a question…"' + (L.askStatus === 'loading' ? ' disabled' : '') + '>' +
      escapeHtml(L.askInput || '') + '</textarea>' +
    '<button class="btn primary" data-action="ask-send"' + (busy ? ' disabled' : '') + '>Send</button>' +
    '</div>';

  return html + '</div>';
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
    eligible, goalActive, trainingGoals, scoreMove, selectMoves, topGoalId,
    cardGoalIds, moveChipIds, moveGoalIds, buildCooldown,
    progressionParams, progressionLadder, currentLevel, restTarget,
    migrateRoutine, migrateRoutineV3, migrateRoutineV4, migrateRoutineV5, migrateRoutineV6, insertSeedMove, renameWarmupGroups, warmupGroups, isLegacyRoutine, migrateIntensity, normalizeState,
    // v2.5 Auto Superset (pure grouping + plan)
    groupSupersets, supersetPlan, supersetRestTarget,
    // Phase 4 heuristics (pure — take log/state as args)
    leastRecentlyCompleted, lastCompletedIndex, sessionCompletion, buildKnobMap,
    volumeNudge, pickRaiseKnob, pickLowerKnob, skippedRecently, skipSuggestions,
    pickReplacement, progressionReady, isDismissed, computeSuggestions,
    findExerciseByName, collectPools, recentAppearances,
    // Phase 5 (LLM flow) — for the smoke test.
    callClaude, extractText, stripFences, tryParseProposal, computeDiff, buildProposal,
    runEditRequest, applyProposal, discardProposal, buildEditUserMessage, buildLogSummary,
    exerciseEqual, goalsEqual,
    _ui: ui,
    _setRetryDelay: (ms) => { LLM_RETRY_MS = ms; },
    _set: (s) => { state = s; },
    _setSeed: (s) => { SEED_ROUTINE = s; }
  };
}
