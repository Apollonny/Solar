'use strict'

// Runs on a Node worker thread in Electron's main OS process. Godot's native
// frame loop stays off Electron's event loop, but a native crash still ends
// the whole application. The executable backend remains available for recovery.
const { parentPort, workerData } = require('node:worker_threads')
const koffi = require('koffi')

let library
let instance = null
let stopping = false
let destroyed = false

function send(type, details = {}) {
  parentPort.postMessage({ type, ...details })
}

function destroy() {
  if (destroyed) return
  destroyed = true
  if (instance) {
    library.func('void solar_godot_destroy(void *instance)')(instance)
    instance = null
  }
}

try {
  library = koffi.load(workerData.libraryPath)
  const bridgeAbi = library.func('int solar_libgodot_bridge_abi()')
  if (bridgeAbi() !== 2) throw new Error('The LibGodot bridge ABI does not match Solar.')
  const create = library.func(
    'void *solar_godot_create_editor(const char *project, const char *parent, const char *log, int x, int y, int width, int height)'
  )
  const start = library.func('int solar_godot_start(void *instance)')
  const iteration = library.func('int solar_godot_iteration(void *instance)')
  const { projectPath, logPath, hostHandle, rect, origin } = workerData
  instance = create(projectPath, hostHandle, logPath, rect.x - origin.x, rect.y - origin.y,
    Math.max(1, rect.width), Math.max(1, rect.height))
  if (!instance) throw new Error('LibGodot could not create an editor instance.')
  if (!start(instance)) throw new Error('LibGodot could not start the editor.')

  parentPort.on('message', (message) => {
    if (message?.type === 'force-stop') stopping = true
  })
  send('ready')
  function tick() {
    try {
      if (stopping || iteration(instance)) {
        destroy()
        send('exited')
        parentPort.close()
        return
      }
      setImmediate(tick)
    } catch (error) {
      send('error', { message: error instanceof Error ? error.message : String(error) })
      destroy()
      parentPort.close()
    }
  }
  setImmediate(tick)
} catch (error) {
  send('error', { message: error instanceof Error ? error.message : String(error) })
  try { destroy() } catch { /* Nothing safe remains to call if native setup failed. */ }
  parentPort.close()
}
