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

// Strikethrough colour for finished titles, set in Pango markup (not CSS).
const DONE_TEXT = '#857C6B';
const DONE_TEXT_LIGHT = '#8E8573';

// Tasks live in the config dir, not the extension folder, which is replaced
// on every update.
const DATA_DIR = GLib.build_filenamev([GLib.get_user_config_dir(), 'scroll-of-deeds']);
const DATA_FILE = GLib.build_filenamev([DATA_DIR, 'tasks.json']);

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const isGioError = (e, code) => e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, code);

async function loadTasks(cancellable) {
    try {
        const [bytes] = await Gio.File.new_for_path(DATA_FILE).load_contents_async(cancellable);
        const tasks = JSON.parse(new TextDecoder().decode(bytes)) || [];
        for (const t of tasks) {
            t.elapsedSeconds ??= 0;
            t.running ??= false;
            t.startedAt ??= null;
        }
        return tasks;
    } catch (e) {
        if (isGioError(e, Gio.IOErrorEnum.CANCELLED)) throw e;
        if (!isGioError(e, Gio.IOErrorEnum.NOT_FOUND)) console.error(e);
        return [];
    }
}

// GRAB/GRABBING came with mutter's CSS cursor names; older shells (45/46) lack them.
const CURSOR_GRAB = Meta.Cursor.GRAB ?? Meta.Cursor.POINTING_HAND ?? Meta.Cursor.DEFAULT;
const CURSOR_GRABBING = Meta.Cursor.GRABBING ?? Meta.Cursor.DND_IN_DRAG ?? Meta.Cursor.DEFAULT;

const MENU_WIDTH = 560;
const MENU_MAX_LIST_HEIGHT = 460;
const UNDO_SECONDS = 6;
const MAX_TITLE_LEN = 120;
const DRAG_THRESHOLD = 6;

// Unique id even for tasks created within the same millisecond.
let idSeq = 0;
function nextId() { return Date.now() * 1000 + (idSeq++ % 1000); }

// Symbolic icons from icons/, recoloured by the CSS `color` of styleClass.
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

