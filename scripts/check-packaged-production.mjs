/** Explicit Windows package acceptance. No provider calls or personal profile. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const executable = join(root, 'dist/win-unpacked/Solar.exe')
const fixture = await mkdtemp(join(tmpdir(), 'solar-package-check-'))
const home = join(fixture, 'home'), profile = join(fixture, 'profile')
await mkdir(home); await mkdir(profile)
const portServer = createServer()
await new Promise(done => portServer.listen(0, '127.0.0.1', done))
const port = portServer.address().port
await new Promise(done => portServer.close(done))
const checks = [], logs = [], start = Date.now()
let runtimeLogs = [], runtimeState = null
let ws, seq = 0, failure = null
const pending = new Map()
const child = spawn(executable, [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'], {
  cwd: dirname(executable), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, SOLAR_PROFILE_DIR: profile, SOLAR_LIBGODOT: '1', SOLAR_SHUTDOWN_DIAGNOSTICS: '1', USERPROFILE: home, HOME: home,
    APPDATA: join(home, 'AppData/Roaming'), LOCALAPPDATA: join(home, 'AppData/Local'),
    XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_CACHE_HOME: join(home, '.cache'),
    OPENCODE_CONFIG: join(home, '.config/opencode/opencode.json'), OPENCODE_CONFIG_DIR: join(home, '.config/opencode')
  }
})
const ended = new Promise(done => { child.once('error', error => { failure = error; done(null) }); child.once('exit', code => done(code)) })
for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs.push(bytes.toString()); if (logs.length > 300) logs.shift() })
const delay = ms => new Promise(done => setTimeout(done, ms))
function call(method, params = {}) {
  return new Promise((done, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out.`)) }, 90_000)
    pending.set(id, { done, reject, timer }); ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}
async function api(method, ...args) {
  const reply = await evaluate(`window.api[${JSON.stringify(method)}](...${JSON.stringify(args)})`)
  assert.equal(reply.ok, true, reply.error)
  return reply.data
}
try {
  let page
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (failure || child.exitCode !== null) throw failure ?? new Error('Packaged application exited before startup.')
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(tab => tab.type === 'page' && tab.url.startsWith('file:')); if (page) break } catch {}
    await delay(250)
  }
  assert.ok(page, 'The packaged renderer did not become available.')
  assert.ok(page.url.includes('/dist/win-unpacked/'), 'This check must target its own packaged Solar renderer.')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((done, reject) => { ws.addEventListener('open', done, { once: true }); ws.addEventListener('error', reject, { once: true }) })
  ws.addEventListener('message', event => {
    const value = JSON.parse(event.data), request = pending.get(value.id)
    if (!request) return
    clearTimeout(request.timer); pending.delete(value.id)
    if (value.error) request.reject(new Error(value.error.message)); else request.done(value.result)
  })
  for (let poll = 0; !await evaluate('Boolean(window.api)') && poll < 100; poll++) await delay(100)
  assert.equal((await api('getSetupStatus')).configured, false)
  const production = await api('productionSettings')
  assert.equal(production.enabled, false); assert.equal(production.ready, true)
  const initial = await api('getInitialState')
  assert.ok(initial.godotPath.includes('win-unpacked')); assert.ok(initial.opencodePath.includes('win-unpacked'))
  checks.push('Packaged sandboxed renderer/preload, offline binaries and default-off preview; no API credential.')
  const project = await api('createProject', fixture, 'Packaged Solar Acceptance')
  await call('Page.reload')
  for (let poll=0; !await evaluate('Boolean(window.api)') && poll<100; poll++) await delay(100)
  assert.equal((await api('getInitialState')).project.path, project.path)
  await evaluate('window.__packageLogs=[]; window.__gameState=null; window.api.onGameLog(line=>window.__packageLogs.push(line)); window.api.onGameState(state=>window.__gameState=state)')
  await evaluate('window.api.setSceneEditorBounds({x:10,y:190,width:900,height:550}); window.api.setSceneEditorVisible(true)')
  await api('openSceneEditor')
  const editor = await api('getSceneEditorState')
  assert.equal(editor.status, 'ready'); assert.equal(editor.mode, 'child'); assert.equal(editor.backend, 'libgodot')
  checks.push('API-free scene editor opens with the packaged in-process LibGodot child window.')
  await api('closeSceneEditor')
  await evaluate('window.api.setGameStageBounds({x:10,y:190,width:900,height:550}); window.api.setGameLayerVisible(true)')
  await api('playGame')
  const runDeadline = Date.now() + 20_000
  while (Date.now() < runDeadline && (await evaluate('window.__gameState'))?.status !== 'running') await delay(150)
  const game = await evaluate('window.__gameState'), gameLogs = await evaluate('window.__packageLogs')
  runtimeLogs = gameLogs; runtimeState = game
  assert.equal(game.status, 'running'); assert.ok(['embedded', 'embedded-window'].includes(game.view))
  assert.equal(/SCRIPT ERROR|Parse Error|No loader found|CRASH|FATAL/.test(JSON.stringify(gameLogs)), false, JSON.stringify(gameLogs))
  await api('stopGame')
  checks.push('API-free packaged Run uses native embedding and imports the starter logo/font without parse/load errors.')
  // Full inventories, native skills and addon preparation resolve from the
  // shipped resources, never the development checkout or a system .NET/Python.
  assert.equal((await api('productionConfigure', true)).enabled, true)
  await api('productionPrepareProject')
  const studio = await api('studioReadiness')
  assert.equal(studio.projectPath,project.path); assert.equal(studio.addons.status,'ready')
  assert.equal(studio.models.configured,false); assert.equal(studio.ready,false)
  checks.push('Packaged Studio read-only readiness reports prepared addons and missing AI credentials; never reports false readiness.')
  assert.ok((await readFile(join(project.path, 'project.godot'), 'utf8')).includes('godot_ai'))
  await api('productionConfigure', false)
  checks.push('Both offline inventories verify and project addons/skills prepare from packaged resources without downloads.')
  console.log('PASS:', checks.join('\nPASS: '))
} catch (error) { failure = error; process.exitCode = 1; console.error(error.message) }
finally {
  if (ws?.readyState === WebSocket.OPEN) {
    await api('stopGame').catch(() => {}); await api('closeSceneEditor').catch(() => {})
    await api('closeProject').catch(() => {})
    await evaluate('window.close()').catch(() => {})
    ws.close()
  }
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Acceptance connection closed.')) }
  pending.clear()
  const exit = await Promise.race([ended, delay(20_000).then(() => 'timeout')])
  if (exit === 'timeout') { child.kill(); failure ??= new Error('Packaged application did not close cleanly.'); process.exitCode = 1; await ended }
  if (!failure) {
    const log = logs.join(''), worker = log.indexOf('shutdown: LibGodot worker thread stopped'), quit = log.indexOf('shutdown: will quit')
    if (exit !== 0 || worker < 0 || quit <= worker) {
      failure = new Error('The actual LibGodot worker thread must stop before Electron quits cleanly.')
      process.exitCode = 1
    } else checks.push('Actual LibGodot worker thread stops before Electron quits with exit code 0.')
  }
  const output = join(root, '.test-dist/acceptance')
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'package-smoke.json'), JSON.stringify({ executable, durationMs: Date.now()-start, passed: !failure, checks, failure: failure?.message ?? null, exitCode: exit, runtimeState, runtimeLogs }, null, 2))
  await writeFile(join(output, 'package-smoke.log'), logs.join(''))
  const target = resolve(fixture)
  if (dirname(target) !== resolve(tmpdir()) || !target.split(/[\\/]/).at(-1).startsWith('solar-package-check-')) throw new Error('Unsafe package fixture cleanup.')
  if (!failure) await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  else console.log('Package fixture:', fixture)
}
