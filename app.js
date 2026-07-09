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
 * Phase 4/5 implementers: the two clean seams are
 *   - selectVariety()  — swap in "least-recently-completed" logic from state.log
 *   - validateRoutine() — already exported for the LLM edit flow
 * Both are exposed on window.TumbleTrainer at the bottom of this file.
 * ==========================================================================*/

'use strict';

/* --- 1. Constants & tiny helpers ----------------------------------------- */

const V1_KEY = 'tumbleTrainer.v1';
const V2_KEY = 'tumbleTrainer.v2';

// Units whose amount can be stepped. "as usual" (warmup) is intentionally not.
const STEPPABLE = ['sec', 'min', 'reps', 'reps/side'];

// Fallback slider ranges if the routine omits structure.sliders.
const DEFAULT_RANGES = { skill: [1, 3], core: [1, 3], wts: [1, 3], mach: [0, 2], cool: [1, 2] };

// Generic tab registry. Later phases just push more entries.
const TABS = [
  { id: 'today', label: 'Today' },
  { id: 'settings', label: 'Settings' }
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
const ui = { expanded: new Set(), finishing: false };

function freshState(routine) {
  return {
    version: 2,
    session: 1,                   // Session 1 = Day A (A on odd sessions)
    view: 'today',
    settings: { skill: 2, core: 2, wts: 2, mach: 1, cool: 2, aerial: false },
    checks: {},                   // { [exerciseName]: true } — cleared on finish
    intensity: {},                // { [exerciseName]: { sets, amount } } — survives sessions
    routine: routine,
    routineHistory: [],           // [{ timestamp, routine }] most-recent first, max 10
    log: [],                      // Phase 2 session log
    lastFinished: null,
    dismissed: {},                // Phase 4: { [suggestionKey]: sessionIndexWhenDismissed }
    swaps: {}                     // Phase 4: { [exerciseName]: replacementName } — per-session, cleared on finish
  };
}

// One-time v1 -> v2 migration: carry session index, slider settings, and aerial flag.
function migrateFromV1(v1, routine) {
  const s = freshState(routine);
  if (v1 && typeof v1.session === 'number') s.session = v1.session;
  ['skill', 'core', 'wts', 'mach', 'cool'].forEach((k) => {
    if (v1 && typeof v1[k] === 'number') s.settings[k] = v1[k];
  });
  if (v1 && typeof v1.aerial === 'boolean') s.settings.aerial = v1.aerial;
  return s;
}

// Fill in any missing fields so old/imported states can't crash the renderer.
function normalizeState(obj) {
  const base = freshState(obj.routine || (SEED_ROUTINE ? deepClone(SEED_ROUTINE) : {}));
  return Object.assign(base, obj, {
    settings: Object.assign({}, base.settings, obj.settings || {}),
    checks: obj.checks || {},
    intensity: obj.intensity || {},
    routineHistory: obj.routineHistory || [],
    log: obj.log || [],
    dismissed: obj.dismissed || {},
    swaps: obj.swaps || {},
    routine: obj.routine || base.routine,
    view: obj.view || 'today'
  });
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

/* --- 3. Routine schema validator (Phase 3) -------------------------------- *
 * Standalone, no deps. Returns { valid, errors[] } with human-readable paths.
 * Reused verbatim by the manual JSON editor and (later) the LLM edit flow.
 * Extra seed fields (userManaged, aerialAlt, aerialOnly, dayLock, range,
 * tempoNote, alwaysInShort, warmup block, structure) are allowed silently.
 */
function validateRoutine(routine) {
  const errors = [];
  if (!routine || typeof routine !== 'object' || Array.isArray(routine)) {
    return { valid: false, errors: ['Routine must be a JSON object'] };
  }

  ['version', 'goals', 'categories', 'blocks'].forEach((f) => {
    if (!(f in routine)) errors.push('Missing required top-level field: ' + f);
  });
  if ('version' in routine && typeof routine.version !== 'number') {
    errors.push('version must be a number');
  }
  if ('goals' in routine && !Array.isArray(routine.goals)) {
    errors.push('goals must be an array');
  }

  const cats = routine.categories;
  if (!cats || typeof cats !== 'object' || Array.isArray(cats)) {
    errors.push('categories must be an object of { label, colorId }');
  }
  const knownCats = (cats && typeof cats === 'object' && !Array.isArray(cats)) ? Object.keys(cats) : [];

  const blocks = routine.blocks;
  if (!blocks || typeof blocks !== 'object' || Array.isArray(blocks)) {
    errors.push('blocks must be an object');
    return { valid: errors.length === 0, errors };
  }

  function validateExercise(ex, path) {
    if (!ex || typeof ex !== 'object' || Array.isArray(ex)) {
      errors.push(path + ': exercise must be an object');
      return;
    }
    const label = ex.name ? '"' + ex.name + '"' : path;
    ['name', 'dose', 'category', 'why'].forEach((f) => {
      if (!(f in ex)) errors.push(path + ' (' + label + '): missing required field "' + f + '"');
    });
    if (ex.category && !knownCats.includes(ex.category)) {
      errors.push(path + ' (' + label + '): unknown category "' + ex.category + '"');
    }
    if ('dose' in ex) {
      const d = ex.dose;
      if (!d || typeof d !== 'object') {
        errors.push(path + ' (' + label + '): dose must be an object');
      } else {
        if (!Number.isInteger(d.sets) || d.sets < 1 || d.sets > 6) {
          errors.push(path + ' (' + label + '): dose.sets must be an integer 1–6 (got ' + JSON.stringify(d.sets) + ')');
        }
        if (typeof d.amount !== 'number' || !(d.amount > 0)) {
          errors.push(path + ' (' + label + '): dose.amount must be a number > 0 (got ' + JSON.stringify(d.amount) + ')');
        }
      }
    }
  }

  function validateArray(arr, path) {
    if (!Array.isArray(arr)) { errors.push('blocks.' + path + ' must be an array'); return; }
    const seen = new Set();
    arr.forEach((ex, i) => {
      validateExercise(ex, 'blocks.' + path + '[' + i + ']');
      if (ex && ex.name) {
        if (seen.has(ex.name)) {
          errors.push('blocks.' + path + ': duplicate exercise name "' + ex.name + '"');
        }
        seen.add(ex.name);
      }
    });
  }

  // skill & core: { staples[], varietyPool[] } with >= 1 staple each.
  ['skill', 'core'].forEach((bk) => {
    const b = blocks[bk];
    if (!b || typeof b !== 'object' || Array.isArray(b)) {
      errors.push('blocks.' + bk + ' must be an object with staples and varietyPool');
      return;
    }
    if (!Array.isArray(b.staples)) {
      errors.push('blocks.' + bk + '.staples must be an array');
    } else if (b.staples.length < 1) {
      errors.push('blocks.' + bk + ' must have at least one staple');
    } else {
      validateArray(b.staples, bk + '.staples');
    }
    if ('varietyPool' in b) validateArray(b.varietyPool, bk + '.varietyPool');
  });

  // Plain array blocks.
  ['warmup', 'weightsA', 'weightsB', 'machinesA', 'machinesB', 'cooldown'].forEach((bk) => {
    if (bk in blocks) validateArray(blocks[bk], bk);
  });

  return { valid: errors.length === 0, errors };
}

/* --- 4. Session selection (the Phase 4 hook) ------------------------------ */

// A on odd sessions, B on even.
function currentDay(session) { return (session % 2 === 1) ? 'A' : 'B'; }

// dayLock + aerial eligibility for pools.
function eligible(ex, day, aerial) {
  if (ex.dayLock && ex.dayLock !== day) return false;   // dayLock "A" only shows on A days
  if (ex.aerialOnly && !aerial) return false;           // aerial-only leaves rotation when off
  return true;
}

// Apply aerial swap to a display copy (category tag + why text).
function resolveExercise(ex, aerial) {
  if (aerial && ex.aerialAlt) {
    return Object.assign({}, ex, { category: ex.aerialAlt.category, why: ex.aerialAlt.why });
  }
  return ex;
}

/*
 * Variety-slot selection (Phase 4, heuristic #3 — variety guarantee).
 * Picks the `count` LEAST-RECENTLY-COMPLETED eligible items from the pool
 * (from state.log). Never-completed items count as least-recent and are
 * preferred; ties break by pool order (stable). Deterministic for a given
 * (log, pool) so re-renders never reshuffle.
 *
 * Fallback: when the log is empty we keep the documented v1 behaviour —
 * rotate `count` items by session index (window shifts by one each session).
 *
 * Signature is intentionally stable (buildStapleBlock calls it unchanged).
 * The log is read from the module-level `state` — in the app buildSession is
 * always called as buildSession(state), so st === state and this is consistent;
 * tests inject a log via module.exports._set(state).
 */
function selectVariety(pool, count, session, day, aerial) {
  const elig = pool.filter((ex) => eligible(ex, day, aerial));
  const n = Math.min(Math.max(count, 0), elig.length);
  const log = (state && state.log) || [];

  if (!log.length) {                                  // empty-log fallback: index rotation
    const out = [];
    for (let i = 0; i < n; i++) out.push(elig[(session + i) % elig.length]);
    return out;
  }
  return leastRecentlyCompleted(elig, log).slice(0, n);
}

// Index of the most recent log entry in which `name` was COMPLETED (done),
// or -1 if it was never completed (so it sorts first as "least recent").
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

// A skill/core block = eligible staples (dayLock-filtered) + N variety slots.
function buildStapleBlock(block, varietyCount, session, day, aerial) {
  const staples = block.staples
    .filter((ex) => eligible(ex, day, aerial))
    .map((ex) => resolveExercise(ex, aerial));
  const variety = selectVariety(block.varietyPool || [], varietyCount, session, day, aerial)
    .map((ex) => resolveExercise(ex, aerial));
  return staples.concat(variety);
}

// weights/machines: show the first N eligible listed exercises (slider = a count).
function takeN(arr, n, day, aerial) {
  return (arr || [])
    .filter((ex) => eligible(ex, day, aerial))
    .slice(0, Math.max(n, 0))
    .map((ex) => resolveExercise(ex, aerial));
}

/*
 * Cooldown interpretation: the seed marks two items `alwaysInShort` and the
 * slider range is [1,2] over three items, so a count doesn't map cleanly.
 * Choice: cool === 1 -> "short" (only alwaysInShort items); cool >= 2 -> full list.
 */
function buildCooldown(arr, cool, day, aerial) {
  let list = (arr || []).filter((ex) => eligible(ex, day, aerial));
  if (cool <= 1) list = list.filter((ex) => ex.alwaysInShort);
  return list.map((ex) => resolveExercise(ex, aerial));
}

// Produce the ordered blocks for a session. Pure given `st`.
function buildSession(st) {
  const r = st.routine;
  const s = st.settings;
  const session = st.session;
  const day = currentDay(session);
  const b = r.blocks;
  const blocks = [];

  if (b.warmup && b.warmup.length) {
    blocks.push({ key: 'warmup', title: 'Warm-up', info: true,
      exercises: b.warmup.map((ex) => resolveExercise(ex, s.aerial)) });
  }
  blocks.push({ key: 'skill', title: 'Skill',
    exercises: buildStapleBlock(b.skill, s.skill, session, day, s.aerial) });
  blocks.push({ key: 'core', title: 'Core',
    exercises: buildStapleBlock(b.core, s.core, session, day, s.aerial) });
  blocks.push({ key: 'weights', title: 'Weights',
    exercises: takeN(day === 'A' ? b.weightsA : b.weightsB, s.wts, day, s.aerial) });
  blocks.push({ key: 'machines', title: 'Machines',
    exercises: takeN(day === 'A' ? b.machinesA : b.machinesB, s.mach, day, s.aerial) });
  blocks.push({ key: 'cooldown', title: 'Cool-down',
    exercises: buildCooldown(b.cooldown, s.cool, day, s.aerial) });

  return { session, day, blocks: applySwaps(blocks, st) };
}

// Find an exercise object anywhere in the routine by name (base, unresolved).
function findExerciseByName(routine, name) {
  for (const pool of collectPools(routine)) {
    const f = pool.find((ex) => ex && ex.name === name);
    if (f) return f;
  }
  return null;
}

// All exercise arrays in the routine (staples + variety pools + flat blocks).
function collectPools(routine) {
  const b = (routine && routine.blocks) || {};
  const pools = [];
  ['warmup', 'weightsA', 'weightsB', 'machinesA', 'machinesB', 'cooldown']
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
    key: bl.key, title: bl.title, info: bl.info,
    exercises: bl.exercises.map((ex) => {
      const repName = swaps[ex.name];
      if (!repName) return ex;
      const rep = findExerciseByName(st.routine, repName);
      return rep ? resolveExercise(rep, st.settings.aerial) : ex;
    })
  }));
}

