#!/usr/bin/env node
/**
 * Prepare and build the exact Godot editor library and native child-window
 * executable that Solar hosts for later editor sessions and visible game runs.
 * This is deliberately separate from postinstall: the in-process backend is
 * enabled only when a verified editor DLL and matching manifest exist.
 *
 * Usage (Windows x64, with MSVC or repo-local LLVM-MinGW, Python and SCons):
 *   node scripts/build-libgodot.mjs
 *   node scripts/build-libgodot.mjs --source=C:\\path\\to\\godot
 *   node scripts/build-libgodot.mjs --native-only (executable-specific changes)
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { patchLibGodot } from './patch-libgodot.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = '4.7.1-stable'
const commit = 'a13da4feb8d8aefc283c3763d33a2f170a18d541'
const sourceArgument = process.argv.find((arg) => arg.startsWith('--source='))
const source = sourceArgument ? resolve(sourceArgument.slice('--source='.length)) : join(root, 'vendor', 'godot-source')
// Existing electron-builder resources already include vendor/godot/win32.
const output = join(root, 'vendor', 'godot', 'win32')
const nativeOnly = process.argv.includes('--native-only')
const bundledPython = join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes',
  'codex-primary-runtime', 'dependencies', 'python', 'python.exe')
const python = process.env.SOLAR_PYTHON || (existsSync(bundledPython) ? bundledPython : 'python')
const localPythonPackages = join(root, 'vendor', 'python-build')
if (existsSync(localPythonPackages)) {
  process.env.PYTHONPATH = `${localPythonPackages}${delimiter}${process.env.PYTHONPATH || ''}`
}

function run(file, args, cwd = root) {
  execFileSync(file, args, { cwd, stdio: 'inherit' })
}

function outputOf(file, args, cwd = root) {
  return execFileSync(file, args, { cwd, encoding: 'utf8' }).trim()
}

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error('This build entrypoint currently targets Windows x64 only.')
}

// Fail before downloading Godot if this machine cannot compile it.
try {
  outputOf(python, ['-c', 'import SCons; print(SCons.__version__)'])
} catch {
  throw new Error('Python with SCons 4.4+ is required. Set SOLAR_PYTHON to that Python executable.')
}

const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
const vswhere = join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
const hasMsvc = existsSync(vswhere) && Boolean(outputOf(vswhere, [
  '-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'
]))
const llvmBin = join(root, 'vendor', 'toolchains', 'llvm-mingw-20260922-ucrt-x86_64', 'bin')
const usePortableLlvm = !hasMsvc && existsSync(join(llvmBin, 'clang.exe'))
if (!hasMsvc && !usePortableLlvm) {
  throw new Error('Install MSVC C++ Build Tools or unpack llvm-mingw-20260922-ucrt-x86_64 under vendor/toolchains.')
}
if (usePortableLlvm) process.env.PATH = `${llvmBin}${delimiter}${process.env.PATH || ''}`

if (!existsSync(source)) {
  mkdirSync(dirname(source), { recursive: true })
  run('git', ['clone', '--filter=blob:none', '--depth=1', '--branch', version,
    'https://github.com/godotengine/godot.git', source])
}
const actualCommit = outputOf('git', ['rev-parse', 'HEAD'], source)
if (actualCommit !== commit) {
  throw new Error(`Godot source revision mismatch: expected ${commit}, found ${actualCommit}.`)
}
patchLibGodot(source)

const compilerFlags = [
  ...(usePortableLlvm ? ['use_mingw=yes', 'use_llvm=yes'] : []),
  'angle=no', 'd3d12=no', 'winrt=no'
]
if (!nativeOnly) run(python, ['-m', 'SCons', 'platform=windows', 'target=editor',
  'library_type=shared_library', 'arch=x86_64', 'num_jobs=4', ...compilerFlags], source)

const bin = join(source, 'bin')
const library = readdirSync(bin).find((name) => /^(?:lib)?godot\.windows\.editor\.x86_64.*\.dll$/i.test(name))
if (!library) throw new Error(`SCons completed without an editor LibGodot DLL in ${bin}.`)
run(python, ['-m', 'SCons', 'platform=windows', 'target=editor',
  'library_type=executable', 'arch=x86_64', 'num_jobs=4', ...compilerFlags], source)
const executable = readdirSync(bin).find((name) =>
  /^godot\.windows\.editor\.x86_64.*\.exe$/i.test(name) && !/\.console\.exe$/i.test(name))
if (!executable) throw new Error(`SCons completed without a Windows editor executable in ${bin}.`)
mkdirSync(output, { recursive: true })
if (!nativeOnly) {
copyFileSync(join(bin, library), join(output, 'libgodot.dll'))
const sha256 = createHash('sha256').update(readFileSync(join(output, 'libgodot.dll'))).digest('hex')
writeFileSync(join(output, 'libgodot-manifest.json'), JSON.stringify({
  version, commit, target: 'editor', architecture: 'x86_64', library, bridgeAbi: 2,
  compiler: usePortableLlvm ? 'llvm-mingw-20260922-ucrt' : 'msvc', sha256
}, null, 2) + '\n')
}
copyFileSync(join(bin, executable), join(output, 'solar-godot.exe'))
const executableSha256 = createHash('sha256').update(readFileSync(join(output, 'solar-godot.exe'))).digest('hex')
writeFileSync(join(output, 'solar-godot-manifest.json'), JSON.stringify({
  version, commit, target: 'editor-executable', architecture: 'x86_64', executable,
  compiler: usePortableLlvm ? 'llvm-mingw-20260922-ucrt' : 'msvc', sha256: executableSha256
}, null, 2) + '\n')
console.log(`Staged ${nativeOnly ? 'native executable' : library + ' and ' + executable} in ${output}`)
