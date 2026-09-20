// Prepares the legal files that ship inside packaged builds. Runs automatically before `npm run dist*`.
//   build/license.txt              LICENSE with a .txt extension (shown by the Windows installer)
//   THIRD_PARTY_LICENSES.txt       licenses of the npm packages that end up inside the app
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nm = (name) => resolve(root, 'node_modules', name)

mkdirSync(resolve(root, 'build'), { recursive: true })
writeFileSync(resolve(root, 'build/license.txt'), readFileSync(resolve(root, 'LICENSE'), 'utf8'))

// Packages whose code ships in the app: bundled into the renderer (React, zustand, Tabler icons), or
// required by the main process (zod, node-html-parser). Their dependencies are followed automatically.
const roots = ['react', 'react-dom', 'scheduler', 'zustand', 'zod', 'node-html-parser', '@tabler/icons-react']
const seen = new Map()

function visit(name) {
  if (seen.has(name) || !existsSync(nm(name))) return
  const pkg = JSON.parse(readFileSync(resolve(nm(name), 'package.json'), 'utf8'))
  const file = readdirSync(nm(name)).find((f) => /^licen[cs]e(\.(md|txt))?$/i.test(f))
  seen.set(name, {
    version: pkg.version,
    license: typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'see package'),
    text: file ? readFileSync(resolve(nm(name), file), 'utf8').trim() : '(no license file shipped with this package)'
  })
  Object.keys(pkg.dependencies ?? {}).forEach(visit)
}
roots.forEach(visit)

const parts = [
  'Third-party software bundled with Cairn',
  '========================================',
  '',
  'Cairn itself is MIT licensed (see LICENSE). It also ships Electron (MIT, with Chromium and its',
  "own third-party licenses in the application's LICENSES.chromium.html) and the packages below.",
  ''
]
for (const [name, info] of [...seen].sort(([a], [b]) => a.localeCompare(b))) {
  parts.push('-'.repeat(80), `${name} ${info.version} - ${info.license}`, '-'.repeat(80), info.text, '')
}
writeFileSync(resolve(root, 'THIRD_PARTY_LICENSES.txt'), parts.join('\n'))
console.log(`Wrote build/license.txt and THIRD_PARTY_LICENSES.txt (${seen.size} packages)`)
