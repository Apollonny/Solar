#!/usr/bin/env node
/**
 * MCP (Model Context Protocol) stdio server that exposes Solar's game
 * testing tools to OpenCode. It is a thin bridge: every tool call is
 * forwarded over HTTP to the running Solar app. The app is discovered
 * via SOLAR_HARNESS_PORT/TOKEN env vars (set by the app on the OpenCode
 * server it spawns, inherited by this process — always the right instance),
 * falling back to harness.json in Solar's userData directory for
 * OpenCode sessions that weren't launched by the app.
 *
 * Spawned by OpenCode (registered in the global opencode config by the app)
 * with Electron's binary in Node mode — no separate Node install needed.
 * Zero dependencies; speaks newline-delimited JSON-RPC 2.0 on stdio.
 */
import { readFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

function userDataDir() {
  switch (process.platform) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'Solar')
    case 'win32':
      return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Solar')
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Solar')
  }
}

function readHarness() {
  // Env vars come from the Solar instance that spawned this OpenCode
  // server, so they can't point at the wrong instance and don't suffer the
  // shared-file races harness.json has when several instances run at once
  // (e.g. dev + packaged: one quitting used to delete the other's file).
  const envPort = process.env.SOLAR_HARNESS_PORT ?? process.env.GENIEENGINE_HARNESS_PORT
  const envToken = process.env.SOLAR_HARNESS_TOKEN ?? process.env.GENIEENGINE_HARNESS_TOKEN
  if (envPort && envToken) return { port: Number(envPort), token: envToken }
  try {
    return JSON.parse(readFileSync(join(userDataDir(), 'harness.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * node:http with timeout 0 — NOT fetch: undici aborts responses that take
 * more than 5 minutes to start, and 3D asset generation legitimately takes
 * longer than that.
 */
function harnessRequest(harness, method, path, body) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: harness.port,
        method,
        path,
        headers: { 'content-type': 'application/json', 'x-solar-token': harness.token },
        timeout: 0
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => {
          try {
            resolve(JSON.parse(data))
          } catch {
            reject(new Error(`invalid harness response (HTTP ${res.statusCode})`))
          }
        })
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    req.end(body ?? '')
  })
}

async function callHarness(name, args) {
  const harness = readHarness()
  if (!harness) {
    return { ok: false, text: 'Solar does not appear to be running (harness.json not found). These tools only work while the Solar app is open.' }
  }
  try {
    const { _solar_session: executorSessionID, ...argumentsForTool } = args
    if (process.env.SOLAR_EXECUTION_MODE === 'microsoft' && typeof executorSessionID !== 'string') throw new Error('The reference call has no Microsoft stage lease.')
    return await harnessRequest(harness, 'POST', '/tool', JSON.stringify({ name, arguments: argumentsForTool, projectPath: process.env.SOLAR_PROJECT_PATH, executorSessionID }))
  } catch (err) {
    return { ok: false, text: `Failed to reach Solar: ${err.message}` }
  }
}

/** Optional-tool availability, checked once per bridge lifetime (per chat server). */
async function harnessCapabilities() {
  const harness = readHarness()
  if (!harness) return {}
  try {
    return await harnessRequest(harness, 'GET', '/capabilities')
  } catch {
    return {}
  }
}

const TOOLS = [
  {
    name: 'production_guidance',
    description: 'Read-only pinned BMAD/TEA references. Search with English path keywords, e.g. {"action":"search","query":"gdd template"}. Read only an exact returned library-relative path, e.g. {"action":"read","file":"bmad/src/workflows/4-production/gds-create-story/template.md"}. Never construct paths from repository/version metadata or repeat an unchanged search. Assigned skills are already supplied; retrieval is optional. Submit StructuredOutput when enough context is available. Never executes installers, agents, tests or hooks.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { action: { type: 'string', enum: ['search', 'read'], default: 'search', description: 'Default search. read requires an exact returned file path.' }, query: { type: 'string', maxLength: 256, description: 'Search only: individual English path keywords; omit for read.' }, file: { type: 'string', description: 'Read only: exact returned bmad/... or tea/... path. Omit for search.' }, start_line: { type: 'integer', minimum: 1, maximum: 1000000, description: 'Read only, default 1. Follow nextStartLine for necessary pages.' } } }
  },
  {
    name: 'game_guidance',
    description:
      'Search/read Solar game-development modules and the pinned Godot Game Dev Studio library offline. Default search returns up to 6 concise matches (max 8); empty query lists Solar modules. Use English topics or an exact id. Read a guide by id, then only required returned library-relative example file paths. Results include provenance, hash, reference availability and paged content; follow nextStartLine with start_line. Upstream code is a reference to adapt to Solar ECS and the actual engine, not verified drop-in code or instructions to install/execute anything. Keep the selected primary model and reasoning.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['search', 'read'], description: 'Default search; read requires id.' },
        query: { type: 'string', maxLength: 256, description: 'Search only: topic terms, e.g. characterbody 2d jump, input, camera, save load.' },
        limit: { type: 'integer', minimum: 1, maximum: 8, description: 'Search only; default 6.' },
        id: { type: 'string', description: 'Read only: a returned guide id, e.g. solar-ecs or godot-gdscript-mastery.' },
        file: { type: 'string', description: 'Read only: exact available library-relative reference path returned by this tool; omit for the guide itself.' },
        start_line: { type: 'integer', minimum: 1, description: 'Read only: default 1; use nextStartLine to continue.' },
        max_lines: { type: 'integer', minimum: 1, maximum: 240, description: 'Read only: default 160; content also has a character limit.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'project_validate',
    description:
      'Validate saved Godot project files in an isolated headless copy. Returns JSON with status, revision, scope, stable diagnostic codes, file/line, timing and cache information. Run after script/scene changes, before gameplay checks. A pass covers only saved files in the stated scope; gameplay, dynamic resources and unsaved editor changes are not verified. Incomplete/stale/timed-out checks are never a pass. Paths select explicit project-relative files; omit for all supported files.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['project', 'scripts', 'resources'], description: 'Default project checks GDScript and scene/resource loading; scripts parses GDScript; resources loads scenes/resources.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Optional normalized relative paths, e.g. main.gd or scenes/player.tscn.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'run_game_test',
    description:
      'Start the currently open Solar game project for AI testing. The game runs the full native engine (rendering, physics) — off-screen on macOS, in a separate visible window on Windows/Linux; every game_* tool works the same either way. Always call this before other game_* tools, and stop_game_test when done.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'game_input',
    description:
      'Send scripted input to the running test game. Actions execute in order. Keys use DOM-style names ("ArrowLeft", "Space", "a", "Enter", "Escape"). Mouse coordinates are in game-view points from the top-left.',
    inputSchema: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description: 'Sequence of input steps',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['key_press', 'key_down', 'key_up', 'mouse_click', 'mouse_move', 'wait'] },
              key: { type: 'string', description: 'For key_* actions' },
              holdMs: { type: 'number', description: 'key_press hold duration (default 60ms)' },
              x: { type: 'number' },
              y: { type: 'number' },
              button: { type: 'number', description: 'mouse button: 0 left, 1 middle, 2 right' },
              ms: { type: 'number', description: 'for wait' }
            },
            required: ['type']
          }
        }
      },
      required: ['actions']
    }
  },
  {
    name: 'game_screenshot',
    description:
      'Capture a PNG screenshot of the running test game. Returns the image and saves it inside the project at .solar/test-shots/ — if you cannot view images yourself, hand that saved path to the image-reader subagent. Never copy screenshots or read them from anywhere else.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'game_state',
    description:
      'Evaluate a GDScript expression against the running game\'s scene tree root and return the result as JSON. Examples: get_tree().current_scene.name · get_node("/root/Main").score · get_node("/root/Main/Score").text. Use this to assert game state without screenshots.',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'GDScript expression (no statements)' } },
      required: ['expression']
    }
  },
  {
    name: 'game_scene_tree',
    description: 'Dump the running game\'s scene tree (node names, classes, hierarchy). Useful to discover node paths for game_state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'game_logs',
    description:
      'Get the game\'s recent console output (prints and script errors) and current run status. Includes "[solar] fps" lines with frame-rate stats (avg/min/max/1% low/0.1% low per 60s window). The full frame-rate history across runs — including the user\'s own play sessions — persists in .solar/perf.log; read that file when diagnosing performance problems.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'stop_game_test',
    description: 'Stop the running test game.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'asset_library',
    description: 'Search Solar’s curated partner asset library before generating game assets. Use recommend with mechanic (movement/combat/pickup/environment/weather/ambience/ui), dimension and style for up to three concrete preset choices per pack, real dimensions/animation names/static bounds, readiness and deterministic solarPath. When tuning a preset, call recommend again with exact packId/path and preset to obtain its new solarPath. Select the exact source path/hash and preset in import or ChangeSet.assetImports. Presets generate Godot wrappers with optional explicit sprite clips, verified model scale/collision, rig metadata or audio loop/volume. needs-adaptation requires actual editor/runtime verification. Filter dimension/kind/style; inspect one pack for exact filenames, hashes and compatibility notes; read bounded source text. In legacy mode use import with packId and exact files while the game is stopped. In Microsoft mode submit ChangeSet.assetImports instead; direct import is disabled. Solar resolves dependencies and preserves provenance. An available/unavailable source is not an installed asset. Reference guides and editor addons are not runtime asset packs. Never invent paths or load the whole catalog into context.',
    inputSchema: {"type":"object","properties":{"action":{"type":"string","enum":["search","inspect","read","recommend","import"]},"query":{"type":"string"},"packId":{"type":"string"},"path":{"type":"string"},"files":{"type":"array","maxItems":24,"items":{"type":"object","properties":{"path":{"type":"string"},"sha256":{"type":"string"},"preset":{"type":"object","properties":{"kind":{"type":"string","enum":["sprite2d","model3d","effect3d","animation-library","audio","shader-material"]},"frameWidth":{"type":"integer","minimum":1,"maximum":4096},"frameHeight":{"type":"integer","minimum":1,"maximum":4096},"animations":{"type":"array","minItems":1,"maxItems":8,"items":{"type":"object","properties":{"name":{"type":"string"},"start":{"type":"integer","minimum":0},"count":{"type":"integer","minimum":1,"maximum":60},"fps":{"type":"number","minimum":1,"maximum":60},"loop":{"type":"boolean"}},"required":["name","start","count","fps","loop"],"additionalProperties":false}},"targetHeight":{"type":"number","minimum":0.01,"maximum":1000},"collision":{"type":"string","enum":["none","static","pickup"]},"volumeDb":{"type":"number","minimum":-80,"maximum":0},"loop":{"type":"boolean"}},"required":["kind"],"additionalProperties":false}},"required":["path","sha256"],"additionalProperties":false}},"dimension":{"type":"string","enum":["2d","3d","any"]},"mechanic":{"type":"string","enum":["movement","combat","pickup","environment","weather","ambience","ui","custom"]},"kind":{"type":"string"},"style":{"type":"string"},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":8},"preset":{"type":"object","properties":{"kind":{"type":"string","enum":["sprite2d","model3d","effect3d","animation-library","audio","shader-material"]},"frameWidth":{"type":"integer","minimum":1,"maximum":4096},"frameHeight":{"type":"integer","minimum":1,"maximum":4096},"animations":{"type":"array","minItems":1,"maxItems":8,"items":{"type":"object","properties":{"name":{"type":"string"},"start":{"type":"integer","minimum":0},"count":{"type":"integer","minimum":1,"maximum":60},"fps":{"type":"number","minimum":1,"maximum":60},"loop":{"type":"boolean"}},"required":["name","start","count","fps","loop"],"additionalProperties":false}},"targetHeight":{"type":"number","minimum":0.01,"maximum":1000},"collision":{"type":"string","enum":["none","static","pickup"]},"volumeDb":{"type":"number","minimum":-80,"maximum":0},"loop":{"type":"boolean"}},"required":["kind"],"additionalProperties":false}},"additionalProperties":false}
  },
  {
    name: 'itch_search',
    description:
      "Search itch.io's catalog of FREE game assets (sprites, tilesets, 3D models, audio, fonts) — no account needed. " +
      'Returns a numbered markdown list of asset pages with clickable links. Present that list to the user VERBATIM as numbered options, ' +
      "remind them to check each asset's license/attribution rules on its itch.io page, and ask them to pick before downloading. " +
      'Rate-limited: make ONE well-chosen search (e.g. "pixel art dungeon tileset"), not many variations.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms, e.g. "pixel art dungeon tileset" or "low poly nature pack".' }
      },
      required: ['query']
    }
  },
  {
    name: 'itch_download',
    description:
      "Download a FREE asset from its itch.io page (URL shaped https://<author>.itch.io/<name>) into the project's .solar/itch/ " +
      'staging folder — zip archives are auto-extracted — and return the file listing. Only free assets work (no purchases, no account). ' +
      'Staged files are INVISIBLE to Godot and git: afterwards copy just the pieces the user wants into the proper assets/ sub-folders ' +
      'with your file tools and wire them into scenes. Only call this after the user has picked an asset.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: "The asset's itch.io page URL, e.g. https://pixelfrog-assets.itch.io/kings-and-pigs." }
      },
      required: ['url']
    }
  }
]

