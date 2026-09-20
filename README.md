# Cairn

A fast, local-first bookmark manager for Windows, macOS and Linux, built with Electron.
Your bookmarks live in a single SQLite file on your own computer: no account, no cloud, no tracking.

Cairn's feature set was inspired by the public features and documentation of bookmark managers such as
Raindrop.io. It shares no code or assets with them and is not affiliated with any of them.

## Features

- **Collections** – nested, colorable, drag-and-drop to reorganize; deleting one sends its bookmarks to the Trash.
- **Tags** – autocomplete, rename/merge/delete, drag bookmarks onto a tag to apply it.
- **Three layouts** – list, grid and headlines; sort by date added/updated, title or website.
- **Powerful search** – instant, substring matching across title, URL, note, description and tags, with operators:

  | Query | Meaning |
  | --- | --- |
  | `rust async` | both words anywhere |
  | `"exact phrase"` | phrase match |
  | `-word` | exclude |
  | `#tag` or `#"two words"` | has tag |
  | `site:github.com` | website (and its subdomains) |
  | `is:favorite` `is:broken` `is:unsorted` | state filters |
  | `has:note` `has:cover` | has a note / preview image |

- **Fast capture** – paste a URL anywhere in the window, drag a link in from your browser, or use *New Bookmark*.
  Title, description, cover image and site icon are fetched automatically. Pasting several links adds them all.
- **Import / export** – browser bookmark files (Chrome, Edge, Firefox, Safari… "Netscape HTML"), CSV, and a
  lossless JSON backup. Nested folders become nested collections; duplicates are skipped.
- **Duplicate finder** – ignores `http`/`https`, `www`, trailing slashes, `#fragments` and tracking parameters (`utm_*`, `fbclid`, …).
- **Broken-link checker and "fetch missing details"** – background jobs with progress and cancel that are polite and
  resilient (see *Bulk requests* below).
- **Trash with undo**, multi-select and bulk actions, favorites, notes, keyboard shortcuts (press `Ctrl/⌘ + /`).
- **Light / dark theme**, remembers window size and layout.

## Getting started

Requires Node.js 22.13+ (developed on 24); the app itself runs on the Node bundled with Electron.

```bash
npm install
npm run dev          # start with hot reload
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Run the app with hot reload |
| `npm run build` | Production build into `out/` |
| `npm start` | Preview the production build |
| `npm test` | Unit tests (database, search, import/export, network code, licensing) |
| `npm run test:e2e` | Builds, then drives the real Electron app with Playwright and saves screenshots to `tests/e2e/screenshots/` |
| `npm run typecheck` | TypeScript checks for main + renderer |
| `npm run dist` / `dist:win` / `dist:mac` / `dist:linux` | Package installers into `dist/` (build each OS on that OS) |
| `npm run icons` | Re-render `build/icon.png` from `resources/app-icon.svg` |

Installers are unsigned. To distribute them, add code-signing certificates (see the
[electron-builder docs](https://www.electron.build/code-signing)); macOS builds also need notarization.

### Where is my data?

`cairn.db` (SQLite) plus `window-state.json` in the app's user-data folder:
`%APPDATA%\Cairn` on Windows, `~/Library/Application Support/Cairn` on macOS, `~/.config/Cairn` on Linux.
Set `CAIRN_USER_DATA=/some/folder` to use a different location (handy for a portable install or for testing).
Use *File → Export* for backups.

## How it works

```
src/
  main/                Electron main process
    db/                SQLite schema + migrations, repository, search-query parser
    services/          page metadata, link checker, background jobs, import/export formats
    ipc.ts             every IPC handler; all input is validated with zod
    window.ts menu.ts  window (state, navigation guards), native menu
  preload/             the only bridge: a small typed `window.cairn` API
  renderer/            React + zustand UI (no Node access)
  shared/              types + URL helpers used by both sides
resources/app-icon.svg original app icon (rendered to build/icon.png by `npm run icons`)
tests/                 unit tests + Playwright end-to-end test
```

- **Storage** uses Node's built-in `node:sqlite`, so there is no native module to rebuild for each platform.
- **Security**: sandboxed renderer with context isolation and no Node integration; a strict Content-Security-Policy
  (`connect-src 'none'`: the UI cannot make network requests, all fetching happens in the main process); IPC senders and payloads
  are validated; navigation and `window.open` are blocked (links open in your browser); only `http(s)` URLs are stored or opened;
  CSV export neutralizes spreadsheet formulas.
- **Privacy**: Cairn contacts a website only when you save/refresh a bookmark there, run *Check links*, or run *Fetch missing
  details*. Cover images and site icons are loaded directly from the source sites when you view a list.
  During those bulk jobs, if several requests in a row fail, Cairn checks whether *your* internet is down. It asks a few
  places at once and the first answer wins: the last couple of sites that answered, `https://www.gstatic.com/generate_204`
  (a tiny connectivity-check endpoint), and `https://1.1.1.1/` (contacted by IP address, so it works even when DNS is
  struggling). Change `PROBE_TARGETS` in `src/main/services/metadata.ts` if you prefer others.
- **Diagnostics**: bulk jobs write `connection.log` in the data folder (open it with *Help → Show Connection Log*): rate
  limits, and, whenever the app decides you are offline, what it saw. Site names and error kinds only, never page content;
  it trims itself at 256 KB.

### Bulk requests (link check, fetch details)

Visiting thousands of sites is where things go wrong, so the jobs are built to cope:

- **Spread out, not in bursts** – bookmarks are shuffled so each site's links are spread over the whole run (an import keeps a
  folder's links together, which would otherwise hit one site over and over). Each site also gets at most 1–2 requests at a
  time, with a short jittered gap between them. Sites with 100+ bookmarks to process (say, a thousand GitHub links) start
  with a larger gap (1.5 s for link checks, 3 s for fetching details) so they are not rate limited straight away.
- **Respects "slow down"** – on `429`/`503` the site is left alone for its `Retry-After` (or 15 s, 30 s, 60 s… up to 5 min),
  its request gap widens, and other sites carry on. The dialog shows that it is waiting.
- **Retries** – timeouts, resets and `5xx` are retried up to 3 times with jittered exponential backoff. Bookmarks that still
  fail are reported as *inconclusive* (their previous status is kept) and are picked up by the next run.
- **Won't blame a link for your outage** – a run of network failures triggers a connectivity check. A single failed check
  is not believed: it looks again a couple of seconds later. If you really are offline the job pauses ("waiting for the
  connection"), probes with backoff, and resumes by itself; that time does not use up retries.
- **"Broken" means broken** – only a 404/410-style answer, or a host that doesn't exist / refuses connections on every
  attempt *while the internet is confirmed to be working*. Timeouts, TLS problems and rate limits never mark a link broken.

## Roadmap ideas

Local caching of covers/icons for offline use · browser extension · full-text "permanent copy" of pages · reminders ·
optional sync between devices · auto-update.

## Licensing

Cairn is released under the **MIT License** (see [LICENSE](LICENSE)).

It bundles third-party packages that keep their own licenses, all permissive: React, zustand, zod, node-html-parser,
Electron/Chromium, and the [Tabler Icons](https://tabler.io/icons) used for the interface (MIT, © Paweł Kuna).
`npm run legal` regenerates [`THIRD_PARTY_LICENSES.txt`](THIRD_PARTY_LICENSES.txt) with their copyright notices;
it is included in packaged builds and shown by *Help → Licenses*.
The app icon (`resources/app-icon.svg`) is original artwork, also MIT.
