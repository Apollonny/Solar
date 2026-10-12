#!/usr/bin/env node
// Maintainer-only import. Nothing from the upstream repository is executed.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY = 'https://github.com/bgrenat/godot-game-dev-studio'
const COMMIT = '9e2b2beaf0bc7ba2e27a40326d058ff2c7a619a9'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destination = join(root, 'resources', 'game-guidance')
const textExtensions = new Set(['.md', '.gd', '.gdshader', '.tscn', '.tres', '.cfg', '.json', '.txt', '.py', '.ps1', '.sh', '.yml', '.generic'])
const rootFiles = new Set(['LICENSE', 'NOTICE.md', 'README.md', 'COMPATIBILITY.md', 'SKILL_CATALOG.md', 'skills_index.json', 'assets/studio-orchestrators-source.md'])
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function safeRelative(path) {
  if (!path || isAbsolute(path) || path.includes('\\') || path.includes(':') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe library path: ${path}`)
  }
  return path
}

// The frontmatter uses scalar strings, including folded blocks. Preserve the
// actual skill directory as its id; frontmatter names need not be unique.
function scalar(frontmatter, key) {
  const lines = frontmatter.split(/\r?\n/)
  const index = lines.findIndex((line) => line.startsWith(`${key}:`))
  if (index < 0) return ''
  let value = lines[index].slice(key.length + 1).trim()
  if (/^[>|][-+]?$/.test(value)) {
    const parts = []
    for (let i = index + 1; i < lines.length && /^\s/.test(lines[i]); i++) parts.push(lines[i].trim())
    value = parts.join(' ')
  }
  if (value.startsWith('"')) {
    try { return JSON.parse(value) } catch { return value.slice(1, -1) }
  }
  return value.replace(/^'|'$/g, '').replace(/''/g, "'")
}

function guideMetadata(id, path, text, source, indexedKeywords = []) {
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? ''
  const heading = text.replace(/^---\r?\n[\s\S]*?\r?\n---/, '').match(/^#\s+(.+)$/m)?.[1]?.trim()
  const description = scalar(frontmatter, 'description').replace(/\s+/g, ' ').slice(0, 800)
  if (!description) throw new Error(`Missing description: ${path}`)
  const family = id.startsWith('godot-prompter-') ? 'godot-prompter' : id.split('-')[0]
  return {
    id, title: heading || scalar(frontmatter, 'name') || id, description, path, source, family,
    tags: [...new Set([...id.split('-'), ...indexedKeywords].map((tag) => String(tag).toLowerCase()))].slice(0, 64)
  }
}

async function localFiles(directory, prefix = '') {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = safeRelative(prefix + entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Symlink in Solar guidance: ${path}`)
    if (entry.isDirectory()) files.push(...await localFiles(join(directory, entry.name), `${path}/`))
    else if (entry.isFile()) files.push({ path, bytes: await readFile(join(directory, entry.name)) })
  }
  return files
}

let checkout = null
const sourceIndex = process.argv.indexOf('--source')
let source = sourceIndex >= 0 ? resolve(process.argv[sourceIndex + 1] || '') : null
if (sourceIndex >= 0 && !process.argv[sourceIndex + 1]) throw new Error('--source requires a local Git repository')
const git = (...args) => execFileSync('git', ['-C', source, ...args], { windowsHide: true, maxBuffer: 24 * 1024 * 1024 })