/* --- 5. Doses & intensity overrides (Phase 1) ----------------------------- */

/*
 * Effective dose = base dose, with per-exercise override applied if present.
 * Override display choice: when the amount is overridden we DROP the range
 * (a single explicit number is clearer than a shifted band). Overrides carry
 * both sets & amount so the card always shows a concrete pair.
 */
function effectiveDose(ex) {
  const d = ex.dose;
  const ov = state.intensity[ex.name];
  if (ov) return { sets: ov.sets, amount: ov.amount, unit: d.unit, overridden: true };
  return { sets: d.sets, amount: d.amount, unit: d.unit, range: d.range };
}

// "3 × 30–45 sec" / "3 × 15 reps/side" / warmup "As usual".
function formatDose(eff) {
  if (eff.unit === 'as usual') return 'As usual';
  const amt = eff.range ? (eff.amount + '–' + eff.range) : String(eff.amount);
  return eff.sets + ' × ' + amt + ' ' + eff.unit;
}

// Amount step: ±5 sec, ±1 min, ±1 rep, ±2 for high-rep (default amount >= 12).
function amountStep(ex) {
  const u = ex.dose.unit;
  if (u === 'sec') return 5;
  if (u === 'min') return 1;
  return ex.dose.amount >= 12 ? 2 : 1;  // reps / reps/side
}

