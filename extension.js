import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

// ── Pharaonic palette (tomb-at-night with treasure gold) ─────────────────
const C = {
    gold:       '#E8C56A',   // treasure gold — brand (ankh + title) only
    lapis:      '#6F9AE0',   // lapis lazuli — copy, add field, header
    turquoise:  '#45C4B0',   // faience turquoise — panel, open seals
    malachite:  '#5FB98A',   // malachite green — done / running
    carnelian:  '#E0654B',   // carnelian red — delete
    silver:     '#C3CCE0',   // Thoth's moon silver — edit
    ochre:      '#E89A4F',   // sunset ochre — clear completed
    cream:      '#EAD9B0',   // papyrus cream — primary text
    doneText:   '#7A84A3',   // faded slate — finished titles recede
};

// ── Storage ──────────────────────────────────────────────────────────────
// Tasks live in the user's config dir (persists across extension updates),
// NOT inside the extension folder (which is wiped on every update).
const DATA_SUBDIR = 'scroll-of-deeds';

function dataDir() {
    return GLib.build_filenamev([GLib.get_user_config_dir(), DATA_SUBDIR]);
}
function getStoragePath() {
    return GLib.build_filenamev([dataDir(), 'tasks.json']);
}
function legacyStoragePath(ext) {
    return GLib.build_filenamev([ext.path, 'tasks.json']);
}

function parseTasks(file) {
    const [, bytes] = file.load_contents(null);
    const tasks = JSON.parse(new TextDecoder('utf-8').decode(bytes)) || [];
    tasks.forEach(t => {
        if (typeof t.elapsedSeconds !== 'number') t.elapsedSeconds = 0;
        if (typeof t.running !== 'boolean') t.running = false;
        if (typeof t.startedAt !== 'number') t.startedAt = null;
    });
    return tasks;
}

function loadTasks(ext) {
    try {
        const primary = Gio.File.new_for_path(getStoragePath());
        if (primary.query_exists(null)) return parseTasks(primary);
        // One-time migration from the old in-extension location.
        const legacy = Gio.File.new_for_path(legacyStoragePath(ext));
        if (legacy.query_exists(null)) {
            const tasks = parseTasks(legacy);
            saveTasks(ext, tasks);
            return tasks;
        }
        return [];
    } catch { return []; }
}

function saveTasks(ext, tasks) {
    try {
        GLib.mkdir_with_parents(dataDir(), 0o700);
        const file = Gio.File.new_for_path(getStoragePath());
        file.replace_contents(
            new TextEncoder().encode(JSON.stringify(tasks, null, 2)),
            null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null
        );
    } catch (e) { logError(e); }
}

// GRAB/GRABBING came with mutter's CSS cursor names; older shells (45/46) lack them.
const CURSOR_GRAB = Meta.Cursor.GRAB ?? Meta.Cursor.POINTING_HAND ?? Meta.Cursor.DEFAULT;
const CURSOR_GRABBING = Meta.Cursor.GRABBING ?? Meta.Cursor.DND_IN_DRAG ?? Meta.Cursor.DEFAULT;

const MENU_WIDTH = 560;
const MENU_MAX_LIST_HEIGHT = 460;   // the list grows with its tasks up to this, then scrolls
const UNDO_SECONDS = 6;
const MAX_TITLE_LEN = 120;   // cap on a task's text length

// Unique id even for tasks created within the same millisecond.
let idSeq = 0;
function nextId() { return Date.now() * 1000 + (idSeq++ % 1000); }

// Custom pharaonic glyph loaded from icons/*-symbolic.svg (recolors via CSS,
// and falls back to gold fill if the shell does not recolor it).
function glyph(ext, name, size, styleClass) {
    const path = GLib.build_filenamev([ext.path, 'icons', `${name}-symbolic.svg`]);
    const icon = new St.Icon({
        gicon: Gio.icon_new_for_string(path),
        icon_size: size,
    });
    if (styleClass) icon.add_style_class_name(styleClass);
    return icon;
}

function liveElapsedSeconds(task) {
    if (task.running && task.startedAt)
        return task.elapsedSeconds + Math.floor((Date.now() - task.startedAt) / 1000);
    return task.elapsedSeconds;
}

function formatElapsed(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds || 0));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), rs = s % 60;
    if (m < 60) return `${m}m ${rs}s`;
    const h = Math.floor(m / 60), rm = m % 60;
    if (h < 24) return `${h}h ${rm}m`;
    const d = Math.floor(h / 24), rh = h % 24;
    return `${d}d ${rh}h`;
}

