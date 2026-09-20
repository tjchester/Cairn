// Renders resources/app-icon.svg to build/icon.png (1024x1024).
// electron-builder converts that single PNG into .ico (Windows) and .icns (macOS) at package time.
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await mkdir(resolve(root, 'build'), { recursive: true })
await sharp(resolve(root, 'resources/app-icon.svg'), { density: 384 })
  .resize(1024, 1024)
  .png()
  .toFile(resolve(root, 'build/icon.png'))
console.log('Wrote build/icon.png')
