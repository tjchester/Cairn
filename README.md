# Cairn

A fast, local-first bookmark manager for Windows, macOS and Linux, built with Electron.
Your bookmarks live in a single SQLite file on your own computer: no account, no cloud, no tracking.

Cairn's feature set was inspired by the public features and documentation of bookmark managers such as
Raindrop.io. It shares no code or assets with them and is not affiliated with any of them.

## Features

- **Collections** – nested, colorable, drag-and-drop to reorganize; deleting one sends its bookmarks to the Trash.
- **Tags** – autocomplete, rename/merge/delete, drag bookmarks onto a tag to apply it.
- **Auto-tagging** – built-in and offline, with an optional local model (see *Auto-tagging* below).
- **Save from your browser** – a bookmarklet and a local-only API (see *Local API* below): one click sends the page to Cairn, which fetches its details and tags it.
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
| `npm test` | Unit tests (database, search, import/export, network code, tagging, local-model client, local API, licensing) |
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
    tagging/           auto-tagging engine, rules, optional local model (Ollama)
    api/               local HTTP API and browser bookmarklet (loopback only)
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
- **Privacy**: Cairn contacts a website only when you save/refresh a bookmark there, run *Check links*, run *Fetch missing
  details*, or send it from your browser with the bookmarklet. Cover images and site icons are loaded directly from the source sites when you view a list.
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

## Auto-tagging

Cairn can suggest tags for a bookmark. It works with any library: nothing is tuned to one person's bookmarks.

**Built-in engine (always available, offline, instant).** It combines evidence and scores it:

- the website (a table of well-known domains), the kind of site from its host or path (`docs.`, `/recipe/`), file extensions,
  and the page type (`og:type`);
- keywords the author published (`article:tag`, JSON-LD, `<meta name="keywords">`); free-form ones count only if they also
  appear in the title or description;
- a topic dictionary with synonyms (`k8s` → `kubernetes`, `ML` → `machine-learning`…);
- **your own tags**: a tag you already use that appears in the title, description or page text is preferred, and suggestions
  are written in *your* spelling (if you use `JS`, you get `JS`, not `javascript`).

Suggestions below a score of 0.45, tags the bookmark already has, tags you told it never to suggest, and workflow tags are
dropped. New tags are lower-case with hyphens. English stop-words only.

**Modes** (*Settings → Auto-tagging*):

| Mode | What happens |
| --- | --- |
| Off | nothing |
| **Suggest** (default) | chips appear in the *New bookmark* and editor dialogs; bulk runs and imports queue suggestions in *Tools → Review suggested tags* |
| Auto | tags are added on their own, styled as automatic, and each run can be undone |

Tools has an *Auto-tag bookmarks* panel, a review screen grouped by tag (accept, reject, or "never suggest this"),
*Undo last run*, and *Remove all automatic tags*. Tags you typed yourself are never touched. After *Fetch missing
details*, bookmarks with no tags get suggestions from what was just learned. You can add your own domain and keyword rules
as JSON in Settings.

**Optional local model (Ollama).** Off by default. Turn on *Settings → Local model*, pick one of the models Ollama has
installed, and Cairn asks it to classify a bookmark as a second opinion; the model's tags go through the same
mapping onto your tags, blocklist and limits, and tags both sources agree on rank higher.

- **Privacy** – the address must be on your own computer (`localhost`, `127.0.0.1`, `::1`) unless you tick the explicit
  consent box (*Allow a server on another computer*). Only the title, URL and description are sent. Page text is sent only if you opt in. Your notes
  are never sent. The address may not contain credentials, and redirects are refused.
- **Untrusted pages** – page text is treated as data; the model is told never to follow instructions in it. That is not
  bulletproof, so a page that looks like it is trying to instruct the model (`ignore previous instructions…`) is not sent
  to it at all, and model suggestions always go through your review in *Suggest* mode.
- **Speed** – with `qwen2.5:7b` on a CPU-only computer, about 3 seconds per bookmark after the first (which loads the model).
  Cairn remembers which bookmarks the model has classified, so a bulk *use local model* run can be cancelled, or the app closed,
  and it continues where it stopped. With the model ticked, the main button becomes *Continue with the model (N left)* and covers every
  bookmark it has not looked at yet, tagged or not. The panel shows how many the model has looked at; tick *Ask the model about all of them again* to start over (for example with a different model). If the model stops
  answering, the run finishes with the built-in engine.
- Recommended model: **`qwen2.5:7b`** (`ollama pull qwen2.5:7b`). `gemma3:12b` gave similar quality but was about six times
  slower on the same computer; `qwen2.5:3b` is a faster choice for very large libraries.

### Data notes

Auto-tagging needed database upgrades (schema v2, then v3 for remembering what the model has done). Before each upgrade Cairn copies
your library to `cairn.db.v<old version>.bak` in the data folder; v3 also recovers, from earlier runs, which bookmarks the model
had already handled. *Fetch missing details* now means "no page signals stored yet", so after the upgrade
it re-reads pages once to learn what tagging needs; lookups that failed are retried on the next run and pages with no cover
are not re-fetched forever.

## Local API and browser bookmarklet

Off by default. Turn it on in *Settings → Browser & API* (or just choose *Tools → Copy Bookmarklet for Your Browser*, which offers to),
then paste the copied snippet as the address of a new bookmark in your browser. Clicking it on any page saves that page to Cairn: the app
fetches the details and suggests tags according to your *Auto-tagging* setting, exactly as if you had added it with *New bookmark*.

The server listens on `127.0.0.1` only (port 47821, changeable), runs only while Cairn is open, and needs a secret key that only the bookmarklet
(and *Copy key*) know. It also has a JSON endpoint, `POST /api/v1/bookmarks`, for scripts; the parameters mirror the *New bookmark* dialog and only
`url` is required. Read endpoints for command-line tools come later. See [docs/api.md](docs/api.md) for the endpoint reference and the security model.

## Roadmap ideas

Learn from your own tagging (similarity to already-tagged bookmarks) · embeddings for smarter matching · collection
suggestions · read endpoints and a command-line tool on the local API · local caching of covers/icons for offline use · browser extension · full-text "permanent copy" of pages ·
reminders · optional sync between devices · auto-update.

## Licensing

Cairn is released under the **MIT License** (see [LICENSE](LICENSE)).

It bundles third-party packages that keep their own licenses, all permissive: React, zustand, zod, node-html-parser,
Electron/Chromium, and the [Tabler Icons](https://tabler.io/icons) used for the interface (MIT, © Paweł Kuna).
`npm run legal` regenerates [`THIRD_PARTY_LICENSES.txt`](THIRD_PARTY_LICENSES.txt) with their copyright notices;
it is included in packaged builds and shown by *Help → Licenses*.
The app icon (`resources/app-icon.svg`) is original artwork, also MIT.
