import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { request as httpRequest, get as httpGet } from 'node:http'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { sendToRenderer } from '../window'
import { resolveOpencode } from './binaries'
import { loadTranscriptRecap, saveChatAttachments, saveChatUploads, type SavedUpload } from './chat-history'
// Benign import cycles (opencode-setup and opencode-config → opencode-setup
// import shutdownChat): all sides only use the other's exports at call time,
// never during module evaluation.
import { agentInstructionsPath, solarMcpEntry, solarSkillsPlugin } from './opencode-config'
import { prepareNativeGameSkills } from './opencode-skills'
import { isSolarNativeSkillName,selectProductionSkills } from './game-guidance'
import { GAME_TESTER_AGENT, IMAGE_READER_AGENT, resolveChatModel, configuredImageModel, runtimeSetupAuth } from './opencode-setup'
import { getProductionEnabled, getCurrentProject } from '../state'
import { controlledAgentConfig, getProductionSession, productionPolicyPath, registerProductionSession, unregisterProductionSession, recordProductionSkill, productionSkillsLoaded,productionAssetSelections,registerLegacySession,unregisterLegacySession,clearLegacySessions } from './production-policy'
import { prepareProductionSkills } from './production-guidance'
import { productionAttempt } from './production-attempts'
import { ProductionToolGuard } from './production-tool-guard'
import { scopedExternalRead } from './production-permissions'
import type { ProductionRole, ProductionState, StageExecution } from '../../shared/production'
import { validateProductionOutput, type ArtifactSchema } from '../../shared/production-output'
import { isSetupUpdating } from './setup-mutations'
import { getHarnessEndpoint } from './test-harness'
import { getActiveAgentRun, startAgentRun } from './agent-run-metrics'
import { productionRoles, productionSolarReadTools, effectiveExecutorPermission, roleSolarReadTools, validateRoleSkills,validateRoleDispatch, type ExecutorPermission } from './production-role-config'
import { selectedSkillContext } from './skill-context'
import { CONNECTION_RECOVERY, connectionRetryDelay, isConnectionFailure } from '../../shared/connection-recovery'
import { clearChatConnection, connectionWait, publishChatConnection } from './chat-connection'
import { cancelProjectValidations } from './project-validation'
import {snapshotProject} from './project-snapshot'
import {projectTaskSelection} from './production-planning-context'
import {developerTaskSkills,type TaskSelectionPolicy} from '../../shared/ai-task-selection'
import type { ChatAttachment, ChatPartUpdate, ChatToolStatus } from '../../shared/types'

/**
 * AI chat backed by a headless OpenCode server (https://opencode.ai).
 *
 * One `opencode serve` process runs per open project (sessions are bound to
 * the server's working directory). Messages go through the HTTP API and the
 * /event SSE stream feeds live progress — text deltas, reasoning and tool
 * invocations — so long agentic tasks show real activity in the chat instead
 * of a silent spinner. The blocking message POST provides the authoritative
 * final message state.
 */

interface OpencodeServer {
  proc: ChildProcess
  base: string
  projectPath: string
  stderrTail: string
  sseAbort: AbortController
  /** Set once the configured model's provider is confirmed available. */
  providerChecked?: boolean
  startupError?: Error
  managed?: boolean
}

let server: OpencodeServer | null = null
let sessionID: string | null = null
/** True while sessionID came from a saved chat file and hasn't been checked against the server. */
let sessionRestored = false
let busy = false
let cancelled = false
let chatController = new AbortController()
let chatEpoch = 0
let legacySelection: {projectPath:string;request:string;policy:TaskSelectionPolicy;skills:string[]}|null=null
let serverStartup: { epoch: number; projectPath: string; promise: Promise<OpencodeServer> } | null = null
let filesChangedTimer: ReturnType<typeof setTimeout> | null = null
/**
 * Message metadata by messageID (parts carry neither field themselves): role
 * filters the user's echoed message out of the stream, agent tells a subagent
 * session's parts apart so delegated work can be shown labelled in the chat.
 */
const messageMeta = new Map<string, { role: string; agent?: string; createdAt?: number }>()
/**
 * Accumulated text of streaming parts in the current turn, by partID.
 * message.part.updated only snapshots a part (empty on creation, full on
 * completion) — the characters in between arrive as message.part.delta
 * appends, so without this cache text and thinking would not stream at all.
 */
const partCache = new Map<string, ChatPartUpdate>()
const shutdownListeners = new Set<() => void>()
const managedAttempts = new Map<string, { fail: (error: Error) => void; observe: (type: string, properties: Record<string, any>) => void }>()
let chatActivity: { sessionId: string; lastProgress: number; tools: Set<string>; questions: Set<string> } | null = null
export function isChatBusy(): boolean { return busy }
export function onChatShutdown(callback: () => void): () => void { shutdownListeners.add(callback); return () => shutdownListeners.delete(callback) }

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

