import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { cp, mkdtemp, mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { copyRunProof } from './production-acceptance-proof.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// A previous isolated backend may still be closing its final lease. Wait for
// its idle reaper; never kill/adopt another profile's authenticated backend.
const waitDeadline = Date.now() + 60_000
async function free(port) {
  const server = createServer()
  return new Promise(done => {
    server.once('error', () => done(false))
    server.listen(port, '127.0.0.1', () => server.close(() => done(true)))
  })
}
while (!process.argv.includes('--preflight-only') && !process.argv.includes('--wire-only') && (!(await free(8000)) || !(await free(9500)))) {
  if (Date.now() > waitDeadline) throw new Error('Godot gateway ports are occupied. This acceptance will not interrupt another backend.')
  await new Promise(done => setTimeout(done, 500))
}
const fixture = await mkdtemp(join(tmpdir(), 'solar-workflow-check-'))
const home = join(fixture, 'home')
await mkdir(home)
await build({ entryPoints: [join(root, 'tests/production-workflow.integration.ts')], bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: join(root, '.test-dist/production-workflow.cjs') })
const child = spawn(join(root, 'node_modules/electron/dist/electron.exe'), [join(root, '.test-dist/production-workflow.cjs')], { cwd: root, windowsHide: true, stdio: 'inherit', env: {
  ...process.env, SOLAR_ACCEPTANCE_ROOT: root, SOLAR_ACCEPTANCE_DIR: fixture, SOLAR_LIBGODOT: '1',
  ...(process.argv.includes('--preflight-only')?{SOLAR_ACCEPTANCE_PREFLIGHT_ONLY:'1'}:{}),
  ...(process.argv.includes('--broken-only')?{SOLAR_ACCEPTANCE_BROKEN_ONLY:'1'}:{}),
  ...(process.argv.includes('--wire-only')?{SOLAR_ACCEPTANCE_WIRE_ONLY:'1'}:{}),
  ...(process.argv.includes('--native-skills')?{SOLAR_ACCEPTANCE_NATIVE_SKILLS_ONLY:'1'}:{}),
  ...(process.argv.includes('--assets')?{SOLAR_ACCEPTANCE_ASSETS:'1',SOLAR_ASSET_LIBRARY_ROOT:join(process.env.APPDATA,'Solar/asset-library')}:{}),
  ...(process.argv.includes('--2d-only')?{SOLAR_ACCEPTANCE_2D_ONLY:'1'}:{}),
  USERPROFILE: home, HOME: home, APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'),
  XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'), GODOT_AI_DISABLE_TELEMETRY: 'true',
  OPENCODE_CONFIG: join(home, '.config/opencode/opencode.json'), OPENCODE_CONFIG_DIR: join(home, '.config/opencode')
} })
const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', value => done(value ?? 1)) })
const proof = join(root, '.test-dist/acceptance', fixture.split(/[\\/]/).at(-1))
await mkdir(proof, { recursive: true })
await copyRunProof(join(fixture, 'profile/production/runs'), join(proof, 'runs'))
await cp(join(fixture, 'summary.json'), join(proof, 'summary.json')).catch(error => { if (error.code !== 'ENOENT') throw error })
console.log('Offline workflow diagnostics:', proof)
const target = resolve(fixture)
if (dirname(target) !== resolve(tmpdir()) || !target.split(/[\\/]/).at(-1).startsWith('solar-workflow-check-')) throw new Error('Unsafe workflow fixture cleanup.')
if (code === 0) await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
else console.log('Offline workflow fixture:', fixture)
process.exitCode = code
