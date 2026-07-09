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

// Units whose amount can be stepped. "as usual" (warmup) is intentionally not.
const STEPPABLE = ['sec', 'min', 'reps', 'reps/side'];

// Fallback slider ranges if the routine omits structure.sliders.
const DEFAULT_RANGES = { skill: [1, 3], core: [1, 3], wts: [1, 3], mach: [0, 2], cool: [1, 2] };

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
    settings: { skill: 2, core: 2, wts: 2, mach: 1, cool: 2, aerial: false },
    checks: {},                   // { [exerciseName]: true } — cleared on finish
    intensity: {},                // { [exerciseName]: { sets, amount } } — survives sessions
    routine: routine,
    routineHistory: [],           // [{ timestamp, routine }] most-recent first, max 10
    log: [],                      // Phase 2 session log
    lastFinished: null,
    dismissed: {},                // Phase 4: { [suggestionKey]: sessionIndexWhenDismissed }
    swaps: {},                    // Phase 4: { [exerciseName]: replacementName } — per-session, cleared on finish
    apiKey: '',                   // Phase 5: BYO Anthropic key. Device-only; never committed, never sent anywhere but api.anthropic.com
    model: DEFAULT_MODEL          // Phase 5: model toggle
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
    apiKey: typeof obj.apiKey === 'string' ? obj.apiKey : base.apiKey,
    model: obj.model || base.model,
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
    const build = buildSession(state);
    view.innerHTML = renderToday(build);   // populates renderedExercises
    renderHeader(build);
  }
  window.scrollTo(0, y);
}

function renderHeader(build, subtitle) {
  const h = document.getElementById('app-header');
  if (!build) {
    h.innerHTML = '<div class="title">Tumble Trainer</div><div class="sub">' +
      escapeHtml(subtitle || 'Settings') + '</div>';
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
  } else if (action === 'apikey') {
    // Persist quietly — no re-render, so focus/caret in the field is preserved.
    state.apiKey = el.value.trim();
    saveState();
  } else if (action === 'model') {
    state.model = el.value;
    saveState();
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
  '2–3 sessions/week, alternating A/B day structure. Primary goals: general core ' +
  'strength and successive backflips; aerial work is a lower-weight optional goal. ' +
  'Health constraints that must be respected: plantar fasciitis (keep impact ' +
  'conservative, keep slow calf loading), cubital tunnel (no aggressive elbow-lockout ' +
  'pressing volume), posture (keep the pulling / row work), sciatic nerve mobility ' +
  '(gentle flossing lives in the user\'s splits routine), and joint-friendly recovery ' +
  'from tumbling. The user already stims by jumping (extra daily impact through the ' +
  'feet), so added plyometric/impact volume should stay conservative. Warm-up is ' +
  'user-managed.';

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
  '- Top level: { version:int, goals:[...], categories:{...}, blocks:{...}, structure?:{...} }\n' +
  '- goals: array of { name:string, weight:number, active:boolean }\n' +
  '- categories: object mapping a short id -> { label:string, colorId:string }. colorId ' +
  'is one of: purple, teal, coral, pink, gray. Every exercise.category MUST be one of the ' +
  'category ids you define here.\n' +
  '- blocks:\n' +
  '    skill: { staples:[exercise...], varietyPool:[exercise...] }\n' +
  '    core:  { staples:[exercise...], varietyPool:[exercise...] }\n' +
  '    weightsA, weightsB, machinesA, machinesB, cooldown, warmup: [exercise...]\n' +
  '  skill and core must each keep at least one staple. No duplicate exercise names within a ' +
  'single array.\n' +
  '- exercise: {\n' +
  '    name: string (unique within its array),\n' +
  '    dose: { sets:int 1-6, amount:number>0, unit: "sec"|"reps"|"reps/side"|"min", range?:number },\n' +
  '    category: one of the category ids above,\n' +
  '    why: short string explaining the purpose,\n' +
  '    aerialAlt?: { category, why }   // used when the user turns aerial mode on\n' +
  '    aerialOnly?: boolean            // item only appears when aerial mode is on\n' +
  '    dayLock?: "A" | "B"             // item only appears on that day\n' +
  '  }\n' +
  '  (Warm-up items may carry unit "as usual" and userManaged:true.)\n\n' +
  'GUARDRAILS (follow strictly):\n' +
  '- Preserve the A/B day structure and the block shapes unless the user explicitly asks to change them.\n' +
  '- Never remove health/rehab items (slow calf work, nerve/sciatic care, rows/pulling, tibialis ' +
  'raises, plantar-fascia and posture work) unless the user explicitly names that item for removal — ' +
  'and if they do, add a warning.\n' +
  '- Respect known issues: no aggressive elbow-lockout pressing volume (cubital tunnel); keep impact / ' +
  'plyometric volume conservative (plantar fasciitis, joint recovery); the user already gets daily ' +
  'impact from jumping.\n' +
  '- Warm-up is user-managed — NEVER add, edit, or remove warmup items.\n' +
  '- When adding a new goal, give it an explicit weight, and rebalance the variety pools so their ' +
  'emphasis roughly matches the active goal weights.\n' +
  '- For anything symptom- or pain-related, adjust conservatively and add a warning recommending the ' +
  'user see a physical therapist rather than prescribing rehab.\n' +
  '- Keep dayLock, aerialAlt, and aerialOnly semantics intact on items you keep.';

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
  return [d.sets, d.amount, d.range == null ? '' : d.range, d.unit].join('|');
}

// modified = same name, different dose / category / why / flags.
function exerciseEqual(a, b) {
  return doseKey(a.dose) === doseKey(b.dose) &&
    a.category === b.category &&
    a.why === b.why &&
    JSON.stringify(a.aerialAlt || null) === JSON.stringify(b.aerialAlt || null) &&
    !!a.aerialOnly === !!b.aerialOnly &&
    (a.dayLock || null) === (b.dayLock || null);
}

function diffGoals(oldGoals, newGoals) {
  const changes = [];
  const o = {}; (oldGoals || []).forEach((g) => { if (g && g.name) o[g.name] = g; });
  const n = {}; (newGoals || []).forEach((g) => { if (g && g.name) n[g.name] = g; });
  Object.keys(n).forEach((name) => {
    const ng = n[name], og = o[name];
    if (!og) {
      changes.push('Added goal: ' + name + ' (weight ' + ng.weight + ', ' + (ng.active ? 'active' : 'inactive') + ')');
    } else if (og.weight !== ng.weight || !!og.active !== !!ng.active) {
      let c = 'Changed goal: ' + name;
      if (og.weight !== ng.weight) c += ' — weight ' + og.weight + ' → ' + ng.weight;
      if (!!og.active !== !!ng.active) c += ' — ' + (ng.active ? 'activated' : 'deactivated');
      changes.push(c);
    }
  });
  Object.keys(o).forEach((name) => { if (!n[name]) changes.push('Removed goal: ' + name); });
  return changes;
}

function diffCategories(oldC, newC) {
  const changes = [];
  oldC = oldC || {}; newC = newC || {};
  Object.keys(newC).forEach((id) => {
    if (!(id in oldC)) changes.push('Added category: ' + id + ' (' + (newC[id].label || '') + ')');
    else if (oldC[id].label !== newC[id].label || oldC[id].colorId !== newC[id].colorId)
      changes.push('Changed category "' + id + '": ' + (oldC[id].label || '') + ' → ' + (newC[id].label || ''));
  });
  Object.keys(oldC).forEach((id) => { if (!(id in newC)) changes.push('Removed category: ' + id); });
  return changes;
}

// Computed diff: added / removed / modified exercises + goal & category changes.
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
    goalChanges: diffGoals(oldR && oldR.goals, newR && newR.goals),
    catChanges: diffCategories(oldR && oldR.categories, newR && newR.categories)
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
  out.blocks.skill = { staples: names(b.skill && b.skill.staples), varietyPool: names(b.skill && b.skill.varietyPool) };
  out.blocks.core = { staples: names(b.core && b.core.staples), varietyPool: names(b.core && b.core.varietyPool) };
  ['weightsA', 'weightsB', 'machinesA', 'machinesB', 'cooldown'].forEach((k) => { out.blocks[k] = names(b[k]); });
  return out;
}

