import type { Bookmark } from '@shared/types'
import type { Repo } from '../db/repo'
import { classifyHttpStatus, fetchMetadata, isRateLimitStatus, isTransientStatus, type MetadataResult } from './metadata'
import { describeNetworkError } from './net'

/** Explains an error status in terms the user can act on. */
const REFUSED = new Set([401, 403, 405, 406, 451, 999])

function describeStatus(status: number): string {
  if (isRateLimitStatus(status)) return 'The site is limiting requests right now (HTTP ' + status + '). Try again in a little while.'
  if (REFUSED.has(status)) return 'The site would not let the app read this page (HTTP ' + status + '), though the link itself is fine: opening it in your browser still works.'
  if (status === 404 || status === 410) return 'The page no longer exists (HTTP ' + status + '), so there is nothing to fetch.'
  if (status >= 500) return 'The site reported a server error (HTTP ' + status + '). This is often temporary, so try again in a little while.'
  return 'The page answered with HTTP ' + status + ', so there is nothing to fetch.'
}

/**
 * Re-fetches one bookmark's title, description, cover image and icon (the "Refresh" button).
 * A page that answers with an error is reported as an error and leaves the bookmark untouched, rather than
 * pretending to succeed and saving guesses such as a default /favicon.ico.
 *
 * The site's answer also settles whether the link works, so it is recorded exactly as a link check would:
 * a page that loads is working, 404/410 is broken, and a site that only refuses to be read by a program
 * (401, 403, 405, 406, 451, 999) counts as working. A temporary fault (429, 5xx) or no answer at all
 * decides nothing, so the status stays as it was.
 */
export async function refreshBookmarkMetadata(
  repo: Repo,
  id: number,
  fetcher: (url: string) => Promise<MetadataResult> = (url) => fetchMetadata(url)
): Promise<Bookmark> {
  const bookmark = repo.getBookmark(id)
  if (!bookmark) throw new Error('Bookmark not found')
  let meta: MetadataResult
  try {
    meta = await fetcher(bookmark.url)
  } catch (error) {
    throw new Error('Could not reach the site (' + describeNetworkError(error) + '). Check your connection or try again later.')
  }
  if (meta.status !== null && !isTransientStatus(meta.status)) repo.setLinkStatus(id, classifyHttpStatus(meta.status), meta.status)
  if (meta.status !== null && meta.status >= 400) throw new Error(describeStatus(meta.status))
  return repo.applyMetadata(id, meta)
}
