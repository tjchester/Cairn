// URL helpers shared by the main process (storage, import, dedupe) and the renderer (display, paste detection).

const REJECTED_SCHEME = /^(javascript|data|mailto|file|about|chrome|tel|blob|vbscript):/i
const ANY_SCHEME_WITH_SLASHES = /^[a-z][a-z0-9+.-]*:\/\//i
const HTTP_SCHEME = /^https?:\/\//i
/**
 * Query parameters that say where a visitor came from rather than which page this is: two links that differ only by
 * these are the same bookmark. Kept to well-known names, because wrongly treating two pages as one would hide a
 * bookmark on import. Anything ambiguous (`id`, `src`, `source`, `from`, `page`, `t`, `v`…) is left alone.
 */
const TRACKING_PARAM = new RegExp(
  '^(' +
    [
      'utm_[a-z0-9_]+', // Google Analytics and everything that copied it
      'ref', 'ref_', 'ref_src', 'referrer', 'referer', 'referral', // "you came from here" links (blogs, newsletters)
      'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'gad_source', 'srsltid', // Google and Meta ad clicks
      'msclkid', 'yclid', 'twclid', 'ttclid', 'igshid', 'igsh', 'li_fat_id', 'rdt_cid', 'epik', 'scid', // other ad networks
      'mc_cid', 'mc_eid', 'mkt_tok', '_hsenc', '_hsmi', 'hsctatracking', 'vero_conv', 'vero_id', 'ck_subscriber_id', // mailing lists
      'oly_enc_id', 'oly_anon_id', '_openstat', 'wickedid', 'ncid', 'cmpid', 'trk', 'trkcampaign', // more campaign tags
      'pk_campaign', 'pk_kwd', 'pk_source', 'pk_medium', 'piwik_campaign', 'piwik_kwd', 'matomo_campaign', 'matomo_kwd', // Piwik / Matomo
      'at_medium', 'at_campaign', 's_cid', 'sc_channel', 'sc_campaign', 'soc_src', 'soc_trk', // BBC, Adobe, social shares
      'si', 'spm', 'scm', 'share_source', 'share_medium', // share links (YouTube, Spotify, Alibaba)
      '_ga', '_gl', '__s', 'guccounter', 'guce_referrer', 'guce_referrer_sig',
      'wt[.]mc_id', 'ftag', 'emcid', 'et_rid', 'et_cid', // Microsoft, CBS (GameSpot, CNET), Salesforce mail campaigns
      'newsletter_popup', 'doing_wp_cron' // a newsletter prompt, and WordPress running its scheduler on a visit
    ].join('|') +
    ')$',
  'i'
)

/**
 * Names that mark where a visitor came from on one site but choose the page on others (`t` is a YouTube timestamp;
 * on Twitter it is a share token), so they are ignored only on the sites listed. Keys are hosts without `www.`; a
 * key also covers its subdomains. Amazon uses many country domains, so it is matched by name below.
 */
const SITE_TRACKING_PARAMS: Record<string, readonly string[]> = {
  'twitter.com': ['s', 't'],
  'x.com': ['s', 't'],
  'forbes.com': ['sh'],
  'theregister.com': ['td'],
  'makeuseof.com': ['pubdate']
}
const AMAZON_TRACKING_PARAMS = ['tag', 'linkcode', 'linkid', 'camp', 'creative', 'creativeasin', 'ascsubtag', 'ie']
const AMAZON_HOST = /(^|\.)amazon\.[a-z.]+$/

function siteTrackingParams(host: string): readonly string[] {
  if (AMAZON_HOST.test(host)) return AMAZON_TRACKING_PARAMS
  for (const [site, params] of Object.entries(SITE_TRACKING_PARAMS)) {
    if (host === site || host.endsWith('.' + site)) return params
  }
  return []
}

/** A folder's own page, which servers also answer at the folder's address: `/docs/index.html` is `/docs/`. */
const INDEX_PAGE = /\/(index|default)\.(html?|shtml|php|aspx?|jsp)$/i

