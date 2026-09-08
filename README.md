# Remembre

A personal work calendar for schoolwork: tests, homework and every other
assignment in one month view, with a running list of what is due next.

No accounts, no build step. It is three files &ndash; `index.html`, `styles.css`,
`app.js` &ndash; and two self-hosted typefaces. Tasks are saved in the browser's
own storage, so nothing about your coursework leaves your device unless you ask
it to: there is an optional server in `api/` that keeps two devices in step and
feeds your calendar app, and the rest works with no server at all.

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

Below the calendar, in a box of its own, sits a panel for the long pieces: internal assessments, the
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

## Study sessions

**Plan study sessions** in the organiser gives every unfinished piece of
coursework a run of dated sittings between tomorrow and its final deadline, and
puts them on the quietest days it can find.

The window is cut into as many slots as there are sittings, and the best day in
each slot is taken. Slots give the systematic spread -- one sitting each, so
they cannot bunch at one end -- and the scoring picks which day inside a slot:

| What is already on a day | Cost |
| --- | --- |
| A test due | 5 |
| The evening before a test, when it gets revised for | 4 |
| Homework due | 2 |
| A coursework deadline, or its eve | 3 |
| A sitting already planned | 12 |
| A sitting the day before or after | 4 |
| It is a weekend | -3 |

Doubling up costs more than sitting next to two other sittings, so the planner
never chooses to double when it can spread. When every day is busy it takes the
least bad one rather than skipping the work.

Sittings show in the month view as outlined chips, so a day reads at a glance
as "two things due, one thing to work on". Replanning replaces the planner's
own future guesses but never touches a sitting you already did or moved
yourself.

Two notices come with each: one an hour before, and "Time to study" as it
starts. Both are in the calendar export too, so they fire with the app closed.

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

**Calendar alerts** get around that without a server.

A calendar file is a snapshot: once imported, nothing updates it. So the panel
keeps a fingerprint of everything the feed would contain and tells you how far
behind your calendar has fallen -- "3 changes behind" -- which turns
remembering to re-export into one tap from a line that says it is needed. Only
things a calendar actually shows are counted, so editing a note changes
nothing, and renaming one entry counts once rather than twice.

Truly hands-off would mean a subscribed calendar URL, which needs a server to
serve it. Export from the sidebar
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

There are two ways, and the first one is automatic.

### Automatic syncing

Under **Automatic sync**, pick a phrase of at least twelve characters and enter
the same phrase on every device. From then on Remembre pushes changes a few
seconds after you make them, pulls again whenever you come back to the app, and
merges both directions the same way the file does.

It also gives you a **calendar address**. Subscribe to it once in your calendar
app -- on iOS, Calendar, Add Account, Other, Add Subscribed Calendar -- and
every deadline you add from then on turns up there on its own, with the same
17:00 alarm the day before. No more exporting a file when the panel says your
calendar has fallen behind.

The phrase never leaves the device in readable form. The server stores a
one-way hash of it, and the calendar address is a second, separate hash, so
handing that URL to a calendar app exposes the calendar and nothing else.