/**
 * Offered only when the user has configured an OpenAI API key in Solar's
 * settings panel (checked via /capabilities at list time).
 */
const GPT_IMAGE_TOOL = {
  name: 'generate_2d_asset',
  description:
    'Generate a 2D image asset (sprite, icon, texture, UI art) with OpenAI image generation and save it into the project\'s assets/ folder. ' +
    'Fixed output: one 1024×1024 PNG with a TRANSPARENT background at medium quality — ideal for sprites and icons. ' +
    'Takes ~10-60 seconds; returns the written file path plus the image itself so you can check it. ' +
    'Describe ONE subject per call (subject, colors/materials, art style, camera angle e.g. "top-down" or "side view for a platformer"). ' +
    'Organize assets to mirror the ECS layout: folder "entities/e_player" for that entity\'s art, "ui" for HUD art, "shared" for reusable pieces. ' +
    'If the user gives feedback on the preview, regenerate with the SAME folder and name so the files are replaced.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Text description of the image (one subject, style, colors, view angle).' },
      folder: { type: 'string', description: 'Destination under assets/, mirroring the ECS structure — e.g. "entities/e_player", "ui", "shared".' },
      name: { type: 'string', description: 'Asset name (lowercase slug), e.g. "coin-icon".' }
    },
    required: ['prompt', 'folder', 'name']
  }
}