function buildAskContext(st) {
  const build = buildSession(st);
  const today = [];
  build.blocks.forEach((bl) => bl.exercises.forEach((ex) => today.push(ex.name)));
  const notes = (st.log || []).slice(-5).filter((e) => e.note).map((e) => '- ' + e.note);
  const goals = (st.routine.goals || []).filter((g) => g.active).map((g) => g.name + ' (w' + g.weight + ')');
  return 'CONTEXT (for your reference):\n' +
    'Active goals: ' + (goals.join(', ') || 'none') + '\n' +
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
  return '<div class="dx-name">' + escapeHtml(ex.name) + '</div>' +
    '<div class="dx-meta">' + escapeHtml(formatDose(ex.dose)) + ' · ' + escapeHtml(ex.category) + '</div>' +
    '<div class="dx-why">' + escapeHtml(ex.why || '') + '</div>';
}

function renderComputedDiff(d) {
  let h = '<div class="computed-diff">';
  if (d.goalChanges.length) {
    h += '<h4>Goals</h4><ul class="diff-list">' + d.goalChanges.map((g) => '<li>' + escapeHtml(g) + '</li>').join('') + '</ul>';
  }
  if (d.catChanges.length) {
    h += '<h4>Categories</h4><ul class="diff-list">' + d.catChanges.map((g) => '<li>' + escapeHtml(g) + '</li>').join('') + '</ul>';
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
  if (!d.added.length && !d.removed.length && !d.modified.length && !d.goalChanges.length && !d.catChanges.length) {
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
    // Phase 5 (LLM flow) — for the smoke test.
    callClaude, extractText, stripFences, tryParseProposal, computeDiff, buildProposal,
    runEditRequest, applyProposal, discardProposal, buildEditUserMessage, buildLogSummary,
    _ui: ui,
    _setRetryDelay: (ms) => { LLM_RETRY_MS = ms; },
    _set: (s) => { state = s; }
  };
}
