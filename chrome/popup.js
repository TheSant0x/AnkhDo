/* Ankh Do — Chrome popup logic. Mirrors the GNOME extension: tasks with
   done, stopwatch timer, copy, edit, delete (with undo), drag to reorder,
   keyboard control, and clear completed. */

const MAX_TITLE_LEN = 120;
const UNDO_SECONDS = 6;
const DRAG_THRESHOLD = 6;    // px of movement before a press becomes a drag

// Unique id even for tasks created within the same millisecond.
let _idSeq = 0;
const nextId = () => Date.now() * 1000 + (_idSeq++ % 1000);

// ── Storage (chrome.storage.local, with a localStorage fallback) ──────────
const store = {
  async load() {
    try {
      if (chrome?.storage?.local) {
        const o = await chrome.storage.local.get('tasks');
        return normalize(o.tasks);
      }
    } catch {}
    try { return normalize(JSON.parse(localStorage.getItem('tasks'))); } catch { return []; }
  },
  save(tasks) {
    try { chrome?.storage?.local?.set({ tasks }); } catch {}
    try { localStorage.setItem('tasks', JSON.stringify(tasks)); } catch {}
  },
};
function normalize(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(t => ({
    id: t.id ?? Date.now() + Math.random(),
    title: String(t.title ?? ''),
    done: !!t.done,
    elapsedSeconds: Number(t.elapsedSeconds) || 0,
    running: !!t.running,
    startedAt: typeof t.startedAt === 'number' ? t.startedAt : null,
  }));
}

// ── Theme (chosen on the options page) ────────────────────────────────────
const applyTheme = light => document.body.classList.toggle('light', !!light);
async function loadTheme() {
  try {
    if (globalThis.chrome?.storage?.local)
      return !!(await chrome.storage.local.get('lightTheme')).lightTheme;
  } catch {}
  try { return localStorage.getItem('lightTheme') === 'true'; } catch { return false; }
}
globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes.lightTheme) applyTheme(changes.lightTheme.newValue);
});

// ── Time helpers ─────────────────────────────────────────────────────────
const liveElapsed = t =>
  t.running && t.startedAt ? t.elapsedSeconds + Math.floor((Date.now() - t.startedAt) / 1000)
                           : t.elapsedSeconds;
function formatElapsed(total) {
  const s = Math.max(0, Math.floor(total || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60) return `${m}m ${rs}s`;
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 24) return `${h}h ${rm}m`;
  const d = Math.floor(h / 24), rh = h % 24;
  return `${d}d ${rh}h`;
}

// ── Icon builders ────────────────────────────────────────────────────────
const glyph = (name, cls = '') =>
  `<span class="icon ${cls}"><svg viewBox="0 0 512 512">${GLYPHS[name]}</svg></span>`;
const SYS = {
  copy: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="5.25" y="5.25" width="8.5" height="9" rx="1.5"/><path d="M10.75 5.25V3.5A1.25 1.25 0 0 0 9.5 2.25H3.5A1.25 1.25 0 0 0 2.25 3.5v6.25A1.25 1.25 0 0 0 3.5 11h1.75"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.2 4.2L19 7"/></svg>`,
  play: `<svg viewBox="0 0 16 16"><path fill="currentColor" d="M4 2.6v10.8a.6.6 0 0 0 .9.52l8.6-5.4a.6.6 0 0 0 0-1.04L4.9 2.08A.6.6 0 0 0 4 2.6z"/></svg>`,
  pause: `<svg viewBox="0 0 16 16"><rect x="3" y="2" width="4" height="12" rx="1" fill="currentColor"/><rect x="9" y="2" width="4" height="12" rx="1" fill="currentColor"/></svg>`,
  grip: `<svg viewBox="0 0 16 16"><g fill="currentColor"><circle cx="5.5" cy="3.5" r="1.4"/><circle cx="10.5" cy="3.5" r="1.4"/><circle cx="5.5" cy="8" r="1.4"/><circle cx="10.5" cy="8" r="1.4"/><circle cx="5.5" cy="12.5" r="1.4"/><circle cx="10.5" cy="12.5" r="1.4"/></g></svg>`,
};
const sys = (kind, cls = '') => `<span class="icon ${cls}">${SYS[kind]}</span>`;
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── State ────────────────────────────────────────────────────────────────
let tasks = [];
let editingId = null;
let confirmingClear = false;
let undo = null;          // { task, idx, timer } for the last deleted task
let focusTaskId = null;   // row to re-focus after a keyboard-driven render
let drag = null;

const $list = document.getElementById('list');
const $bottom = document.getElementById('bottom');
const $count = document.getElementById('hCount');
document.getElementById('hEmblem').innerHTML =
  `<svg viewBox="0 0 512 512">${GLYPHS.ankh}</svg>`;

