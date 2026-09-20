import { openDatabase } from '../src/main/db/database'
import { Repo } from '../src/main/db/repo'
import type { BookmarkQuery } from '../src/shared/types'

export function makeRepo(): Repo {
  return new Repo(openDatabase(':memory:'))
}

export function q(overrides: Partial<BookmarkQuery> = {}): BookmarkQuery {
  return { scope: { kind: 'all' }, sort: 'created', direction: 'desc', limit: 100, offset: 0, ...overrides }
}