const AnkhDoIndicator = GObject.registerClass(
class AnkhDoIndicator extends PanelMenu.Button {

    _init(ext) {
        super._init(0.0, 'Ankh Do');
        this._ext = ext;
        this._tasks = [];
        this._loaded = false;
        this._saving = false;
        this._saveWanted = false;
        this._cancellable = new Gio.Cancellable();
        this._editRowId = null;
        this._drag = null;
        this._rowActors = [];
        this._confirmingClear = false;
        this._addEntry = null;
        this._addFocusTimer = 0;
        this._rowFocusTimer = 0;
        this._copyTimer = 0;
        this._tickTimer = 0;
        this._undo = null;          // { task, idx, timer, item } for the last deleted task
        this._focusTaskId = null;   // row to re-focus after a keyboard-driven rebuild
        this._tooltip = null;
        this._tooltipForItem = null;
        this._timerLabels = new Map();

        const panelBox = new St.BoxLayout({
            style_class: 'ankhdo-panel-pill',
            y_align: Clutter.ActorAlign.CENTER,
        });
        panelBox.add_child(glyph(ext, 'ankh-panel', 16, 'ankhdo-panel-icon'));
        this._panelCount = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ankhdo-panel-count',
        });
        panelBox.add_child(this._panelCount);
        this.add_child(panelBox);

        this.menu.actor.style = `min-width:${MENU_WIDTH}px;`;
        this.menu.actor.add_style_class_name('ankhdo-menu');
        this._settings = ext.getSettings();
        this._applyTheme();

        const headerItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        headerItem.remove_style_class_name('popup-menu-item');
        headerItem.style = 'padding:0;';
        const header = new St.BoxLayout({
            vertical: false, x_expand: true,
            style_class: 'ankhdo-header',
        });
        header.add_child(glyph(ext, 'ankh', 20, 'ankhdo-header-emblem'));
        header.add_child(new St.Label({
            text: 'ANKH DO',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ankhdo-header-title',
        }));
        header.add_child(new St.Widget({ x_expand: true }));
        this._headerCount = new St.Label({
            text: '', y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ankhdo-header-count',
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
        this._load();

        this._themeChangedId = this._settings.connect('changed::light-theme', () => {
            this._applyTheme();
            this._buildMenu();
        });
        // On the menu, not global.stage: the open menu holds a grab, so events
        // never reach the stage.
        this._menuCaptureId = this.menu.actor.connect('captured-event', (_a, event) => this._onMenuCapture(event));
        this._menuOpenId = this.menu.connect('open-state-changed', (_menu, isOpen) => {
            if (isOpen) {
                this._updateClocks();
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
    }

    _updateClocks() {
        for (const task of this._tasks) {
            const lbl = task.running && this._timerLabels.get(task.id);
            if (lbl) lbl.text = formatElapsed(liveElapsedSeconds(task));
        }
    }

    // Clocks only tick while the menu is open.
    _startTick() {
        if (this._tickTimer) return;
        this._tickTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._updateClocks();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTick() {
        if (this._tickTimer) GLib.source_remove(this._tickTimer);
        this._tickTimer = 0;
    }

    get _light() {
        return this._settings.get_boolean('light-theme');
    }

    // The ground is set inline on the content box only: the outer actor is a
    // plain rectangle that also covers the margin around the rounded bubble.
    _applyTheme() {
        const light = this._light;
        const [ground, border] = light
            ? ['#F6F0E4', 'rgba(110,90,50,0.22)']
            : ['#171513', 'rgba(232,197,106,0.16)'];
        this.menu.box.style = `width:${MENU_WIDTH}px;background-color:${ground};border-color:${border};`;
        if (light) this.menu.actor.add_style_class_name('ankhdo-light');
        else this.menu.actor.remove_style_class_name('ankhdo-light');
    }

    async _load() {
        try {
            const tasks = await loadTasks(this._cancellable);
            // Anything added in the moment before the file was read stays on top.
            this._tasks = this._tasks.concat(tasks);
            this._loaded = true;
            if (this._saveWanted) this._flushSave();
            this._updatePanelCount();
            this._buildMenu();
        } catch (e) {
            if (!isGioError(e, Gio.IOErrorEnum.CANCELLED)) console.error(e);
        }
    }

    // Writes are queued: one at a time, always the latest state, so an older
    // write can never land after a newer one. Nothing is written before the
    // file has been read, or the saved list would be clobbered.
    _save() {
        this._saveWanted = true;
        if (this._loaded && !this._saving) this._flushSave();
    }

    async _flushSave() {
        this._saving = true;
        while (this._saveWanted) {
            this._saveWanted = false;
            try {
                GLib.mkdir_with_parents(DATA_DIR, 0o700);
                const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(this._tasks, null, 2)));
                await Gio.File.new_for_path(DATA_FILE).replace_contents_bytes_async(
                    bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            } catch (e) {
                console.error(e);
            }
        }
        this._saving = false;
    }

    _updatePanelCount() {
        const remaining = this._tasks.filter(t => !t.done).length;
        this._panelCount.text = `${remaining}`;
        this._headerCount.text =
            this._tasks.length === 0 ? 'empty'
            : remaining === 0 ? 'all done'
            : `${remaining} open`;
    }

    // Shows a task's full text when its title is cut off.
    _showTooltip(label, text, rowActor) {
        if (!label.clutter_text.get_layout().is_ellipsized()) return;
        this._hideTooltip();
        const tt = new St.Label({
            text,
            style_class: this._light ? 'ankhdo-tooltip ankhdo-light' : 'ankhdo-tooltip',
        });
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

    // Deferred: a just-built entry isn't mapped yet, so focusing it now
    // wouldn't stick.
    _focusAddDeferred() {
        if (this._addFocusTimer) return;
        this._addFocusTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
            this._addFocusTimer = 0;
            if (this._addEntry && this._editRowId === null && this.menu.isOpen)
                global.stage.set_key_focus(this._addEntry);
            return GLib.SOURCE_REMOVE;
        });
    }

    _showCopyFeedback(btn) {
        const icon = btn.get_child();
        // A repeat copy restarts the timer but keeps the real original icon.
        if (this._copyTimer) GLib.source_remove(this._copyTimer);
        else this._copyIconName = icon.icon_name;
        icon.icon_name = 'object-select-symbolic';
        btn.add_style_class_name('ankhdo-copied');
        this._copyTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 900, () => {
            this._copyTimer = 0;
            icon.icon_name = this._copyIconName;
            btn.remove_style_class_name('ankhdo-copied');
            return GLib.SOURCE_REMOVE;
        });
    }

    _buildMenu() {
        this._hideTooltip();
        // The button the copy feedback points at is about to be destroyed.
        if (this._copyTimer) {
            GLib.source_remove(this._copyTimer);
            this._copyTimer = 0;
        }
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

            const mark = glyph(this._ext, 'papyrus', 50, 'ankhdo-empty-glyph');
            mark.set_x_align(Clutter.ActorAlign.CENTER);
            col.add_child(mark);

            const emptyTitle = new St.Label({
                text: 'The papyrus is blank',
                style_class: 'ankhdo-empty-title',
            });
            emptyTitle.set_x_align(Clutter.ActorAlign.CENTER);
            col.add_child(emptyTitle);

            const emptyHint = new St.Label({
                text: 'Inscribe your first deed below',
                style_class: 'ankhdo-empty-hint',
            });
            emptyHint.set_x_align(Clutter.ActorAlign.CENTER);
            col.add_child(emptyHint);

            empty.add_child(col);
            this._taskSection.addMenuItem(empty);
        } else {
            for (const task of this._tasks) this._taskRow(task);
        }

        if (this._undo) this._buildUndoRow();
        this._buildAddRow();
        if (this._focusTaskId !== null) this._focusRowDeferred();
    }

    // Deferred for the same reason as _focusAddDeferred.
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

    _toggleDone(task) {
        task.done = !task.done;
        if (task.done && task.running) {
            task.elapsedSeconds = liveElapsedSeconds(task);
            task.running = false;
            task.startedAt = null;
        }
        this._save();
        this._updatePanelCount();
        this._buildMenu();
    }

    _toggleTimer(task) {
        if (task.done) return;
        if (task.running) {
            task.elapsedSeconds = liveElapsedSeconds(task);
            task.running = false;
            task.startedAt = null;
        } else {
            task.running = true;
            task.startedAt = Date.now();
        }
        this._save();
        this._buildMenu();
    }

    _copyTask(task, btn) {
        try {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, task.title);
            this._showCopyFeedback(btn);
        } catch (e) { console.error(e); }
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
        this._save();
        this._focusTaskId = task.id;
        this._buildMenu();
    }

    // Returning EVENT_STOP also keeps the menu item from treating Space/Enter
    // as "activate", which would close the menu.
    _onRowKey(task, event, copyBtn) {
        const sym = event.get_key_symbol();
        const alt = (event.get_state() & Clutter.ModifierType.MOD1_MASK) !== 0;

        if (alt && (sym === Clutter.KEY_Up || sym === Clutter.KEY_Down)) {
            this._moveTask(task, sym === Clutter.KEY_Up ? -1 : 1);
            return Clutter.EVENT_STOP;
        }
        if (alt) return Clutter.EVENT_PROPAGATE;

        switch (sym) {
        case Clutter.KEY_space:
            this._focusTaskId = task.id;
            this._toggleDone(task);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Return: case Clutter.KEY_KP_Enter: case Clutter.KEY_F2: case Clutter.KEY_e:
            this._startEdit(task);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_t:
            if (!task.done) {
                this._focusTaskId = task.id;
                this._toggleTimer(task);
            }
            return Clutter.EVENT_STOP;
        case Clutter.KEY_c:
            this._copyTask(task, copyBtn);
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Delete: case Clutter.KEY_BackSpace: {
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
        const bar = new St.BoxLayout({ x_expand: true, style_class: 'ankhdo-undo-shell' });
        const msg = new St.Label({
            text: `Deleted “${this._undo.task.title}”`,
            x_expand: true, y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ankhdo-undo-label',
        });
        msg.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        bar.add_child(msg);
        const undoBtn = new St.Button({
            label: 'Undo', reactive: true, track_hover: true, can_focus: true,
            style_class: 'ankhdo-undo-btn',
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
        this._save();
        this._undo = { task, idx, item: null, timer: 0 };
        // Expires by removing just the bar: a full rebuild would discard an
        // edit in progress.
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
        this._save();
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
            style_class: 'ankhdo-input-shell',
        });
        inputShell.add_child(glyph(this._ext, 'scarab', 18, 'ankhdo-add-scarab'));

        const entry = new St.Entry({
            hint_text: 'Inscribe a deed…',
            can_focus: true, x_expand: true,
            style_class: 'ankhdo-entry',
        });
        entry.clutter_text.set_max_length(MAX_TITLE_LEN);
        entry.get_clutter_text().connect('activate', () => {
            const title = entry.get_text().trim().slice(0, MAX_TITLE_LEN);
            if (!title) return;
            this._tasks.unshift({
                id: nextId(), title, done: false,
                elapsedSeconds: 0, running: false, startedAt: null,
            });
            this._save();
            this._updatePanelCount();
            this._buildMenu();
        });
        inputShell.add_child(entry);
        row.add_child(inputShell);
        this._addEntry = entry;

        // Keep focus here so several tasks can be typed in a row.
        if (this._editRowId === null && this._focusTaskId === null && this.menu.isOpen)
            this._focusAddDeferred();

        const doneCount = this._tasks.filter(t => t.done).length;
        if (doneCount > 0) {
            const clearBox = new St.BoxLayout({ vertical: false, style: 'spacing:6px;' });
            clearBox.add_child(glyph(this._ext, 'sunset', 15, 'ankhdo-clear-glyph'));
            clearBox.add_child(new St.Label({
                text: `${doneCount}`,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'ankhdo-clear-count',
            }));
            const clearBtn = new St.Button({
                child: clearBox,
                accessible_name: `Clear ${doneCount} completed task${doneCount === 1 ? '' : 's'}`,
                style_class: 'ankhdo-clear-btn',
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
            style_class: 'ankhdo-confirm-shell',
        });

        const top = new St.BoxLayout({ vertical: false, x_expand: true, style: 'spacing:12px;' });
        const medallion = new St.Bin({
            style_class: 'ankhdo-confirm-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        medallion.set_child(glyph(this._ext, 'sunset', 18, 'ankhdo-confirm-glyph'));
        top.add_child(medallion);

        const textCol = new St.BoxLayout({
            vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        });
        textCol.add_child(new St.Label({
            text: 'Clear completed deeds?',
            style_class: 'ankhdo-confirm-title',
        }));
        textCol.add_child(new St.Label({
            text: `${doneCount} finished deed${doneCount === 1 ? '' : 's'} will be sent to the afterlife.`,
            style_class: 'ankhdo-confirm-sub',
        }));
        top.add_child(textCol);
        card.add_child(top);

        const btnRow = new St.BoxLayout({
            vertical: false, x_expand: true,
            style: 'spacing:8px; padding-top:12px;',
        });
        btnRow.add_child(new St.Widget({ x_expand: true }));

        const cancelBtn = new St.Button({
            label: 'Keep',
            style_class: 'ankhdo-cancel-btn',
            reactive: true, track_hover: true,
        });
        cancelBtn.connect('clicked', () => {
            this._confirmingClear = false;
            this._buildMenu();
        });

        const confirmBtn = new St.Button({
            label: 'Send away',
            style_class: 'ankhdo-confirm-remove',
            reactive: true, track_hover: true,
        });
        confirmBtn.connect('clicked', () => {
            this._tasks = this._tasks.filter(t => !t.done);
            this._save();
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

    _rowButton(icon, accessibleName, styleClass, onClick) {
        const btn = new St.Button({
            child: icon,
            accessible_name: accessibleName,
            style_class: `ankhdo-icon-btn ${styleClass}`,
            reactive: true, track_hover: true,
        });
        btn.connect('clicked', onClick);
        return btn;
    }

    _taskRow(task) {
        if (this._editRowId === task.id) {
            this._buildEditRow(task);
            return;
        }
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: true, hover: true });
        item.style = 'padding:8px 14px 8px 4px;';
        item.add_style_class_name('ankhdo-row');
        if (task.running) item.add_style_class_name('ankhdo-row-running');
        this._rowActors.push({ item, task });

        const row = new St.BoxLayout({
            vertical: false, x_expand: true,
            style_class: 'ankhdo-task-layout',
        });

        // Opacity, not visibility, so the grip keeps its space and nothing shifts.
        const grip = glyph(this._ext, 'grip', 14, 'ankhdo-grip');
        grip.set_y_align(Clutter.ActorAlign.CENTER);
        grip.reactive = true;
        grip.track_hover = true;
        grip.opacity = 0;
        grip.connect('notify::hover', () => {
            if (!this._drag?.active)
                global.display.set_cursor(grip.hover ? CURSOR_GRAB : Meta.Cursor.DEFAULT);
        });
        row.add_child(grip);

        const chk = new St.Button({
            style_class: task.done ? 'ankhdo-checkbox ankhdo-checkbox-done'
                                   : 'ankhdo-checkbox',
            reactive: true, track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (task.done) {
            const f = glyph(this._ext, 'feather', 12, 'ankhdo-check-feather');
            f.set_x_align(Clutter.ActorAlign.CENTER);
            f.set_y_align(Clutter.ActorAlign.CENTER);
            chk.set_child(f);
        }
        chk.connect('clicked', () => this._toggleDone(task));
        row.add_child(chk);

        const titleLbl = new St.Label({
            text: task.title, x_expand: true,
            style_class: task.done ? 'ankhdo-title ankhdo-title-done'
                                   : 'ankhdo-title',
        });
        titleLbl.set_x_align(Clutter.ActorAlign.START);
        titleLbl.set_y_align(Clutter.ActorAlign.CENTER);
        titleLbl.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
        titleLbl.clutter_text.set_single_line_mode(true);
        titleLbl.clutter_text.set_line_wrap(false);
        if (task.done) {
            titleLbl.clutter_text.set_markup(
                `<span strikethrough="true" foreground="${this._light ? DONE_TEXT_LIGHT : DONE_TEXT}">${GLib.markup_escape_text(task.title, -1)}</span>`
            );
        }
        row.add_child(titleLbl);

        // A finished task keeps its final time but loses the start button.
        const timerGroup = new St.BoxLayout({ vertical: false, style: 'spacing:4px;' });
        let timerLbl = null, timerBtn = null;
        if (task.done) {
            if (task.elapsedSeconds > 0) {
                timerLbl = new St.Label({
                    text: formatElapsed(task.elapsedSeconds),
                    y_align: Clutter.ActorAlign.CENTER,
                    style_class: 'ankhdo-timer-label',
                });
                timerGroup.add_child(timerLbl);
            }
        } else {
            timerLbl = new St.Label({
                text: formatElapsed(liveElapsedSeconds(task)),
                y_align: Clutter.ActorAlign.CENTER,
                style_class: task.running ? 'ankhdo-timer-label ankhdo-timer-label-active'
                                          : 'ankhdo-timer-label',
            });
            this._timerLabels.set(task.id, timerLbl);
            timerGroup.add_child(timerLbl);

            timerBtn = this._rowButton(
                new St.Icon({
                    icon_name: task.running ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic',
                    icon_size: 16,
                }),
                task.running ? 'Pause timer' : 'Start timer',
                task.running ? 'ankhdo-icon-timer ankhdo-timer-active' : 'ankhdo-icon-timer',
                () => this._toggleTimer(task));
            timerGroup.add_child(timerBtn);
        }
        row.add_child(timerGroup);

        const actions = new St.BoxLayout({ vertical: false, style: 'spacing:4px;' });
        const copyBtn = this._rowButton(new St.Icon({ icon_name: 'edit-copy-symbolic', icon_size: 16 }),
            'Copy task', 'ankhdo-icon-copy', () => this._copyTask(task, copyBtn));
        actions.add_child(copyBtn);
        actions.add_child(this._rowButton(glyph(this._ext, 'pen', 16),
            'Edit task', 'ankhdo-icon-edit', () => this._startEdit(task)));
        actions.add_child(this._rowButton(glyph(this._ext, 'blade', 16),
            'Delete task', 'ankhdo-icon-delete', () => this._deleteTask(task)));
        row.add_child(actions);

        // Controls appear on hover or keyboard focus. They are hidden with
        // `visible` so their space collapses and the time sits flush right;
        // the row's min-height keeps its height from changing. Running and
        // finished tasks keep their time visible at rest.
        const revealables = [actions];
        if (timerBtn) revealables.push(timerBtn);
        if (timerLbl && !task.running && !task.done) revealables.push(timerLbl);
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

    _onMenuCapture(event) {
        const type = event.type();

        // Focus rings only while using the keyboard: St has no :focus-visible,
        // and hovering a menu item also gives it key focus.
        if (type === Clutter.EventType.KEY_PRESS)
            this.menu.box.add_style_class_name('ankhdo-kbd-nav');
        else if (type === Clutter.EventType.MOTION)
            this.menu.box.remove_style_class_name('ankhdo-kbd-nav');

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
                if (Math.abs(dy) < DRAG_THRESHOLD) return Clutter.EVENT_PROPAGATE;
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
                this._save();
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

        // Rows paint in list order, so a moved row would slide under later
        // rows. Instead a clone floats above the menu and the original, made
        // transparent, stays as the gap (a clone paints at its own opacity).
        // Geometry is read before restyling, which invalidates the allocation.
        const item = items[d.idx];
        const [x, y] = item.get_transformed_position();
        const box = item.get_allocation_box();
        d.cloneY = y;
        d.clone = new Clutter.Clone({ source: item, reactive: false });
        d.clone.set_position(x, y);
        d.clone.set_size(box.get_width(), box.get_height());
        item.add_style_class_name('ankhdo-row-dragging');
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
                item.remove_style_class_name('ankhdo-row-dragging');
            }
            global.display.set_cursor(Meta.Cursor.DEFAULT);
        }
        this._drag = null;
    }

    _buildEditRow(task) {
        const item = new PopupMenu.PopupBaseMenuItem({ reactive: false });
        item.style = 'padding:8px 14px;';
        item.add_style_class_name('ankhdo-edit-shell');
        const row = new St.BoxLayout({ vertical: false, x_expand: true });

        const entry = new St.Entry({
            text: task.title, can_focus: true, x_expand: true,
            style_class: 'ankhdo-edit-entry',
        });
        entry.clutter_text.set_max_length(MAX_TITLE_LEN);
        const commit = () => {
            const val = entry.get_text().trim().slice(0, MAX_TITLE_LEN);
            if (val) task.title = val;
            this._save();
            this._editRowId = null;
            this._focusTaskId = task.id;
            this._buildMenu();
        };
        entry.get_clutter_text().connect('activate', commit);
        row.add_child(entry);

        const saveBtn = new St.Button({
            label: 'Seal',
            style_class: 'ankhdo-save-btn',
            reactive: true, track_hover: true,
        });
        saveBtn.connect('clicked', commit);
        row.add_child(saveBtn);

        const cancelBtn = new St.Button({
            label: 'Cancel',
            style_class: 'ankhdo-cancel-btn',
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
        if (this._copyTimer) {
            GLib.source_remove(this._copyTimer);
            this._copyTimer = 0;
        }
        this._cancelDrag();
        this._cancellable.cancel();
        this.menu.actor.disconnect(this._menuCaptureId);
        this.menu.disconnect(this._menuOpenId);
        this._settings.disconnect(this._themeChangedId);
        this._settings = null;
        this._hideTooltip();
        this._dropUndo();
        super.destroy();
    }
});

export default class AnkhDoExtension extends Extension {
    enable() {
        this._ind = new AnkhDoIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._ind);
    }
    disable() {
        this._ind?.destroy();
        this._ind = null;
    }
}