try {
  if (!source) {
    checkout = await mkdtemp(join(tmpdir(), 'solar-guidance-import-'))
    source = checkout
    git('init', '--quiet')
    git('fetch', '--depth', '1', `${REPOSITORY}.git`, COMMIT)
  }
  if (git('rev-parse', `${COMMIT}^{commit}`).toString().trim() !== COMMIT) throw new Error('Pinned upstream commit is unavailable')
  const tree = git('ls-tree', '-r', '--long', COMMIT).toString('utf8').trim().split('\n').map((line) => {
    const match = line.match(/^(\d+) blob ([a-f0-9]{40})\s+(\d+)\t(.+)$/)
    if (!match) return null
    return { mode: match[1], oid: match[2], size: Number(match[3]), path: safeRelative(match[4]) }
  }).filter(Boolean)
  const selected = tree.filter((file) => rootFiles.has(file.path) ||
    ((file.path.startsWith('skills/') || file.path.startsWith('assets/godot-worldmap-builder/')) && textExtensions.has(extname(file.path))))
  if (selected.some((file) => file.mode !== '100644' && file.mode !== '100755')) throw new Error('Non-regular upstream file selected')
  if (new Set(selected.map((file) => file.path.toLowerCase())).size !== selected.length) throw new Error('Case-colliding upstream paths cannot be bundled on Windows')
  if (selected.some((file) => file.size > 1024 * 1024) || selected.reduce((sum, file) => sum + file.size, 0) > 16 * 1024 * 1024) throw new Error('Upstream import exceeds its size limit')

  // One batch for all blobs: no checkout, installation hooks or helper scripts.
  const batch = execFileSync('git', ['-C', source, 'cat-file', '--batch'], {
    input: selected.map((file) => file.oid).join('\n') + '\n', windowsHide: true, maxBuffer: 24 * 1024 * 1024
  })
  let cursor = 0
  const contents = new Map()
  for (const file of selected) {
    const newline = batch.indexOf(10, cursor)
    const header = batch.subarray(cursor, newline).toString()
    if (header !== `${file.oid} blob ${file.size}`) throw new Error(`Unexpected Git blob: ${file.path}`)
    cursor = newline + 1
    const bytes = batch.subarray(cursor, cursor + file.size)
    if (bytes.includes(0)) throw new Error(`Binary data in reference library: ${file.path}`)
    contents.set(file.path, bytes)
    cursor += file.size + 1
  }

  const upstreamIndex = JSON.parse(contents.get('skills_index.json').toString('utf8'))
  const keywords = new Map(upstreamIndex.map((entry) => [entry.name, Array.isArray(entry.keywords) ? entry.keywords : []]))
  const guides = []
  const files = []
  for (const [path, bytes] of contents) {
    const bundledPath = `upstream/${path}`
    files.push({ path: bundledPath, bytes: bytes.length, sha256: sha256(bytes), source: 'godot-game-dev-studio' })
    if (/^skills\/[^/]+\/SKILL\.md$/.test(path)) {
      const id = path.split('/')[1]
      guides.push(guideMetadata(id, bundledPath, bytes.toString('utf8'), 'godot-game-dev-studio', keywords.get(id)))
    }
  }
  if (guides.length !== 189) throw new Error(`Pinned library expected 189 skills, found ${guides.length}`)
  for (const file of await localFiles(join(destination, 'solar'))) {
    const path = `solar/${file.path}`
    files.push({ path, bytes: file.bytes.length, sha256: sha256(file.bytes), source: 'solar' })
    if (file.path.endsWith('.md')) guides.push(guideMetadata(`solar-${file.path.slice(0, -3)}`, path, file.bytes.toString('utf8'), 'solar'))
  }
  guides.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const catalog = {
    schemaVersion: 1,
    source: { repository: REPOSITORY, commit: COMMIT, license: 'LGPL-3.0', engineBaseline: 'Godot 4.7+ reference patterns; verify APIs against the project engine', upstreamSkillCount: 189 },
    guides, files
  }
  if (new Set(guides.map((guide) => guide.id)).size !== guides.length) throw new Error('Duplicate guidance ids')
  const staging = await mkdtemp(join(destination, '.import-'))
  try {
    for (const [path, bytes] of contents) {
      const target = join(staging, ...path.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
    }
    const target = resolve(destination, 'upstream')
    if (dirname(target) !== resolve(destination) || relative(root, target).startsWith('..')) throw new Error('Unsafe upstream replacement path')
    try {
      if ((await lstat(target)).isSymbolicLink() || await realpath(target) !== target) throw new Error('Refusing to replace a linked library directory')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    // Only this generated, app-owned library is replaced by a maintainer import.
    await rm(target, { recursive: true, force: true })
    await rename(staging, target)
    await writeFile(join(destination, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n')
  } finally {
    if (dirname(resolve(staging)) !== resolve(destination) || !staging.includes('.import-')) throw new Error('Unsafe staging cleanup path')
    await rm(staging, { recursive: true, force: true })
  }
  console.log(`Bundled ${guides.length} guides (${catalog.source.upstreamSkillCount} upstream) and ${files.length} text references; ${files.reduce((sum, file) => sum + file.bytes, 0)} bytes. Commit ${COMMIT}.`)
} finally {
  if (checkout) {
    if (dirname(resolve(checkout)) !== resolve(tmpdir()) || !checkout.includes('solar-guidance-import-')) throw new Error('Unsafe checkout cleanup path')
    await rm(checkout, { recursive: true, force: true })
  }
}
