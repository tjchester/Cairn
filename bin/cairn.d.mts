// Types for the command-line tool, so the tests can drive it directly.

export interface CliIo {
  out?: (line: string) => void
  err?: (line: string) => void
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
}

/** The app's data folder on this platform, where a running Cairn leaves `api.json`. */
export function dataFolder(env?: Record<string, string | undefined>, os?: string): string

export function parseArgs(argv: string[]): {
  command: string
  words: string[]
  options: Record<string, string | boolean | undefined>
}

/** Runs one command and returns the exit code. */
export function run(argv: string[], io?: CliIo): Promise<number>