/**
 * Offered only when the user has configured Tencent HY 3D credentials in
 * Solar's setup panel (checked via /capabilities at list time).
 */
const HY3D_TOOL = {
  name: 'generate_3d_asset',
  description:
    'Generate a 3D model with Tencent HY 3D and save it into the project\'s assets/ folder. ' +
    'Takes 1-5 minutes — the call blocks until the model is ready and returns the written file paths plus a preview image. ' +
    'Describe ONE object per call (simple prompt: subject, shape, colors/materials, style). ' +
    'Organize assets to mirror the ECS layout: folder "entities/e_player" for that entity\'s model, "ui" for HUD art, "shared" for reusable pieces. ' +
    'Keep face_count modest for game use (default 60000; use generate_type "LowPoly" for stylized low-poly).',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Text description of the 3D object (max 1024 chars). Required unless image_path is given.' },
      image_path: { type: 'string', description: 'Project-relative path to a reference image (jpg/png/webp, single object on a plain background). Cannot be combined with prompt except in Sketch mode.' },
      folder: { type: 'string', description: 'Destination under assets/, mirroring the ECS structure — e.g. "entities/e_player", "ui", "shared".' },
      name: { type: 'string', description: 'Asset name (lowercase slug), e.g. "spaceship".' },
      face_count: { type: 'number', description: 'Polygon budget, 3000-1500000 (default 60000).' },
      generate_type: { type: 'string', enum: ['Normal', 'LowPoly', 'Geometry', 'Sketch'], description: 'Normal = textured model (default) · LowPoly = stylized reduced-poly · Geometry = untextured white model · Sketch = from a line drawing.' },
      enable_pbr: { type: 'boolean', description: 'Generate PBR materials (default true; ignored for Geometry).' }
    },
    required: ['folder', 'name']
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

