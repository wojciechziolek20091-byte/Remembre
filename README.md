# Remembre

A personal work calendar for schoolwork: tests, homework and every other
assignment in one month view, with a running list of what is due next.

No accounts, no server, no build step. It is three files &ndash; `index.html`,
`styles.css`, `app.js` &ndash; and two self-hosted typefaces. Tasks are saved in
the browser's own storage, so nothing about your coursework leaves your device.

![The calendar in its light theme](docs/screenshot-light.png)

## What it does

- **Add a task by answering questions.** Homework or test, then the subject,
  then whatever that subject needs. Maths asks which kind of work, whether it
  sits in the Core Topics or HL AI, and which chapters; economics asks whether
  it is Self Study, a Practice paper or something else, and which chapters.
  The other subjects ask nothing further. The task names itself from the
  answers, e.g. *Test Chapters 3-5 from Core Topics*, and the name stays
  editable.
- **Work from your timetable.** The default view is your school week, period by
  period. Choosing a lesson opens the form already knowing the subject, the
  date and the period's start time, so adding homework takes one tap and three
  answers. Work due shows against the lesson it belongs to.
- **See the month at a glance.** Every day cell lists what is due, with today
  marked and weekends tinted.
- **Know what is next.** The Upcoming panel puts overdue work first, then the
  next six things due, each with a plain-English "Tomorrow" or "In 4 days".
- **Switch to an agenda** when a list is easier to read than a grid.
- **Tick things off.** Completed tasks are hidden by default and can be shown
  again from the sidebar.
- **Filter by type**, so a revision week can show only tests.
- **Move work between devices.** Save a copy to iCloud Drive on one device and
  load it on the other. Loading *merges*: tasks are matched by id, the newer
  edit of each one wins, and deletions travel too, so neither device loses
  work and loading the same file twice does nothing.

## Your timetable

The week view is driven by `TIMETABLE_ROWS` near the top of `app.js`: one row
per period, five entries per row for Monday to Friday, `null` for a free
period. `PERIOD_TIMES` holds the start time of each period; periods 1-2, 3-4,
5-6 and 7-8 are double blocks that share a start. Edit those two to change the
timetable; `subject` on a lesson must be a key in `SUBJECTS`, or `""` for a
lesson like tutor time that carries no coursework.

A task sits on the day's first lesson in its subject, or on the lesson matching
its time when it has one, so a subject taught twice in a day does not show the
same task twice. Work due on a day with no lesson in that subject appears in an
"Also due" row beneath the grid rather than disappearing.

## Accessibility

This was built to be usable without a mouse, without colour vision, and at
whatever text size you need. Concretely:

- **The month grid is a real table** with column headers, so a screen reader
  announces "Wednesday" along with the date. Each day is one button whose label
  reads out the full date and everything due: *"Wednesday 14 October 2026.
  2 tasks: Homework, Biology worksheet; Test, Algebra, at 11:30."*
- **The grid is fully keyboard-driven** on the ARIA roving-tabindex pattern:
  one tab stop, then arrow keys by day and week, <kbd>Home</kbd> and
  <kbd>End</kbd> for the week, <kbd>Page&nbsp;Up</kbd> and
  <kbd>Page&nbsp;Down</kbd> by month (hold <kbd>Shift</kbd> for a year), and
  <kbd>Enter</kbd> to open a day. Crossing a month boundary moves the calendar
  and keeps focus on the date you navigated to.
- **Colour is never the only signal.** Colour says which subject; a glyph says
  whether it is a test (★) or homework (●). The two sit on separate channels,
  so each survives without the other, and both are spelled out in words in the
  key, the badges and the sidebar.
- **Contrast meets WCAG 2.1 AA** in both themes &ndash; verified, not assumed.
  `npm test` reads the colour tokens straight out of `styles.css` and checks
  every foreground/background pair the interface uses.
- **Focus is never lost.** Completing a task removes its row when completed
  tasks are hidden, so focus is deliberately moved to the row that replaced it
  rather than dropped to the page body. There is a test for this.
- **Changes are announced** through a polite live region: tasks added, saved,
  completed or deleted, and every change of month.
- **It reflows** to a single column and survives 200% zoom with no horizontal
  scrolling, down to a 320px viewport.
- **It respects your settings**: `prefers-color-scheme`, `prefers-reduced-motion`
  and `prefers-contrast`, with a manual light/dark override in the sidebar.
- Every target is at least 44px tall, every form field has a real label, and
  errors are reported in text next to the field they belong to.

Keyboard shortcuts: <kbd>N</kbd> adds a task, <kbd>T</kbd> jumps back to today.

## Installing it on a phone or tablet

Remembre is a Progressive Web App, so it installs to a home screen from the
browser with no app store involved. It needs to be served over HTTPS first.

On an iPhone or iPad, open the site **in Safari** (iOS only offers this from
Safari), tap Share, then *Add to Home Screen*. On Android, Chrome offers
*Install app* from its menu. Either way it gets its own icon, launches without
browser chrome, and works with no connection.

The document, stylesheet and script are fetched from the network first, with
the cache as a fallback when the network fails or is slow, so a release is
visible the next time the app is opened. Fonts and icons, which are large and
change rarely, are served from the cache and refreshed in the background, so
the app still opens with no connection at all.

When a new service worker itself downloads, it waits rather than taking over: a
bar appears offering **Reload now** or **Later**, and nothing is swapped
underneath you mid-session.