const openCount = () => tasks.filter(t => !t.done).length;
const doneCount = () => tasks.filter(t => t.done).length;
const persist = () => store.save(tasks);
const byId = id => tasks.find(t => String(t.id) === String(id));
const rowEls = () => [...$list.querySelectorAll('.row')];
const rowEl = id => $list.querySelector(`.row[data-id="${id}"]`);

function updateCount() {
  const open = openCount(), total = tasks.length;
  $count.textContent = total === 0 ? 'empty' : open === 0 ? 'all done' : `${open} open`;
}

// ── Render ───────────────────────────────────────────────────────────────
function render() {
  updateCount();

  $list.innerHTML = tasks.length === 0
    ? `<div class="empty">${glyph('papyrus', 'glyph')}
         <h3>The papyrus is blank</h3>
         <p>Inscribe your first deed below</p>
       </div>`
    : tasks.map(rowHTML).join('');

  $bottom.innerHTML = (undo ? undoHTML() : '') + (confirmingClear ? confirmHTML() : addRowHTML());
  wireBottom();

  // Focus: the edit field while editing, a row after a keyboard action,
  // otherwise the add field so several tasks can be typed in a row.
  const editInput = document.querySelector('.edit-shell input');
  if (editInput) { editInput.focus(); editInput.select(); return; }
  if (focusTaskId !== null) {
    const el = rowEl(focusTaskId);
    focusTaskId = null;
    if (el) { el.focus(); return; }
  }
  document.getElementById('addInput')?.focus();
}

function rowHTML(t) {
  if (t.id === editingId) {
    return `<div class="edit-shell" data-id="${t.id}">
      <input type="text" maxlength="${MAX_TITLE_LEN}" value="${esc(t.title)}" />
      <button class="btn seal" data-action="save-edit" data-id="${t.id}">Seal</button>
      <button class="btn ghost" data-action="cancel-edit">Cancel</button>
    </div>`;
  }
  const state = t.done ? ' done' : t.running ? ' running' : '';
  const titleHTML = esc(t.title);
  // Idle (not-done) rows reveal their time on hover; running and done rows
  // keep their count visible, flush right.
  const label = t.done
    ? (t.elapsedSeconds > 0 ? `<span class="t-lbl">${formatElapsed(t.elapsedSeconds)}</span>` : '')
    : `<span class="t-lbl${t.running ? '' : ' reveal'}" data-tlbl="${t.id}">${formatElapsed(liveElapsed(t))}</span>`;
  const timerBtn = t.done ? '' :
    `<button class="ibtn timer-btn reveal" data-action="timer" data-id="${t.id}" tabindex="-1" title="${t.running ? 'Pause timer' : 'Start timer'}">${sys(t.running ? 'pause' : 'play')}</button>`;
  return `<div class="row${state}" data-id="${t.id}" tabindex="0">
    <span class="grip" aria-hidden="true">${SYS.grip}</span>
    <button class="chk" data-action="toggle" data-id="${t.id}" tabindex="-1" title="${t.done ? 'Mark as not done' : 'Mark done'}">${t.done ? glyph('feather') : ''}</button>
    <span class="title" title="${titleHTML}">${titleHTML}</span>
    <span class="timer">${label}${timerBtn}</span>
    <span class="controls reveal">
      <button class="ibtn copy" data-action="copy" data-id="${t.id}" tabindex="-1" title="Copy">${sys('copy')}</button>
      <button class="ibtn edit" data-action="edit" data-id="${t.id}" tabindex="-1" title="Edit">${glyph('pen')}</button>
      <button class="ibtn del" data-action="del" data-id="${t.id}" tabindex="-1" title="Delete">${glyph('blade')}</button>
    </span>
  </div>`;
}

function undoHTML() {
  return `<div class="undo">
    <span class="msg">Deleted “${esc(undo.task.title)}”</span>
    <button class="btn undo-btn" data-action="undo">Undo</button>
  </div>`;
}

function addRowHTML() {
  const dc = doneCount();
  const clear = dc > 0
    ? `<button class="clear-btn" data-action="clear" title="Clear completed">
         ${glyph('sunset')}<span class="cnt">${dc}</span></button>` : '';
  return `<div class="addrow">
    <label class="input-shell">
      ${glyph('scarab', 'scarab')}
      <input id="addInput" type="text" maxlength="${MAX_TITLE_LEN}" placeholder="Inscribe a deed…" autocomplete="off" />
    </label>
    ${clear}
  </div>`;
}

