/** A problem with a request to the local API, described so the caller can act on it. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {}
  ) {
    super(message)
    this.name = 'ApiError'
  }
}