function amountLabel(unit) {
  if (unit === 'sec') return 'Seconds';
  if (unit === 'min') return 'Minutes';
  return 'Reps';
}

function ensureOverride(ex) {
  if (!state.intensity[ex.name]) {
    const eff = effectiveDose(ex);
    state.intensity[ex.name] = { sets: eff.sets, amount: eff.amount };
  }
  return state.intensity[ex.name];
}

function stepOverride(ex, field, dir) {
  const ov = ensureOverride(ex);
  if (field === 'sets') ov.sets = clamp(ov.sets + dir, 1, 6);
  else ov.amount = Math.max(1, ov.amount + amountStep(ex) * dir);
  saveState();
  render();
}

function resetOverride(ex) {
  delete state.intensity[ex.name];
  saveState();
  render();
}

/* --- 6. Rendering --------------------------------------------------------- */

function render() {
  const y = window.scrollY;
  renderTabs();
  const view = document.getElementById('view');
  if (state.view === 'settings') {
    renderedExercises = [];
    view.innerHTML = renderSettings();
    renderHeader(null);
  } else {
    const build = buildSession(state);
    view.innerHTML = renderToday(build);   // populates renderedExercises
    renderHeader(build);
  }
  window.scrollTo(0, y);
}

function renderHeader(build) {
  const h = document.getElementById('app-header');
  if (!build) {
    h.innerHTML = '<div class="title">Tumble Trainer</div><div class="sub">Settings</div>';
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

function renderTabs() {
  document.getElementById('tabs').innerHTML = TABS.map((t) =>
    '<button class="tab' + (state.view === t.id ? ' active' : '') +
    '" data-action="tab" data-view="' + t.id + '">' + escapeHtml(t.label) + '</button>'
  ).join('');
}

function renderToday(build) {
  renderedExercises = [];
  let html = renderSuggestions(build);
  build.blocks.forEach((bl) => {
    if (!bl.exercises.length) return;   // skip empty blocks (e.g. machines at count 0)
    html += '<section class="block"><h2 class="block-title">' + escapeHtml(bl.title) + '</h2>';
    bl.exercises.forEach((ex) => {
      const idx = renderedExercises.length;
      renderedExercises.push(ex);
      html += renderCard(ex, idx, bl.key === 'warmup');
    });
    html += '</section>';
  });
  html += renderFinish();
  return html;
}

function renderCard(ex, idx, isInfo) {
  const eff = effectiveDose(ex);
  const cat = state.routine.categories[ex.category] || { label: ex.category, colorId: 'gray' };
  const done = !!state.checks[ex.name];
  const overridden = !!state.intensity[ex.name];
  const expanded = ui.expanded.has(ex.name);
  const steppable = !isInfo && STEPPABLE.includes(ex.dose.unit);

  return '' +
    '<div class="card cat-' + escapeHtml(cat.colorId) +
      (done ? ' is-done' : '') + (expanded ? ' is-open' : '') + '">' +
      '<div class="card-main" data-action="expand" data-idx="' + idx + '">' +
        '<span class="tag">' + escapeHtml(cat.label) + '</span>' +
        '<div class="card-body">' +
          '<div class="card-name">' + escapeHtml(ex.name) +
            (overridden ? ' <span class="mod">modified</span>' : '') + '</div>' +
          '<div class="dose">' + escapeHtml(formatDose(eff)) + '</div>' +
          '<div class="why">' + escapeHtml(ex.why) + '</div>' +
        '</div>' +
        '<input type="checkbox" class="check" data-action="check" data-idx="' + idx + '"' +
          (done ? ' checked' : '') + ' aria-label="Mark done">' +
      '</div>' +
      (expanded && steppable ? renderSteppers(ex, idx, overridden) : '') +
    '</div>';
}

function renderSteppers(ex, idx, overridden) {
  const eff = effectiveDose(ex);
  // Phase 4, heuristic #4: subtle "ready to add?" marker when this exercise has
  // been completed 4+ times at the current effective intensity.
  const ready = progressionReady(ex.name, eff, state.log || []);
  const row = (label, field, val) =>
    '<div class="stepper">' +
      '<span class="stepper-label">' + escapeHtml(label) + '</span>' +
      '<button data-action="step" data-idx="' + idx + '" data-field="' + field + '" data-dir="-1" aria-label="Decrease ' + field + '">−</button>' +
      '<span class="stepper-val">' + val + '</span>' +
      '<button data-action="step" data-idx="' + idx + '" data-field="' + field + '" data-dir="1" aria-label="Increase ' + field + '">+</button>' +
    '</div>';
  return '<div class="steppers">' +
      row('Sets', 'sets', eff.sets) +
      row(amountLabel(ex.dose.unit), 'amount', eff.amount) +
      (ready ? '<span class="prog-hint" title="Completed 4+ times at this intensity">ready to add?</span>' : '') +
      (overridden ? '<button class="reset" data-action="reset" data-idx="' + idx + '">Reset to default</button>' : '') +
    '</div>';
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

  // Session knobs
  html += '<section class="panel"><h3>Session</h3>' +
    slider('skill', 'Skill variety slots') +
    slider('core', 'Core variety slots') +
    slider('wts', 'Weights exercises') +
    slider('mach', 'Machine exercises') +
    slider('cool', 'Cool-down (1 = short, 2 = full)') +
    '<div class="field toggle">' +
      '<label for="aerial">Aerial mode</label>' +
      '<input type="checkbox" id="aerial" data-action="toggle-aerial"' + (s.aerial ? ' checked' : '') + '>' +
    '</div></section>';

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

  switch (action) {
    case 'check': return;                       // handled by onChange
    case 'expand': toggleExpand(ex); break;
    case 'step': stepOverride(ex, el.dataset.field, +el.dataset.dir); break;
    case 'reset': resetOverride(ex); break;
    case 'finish': ui.finishing = true; render(); break;
    case 'cancel-finish': ui.finishing = false; render(); break;
    case 'confirm-finish': doFinish(); break;
    case 'tab': setView(el.dataset.view); break;
    case 'export': exportState(); break;
    case 'clear': clearData(); break;
    case 'rollback': rollback(+el.dataset.hidx); break;
    case 'save-routine': saveRoutineFromEditor(); break;
    case 'suggest-apply': applySuggestion(+el.dataset.sidx); break;
    case 'suggest-dismiss': dismissSuggestion(+el.dataset.sidx); break;
    default: break;
  }
}

function onChange(e) {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'check') {
    const ex = renderedExercises[+el.dataset.idx];
    if (el.checked) state.checks[ex.name] = true; else delete state.checks[ex.name];
    saveState();
    render();
  } else if (action === 'setting') {
    state.settings[el.dataset.key] = +el.value;
    saveState();
    render();
  } else if (action === 'toggle-aerial') {
    state.settings.aerial = el.checked;
    saveState();
    render();
  } else if (action === 'import') {
    importFile(el.files && el.files[0]);
  }
}

function toggleExpand(ex) {
  if (!ex) return;
  if (ui.expanded.has(ex.name)) ui.expanded.delete(ex.name);
  else ui.expanded.add(ex.name);
  render();
}

function setView(v) {
  state.view = v;
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
  built.blocks.forEach((bl) => bl.exercises.forEach((ex) => {
    const eff = effectiveDose(ex);
    entry.exercises.push({
      name: ex.name,
      category: ex.category,
      dose: { sets: eff.sets, amount: eff.amount, unit: eff.unit },  // EFFECTIVE dose
      done: !!state.checks[ex.name]
    });
  }));
  if (note) entry.note = note;

  state.log.push(entry);
  state.session += 1;
  state.checks = {};
  state.swaps = {};              // Phase 4: swaps are per-session trials — clear on finish
  state.lastFinished = entry.date;
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
const ALL_KNOBS = ['skill', 'core', 'wts', 'mach', 'cool'];
// Raise candidates + tie-break order. Weights first so the canonical
// "raise weights to 3?" wins ties (matches the spec example). mach/cool are
// structural, not effort knobs, so they're never *raised* by the nudge.
const RAISE_KNOBS = ['wts', 'skill', 'core'];
const KNOB_LABEL = { skill: 'skill variety', core: 'core variety', wts: 'weights', mach: 'machines', cool: 'cool-down' };

function sliderRanges(routine) {
  return (routine && routine.structure && routine.structure.sliders) || DEFAULT_RANGES;
}

// Fraction (0..1) of an entry's exercises marked done. Empty entry => 0.
function sessionCompletion(entry) {
  const ex = (entry && entry.exercises) || [];
  if (!ex.length) return 0;
  return ex.filter((e) => e.done).length / ex.length;
}

// name -> knob (block slider) map, derived from the routine so old logs work.
function buildKnobMap(routine) {
  const b = (routine && routine.blocks) || {};
  const map = {};
  const add = (arr, knob) => (arr || []).forEach((ex) => { if (ex && ex.name) map[ex.name] = knob; });
  if (b.skill) { add(b.skill.staples, 'skill'); add(b.skill.varietyPool, 'skill'); }
  if (b.core) { add(b.core.staples, 'core'); add(b.core.varietyPool, 'core'); }
  add(b.weightsA, 'wts'); add(b.weightsB, 'wts');
  add(b.machinesA, 'mach'); add(b.machinesB, 'mach');
  add(b.cooldown, 'cool');   // warmup intentionally omitted (user-managed, no knob)
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

/*
 * Pick a same-category replacement for a skipped exercise. Candidates: same
 * BASE category (looked up in the routine, so aerial resolution doesn't
 * confuse it), eligible for the day/aerial state, not currently shown, not
 * already proposed, not itself. Ranked least-recently-completed (consistent
 * with the variety guarantee), tie-break pool order.
 */
function pickReplacement(name, st, shownNames, proposed, day) {
  const routine = st.routine;
  const base = findExerciseByName(routine, name);
  if (!base) return null;
  const cat = base.category;
  const aerial = st.settings.aerial;
  const log = st.log || [];
  const cands = [];
  collectPools(routine).forEach((pool) => pool.forEach((ex) => {
    if (!ex || ex.name === name || ex.category !== cat) return;
    if (!eligible(ex, day, aerial)) return;
    if (shownNames.has(ex.name) || proposed.has(ex.name)) return;
    if (!cands.some((c) => c.name === ex.name)) cands.push(ex);
  }));
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
 * intensity (sets+amount+unit). Bumping the dose changes `cur`, so the count
 * naturally resets at the new level.
 */
function progressionReady(name, cur, log) {
  let n = 0;
  (log || []).forEach((entry) => (entry.exercises || []).forEach((e) => {
    if (e.name === name && e.done && e.dose &&
        e.dose.sets === cur.sets && e.dose.amount === cur.amount && e.dose.unit === cur.unit) {
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
  const raw = localStorage.getItem(V2_KEY);
  if (raw) {
    try { state = normalizeState(JSON.parse(raw)); }
    catch (e) { SEED_ROUTINE = await loadSeed(); state = freshState(deepClone(SEED_ROUTINE)); }
    if (!state.routine || !state.routine.blocks) {
      SEED_ROUTINE = await loadSeed();
      state.routine = deepClone(SEED_ROUTINE);
    }
  } else {
    SEED_ROUTINE = await loadSeed();
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

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}

// Expose a small, stable API for Phase 5 (LLM flow) and testing.
if (typeof window !== 'undefined') {
  window.TumbleTrainer = {
    validateRoutine,
    buildSession: () => buildSession(state),
    getState: () => state
  };
}

// Node smoke-test hook (kept out of the browser path).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    validateRoutine, formatDose, effectiveDose, buildSession, selectVariety,
    migrateFromV1, freshState, currentDay, amountStep,
    // Phase 4 heuristics (pure — take log/state as args)
    leastRecentlyCompleted, lastCompletedIndex, sessionCompletion, buildKnobMap,
    volumeNudge, pickRaiseKnob, pickLowerKnob, skippedRecently, skipSuggestions,
    pickReplacement, progressionReady, isDismissed, computeSuggestions,
    findExerciseByName, collectPools, recentAppearances,
    _set: (s) => { state = s; }
  };
}
