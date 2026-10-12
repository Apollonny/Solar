import type { BrowserWindow } from 'electron'

/**
 * Windows in-app Godot surfaces: both scene-editor backends create their
 * editor HWND as a direct child of Solar. The game runner can also reparent
 * its window into a native child container when DPI contexts match.
 * Ports the Godot editor's in-editor game view glue (embed_process and
 * friends, platform/windows/display_server_windows.cpp, Godot 4.7): find the
 * Godot window by process id, size it to the stage, show/hide it, WM_CLOSE to
 * close, and a focus dance on detach. Child windows follow Solar through the
 * native parent relationship; owned game windows follow native move messages.
 *
 * Implemented with koffi (runtime FFI) rather than a compiled N-API addon
 * because the Windows installer is cross-built from macOS: an MSVC-compiled
 * .node can only be produced on Windows, so a native winhost addon could
 * never make it into the package and embedding silently degraded to a
 * free-floating window. The Win32 surface needed here is tiny and cold
 * (a handful of calls per resize/move), so FFI overhead is irrelevant.
 * koffi's prebuilt win32 binary is staged by fetch-vendor.mjs and shipped
 * into resources/koffi/, one of koffi's built-in Electron search paths.
 *
 * Everything here must stay best-effort safe on a live user desktop: every
 * call re-validates the window handle (the game can die at any moment, and
 * HWNDs are recycled by the OS).
 */

export interface WinHost {
  /** One find-by-pid attempt; false = Godot window doesn't exist yet, retry. */
  attach(hostHandle: Buffer, pid: number, x: number, y: number, w: number, h: number, visible: boolean): boolean
  /** True child HWND follows the Solar window without move polling. */
  embedAsChild(): boolean
  /** Whether attach() found a child HWND created by Godot itself. */
  isChildEmbedded(): boolean
  /** Follow host movement through Electron window messages; false means use polling. */
  trackMoves(hostWindow: BrowserWindow, onMove: () => void): boolean
  /** Screen physical pixels. */
  setFrame(x: number, y: number, w: number, h: number): void
  setVisible(visible: boolean): void
  /** Post WM_CLOSE — the clean close request (what the Godot editor sends). */
  requestClose(): void
  /** User-initiated shortcut, sent only when this window becomes foreground. */
  focusAndSendShortcut(keys: number[]): boolean
  detach(): void
  /** Top-left of the virtual desktop — the origin of Godot's --position space. */
  virtualScreenOrigin(): { x: number; y: number }
}

// Win32 constants (winuser.h) — koffi binds functions, not defines.
const GW_OWNER = 4
const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOZORDER = 0x0004
const SWP_NOACTIVATE = 0x0010
const SWP_FRAMECHANGED = 0x0020
const SWP_ASYNCWINDOWPOS = 0x4000
const SW_HIDE = 0
const SW_SHOW = 5
const SW_SHOWNA = 8
const WM_CLOSE = 0x0010
const WS_POPUP = 0x80000000
const WS_CHILD = 0x40000000
const WS_VISIBLE = 0x10000000
const WS_CLIPCHILDREN = 0x02000000
const WS_EX_TOPMOST = 0x00000008
const HWND_BOTTOM = 1
const HWND_TOP = 0
const HWND_TOPMOST = -1
const SM_XVIRTUALSCREEN = 76
const SM_YVIRTUALSCREEN = 77
const WM_MOVE = 0x0003
const WM_MOVING = 0x0216
const WM_WINDOWPOSCHANGED = 0x0047

/**
 * A native window handle as the signed integer Win32 traffics in. Electron's
 * getNativeWindowHandle() buffer holds the raw pointer; read it *signed* so a
 * sign-extended HWND (top bit of the 32-bit handle set) round-trips as the
 * same value Win32 APIs return — HWNDs only carry 32 significant bits, so the
 * magnitude always fits a JS number exactly.
 */