async function waitForHealth(srv: OpencodeServer): Promise<void> {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (srv.sseAbort.signal.aborted) throw new Error('Assistant startup was cancelled.')
    if (srv.startupError) throw srv.startupError
    if (srv.proc.exitCode !== null || srv.proc.signalCode !== null) {
      throw new Error(`OpenCode server exited unexpectedly: ${srv.stderrTail.trim() || 'no output'}`)
    }
    try {
      const res = await fetch(`${srv.base}/session`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('OpenCode server did not become ready in time')
}

/* eslint-disable @typescript-eslint/no-explicit-any -- SSE payloads are untyped JSON */
function translatePart(part: any): ChatPartUpdate | null {
  if (!part?.id || !part.messageID) return null
  if (part.type === 'text' || part.type === 'reasoning') {
    return { messageID: part.messageID, partID: part.id, kind: part.type, text: part.text ?? '' }
  }
  if (part.type === 'tool') {
    // Phantom calls: some model/provider combos (notably Kimi through
    // quantized OpenRouter hosts) emit malformed duplicate tool-call
    // fragments. OpenCode records them as tool "unknown" — they never
    // execute and the real call sits alongside, so they're pure noise.
    if (!part.tool || part.tool === 'unknown') return null
    const state = part.state ?? {}
    const status: ChatToolStatus = ['pending', 'running', 'completed', 'error'].includes(state.status)
      ? state.status
      : 'running'
    // Prefer the human title OpenCode assigns on completion; fall back to the
    // tool input (file path, subagent task description, or command) so
    // pending chips aren't blank.
    const input = state.input ?? {}
    const title: string =
      state.title ||
      input.filePath ||
      input.pattern ||
      input.description ||
      input.expression ||
      (typeof input.command === 'string' ? input.command : '') ||
      ''
    return {
      messageID: part.messageID,
      partID: part.id,
      kind: 'tool',
      tool: {
        name: part.tool ?? 'tool',
        status,
        title: String(title).slice(0, 200),
        // Why the call failed — shown as a tooltip on the red ✗ chip.
        error: status === 'error' && state.error ? String(state.error).slice(0, 500) : undefined
      }
    }
  }
  return null // step-start / step-finish / snapshot etc. — not user-facing
}

/**
 * External directories the agent may use freely: the OS scratch space, in
 * every spelling it shows up under (macOS /tmp is a symlink into /private,
 * and os.tmpdir() lives in /var/folders).
 */
const TEMP_ROOTS = [
  tmpdir(),
  ...(process.platform === 'darwin' ? ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders'] : []),
  ...(process.platform === 'linux' ? ['/tmp'] : [])
]

function isUnderRoot(dir: string, root: string): boolean {
  // Windows paths compare case-insensitively.
  const [a, b] = process.platform === 'win32' ? [dir.toLowerCase(), root.toLowerCase()] : [dir, root]
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep)
}

/**
 * OpenCode pauses the whole session until permission asks are answered, and
 * Solar has no permission UI — unanswered asks would freeze the chat
 * forever. Policy, matching the CLI's autonomous behavior:
 *
 *  - external_directory asks for the OS temp dir are approved — shell
 *    commands legitimately stage scratch files in /tmp, and rejecting those
 *    made ordinary bash commands fail mid-turn;
 *  - other external_directory asks are rejected WITH feedback telling the
 *    agent to stay inside the project and where in-project copies of what it
 *    usually wants (screenshots, attachments) already live;
 *  - everything else is approved.
 *
 * A rejection only steers the model instead of stranding the run because
 * ensureOpencodeConfig sets experimental.continue_loop_on_deny — without it
 * OpenCode stops the agent loop on every rejected ask and the chat sits dead
 * until the user manually prompts "continue".
 *
 * Bash can still slip file access past OpenCode's command parsing, so this
 * reply is NOT what keeps the agent out of the user's personal folders — the
 * macOS seatbelt around the server process is (see sandboxCommand).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- untyped event payload */
function replyToPermission(sessionId: string, permissionId: string, permission: string, ask: any): void {
  if (!server) return
  const srv = server
  let response: 'always' | 'reject' = 'always'
  let feedback: string | undefined
  const managed = getProductionSession(sessionId)
  if (server.managed) {
    const selected = permission === 'skill' && managed && Array.isArray(ask?.patterns) && ask.patterns.every((name: string) => managed.skills.includes(name))
    const scopedRead = permission === 'external_directory' && managed && scopedExternalRead(ask?.patterns, managed.readPaths)
    response = selected || scopedRead ? 'always' : 'reject'
    feedback = selected || scopedRead ? undefined : 'Microsoft owns this stage. The executor cannot mutate files, delegate, execute commands or expand permissions.'
  }
  if (!server.managed && permission === 'external_directory') {
    // The ask names the directories involved: bash asks carry
    // metadata.directories, file-tool asks metadata.parentDir, and both carry
    // "<dir>/*" patterns. An ask we can't extract a directory from fails
    // closed (reject), same as the old blanket behavior.
    const meta = ask?.metadata ?? {}
    const dirs: string[] = (
      Array.isArray(meta.directories) && meta.directories.length
        ? meta.directories
        : typeof meta.parentDir === 'string' && meta.parentDir
          ? [meta.parentDir]
          : Array.isArray(ask?.patterns)
            ? ask.patterns.map((p: unknown) => String(p).replace(/[\\/]\*$/, ''))
            : []
    ).map(String)
    const inTemp = dirs.length > 0 && dirs.every((d) => TEMP_ROOTS.some((root) => isUnderRoot(d, root)))
    if (!inTemp) {
      response = 'reject'
      feedback =
        `${dirs.join(', ') || 'That path'} is outside the project directory and off-limits. ` +
        'Work only inside the project (the OS temp dir is fine for scratch files). ' +
        'Game screenshots are already saved in-project under .solar/test-shots/ and ' +
        'user-attached files (images, zips, asset folders) under .solar/attachments/ — ' +
        'read them from there instead of copying.'
    }
  }
  void (async () => {
    try {
      // Newer reply route: a rejection can carry feedback, which reaches the
      // model as the tool error text so it can route around the denial.
      await api(srv, 'POST', `/permission/${permissionId}/reply`, { reply: response, message: feedback })
    } catch {
      // Older servers only have the session route (feedback not supported).
      await api(srv, 'POST', `/session/${sessionId}/permissions/${permissionId}`, { response }).catch(() => {})
    }
  })()
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function handleEvent(evt: any): void {
  const props = evt?.properties ?? {}
  const activity = chatActivity
  if (activity && (props.sessionID ?? props.part?.sessionID ?? props.info?.sessionID) === activity.sessionId) {
    if (/^question\.(?:v2\.)?asked$/.test(evt.type)) activity.questions.add(props.id)
    if (/^question\.(?:v2\.)?(?:replied|rejected)$/.test(evt.type)) activity.questions.delete(props.requestID)
    if (evt.type === 'message.part.updated' && props.part?.type === 'tool') {
      if (['pending','running'].includes(props.part.state?.status)) activity.tools.add(props.part.id)
      else activity.tools.delete(props.part.id)
    }
    if (evt.type === 'message.part.delta' && props.delta?.length || evt.type === 'message.part.updated' && (props.part?.text?.length || props.part?.type === 'tool')) {
      activity.lastProgress = Date.now()
      if (server) publishChatConnection({projectPath:server.projectPath,source:'provider',status:'connected',message:'AI connection restored.'})
    }
    if (evt.type === 'session.status' && props.status?.type === 'retry' && server) {
      publishChatConnection({projectPath:server.projectPath,source:'provider',status:'reconnecting',message:'Reconnecting to the AI provider. Your conversation is preserved…'})
    }
  }
  const controlled = managedAttempts.get(props.sessionID ?? props.part?.sessionID ?? props.info?.sessionID ?? '')
  controlled?.observe(evt?.type, props)
  if (controlled && evt?.type === 'session.status' && props.status?.type === 'retry') {
    const quota = props.status.action?.reason === 'free_tier_limit'
    controlled.fail(new Error(quota ? 'Provider quota requires attention; automatic retry was stopped.' : 'PRODUCTION_TRANSIENT: OpenCode provider retry was stopped; Microsoft owns the next attempt.'))
    return
  }
  if (controlled && evt?.type === 'session.compacted') {
    controlled.fail(new Error('The controlled role exceeded its context. Automatic context rollover was stopped; revise the story or its retrieval scope.'))
    return
  }
  if (evt?.type === 'permission.asked' && props.id && props.sessionID) {
    replyToPermission(props.sessionID, props.id, String(props.permission ?? ''), props)
  } else if (evt?.type === 'permission.v2.asked' && props.id && props.sessionID) {
    replyToPermission(props.sessionID, props.id, String(props.action ?? ''), props)
  } else if (
    (evt?.type === 'question.asked' || evt?.type === 'question.v2.asked') &&
    props.id &&
    props.sessionID === sessionID
  ) {
    // The "question" tool blocks the whole turn until it gets a reply — the
    // renderer shows the options as buttons (see ChatPanel's question card).
    // Both API generations carry identical payloads (id/sessionID/questions),
    // same v1/v2 dance as the permission events above.
    sendToRenderer('chat:question', { id: props.id, questions: props.questions ?? [] })
  } else if (/^question\.(v2\.)?(replied|rejected)$/.test(evt?.type) && props.requestID) {
    sendToRenderer('chat:question-done', props.requestID)
  } else if (evt?.type === 'message.updated' && props.info?.id) {
    messageMeta.set(props.info.id, { role: props.info.role, agent: props.info.agent, createdAt: props.info.time?.created })
    const run = getActiveAgentRun(server?.projectPath)
    if (run && props.info.role === 'assistant' && (props.info.sessionID === sessionID || getProductionSession(props.info.sessionID)) && props.info.time?.created >= run.started) {
      run.providerUsage(props.info.id, props.info.tokens, props.info.cost)
    }
  } else if (evt?.type === 'message.part.updated') {
    const managed = getProductionSession(props.sessionID ?? props.part?.sessionID ?? '')
    if (managed && props.part) {
      if (messageMeta.get(props.part.messageID)?.role === 'user') return
      const update = translatePart(props.part)
      if (update?.kind === 'tool' && update.tool) {
        const run = getActiveAgentRun(server?.projectPath)
        run?.tool(update.partID, String(props.part.tool ?? ''), String(props.part.state?.status ?? ''))
        const name = props.part.state?.input?.name
        if (props.part.tool === 'skill' && props.part.state?.status === 'completed' && messageMeta.get(props.part.messageID)?.role === 'assistant' && managed.skills.includes(name)) { recordProductionSkill(props.part.sessionID ?? props.sessionID, name); if (isSolarNativeSkillName(name)) run?.skillLoaded(update.partID, name) }
        sendToRenderer('chat:part', { ...update, tool: { ...update.tool, agent: managed.role } })
      }
      return
    }
    if (!sessionID || !props.part) return
    if ((props.sessionID ?? props.part.sessionID) === sessionID) {
      // The user's own message echoes back as a text part — skip it.
      if (messageMeta.get(props.part.messageID)?.role === 'user') return
      const update = translatePart(props.part)
      if (update) {
        const active = getActiveAgentRun(server?.projectPath)
        const run = active && (messageMeta.get(props.part.messageID)?.createdAt ?? 0) >= active.started ? active : null
        if ((update.kind === 'text' || update.kind === 'reasoning') && update.text) run?.response()
        if (update.kind === 'tool') {
          run?.tool(update.partID, String(props.part.tool ?? ''), String(props.part.state?.status ?? ''))
          const skill = props.part.state?.metadata?.name ?? props.part.state?.input?.name
          if (props.part.tool === 'skill' && props.part.state?.status === 'completed' && isSolarNativeSkillName(skill)) run?.skillLoaded(update.partID, skill)
        }
        if (update.kind === 'text' || update.kind === 'reasoning') partCache.set(update.partID, update)
        sendToRenderer('chat:part', update)
      }
    } else {
      // Subagent sessions (task-tool children) used to stream nothing: the
      // game-tester would probe for 10+ minutes behind a perfectly still
      // chat, and users read the silence as a hang and cancelled the turn.
      // Relay their tool calls — labelled, tools only; their text/reasoning
      // belongs to the subagent's own report, not the main transcript.
      const agent = messageMeta.get(props.part.messageID)?.agent
      if (agent !== GAME_TESTER_AGENT && agent !== IMAGE_READER_AGENT) return
      const update = translatePart(props.part)
      if (update?.kind === 'tool' && update.tool) {
        const run = getActiveAgentRun(server?.projectPath)
        if (run && (messageMeta.get(props.part.messageID)?.createdAt ?? 0) >= run.started) run.tool(update.partID, String(props.part.tool ?? ''), String(props.part.state?.status ?? ''))
        sendToRenderer('chat:part', { ...update, tool: { ...update.tool, agent } })
      }
    }
  } else if (evt?.type === 'message.part.delta') {
    if (!sessionID || props.sessionID !== sessionID || props.field !== 'text') return
    const cached = partCache.get(props.partID)
    if (!cached) return // part not announced (or not a streaming kind) — skip
    cached.text = (cached.text ?? '') + String(props.delta ?? '')
    const run = getActiveAgentRun(server?.projectPath)
    if (cached.text && run && (messageMeta.get(cached.messageID)?.createdAt ?? 0) >= run.started) run.response()
    sendToRenderer('chat:part', { ...cached })
  } else if (evt?.type === 'file.edited') {
    // The agent touched a project file — nudge the Files/Git panels (debounced).
    if (filesChangedTimer) clearTimeout(filesChangedTimer)
    filesChangedTimer = setTimeout(() => sendToRenderer('chat:files-changed'), 750)
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Consume the server's SSE event stream via node:http — undici's fetch
 * applies a 5-minute idle body timeout that would silently kill the stream
 * during long agent "thinking" gaps. Reconnects while the server lives.
 */
function pumpEvents(srv: OpencodeServer): void {
  if (srv.sseAbort.signal.aborted || server !== srv) return
  let scheduled = false
  const retry = (): void => {
    if (scheduled || srv.sseAbort.signal.aborted || server !== srv || srv.proc.exitCode !== null || srv.proc.signalCode !== null) return
    scheduled = true
    if (busy || managedAttempts.size) publishChatConnection({projectPath:srv.projectPath,source:'events',status:'reconnecting',message:'Reconnecting to the assistant stream…'})
    const timer = setTimeout(() => { srv.sseAbort.signal.removeEventListener('abort', stop); pumpEvents(srv) }, 1000)
    const stop = (): void => clearTimeout(timer)
    srv.sseAbort.signal.addEventListener('abort', stop, { once:true })
  }
  const req = httpGet(`${srv.base}/event`, { signal: srv.sseAbort.signal, timeout: 0 }, (res) => {
    if (res.statusCode !== 200) { res.resume(); retry(); return }
    if (srv.sseAbort.signal.aborted || server !== srv) { res.destroy(); return }
    publishChatConnection({projectPath:srv.projectPath,source:'events',status:'connected',message:'Assistant stream reconnected.'})
    res.setEncoding('utf8')
    let buffer = ''
    res.on('data', (chunk: string) => {
      if (srv.sseAbort.signal.aborted || server !== srv) return
      buffer += chunk
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))
        if (!dataLine) continue
        try {
          handleEvent(JSON.parse(dataLine.slice(5)))
        } catch {
          /* malformed frame — skip */
        }
      }
    })
    res.on('end', () => retry())
    res.on('error', () => retry())
    res.on('close', () => retry())
  })
  req.on('error', () => retry())

}

/** Quote a path as an SBPL string literal. */
function sbplPath(p: string): string {
  return `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** A path plus its symlink-resolved form (seatbelt matches canonical paths). */
function withRealpath(p: string): string[] {
  try {
    const real = realpathSync(p)
    return real === p ? [p] : [p, real]
  } catch {
    return [p]
  }
}

/**
 * The .app bundle holding the running executable (macOS layout is always
 * <bundle>.app/Contents/MacOS/<binary>). Falls back to the binary's own
 * directory if the executable somehow isn't in a bundle — never a broad
 * ancestor, since this feeds a sandbox allow-rule.
 */
function appBundleRoot(): string {
  const bundle = dirname(dirname(dirname(process.execPath)))
  return bundle.endsWith('.app') ? bundle : dirname(process.execPath)
}

/** Every ancestor directory of p, from dirname(p) up to the filesystem root. */
function ancestorDirs(p: string): string[] {
  const out: string[] = []
  for (let dir = dirname(p); ; dir = dirname(dir)) {
    out.push(dir)
    if (dir === dirname(dir)) break
  }
  return out
}

/**
 * Wraps the chat-server command in a macOS seatbelt sandbox, inherited by
 * every tool it spawns (bash, rg, git, the MCP bridge). Two reasons:
 *
 *  - macOS attributes file access by this process tree to Solar, so a
 *    stray `find ~` from the model used to pop "Solar would like to
 *    access your Desktop/Photos/…" TCC dialogs at the user. Seatbelt denies
 *    the access before TCC is ever consulted — no dialog, the command just
 *    gets a permission error the agent can read and route around.
 *  - OpenCode's external-directory permission asks are parsed out of bash
 *    commands heuristically and can miss, so replyToPermission alone can't
 *    keep the agent out of personal folders. This is the hard boundary.
 *
 * The profile allows everything except the user's personal and cloud-synced
 * folders plus key credential stores. The project itself is re-allowed even
 * when it lives inside a denied folder (projects commonly sit in Documents;
 * SBPL is last-match-wins), and the app's own files stay readable — the
 * opencode binary, MCP bridge, and dev vendor tree live there.
 *
 * "The app's own files" must cover the WHOLE bundle, not just Resources:
 * OpenCode spawns the MCP bridge with the app's own executable
 * (Contents/MacOS, loading Contents/Frameworks), and when the app runs from
 * a DMG mounted under /Volumes — a denied root — the bridge died at dyld
 * time, silently taking every solar game tool with it ("server
 * unavailable key=solar" in the OpenCode log). Electron startup also
 * canonicalizes its own bundle path, stat'ing each ancestor directory
 * (/Volumes, the mount root), so those need metadata-level reads too or ICU
 * init crashes before main(). Metadata only — denied directories still can't
 * be listed or read.
 */
function sandboxCommand(opencode: string, args: string[], projectPath: string): { command: string; args: string[] } {
  if (process.platform !== 'darwin') return { command: opencode, args }
  const home = homedir()
  const denyDirs = [
    app.getPath('desktop'),
    app.getPath('documents'),
    app.getPath('downloads'),
    app.getPath('music'),
    app.getPath('pictures'), // includes the Photos library
    app.getPath('videos'),
    join(home, 'Library', 'Mobile Documents'), // iCloud Drive
    join(home, 'Library', 'CloudStorage'), // Google Drive / Dropbox / OneDrive mounts
    join(home, 'Library', 'Containers'),
    join(home, 'Library', 'Group Containers'),
    join(home, '.ssh'),
    join(home, '.aws'),
    join(home, '.gnupg'),
    '/Volumes' // removable + network drives
  ]
  // The MCP bridge reads harness.json from userData, so that directory stays
  // readable — but the app's encrypted credential files stored next to it don't.
  const denyFiles = [
    join(app.getPath('userData'), 'gptimage-credentials.json'),
    join(app.getPath('userData'), 'hy3d-credentials.json'),
    join(app.getPath('userData'), 'opencode-credentials.json')
  ]
  const allowRead = [
    ...withRealpath(app.getAppPath()),
    ...withRealpath(process.resourcesPath),
    ...withRealpath(appBundleRoot()),
    dirname(opencode)
  ]
  const allowReadWrite = withRealpath(projectPath)
  // Ancestors of every allowed path (deduped), covering path canonicalization
  // through denied roots — e.g. /Volumes and the mount root for a DMG-run
  // app, or an external volume holding the project.
  const allowStat = [...new Set([...allowRead, ...allowReadWrite].flatMap(ancestorDirs))]
  const profile = [
    '(version 1)',
    '(allow default)',
    `(deny file-read* file-write* ${denyDirs.map((p) => `(subpath ${sbplPath(p)})`).join(' ')})`,
    `(deny file-read* ${denyFiles.map((p) => `(literal ${sbplPath(p)})`).join(' ')})`,
    `(allow file-read* ${allowRead.map((p) => `(subpath ${sbplPath(p)})`).join(' ')})`,
    `(allow file-read* file-write* ${allowReadWrite.map((p) => `(subpath ${sbplPath(p)})`).join(' ')})`,
    `(allow file-read-metadata ${allowStat.map((p) => `(literal ${sbplPath(p)})`).join(' ')})`
  ].join('\n')
  return { command: '/usr/bin/sandbox-exec', args: ['-p', profile, opencode, ...args] }
}

/** Kill the serve process (if any) without touching conversation state. */
function killServer(): void {
  if (server) {
    server.sseAbort.abort()
    server.proc.kill()
    server = null
  }
}

async function ensureServer(projectPath: string): Promise<OpencodeServer> {
  if (isSetupUpdating()) throw new Error('Wait for AI settings to finish saving before starting the assistant.')
  const epoch = chatEpoch
  if (serverStartup?.epoch === epoch && serverStartup.projectPath === projectPath) return serverStartup.promise
  const promise = startServer(projectPath, epoch)
  const pending = { epoch, projectPath, promise }
  serverStartup = pending
  try {
    return await promise
  } finally {
    if (serverStartup === pending) serverStartup = null
  }
}

async function startServer(projectPath: string, epoch: number): Promise<OpencodeServer> {
  const managed = getProductionEnabled()
  if (server && server.projectPath === projectPath && server.proc.exitCode === null && server.proc.signalCode === null && server.managed === managed) {
    return server
  }
  // Replace a dead or wrong-project server process — but never reset the
  // conversation here: sessions live in OpenCode's storage, not the process,
  // and a session restored from saved chat history must survive its own
  // first send (which is what spawns the server).
  killServer()

  const opencode = await resolveOpencode()
  if (!opencode) {
    throw new Error(
      'The bundled OpenCode assistant is missing. Reinstall Solar, or run `npm run setup` in development.'
    )
  }

  const port = await getFreePort()
  // The MCP bridge inherits this env through OpenCode, so the game-test tools
  // reach THIS app instance even when several Solar instances are running
  // (harness.json alone is shared and only names whichever registered last).
  const harness = getHarnessEndpoint()
  // Same multi-instance problem one level up: the global config's
  // mcp.solar command names the binary of whichever instance STARTED
  // last, which this instance's sandbox usually can't read (and which is gone
  // entirely once its DMG is ejected). OPENCODE_CONFIG_CONTENT merges over
  // the file config at server startup — objects merge, arrays replace — so
  // the spawned server always runs this instance's own bridge while the
  // user's other config keys survive.
  const mcpEntry = solarMcpEntry()
  // Keep app-managed API keys out of OpenCode's shared plaintext auth.json.
  // The child receives the keys in its environment and a per-process config
  // references them by variable name; the global config and other OpenCode
  // installs remain untouched.
  const providerAuth = await runtimeSetupAuth()
  if (epoch !== chatEpoch) throw new Error('Assistant startup was cancelled.')
  // The app-owned build rules ride the same per-spawn override. `instructions`
  // is the one config key whose arrays concatenate across layers instead of
  // replacing, so this adds to whatever the user configured globally.
  const instructions = managed ? join(app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath(), 'resources/production-agent-instructions.md') : await agentInstructionsPath()
  const nativeSkills = await prepareNativeGameSkills()
  const productionSkills = managed ? await prepareProductionSkills() : null
  if (epoch !== chatEpoch) throw new Error('Assistant startup was cancelled.')
  const configContent = {
    ...(Object.keys(providerAuth.config).length ? { provider: providerAuth.config } : {}),
    ...(mcpEntry ? { mcp: { solar: mcpEntry } } : {}),
    plugin: [solarSkillsPlugin()],
    tools: { skill: true },
    ...(managed ? { agent: controlledAgentConfig(), compaction: { auto: false, prune: false }, experimental: { continue_loop_on_deny: false } } : {}),
    ...(instructions ? { instructions: [instructions] } : {})
  }
  const { command, args } = sandboxCommand(
    opencode,
    ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
    projectPath
  )
  const proc = spawn(command, args, {
    cwd: projectPath,
    // PWD must match cwd — OpenCode trusts the logical PWD for its project
    // directory (see the run-mode bug this fixed in git history).
    // OPENCODE_ENABLE_EXA registers the websearch tool (hosted Exa/Parallel
    // search, no API key needed) — without it, OpenCode only offers webfetch.
    env: {
      ...process.env,
      ...providerAuth.environment,
      PWD: projectPath,
      NO_COLOR: '1',
      OPENCODE_ENABLE_EXA: '1',
      SOLAR_PROJECT_PATH: projectPath,
      SOLAR_NATIVE_SKILLS_PATH: nativeSkills.path,
      SOLAR_EXECUTION_POLICY:productionPolicyPath(),
      ...(managed ? { SOLAR_EXECUTION_MODE: 'microsoft', SOLAR_PRODUCTION_SKILLS_PATH: productionSkills!.path } : {SOLAR_EXECUTION_MODE:'legacy'}),
      ...(harness
        ? { SOLAR_HARNESS_PORT: String(harness.port), SOLAR_HARNESS_TOKEN: harness.token }
        : {}),
      ...(Object.keys(configContent).length
        ? { OPENCODE_CONFIG_CONTENT: JSON.stringify(configContent) }
        : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const srv: OpencodeServer = {
    proc,
    base: `http://127.0.0.1:${port}`,
    projectPath,
    stderrTail: '',
    sseAbort: new AbortController()
  }
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (chunk: string) => {
    srv.stderrTail = (srv.stderrTail + chunk).slice(-2000)
  })
  proc.once('exit', () => {
    if (server === srv) server = null
  })
  proc.once('error', (error) => { srv.startupError = error })
  // Register the starting process so project switches can stop it before health succeeds.
  server = srv
  srv.managed = managed
  try {
    await waitForHealth(srv)
    if (epoch !== chatEpoch || server !== srv) throw new Error('Assistant startup was cancelled.')
    const discovered = await api<{ name: string; location: string }[]>(srv, 'GET', '/skill', undefined, { timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024 })
    if (epoch !== chatEpoch || server !== srv) throw new Error('Assistant startup was cancelled.')
    const registryMatches = (bundle: typeof nativeSkills, name: string): boolean => {
      const matches = Array.isArray(discovered) ? discovered.filter(entry => entry?.name === name) : []
      return matches.length === 1 && typeof matches[0].location === 'string' && resolve(matches[0].location) === resolve(bundle.path, name, 'SKILL.md')
    }
    const ownNames = new Set(nativeSkills.names.filter(name => registryMatches(nativeSkills, name)))
    const missing = nativeSkills.names.filter((name) => !ownNames.has(name))
    if (missing.length) throw new Error(`OpenCode could not discover ${missing.length} of Solar's ${nativeSkills.names.length} native skills. Restart Solar or restore its skill bundle.`)
    if (productionSkills) {
      const extra = new Set(productionSkills.names.filter(name => registryMatches(productionSkills, name)))
      if (productionSkills.names.some(name => !extra.has(name))) throw new Error('Microsoft production skills were not registered.')
    }
  } catch (err) {
    srv.sseAbort.abort()
    proc.kill()
    if (server === srv) server = null
    throw err
  }
  pumpEvents(srv)
  return srv
}