The footer shows the running version, which is the quickest way to tell whether
a device is actually on the latest release.

One caveat worth knowing: tasks live in the browser's storage on that device.
## The study organiser

Below the calendar sits a panel for the long pieces: internal assessments, the
extended essay, the TOK essay, CAS, and anything else that runs over weeks
rather than landing on one day. Each carries a kind, an optional subject and
deadline, a stage (Not started, In progress, Draft done, Submitted) and notes.

The list orders itself by deadline, soonest first, with undated work and then
submitted work at the bottom. A deadline within a fortnight is marked, and one
that has passed is marked more sharply -- unless the piece is already
submitted, in which case neither applies. The stage can be changed straight
from the list without opening anything.

Coursework is stored separately from tasks, since it is worked at in stages and
is not usefully drawn on a timetable, but it is backed up and merged exactly
like tasks, so it travels between devices with everything else.

## Reminders

A reminder becomes due at 17:00 on the day before each task, and reads
"Remember: *the task*". Turn them on from the sidebar, which asks the browser
for permission and sends a test notification straight back so you can see they
work.

There is an honest limit. The web cannot schedule a notification for a page
that is not running: the Notification Triggers proposal never shipped, and a
push has to be sent by a server, which Remembre does not have. So an in-app
reminder is delivered the first moment the app is open after it falls due -- on
launch, when the app returns to the foreground, and once a minute while it is
in front.

**Calendar alerts** get around that without a server. Export from the sidebar
and Remembre writes an iCalendar file with an alarm on every deadline, set to
17:00 the day before. Your own calendar then does the alerting, with Remembre
closed, offline, on every device signed into the same account. Entries keep a
stable id, so exporting again updates what is there rather than duplicating it.

The alarms are built from local time on each entry's own date, so a deadline
the far side of a clock change still alarms at 17:00 there: a September one
fires at 15:00 UTC and a November one at 16:00 UTC, both 17:00 in Warsaw.

Each reminder is delivered once, keyed by the task and its date, so moving a
task to a different day arms it again. Work that is already overdue or already
finished is not reminded about.

## Moving work between devices

Remembre has no server, so nothing syncs by itself. Instead it moves work as a
file, and does the merge properly:

1. On the device you have been using, open **Sync and backup** and tap **Save a
   copy**. On iOS this opens the share sheet, so you can put the file in iCloud
   Drive or AirDrop it straight across.
2. On the other device, tap **Load a copy** and pick that file.

Loading merges rather than replaces. Every task carries an `updatedAt` stamp
and is matched by id, so the newer edit of each task wins, tasks that exist on
only one device are kept, and a task deleted on one device stays deleted rather
than reappearing on the next merge. Loading the same file twice changes
nothing.

The panel tells you where you stand -- when you last saved a copy and how many
tasks have changed since -- so it is obvious when the other device is behind.

Two honest limits. If you edit the *same* task on both devices, the later edit
wins and the earlier one is lost; there is no field-by-field merge. And iOS can
clear a web app's storage after a long unused stretch, which is the other
reason to save a copy occasionally.

## Running it

It is a static site, so any web server will do:

```sh
npm run serve     # then open http://localhost:8000
```

Opening `index.html` straight from disk works too, except that browsers refuse
to load the fonts over `file://`, so the page falls back to system faces.

## A single-file build

```sh
npm run build      # writes dist/remembre.html
```

That bundles the stylesheet, the script and both typefaces into one HTML file
with no external requests, so it runs from a double click with no server. Handy
for a USB stick or an offline laptop.

## Tests

```sh
npm install       # playwright, for the browser test only
npm test
```

`tools/check-contrast.mjs` checks the palette. `tools/smoke-test.mjs` serves the
site, drives it in Chromium and asserts the behaviour above. Both exit non-zero
on failure.

## Deploying

There is nothing to build. Point any static host at the repository root; the
included `vercel.json` sets long-lived caching for the fonts and the usual
security headers.

A GitHub Pages workflow lived at `.github/workflows/deploy.yml` until it was
removed in favour of Vercel. It works, but only once Pages has been switched on
by hand under Settings, Pages, Source: GitHub Actions -- a workflow token is
not allowed to do that itself. Recover it from git history if you ever want it.

## How it is put together

| File | What lives there |
| --- | --- |
| `index.html` | The whole document: app bar, sidebars, month table, agenda and the two dialogs. |
| `styles.css` | Design tokens for both themes, then components. Fonts are declared at the top. |
| `app.js` | State, storage, rendering, keyboard handling. No dependencies. |
| `tools/` | The contrast checker and the browser smoke test. |

Dates are stored as local `YYYY-MM-DD` strings and never as `Date` objects, so
a task due on the 14th stays on the 14th in every time zone.

The palette is cherry red for the header, warm oat and cream for the page, and
one hue per subject: teal for Economics, indigo for Mathematics, plum for
English, amber for Polish, slate for History and green for ESS. Those hues
belong to the work, not to the timetable: the grid stays neutral so the
assignments on it are what catches the eye. Every pairing is checked by
`npm test` rather than eyeballed.

Type is [Fraunces](https://fonts.google.com/specimen/Fraunces) for the wordmark
and month heading, [Inter](https://fonts.google.com/specimen/Inter) for
everything else; both are subset to Latin and served from `fonts/`.