/**
 * Turns user input into a valid absolute http(s) URL.
 * Bare hostnames get `https://`. Throws for anything that is not a web URL.
 */
export function coerceUrl(raw: string): string {
  const input = raw.trim()
  if (!input) throw new Error('URL is empty')
  if (REJECTED_SCHEME.test(input)) throw new Error('Only http and https links are supported')
  if (ANY_SCHEME_WITH_SLASHES.test(input) && !HTTP_SCHEME.test(input)) {
    throw new Error('Only http and https links are supported')
  }
  const candidate = HTTP_SCHEME.test(input) ? input : `https://${input}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new Error('That does not look like a valid URL')
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    throw new Error('That does not look like a valid URL')
  }
  return url.href
}

export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Hostname without a leading `www.`, lower-cased. Empty string if the URL cannot be parsed. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * A normalised key used to detect duplicate bookmarks: scheme, `www.`, fragment, trailing and repeated slashes, a
 * folder's index page, tracking parameters and query-parameter order are ignored. On GitHub, whose account and
 * repository names ignore case, so does the start of the path; so does Amazon's `/ref=…` tracking segment.
 */
export function urlKey(raw: string): string {
  try {
    const u = new URL(raw)
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    const port = u.port ? `:${u.port}` : ''
    let path = u.pathname.replace(/\/{2,}/g, '/').replace(INDEX_PAGE, '')
    if (AMAZON_HOST.test(host)) path = path.replace(/\/ref=[^/]*$/, '')
    if (host === 'github.com') path = path.replace(/^(\/[^/]+){1,2}/, (start) => start.toLowerCase())
    path = path.replace(/\/+$/, '')
    const siteParams = siteTrackingParams(host)
    const params = [...u.searchParams.entries()]
      .filter(([key]) => !TRACKING_PARAM.test(key) && !siteParams.includes(key.toLowerCase()))
      .sort(([ak, av], [bk, bv]) => (ak === bk ? av.localeCompare(bv) : ak.localeCompare(bk)))
    const query = params.length ? `?${new URLSearchParams(params).toString()}` : ''
    return `${host}${port}${path}${query}`
  } catch {
    return raw.trim().toLowerCase()
  }
}

/** Extract every http(s) URL from a block of pasted text. */
export function extractUrls(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>"']+/gi) ?? []
  const seen = new Set<string>()
  const out: string[] = []
  for (const candidate of found) {
    const cleaned = candidate.replace(/[),.;:!?]+$/, '')
    if (isHttpUrl(cleaned) && !seen.has(cleaned)) {
      seen.add(cleaned)
      out.push(cleaned)
    }
  }
  return out
}

/** Where a site sends visitors it will not show the page to, or whose page is gone: not a new home for the page. */
const DEAD_END_PATH = /(^|\/)(log[-_]?in|sign[-_]?in|sign[-_]?up|auth|account|session|404|not[-_]?found|error|gone)(\/|\.|$)/i

/**
 * The key of the address a link redirects to, when that address is a new home for the same page and not the one the
 * bookmark already has: `golang.org/ref/spec` now lives at `go.dev/ref/spec`. Null otherwise. A page that is sent to
 * the site's front page, or to a sign-in or error page, has been removed or hidden rather than moved, and is not
 * counted: every dead page on a site would otherwise look like a copy of its home page.
 */
export function redirectKey(url: string, finalUrl: string | null | undefined): string | null {
  if (!finalUrl || !isHttpUrl(finalUrl)) return null
  const key = urlKey(finalUrl)
  if (key === urlKey(url)) return null
  const path = (raw: string): string => urlKey(raw).replace(/^[^/?]*/, '').split('?')[0] ?? ''
  const finalPath = path(finalUrl)
  if (finalPath === '' && path(url) !== '') return null
  if (DEAD_END_PATH.test(finalPath)) return null
  return key
}