/** API failure carrying the HTTP status, so callers can tell 404 from flake. */
class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

/**
 * API call via node:http with explicit deadlines. Message POSTs may span many
 * model/tool rounds; control requests use a shorter default deadline.
 */
function api<T>(srv: OpencodeServer, method: string, path: string, body?: unknown, limits: { timeoutMs: number; maxBytes: number; signal?: AbortSignal } = {timeoutMs:30_000,maxBytes:8*1024*1024}): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${srv.base}${path}`,
      { method, headers: { 'content-type': 'application/json' }, timeout: 0 },
      (res) => {
        res.setEncoding('utf8')
        let data = ''
        let bytes = 0
        res.on('data', (chunk: string) => {
          bytes += Buffer.byteLength(chunk)
          if (limits && bytes > limits.maxBytes) { req.destroy(new Error(`OpenCode API ${path} exceeds its response limit.`)); return }
          data += chunk
        })
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(
              new ApiError(
                `OpenCode API ${method} ${path} failed (${res.statusCode}): ${data.slice(0, 300)}`,
                res.statusCode
              )
            )
            return
          }
          if (!data.trim()) { reject(new ApiError(`PRODUCTION_TRANSIENT: OpenCode API ${method} ${path} returned an empty response.`)); return }
          try {
            resolve(JSON.parse(data) as T)
          } catch {
            reject(new Error(`OpenCode API ${method} ${path}: invalid JSON response`))
          }
        })
        res.on('error', reject)
      }
    )
    req.on('error', reject)
    if (limits?.signal) {
      const abort = (): void => { req.destroy(limits.signal?.reason instanceof Error ? limits.signal.reason : new Error('Managed executor cancelled.')) }
      if (limits.signal.aborted) abort()
      else limits.signal.addEventListener('abort', abort, { once: true })
      req.once('close', () => limits.signal?.removeEventListener('abort', abort))
    }
    if (limits) {
      const timer = setTimeout(() => req.destroy(new Error(`OpenCode API ${path} timed out.`)), limits.timeoutMs)
      req.once('close', () => clearTimeout(timer))
    }
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

/**
 * The most common first-run failure is a configured model whose provider has
 * no credentials (OpenCode then 500s with an opaque "UnknownError"). Check
 * proactively — the chat model and the subagents' image model, each of which may use its own
 * provider — and explain exactly how to fix it.
 */
async function assertProviderAvailable(srv: OpencodeServer): Promise<void> {
  if (srv.providerChecked) return
  let missing: string | null = null
  try {
    const config = await api<{ model?: string; agent?: Record<string, { model?: string }> }>(
      srv,
      'GET',
      '/config'
    )
    const wanted = new Set<string>()
    for (const ref of [config.model, ...Object.values(config.agent ?? {}).map((a) => a?.model)]) {
      if (typeof ref === 'string' && ref.includes('/')) wanted.add(ref.split('/')[0])
    }
    wanted.add((await resolveChatModel()).providerID)
    if (wanted.size) {
      const list = await api<{ providers: { id: string }[] }>(srv, 'GET', '/config/providers')
      const available = new Set(list.providers.map((p) => p.id))
      missing = [...wanted].find((id) => !available.has(id)) ?? null
    }
  } catch {
    return // Introspection failed — don't block the chat on it.
  }
  if (missing) {
    // The settings panel writes keys for every provider we configure
    // (including the `custom`/`image` openai-compatible ones, which
    // `opencode auth login` has no named entry for) — point users there.
    throw new Error(
      `The AI provider "${missing}" isn't connected yet — its API key is missing.\n\n` +
        `Open the AI settings (gear icon in the sidebar) and add the API key for its endpoint, then try again.`
    )
  }
  srv.providerChecked = true
}