This needs a server with somewhere to store things; see
[Setting up the server](#setting-up-the-server). Without one, the panel says so
and the file route below still works.

### As a file

The way that needs nothing but the app, and the fallback when syncing is off:

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

Two honest limits, and they apply to automatic syncing too. If you edit the *same* task on both devices, the later edit
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

`tools/check-contrast.mjs` checks the palette. `tools/api-test.mjs` drives the
sync routes directly against a temporary directory. `tools/push-test.mjs`
encrypts a notification and then decrypts it the way RFC 8291 says a browser
does, so a mistake in the key derivation fails a test rather than failing
silently on a phone. `tools/notify-test.mjs` runs the nightly job against a fake
push service that really decrypts what it is sent. `tools/smoke-test.mjs`
serves the site and asserts the behaviour above in Chromium.
`tools/sync-test.mjs` runs the site and the real sync routes together and drives
two browser contexts, checking that work added on one turns up on the other and
that the calendar address carries it. `tools/update-test.mjs` covers the update
bar. All exit non-zero on failure.

Set `CHROMIUM_PATH` if Playwright's bundled browser is not installed.

## Setting up the server

The app is a static site and works entirely without one. The three routes in
`api/` exist only for the two things a device cannot do alone: let two devices
meet in the middle, and give a calendar app an address it can poll by itself.

| Route | What it does |
| --- | --- |
| `GET /api/status` | Which store is attached, and what it is waiting for if none is. Never reports a value. |
| `GET /api/sync?code=` | What the server holds for that phrase. |
| `POST /api/sync` | Merges a device's copy into it and returns the result. |
| `GET /calendar/<token>.ics` | The subscription a calendar app polls. |
| `POST /api/subscribe` | Remembers a device so it can be sent a notification later. `DELETE` forgets it. |
| `GET /api/notify` | The nightly run. Sends each device what is due tomorrow, once. |

They have no dependencies and run on Vercel's Node runtime as they are. What
they need is somewhere to keep bytes, which is one of these environment
variables -- the first one that is set is the one that gets used:

| Set these | Store |
| --- | --- |
| A `*_REST_API_URL` and `*_REST_API_TOKEN` pair | Upstash Redis. Adding the Redis integration from the Vercel marketplace sets both for you. The prefix is chosen when the store is connected, so they may arrive as `KV_`, `UPSTASH_REDIS_`, `STORAGE_` or anything else; the app looks for the shape of the pair rather than a fixed name, and `/api/status` reports which two it settled on. |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob. Creating a Blob store sets it for you. |
| `REMEMBRE_GITHUB_TOKEN`, `REMEMBRE_GITHUB_REPO` | A GitHub repository, under `remembre-data/`. Needs no storage product at all: a fine-grained token with read and write on Contents for one repository, and `owner/name` in the second variable. Add `REMEMBRE_GITHUB_BRANCH` if it is not `main`. |
| `REMEMBRE_DATA_DIR` | A directory on disk. For running locally; a serverless filesystem does not survive a request, so this is last on the list. |

Open `/api/status` after deploying: it says which one it found, or lists what
each of them still needs. If a store is attached and it still found nothing,
the `seen` list names every storage-shaped variable the deployment can actually
see -- names only, never values -- which is usually enough to spot that the
integration called something by a name the app was not looking for. Until one is set, every sync answers 503 with that
same explanation rather than pretending to have saved anything.

Nothing here is a paid tier at the time of writing, and the GitHub option needs
no storage product to be provisioned at all.

### Notifications while the app is closed

The in-app reminders need the app to be running. To be told about tomorrow with
Remembre shut, the server sends the notification instead, which needs two more
things.

**A key pair.** `npm run vapid` prints one. Set `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` (a `mailto:` address the push services
can complain to). The pair is what proves to Apple and Google that a
notification really came from this deployment; changing it invalidates every
device that has already subscribed, so once set, leave it.

**A schedule.** `vercel.json` asks for `/api/notify` once a day at 16:00 UTC.
Hobby accounts may only schedule daily jobs -- anything finer fails the
deployment -- so the run does not assume it happens at 17:00. Each device stores
its own time zone, and the rule is *it is past 17:00 where this device is, and
it has not been told about tomorrow yet*. Running it twice sends nothing twice,
and `GET /api/notify?dry=1` shows what it would send without sending it. On a
plan that allows `0 * * * *`, changing that one line makes the reminder land at
17:00 exactly rather than within the evening.

Optionally set `CRON_SECRET`; when it is set, a caller without it gets a dry run
instead of a send.

Two devices, two subscriptions, two reminders -- so turn reminders on where you
want them and leave them off where you do not. What a server still cannot do on
a daily schedule is the *hour before* nudge for a study session; those alarms
ride on the calendar subscription, which fires them at the minute regardless.

## Deploying

There is nothing to build. Point any static host at the repository root; the
included `vercel.json` sets long-lived caching for the fonts, the usual
security headers, and the `/calendar/<token>.ics` rewrite. A host with no
serverless functions serves the app perfectly well; only the sync panel goes
quiet.

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
| `api/` | The sync, calendar and notification routes, the storage drivers, and Web Push written out by hand. No dependencies. |
| `tools/` | The contrast checker and the four test suites. |

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
