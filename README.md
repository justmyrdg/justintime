# Jas in Time

*Slides, ink, and calling on students — just in time.*

A PDF viewer with pen/highlighter annotations plus a floating "index card" widget
for calling on students and giving them points (0–30). Students are stored in `students.csv`.

## Run
Double-click `start.bat` (or run `npm install` once, then `node server.js`) and open http://localhost:3000.

## Classes (data/*.csv)
Each class (section + subject) is its own CSV in the `data` folder, e.g.
`BCpET-3301 - Embedded Systems.csv`, so points are tracked separately per subject.
Switch classes with the menu at the top of the index card; the menu can also create
("copy names from this class") and rename classes.

Attendance is kept per class in `data/attendance/<class>.csv`: one row per student,
one column per date, with P (present), L (late), A (absent) or E (excused). Mark it
from the P/L/A/E buttons on the card (current student) or the Attendance panel
(whole class, any date, "Mark rest present").

Columns: `id,srcode,name,points`. You can edit the files in Excel while the app is
closed — rows without an id get one automatically. Points are always clamped to 0–30.

## Shortcuts
| Key | Action |
|---|---|
| V / P / H / E | Scroll · Pen · Highlighter · Eraser |
| L | Laser pointer (fading red trail, leaves no ink) |
| I / A / B | Line · Arrow · Box (hold Shift to snap angles / make a square) |
| T | Text — click to type, click existing text to edit, Enter to finish, Shift+Enter new line |
| S | Page thumbnails sidebar |
| N | Insert a blank whiteboard page after the current page (hover it to delete) |
| F | Presentation mode (full screen, one page at a time; Space/PageDown/wheel next, Backspace/PageUp back, Esc exits) |
| Ctrl+Z / Ctrl+Y | Undo / Redo ink |
| Ctrl+scroll | Zoom |
| PageUp / PageDown | Previous / next PDF page |
| ← / → | Previous / next student |
| ↑ / ↓ | +1 / −1 point |
| R | Random student (everyone is picked once before repeats) |
| C | Show / hide the index card |

Ink and inserted whiteboard pages are saved automatically in the browser per PDF (by file name + size).
**Export** downloads `<name> (annotated).pdf` with the ink drawn onto the original pages
(the text stays selectable). The last 8 opened PDFs are kept in the browser, so you can reopen them
from the history button next to **Open PDF** or from the start screen.
