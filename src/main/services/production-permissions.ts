import { dirname, resolve } from 'node:path'

/** OpenCode uses both directory/* and directory/** for external read asks.
 * The tool hook still enforces the exact file allowlist after this directory grant. */
export function scopedExternalRead(patterns: unknown, readPaths: string[]): boolean {
  if (!Array.isArray(patterns) || !patterns.length || patterns.some(pattern => typeof pattern !== 'string')) return false
  return patterns.every(pattern => {
    const directory = pattern.replace(/[\\/]\*{1,2}$/, '')
    if (/[?*]/.test(directory)) return false
    return readPaths.some(path => resolve(dirname(path)).toLowerCase() === resolve(directory).toLowerCase())
  })
}
