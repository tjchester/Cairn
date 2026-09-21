# Cairn local API

Cairn can run a small HTTP server so that a browser bookmarklet, and your own scripts, can add bookmarks to the running app.

- It is **off by default**. Turn it on in *Settings → Browser & API*, or by choosing *Tools → Copy Bookmarklet for Your Browser* the first time.
- It runs **only while Cairn is open**. Quitting the app stops it.
- It listens on **`127.0.0.1` only** (default port `47821`, changeable in Settings). Nothing on your network can connect to it.
- Every request except `GET /api/v1/ping` needs a **secret key**. It is created the first time the API is switched on and lives in Cairn's database.
  The bookmarklet contains it. *Copy key (for scripts)* puts it on the clipboard; *Make a new key* invalidates every bookmarklet and script that has the old one.

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

### `GET /capture?k=<key>&url=<address>&...`

What the bookmarklet opens. It takes the same fields as the JSON body as query parameters (`tags` comma-separated, booleans as
`1`/`0`) and answers with a small HTML page. Because a navigation cannot carry a header, this is the one place the key goes in the
address; it is not used by scripts.

## Security notes

- **Loopback only, and only while the app is open.** The server binds to `127.0.0.1`, not to `0.0.0.0`.
- **DNS rebinding:** requests whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` are refused.
- **Web pages cannot use the JSON endpoint:** requests with an `Origin` header, or marked cross-site by the browser, are refused, and
  no CORS headers are sent, so a page cannot read responses either. `Content-Type: application/json` is required.
- **The key** is compared in constant time, is never shown in the app's window, and is never written to logs (which contain the
  method, path and status only, never query strings).
- **What a leaked key allows:** adding bookmarks (and having Cairn fetch the pages you name). It cannot read your data. A malicious
  page could in principle learn the key by watching what the bookmarklet does while you click it; if you suspect that, make a new key.
- **Limits:** bodies up to 64 KB, at most 30 bookmarks per minute, Cairn's own API address cannot be added as a bookmark.
- Anything running as you on your computer can read Cairn's database anyway, so this protects against web pages and other computers, not against your own account.
- The pop-up page escapes everything it shows (a page's title is untrusted) and carries a Content-Security-Policy that allows nothing but its own script and style.

## Later

Read endpoints for command-line tools (search, get, collections, tags) are planned. They will use a separate read key, so the key inside a
bookmarklet can never be used to read your bookmarks.