function confirmHTML() {
  const dc = doneCount();
  return `<div class="confirm">
    <div class="top">
      <span class="medallion">${glyph('sunset')}</span>
      <div>
        <div class="ttl">Clear completed deeds?</div>
        <div class="sub">${dc} finished deed${dc === 1 ? '' : 's'} will be sent to the afterlife.</div>
      </div>
    </div>
    <div class="actions">
      <button class="btn ghost" data-action="cancel-clear">Keep</button>
      <button class="btn send" data-action="confirm-clear">Send away</button>
    </div>
  </div>`;
}

function wireBottom() {
  const add = document.getElementById('addInput');
  add?.addEventListener('keydown', e => {
    if (e.isComposing) return;
    if (e.key === 'ArrowUp') {
      const rows = rowEls();
      if (rows.length) { e.preventDefault(); rows[rows.length - 1].focus(); }
      return;
    }
    if (e.key !== 'Enter') return;
    const title = add.value.trim().slice(0, MAX_TITLE_LEN);
    if (!title) return;
    tasks.unshift({ id: nextId(), title, done: false, elapsedSeconds: 0, running: false, startedAt: null });
    persist();
    render();
  });
  const editInput = document.querySelector('.edit-shell input');
  editInput?.addEventListener('keydown', e => {
    if (!e.isComposing && e.key === 'Enter') commitEdit(editingId, editInput.value);
  });
}

// ── Task actions (shared by mouse and keyboard) ──────────────────────────
function toggleDone(t) {
  t.done = !t.done;
  if (t.done && t.running) { t.elapsedSeconds = liveElapsed(t); t.running = false; t.startedAt = null; }
  persist(); render();
}

function toggleTimer(t) {
  if (t.done) return;
  if (t.running) { t.elapsedSeconds = liveElapsed(t); t.running = false; t.startedAt = null; }
  else { t.running = true; t.startedAt = Date.now(); }
  persist(); render();
}

function startEdit(t) { editingId = t.id; render(); }

function commitEdit(id, value) {
  const t = byId(id);
  const v = value.trim().slice(0, MAX_TITLE_LEN);
  if (t && v) t.title = v;
  editingId = null;
  focusTaskId = id;
  persist(); render();
}

function moveTask(t, delta) {
  const from = tasks.indexOf(t), to = from + delta;
  if (to < 0 || to >= tasks.length) return;
  tasks.splice(from, 1);
  tasks.splice(to, 0, t);
  focusTaskId = t.id;
  persist(); render();
}

function deleteTask(t) {
  dropUndo();
  const idx = tasks.indexOf(t);
  tasks.splice(idx, 1);
  // Expire by removing just the bar: a full render would discard an
  // in-progress edit elsewhere in the popup.
  undo = { task: t, idx, timer: setTimeout(() => { undo = null; $bottom.querySelector('.undo')?.remove(); }, UNDO_SECONDS * 1000) };
  persist(); render();
}

function restoreDeleted() {
  const { task, idx } = undo;
  dropUndo();
  tasks.splice(Math.min(idx, tasks.length), 0, task);
  persist(); render();
}

function dropUndo() {
  if (!undo) return;
  clearTimeout(undo.timer);
  undo = null;
}

async function copyTask(t, btn) {
  try { await navigator.clipboard.writeText(t.title); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = t.title; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch {}
    ta.remove();
  }
  if (!btn) return;
  const inner = btn.innerHTML;
  btn.innerHTML = sys('check');
  btn.classList.add('copied');
  setTimeout(() => { btn.innerHTML = inner; btn.classList.remove('copied'); }, 900);
}

// ── Mouse ────────────────────────────────────────────────────────────────
document.getElementById('app').addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const t = byId(btn.dataset.id);
  switch (btn.dataset.action) {
    case 'toggle': toggleDone(t); break;
    case 'timer': toggleTimer(t); break;
    case 'copy': copyTask(t, btn); break;
    case 'edit': startEdit(t); break;
    case 'del': deleteTask(t); break;
    case 'undo': restoreDeleted(); break;
    case 'save-edit': commitEdit(btn.dataset.id, document.querySelector('.edit-shell input').value); break;
    case 'cancel-edit': focusTaskId = editingId; editingId = null; render(); break;
    case 'clear': confirmingClear = true; render(); break;
    case 'cancel-clear': confirmingClear = false; render(); break;
    case 'confirm-clear':
      tasks = tasks.filter(x => !x.done); confirmingClear = false; persist(); render(); break;
  }
});

// ── Keyboard ─────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.isComposing) return;
  if (e.key === 'Escape') {
    // Back out of an edit or a confirmation before closing the popup.
    e.preventDefault();
    if (editingId !== null) { focusTaskId = editingId; editingId = null; render(); }
    else if (confirmingClear) { confirmingClear = false; render(); }
    else window.close();
    return;
  }
  const row = e.target.classList?.contains('row') ? e.target : null;
  if (row) onRowKey(e, byId(row.dataset.id), row);
});

