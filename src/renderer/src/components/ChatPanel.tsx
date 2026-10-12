import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AssetPreview,
  ChatAttachment,
  ChatPartUpdate,
  ChatQuestionRequest,
  ChatToolStatus,
  ReasoningEffort,
  SetupStatus
} from '../../../shared/types'
import { REASONING_EFFORT_CHOICES, reasoningEffortsForModel } from '../../../shared/model-reasoning'
import type { ChatConnectionState } from '../../../shared/connection-recovery'
import solarMark from '../assets/solar-mark.png'
import { ProductionPanel } from './ProductionPanel'
import { DownArrowIcon, FileIcon, FolderIcon, PlusIcon, SearchIcon, SendIcon, SparkIcon, StopIcon, TerminalIcon, XIcon } from './Icons'

marked.setOptions({ gfm: true, breaks: true })

/** Sanitized GitHub-flavored markdown — the assistant writes reports, tables, code. */
function Markdown({ source }: { source: string }): React.JSX.Element {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(source, { async: false }) as string), [source])
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
}

interface AssistantPart {
  id: string
  kind: 'text' | 'reasoning' | 'tool' | 'image' | 'asset'
  text: string
  tool?: { name: string; status: ChatToolStatus; title?: string; error?: string; agent?: string }
  dataUrl?: string
  /** For kind 'asset': the generated 2D/3D asset preview the user can react to. */
  asset?: AssetPreview
}

interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'error'
  content: string
  /** Assistant messages are a sequence of parts (text, tools, images). */
  parts?: AssistantPart[]
  /** Files the user attached to this message (chat-only, not project files). */
  attachments?: ChatAttachment[]
  streaming?: boolean
}

// Inline attachments cap: data URLs ride the message to the model; keep them sane.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

// What the assistant can digest inline. The file-picker enforces this via
// `accept`; drag & drop bypasses that, so addFiles re-checks the same lists.
const ATTACH_EXTENSIONS = ['.txt', '.md', '.json', '.gd', '.tscn', '.cfg', '.csv', '.log', '.pdf']

// Asset uploads: archives and 2D/3D asset files too big or too binary to ride
// the message as data URLs. They attach by disk path — on send the main
// process copies them into the project's .solar/attachments/ and points
// the assistant there (see saveChatUploads). Dropped/picked folders always
// take this route. Checked against the same 512 MB cap the main process
// enforces; folders can only be measured there, so theirs waits until send.
const UPLOAD_EXTENSIONS = [
  '.zip',
  '.glb', '.gltf', '.obj', '.fbx', '.dae', '.stl', '.blend',
  '.wav', '.ogg', '.mp3',
  '.ttf', '.otf'
]
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024
const ATTACH_ACCEPT = ['image/*', ...ATTACH_EXTENSIONS, ...UPLOAD_EXTENSIONS].join(',')

function isAttachable(file: File): boolean {
  return file.type.startsWith('image/') || ATTACH_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext))
}

function isUpload(file: File): boolean {
  return UPLOAD_EXTENSIONS.some((ext) => file.name.toLowerCase().endsWith(ext))
}

/** A picked/dropped file plus what only the drop event can know: folder-ness. */
interface IncomingFile {
  file: File
  dir: boolean
}

/**
 * Restored transcripts come back as opaque JSON (possibly from an older app
 * version) — keep only messages that still match our shape, and settle any
 * state that only makes sense live: nothing restored can be streaming, and a
 * tool chip frozen as "running" would show a spinner forever.
 */
function sanitizeRestored(raw: unknown[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  for (const item of raw) {
    const m = item as Partial<ChatMessage>
    if (typeof m.id !== 'string' || (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'error')) continue
    const parts = Array.isArray(m.parts)
      ? m.parts
          // Reasoning is live-only UI; drop any saved by older builds too.
          .filter((p) => p && typeof p.id === 'string' && p.kind !== 'reasoning')
          .map((p) =>
            p.kind === 'tool' && p.tool && (p.tool.status === 'running' || p.tool.status === 'pending')
              ? { ...p, tool: { ...p.tool, status: 'completed' as ChatToolStatus } }
              : p
          )
      : undefined
    messages.push({
      id: m.id,
      role: m.role,
      content: typeof m.content === 'string' ? m.content : '',
      parts,
      attachments: Array.isArray(m.attachments) ? m.attachments : undefined
    })
  }
  return messages
}

/**
 * Live-only parts (the streaming thinking preview) must not reach the saved
 * transcript: they're noise on restore and can carry a lot of text.
 */
function stripEphemeral(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) =>
    m.parts?.some((p) => p.kind === 'reasoning')
      ? { ...m, parts: m.parts.filter((p) => p.kind !== 'reasoning') }
      : m
  )
}

/**
 * Heuristic for "the AI provider couldn't be reached": the error strings
 * Node/undici/OpenCode produce for DNS, socket and timeout failures. Used to
 * tell a dropped connection apart from a real model/tooling error, so the
 * chat can offer to continue the interrupted turn instead of just showing a
 * raw failure. (navigator.onLine alone isn't enough — a router that's up but
 * without internet keeps it true.)
 */
const NETWORK_ERROR_RE =
  /fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|socket|UND_ERR/i

/** Message shown in place of the raw error when a turn dies to a lost connection. */
const DISCONNECTED_NOTICE =
  'Automatic reconnect is paused. Your conversation and completed work are saved. ' +
  'Continue when the provider or server is available.'

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

interface Props {
  projectPath: string
  opencodeAvailable: boolean
  setup: SetupStatus | null
  onSetupUpdated: (status: SetupStatus) => void
  onOpenSettings: () => void
  onOpenScene: () => void
  onAssistantDone: () => void
}

const SUGGESTIONS = [
  'Make a 2D platformer with a player that moves and jumps',
  'Add a score counter to the screen',
  'Give the game a title screen with a start button'
]

interface SlashCommand {
  name: string
  description: string
}

const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'clear', description: 'Clear the chat history' },
  { name: 'undo', description: 'Undo your last message and the file changes it made' },
  { name: 'redo', description: 'Restore the last undone message' }
]

/**
 * The text qualifies as a slash-command query only while it looks like one:
 * starts with "/", single token, no second slash (so pasting paths like
 * "/root/Main" never hijacks the input).
 */
function slashQueryOf(input: string): string | null {
  if (!input.startsWith('/') || input.length > 24) return null
  const rest = input.slice(1)
  if (/[\s/]/.test(rest)) return null
  return rest.toLowerCase()
}

