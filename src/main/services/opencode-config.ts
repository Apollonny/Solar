import { app } from 'electron'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyAgentConfig, configuredImageModel, normalizeChatReasoningOptions, normalizeManagedProviderAdapters } from './opencode-setup'
import { readJsonForUpdate, writeAtomic } from './json-file'
import { gameTestBudgetInstructions } from '../../shared/agent-budget'

/**
 * Keeps Solar's entries in the user's global OpenCode config
 * (~/.config/opencode/opencode.json) up to date at app startup:
 *
 *  - `mcp.solar` — the game-testing MCP bridge, giving the assistant the
 *    run_game_test / game_input / game_screenshot / game_state tools in every
 *    project. The bridge is spawned with the app's own binary in Node mode
 *    (ELECTRON_RUN_AS_NODE), so users don't need Node installed; it locates
 *    the running app through harness.json (see test-harness.ts), so this
 *    config stays valid across app restarts. This file entry serves OpenCode
 *    sessions launched outside the app (e.g. a terminal); servers the app
 *    spawns get a per-spawn override pointing at their own instance instead
 *    (see solarMcpEntry).
 *  - `agent.image-reader` / `agent.game-tester` — the image-enabled subagents
 *    (see opencode-setup.ts). Re-applied here so users who never reopen the
 *    settings panel (upgrades) still get them, and so prompt/tool refinements
 *    ship with app updates. The models the user picked are preserved.
 *
 * Everything else in the config is the user's and is left untouched.
 */
/**
 * This instance's `mcp.solar` entry, pointing at its own binary and
 * bridge script by absolute path (null when the bridge script is missing —
 * broken install). Used twice:
 *
 *  - written into the global config below, as the fallback for OpenCode
 *    sessions not launched by the app;
 *  - passed per spawn via OPENCODE_CONFIG_CONTENT (see ensureServer in
 *    opencode.ts). The global file names exactly ONE instance's paths
 *    (last-started wins), so with several installs around (dev checkout +
 *    mounted DMG builds) it points every other instance at a binary that
 *    instance's sandbox can't read — which silently killed the bridge and
 *    all game tools. The override keeps each server on its own bridge.
 */
/**
 * Absolute path of a file in the app's resources/ folder: the checkout's
 * resources/ in development, the asar-unpacked copy in packaged builds
 * (asarUnpack covers resources/**, so external processes like the OpenCode
 * server can read these files directly). Null when missing — broken install.
 */
function bundledResource(name: string): string | null {
  const path = app.isPackaged
    ? join(process.resourcesPath, 'app.asar.unpacked', 'resources', name)
    : join(app.getAppPath(), 'resources', name)
  return existsSync(path) ? path : null
}

/**
 * The app-owned build rules (scope, ECS architecture, asset layout, file
 * headers, testing) injected into every app-spawned chat server via the
 * `instructions` config key — OpenCode loads the file into the system prompt
 * the same way it loads the project's AGENTS.md. They live here rather than
 *
 *  - in the project's AGENTS.md, which is a creation-time snapshot that would
 *    go stale as the app updates (projects.ts upgrades old fat copies), or
 *  - in the global config file, where they would leak Godot-game policy into
 *    the user's unrelated terminal OpenCode sessions.
 *
 * Safe to pass per spawn: `instructions` arrays concatenate across config
 * layers (unlike other arrays, which replace), so instructions the user
 * configured themselves survive.
 */
export async function agentInstructionsPath(): Promise<string | null> {
  const source = bundledResource('agent-instructions.md')
  if (!source) return null
  const template = await readFile(source, 'utf8')
  const contents = template.replaceAll('{{SOLAR_GAME_TEST_BUDGET}}', gameTestBudgetInstructions())
  const hash = createHash('sha256').update(contents).digest('hex')
  const target = join(app.getPath('userData'), 'agent-instructions', `${hash}.md`)
  if (!existsSync(target)) await writeAtomic(target, contents)
  return target
}

export function solarMcpEntry(): Record<string, unknown> | null {
  const bridgePath = bundledResource('mcp-bridge.mjs')
  if (!bridgePath) return null
  return {
    type: 'local',
    command: [process.execPath, bridgePath],
    enabled: true,
    environment: { ELECTRON_RUN_AS_NODE: '1' }
  }
}

export function solarSkillsPlugin(): string {
  const plugin = bundledResource('solar-skills-plugin.mjs')
  if (!plugin) throw new Error('The Solar native skill plugin is missing. Restore the application resources.')
  return pathToFileURL(plugin).href
}

export async function ensureOpencodeConfig(): Promise<void> {
  try {
    const entry = solarMcpEntry()
    if (!entry) return

    const configDir = join(homedir(), '.config', 'opencode')
    const configPath = join(configDir, 'opencode.json')
    const { value: config, original } = await readJsonForUpdate(configPath)
    const before = JSON.stringify(config)

    const mcp = (config.mcp ?? {}) as Record<string, unknown>
    if (mcp.genieengine && JSON.stringify(mcp.genieengine).includes('mcp-bridge.mjs')) {
      delete mcp.genieengine
    }
    mcp.solar = entry
    config.mcp = mcp

    // Without this flag OpenCode halts the whole agent run when a permission
    // ask is rejected (the model only sees the denial after the user manually
    // prompts again). With it, a denial comes back as a normal tool error the
    // agent can read and route around mid-run — Solar answers every ask
    // automatically (see replyToPermission in opencode.ts), so a halt would
    // otherwise strand the chat on every rejected out-of-project access.
    const experimental = (config.experimental ?? {}) as Record<string, unknown>
    experimental.continue_loop_on_deny = true
    config.experimental = experimental

    applyAgentConfig(config, configuredImageModel(config))
    normalizeManagedProviderAdapters(config)
    normalizeChatReasoningOptions(config)

    if (!config.$schema) config.$schema = 'https://opencode.ai/config.json'
    if (JSON.stringify(config) === before) return
    await writeAtomic(configPath, JSON.stringify(config, null, 2), original)
  } catch (err) {
    console.error('[solar] failed to update opencode config:', err)
  }
}
