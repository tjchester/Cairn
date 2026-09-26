# Cairn local API

Cairn can run a small HTTP server so that a browser bookmarklet, and your own scripts, can add bookmarks to the running app.

- It is **off by default**. Turn it on in *Settings → Browser & API*, or by choosing *Tools → Copy Bookmarklet for Your Browser* the first time.
- It runs **only while Cairn is open**. Quitting the app stops it.
- It listens on **`127.0.0.1` only** (default port `47821`, changeable in Settings). Nothing on your network can connect to it.
- There are **two keys**, both made the first time the API is switched on and kept in Cairn's database:
  - a **write key**, which may add bookmarks. This is the one inside the bookmarklet; *Copy key (for scripts)* in Settings puts it on the clipboard.
  - a **read key**, which may read the library and nothing else. Neither key does the other's job, so a web page that gets hold of the
    bookmarklet's key still cannot read a single bookmark.
  *Make a new key* in Settings replaces both, and every bookmarklet and script with an old one stops working.
- While the API is running, Cairn writes **`api.json`** into its data folder (`%APPDATA%\Cairn` on Windows) with the address and the read key,
  so a tool on this computer can find it without being set up. The file goes when the API stops.

## The bookmarklet

*Tools → Copy Bookmarklet for Your Browser* (or the button in Settings) copies a `javascript:` snippet. In your browser, add a new bookmark
and paste the snippet as its address (URL). Clicking that bookmark on any page opens a small pop-up that saves the page to Cairn, shows
"Saved to Cairn" and closes itself.

What is sent: the page's address, its title, and any text you had selected (which becomes the note). Cairn then looks the page up
itself for its description, cover image and icon, and suggests tags according to your *Auto-tagging* setting.

Notes:

- The bookmarklet opens a pop-up (a plain navigation) instead of calling `fetch()`, so it works on sites with a strict
  Content-Security-Policy, from `https` pages, and in browsers that restrict requests to local addresses.
  If your browser blocks the pop-up, it tells you; allow pop-ups for that site.
- If Cairn is not running, the pop-up shows the browser's "can't connect" page. Start Cairn and click again.
- If you change the port or make a new key, copy the bookmarklet again and replace the one in your browser.
- Tested in Microsoft Edge (Chromium) on `https` pages including one with a strict policy. Firefox and Safari should behave the same
  (they treat `127.0.0.1` as a trustworthy address and allow pop-ups opened by a click) but have not been tried.

## Endpoints

Version 1. All bodies are UTF-8 JSON. Errors look like `{"error": {"code": "...", "message": "..."}}`.

### `GET /api/v1/ping`

No key needed. Returns `{"app": "Cairn", "version": "0.1.0", "apiVersion": 1}`. Use it to check that Cairn is running.

### `POST /api/v1/bookmarks`

Adds a bookmark. Headers: `Authorization: Bearer <key>` and `Content-Type: application/json`. Only `url` is required; everything else
is what the *New bookmark* dialog offers, plus what to do afterwards.

| Field | Type | Meaning |
| --- | --- | --- |
| `url` | string | **Required.** `http`/`https` only; a bare `example.com` becomes `https://example.com`. |
| `title` | string | Kept as given. Without it, the page's own title is used once it has been fetched. |
| `note` | string | Your private note. |
| `description` | string | Fills the description; without it, the page's own is used. |
| `collection` | string | A collection by name or path, e.g. `Work/Reading` (case-insensitive). It must already exist. |
| `collectionId` | integer | A collection by id (use this if a name contains `/`). Not together with `collection`. |
| `tags` | string[] | Tags to add. |
| `favorite` | boolean | Default `false`. |
| `coverUrl`, `faviconUrl` | string | Image addresses; the fetched ones replace them unless fetching is off. |
| `fetch` | boolean | Look the page up for its title, description, cover and icon. Default `true`. |
| `autoTag` | `"off"` \| `"suggest"` \| `"auto"` | Tagging for this bookmark. Default: the mode in Settings. `suggest` queues tags for review, `auto` applies them. |
| `useLlm` | boolean | Use the local model for tag suggestions if it is set up. Default `true`. |
| `onDuplicate` | `"skip"` \| `"merge"` | If the page is already saved: leave it (default), or add the given `tags` and fill in an empty `note`. |
| `wait` | integer 0–30 | Seconds to wait for the details and tags before answering. Default `0`: answer at once. |

Unknown fields are rejected, so a typo is reported instead of ignored.

The bookmark is saved **before** the details are fetched, so the answer is quick. Fetching and tagging carry on in the background
(a few at a time); the app window updates by itself. A page that cannot be read is still saved, and *Tools → Fetch missing details*
will try it again.

Response `201` for a new bookmark, `200` if it already existed (a bookmark in the Trash is restored):

```json
{
  "status": "created",
  "enrichment": "queued",
  "bookmark": {
    "id": 42, "url": "https://github.com/org/repo", "title": "github.com", "description": "", "note": "",
    "tags": [], "autoTags": [], "favorite": false,
    "collectionId": null, "collection": null, "domain": "github.com",
    "coverUrl": null, "faviconUrl": null,
    "createdAt": "2026-09-21T09:00:00.000Z", "updatedAt": "2026-09-21T09:00:00.000Z", "inTrash": false
  }
}
```