function toolIcon(name: string): React.JSX.Element {
  const base = name.replace(/^(?:solar|genieengine)_/, '')
  if (base === 'bash') return <TerminalIcon size={11} />
  if (base === 'glob' || base === 'grep' || base === 'list' || base === 'webfetch' || base === 'itch_search' || base === 'game_guidance')
    return <SearchIcon size={11} />
  if (base === 'read' || base === 'write' || base === 'edit' || base === 'patch' || base === 'skill') return <FileIcon size={11} />
  if (base === 'itch_download') return <FolderIcon size={11} />
  return <SparkIcon size={11} />
}

/** Compact label for a tool chip: the tool name plus a shortened target. */
function toolLabel(tool: { name: string; title?: string; agent?: string }): string {
  let title = tool.title ?? ''
  if (title.includes('/')) {
    title = title.split('/').filter(Boolean).slice(-2).join('/')
  }
  if (title.length > 40) title = title.slice(0, 39) + '…'
  const name = tool.name.replace(/^(?:solar|genieengine)_/, '')
  const displayName = name === 'game_guidance' ? 'Game guidance' : name === 'skill' ? 'Skill' : name
  const label = title ? `${displayName} · ${title}` : displayName
  // Subagent calls carry their agent so delegated work reads as such.
  return tool.agent ? `${tool.agent} → ${label}` : label
}

/**
 * "Thinking… Ns" with a live seconds counter — the fallback face of the
 * thinking line when the model's reasoning text isn't available (some
 * providers keep it encrypted), so the chat still visibly makes progress.
 */
function ThinkingTicker(): React.JSX.Element {
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  return <span>Thinking…{seconds >= 2 ? ` ${seconds}s` : ''}</span>
}

function ToolChip({ part }: { part: AssistantPart }): React.JSX.Element {
  const status = part.tool?.status ?? 'running'
  // Failed calls explain themselves on hover (native tooltip).
  const tooltip = status === 'error' ? `Failed: ${part.tool?.error || 'no error details reported'}` : undefined
  return (
    <span className={`tool-chip ${status}${part.tool?.agent ? ' subagent' : ''}`} title={tooltip}>
      <span className="tool-chip-icon">{toolIcon(part.tool?.name ?? '')}</span>
      <span className="tool-chip-label">{toolLabel(part.tool ?? { name: 'tool' })}</span>
      <span className="tool-chip-status">
        {status === 'completed' ? '✓' : status === 'error' ? <XIcon size={9} /> : <span className="spinner" />}
      </span>
    </span>
  )
}

/**
 * Renders one assistant message as flowing content (no bubble): markdown
 * text, compact tool-activity rows, live test screenshots.
 */
function AssistantMessage({
  msg,
  isFirst,
  onAssetFeedback
}: {
  msg: ChatMessage
  isFirst: boolean
  onAssetFeedback: (asset: AssetPreview) => void
}): React.JSX.Element {
  const parts = msg.parts ?? []
  const last = parts[parts.length - 1]

  const blocks: React.JSX.Element[] = []
  let toolGroup: AssistantPart[] = []
  const flushTools = (): void => {
    if (toolGroup.length > 0) {
      blocks.push(
        <div key={`tools-${toolGroup[0].id}`} className="tool-row">
          {toolGroup.map((p) => (
            <ToolChip key={p.id} part={p} />
          ))}
        </div>
      )
      toolGroup = []
    }
  }

  for (const part of parts) {
    if (part.kind === 'tool') {
      toolGroup.push(part)
      continue
    }
    flushTools()
    if (part.kind === 'text' && part.text) {
      blocks.push(<Markdown key={part.id} source={part.text} />)
    } else if (part.kind === 'image' && part.dataUrl) {
      blocks.push(<img key={part.id} className="chat-shot" src={part.dataUrl} alt="Game screenshot from test run" />)
    } else if (part.kind === 'asset' && part.asset) {
      const asset = part.asset
      blocks.push(
        <div key={part.id} className="asset-card">
          <img className="asset-card-img" src={asset.dataUrl} alt={`Generated ${asset.kind} asset: ${asset.label}`} />
          <div className="asset-card-meta">
            <span className={`asset-kind-badge kind-${asset.kind}`}>{asset.kind === '3d' ? '3D' : '2D'}</span>
            <span className="asset-card-name">{asset.label}</span>
            <span className="asset-card-path">{asset.path}</span>
            <button
              className="btn btn-sm btn-ghost asset-feedback-btn"
              title="Describe what to change — the assistant will regenerate this asset"
              onClick={() => onAssetFeedback(asset)}
            >
              Request changes
            </button>
          </div>
        </div>
      )
    } else if (part.kind === 'reasoning' && msg.streaming && part === last) {
      // Live preview of the model's thinking: one line showing the newest
      // tail of the reasoning stream, replaced in place as more arrives, so
      // long silent stretches still visibly make progress. Never persisted —
      // see stripEphemeral.
      const tail = part.text.replace(/\s+/g, ' ').trim().slice(-300)
      blocks.push(
        <div key={part.id} className="thinking-line">
          <span className="spinner" />
          {tail ? (
            <span className="thinking-preview">
              <bdi>{tail}</bdi>
            </span>
          ) : (
            <ThinkingTicker key={part.id} />
          )}
        </div>
      )
    }
  }
  flushTools()

  return (
    <div className={isFirst ? 'msg assistant' : 'msg assistant cont'}>
      {blocks}
      {msg.streaming && parts.length === 0 && (
        <span className="typing-dots">
          <span />
          <span />
          <span />
        </span>
      )}
    </div>
  )
}

/**
 * The assistant's "question" tool blocks its whole turn until it hears back,
 * so this card is the only way to unblock it: options render as buttons, a
 * lone single-choice question answers on click, anything else (multi-select,
 * several questions, free-text) collects choices behind one Answer button,
 * and dismissing tells the assistant to carry on without an answer.
 */