/**
 * Whether a saved session id no longer exists on the server. Only an explicit
 * 404/410 counts: forgetting the session on ANY failure (as this used to do)
 * silently forked the conversation into a fresh context-less session whenever
 * the GET merely flaked, which users experienced as the assistant "losing its
 * memory" after reopening a project. Transient failures are retried, then
 * surfaced as a send error — the user can retry with the session intact.
 */
async function sessionGone(srv: OpencodeServer, id: string, signal?: AbortSignal): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await api(srv, 'GET', `/session/${id}`,undefined,{signal,timeoutMs:5000,maxBytes:256*1024})
      return false
    } catch (err) {
      signal?.throwIfAborted()
      if (err instanceof ApiError && (err.status === 404 || err.status === 410)) return true
      if (attempt >= 2) {
        throw new Error(
          `Could not verify the saved conversation (${err instanceof Error ? err.message : err}). Try again.`
        )
      }
      await new Promise((r) => setTimeout(r, 300))
    }
  }
}

/** First actual use of a session id restored from saved chat history: drop it if the server no longer has it. */
async function verifyRestoredSession(srv: OpencodeServer, signal?: AbortSignal): Promise<void> {
  if (sessionID && sessionRestored) {
    const id = sessionID
    const epoch = chatEpoch
    const gone = await sessionGone(srv, id, signal)
    if (epoch !== chatEpoch || sessionID !== id) return
    sessionRestored = false
    if (gone) sessionID = null
  }
}

/**
 * Provider errors that mean the accumulated conversation no longer fits the
 * model's context window (observed: "Input length 202850 exceeds the maximum
 * allowed input length of 202720 tokens"; also matches the OpenAI/Anthropic
 * phrasings). Once a session hits this, EVERY further send into it fails the
 * same way — the only way forward is a fresh session, re-seeded with a recap.
 */
const CONTEXT_OVERFLOW_RE =
  /context[_ -]?(length|window)|maximum (allowed )?(input|context|prompt)|input (length|is )?too long|prompt is too long|input length \d+ exceeds|too many (total )?(text bytes|input tokens)/i

/**
 * A server read can be retried without replaying a provider message. Keep
 * the saved session intact until the server explicitly confirms its absence.
 */
/** Retry only server setup and reads, never an unreconciled message or write. */
async function reconnectRead<T>(projectPath: string, operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let since = 0
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    try {
      const result = await operation()
      if (since) publishChatConnection({projectPath,source:'server',status:'connected',message:'Assistant reconnected. Continuing saved work.'})
      return result
    } catch (error) {
      if (signal.aborted || !isConnectionFailure(error)) throw error
      since ||= Date.now()
      const delay = connectionRetryDelay(attempt)
      if (attempt + 1 >= CONNECTION_RECOVERY.attempts || Date.now() - since + delay >= CONNECTION_RECOVERY.windowMs) throw new Error('The connection is still unavailable. Your conversation is saved; continue when the server is available.')
      publishChatConnection({projectPath,source:'server',status:'reconnecting',attempt:attempt+2,maxAttempts:CONNECTION_RECOVERY.attempts,nextAttemptAt:new Date(Date.now()+delay).toISOString(),message:'Reconnecting to the assistant server…'})
      await connectionWait(delay, signal)
    }
  }
}

let messageCounter = 0
function messageIdentifier(): string {
  const time = (BigInt(Date.now()) * 4096n + BigInt(++messageCounter % 4096)) & 0xffffffffffffn
  return 'msg_' + time.toString(16).padStart(12,'0') + randomBytes(7).toString('hex')
}

/** Reattach to accepted work after losing a POST response; never replay it blind. */
async function recoverChatResponse(projectPath: string, id: string, messageId: string, signal: AbortSignal): Promise<{ srv: OpencodeServer; reply?: any; accepted: boolean }> {
  let srv = await reconnectRead(projectPath, () => ensureServer(projectPath).then(async candidate => { await api(candidate,'GET',`/session/${id}`,undefined,{signal,timeoutMs:5000,maxBytes:256*1024}); return candidate }), signal)
  publishChatConnection({projectPath,source:'server',status:'connected',message:'Assistant reconnected. Recovering the saved response.'})
  const started = Date.now()
  for (;;) {
    signal.throwIfAborted()
    const statuses = await reconnectRead(projectPath, async () => { srv = await ensureServer(projectPath); return api<Record<string,{type:string}>>(srv,'GET','/session/status',undefined,{signal,timeoutMs:5000,maxBytes:256*1024}) },signal)
    const active = statuses[id]?.type === 'busy' || statuses[id]?.type === 'retry'
    if (active && Date.now()-Math.max(started,chatActivity?.lastProgress??0)<CONNECTION_RECOVERY.idleMs) { await connectionWait(1000,signal); continue }
    const entries = await reconnectRead(projectPath, async () => { srv=await ensureServer(projectPath); return api<any[]>(srv,'GET',`/session/${id}/message`,undefined,{signal,timeoutMs:15000,maxBytes:8*1024*1024}) },signal)
    const accepted = entries.some(entry=>entry.info?.role==='user' && entry.info.id===messageId)
    const responses = entries.filter(entry=>entry.info?.role==='assistant' && entry.info.sessionID===id && entry.info.parentID===messageId)
    const latest = responses.sort((a,b)=>String(b.info.id).localeCompare(String(a.info.id)))[0]
    if (latest?.info?.time?.completed && (latest.info.error || ['stop','end-turn','length'].includes(latest.info.finish))) return {srv,reply:latest,accepted}
    const interruptedWrite = responses.some(entry=>entry.parts?.some((part:any)=>part.type==='tool' && ['pending','running'].includes(part.state?.status) && !['read','glob','grep','list','webfetch','websearch','skill','solar_game_guidance','solar_production_guidance'].includes(part.tool)))
    // Abort acknowledgement reconciles a stopped/queued loop before any resume.
    await api(srv,'POST',`/session/${id}/abort`,{}, {signal,timeoutMs:15000,maxBytes:4096})
    if (interruptedWrite) throw new Error('An interrupted write needs reconciliation. Inspect its recorded work before continuing; it will not be replayed automatically.')
    // Re-read after abort acknowledgement: the POST might have landed between
    // the earlier lookup and cancellation. Only explicit absence permits replay.
    try {
      const stored = await api<{info?:{role?:string;sessionID?:string;id?:string}}>(srv,'GET',`/session/${id}/message/${messageId}`,undefined,{signal,timeoutMs:5000,maxBytes:8*1024*1024})
      if (stored.info?.role!=='user' || stored.info.id!==messageId || stored.info.sessionID!==id) throw new Error('The interrupted request could not be reconciled with its saved conversation.')
      return {srv,accepted:true}
    } catch (error) {
      if (error instanceof ApiError && [404,410].includes(error.status??0) && !accepted) return {srv,accepted:false}
      throw error
    }
  }
}

/** Stop a silent HTTP request, then reconcile its persisted work before retry. */
async function chatResponse(srv: OpencodeServer, id: string, body: unknown, signal: AbortSignal): Promise<any> {
  const request = new AbortController()
  const timer = setInterval(() => {
    const activity = chatActivity
    if (activity?.sessionId===id && !activity.tools.size && !activity.questions.size && Date.now()-activity.lastProgress>=CONNECTION_RECOVERY.idleMs) request.abort(new Error('PRODUCTION_TRANSIENT: The provider stopped responding. Recovering the saved conversation.'))
  },1000)
  timer.unref()
  try {
    const reply = await api<any>(srv,'POST',`/session/${id}/message`,body,{signal:AbortSignal.any([signal,request.signal]),timeoutMs:30*60_000,maxBytes:8*1024*1024})
    if (!reply?.info) throw new Error('PRODUCTION_TRANSIENT: The assistant returned no response. Recovering the saved turn.')
    return reply
  }
  finally { clearInterval(timer) }
}