`status` is `created`, `exists` or `restored`. `enrichment` is `queued` (still working), `none` (nothing was asked for, or it already existed),
and, with `wait`, `done` or `failed` (the page could not be read; the bookmark is saved anyway). When `wait` returns, the response also
has `suggestedTags` (`[{"tag", "score", "origin"}]`, those waiting for review in *Suggest* mode) and, if something went wrong, a `note`.

Example:

```bash
curl -s http://127.0.0.1:47821/api/v1/bookmarks \
  -H "Authorization: Bearer $CAIRN_KEY" -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/article", "tags": ["reading"], "collection": "Inbox", "wait": 15}'
```

### `GET /api/v1/bookmarks`

Searches, exactly as the app's own list does. Headers: `Authorization: Bearer <read key>`.

| Parameter | Meaning |
| --- | --- |
| `q` | the search box syntax: words, `"a phrase"`, `-word`, `#tag`, `site:example.com`, `is:favorite`, `is:broken`, `is:unsorted`, `is:archived`, `has:note`, `has:cover` |
| `scope` | `all` (default), `unsorted`, `favorites`, `broken`, `trash`, `tag:<name>`, `collection:<id>` or `collection:Dev/Rust` |
| `sort` | `created` (default), `updated`, `title`, `domain` |
| `direction` | `desc` (default) or `asc` |
| `limit`, `offset` | 1–1000 (default 50), and where to start |
| `archived` | include what is in the Archive (left out by default) |
| `direct` | with `scope=collection:…`, only what is filed in that collection, leaving out its sub-collections |

```json
{ "total": 1530, "limit": 50, "offset": 0, "bookmarks": [ { "id": 42, "url": "…", "title": "…", "collection": "Dev/Rust", "tags": ["rust"] } ] }
```

### `GET /api/v1/bookmarks/<id>`

One bookmark, in the same shape. `404` if there is none.

### `GET /api/v1/collections`

Every collection with its `path`, `parentId`, colour and how many bookmarks it holds directly. The Archive carries `"role": "archive"`.

### `GET /api/v1/tags`

Every tag with how many bookmarks use it (what is in the Archive is left out, as in the app).

### `GET /api/v1/stats`

Counts: bookmarks, unsorted, favorites, broken, archived, trash, collections, tags.

### `GET /capture?k=<key>&url=<address>&...`

What the bookmarklet opens. It takes the same fields as the JSON body as query parameters (`tags` comma-separated, booleans as
`1`/`0`) and answers with a small HTML page. Because a navigation cannot carry a header, this is the one place the key goes in the
address; it is not used by scripts.

## The command-line tool

`bin/cairn.mjs` is a small program that reads a running Cairn. It needs nothing installed: `node bin/cairn.mjs stats`, or
`npm link` once and then just `cairn`.

```
cairn search rust async --limit 5     search (the app's own syntax works: #tag site:example.com is:favorite)
cairn search --scope collection:Dev/Rust --sort title --asc
cairn search --scope collection:Dev --direct   only what is filed in Dev itself, not in what is under it
cairn get 1428                        one bookmark in full
cairn collections                     the tree, with how many bookmarks each holds
cairn tags --limit 20                 the tags you use, most used first
cairn stats                           how much of everything there is
cairn ping                            check that Cairn is running
```

Add `--json` to any of them to get the answer as JSON, for piping into `jq` or a script. It finds the app through `api.json`;
`CAIRN_URL` and `CAIRN_READ_KEY` (or `--url` and `--key`) override that. It only reads: adding a bookmark goes through the
bookmarklet or `POST /api/v1/bookmarks` with the write key.

## Security notes

- **Loopback only, and only while the app is open.** The server binds to `127.0.0.1`, not to `0.0.0.0`.
- **DNS rebinding:** requests whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` are refused.
- **Web pages cannot use the JSON endpoint:** requests with an `Origin` header, or marked cross-site by the browser, are refused, and
  no CORS headers are sent, so a page cannot read responses either. `Content-Type: application/json` is required.
- **The keys** are compared in constant time, are never shown in the app's window, and are never written to logs (which contain the
  method, path and status only, never query strings). Reading takes the read key; adding takes the write key; neither does the other's job.
- **What a leaked write key allows:** adding bookmarks (and having Cairn fetch the pages you name). It cannot read your data. A malicious
  page could in principle learn it by watching what the bookmarklet does while you click it; if you suspect that, make a new key.
- **The read key** can read everything in your library, so treat it as you would the library itself. It lives in `api.json` in your own
  profile folder, which already holds the database, and is written readable by you alone.
- **Limits:** bodies up to 64 KB, at most 30 bookmarks per minute, Cairn's own API address cannot be added as a bookmark.
- Anything running as you on your computer can read Cairn's database anyway, so this protects against web pages and other computers, not against your own account.
- The pop-up page escapes everything it shows (a page's title is untrusted) and carries a Content-Security-Policy that allows nothing but its own script and style.

## Later

Changing bookmarks from a script (update, delete, tag) and an OpenAPI description of all of it.
