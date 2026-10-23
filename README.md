<div align="center">

# 𓋹 Ankh Do

**A pharaonic-themed to-do manager for the GNOME top bar.**
Drag to reorder, time your deeds, undo mistakes — under a tomb-ceiling sky of lapis and gold.

![GNOME Shell](https://img.shields.io/badge/GNOME_Shell-45_·_46_·_47_·_48-4A86CF?logo=gnome&logoColor=white)
![License](https://img.shields.io/badge/license-GPL--2.0--or--later-blue)
![Glyphs](https://img.shields.io/badge/glyphs-CC_BY_3.0-lightgrey)

<img src="screenshots/menu.png" alt="The Ankh Do dropdown with tasks, a running timer, and hover controls" width="600">

</div>

## Features

- **Drag to reorder** — grab a task (or its grip) and drop it anywhere; the
  other tasks slide aside as you move.
- **Round "seal" checkbox** — a turquoise ring when open; done, it becomes a
  malachite disc bearing the Feather of Ma'at.
- **Per-task stopwatch**; time keeps counting even while the menu is closed. A
  completed task keeps its final time, read-only.
- **Copy, edit in place, delete** (a flint blade) — and **undo** a delete for a
  few seconds afterwards.
- **Hover to reveal** a row's controls; long titles show a full-text tooltip.
- **Clear completed** as a gentle "send to the West" (sunset), with a confirm card.
- **Fully keyboard-driven** — see the shortcuts below.
- A palette where every colour has one job, each a material the Egyptians used:
  a night-lapis ground (Nut's starry sky on tomb ceilings), **gold** for the
  name, **turquoise** for open tasks, **lapis** for the add field, **malachite**
  for done and running, **silver** for edit, **carnelian** for delete, and
  **sunset ochre** for clearing completed deeds.

## Screenshots

| Tasks, timer & controls | Empty state |
| --- | --- |
| <img src="screenshots/menu.png" alt="Populated menu" width="380"> | <img src="screenshots/empty.png" alt="Empty state" width="380"> |

## Keyboard

From the *Inscribe a deed* field, press <kbd>↑</kbd> to move into the list.

| Key | Action |
| --- | --- |
| <kbd>↑</kbd> / <kbd>↓</kbd> | Move between tasks |
| <kbd>Alt</kbd>+<kbd>↑</kbd> / <kbd>Alt</kbd>+<kbd>↓</kbd> | Move the task up / down |
| <kbd>Space</kbd> | Mark done / not done |
| <kbd>Enter</kbd>, <kbd>F2</kbd> or <kbd>E</kbd> | Edit (<kbd>Enter</kbd> saves, <kbd>Esc</kbd> cancels) |
| <kbd>T</kbd> | Start / pause the timer |
| <kbd>C</kbd> | Copy the task text |
| <kbd>Delete</kbd> | Delete (with undo) |
| <kbd>Esc</kbd> | Cancel an edit or confirmation; otherwise close the menu |

## Requirements

GNOME Shell **45, 46, 47, or 48** (developed and tested on 48).

## Install

### From source

```bash
ln -s "$PWD" "$HOME/.local/share/gnome-shell/extensions/gnome-todo@claudeai"
gnome-extensions enable gnome-todo@claudeai
```

Then reload the shell: **log out and back in** on Wayland, or press
<kbd>Alt</kbd>+<kbd>F2</kbd> → <kbd>r</kbd> on Xorg.

### From a package

```bash
gnome-extensions install --force gnome-todo@claudeai.shell-extension.zip
```

## Where your tasks live

Tasks are stored in `~/.config/scroll-of-deeds/tasks.json`, **outside** the
extension folder, so updating the extension never erases them. Data from an
older build (kept inside the extension folder) migrates automatically on first run.

## Publishing to extensions.gnome.org

Build the upload package (`gnome-todo@claudeai.shell-extension.zip`):

```bash
gnome-extensions pack --force --extra-source=icons .
```

Then:

1. Sign in at <https://extensions.gnome.org>.
2. Optionally add a `url` (your repo) to `metadata.json`.
3. Upload the zip at <https://extensions.gnome.org/upload/> and await review.

It already meets the review guidelines: readable code, no network access, clean
teardown in `disable()`, and bundled-glyph licensing credited in
`icons/CREDITS.txt`. extensions.gnome.org assigns the published version number,
so `version` in `metadata.json` need not be bumped by hand.

> **Note on the UUID.** `gnome-todo@claudeai` uses a placeholder domain. It is
> accepted as-is; if you'd prefer `ankh-do@yourhandle`, rename the folder
> and the `uuid` field to match, then re-package.

## Project layout

```
extension.js      · the indicator, menu, tasks, timers, and storage
stylesheet.css    · the pharaonic theme
metadata.json     · UUID, name, supported shell versions
icons/            · pharaonic glyphs (*-symbolic.svg) + CREDITS.txt
screenshots/      · images used in this README
```

## Credits & licence

Code is licensed **GPL-2.0-or-later** (see `LICENSE`), the conventional licence
for GNOME Shell extensions. The glyphs are derived from
[game-icons.net](https://game-icons.net) by **Lorc** and **Delapouite** under
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/); the winged sun-disk,
the cartouche panel icon, and the drag grip are original work released CC0.
Full attribution is in `icons/CREDITS.txt`.
