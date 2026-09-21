import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** A new random secret (256 bits, URL-safe). */
export function generateKey(): string {
  return randomBytes(32).toString('base64url')
}

/** Constant-time comparison (both sides are hashed first so the length cannot leak either). */
export function keysMatch(given: string | null | undefined, expected: string): boolean {
  if (!given || !expected) return false
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/** The token from an `Authorization: Bearer <token>` header, if there is one. */
export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '')
  return match?.[1]
}