function onRowKey(e, t, row) {
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    moveTask(t, e.key === 'ArrowUp' ? -1 : 1);
    return;
  }
  if (e.altKey || e.metaKey) return;

  const rows = rowEls(), i = rows.indexOf(row);
  switch (e.key) {
    case 'ArrowUp': rows[i - 1]?.focus(); break;
    case 'ArrowDown': (rows[i + 1] ?? document.getElementById('addInput'))?.focus(); break;
    case ' ': focusTaskId = t.id; toggleDone(t); break;
    case 'Enter': case 'F2': case 'e': case 'E': startEdit(t); break;
    case 't': case 'T': if (!t.done) { focusTaskId = t.id; toggleTimer(t); } break;
    case 'c': case 'C': copyTask(t, row.querySelector('.ibtn.copy')); break;
    case 'Delete': case 'Backspace': {
      const k = tasks.indexOf(t);
      focusTaskId = (tasks[k + 1] ?? tasks[k - 1])?.id ?? null;
      deleteTask(t);
      break;
    }
    default: return;
  }
  e.preventDefault();
}

// ── Drag to reorder ──────────────────────────────────────────────────────
$list.addEventListener('pointerdown', e => {
  if (e.button !== 0 || editingId !== null) return;
  const row = e.target.closest('.row');
  if (!row || e.target.closest('button')) return;
  drag = { row, idx: rowEls().indexOf(row), startY: e.clientY, pointerId: e.pointerId, active: false, to: -1 };
});

document.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dy = e.clientY - drag.startY;
  if (!drag.active) {
    if (Math.abs(dy) < DRAG_THRESHOLD) return;
    startDrag();
  }
  dragTo(dy);
});

document.addEventListener('pointerup', e => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const d = drag;
  drag = null;
  if (!d.active) return;
  document.body.classList.remove('dragging');
  if (d.to !== d.idx) {
    const [moved] = tasks.splice(d.idx, 1);
    tasks.splice(d.to, 0, moved);
    persist();
  }
  render();
});

document.addEventListener('pointercancel', () => {
  if (drag?.active) { document.body.classList.remove('dragging'); render(); }
  drag = null;
});

function startDrag() {
  const d = drag;
  d.active = true;
  d.els = rowEls();
  d.tops = d.els.map(el => el.offsetTop);
  d.heights = d.els.map(el => el.offsetHeight);
  const gap = d.els.length > 1 ? d.tops[1] - d.tops[0] - d.heights[0] : 0;
  d.span = d.heights[d.idx] + gap;
  const last = d.els.length - 1;
  d.minDy = d.tops[0] - d.tops[d.idx];
  d.maxDy = d.tops[last] + d.heights[last] - d.heights[d.idx] - d.tops[d.idx];
  d.shift = d.els.map(() => 0);
  d.to = d.idx;
  d.row.classList.add('dragging');
  d.row.setPointerCapture(d.pointerId);
  document.body.classList.add('dragging');
  window.getSelection()?.removeAllRanges();
}

function dragTo(dy) {
  const d = drag;
  dy = Math.max(d.minDy, Math.min(d.maxDy, dy));
  d.row.style.transform = `translateY(${dy}px)`;

  const center = d.tops[d.idx] + d.heights[d.idx] / 2 + dy;
  let to = d.idx;
  for (let i = d.idx + 1; i < d.els.length; i++)
    if (center > d.tops[i] + d.heights[i] / 2) to = i;
  for (let i = d.idx - 1; i >= 0; i--)
    if (center < d.tops[i] + d.heights[i] / 2) to = i;
  d.to = to;

  d.els.forEach((el, i) => {
    if (i === d.idx) return;
    let want = 0;
    if (i > d.idx && i <= to) want = -d.span;
    else if (i < d.idx && i >= to) want = d.span;
    if (want !== d.shift[i]) {
      d.shift[i] = want;
      el.style.transform = want ? `translateY(${want}px)` : '';
    }
  });
}

// ── Live timer tick (updates running labels while the popup is open) ──────
setInterval(() => {
  for (const t of tasks) {
    if (!t.running) continue;
    const el = document.querySelector(`[data-tlbl="${t.id}"]`);
    if (el) el.textContent = formatElapsed(liveElapsed(t));
  }
}, 1000);

// ── Boot ─────────────────────────────────────────────────────────────────
(async () => {
  const [loaded, light] = await Promise.all([store.load(), loadTheme()]);
  tasks = loaded;
  applyTheme(light);
  render();
})();