async function handle(request) {
  const { id, method, params } = request
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'solar', version: '0.1.0' }
      }
    })
  } else if (method === 'tools/list') {
    const caps = await harnessCapabilities()
    const tools = TOOLS.map((tool) => tool.name === 'run_game_test' && caps.gameTestBudget
      ? { ...tool, description: tool.description + ' ' + caps.gameTestBudget }
      : tool)
    if (caps.hy3d) tools.push(HY3D_TOOL)
    if (caps.gptImage) tools.push(GPT_IMAGE_TOOL)
    send({ jsonrpc: '2.0', id, result: { tools } })
  } else if (method === 'tools/call') {
    const result = await callHarness(params.name, params.arguments ?? {})
    const content = []
    if (result.imageBase64) {
      content.push({ type: 'image', data: result.imageBase64, mimeType: result.imageMime ?? 'image/png' })
    }
    content.push({ type: 'text', text: result.text ?? (result.ok ? 'ok' : 'failed') })
    send({ jsonrpc: '2.0', id, result: { content, isError: !result.ok } })
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} })
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
  // Notifications (no id) are ignored.
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (!line.trim()) return
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  handle(request).catch((err) => {
    if (request.id !== undefined) {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: String(err?.message ?? err) } })
    }
  })
})
rl.on('close', () => process.exit(0))
