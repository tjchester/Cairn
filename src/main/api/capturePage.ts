// The small page shown in the pop-up the bookmarklet opens. Everything it displays can come from a hostile web
// page (its title, its address), so all of it is HTML-escaped, and the page's own policy forbids anything but its
// one inline script and stylesheet.

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string)
}

export interface CapturePageModel {
  kind: 'saved' | 'exists' | 'error'
  heading: string
  /** A line of explanation under the heading. */
  detail: string
  /** The bookmark's title or address, shown quoted. */
  subject?: string
  /** Shown in the page's own tab rather than a pop-up: go back to the saved page instead of closing. */
  inPlace?: boolean
}

const ICONS = { saved: '✓', exists: '✓', error: '!' } as const

export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    "style-src 'nonce-" + nonce + "'",
    "script-src 'nonce-" + nonce + "'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ')
}

export function renderCapturePage(model: CapturePageModel, nonce: string): string {
  const done = model.kind !== 'error'
  const script = done
    ? 'setTimeout(function(){' + (model.inPlace ? 'history.back()' : 'window.close()') + '},2200)'
    : model.inPlace
      ? 'document.getElementById("back").onclick=function(){history.back()}'
      : ''
  const subject = model.subject ? '<p class="subject">' + escapeHtml(model.subject.slice(0, 200)) + '</p>' : ''
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="referrer" content="no-referrer">' +
    '<title>Cairn</title>' +
    '<style nonce="' + nonce + '">' +
    ':root{color-scheme:light dark;--bg:#f6f6f8;--fg:#1b1c20;--muted:#666a73;--ok:#1f8a4c;--bad:#c62828}' +
    '@media (prefers-color-scheme:dark){:root{--bg:#1b1c20;--fg:#ececf0;--muted:#a0a4ad;--ok:#4cc38a;--bad:#ff6b6b}}' +
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif;text-align:center}' +
    'main{padding:20px;max-width:380px}' +
    '.icon{width:44px;height:44px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;color:#fff;background:var(--ok)}' +
    '.error .icon{background:var(--bad)}' +
    'h1{font-size:18px;margin:10px 0 4px}' +
    '.subject{margin:0 0 6px;font-weight:600;overflow-wrap:anywhere}' +
    '.detail{margin:0;color:var(--muted)}' +
    'button{margin-top:14px;font:inherit;padding:6px 14px}' +
    '</style></head><body><main class="' + model.kind + '">' +
    '<div class="icon" aria-hidden="true">' + ICONS[model.kind] + '</div>' +
    '<h1>' + escapeHtml(model.heading) + '</h1>' +
    subject +
    '<p class="detail">' + escapeHtml(model.detail) + '</p>' +
    (!done && model.inPlace ? '<button id="back" type="button">Back to the page</button>' : '') +
    '</main>' +
    (script ? '<script nonce="' + nonce + '">' + script + '</script>' : '') +
    '</body></html>'
  )
}