/** Turn provider authentication failures into an actionable, secret-free UI message. */
function providerAuthRecovery(detail: string, providerId: string): string | null {
  if (!/(?:\bHTTP\s*)?(?:401|403)\b|authorization failed|forbidden|invalid api key|invalid token/i.test(detail)) return null
  const provider = providerId.toLowerCase().includes('nvidia') ? 'NVIDIA'
    : providerId.toLowerCase().includes('openrouter') ? 'OpenRouter'
      : providerId.toLowerCase().includes('anthropic') ? 'Anthropic'
        : providerId.toLowerCase().includes('gemini') || providerId.toLowerCase().includes('google') ? 'Google Gemini'
          : providerId.toLowerCase().includes('xai') ? 'xAI'
            : providerId.toLowerCase().includes('openai') ? 'OpenAI' : 'The selected provider'
  return `${provider} rejected the saved API key (HTTP 401/403). Open AI Settings, enter a fresh key for ${provider}, use Check & load, then retry.`
}

/**
 * What the model sees when its turn is resumed after a transient provider
 * error. A user-role message, like the recap: the renderer never displays
 * user-message echoes, so the user sees one seamless turn.
 */
const RESUME_NUDGE =
  '[Your previous response was cut off by a temporary provider error, not by the user. ' +
  'Continue exactly where you left off — do not restart the task or repeat work that already completed.]'

/**
 * Validates and kicks off a chat turn. Resolves as soon as the request is
 * accepted; progress streams via chat:part events and completion (or failure)
 * arrives as a chat:done event when the blocking POST returns.
 *
 * `isRetry` marks the internal second attempt after a context-overflow
 * rollover: it keeps the turn claimed (busy stays true, so the renderer sees
 * one seamless turn) and must never recurse again.
 */
export async function sendChatMessage(
  message: string,
  projectPath: string,
  attachments: ChatAttachment[] = [],
  isRetry = false
): Promise<void> {
  const epoch = chatEpoch
  const isCurrent = (): boolean => epoch === chatEpoch
  if (!isRetry) {
    if (isSetupUpdating()) throw new Error('Wait for AI settings to finish saving before sending a message.')
    if (busy) throw new Error('A response is already in progress')
    // Claim the turn before the first await — two rapid sends could otherwise
    // both pass the guard above while the first was still starting its server.
    busy = true
    cancelled = false
    chatController = new AbortController()
  }
  const run = isRetry ? getActiveAgentRun(projectPath) : startAgentRun(projectPath)

  let srv: OpencodeServer
  let uploaded: SavedUpload[] = []
  let recap: string | null = null
  try {
    run?.starting()
    const startupStarted = Date.now()
    srv = await reconnectRead(projectPath,()=>ensureServer(projectPath),chatController.signal)
    run?.startup(Date.now() - startupStarted)
    if (!isCurrent()) return
    await assertProviderAvailable(srv)
    if (!isCurrent()) return
    // A session restored from a saved chat continues that conversation (OpenCode
    // persists sessions per directory) — verified against the server the first
    // time it is actually used.
    await reconnectRead(projectPath,async()=>{srv=await ensureServer(projectPath);await verifyRestoredSession(srv,chatController.signal)},chatController.signal)
    if (!isCurrent()) return
    if (!sessionID) {
      // Starting a fresh session while the project still has a saved
      // transcript (stale/lost session id, or the context-overflow rollover
      // below): seed it with a recap of that transcript. The chat window and
      // the model must not diverge — this is what carries the conversation
      // the user can see back into the new OpenCode session. After /clear
      // there is no saved transcript, so a cleared chat correctly starts raw.
      recap = await loadTranscriptRecap(projectPath).catch(() => null)
      if (!isCurrent()) return
      const session = await reconnectRead(projectPath, async () => {
        srv = await ensureServer(projectPath)
        return api<{ id: string }>(srv, 'POST', '/session', {}, {signal:chatController.signal,timeoutMs:30_000,maxBytes:4096})
      },chatController.signal)
      if (!isCurrent()) return
      sessionID = session.id
    }
    // Asset uploads (zips, folders, models…) are copied into the project's
    // .solar/attachments/ — the only place the sandboxed assistant can
    // reach them. Unlike the best-effort image saving below, a failure here
    // fails the whole send: the message must not describe files that never
    // arrived. The error text is user-readable (caps, unreadable source).
    // Copied after the session checks so a failed verify can't duplicate them.
    uploaded = await saveChatUploads(projectPath, attachments.filter((a) => a.path))
  } catch (err) {
    if (!isCurrent()) return
    run?.finish(cancelled ? 'cancelled' : 'failed')
    busy = false
    if (cancelled) {
      sendToRenderer('chat:done', { ok: false, cancelled: true })
      return
    }
    throw err
  }

  // The stop button can be pressed while OpenCode is still starting or while
  // the saved session is being restored. At that point there may be no
  // session ID to abort yet; honor the cancellation before sending a turn.
  if (!isCurrent()) return
  if (cancelled) {
    run?.finish('cancelled')
    busy = false
    sendToRenderer('chat:done', { ok: false, cancelled: true })
    return
  }

  // Parts of finished turns are final — only the live turn needs delta state.
  partCache.clear()
  const currentSession = sessionID
  // The chat model for this turn, resolved now so a mid-turn settings save
  // can't split one turn across models (the resume nudges reuse it too).
  let model: Awaited<ReturnType<typeof resolveChatModel>>
  try {
    model = await resolveChatModel()
  } catch (err) {
    if (!isCurrent()) return
    run?.finish(cancelled ? 'cancelled' : 'failed')
    busy = false
    if (cancelled) {
      sendToRenderer('chat:done', { ok: false, cancelled: true })
      return
    }
    throw err
  }

  // Image attachments are additionally saved under .solar/attachments/
  // and their paths appended to the message: the main coding model may not
  // accept image input (OpenCode then replaces the file parts below with an
  // "ERROR: Cannot read" note), and the image-enabled subagents can only
  // reach an image through a file path. Best-effort — a failed save just
  // means the message goes out the old way.
  // The recap rides inside this message rather than as its own turn: a
  // separate priming message would cost a full model round-trip. The renderer
  // shows its own copy of the user text, so the recap never appears in the UI.
  let text = recap ? `${recap}\n\n${message}` : message
  try {
    const continuation=/^(?:continue(?: where you left off)?\.?|devam(?: et)?\.?|resume)\s*$/i.test(message.trim())
    if(!continuation||legacySelection?.projectPath!==projectPath) {
      const snapshot=await snapshotProject(projectPath,{signal:chatController.signal})
      const policy=projectTaskSelection(snapshot,message)
      const selected=await selectProductionSkills([],policy)
      legacySelection={projectPath,request:message,policy,skills:developerTaskSkills(selected.names,policy)}
    }
    if(!isCurrent())return
    await registerLegacySession(currentSession!,run!.identity.runId,projectPath,legacySelection!.skills,legacySelection!.policy)
    const provided=await selectedSkillContext(legacySelection!.skills,[await prepareNativeGameSkills()],chatController.signal)
    text+=`\n\n[Complete, hash-verified Solar task references. Native skill calls are optional for these already supplied documents.]\n${provided.context}`
    text+=`\n\n[Solar task selection policy: ${JSON.stringify(legacySelection!.policy)}. Assigned skills: ${legacySelection!.skills.join(', ')}. Load only these native guides. Library asset imports require an exact asset_library recommend result for this task, including its hash and preset; do not guess resource paths or copy whole packs. studio/master/router guides cannot delegate. Only configured image-reader and game-tester helpers may assist regular chat; Microsoft mode owns production agent routing.]`
  } catch(error) {
    if(!isCurrent())return
    await unregisterLegacySession(currentSession!).catch(()=>{})
    busy=false;run?.finish(cancelled?'cancelled':'failed')
    if(cancelled){sendToRenderer('chat:done',{ok:false,cancelled:true});return}
    throw error
  }
  if (run) text += `\n\n[Solar task: runId=${run.identity.runId}, taskRevision=${run.identity.taskRevision}. Call project_validate after editing saved scripts/scenes when verification is permitted. A static pass does not verify gameplay.]`
  const images = attachments.filter((a) => a.dataUrl && a.mime.startsWith('image/'))
  if (images.length) {
    const saved = await saveChatAttachments(projectPath, images).catch(() => [] as string[])
    if (saved.length) {
      text +=
        `\n\n[The attached image${saved.length > 1 ? 's are' : ' is'} also saved at: ` +
        `${saved.join(', ')} — if you cannot view images yourself, delegate to the ` +
        `image-reader subagent with the path${saved.length > 1 ? 's' : ''}.]`
    }
  }
  // Asset uploads reach the model as paths only (copied above) — a zip or a
  // 40 MB GLB as a base64 message part would be useless to it. The note also
  // spells out the .solar/ catch: Godot ignores that directory, so assets
  // must be copied into the game tree to be usable.
  if (uploaded.length) {
    const list = uploaded.map((u) => (u.dir ? `${u.rel}/ (folder)` : u.rel)).join(', ')
    text +=
      `\n\n[The user uploaded asset file${uploaded.length > 1 ? 's' : ''} with this message, ` +
      `saved in the project at: ${list}. Explore what's inside — extract any .zip first ` +
      '(e.g. `unzip -o <file>.zip -d <folder>`). Everything under .solar/ is invisible ' +
      'to Godot, so copy the files the game needs into the proper assets/ sub-folders ' +
      'before wiring them into scenes.]'
  }

  // Inline attachments travel as data-URL file parts in the message itself —
  // they reach the model directly when it supports image input.
  const parts: unknown[] = attachments
    .filter((a) => a.dataUrl)
    .map((a) => ({
      type: 'file',
      mime: a.mime,
      filename: a.name,
      url: a.dataUrl
    }))
  parts.push({ type: 'text', text })

  // Attachment saving is asynchronous too. A cancellation during that work
  // must not fall through and start the provider request afterward.
  if (!isCurrent()) return
  if (cancelled) {
    run?.finish('cancelled')
    busy = false
    sendToRenderer('chat:done', { ok: false, cancelled: true })
    return
  }

  void (async () => {
    // Set when the turn died to context overflow and a rollover retry should
    // run: the retry happens in `finally` so this attempt's api/renderer work
    // is fully settled first, and `busy` stays claimed across the handoff so
    // the renderer experiences one seamless turn.
    let retryInFreshSession = false
    chatActivity = {sessionId:currentSession!,lastProgress:Date.now(),tools:new Set(),questions:new Set()}
    try {
      /* eslint-disable @typescript-eslint/no-explicit-any -- untyped server reply */
      const turnError = (reply: any): string | null => {
        const error = reply?.info?.error
        return error ? String(error?.data?.message || error?.name || JSON.stringify(error)) : null
      }
      // A transient backend failure can stop the agent
      // loop mid-turn, but everything up to it — applied edits, tool results —
      // is safely in the session. Resume the same session with a nudge rather
      // than surfacing the error: re-sending the user message would duplicate
      // it, and a fresh session would orphan the completed work. Bounded, so
      // a prolonged outage eventually pauses at the reconnect window.
      let reply: any, requestId = messageIdentifier(), requestParts = parts, recoveryStarted = 0
      for (let attempt = 0; ; attempt++) {
        if (!isCurrent()) return
        const requestStarted = Date.now()
        run?.requesting()
        if (chatActivity) chatActivity.lastProgress=Date.now()
        try {
          try {
            reply = await chatResponse(srv,currentSession!,{messageID:requestId,model,parts:requestParts},chatController.signal)
          } catch (error) {
            if (chatController.signal.aborted || !isConnectionFailure(error)) throw error
            publishChatConnection({projectPath,source:'server',status:'reconnecting',message:'Reconnecting to the assistant. Recovering this turn…'})
            const recovered = await recoverChatResponse(projectPath,currentSession!,requestId,chatController.signal)
            srv = recovered.srv
            if (recovered.reply) reply = recovered.reply
            else {
              if (recovered.accepted) { requestId=messageIdentifier(); requestParts=[{type:'text',text:RESUME_NUDGE}] }
              reply = { info:{error:{data:{message:'PRODUCTION_TRANSIENT: The interrupted response is ready to resume.'}}} }
            }
          }
        } finally { run?.request(Date.now() - requestStarted) }
        if (!isCurrent()) return
        run?.providerUsage(reply?.info?.id, reply?.info?.tokens, reply?.info?.cost)
        const detail = turnError(reply)
        if (detail && isConnectionFailure(detail) && (reply?.parts??[]).some((part:any)=>part.type==='tool' && ['pending','running'].includes(part.state?.status) && !['read','glob','grep','list','webfetch','websearch','skill','solar_game_guidance','solar_production_guidance'].includes(part.tool))) {
          throw new Error('An interrupted write needs reconciliation. Inspect its recorded work before continuing; it will not be replayed automatically.')
        }
        if (
          detail === null ||
          !isConnectionFailure(detail) ||
          attempt + 1 >= CONNECTION_RECOVERY.attempts ||
          cancelled
        ) {
          break
        }
        recoveryStarted ||= Date.now()
        const delay = connectionRetryDelay(attempt)
        if (Date.now() - recoveryStarted + delay >= CONNECTION_RECOVERY.windowMs) break
        publishChatConnection({projectPath,source:'provider',status:'reconnecting',attempt:attempt+2,maxAttempts:CONNECTION_RECOVERY.attempts,nextAttemptAt:new Date(Date.now()+delay).toISOString(),message:'Reconnecting to the AI provider. Your work is preserved…'})
        run?.retry('provider')
        // Known provider errors ended the loop; resume its persisted work.
        if (reply?.info?.id) { requestId=messageIdentifier(); requestParts=[{type:'text',text:RESUME_NUDGE}] }
        await connectionWait(delay,chatController.signal)
        if (cancelled) break
      }
      const detail = turnError(reply)
      if (detail === null) publishChatConnection({projectPath,source:'provider',status:'connected',message:'AI connection restored.'})
      /* eslint-enable @typescript-eslint/no-explicit-any */
      // The conversation no longer fits the model's context window; nothing
      // sent into this session can ever succeed again. Roll over: next
      // session starts fresh and loadTranscriptRecap carries the visible
      // conversation into it. Without this, users were stuck resending into
      // a permanently failing session until they gave up and lost context.
      if (detail !== null && CONTEXT_OVERFLOW_RE.test(detail)) {
        sessionID = null
        if (!isRetry && !cancelled) {
          run?.retry('context')
          retryInFreshSession = true
          return
        }
      }
      // Re-send the final parts: guarantees the full text is present even if
      // the last SSE frames raced the POST response.
      for (const part of reply?.parts ?? []) {
        const update = translatePart(part)
        if ((update?.kind === 'text' || update?.kind === 'reasoning') && update.text) run?.response()
        if (update) sendToRenderer('chat:part', update)
      }
      if (cancelled) {
        run?.finish('cancelled')
        sendToRenderer('chat:done', { ok: false, cancelled: true })
      } else if (detail !== null) {
        run?.finish('failed')
        const authRecovery = providerAuthRecovery(detail, model.providerID)
        sendToRenderer('chat:done', {
          ok: false,
          recoverable: isConnectionFailure(detail),
          error: CONTEXT_OVERFLOW_RE.test(detail)
            ? `This message is too large for the model's context window even in a fresh session — ` +
              `try a shorter message or smaller attachments. (${detail})`
            : authRecovery ?? (isConnectionFailure(detail) ? 'The AI connection is still unavailable after automatic reconnect attempts. Your conversation and completed work are saved; continue when the provider is available.' : detail)
        })
      } else {
        run?.finish('response_completed')
        sendToRenderer('chat:done', { ok: true })
      }
    } catch (err) {
      if (!isCurrent()) return
      run?.finish(cancelled ? 'cancelled' : 'failed')
      const detail = err instanceof Error ? err.message : String(err)
      // Overflow surfaced as a failed request rather than an errored reply:
      // still roll over so the NEXT send starts a recap-seeded session, but
      // don't auto-retry — the POST may have half-landed, and a duplicate
      // user message is worse than asking for a resend.
      if (CONTEXT_OVERFLOW_RE.test(detail)) sessionID = null
      const authRecovery = providerAuthRecovery(detail, model.providerID)
      sendToRenderer('chat:done', {
        ok: false,
        cancelled,
        recoverable: !cancelled && isConnectionFailure(err),
        error: cancelled ? undefined : authRecovery ?? detail
      })
    } finally {
      if (!isCurrent()) return
      chatActivity=null
      await unregisterLegacySession(currentSession!).catch(()=>{})
      if (retryInFreshSession) {
        void sendChatMessage(message, projectPath, attachments, true).catch((err) => {
          if (!isCurrent()) return
          // The retry failed before its own turn could report — close out the
          // renderer's pending turn here or the chat would spin forever.
          sendToRenderer('chat:done', {
            ok: false,
            error: err instanceof Error ? err.message : String(err)
          })
          busy = false
        })
      } else {
        busy = false
        clearChatConnection(projectPath)
      }
    }
  })()
}