function QuestionCard({
  request,
  onAnswer,
  onDismiss
}: {
  request: ChatQuestionRequest
  onAnswer: (answers: string[][]) => void
  onDismiss: () => void
}): React.JSX.Element {
  const [selected, setSelected] = useState<string[][]>(() => request.questions.map(() => []))
  const [customs, setCustoms] = useState<string[]>(() => request.questions.map(() => ''))
  const [customOpen, setCustomOpen] = useState<boolean[]>(() => request.questions.map(() => false))

  const instant = request.questions.length === 1 && !request.questions[0].multiple
  const answerFor = (i: number): string[] =>
    customOpen[i] && customs[i].trim() ? [customs[i].trim()] : selected[i]
  const complete = request.questions.every((_, i) => answerFor(i).length > 0)
  const submitAll = (): void => onAnswer(request.questions.map((_, i) => answerFor(i)))

  const choose = (qi: number, label: string): void => {
    if (instant && !customOpen[qi]) {
      onAnswer([[label]])
      return
    }
    setCustomOpen((open) => open.map((o, i) => (i === qi ? false : o)))
    setSelected((sel) =>
      sel.map((choices, i) => {
        if (i !== qi) return choices
        if (request.questions[qi].multiple) {
          return choices.includes(label) ? choices.filter((c) => c !== label) : [...choices, label]
        }
        return [label]
      })
    )
  }

  return (
    <div className="question-card">
      <div className="question-card-head">
        <SparkIcon size={11} />
        <span>The assistant needs your input</span>
        <button
          className="question-dismiss"
          title="Dismiss — the assistant continues without an answer"
          onClick={onDismiss}
        >
          <XIcon size={9} />
        </button>
      </div>
      {request.questions.map((q, qi) => (
        <div key={qi} className="question-block">
          <div className="question-text">
            {q.header && <span className="question-header-chip">{q.header}</span>}
            {q.question}
          </div>
          <div className="question-options">
            {q.options.map((opt) => (
              <button
                key={opt.label}
                className={
                  selected[qi].includes(opt.label) && !customOpen[qi]
                    ? 'question-option selected'
                    : 'question-option'
                }
                onClick={() => choose(qi, opt.label)}
              >
                <span className="question-option-label">{opt.label}</span>
                {opt.description && <span className="question-option-desc">{opt.description}</span>}
              </button>
            ))}
            {q.custom && (
              <button
                className={customOpen[qi] ? 'question-option selected' : 'question-option'}
                onClick={() => setCustomOpen((open) => open.map((o, i) => (i === qi ? !o : o)))}
              >
                <span className="question-option-label">Other…</span>
              </button>
            )}
          </div>
          {q.custom && customOpen[qi] && (
            <input
              className="question-custom-input"
              autoFocus
              placeholder="Type your answer and press Enter…"
              value={customs[qi]}
              onChange={(e) => setCustoms((c) => c.map((v, i) => (i === qi ? e.target.value : v)))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && complete) {
                  e.preventDefault()
                  submitAll()
                }
              }}
            />
          )}
        </div>
      ))}
      {(!instant || customOpen[0]) && (
        <button className="btn btn-sm btn-primary question-submit" disabled={!complete} onClick={submitAll}>
          Answer
        </button>
      )}
    </div>
  )
}