export function nativeHandleInt(handle: Buffer): number {
  return Number(handle.length >= 8 ? handle.readBigInt64LE(0) : BigInt(handle.readInt32LE(0)))
}

/** The Electron window's HWND as the integer string Godot's --wid expects. */
export function windowHandleArg(win: BrowserWindow): string {
  return String(nativeHandleInt(win.getNativeWindowHandle()))
}

export function createWinHost(): WinHost {
  // Lazy so non-Windows platforms never load the FFI runtime.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require('koffi') as typeof import('koffi')
  const user32 = koffi.load('user32.dll')

  // Handles travel as plain `intptr` integers instead of koffi's opaque
  // pointer objects so HWNDs can be compared and stored naturally.
  const FindWindowExW = user32.func(
    'intptr __stdcall FindWindowExW(intptr parent, intptr childAfter, const char16_t *cls, const char16_t *title)'
  )
  const GetWindowThreadProcessId = user32.func(
    'uint32_t __stdcall GetWindowThreadProcessId(intptr hwnd, _Out_ uint32_t *pid)'
  )
  const AttachThreadInput = user32.func('int __stdcall AttachThreadInput(uint32_t from, uint32_t to, int attach)')
  const GetFocus = user32.func('intptr __stdcall GetFocus()')
  const SetFocus = user32.func('intptr __stdcall SetFocus(intptr hwnd)')
  const keybd_event = user32.func('void __stdcall keybd_event(uint8_t key, uint8_t scan, uint32_t flags, uintptr extraInfo)')
  const GetCurrentThreadId = koffi.load('kernel32.dll').func('uint32_t __stdcall GetCurrentThreadId()')
  const GetWindow = user32.func('intptr __stdcall GetWindow(intptr hwnd, uint32_t cmd)')
  const GetParent = user32.func('intptr __stdcall GetParent(intptr hwnd)')
  const GetWindowLongPtrW = user32.func('intptr __stdcall GetWindowLongPtrW(intptr hwnd, int index)')
  const IsWindow = user32.func('int __stdcall IsWindow(intptr hwnd)')
  const IsWindowVisible = user32.func('int __stdcall IsWindowVisible(intptr hwnd)')
  const SetWindowPos = user32.func(
    'int __stdcall SetWindowPos(intptr hwnd, intptr insertAfter, int x, int y, int w, int h, uint32_t flags)'
  )
  const pointType = koffi.struct({ x: 'int32_t', y: 'int32_t' })
  const ScreenToClient = user32.func('__stdcall', 'ScreenToClient', 'int', [
    'intptr', koffi.inout(koffi.pointer(pointType))
  ])
  const windowRectType = koffi.struct({ left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' })
  const GetWindowRect = user32.func('__stdcall', 'GetWindowRect', 'int', [
    'intptr', koffi.out(koffi.pointer(windowRectType))
  ])
  // ShowWindow can wait while a foreign window thread handles its message and
  // freeze Electron's main thread; ShowWindowAsync posts and returns.
  const ShowWindowAsync = user32.func('int __stdcall ShowWindowAsync(intptr hwnd, int cmd)')
  const SetForegroundWindow = user32.func('int __stdcall SetForegroundWindow(intptr hwnd)')
  const GetForegroundWindow = user32.func('intptr __stdcall GetForegroundWindow()')
  const GetAsyncKeyState = user32.func('int16_t __stdcall GetAsyncKeyState(int key)')
  const MapVirtualKeyW = user32.func('uint32_t __stdcall MapVirtualKeyW(uint32_t code, uint32_t mapType)')
  const PostMessageW = user32.func('int __stdcall PostMessageW(intptr hwnd, uint32_t msg, uintptr wparam, intptr lparam)')
  const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int index)')
  const CreateWindowExW = user32.func(
    'intptr __stdcall CreateWindowExW(uint32_t exStyle, const char16_t *cls, const char16_t *title, uint32_t style, int x, int y, int w, int h, intptr owner, intptr menu, intptr instance, intptr param)'
  )
  const DestroyWindow = user32.func('int __stdcall DestroyWindow(intptr hwnd)')
  let gameHwnd = 0
  let hostHwnd = 0
  let childEmbedded = false
  let childContainer = 0
  let restoreChild: (() => void) | null = null
  let lastFrame = { x: 0, y: 0, w: 1, h: 1 }
  let frameInFlight: typeof lastFrame | null = null
  let visibleWanted = true
  let moveHooks: number[] = []
  let trackingWindow: BrowserWindow | null = null

  const stopMoveTracking = (): void => {
    if (trackingWindow && !trackingWindow.isDestroyed()) {
      for (const message of moveHooks) {
        if (trackingWindow.isWindowMessageHooked(message)) trackingWindow.unhookWindowMessage(message)
      }
    }
    moveHooks = []
    trackingWindow = null
  }

  // The game window handle is only usable while it identifies a live window;
  // drop it the moment it goes stale (the OS recycles HWND values).
  const gameWindowAlive = (): boolean => {
    if (gameHwnd && !IsWindow(gameHwnd)) gameHwnd = 0
    return gameHwnd !== 0
  }

  // Same SetWindowPos flags as DisplayServerWindows::embed_process: keep the
  // current z-order (owned windows already float above the owner), never
  // steal activation, and don't block on the game's thread.
  const positionGameWindow = (x: number, y: number, w: number, h: number, raise = false): void => {
    lastFrame = { x, y, w, h }
    let positioned = true
    if (childEmbedded) {
      const point = { x, y }
      if (!ScreenToClient(hostHwnd, point)) {
        frameInFlight = null
        return
      }
      if (childContainer) {
        positioned = Boolean(SetWindowPos(childContainer, HWND_TOP, point.x, point.y, Math.max(1, w), Math.max(1, h),
          (raise ? SWP_FRAMECHANGED : SWP_NOZORDER) | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS))
        positioned = Boolean(SetWindowPos(gameHwnd, HWND_TOP, 0, 0, Math.max(1, w), Math.max(1, h),
          (raise ? SWP_FRAMECHANGED : SWP_NOZORDER) | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS)) && positioned
      } else {
        positioned = Boolean(SetWindowPos(gameHwnd, HWND_TOP, point.x, point.y, Math.max(1, w), Math.max(1, h),
          (raise ? SWP_FRAMECHANGED : SWP_NOZORDER) | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS))
      }
    } else {
      positioned = Boolean(SetWindowPos(gameHwnd, HWND_BOTTOM, x, y, Math.max(1, w), Math.max(1, h),
        SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS))
    }
    frameInFlight = positioned && !childEmbedded ? lastFrame : null
  }

  const windowMatchesFrame = (rect: { left: number; top: number; right: number; bottom: number }, frame: typeof lastFrame): boolean =>
    rect.left === frame.x && rect.top === frame.y &&
    rect.right - rect.left === Math.max(1, frame.w) &&
    rect.bottom - rect.top === Math.max(1, frame.h)

  // LibGodot shares Electron's process id. Search direct Engine children
  // first so an unrelated Solar-owned popup cannot be mistaken for Godot.
  // Owned top-level game windows still use the search below.
  const findGameWindow = (pid: number, host: number): number => {
    const pidOut = [0]
    let hwnd = 0
    while ((hwnd = Number(FindWindowExW(host, hwnd, 'Engine', null))) !== 0) {
      GetWindowThreadProcessId(hwnd, pidOut)
      const style = Number(GetWindowLongPtrW(hwnd, -16)) >>> 0
      if (pidOut[0] === pid && (style & WS_CHILD) !== 0 && Number(GetParent(hwnd)) === host) return hwnd
    }

    // Mirrors Godot's embed_process window discovery for the standalone
    // executable fallback: top-level Godot windows are owned by --wid.
    hwnd = 0
    while ((hwnd = Number(FindWindowExW(0, hwnd, null, null))) !== 0) {
      GetWindowThreadProcessId(hwnd, pidOut)
      if (pidOut[0] === pid && Number(GetWindow(hwnd, GW_OWNER)) === host) return hwnd
    }
    return 0
  }

  return {
    attach(hostHandle, pid, x, y, w, h, visible) {
      const host = nativeHandleInt(hostHandle)
      const found = findGameWindow(pid, host)
      if (!found) return false

      gameHwnd = found
      hostHwnd = host
      frameInFlight = null
      visibleWanted = visible
      const style = Number(GetWindowLongPtrW(gameHwnd, -16)) >>> 0
      if ((style & WS_CHILD) !== 0 && Number(GetParent(gameHwnd)) === hostHwnd) {
        // A native child already belongs to the Solar window. Don't reparent
        // it or wrap it in another STATIC container.
        childEmbedded = true
        childContainer = 0
      }

      // Chromium's render HWND is another child of the Solar window. Put the
      // native scene above it so the editor is visible inside the stage.
      positionGameWindow(x, y, w, h, childEmbedded)
      // This initial show happens directly after the user opens the editor.
      // Never synchronously activate a foreign HWND from Electron's main thread.
      ShowWindowAsync(gameHwnd, visible ? SW_SHOW : SW_HIDE)
      return true
    },

    embedAsChild() {
      if (!gameWindowAlive() || !hostHwnd || childEmbedded) return childEmbedded
      let restoreStyle: (() => void) | null = null
      let setParent: ((child: number, parent: number) => number) | null = null
      let container = 0
      let parentChanged = false
      const cleanupFailedEmbed = (): void => {
        if (parentChanged && gameWindowAlive()) {
          ShowWindowAsync(gameHwnd, SW_HIDE)
          setParent?.(gameHwnd, 0)
        }
        restoreStyle?.()
        if (container) DestroyWindow(container)
      }
      try {
        // SetParent across processes can reset DPI awareness when the two
        // windows differ. Fall back to the owned-window path in that case.
        const GetWindowDpiAwarenessContext = user32.func('intptr __stdcall GetWindowDpiAwarenessContext(intptr hwnd)')
        const AreDpiAwarenessContextsEqual = user32.func('int __stdcall AreDpiAwarenessContextsEqual(intptr a, intptr b)')
        if (!AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(gameHwnd), GetWindowDpiAwarenessContext(hostHwnd))) return false

        const point = { x: lastFrame.x, y: lastFrame.y }
        if (!ScreenToClient(hostHwnd, point)) return false
        container = Number(CreateWindowExW(0, 'STATIC', '',
          WS_CHILD | WS_CLIPCHILDREN | (visibleWanted ? WS_VISIBLE : 0),
          point.x, point.y, Math.max(1, lastFrame.w), Math.max(1, lastFrame.h),
          hostHwnd, 0, 0, 0))
        if (!container) return false

        const GetWindowLongPtrW = user32.func('intptr __stdcall GetWindowLongPtrW(intptr hwnd, int index)')
        const SetWindowLongPtrW = user32.func('intptr __stdcall SetWindowLongPtrW(intptr hwnd, int index, intptr value)')
        setParent = user32.func('intptr __stdcall SetParent(intptr child, intptr parent)')
        const GetAncestor = user32.func('intptr __stdcall GetAncestor(intptr hwnd, uint32_t flags)')
        const originalStyle = Number(GetWindowLongPtrW(gameHwnd, -16))
        const childStyle = (originalStyle & ~WS_POPUP) | WS_CHILD
        SetWindowLongPtrW(gameHwnd, -16, childStyle)
        restoreStyle = () => { SetWindowLongPtrW(gameHwnd, -16, originalStyle) }
        const appliedStyle = Number(GetWindowLongPtrW(gameHwnd, -16))
        if ((appliedStyle & WS_CHILD) === 0 || (appliedStyle & WS_POPUP) !== 0) {
          cleanupFailedEmbed()
          return false
        }
        setParent(gameHwnd, container)
        parentChanged = Number(GetAncestor(gameHwnd, 1)) === container
        if (!parentChanged) {
          cleanupFailedEmbed()
          return false
        }
        restoreStyle = null
        childEmbedded = true
        childContainer = container
        restoreChild = () => {
          if (!gameWindowAlive()) return
          ShowWindowAsync(gameHwnd, SW_HIDE)
          setParent?.(gameHwnd, 0)
          SetWindowLongPtrW(gameHwnd, -16, originalStyle)
        }
        positionGameWindow(lastFrame.x, lastFrame.y, lastFrame.w, lastFrame.h, true)
        return true
      } catch (err) {
        console.warn('[solar] native child embedding unavailable:', err)
        if (!childEmbedded) cleanupFailedEmbed()
        return childEmbedded
      }
    },

    isChildEmbedded() {
      return gameWindowAlive() && childEmbedded
    },

    trackMoves(hostWindow, onMove) {
      if (!gameWindowAlive() || !hostHwnd || hostWindow.isDestroyed()) return false
      // A real child HWND follows Solar's movement directly.
      if (childEmbedded) return true
      if (nativeHandleInt(hostWindow.getNativeWindowHandle()) !== hostHwnd) return false
      stopMoveTracking()
      trackingWindow = hostWindow
      try {
        for (const message of [WM_MOVING, WM_MOVE, WM_WINDOWPOSCHANGED]) {
          if (hostWindow.isWindowMessageHooked(message)) continue
          hostWindow.hookWindowMessage(message, () => {
            if (trackingWindow !== hostWindow || !gameWindowAlive()) return
            try { onMove() } catch (err) {
              console.warn('[solar] native window tracking callback failed:', err)
            }
          })
          if (hostWindow.isWindowMessageHooked(message)) moveHooks.push(message)
        }
        if (moveHooks.length > 0) return true
        trackingWindow = null
        return false
      } catch (err) {
        stopMoveTracking()
        console.warn('[solar] Electron window-message tracking unavailable:', err)
        return false
      }
    },

    setFrame(x, y, w, h) {
      if (!gameWindowAlive()) return
      const desired = { x, y, w: Math.max(1, w), h: Math.max(1, h) }
      // Keep the newest requested position while the asynchronous Win32 call
      // is in flight. The location-change hook applies it as soon as Godot
      // confirms the previous position.
      lastFrame = desired
      const current = { left: 0, top: 0, right: 0, bottom: 0 }
      const hasCurrent = Boolean(GetWindowRect(gameHwnd, current))

      // SetWindowPos is asynchronous for foreign window threads. Keep one
      // request in flight and coalesce drag updates to the latest stage rect;
      // otherwise stale window-position messages trail behind Solar.
      if (frameInFlight) {
        if (!hasCurrent || windowMatchesFrame(current, frameInFlight)) frameInFlight = null
        else return
      }
      if (hasCurrent && windowMatchesFrame(current, desired)) return
      positionGameWindow(desired.x, desired.y, desired.w, desired.h)
    },

    setVisible(visible) {
      visibleWanted = visible
      if (childContainer) ShowWindowAsync(childContainer, visible ? SW_SHOWNA : SW_HIDE)
      if (gameWindowAlive()) {
        ShowWindowAsync(gameHwnd, visible ? SW_SHOWNA : SW_HIDE)
        if (visible && childEmbedded) {
          SetWindowPos(childContainer || gameHwnd, HWND_TOP, 0, 0, 0, 0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS)
        }
      }
    },

    requestClose() {
      if (gameWindowAlive()) PostMessageW(gameHwnd, WM_CLOSE, 0, 0)
    },

    focusAndSendShortcut(keys) {
      if (!gameWindowAlive() || keys.length === 0) return false
      // Avoid combining a Solar command with keys the user is already holding.
      if ([0x10, 0x11, 0x12, 0x5b, 0x5c].some((vk) => (Number(GetAsyncKeyState(vk)) & 0x8000) !== 0)) return false
      if (!SetForegroundWindow(hostHwnd) && Number(GetForegroundWindow()) !== hostHwnd) return false
      if (!IsWindowVisible(gameHwnd)) return false

      // Godot owns a separate Win32 input queue. Attach it temporarily so the
      // Solar toolbar can focus the owned editor window and send real keyboard
      // state. Posting WM_KEYDOWN directly does not update GetKeyState(); Godot
      // then sees Ctrl+F1 as plain F1 and opens the Help dialog instead.
      const currentThread = Number(GetCurrentThreadId())
      const threadOut = [0]
      const gameThread = Number(GetWindowThreadProcessId(gameHwnd, threadOut))
      if (!gameThread) return false
      const previousFocus = Number(GetFocus())
      const attached = gameThread !== currentThread && Boolean(AttachThreadInput(currentThread, gameThread, 1))
      if (gameThread !== currentThread && !attached) return false
      try {
        SetFocus(gameHwnd)
        if (Number(GetFocus()) !== gameHwnd) return false
        for (const key of keys) {
          keybd_event(key, Number(MapVirtualKeyW(key, 0)) & 0xff, 0, 0)
        }
        for (const key of [...keys].reverse()) {
          keybd_event(key, Number(MapVirtualKeyW(key, 0)) & 0xff, 0x0002, 0)
        }
        return true
      } finally {
        // Let Godot's worker-thread message pump consume both key edges before
        // returning focus to Chromium and detaching the shared input queue.
        setTimeout(() => {
          if (previousFocus && IsWindow(previousFocus)) SetFocus(previousFocus)
          if (attached) AttachThreadInput(currentThread, gameThread, 0)
        }, 100)
      }
    },

    // The temp-window dance is Godot's documented workaround (see
    // remove_embedded_process): when the embedded window is closed while it
    // has focus, the host window looks focused but is not truly activated;
    // opening and closing a topmost popup forces Windows to recompute
    // activation. The predefined STATIC class stands in for the throwaway
    // DefWindowProc class Godot registers — FFI can't cheaply supply a
    // WNDPROC pointer, and the window only exists for a microsecond.
    detach() {
      stopMoveTracking()
      restoreChild?.()
      restoreChild = null
      childEmbedded = false
      if (childContainer) DestroyWindow(childContainer)
      childContainer = 0
      if (hostHwnd) {
        const tmp = Number(CreateWindowExW(WS_EX_TOPMOST, 'STATIC', '', WS_POPUP | WS_VISIBLE, 0, 0, 1, 1, hostHwnd, 0, 0, 0))
        if (tmp) {
          SetWindowPos(tmp, HWND_TOPMOST, 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE)
          DestroyWindow(tmp)
        }
        SetForegroundWindow(hostHwnd)
      }
      gameHwnd = 0
      hostHwnd = 0
      frameInFlight = null
    },

    // Godot's --position argument is in Godot screen space, whose origin is
    // the top-left-most corner of the virtual desktop (_get_screens_origin in
    // display_server_windows.cpp) — Win32 screen coordinates minus this.
    virtualScreenOrigin() {
      return { x: Number(GetSystemMetrics(SM_XVIRTUALSCREEN)), y: Number(GetSystemMetrics(SM_YVIRTUALSCREEN)) }
    }
  }
}

let cached: WinHost | null | undefined

/**
 * The embedding glue, or null where unavailable (non-Windows, or koffi failed
 * to load — e.g. its prebuilt binary missing from the package). Callers fall
 * back to free-floating windowed play on null.
 */
export function winhost(): WinHost | null {
  if (cached === undefined) {
    if (process.platform !== 'win32') {
      cached = null
    } else {
      try {
        cached = createWinHost()
      } catch (err) {
        console.error('[solar] winhost unavailable:', err)
        cached = null
      }
    }
  }
  return cached
}