export function cancelChat(): void {
  if (!busy) return
  // Always latch cancellation. Server startup/session creation can still be
  // in flight, in which case there is nothing to POST /abort yet.
  cancelled = true
  chatController.abort()
  if(sessionID)void unregisterLegacySession(sessionID).catch(()=>{})
  getActiveAgentRun()?.finish('cancelled')
  if (server && sessionID) {
    void fetch(`${server.base}/session/${sessionID}/abort`, { method: 'POST' }).catch(() => {})
  }
}

/*
 * /undo and /redo — OpenCode's native session revert. Reverting to a user
 * message hides that turn and everything after it from the model AND restores
 * the project files to the snapshot OpenCode took before the turn ran;
 * unrevert restores the pre-revert state (the revert record keeps its own
 * snapshot for that). The revert point lives on the session, so it survives
 * app restarts — but sending a new message makes the pending revert permanent
 * (OpenCode trims the reverted messages), which is why redo availability is
 * additionally tracked renderer-side.
 */

/**
 * The session's real user turns (message ids, ascending). Excludes the
 * synthetic user-role prompts this module injects (RESUME_NUDGE, sent to
 * resume a turn after a transient provider error): those belong to the turn
 * of the real user message before them, so a revert must never target one —
 * it would restore half a turn.
 */
async function listUserTurns(srv: OpencodeServer, session: string): Promise<string[]> {
  /* eslint-disable @typescript-eslint/no-explicit-any -- untyped server JSON */
  const entries = await api<any[]>(srv, 'GET', `/session/${session}/message`)
  const ids: string[] = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    const info = entry?.info
    if (info?.role !== 'user' || typeof info.id !== 'string') continue
    const parts = Array.isArray(entry.parts) ? entry.parts : []
    if (parts.some((p: any) => p?.type === 'text' && p.text === RESUME_NUDGE)) continue
    ids.push(info.id)
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return ids.sort()
}

/** The session's pending revert point, if any (set by a previous undo). */
async function revertPoint(srv: OpencodeServer, session: string): Promise<string | null> {
  const info = await api<{ revert?: { messageID?: string } }>(srv, 'GET', `/session/${session}`)
  return info.revert?.messageID ?? null
}

/**
 * The session undo/redo operate on, or null when there is no conversation
 * (no session yet, or the saved id is gone from the server). Never creates a
 * session — unlike a send, an undo must not open a fresh conversation.
 */
async function activeSession(projectPath: string): Promise<{ srv: OpencodeServer; session: string } | null> {
  if (!sessionID) return null
  const srv = await ensureServer(projectPath)
  await verifyRestoredSession(srv)
  return sessionID ? { srv, session: sessionID } : null
}

/** Wait for an aborted turn to settle (release `busy`) before reverting under it. */
async function waitForIdle(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (busy && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  return !busy
}

/**
 * /undo: revert the conversation to just before its most recent user turn
 * (or one turn further back on repeat), restoring the files that turn
 * touched. Returns the reverted-to message id so the renderer can drop the
 * matching turns from its own transcript — the renderer's assistant message
 * ids ARE OpenCode message ids, which is what makes that mapping possible.
 */
export async function undoChat(projectPath: string): Promise<{ revertedTo: string }> {
  const epoch = chatEpoch
  // Undoing a turn that is still streaming aborts it first (matching the
  // native TUI), then reverts once the in-flight POST has settled.
  if (busy) {
    cancelChat()
    if (!(await waitForIdle(8000))) {
      throw new Error('Could not stop the current response — press Stop, then try again.')
    }
  }
  if (epoch !== chatEpoch) throw new Error('The conversation changed before undo completed.')
  if (busy) throw new Error('A response is already in progress')
  busy = true // hold the turn so a racing send can't interleave with the revert
  try {
    const active = await activeSession(projectPath)
    if (epoch !== chatEpoch) throw new Error('The conversation changed before undo completed.')
    if (!active) throw new Error('Nothing to undo.')
    const { srv, session } = active
    const point = await revertPoint(srv, session)
    const target = (await listUserTurns(srv, session)).filter((id) => !point || id < point).pop()
    if (!target) throw new Error('Nothing to undo.')
    await api(srv, 'POST', `/session/${session}/revert`, { messageID: target })
    return { revertedTo: target }
  } finally {
    if (epoch === chatEpoch) busy = false
  }
}

/**
 * /redo: step the revert point forward one user turn, or fully restore the
 * conversation and files once the newest undone turn is reached (unrevert).
 */
export async function redoChat(projectPath: string): Promise<void> {
  if (busy) throw new Error('A response is already in progress')
  const epoch = chatEpoch
  busy = true
  try {
    const active = await activeSession(projectPath)
    if (epoch !== chatEpoch) throw new Error('The conversation changed before redo completed.')
    if (!active) throw new Error('Nothing to redo.')
    const { srv, session } = active
    const point = await revertPoint(srv, session)
    if (!point) throw new Error('Nothing to redo.')
    const next = (await listUserTurns(srv, session)).find((id) => id > point)
    if (next) await api(srv, 'POST', `/session/${session}/revert`, { messageID: next })
    else await api(srv, 'POST', `/session/${session}/unrevert`, {})
  } finally {
    if (epoch === chatEpoch) busy = false
  }
}

/**
 * A request is owned by whichever question-API generation created it, and the
 * event doesn't say which — answer via the v1 route, falling back to v2.
 */
async function questionAction(requestID: string, action: 'reply' | 'reject', body: unknown): Promise<void> {
  if (!server) throw new Error('The assistant is not running.')
  const srv = server
  const id = sessionID
  try {
    await api(srv, 'POST', `/question/${requestID}/${action}`, body)
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 404 || server !== srv || sessionID !== id) throw err
    await api(srv, 'POST', `/api/session/${id}/question/${requestID}/${action}`, body)
  }
}

