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
      '_ga', '_gl', '__s', 'guccounter', 'guce_referrer', 'guce_referrer_sig'
    ].join('|') +
    ')$',
  'i'
)

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
 * A normalised key used to detect duplicate bookmarks: scheme, `www.`, fragment, trailing
 * slashes, tracking parameters and query-parameter order are ignored.
 */
export function urlKey(raw: string): string {
  try {
    const u = new URL(raw)
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    const port = u.port ? `:${u.port}` : ''
    const path = u.pathname.replace(/\/+$/, '')
    const params = [...u.searchParams.entries()]
      .filter(([key]) => !TRACKING_PARAM.test(key))
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