// ── Indicator ────────────────────────────────────────────────────────────
const GnomeTodoIndicator = GObject.registerClass(
class GnomeTodoIndicator extends PanelMenu.Button {

    _init(ext) {
        super._init(0.0, 'Ankh Do');
        this._ext = ext;
        this._tasks = loadTasks(ext);
        this._editRowId = null;
        this._drag = null;
        this._rowActors = [];
        this._confirmingClear = false;
        this._addEntry = null;
        this._addFocusTimer = 0;
        this._undo = null;   // { task, idx, timer, item } for the last deleted task
        this._focusTaskId = null;   // row to re-focus after a keyboard-driven rebuild
        this._rowFocusTimer = 0;
        this._tooltip = null;
        this._tooltipForItem = null;
        this._timerLabels = new Map();

        const panelBox = new St.BoxLayout({
            style_class: 'gnome-todo-panel-pill',
            y_align: Clutter.ActorAlign.CENTER,
        });
        panelBox.add_child(glyph(ext, 'cartouche-check', 16, 'gnome-todo-panel-icon'));
        this._panelCount = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'gnome-todo-panel-count',
        });
        panelBox.add_child(this._panelCount);
        this.add_child(panelBox);
        this.add_style_class_name('gnome-todo-panel-button');

        // Fixed width on the content box: titles flex to fill a row, so a long
        // title must ellipsize rather than widen the menu.
        // Night-lapis gradient: a tomb ceiling — deep blue, gold stars.
        // Only on the content box: the outer actor is a plain rectangle that
        // also covers the margin around the rounded bubble.
        const menuBg =
            'background-gradient-direction:vertical;' +
            'background-gradient-start:#171B2E;' +
            'background-gradient-end:#10131F;' +
            'border-color:rgba(111,154,224,0.28);';
        this.menu.actor.style = `min-width:${MENU_WIDTH}px;`;
        this.menu.box.style = `width:${MENU_WIDTH}px;${menuBg}`;

        // ── Header cartouche (sun emblem · title · remaining count) ──────
        const headerItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        headerItem.remove_style_class_name('popup-menu-item');
        headerItem.style = 'padding:0;';
        const header = new St.BoxLayout({
            vertical: false, x_expand: true,
            style_class: 'gnome-todo-header',
        });
        header.add_child(glyph(ext, 'ankh', 20, 'gnome-todo-header-emblem'));
        header.add_child(new St.Label({
            text: 'ANKH DO',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'gnome-todo-header-title',
        }));
        header.add_child(new St.Widget({ x_expand: true }));
        this._headerCount = new St.Label({
            text: '', y_align: Clutter.ActorAlign.CENTER,
            style_class: 'gnome-todo-header-count',
        });
        header.add_child(this._headerCount);
        headerItem.add_child(header);
        this.menu.addMenuItem(headerItem);

        this._taskSection = new PopupMenu.PopupMenuSection();
        this._scrollView = new St.ScrollView({
            style: `max-height:${MENU_MAX_LIST_HEIGHT}px;`,
            x_expand: true,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            hscrollbar_policy: St.PolicyType.NEVER,
            child: this._taskSection.actor,
        });

        const scrollItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        scrollItem.remove_style_class_name('popup-menu-item');
        scrollItem.style = 'padding:0;';
        scrollItem.add_child(this._scrollView);
        this.menu.addMenuItem(scrollItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._bottomSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._bottomSection);

        this._buildMenu();
        this._updatePanelCount();

        // Drag-to-reorder. Captured on the menu itself: while open, the menu's
        // grab means events never reach global.stage.
        this.menu.actor.connect('captured-event', (_a, event) => this._onMenuCapture(event));

        // Focus the "add task" field whenever the menu opens.
        this.menu.connect('open-state-changed', (menu, isOpen) => {
            if (isOpen) {
                // Labels were last drawn when the menu closed; bring them current.
                for (const task of this._tasks) {
                    const lbl = task.running && this._timerLabels.get(task.id);
                    if (lbl) lbl.text = formatElapsed(liveElapsedSeconds(task));
                }
                this._startTick();
                this._focusAddDeferred();
            } else {
                this._stopTick();
                this._hideTooltip();
                this._cancelDrag();
                this._dropUndo();
                global.display.set_cursor(Meta.Cursor.DEFAULT);
            }
        });

        this._tickTimer = 0;
    }

    // Running clocks only need to tick while someone can see them.
    _startTick() {
        if (this._tickTimer) return;
        this._tickTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            for (const task of this._tasks) {
                const lbl = task.running && this._timerLabels.get(task.id);
                if (lbl) lbl.text = formatElapsed(liveElapsedSeconds(task));
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTick() {
        if (this._tickTimer) GLib.source_remove(this._tickTimer);
        this._tickTimer = 0;
    }

    _updatePanelCount() {
        const remaining = this._tasks.filter(t => !t.done).length;
        this._panelCount.text = `${remaining}`;
        if (this._headerCount) {
            const total = this._tasks.length;
            this._headerCount.text =
                total === 0 ? 'empty'
                : remaining === 0 ? 'all done'
                : `${remaining} open`;
        }
    }

    // Floating tooltip showing a task's full text when its label is truncated.
    _showTooltip(label, text, rowActor) {
        let truncated = false;
        try { truncated = label.clutter_text.get_layout().is_ellipsized(); }
        catch { truncated = text.length > 28; }
        if (!truncated) return;
        this._hideTooltip();
        const tt = new St.Label({ text, style_class: 'gnome-todo-tooltip' });
        tt.clutter_text.set_line_wrap(true);
        tt.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        Main.uiGroup.add_child(tt);
        const [rx, ry] = rowActor.get_transformed_position();
        const [, natH] = tt.get_preferred_height(340);
        let ty = ry - natH - 6;
        if (ty < 32) ty = ry + rowActor.height + 6;
        tt.set_position(Math.round(rx + 40), Math.round(ty));
        this._tooltip = tt;
        this._tooltipForItem = rowActor;
    }

    _hideTooltip() {
        if (this._tooltip) { this._tooltip.destroy(); this._tooltip = null; }
        this._tooltipForItem = null;
    }

    // Focus the add field on the next loop iteration, once it's mapped.
    _focusAddDeferred() {
        if (this._addFocusTimer) return;
        this._addFocusTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            this._addFocusTimer = 0;
            try {
                if (this._addEntry && this._editRowId === null && this.menu.isOpen)
                    global.stage.set_key_focus(this._addEntry);
            } catch {}
            return GLib.SOURCE_REMOVE;
        });
    }

    _showCopyFeedback(btn) {
        const icon = btn.get_child();
        if (!icon) return;
        const originalIcon = icon.icon_name;
        icon.icon_name = 'object-select-symbolic';
        btn.add_style_class_name('gnome-todo-copied');
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 900, () => {
            try {
                icon.icon_name = originalIcon;
                btn.remove_style_class_name('gnome-todo-copied');
            } catch {}
            return GLib.SOURCE_REMOVE;
        });
    }

    // ── Menu build ──────────────────────────────────────────────────────
    _buildMenu() {
        this._hideTooltip();
        this._taskSection.removeAll();
        this._bottomSection.removeAll();
        this._timerLabels.clear();
        this._rowActors = [];

        if (this._tasks.length === 0) {
            const empty = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
            empty.remove_style_class_name('popup-menu-item');
            empty.style = 'padding:36px 16px 32px 16px;';
            const col = new St.BoxLayout({
                vertical: true, x_expand: true, y_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });

            const mark = glyph(this._ext, 'papyrus', 50, 'gnome-todo-empty-glyph');
            mark.set_x_align(Clutter.ActorAlign.CENTER);
            col.add_child(mark);

            const emptyTitle = new St.Label({
                text: 'The papyrus is blank',
                style_class: 'gnome-todo-empty-title',
            });
            emptyTitle.set_x_align(Clutter.ActorAlign.CENTER);
            col.add_child(emptyTitle);

            const emptyHint = new St.Label({
                text: 'Inscribe your first deed below',
                style_class: 'gnome-todo-empty-hint',
            });
            emptyHint.set_x_align(Clutter.ActorAlign.CENTER);
            col.add_child(emptyHint);

            empty.add_child(col);
            this._taskSection.addMenuItem(empty);
        } else {
            this._tasks.forEach((task, idx) => this._taskRow(task, idx));
        }

        if (this._undo) this._buildUndoRow();
        this._buildAddRow();
        if (this._focusTaskId !== null) this._focusRowDeferred();
    }

    // Like _focusAddDeferred: a just-rebuilt row isn't mapped yet.
    _focusRowDeferred() {
        const id = this._focusTaskId;
        this._focusTaskId = null;
        if (this._rowFocusTimer) GLib.source_remove(this._rowFocusTimer);
        this._rowFocusTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            this._rowFocusTimer = 0;
            const r = this._rowActors.find(x => x.task.id === id);
            if (r && this.menu.isOpen) r.item.grab_key_focus();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ── Task actions (shared by mouse and keyboard) ──────────────────
    _toggleDone(task) {
        task.done = !task.done;
        if (task.done && task.running) {
            task.elapsedSeconds = liveElapsedSeconds(task);
            task.running = false;
            task.startedAt = null;
        }
        saveTasks(this._ext, this._tasks);
        this._updatePanelCount();
        this._buildMenu();
    }

    _toggleTimer(task) {
        if (task.done) return; // a completed task's timer never runs
        if (task.running) {
            task.elapsedSeconds = liveElapsedSeconds(task);
            task.running = false;
            task.startedAt = null;
        } else {
            task.running = true;
            task.startedAt = Date.now();
        }
        saveTasks(this._ext, this._tasks);
        this._buildMenu();
    }

    _copyTask(task, btn) {
        try {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, task.title);
            this._showCopyFeedback(btn);
        } catch (e) { logError(e); }
    }

    _startEdit(task) {
        this._editRowId = task.id;
        this._buildMenu();
    }

    _moveTask(task, delta) {
        const from = this._tasks.indexOf(task);
        const to = from + delta;
        if (to < 0 || to >= this._tasks.length) return;
        this._tasks.splice(from, 1);
        this._tasks.splice(to, 0, task);
        saveTasks(this._ext, this._tasks);
        this._focusTaskId = task.id;
        this._buildMenu();
    }

    // Keys on a focused row. Returning STOP also keeps the menu item from
    // treating Space/Enter as "activate" (which would close the menu).
    _onRowKey(task, event, copyBtn) {
        const sym = event.get_key_symbol();
        const state = event.get_state();
        const alt = (state & Clutter.ModifierType.MOD1_MASK) !== 0;
        const K = Clutter;

        if (alt && (sym === K.KEY_Up || sym === K.KEY_Down)) {
            this._moveTask(task, sym === K.KEY_Up ? -1 : 1);
            return Clutter.EVENT_STOP;
        }
        if (alt) return Clutter.EVENT_PROPAGATE;

        switch (sym) {
        case K.KEY_space:
            this._focusTaskId = task.id;
            this._toggleDone(task);
            return Clutter.EVENT_STOP;
        case K.KEY_Return: case K.KEY_KP_Enter: case K.KEY_F2: case K.KEY_e:
            this._startEdit(task);
            return Clutter.EVENT_STOP;
        case K.KEY_t:
            if (task.done) return Clutter.EVENT_STOP;
            this._focusTaskId = task.id;
            this._toggleTimer(task);
            return Clutter.EVENT_STOP;
        case K.KEY_c:
            this._copyTask(task, copyBtn);
            return Clutter.EVENT_STOP;
        case K.KEY_Delete: case K.KEY_BackSpace: {
            const i = this._tasks.indexOf(task);
            const next = this._tasks[i + 1] ?? this._tasks[i - 1];
            this._focusTaskId = next ? next.id : null;
            this._deleteTask(task);
            return Clutter.EVENT_STOP;
        }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _buildUndoRow() {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        item.remove_style_class_name('popup-menu-item');
        item.style = 'padding:8px 14px 0 14px;';
        const bar = new St.BoxLayout({ x_expand: true, style_class: 'gnome-todo-undo-shell' });
        const msg = new St.Label({
            text: `Deleted “${this._undo.task.title}”`,
            x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            style_class: 'gnome-todo-undo-label',
        });
        msg.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        bar.add_child(msg);
        const undoBtn = new St.Button({
            label: 'Undo', reactive: true, track_hover: true, can_focus: true,
            style_class: 'gnome-todo-undo-btn',
        });
        undoBtn.connect('clicked', () => this._restoreDeleted());
        bar.add_child(undoBtn);
        item.add_child(bar);
        this._bottomSection.addMenuItem(item);
        this._undo.item = item;
    }

    _deleteTask(task) {
        this._dropUndo();
        const idx = this._tasks.indexOf(task);
        this._tasks.splice(idx, 1);
        saveTasks(this._ext, this._tasks);
        this._undo = { task, idx, item: null, timer: 0 };
        // Expire by removing just the bar: a full rebuild would discard an
        // in-progress edit elsewhere in the menu.
        this._undo.timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, UNDO_SECONDS, () => {
            this._undo.timer = 0;
            this._dropUndo();
            return GLib.SOURCE_REMOVE;
        });
        this._updatePanelCount();
        this._buildMenu();
    }

    _restoreDeleted() {
        const { task, idx } = this._undo;
        this._dropUndo();
        this._tasks.splice(Math.min(idx, this._tasks.length), 0, task);
        saveTasks(this._ext, this._tasks);
        this._updatePanelCount();
        this._buildMenu();
    }

    _dropUndo() {
        if (!this._undo) return;
        if (this._undo.timer) GLib.source_remove(this._undo.timer);
        this._undo.item?.destroy();
        this._undo = null;
    }

    _buildAddRow() {
        if (this._confirmingClear) {
            this._buildClearConfirmRow();
            return;
        }

        const bottomItem = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        bottomItem.style = 'padding:10px 14px;';
        const row = new St.BoxLayout({ vertical: false, x_expand: true });

        const inputShell = new St.BoxLayout({
            vertical: false, x_expand: true,
            style_class: 'gnome-todo-input-shell',
        });
        inputShell.add_child(glyph(this._ext, 'scarab', 18, 'gnome-todo-add-scarab'));

        const entry = new St.Entry({
            hint_text: 'Inscribe a deed…',
            can_focus: true, x_expand: true,
            style_class: 'gnome-todo-entry',
        });
        entry.clutter_text.set_max_length(MAX_TITLE_LEN);
        entry.get_clutter_text().connect('activate', () => {
            const title = entry.get_text().trim().slice(0, MAX_TITLE_LEN);
            if (!title) return;
            this._tasks.unshift({
                id: nextId(), title, done: false,
                elapsedSeconds: 0, running: false, startedAt: null,
            });
            saveTasks(this._ext, this._tasks);
            this._updatePanelCount();
            this._buildMenu();
        });
        inputShell.add_child(entry);
        row.add_child(inputShell);
        this._addEntry = entry;

        // Keep the add field focused whenever the menu is open and no task is
        // being edited, so tasks can be added one after another (press Enter,
        // keep typing) without re-clicking the field. Deferred, because a just-
        // rebuilt entry isn't mapped yet, so a synchronous focus wouldn't stick.
        if (this._editRowId === null && this._focusTaskId === null && this.menu.isOpen)
            this._focusAddDeferred();

        const doneCount = this._tasks.filter(t => t.done).length;
        if (doneCount > 0) {
            const clearBox = new St.BoxLayout({ vertical: false, style: 'spacing:6px;' });
            clearBox.add_child(glyph(this._ext, 'sunset', 15, 'gnome-todo-clear-glyph'));
            clearBox.add_child(new St.Label({
                text: `${doneCount}`,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'gnome-todo-clear-count',
            }));
            const clearBtn = new St.Button({
                child: clearBox,
                accessible_name: `Clear ${doneCount} completed task${doneCount === 1 ? '' : 's'}`,
                style_class: 'gnome-todo-clear-btn',
                reactive: true, track_hover: true,
            });
            clearBtn.connect('clicked', () => {
                this._confirmingClear = true;
                this._buildMenu();
            });
            row.add_child(clearBtn);
        }

        bottomItem.add_child(row);
        this._bottomSection.addMenuItem(bottomItem);
    }

    _buildClearConfirmRow() {
        this._addEntry = null;
        const doneCount = this._tasks.filter(t => t.done).length;
        const bottomItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        bottomItem.remove_style_class_name('popup-menu-item');
        bottomItem.style = 'padding:8px 12px;';

        const card = new St.BoxLayout({
            vertical: true, x_expand: true,
            style_class: 'gnome-todo-confirm-shell',
        });

        // headline row: icon medallion + title / subtitle
        const top = new St.BoxLayout({ vertical: false, x_expand: true, style: 'spacing:12px;' });
        const medallion = new St.Bin({
            style_class: 'gnome-todo-confirm-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        medallion.set_child(glyph(this._ext, 'sunset', 18, 'gnome-todo-confirm-glyph'));
        top.add_child(medallion);

        const textCol = new St.BoxLayout({
            vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        });
        textCol.add_child(new St.Label({
            text: 'Clear completed deeds?',
            style_class: 'gnome-todo-confirm-title',
        }));
        textCol.add_child(new St.Label({
            text: `${doneCount} finished deed${doneCount === 1 ? '' : 's'} will be sent to the afterlife.`,
            style_class: 'gnome-todo-confirm-sub',
        }));
        top.add_child(textCol);
        card.add_child(top);

        // actions
        const btnRow = new St.BoxLayout({
            vertical: false, x_expand: true,
            style: 'spacing:8px; padding-top:12px;',
        });
        btnRow.add_child(new St.Widget({ x_expand: true }));

        const cancelBtn = new St.Button({
            label: 'Keep',
            style_class: 'gnome-todo-cancel-btn',
            reactive: true, track_hover: true,
        });
        cancelBtn.connect('clicked', () => {
            this._confirmingClear = false;
            this._buildMenu();
        });

        const confirmBtn = new St.Button({
            label: 'Send away',
            style_class: 'gnome-todo-confirm-remove',
            reactive: true, track_hover: true,
        });
        confirmBtn.connect('clicked', () => {
            this._tasks = this._tasks.filter(t => !t.done);
            saveTasks(this._ext, this._tasks);
            this._updatePanelCount();
            this._confirmingClear = false;
            this._buildMenu();
        });

        btnRow.add_child(cancelBtn);
        btnRow.add_child(confirmBtn);
        card.add_child(btnRow);
        bottomItem.add_child(card);
        this._bottomSection.addMenuItem(bottomItem);
    }

    _iconButton(iconName, onClick, extraClass = '', accessibleName = '') {
        const btn = new St.Button({
            child: new St.Icon({ icon_name: iconName, icon_size: 16 }),
            accessible_name: accessibleName,
            reactive: true, track_hover: true,
        });
        btn.add_style_class_name('gnome-todo-icon-btn');
        if (extraClass) btn.add_style_class_name(extraClass);
        btn.connect('clicked', onClick);
        return btn;
    }

    // ── Single task row ──────────────────────────────────────────────────
    _taskRow(task, idx) {
        if (this._editRowId === task.id) {
            this._buildEditRow(task);
            return;
        }
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: true, hover: true });
        item.style = 'padding:8px 14px 8px 4px;';
        item.add_style_class_name('gnome-todo-row');
        if (task.done) item.add_style_class_name('gnome-todo-row-done');
        else if (task.running) item.add_style_class_name('gnome-todo-row-running');
        this._rowActors.push({ item, task });

        const row = new St.BoxLayout({
            vertical: false, x_expand: true,
            style_class: 'gnome-todo-task-layout',
        });

        // Drag grip: shown on hover so rows read as movable. Uses opacity, not
        // visibility, so it always keeps its space and nothing shifts.
        const grip = glyph(this._ext, 'grip', 14, 'gnome-todo-grip');
        grip.set_y_align(Clutter.ActorAlign.CENTER);
        grip.reactive = true;
        grip.track_hover = true;
        grip.opacity = 0;
        grip.connect('notify::hover', () => {
            if (!this._drag?.active)
                global.display.set_cursor(grip.hover ? CURSOR_GRAB : Meta.Cursor.DEFAULT);
        });
        row.add_child(grip);

        // Done seal: a round malachite disc bearing the Feather of Ma'at.
        const chk = new St.Button({
            style_class: task.done ? 'gnome-todo-checkbox gnome-todo-checkbox-done'
                                   : 'gnome-todo-checkbox',
            reactive: true, track_hover: true,
            // Stay a fixed 22px circle; don't stretch to the row height when the
            // row grows taller on hover (that turned the circle into a pill).
            y_align: Clutter.ActorAlign.CENTER, y_expand: false,
        });
        if (task.done) {
            const f = glyph(this._ext, 'feather', 12, 'gnome-todo-check-feather');
            f.set_x_align(Clutter.ActorAlign.CENTER);
            f.set_y_align(Clutter.ActorAlign.CENTER);
            chk.set_child(f);
        }
        chk.connect('clicked', () => this._toggleDone(task));
        row.add_child(chk);

        const titleLbl = new St.Label({
            text: task.title, x_expand: true,
            style_class: task.done ? 'gnome-todo-title gnome-todo-title-done'
                                   : 'gnome-todo-title',
        });
        titleLbl.set_x_align(Clutter.ActorAlign.START);
        titleLbl.set_y_align(Clutter.ActorAlign.CENTER);
        titleLbl.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        titleLbl.clutter_text.set_single_line_mode(true);
        titleLbl.clutter_text.set_line_wrap(false);
        if (task.done) {
            titleLbl.clutter_text.set_markup(
                `<span strikethrough="true" foreground="${C.doneText}">${GLib.markup_escape_text(task.title, -1)}</span>`
            );
        }
        row.add_child(titleLbl);

        // Timer. A running/idle task gets the live label + start-pause button.
        // A completed task keeps its final elapsed count (read-only) but no
        // button — its timer cannot be run again unless the task is unmarked.
        const timerGroup = new St.BoxLayout({ vertical: false, style: 'spacing:4px;' });
        let timerLbl = null, timerBtn = null;
        if (task.done) {
            if (task.elapsedSeconds > 0) {
                timerLbl = new St.Label({
                    text: formatElapsed(task.elapsedSeconds),
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: 'gnome-todo-timer-label',
                });
                timerGroup.add_child(timerLbl);
            }
        } else {
            timerLbl = new St.Label({
                text: formatElapsed(liveElapsedSeconds(task)),
                y_align: Clutter.ActorAlign.CENTER,
                style_class: task.running ? 'gnome-todo-timer-label gnome-todo-timer-label-active'
                                          : 'gnome-todo-timer-label',
            });
            this._timerLabels.set(task.id, timerLbl);
            timerGroup.add_child(timerLbl);

            timerBtn = new St.Button({
                child: new St.Icon({
                    icon_name: task.running ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic',
                    icon_size: 16,
                }),
                accessible_name: task.running ? 'Pause timer' : 'Start timer',
                reactive: true, track_hover: true,
            });
            timerBtn.add_style_class_name('gnome-todo-icon-btn');
            timerBtn.add_style_class_name('gnome-todo-icon-timer');
            if (task.running) timerBtn.add_style_class_name('gnome-todo-timer-active');
            timerBtn.connect('clicked', () => this._toggleTimer(task));
            timerGroup.add_child(timerBtn);
        }
        row.add_child(timerGroup);

        // Actions
        const actions = new St.BoxLayout({ vertical: false, style: 'spacing:4px;' });

        const copyBtn = this._iconButton('edit-copy-symbolic',
            () => this._copyTask(task, copyBtn), 'gnome-todo-icon-copy', 'Copy task');
        actions.add_child(copyBtn);

        // Edit — the scribe's pen (writing / editing the record)
        const editBtn = new St.Button({
            child: glyph(this._ext, 'pen', 16),
            accessible_name: 'Edit task',
            reactive: true, track_hover: true,
        });
        editBtn.add_style_class_name('gnome-todo-icon-btn');
        editBtn.add_style_class_name('gnome-todo-icon-edit');
        editBtn.connect('clicked', () => this._startEdit(task));
        actions.add_child(editBtn);

        // Delete — the flint des-blade (execration / the knife that severs Apophis)
        const delBtn = new St.Button({
            child: glyph(this._ext, 'blade', 16),
            accessible_name: 'Delete task',
            reactive: true, track_hover: true,
        });
        delBtn.add_style_class_name('gnome-todo-icon-btn');
        delBtn.add_style_class_name('gnome-todo-icon-delete');
        delBtn.connect('clicked', () => this._deleteTask(task));
        actions.add_child(delBtn);

        row.add_child(actions);

        // Reveal controls only while the row is hovered. The elapsed-time
        // label stays visible for a running task so time reads at a glance.
        // Reveal controls on hover. Toggling `visible` (not opacity) collapses
        // their space, so a running task's time label sits flush at the right
        // edge instead of floating mid-row. The label stays shown for a running
        // task; idle rows reveal it with the rest.
        const revealables = [actions];
        if (timerBtn) revealables.push(timerBtn);
        // Idle (not-done) rows reveal their time on hover; a done task's final
        // count stays visible at rest.
        if (timerLbl && !task.running && !task.done) revealables.push(timerLbl);
        // Revealed by mouse hover or keyboard focus alike.
        let focused = false;
        const syncRevealed = () => {
            const shown = item.hover || focused;
            for (const a of revealables) a.visible = shown;
            grip.opacity = shown ? 255 : 0;
        };
        syncRevealed();
        item.connect('notify::hover', () => {
            syncRevealed();
            if (item.hover) this._showTooltip(titleLbl, task.title, item);
            else if (this._tooltipForItem === item) this._hideTooltip();
        });
        item.connect('key-focus-in', () => { focused = true; syncRevealed(); });
        item.connect('key-focus-out', () => { focused = false; syncRevealed(); });
        item.connect('key-press-event', (_a, event) => this._onRowKey(task, event, copyBtn));

        item.add_child(row);
        this._taskSection.addMenuItem(item);
    }

    // ── Drag to reorder ─────────────────────────────────────────────────
    _onMenuCapture(event) {
        const type = event.type();

        // Focus rings only while navigating by keyboard (St has no :focus-visible;
        // hovering a menu item also gives it key focus).
        if (type === Clutter.EventType.KEY_PRESS)
            this.menu.box.add_style_class_name('gnome-todo-kbd-nav');
        else if (type === Clutter.EventType.MOTION)
            this.menu.box.remove_style_class_name('gnome-todo-kbd-nav');

        // Connected before the shell's menu manager (which closes the whole menu
        // on Escape), so Escape can first back out of an edit or a confirmation.
        if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
            if (this._editRowId !== null) {
                this._focusTaskId = this._editRowId;
                this._editRowId = null;
                this._buildMenu();
                return Clutter.EVENT_STOP;
            }
            if (this._confirmingClear) {
                this._confirmingClear = false;
                this._buildMenu();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (type === Clutter.EventType.BUTTON_PRESS) {
            this._drag = null;
            if (event.get_button() !== Clutter.BUTTON_PRIMARY || this._editRowId !== null)
                return Clutter.EVENT_PROPAGATE;
            const target = global.stage.get_event_actor(event);
            const idx = this._rowActors.findIndex(r => r.item.contains(target));
            if (idx < 0 || this._pressedOnButton(target, this._rowActors[idx].item))
                return Clutter.EVENT_PROPAGATE;
            this._drag = { idx, startY: event.get_coords()[1], active: false, to: idx };
            return Clutter.EVENT_PROPAGATE;
        }

        if (!this._drag)
            return Clutter.EVENT_PROPAGATE;

        if (type === Clutter.EventType.MOTION) {
            const dy = event.get_coords()[1] - this._drag.startY;
            if (!this._drag.active) {
                if (Math.abs(dy) < 6) return Clutter.EVENT_PROPAGATE;
                this._startDrag();
            }
            this._dragTo(dy);
            return Clutter.EVENT_STOP;
        }

        if (type === Clutter.EventType.BUTTON_RELEASE) {
            const d = this._drag;
            this._drag = null;
            if (!d.active) return Clutter.EVENT_PROPAGATE;
            d.clone.destroy();
            global.display.set_cursor(Meta.Cursor.DEFAULT);
            if (d.to !== d.idx) {
                const [moved] = this._tasks.splice(d.idx, 1);
                this._tasks.splice(d.to, 0, moved);
                saveTasks(this._ext, this._tasks);
            }
            this._buildMenu();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _pressedOnButton(actor, rowItem) {
        for (let a = actor; a && a !== rowItem; a = a.get_parent())
            if (a instanceof St.Button) return true;
        return false;
    }

    _startDrag() {
        const d = this._drag;
        d.active = true;
        this._hideTooltip();
        const items = this._rowActors.map(r => r.item);
        d.tops = items.map(it => it.y);
        d.heights = items.map(it => it.height);
        const gap = items.length > 1 ? d.tops[1] - d.tops[0] - d.heights[0] : 0;
        d.span = d.heights[d.idx] + gap;
        d.minDy = d.tops[0] - d.tops[d.idx];
        const last = items.length - 1;
        d.maxDy = d.tops[last] + d.heights[last] - d.heights[d.idx] - d.tops[d.idx];
        d.shift = items.map(() => 0);

        // Rows paint in list order, so the row itself would slide under later
        // rows. Drag a clone floating above the menu; the original stays as the
        // (invisible) gap. A clone paints its source at the clone's opacity.
        // Read geometry before restyling: a style change invalidates the
        // allocation and the size getters would fall back to preferred size.
        const item = items[d.idx];
        const [x, y] = item.get_transformed_position();
        const box = item.get_allocation_box();
        d.cloneY = y;
        d.clone = new Clutter.Clone({ source: item, reactive: false });
        d.clone.set_position(x, y);
        d.clone.set_size(box.get_width(), box.get_height());
        item.add_style_class_name('gnome-todo-row-dragging');
        Main.uiGroup.add_child(d.clone);
        item.opacity = 0;
        global.display.set_cursor(CURSOR_GRABBING);
    }

    _dragTo(dy) {
        const d = this._drag;
        const items = this._rowActors.map(r => r.item);
        dy = Math.max(d.minDy, Math.min(d.maxDy, dy));
        d.clone.y = d.cloneY + dy;

        const center = d.tops[d.idx] + d.heights[d.idx] / 2 + dy;
        let to = d.idx;
        for (let i = d.idx + 1; i < items.length; i++)
            if (center > d.tops[i] + d.heights[i] / 2) to = i;
        for (let i = d.idx - 1; i >= 0; i--)
            if (center < d.tops[i] + d.heights[i] / 2) to = i;
        d.to = to;

        items.forEach((it, i) => {
            if (i === d.idx) return;
            let want = 0;
            if (i > d.idx && i <= to) want = -d.span;
            else if (i < d.idx && i >= to) want = d.span;
            if (want !== d.shift[i]) {
                d.shift[i] = want;
                it.ease({ translation_y: want, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            }
        });
    }

    _cancelDrag() {
        if (this._drag?.active) {
            this._drag.clone.destroy();
            for (const { item } of this._rowActors) {
                item.remove_all_transitions();
                item.translation_y = 0;
                item.opacity = 255;
                item.remove_style_class_name('gnome-todo-row-dragging');
            }
            global.display.set_cursor(Meta.Cursor.DEFAULT);
        }
        this._drag = null;
    }

    _buildEditRow(task) {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        item.style = 'padding:8px 14px;';
        item.add_style_class_name('gnome-todo-edit-shell');
        const row = new St.BoxLayout({ vertical: false, x_expand: true });

        const entry = new St.Entry({
            text: task.title, can_focus: true, x_expand: true,
            style_class: 'gnome-todo-edit-entry',
        });
        entry.clutter_text.set_max_length(MAX_TITLE_LEN);
        const commit = () => {
            const val = entry.get_text().trim().slice(0, MAX_TITLE_LEN);
            if (val) task.title = val;
            saveTasks(this._ext, this._tasks);
            this._editRowId = null;
            this._focusTaskId = task.id;
            this._buildMenu();
        };
        entry.get_clutter_text().connect('activate', commit);
        row.add_child(entry);

        const saveBtn = new St.Button({
            label: 'Seal',
            style_class: 'gnome-todo-save-btn',
            reactive: true, track_hover: true,
        });
        saveBtn.connect('clicked', commit);
        row.add_child(saveBtn);

        const cancelBtn = new St.Button({
            label: 'Cancel',
            style_class: 'gnome-todo-cancel-btn',
            reactive: true, track_hover: true,
        });
        cancelBtn.connect('clicked', () => { this._editRowId = null; this._buildMenu(); });
        row.add_child(cancelBtn);

        item.add_child(row);
        this._taskSection.addMenuItem(item);
        global.stage.set_key_focus(entry);
    }

    destroy() {
        this._stopTick();
        if (this._addFocusTimer) {
            GLib.source_remove(this._addFocusTimer);
            this._addFocusTimer = 0;
        }
        if (this._rowFocusTimer) {
            GLib.source_remove(this._rowFocusTimer);
            this._rowFocusTimer = 0;
        }
        this._hideTooltip();
        this._dropUndo();
        super.destroy();
    }
});

export default class GnomeTodoExtension extends Extension {
    enable() {
        this._ind = new GnomeTodoIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._ind);
    }
    disable() {
        this._ind?.destroy();
        this._ind = null;
    }
}