/** Deliver the user's answers for a pending question (unblocks the turn). */
export async function answerQuestion(requestID: string, answers: string[][]): Promise<void> {
  await questionAction(requestID, 'reply', { answers })
}

/** Dismiss a pending question — best-effort; the tool reports the dismissal to the model. */
export async function rejectQuestion(requestID: string): Promise<void> {
  if (!server) return
  await questionAction(requestID, 'reject', {}).catch(() => {})
}

/**
 * Questions still awaiting an answer in the current session. Lets a freshly
 * (re)loaded window re-show the question card instead of leaving the turn
 * stuck on a prompt that's no longer on screen.
 */
export async function pendingQuestion(): Promise<{ id: string; questions: unknown[] } | null> {
  if (!server || !sessionID) return null
  const srv = server
  const id = sessionID
  const epoch = chatEpoch
  /* eslint-disable @typescript-eslint/no-explicit-any -- untyped server JSON */
  const v1 = await api<any[]>(srv, 'GET', '/question').catch(() => [])
  if (epoch !== chatEpoch || sessionID !== id) return null
  const v2 = await api<{ data?: any[] }>(srv, 'GET', `/api/session/${id}/question`).catch(
    () => ({}) as { data?: any[] }
  )
  if (epoch !== chatEpoch || sessionID !== id) return null
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const mine = [...(Array.isArray(v1) ? v1 : []), ...(v2.data ?? [])].find(
    (r) => r?.sessionID === id && r?.id
  )
  return mine ? { id: mine.id, questions: mine.questions ?? [] } : null
}

/** Start a fresh conversation; stop old event streams before allowing another turn. */
export function newChatSession(): void {
  cancelChat()
  shutdownChat()
}

/**
 * Continue a session saved in the project's chat history (called when a
 * project with a restored transcript is opened). Verified lazily on the next
 * send — see sendChatMessage. A null id is ignored rather than applied: it
 * means the chat file is missing or unreadable, and wiping a live session
 * over that (e.g. on a window reload whose loadState found nothing) would
 * silently fork the conversation. Real resets go through newChatSession
 * (/clear) or shutdownChat (project switch).
 */
export function resumeSession(id: string | null): void {
  if (busy || !id) return
  sessionID = id
  sessionRestored = true
}

/** The active conversation id, saved with the transcript for later resume. */
export function getSessionID(): string | null {
  return sessionID
}

/** Tear down the chat server — project switch or app quit. */
/** Connection changes restart the executor without discarding the task scope. */
export function restartChatForSettings(): void {
  const selected = legacySelection?.projectPath === getCurrentProject()?.path ? legacySelection : null
  shutdownChat()
  legacySelection = selected
}
export function shutdownChat(): void {
  for (const listener of shutdownListeners) listener()
  getActiveAgentRun()?.finish('cancelled')
  void cancelProjectValidations()
  if (busy) sendToRenderer('chat:done', { ok: false, cancelled: true })
  chatEpoch++
  cancelled = true
  chatController.abort()
  clearChatConnection()
  chatActivity=null
  legacySelection=null
  void clearLegacySessions().catch(()=>{})
  serverStartup = null
  if (filesChangedTimer) clearTimeout(filesChangedTimer)
  filesChangedTimer = null
  sessionID = null
  sessionRestored = false
  busy = false
  messageMeta.clear()
  partCache.clear()
  killServer()
}