export function ChatPanel({ projectPath, opencodeAvailable, setup, onSetupUpdated, onOpenSettings, onOpenScene, onAssistantDone }: Props): React.JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(setup?.chat.effort ?? 'default')
  const [savingReasoningEffort, setSavingReasoningEffort] = useState(false)
  const [reasoningEffortError, setReasoningEffortError] = useState<string | null>(null)
  const [reasoningEffortDirty, setReasoningEffortDirty] = useState(false)
  const reasoningSaveInFlight = useRef(false)
  const [reasoningMenuOpen, setReasoningMenuOpen] = useState(false)
  const reasoningPickerRef = useRef<HTMLDivElement>(null)
  // OS file drag hovering the panel. Enter/leave fire for every child crossed,
  // so a depth counter decides when the drag has truly left the panel.
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)
  // A question the assistant is blocked on (null = none pending).
  const [question, setQuestion] = useState<ChatQuestionRequest | null>(null)
  // Live connectivity, driven by the browser's online/offline events. When
  // false the composer is locked and a "Disconnected" banner explains why.
  const [online, setOnline] = useState(navigator.onLine)
  const selectedModelReady = setup?.chat.configured === true
  const canChat = opencodeAvailable && selectedModelReady
  const supportedReasoningEfforts = setup
    ? reasoningEffortsForModel(
        setup.chat.provider,
        setup.chat.model,
        setup.chat.reasoningEfforts === undefined
          ? undefined
          : {
              id: setup.chat.model,
              supportsImageInput: null,
              reasoningEfforts: setup.chat.reasoningEfforts,
              reasoningBudgetMax: setup.chat.reasoningBudgetMax,
              reasoningMode: setup.chat.reasoningMode
            }
      )
    : null
  const reasoningChoices = [...REASONING_EFFORT_CHOICES]
    .filter(({ value }) => supportedReasoningEfforts?.includes(value)).reverse()
  const effectiveReasoningEffort = reasoningEffort === 'default' ||
    reasoningChoices.some(({ value }) => value === reasoningEffort)
    ? reasoningEffort
    : 'default'
  const reasoningEffortLabel = REASONING_EFFORT_CHOICES.find(({ value }) => value === effectiveReasoningEffort)?.label ?? 'Default'
  const chatModelName = setup?.chat.model.split('/').pop() ?? ''
  const formattedModelName = chatModelName
    .replace(/^gpt-/i, 'GPT-')
    .replace(/^claude-/i, 'Claude ')
    .replace(/^gemini-/i, 'Gemini-')
    .replace(/^grok-/i, 'Grok-')

  useEffect(() => {
    if (!reasoningMenuOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!reasoningPickerRef.current?.contains(event.target as Node)) setReasoningMenuOpen(false)
    }
    const onEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setReasoningMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onEscape)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onEscape)
    }
  }, [reasoningMenuOpen])

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'm') {
        if (!setup?.chat.configured || !reasoningChoices.length) return
        event.preventDefault()
        setReasoningMenuOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onShortcut)
    return () => window.removeEventListener('keydown', onShortcut)
  }, [setup?.chat.configured, reasoningChoices.length])

  useEffect(() => {
    setReasoningEffort(setup?.chat.effort ?? 'default')
    setReasoningEffortDirty(false)
    setReasoningEffortError(null)
    setReasoningMenuOpen(false)
  }, [setup?.chat.provider, setup?.chat.model, setup?.chat.effort])

  const persistReasoningEffort = async (effort: ReasoningEffort): Promise<void> => {
    if (!setup || reasoningSaveInFlight.current) return
    if (setup.chat.effort === effort) {
      setReasoningEffortDirty(false)
      setReasoningMenuOpen(false)
      return
    }
    reasoningSaveInFlight.current = true
    setSavingReasoningEffort(true)
    setReasoningEffortError(null)
    try {
      const result = await window.api.setChatReasoningEffort(effort)
      if (!result.ok) {
        setReasoningEffortError(result.error)
        setReasoningEffortDirty(true)
        return
      }
      onSetupUpdated(result.data)
      setReasoningEffort(result.data.chat.effort)
      setReasoningEffortDirty(false)
      setReasoningMenuOpen(false)
    } catch (err) {
      setReasoningEffortError(err instanceof Error ? err.message : String(err))
      setReasoningEffortDirty(true)
    } finally {
      reasoningSaveInFlight.current = false
      setSavingReasoningEffort(false)
    }
  }
  // True after a turn died to a lost connection — surfaces the "Back online /
  // Continue" banner once connectivity returns. Cleared by the next send.
  const [interrupted, setInterrupted] = useState(false)
  const [connection, setConnection] = useState<ChatConnectionState | null>(null)
  const [connectionNow, setConnectionNow] = useState(Date.now())
  const [resumeRunId, setResumeRunId] = useState<string | null>(null)
  useEffect(() => {
    setConnection(null); setResumeRunId(null); setInterrupted(false)
    return window.api.onChatConnection(state => {
      if (state.projectPath === projectPath) setConnection(previous => state.status==='connected' && !previous ? null : state)
    })
  },[projectPath])
  useEffect(() => {
    if (!connection) return
    if (connection.status === 'connected') { const timer=setTimeout(()=>setConnection(null),3000); return ()=>clearTimeout(timer) }
    const timer=setInterval(()=>setConnectionNow(Date.now()),1000)
    return ()=>clearInterval(timer)
  },[connection])
  // ↑/↓ recall of previously sent messages: historyPos is the entry being
  // browsed (null = not browsing), draftRef holds whatever was typed before
  // browsing started so ↓ past the newest entry brings it back.
  const [inputHistory, setInputHistory] = useState<string[]>([])
  const [historyPos, setHistoryPos] = useState<number | null>(null)
  const draftRef = useRef('')
  // Saving is disabled until this project's saved state has loaded, and a
  // just-restored/just-saved array isn't rewritten to disk unchanged.
  const [canSave, setCanSave] = useState(false)
  const lastSavedRef = useRef<ChatMessage[] | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  useEffect(()=>{
    const receive = (event: Event): void => {
      const detail = (event as CustomEvent<{projectPath:string;request:string}>).detail
      if(detail?.projectPath===projectPath&&typeof detail.request==='string') {
        setInput(previous=>previous.trim()?previous+'\n'+detail.request:detail.request)
        requestAnimationFrame(()=>textareaRef.current?.focus())
      }
    }
    window.addEventListener('solar:asset-request',receive)
    return ()=>window.removeEventListener('solar:asset-request',receive)
  },[projectPath])
  const onDoneRef = useRef(onAssistantDone)
  // Grow the composer with its content, up to the CSS max-height (then it
  // scrolls). Keyed on `input` so every way the text changes resizes it —
  // including the clear on send, which snaps it back to the rows default.
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = ''
    if (ta.scrollHeight > ta.clientHeight) ta.style.height = `${ta.scrollHeight}px`
  }, [input])
  onDoneRef.current = onAssistantDone
  // Live mirror of `messages` for handlers that read it after an await —
  // /undo may abort a streaming turn first, and the resulting "Stopped."
  // notice must be part of what gets sliced away.
  const messagesRef = useRef<ChatMessage[]>(messages)
  messagesRef.current = messages
  // Turns removed by /undo, newest last; /redo pops and re-appends. Renderer
  // state is the only copy — the saved transcript is overwritten on undo — so
  // redo reaches exactly as far back as the undos of this app run. Cleared
  // whenever the conversation moves on (send, /clear, project switch), which
  // mirrors OpenCode dropping its revert point on the next message.
  const redoStackRef = useRef<ChatMessage[][]>([])

  // Restore this project's transcript and recall history when it opens (the
  // main process also resumes the saved AI session so context carries over).
  useEffect(() => {
    let alive = true
    redoStackRef.current = [] // undone turns belong to the previous project's chat
    void window.api.chatLoadState(projectPath).then((result) => {
      if (!alive) return
      if (result.ok) {
        if (result.data.messages.length > 0) {
          const restored = sanitizeRestored(result.data.messages)
          lastSavedRef.current = restored
          setMessages(restored)
        }
        setInputHistory(result.data.inputHistory)
        setQuestion(result.data.pendingQuestion ?? null)
      }
      setCanSave(true)
    })
    return () => {
      alive = false
    }
  }, [projectPath])

  // Persist the transcript whenever the conversation settles. Skipped while
  // streaming — parts update many times a second and transcripts can embed
  // screenshots — so only the settled state is written (debounced on top).
  // The timer lives in a ref so /clear can cancel a pending save immediately;
  // waiting for the effect cleanup would let it fire mid-clear and resurrect
  // the just-deleted file.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelPendingSave = (): void => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = null
  }
  useEffect(() => {
    if (!canSave || streaming || messages.length === 0 || messages === lastSavedRef.current) return
    saveTimerRef.current = setTimeout(() => {
      lastSavedRef.current = messages
      void window.api.chatSaveHistory(projectPath, stripEphemeral(messages))
    }, 400)
    return cancelPendingSave
  }, [messages, streaming, canSave, projectPath])

  // "Request changes" on a generated asset: pre-fill the composer so the user
  // just describes what's wrong; the assistant regenerates (AGENTS.md tells it
  // to reuse the same folder/name so the files are replaced).
  const startAssetFeedback = (asset: AssetPreview): void => {
    setInput(`Change the "${asset.label}" asset (${asset.path}): `)
    textareaRef.current?.focus()
  }

  /** After recalling a history entry, park the caret at its end (shell-style). */
  const moveCaretToEnd = (): void => {
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      ta?.setSelectionRange(ta.value.length, ta.value.length)
    })
  }

  const addFiles = async (incoming: IncomingFile[]): Promise<void> => {
    if (incoming.length === 0) return
    if (!canChat) {
      setAttachError('Connect the selected chat model before attaching files.')
      return
    }
    setAttachError(null)
    const next = [...attachments]
    for (const { file, dir } of incoming) {
      // Folders and asset files (zips, models, audio…) attach by path — only
      // their location crosses to the main process, which copies them into
      // .solar/attachments/ when the message is sent.
      if (dir || isUpload(file)) {
        const path = window.api.pathForFile(file)
        if (!path) {
          setAttachError(`"${file.name}" has no location on disk, so it can't be attached.`)
          continue
        }
        if (!dir && file.size > MAX_UPLOAD_BYTES) {
          setAttachError(`"${file.name}" is over the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB upload limit.`)
          continue
        }
        if (!next.some((a) => a.path === path)) {
          next.push({ name: file.name, mime: file.type || 'application/octet-stream', path, dir })
        }
        continue
      }
      if (!isAttachable(file)) {
        setAttachError(`"${file.name}" isn't a supported attachment type.`)
        continue
      }
      const total = next.reduce((n, a) => n + (a.dataUrl?.length ?? 0), 0)
      if (file.size > MAX_ATTACHMENT_BYTES || total + file.size * 1.4 > MAX_ATTACHMENT_BYTES) {
        setAttachError('Attachments are limited to 8 MB per message.')
        break
      }
      next.push({
        name: file.name,
        mime: file.type || 'application/octet-stream',
        dataUrl: await readFileAsDataUrl(file)
      })
    }
    setAttachments(next)
  }

  // Attach a whole folder of assets via the native directory picker (drag &
  // drop is the only other way in — a plain <input type="file"> can't mix
  // files and folders).
  const attachFolder = async (): Promise<void> => {
    if (!canChat) return
    const result = await window.api.chooseDirectory()
    if (!result.ok || !result.data) return
    const path = result.data
    const name = path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
    setAttachError(null)
    setAttachments((prev) =>
      prev.some((a) => a.path === path) ? prev : [...prev, { name, mime: 'inode/directory', path, dir: true }]
    )
  }

  useEffect(() => {
    const goOnline = (): void => setOnline(true)
    const goOffline = (): void => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  const slashQuery = slashQueryOf(input)
  const slashMatches = slashQuery !== null ? SLASH_COMMANDS.filter((c) => c.name.startsWith(slashQuery)) : []
  const slashOpen = !slashDismissed && slashMatches.length > 0

  useEffect(() => {
    const offPart = window.api.onChatPart((update: ChatPartUpdate) => {
      setMessages((msgs) => {
        const next = [...msgs]
        // Find (or start) the assistant message this part belongs to.
        let idx = next.findIndex((m) => m.id === update.messageID)
        if (idx === -1) {
          next.push({ id: update.messageID, role: 'assistant', content: '', parts: [], streaming: true })
          idx = next.length - 1
        }
        const msg = { ...next[idx], parts: [...(next[idx].parts ?? [])] }
        const parts = msg.parts!
        const part: AssistantPart = {
          id: update.partID,
          kind: update.kind,
          text: update.text ?? '',
          tool: update.tool
        }
        const existing = parts.findIndex((p) => p.id === update.partID)
        if (existing === -1) parts.push(part)
        else parts[existing] = part
        next[idx] = msg
        return next
      })
    })
    // Appends a part to the newest assistant message (screenshots and asset
    // previews arrive from the main process while the assistant is working).
    const appendToLatestAssistant = (part: AssistantPart): void => {
      setMessages((msgs) => {
        const next = [...msgs]
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].role === 'assistant') {
            const msg = { ...next[i], parts: [...(next[i].parts ?? [])] }
            msg.parts!.push(part)
            next[i] = msg
            return next
          }
        }
        // No assistant message yet — show the part in a message of its own.
        return [...next, { id: crypto.randomUUID(), role: 'assistant', content: '', parts: [part] }]
      })
    }
    // Screenshots taken during AI test runs flow into the conversation.
    const offShot = window.api.onGameTestShot((dataUrl: string) => {
      appendToLatestAssistant({ id: `shot-${Date.now()}-${Math.random()}`, kind: 'image', text: '', dataUrl })
    })
    // Generated 2D/3D asset previews — rendered with a feedback button.
    const offAsset = window.api.onAssetPreview((preview: AssetPreview) => {
      appendToLatestAssistant({ id: `asset-${Date.now()}-${Math.random()}`, kind: 'asset', text: '', asset: preview })
    })
    const offQuestion = window.api.onChatQuestion(setQuestion)
    const offQuestionDone = window.api.onChatQuestionDone((id: string) => {
      setQuestion((q) => (q?.id === id ? null : q))
    })
    const offDone = window.api.onChatDone((payload) => {
      setStreaming(false)
      setConnection(null)
      setResumeRunId(payload.resumeRunId ?? null)
      // However the turn ended, no question can still be waiting on it.
      setQuestion(null)
      // A turn that failed because the connection dropped (either we're
      // observably offline, or the error reads as a transport failure) is
      // resumable — remember it so the "Continue" banner appears on reconnect.
      const dropped =
        !payload.ok && !payload.cancelled && !!payload.error && (payload.recoverable ?? (!navigator.onLine || NETWORK_ERROR_RE.test(payload.error)))
      setInterrupted(dropped)
      setMessages((msgs) => {
        const finalized = msgs.map((m) => (m.streaming ? { ...m, streaming: false } : m))
        if (payload.cancelled) {
          // A cancel that raced /clear reports into an already-empty chat —
          // keep it empty instead of persisting a lone "Stopped." notice.
          if (finalized.length === 0) return finalized
          return [...finalized, { id: crypto.randomUUID(), role: 'error' as const, content: 'Stopped.' }]
        }
        if (!payload.ok && payload.error) {
          return [
            ...finalized,
            { id: crypto.randomUUID(), role: 'error' as const, content: dropped ? DISCONNECTED_NOTICE : payload.error }
          ]
        }
        return finalized
      })
      // The assistant may have created or edited game files — refresh views.
      onDoneRef.current()
    })
    return () => {
      offPart()
      offShot()
      offAsset()
      offQuestion()
      offQuestionDone()
      offDone()
    }
  }, [])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, streaming, question])

  const answerQuestion = (req: ChatQuestionRequest, answers: string[][]): void => {
    setQuestion(null)
    void window.api.chatAnswerQuestion(req.id, answers)
  }

  const dismissQuestion = (req: ChatQuestionRequest): void => {
    setQuestion(null)
    void window.api.chatRejectQuestion(req.id)
  }

  const send = async (text?: string): Promise<void> => {
    const message = (text ?? input).trim()
    if ((!message && attachments.length === 0) || streaming || !canChat || savingReasoningEffort || reasoningEffortDirty) return
    // Offline sends could only fail at the provider — the "Disconnected"
    // banner above the composer already explains why nothing goes through.
    if (!navigator.onLine) return
    setInterrupted(false)
    setResumeRunId(null)
    const outgoing = attachments
    if (message) {
      // Record for ↑/↓ recall — in memory and on disk (kept across /clear;
      // the 100-entry cap mirrors what chat-history.ts keeps on disk).
      setInputHistory((h) => (h[h.length - 1] === message ? h : [...h, message].slice(-100)))
      void window.api.chatAppendInput(projectPath, message)
    }
    setHistoryPos(null)
    draftRef.current = ''
    setInput('')
    setAttachments([])
    setAttachError(null)
    // Moving the conversation forward makes any pending undo permanent
    // (OpenCode trims the reverted messages on the next prompt).
    redoStackRef.current = []
    setMessages((msgs) => [
      ...msgs,
      { id: crypto.randomUUID(), role: 'user', content: message, attachments: outgoing }
    ])
    setStreaming(true)
    try {
      const result = await window.api.chatSend(message, outgoing)
      if (!result.ok) throw new Error(result.error)
    } catch (error) {
      setStreaming(false)
      setInput(current => current || message)
      setAttachments(current => current.length ? current : outgoing)
      setMessages((msgs) => [...msgs, { id: crypto.randomUUID(), role: 'error', content: error instanceof Error ? error.message : 'The assistant could not connect. Your message is ready to retry.' }])
    }
  }

  /** Notice bubble for a command that couldn't run (nothing to undo, …). */
  const appendNotice = (content: string): void =>
    setMessages((msgs) => [...msgs, { id: crypto.randomUUID(), role: 'error', content }])

  /**
   * Persist a transcript rewritten by /undo//redo right away, bypassing the
   * debounced effect: it skips empty arrays (mount protection), but undoing
   * back to an empty chat must still overwrite the saved file or the undone
   * turn would resurrect on the next open.
   */
  const commitRewrite = (next: ChatMessage[]): void => {
    cancelPendingSave()
    lastSavedRef.current = next
    setMessages(next)
    void window.api.chatSaveHistory(projectPath, stripEphemeral(next))
    // The revert touched project files under the open views — refresh them.
    onDoneRef.current()
  }

  const runCommand = async (command: SlashCommand): Promise<void> => {
    setInput('')
    setSlashIndex(0)
    if (command.name === 'clear') {
      cancelPendingSave()
      if (streaming) await window.api.chatCancel()
      // Also deletes the saved transcript (input history survives — ↑ still
      // recalls messages sent before the clear).
      const cleared = await window.api.chatNewSession()
      if (!cleared.ok) {
        appendNotice(`Could not clear the saved chat: ${cleared.error}`)
        return
      }
      redoStackRef.current = []
      setMessages([])
      setStreaming(false)
      setQuestion(null)
      setInterrupted(false)
      setHistoryPos(null)
      draftRef.current = ''
    }
    if (command.name === 'undo') {
      // The main process aborts a still-streaming turn first (native /undo
      // behavior), reverts the OpenCode session one user turn, and restores
      // the project files that turn changed.
      const result = await window.api.chatUndo()
      if (!result.ok) {
        appendNotice(result.error)
        return
      }
      // Drop the undone turn from the transcript. Assistant message ids are
      // OpenCode message ids (time-ordered strings, unlike the local uuids on
      // user bubbles), so the first assistant message newer than the
      // reverted-to id marks the undone turn; the user bubble before it opens
      // that turn. No such assistant message (the turn died before producing
      // one, or a trailing send never reached the session) → the last user
      // bubble is the one being undone. Slicing to the turn's start also
      // sweeps the turn's error/"Stopped." notices.
      const current = messagesRef.current
      let cut = current.findIndex((m) => m.role === 'assistant' && m.id > result.data.revertedTo)
      if (cut === -1) cut = current.length
      let start = cut - 1
      while (start >= 0 && current[start].role !== 'user') start--
      if (start < 0) return // no matching turn on screen — leave the transcript alone
      const removed = current.slice(start)
      redoStackRef.current.push(removed)
      commitRewrite(current.slice(0, start))
      // The undone message returns to the (just-cleared) composer for editing.
      const undone = removed.find((m) => m.role === 'user')
      if (undone?.content) setInput(undone.content)
    }
    if (command.name === 'redo') {
      if (redoStackRef.current.length === 0) {
        appendNotice('Nothing to redo.')
        return
      }
      const result = await window.api.chatRedo()
      if (!result.ok) {
        appendNotice(result.error)
        return
      }
      // Steps forward in the same order the undos stepped back (LIFO), the
      // same way the session's revert point just moved server-side.
      const restored = redoStackRef.current.pop()!
      commitRewrite([...messagesRef.current, ...restored])
    }
  }

  // Files can be dropped anywhere on the chat panel, not just the input box.
  // dragOver must preventDefault or the browser never fires the drop (and
  // Electron would try to navigate to the dropped file instead).
  const hasFiles = (e: React.DragEvent): boolean => e.dataTransfer.types.includes('Files')

  return (
    <div
      className="chat-panel"
      onDragEnter={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        dragDepth.current++
        setDragActive(true)
      }}
      onDragOver={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragActive(false)
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        dragDepth.current = 0
        setDragActive(false)
        // dataTransfer.items is only readable synchronously during the event;
        // webkitGetAsEntry is what tells a dropped folder apart from a file
        // (the File object alone can't — folders arrive with size 0, type '').
        const incoming: IncomingFile[] = []
        for (const item of Array.from(e.dataTransfer.items)) {
          const file = item.getAsFile()
          if (file) incoming.push({ file, dir: item.webkitGetAsEntry?.()?.isDirectory ?? false })
        }
        void addFiles(incoming)
      }}
    >
      {dragActive && (
        <div className="drop-overlay">
          <PlusIcon size={22} />
          <span>Drop files or folders to attach</span>
        </div>
      )}
      <div className="chat-panel-head">
        <div className="chat-panel-identity">
          <img src={solarMark} alt="" />
          <span>Solar Assistant</span>
        </div>
        <span className="chat-panel-state" aria-live="polite">
          <span className={`chat-panel-state-dot${!opencodeAvailable || !setup || !online ? ' unavailable' : !selectedModelReady ? ' setup' : streaming ? ' working' : ''}`} />
          {!opencodeAvailable ? 'Unavailable' : !setup ? 'Checking' : !selectedModelReady ? 'Setup needed' : !online ? 'Offline' : streaming ? 'Working' : 'Ready'}
        </span>
      </div>
      {opencodeAvailable && setup && !selectedModelReady && (
        <div className="assistant-setup-banner" role="status">
          <span>
            {setup.credentialStoreError
              ? 'Solar could not read a saved AI key. Re-enter it in AI settings; the project editor remains available.'
              : 'Connect an API provider to use Solar Assistant. You can keep working on your project without one.'}
          </span>
          <button className="btn btn-sm btn-ghost" onClick={onOpenSettings}>AI settings</button>
        </div>
      )}
      <ProductionPanel projectPath={projectPath} setup={setup} chatBusy={streaming} onOpenSettings={onOpenSettings} onOpenScene={onOpenScene} />
      <div className="chat-body">
      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            {!opencodeAvailable && (
              <div className="notice">
                The bundled OpenCode assistant is missing. Reinstall Solar, or run{' '}
                <code>npm run setup</code> in development.
              </div>
            )}
            <div className="chat-empty-intro">
              <span className="chat-empty-icon"><SparkIcon size={18} /></span>
              <h2>Start creating</h2>
              <p className="muted">Describe what you want to build and the assistant will write the game for you.</p>
            </div>
            <div className="chat-suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="suggestion-chip" disabled={!online || !canChat || streaming} onClick={() => void send(s)}>
                  <span>{s}</span><SendIcon size={12} />
                </button>
              ))}
            </div>
            <p className="chat-hint">
              Tip: type <code>/</code> for commands — <code>/clear</code> resets the chat, <code>/undo</code> takes
              back your last message and its changes. Press <code>↑</code> to recall messages you sent before.
            </p>
          </div>
        )}

        {messages.map((m, i) => {
          if (m.role === 'assistant') {
            return (
              <AssistantMessage
                key={m.id}
                msg={m}
                isFirst={messages[i - 1]?.role !== 'assistant'}
                onAssetFeedback={startAssetFeedback}
              />
            )
          }
          return (
            <div key={m.id} className={`msg ${m.role}`}>
              {m.attachments && m.attachments.length > 0 && (
                <div className="msg-attachments">
                  {m.attachments.map((a, j) =>
                    a.dataUrl && a.mime.startsWith('image/') ? (
                      <img key={j} className="attach-thumb" src={a.dataUrl} alt={a.name} title={a.name} />
                    ) : (
                      <span key={j} className="attach-file" title={a.path ?? a.name}>
                        {a.dir ? <FolderIcon size={11} /> : <FileIcon size={11} />} {a.name}
                      </span>
                    )
                  )}
                </div>
              )}
              {m.content && <div className="msg-content">{m.content}</div>}
            </div>
          )
        })}

        {question && (
          <QuestionCard
            key={question.id}
            request={question}
            onAnswer={(answers) => answerQuestion(question, answers)}
            onDismiss={() => dismissQuestion(question)}
          />
        )}

        {streaming && !question && !messages.some((m) => m.role === 'assistant' && m.streaming) && (
          <div className="msg assistant">
            <span className="typing-dots">
              <span />
              <span />
              <span />
            </span>
          </div>
        )}
      </div>

      <div className="chat-inputbar">
        {online && connection && <div className={`chat-status ${connection.status==='reconnecting'?'offline':'reconnected'}`} role="status" aria-live="polite">
          <span className="status-dot" /><span>{connection.status==='reconnecting'?'Reconnecting…':'Reconnected — continuing your work.'}{connection.status==='reconnecting' && connection.attempt ? ` Attempt ${connection.attempt}/${connection.maxAttempts}.` : ''}{connection.status==='reconnecting' && connection.nextAttemptAt ? ` Retrying in ${Math.max(0,Math.ceil((Date.parse(connection.nextAttemptAt)-connectionNow)/1000))}s.` : ''}</span>
        </div>}
        {!online && (
          <div className="chat-status offline" role="status">
            <span className="status-dot" />
            <span>
              {streaming
                ? 'Reconnecting automatically — waiting for the internet…'
                : 'Disconnected — no internet connection.'}
            </span>
          </div>
        )}
        {online && interrupted && !streaming && (
          <div className="chat-status reconnected" role="status">
            <span className="status-dot" />
            <span>Automatic reconnect paused.</span>
            <button
              className="btn btn-sm btn-primary continue-btn"
              onClick={() => {
                if (!resumeRunId) { void send('Continue where you left off.'); return }
                setStreaming(true);setInterrupted(false)
                void window.api.productionResume(resumeRunId).then(result=>{if(!result.ok){setStreaming(false);setInterrupted(true);setMessages(previous=>[...previous,{id:crypto.randomUUID(),role:'error',content:result.error}])}}).catch(()=>{setStreaming(false);setInterrupted(true)})
              }}
            >
              Continue
            </button>
          </div>
        )}
        {slashOpen && (
          <div className="slash-pop">
            {slashMatches.map((command, i) => (
              <button
                key={command.name}
                className={i === slashIndex ? 'slash-item selected' : 'slash-item'}
                onMouseEnter={() => setSlashIndex(i)}
                onClick={() => void runCommand(command)}
              >
                <span className="slash-name">/{command.name}</span>
                <span className="slash-desc">{command.description}</span>
              </button>
            ))}
          </div>
        )}
        <div className="chat-inputbox">
          {(attachments.length > 0 || attachError) && (
            <div className="attach-row">
              {attachments.map((a, i) => (
                <span key={i} className="attach-chip" title={a.path ?? a.name}>
                  {a.dataUrl && a.mime.startsWith('image/') ? (
                    <img className="attach-chip-thumb" src={a.dataUrl} alt="" />
                  ) : a.dir ? (
                    <FolderIcon size={11} />
                  ) : (
                    <FileIcon size={11} />
                  )}
                  <span className="attach-chip-name">{a.name}</span>
                  <button
                    className="attach-remove"
                    title="Remove attachment"
                    onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <XIcon size={9} />
                  </button>
                </span>
              ))}
              {attachError && <span className="attach-error">{attachError}</span>}
            </div>
          )}
          <textarea
            ref={textareaRef}
            className="chat-textarea"
            rows={3}
            placeholder={canChat ? 'Build me a game where…  (/ for commands)' : 'Connect a chat model to use the assistant'}
            disabled={!canChat}
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              setSlashDismissed(false)
              setSlashIndex(0)
              // Typing ends history browsing — the edit becomes the draft.
              setHistoryPos(null)
            }}
          onKeyDown={(e) => {
            if (slashOpen) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSlashIndex((i) => (i + 1) % slashMatches.length)
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length)
                return
              }
              if (e.key === 'Tab') {
                e.preventDefault()
                setInput(`/${slashMatches[slashIndex].name}`)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setSlashDismissed(true)
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void runCommand(slashMatches[slashIndex])
                return
              }
            }
            // ↑/↓ recall previously sent messages (shell-style). ↑ starts
            // browsing when the composer is empty or the caret is at the very
            // start; while the text still equals the recalled entry the
            // arrows keep cycling, and any edit ends browsing, returning the
            // arrows to normal caret movement.
            const browsing = historyPos !== null && input === inputHistory[historyPos]
            if (e.key === 'ArrowUp' && inputHistory.length > 0) {
              const caretAtStart = e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0
              if (browsing || input === '' || caretAtStart) {
                e.preventDefault()
                if (!browsing) draftRef.current = input
                const next = browsing && historyPos !== null ? Math.max(0, historyPos - 1) : inputHistory.length - 1
                setHistoryPos(next)
                setInput(inputHistory[next])
                moveCaretToEnd()
                return
              }
            }
            if (e.key === 'ArrowDown' && browsing && historyPos !== null) {
              e.preventDefault()
              if (historyPos >= inputHistory.length - 1) {
                // Past the newest entry: back to whatever was being typed.
                setHistoryPos(null)
                setInput(draftRef.current)
              } else {
                setHistoryPos(historyPos + 1)
                setInput(inputHistory[historyPos + 1])
              }
              moveCaretToEnd()
              return
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
          />
          <div className="inputbox-bar">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ATTACH_ACCEPT}
              style={{ display: 'none' }}
              onChange={(e) => {
                void addFiles(Array.from(e.target.files ?? []).map((file) => ({ file, dir: false })))
                e.target.value = ''
              }}
            />
            <div className="inputbar-tools">
              <div className="attach-btns">
                <button
                  className="attach-btn"
                  disabled={!canChat}
                  title="Attach files, images, or .zip asset packs — or drag & drop them (folders too) into the chat"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <PlusIcon size={14} />
                </button>
                <button
                  className="attach-btn"
                  disabled={!canChat}
                  title="Attach a folder of assets — uploaded for the assistant when you send"
                  onClick={() => void attachFolder()}
                >
                  <FolderIcon size={13} />
                </button>
              </div>
              {setup?.chat.configured && reasoningChoices.length > 0 && (
                <div className="reasoning-picker" ref={reasoningPickerRef}>
                  <button
                    type="button"
                    className={`reasoning-trigger${reasoningEffortDirty ? ' dirty' : ''}`}
                    disabled={streaming || savingReasoningEffort}
                    title="Choose reasoning effort · Ctrl+Shift+M"
                    aria-label={`Choose reasoning effort. ${formattedModelName}, ${reasoningEffortLabel}.`}
                    aria-haspopup="menu"
                    aria-expanded={reasoningMenuOpen}
                    onClick={() => setReasoningMenuOpen((open) => !open)}
                  >
                    <span className="reasoning-trigger-model">{formattedModelName}</span>
                    <span className="reasoning-trigger-level">{reasoningEffortLabel}</span>
                    {savingReasoningEffort
                      ? <span className="reasoning-save-spinner" aria-label="Saving reasoning effort" />
                      : <DownArrowIcon size={11} />}
                  </button>
                  {reasoningMenuOpen && (
                    <div className="reasoning-menu" role="menu" aria-label="Reasoning effort">
                      <div className="reasoning-menu-heading">Choose reasoning effort</div>
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={effectiveReasoningEffort === 'default'}
                        className={`reasoning-menu-item${effectiveReasoningEffort === 'default' ? ' selected' : ''}`}
                        disabled={savingReasoningEffort}
                        onClick={() => {
                          setReasoningEffort('default')
                          setReasoningEffortDirty(setup.chat.effort !== 'default')
                          setReasoningEffortError(null)
                          void persistReasoningEffort('default')
                        }}
                      >
                        <span>Model default</span>
                        <span className="reasoning-menu-note">Provider setting</span>
                        {effectiveReasoningEffort === 'default' && <span className="reasoning-menu-check">✓</span>}
                      </button>
                      {[...reasoningChoices].reverse().map(({ value, label }) => (
                        <button
                          key={value}
                          type="button"
                          role="menuitemradio"
                          aria-checked={effectiveReasoningEffort === value}
                          className={`reasoning-menu-item${effectiveReasoningEffort === value ? ' selected' : ''}`}
                          disabled={savingReasoningEffort}
                          onClick={() => {
                            setReasoningEffort(value)
                            setReasoningEffortDirty(value !== setup.chat.effort)
                            setReasoningEffortError(null)
                            void persistReasoningEffort(value)
                          }}
                        >
                          <span>{label}</span>
                          <span className="reasoning-menu-note">
                            {value === 'max' ? 'Maximum' : value === 'xhigh' ? 'Very high' : value === 'high' ? 'High' : value === 'medium' ? 'Balanced' : 'Fast'}
                          </span>
                          {effectiveReasoningEffort === value && <span className="reasoning-menu-check">✓</span>}
                        </button>
                      ))}
                      {reasoningEffortError && (
                        <div className="reasoning-save-error" role="alert" title={reasoningEffortError}>
                          Could not save: {reasoningEffortError}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
            {streaming ? (
              <button className="send-btn stop" title="Stop" onClick={() => void window.api.chatCancel()}>
                <StopIcon size={13} />
              </button>
            ) : (
              <button
                className="send-btn"
                title={!canChat ? 'Connect the selected chat model to send' : online ? 'Send' : 'No internet connection'}
                disabled={(!input.trim() && attachments.length === 0) || !online || !canChat || savingReasoningEffort || reasoningEffortDirty}
                onClick={() => void send()}
              >
                <SendIcon size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
      </div>
    </div>
  )
}
