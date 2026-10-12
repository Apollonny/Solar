import { createHash } from 'node:crypto'
import type { ProjectSnapshot } from './project-snapshot'

export interface ValidationDependency { directory: string; files: Record<string, string> }

/** Recognize only unchanged locked sources and Godot's own adjacent metadata. */
export function inspectLockedDependency(snapshot: ProjectSnapshot, dependency: ValidationDependency): { paths: Set<string>; summary: { directory: string; files: number; sha256: string } } {
  if (!/^addons\/[a-zA-Z0-9_-]+$/.test(dependency.directory) || !Object.keys(dependency.files).length) throw new Error('Invalid locked validation dependency.')
  const paths = new Set<string>()
  const entries = [...snapshot.files].filter(([path]) => path.startsWith(dependency.directory + '/'))
  for (const [path, hash] of Object.entries(dependency.files)) {
    if (!path.startsWith(dependency.directory + '/') || path.includes('\\') || path.split('/').some(part => !part || part === '..' || part === '.') || !/^[a-f0-9]{64}$/.test(hash) || snapshot.files.get(path)?.hash !== hash) throw new Error('Locked validation dependency changed: ' + path)
    paths.add(path)
  }
  for (const [path, file] of entries) {
    if (paths.has(path)) continue
    const generatedUID = path.endsWith('.gd.uid') && path.slice(0, -4) in dependency.files && /^uid:\/\/[a-z0-9]+\s*$/.test(file.text ?? '')
    const generatedImport = path.endsWith('.import') && path.slice(0, -7) in dependency.files && /\.(png|svg|ttf|otf)\.import$/.test(path) && /^\[remap\]/.test(file.text ?? '')
    if (!generatedUID && !generatedImport) throw new Error('Unexpected locked dependency file: ' + path)
    paths.add(path)
  }
  return { paths, summary: { directory: dependency.directory, files: entries.length, sha256: createHash('sha256').update(JSON.stringify(entries.map(([path, file]) => [path, file.hash]).sort())).digest('hex') } }
}