/** One attempt, one scoped session. Microsoft, not this adapter, owns retries. */
export async function prepareProductionExecutor(projectPath: string): Promise<void> {
  const srv = await ensureServer(projectPath)
  if (!srv.managed) throw new Error('Microsoft executor mode is disabled.')
  await assertProviderAvailable(srv)
}
/** Inspect native MCP readiness without sending a provider request or exposing config/auth. */
export async function productionExecutorCapabilities(projectPath: string): Promise<{ solarStatus: string; allowedSolarTools: Record<ProductionRole, string[]> }> {
  const srv=await ensureServer(projectPath)
  if(!srv.managed)throw new Error('Microsoft executor mode is disabled.')
  const mcp=await api<Record<string,{status?:string}>>(srv,'GET','/mcp',undefined,{timeoutMs:20_000,maxBytes:64*1024})
  // /experimental/tool/ids lists registry tools, not MCP tools. Inspect actual
  // normalized agent permissions instead of mistaking an empty registry for a
  // disconnected MCP server. Return no prompts, provider config or credentials.
  const agents=await api<{name:string;permission:ExecutorPermission[]}[]>(srv,'GET','/agent',undefined,{timeoutMs:20_000,maxBytes:1024*1024})
  const allowedSolarTools = Object.fromEntries(productionRoles.map(role => {
    const rules=agents.find(agent=>agent.name===`solar-production-${role}`)?.permission??[]
    return [role,productionSolarReadTools.filter(tool=>effectiveExecutorPermission(tool,rules)==='allow')]
  })) as Record<ProductionRole,string[]>
  return {solarStatus:mcp.solar?.status??'missing',allowedSolarTools}
}
export async function executeProductionAgent(stage: StageExecution, role: ProductionRole, skills: string[], prompt: string, signal: AbortSignal, images: { mime: string; dataUrl: string; name: string }[] = [], readPaths: string[] = [], options: { schema?: ArtifactSchema; toolAllowlist?: string[]; onProgress?: (progress: NonNullable<ProductionState['progress']>) => void } = {}): Promise<unknown> {
  if (!getProductionEnabled()) throw new Error('Microsoft production mode is disabled.')
  validateRoleDispatch(stage.phase,role)
  validateRoleSkills(role,skills,stage.task.selection)
  const epoch = chatEpoch
  const srv = await ensureServer((stage.task as StageExecution['task'] & { projectPath: string }).projectPath)
  if (!srv.managed || signal.aborted || epoch !== chatEpoch) throw new Error('Managed executor startup was cancelled.')
  let capabilities: Awaited<ReturnType<typeof productionExecutorCapabilities>>
  try {
    await assertProviderAvailable(srv)
    capabilities=await productionExecutorCapabilities(stage.task.projectPath)
  } catch (error) {
    // No model session is executing here. Recycle an unresponsive managed
    // server before Microsoft's next read-only stage attempt.
    if (isConnectionFailure(error) && !managedAttempts.size && server===srv) killServer()
    throw error
  }
  if(capabilities.solarStatus!=='connected' || roleSolarReadTools(role).some(tool=>!capabilities.allowedSolarTools[role].includes(tool))) {
    throw new Error('The managed Solar reference tools are unavailable or denied for this role. No provider request was sent; restart the assistant after correcting its configuration.')
  }
  const allowedTools = ['StructuredOutput','skill','read','glob','grep','list','webfetch','websearch',...roleSolarReadTools(role)]
  if (options.toolAllowlist?.some(tool => !allowedTools.includes(tool)) || options.toolAllowlist && (!options.schema || !options.toolAllowlist.includes('StructuredOutput') || skills.length > 0 && !options.toolAllowlist.includes('skill'))) throw new Error('Invalid Microsoft stage tool allowlist.')
  const permission = options.toolAllowlist ? [{ permission:'*', pattern:'*', action:'deny' },...options.toolAllowlist.map(tool => ({ permission:tool,pattern:'*',action:'allow' }))] : undefined
  const skillBundles = [await prepareNativeGameSkills(), await prepareProductionSkills()]
  const provided = await selectedSkillContext(skills, skillBundles, signal)
  const methodologyFiles = [...new Set([...provided.context.matchAll(/(?:^|\n)- ((?:bmad|tea)\/[a-zA-Z0-9_./-]+\.md)/g)].map(match => match[1]))].slice(0, 4)
  const methodologyHint = methodologyFiles.length
    ? `\nOptional methodology files (exact library-relative paths): ${methodologyFiles.join(', ')}. To read one, use solar_production_guidance {action:"read",file:"${methodologyFiles[0]}"}. Do not prefix repository/version metadata, guess files, or repeat failed/empty retrieval. The supplied skill already contains the method; submit StructuredOutput once sufficient.`
    : ''
  let session: {id:string}
  try { session=await api<{id:string}>(srv,'POST','/session',{title:`Solar ${role} · ${stage.stageId}`,...(permission?{permission}:{})},{signal,timeoutMs:30_000,maxBytes:256*1024}) }
  catch (error) { if(isConnectionFailure(error)&&!managedAttempts.size&&server===srv)killServer(); throw error }
  try {
    if (signal.aborted || epoch !== chatEpoch) throw new Error('Managed executor was cancelled.')
    await registerProductionSession(session.id,stage.runId,role,skills,stage.task.projectPath,[...readPaths,...provided.paths],options.toolAllowlist,stage.task.selection)
  } catch (error) {
    await api(srv, 'DELETE', `/session/${session.id}`, undefined, { timeoutMs: 15_000, maxBytes: 4096 }).catch(() => {})
    throw error
  }
  const preloadedContext = provided.context
    ? `${methodologyHint}\n\nSolar supplied the complete, hash-verified assigned references below. Use their methodology for this stage. A native skill call is optional for these already supplied documents. Only selected guides may be loaded.\n${provided.context}`
    : ''
  const attempt = new AbortController()
  const trace = productionAttempt(stage, role, session.id, Buffer.byteLength(prompt + preloadedContext), options.onProgress)
  trace.skillContext(provided.receipts)
  let outcome: 'completed'|'blocked'|'transient'|'cancelled' = 'blocked', failure: string | null = null
  let controlledFailure: Error | null = null
  const toolGuard = new ProductionToolGuard(role)
  const toolMessages = new Set<string>()
  const assistantMessages = new Set<string>()
  let abortRequest: Promise<boolean> | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const abort = (): void => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }; attempt.abort(); abortRequest ??= api(srv, 'POST', `/session/${session.id}/abort`, {}, { timeoutMs: 15_000, maxBytes: 4096 }).then(() => true, () => false) }
  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => { controlledFailure = new Error('PRODUCTION_TRANSIENT: The provider stopped responding. Reconnecting this read-only stage.'); abort() }, CONNECTION_RECOVERY.idleMs)
    idleTimer.unref()
  }
  managedAttempts.set(session.id, { fail: error => { controlledFailure ??= error; abort() }, observe: (type, properties) => {
    if (controlledFailure) return
    if (properties.info?.role === 'assistant' && typeof properties.info.id === 'string') assistantMessages.add(properties.info.id)
    const messageId = properties.part?.messageID ?? properties.messageID
    if (!type.startsWith('message.part.') || typeof messageId === 'string' && assistantMessages.has(messageId)) trace.observe(type, properties)
    if (typeof messageId === 'string' && assistantMessages.has(messageId) && (properties.delta?.length || properties.part?.text?.length || properties.part?.type === 'tool')) armIdle()
    const part = properties.part
    if (part?.type === 'tool') {
      const loop = toolGuard.observe(part)
      if (loop) { controlledFailure = loop; abort(); return }
    }
    // A reconnect can deliver tool parts before message metadata. Fetch their
    // actual session messages later and validate the assistant role then.
    if (part?.type === 'tool' && typeof part.messageID === 'string' && /^msg[a-zA-Z0-9_-]{1,120}$/.test(part.messageID) && toolMessages.size < 128) toolMessages.add(part.messageID)
  } })
  try {
  await trace.started()
  let model = stage.task.model
  if (role === 'vision-reviewer') {
    const config = JSON.parse(await readFile(join(homedir(), '.config/opencode/opencode.json'), 'utf8'))
    const ref = configuredImageModel(config)
    const slash = ref.indexOf('/')
    model = { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) }
  }
  trace.model(model)
  const currentModel = await resolveChatModel()
  if (role !== 'vision-reviewer' && JSON.stringify(currentModel) !== JSON.stringify(model)) throw new Error('The selected model changed. Restart the workflow with its current settings.')
  signal.addEventListener('abort', abort, { once: true })
    const parts: unknown[] = images.map(image => ({ type: 'file', mime: image.mime, filename: image.name, url: image.dataUrl }))
    parts.push({ type: 'text', text: `Microsoft stage: ${role}. Assigned native skill references: ${skills.join(', ') || 'none'}.\nSolar supplies these complete references in this message. Apply them before preparing the artifact; additional native skill calls are optional. Group independent reads in at most two calls per response. Avoid repeated retrieval; return the bounded artifact once the contract is satisfied.${options.schema ? ' Submit the final artifact using StructuredOutput after required evidence reads are complete. Do not return prose or fenced JSON. Stop immediately after the StructuredOutput tool confirms submission; do not generate a duplicate final answer.' : ''}\n${prompt}${preloadedContext}` })
    signal.throwIfAborted()
    // The request includes every tool/model round, not just a single generation.
    // Slow reasoning providers can exceed eight minutes while completing real
    // reads. Keep a role ceiling and retain immediate Stop/epoch cancellation.
    const roleMinutes=role==='vision-reviewer'?5:role==='developer'?30:20
    armIdle()
    const reply = await api<{ info?: { structured?: unknown; finish?: string; tokens?: { input?: number; output?: number; reasoning?: number }; error?: { name?: string; data?: { message?: string } } }; parts?: { type: string; text?: string; tool?: string; state?: { status?: string; input?: Record<string, unknown> } }[] }>(srv, 'POST', `/session/${session.id}/message`, { model, agent: `solar-production-${role}`, parts, ...(options.schema ? { format: { type: 'json_schema', schema: options.schema, retryCount: 0 } } : {}) }, { timeoutMs: roleMinutes * 60_000, maxBytes: 4 * 1024 * 1024, signal: attempt.signal })
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    if (controlledFailure) throw controlledFailure
    trace.response(reply.info, reply.parts ?? [])
    // OpenCode/NVIDIA may report finish=length after its required structured
    // tool accepted the complete JSON, because the model continues generating
    // a redundant final message. The completed tool input is the artifact;
    // only this exact successful tool call can recover a length-truncated turn.
    const submittedParts = options.schema ? (reply.parts ?? []).filter(part => part.type === 'tool' && part.tool === 'StructuredOutput' && part.state?.status === 'completed') : []
    const submittedArtifact = submittedParts.length === 1 ? submittedParts[0].state?.input : undefined
    const structuredValue = reply.info?.structured ?? submittedArtifact
    const structured = !!options.schema && structuredValue !== undefined
    if (reply.info?.error) {
      if (reply.info.error.name === 'StructuredOutputError' && !(reply.info.finish === 'length' && structured)) throw new Error(reply.info.finish === 'length' ? `The selected model reached its output limit without submitting a complete artifact. This stage is blocked. Use a smaller story or choose a model that can finish it in AI settings; the selected reasoning level was preserved.` : 'The selected model did not submit the required structured artifact. This stage is blocked; review AI settings before resuming.')
      if (reply.info.error.name === 'StructuredOutputError') { /* A single successful, schema-validated tool submission is authoritative. */ }
      else
      throw new Error(reply.info.error.data?.message || reply.info.error.name || 'Managed model request failed.')
    }
    const output = (reply.parts ?? []).filter(p => p.type === 'text').map(p => p.text ?? '').join('\n').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    if (!structured && !output) throw new Error(`The provider ${model.providerID}/${model.modelID} returned no final artifact${(reply.parts ?? []).some(part => part.type === 'reasoning') ? ' (reasoning only)' : ''}. This stage is blocked; reasoning text cannot replace a completed response.`)
    if (/^Maximum (?:number of )?steps/i.test(output)) throw new Error('The executor reached its stage step limit before returning the required artifact. This stage is blocked; the limit summary cannot replace a completed response.')
    const finish = reply.info?.finish ?? ''
    if (!['stop', 'end-turn', ...(structured ? ['tool-calls', ...(submittedArtifact !== undefined ? ['length'] : [])] : [])].includes(finish)) throw new Error(`The provider returned an incomplete artifact (finish: ${finish || 'missing'}). This stage cannot be accepted.`)
    if (output.length > 1024 * 1024) throw new Error('Managed executor returned an oversized artifact.')
    // OpenCode 1.17.13's bulk transcript encoder rejects persisted json_schema
    // user formats. Read the actual assistant tool messages by their IDs from
    // this authenticated session stream; never replace evidence with claims.
    type ToolMessage = { info?: { role?: string; sessionID?: string }; parts?: { type?: string; tool?: string; state?: { status?: string; input?: Record<string, unknown> } }[] }
    const transcript: ToolMessage[] = [{ info: { role: 'assistant', sessionID: session.id }, parts: reply.parts }]
    if (options.schema) {
      for (const id of toolMessages) transcript.push(await api<ToolMessage>(srv, 'GET', `/session/${session.id}/message/${id}`, undefined, { signal, timeoutMs: 30_000, maxBytes: 1024 * 1024 }))
    } else transcript.push(...await api<ToolMessage[]>(srv, 'GET', `/session/${session.id}/message`, undefined, { signal, timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024 }))
    const reads = new Set<string>()
    for (const message of transcript) for (const part of message.info?.role === 'assistant' && message.info.sessionID === session.id ? message.parts ?? [] : []) {
      const skillName = part.state?.input?.name, filePath = part.state?.input?.filePath
      if (part.tool === 'skill' && part.state?.status === 'completed' && typeof skillName === 'string') recordProductionSkill(session.id, skillName)
      if (part.tool === 'read' && part.state?.status === 'completed' && typeof filePath === 'string') reads.add(resolve(filePath).toLowerCase())
    }
    const loaded = productionSkillsLoaded(session.id)
    // Native calls read this same snapshot during generation. Detect cache
    // changes made after context delivery before accepting the stage.
    await selectedSkillContext(skills, skillBundles, signal)
    if (options.schema && (!structured || !(reply.parts ?? []).some(part => part.tool === 'StructuredOutput' && part.state?.status === 'completed'))) throw new Error('The executor did not complete the required StructuredOutput tool. Plain JSON cannot replace its stage artifact.')
    if (skills.some(name => !provided.receipts.some(receipt => receipt.name === name))) throw new Error('The stage did not receive every selected skill reference.')
    // Vision reads the original PNG through its image model; the gate must also
    // read every original structured artifact, rather than approve metadata alone.
    if (role === 'tea-gate' && readPaths.filter(path => path.endsWith('.json')).some(path => !reads.has(resolve(path).toLowerCase()))) throw new Error('TEA did not read every required original evidence artifact. The gate cannot be accepted.')
    stage.role = role; stage.loadedSkills = loaded; stage.skillContext = provided.receipts
    stage.assetSelections=productionAssetSelections(session.id)
    let artifact: unknown
    try { artifact = structured ? structuredValue : JSON.parse(output) }
    catch { throw new Error('The executor did not return valid JSON for the stage artifact. This stage is blocked; no implementation or quality verdict was accepted.') }
    if (options.schema) validateProductionOutput(artifact, options.schema)
    outcome = 'completed'
    return artifact
  } catch (error) {
    const reason = controlledFailure ?? error
    const message = (reason as Error).message
    outcome = signal.aborted ? 'cancelled' : isConnectionFailure(reason) ? 'transient' : 'blocked'
    failure = /Production tool loop stopped/.test(message) ? 'tool_loop' : isConnectionFailure(reason) ? 'provider_retry' : /stage step limit/i.test(message) ? 'step_limit' : /no final artifact/i.test(message) ? 'empty_provider_response' : /incomplete artifact/i.test(message) ? 'incomplete_generation' : /quota|credits|can only afford/i.test(message) ? 'quota' : /JSON/i.test(message) ? 'invalid_artifact' : 'executor_error'
    throw reason
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    managedAttempts.delete(session.id)
    signal.removeEventListener('abort', abort)
    // A local HTTP timeout must also stop provider generation in OpenCode.
    // Aborting an already completed role is idempotent and affects this session only.
    abort()
    const cleanup = abortRequest as Promise<boolean> | null
    let stopped: boolean = cleanup ? await cleanup : false
    if (!stopped && outcome === 'transient' && !signal.aborted && epoch === chatEpoch && server === srv) {
      // Every managed tool is read-only. Stop an unreachable executor before
      // Microsoft starts a replacement; Godot and the app remain untouched.
      const exited = new Promise<boolean>(resolve => {
        if (srv.proc.exitCode !== null || srv.proc.signalCode !== null) { resolve(true); return }
        const timer = setTimeout(() => { srv.proc.removeListener('close', closed); resolve(false) }, 5000)
        const closed = (): void => { clearTimeout(timer); resolve(true) }
        srv.proc.once('close', closed)
      })
      killServer()
      stopped = await exited
    } else if (!stopped && (srv.proc.exitCode !== null || srv.proc.signalCode !== null)) stopped = true
    try { await trace.finish(outcome, productionSkillsLoaded(session.id), failure, stopped === true) }
    finally { await unregisterProductionSession(session.id) }
    if (!stopped && !signal.aborted && epoch === chatEpoch) throw new Error('OpenCode generation cleanup could not be confirmed. Restart the assistant before retrying this stage.')
  }
}
