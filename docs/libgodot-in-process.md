# Solar's in-process Godot editor

## Target

Run the Godot 2D/3D editor from a pinned LibGodot **editor** build loaded in
Electron's main process. Solar embeds the editor window as a native child of
the scene area and retains control of project, window, and editor lifecycle.
The pinned `solar-godot.exe` scene workspace handles later editor sessions and
in-process startup failures with the same native child-window behavior.

## Current boundary

Solar also packages upstream Godot 4.7.1 as `godot.exe` for helper processes,
game runs and the separately opened editor. The embedded fallback in
`scene-editor.ts` launches Solar's source-built `solar-godot.exe` with
`--editor --wid`; it creates a direct child of Solar's HWND. The LibGodot
backend uses the same native child attachment, with Godot's frame loop inside
Electron's main process.

The upstream 4.7.1 LibGodot build exports instance creation and destruction.
An instance's `start`, `iteration`, and `stop` methods are exposed through its
GDExtension object; they are not simple C exports. The Windows implementation
also enforces one instance per process and explicitly leaves reinitialization
unsupported. The public API does not adopt a supplied Electron rendering
surface before Godot creates its window. These are engineering constraints,
not packaging choices:

- [LibGodot C API](https://github.com/godotengine/godot/blob/4.7.1-stable/core/extension/libgodot.h)
- [Windows instance lifecycle](https://github.com/godotengine/godot/blob/4.7.1-stable/platform/windows/libgodot_windows.cpp)
- [GodotInstance lifecycle](https://github.com/godotengine/godot/blob/4.7.1-stable/core/extension/godot_instance.cpp)
- [Native surface API proposal](https://github.com/godotengine/godot-proposals/issues/14435)

## Integration design

1. Build from the exact Godot 4.7.1 commit with `target=editor` and
   `library_type=shared_library`. `npm run build:libgodot` prepares that
   artifact and a patched editor executable on Windows x64. Both are staged
   in `vendor/godot/win32`; their manifests and SHA-256 digests are checked
   before Solar starts either backend.
2. The native bridge exposes editor creation, startup, iteration, and shutdown
   as C calls against the same Godot source revision. A Node worker thread
   drives those calls so Electron's JavaScript event loop never executes a
   blocking Godot frame. Solar does not register a host GDExtension. The bridge
   also passes a log path so early native startup failures are inspectable.
3. Host the DLL on a dedicated worker thread **inside Electron's main OS process**.
   Godot's frame loop does not block Electron's JavaScript event loop. A native
   Godot crash will terminate Solar. The upstream one-instance lifetime limit
   means later scene sessions in one Solar run use `solar-godot.exe`.
4. Create LibGodot's editor HWND as a native `WS_CHILD` of Solar during
   `CreateWindowExW`. Convert its requested screen rectangle to Solar client
   coordinates before creation. Windows moves the child with the main window;
   stage and resize updates only adjust its local bounds. Both editor backends
   request Vulkan because the OpenGL compatibility renderer produced a black
   child surface under Electron on the tested NVIDIA driver. The source-built
   executable fallback uses the same creation-time child-window patch, gated
   to Solar's exact parent HWND.
5. The library backend is selected when a matching DLL and manifest are
   installed. `SOLAR_LIBGODOT=0` forces the executable recovery path. Godot
   4.7.1 keeps a process-global LibGodot instance pointer and rejects a second
   instance. Its Windows destroy function deliberately does not clear that
   pointer; the source comment says to wait until engine reinitialization is
   supported. The editor's Project Manager route also relies on restarting
   Godot after cleanup. Solar therefore uses `solar-godot.exe` for later
   scene-editor sessions in the same Solar process. Do not clear the singleton or call
   `Main::setup()` again as a workaround: the rest of Godot is not documented
   to support reinitialization.
6. Godot starts helper processes to probe rendering devices and run projects.
   Without Solar's `get_executable_path()` override, these calls spawn
   `Solar.exe`, which hangs editor startup while Godot waits for output. Solar
   points this override at the matching bundled `godot.exe`. Startup failures
   time out, are written to `logs/godot-libgodot-fallback.log`, and retry with
   Solar's source-built child-window executable in the same request.
7. Solar writes an unfinished-session marker before loading the DLL and removes
   it after a clean Godot exit. If the native code terminates Solar, the next
   launch uses `solar-godot.exe` for that DLL build. Set `SOLAR_LIBGODOT=1` to retry
   the in-process backend after investigating the crash; `SOLAR_LIBGODOT=0`
   always selects the executable backend.
8. The in-process Windows build does not force-load `dinput8.dll` to install
   Godot's DirectInput import hook. SDL's legacy DirectInput joystick and
   haptics backends are also omitted because the affected Windows image raised
   an unhandled delay-load exception for the missing `CreateInputHostForProcess`
   export. SDL keeps its Raw Input, XInput, HIDAPI, and Windows Gaming Input
   joystick paths; haptics use SDL's no-device implementation in LibGodot.
   The bundled upstream `godot.exe` keeps its normal input configuration.

Set `SOLAR_PROFILE_DIR` to an empty directory to run Solar with a separate
profile. This skips legacy profile migration and keeps development runs away
from the user's saved credentials and recent projects.

## Previous runtime validation

The checks below were run against the earlier owned-popup LibGodot build,
before the creation-time child-window change. They establish that LibGodot
itself renders and accepts input in Solar, but they do not validate the new
child HWND path.

- On Windows x64 with the pinned Godot 4.7.1 build, a clean profile opened the
  editor as `backend=libgodot`, `mode=owned`. The full Godot editor and 3D
  viewport rendered inside Solar's scene area. The Solar 2D and 3D controls
  switched the actual Godot workspace; sending raw `WM_KEYDOWN` messages had
  previously omitted modifier state and opened Godot Help, so WinHost now
  temporarily attaches the input threads, focuses Godot, and emits real key
  events.
- The editor window followed a Solar resize and returned to the scene area's
  bounds. Closing the first LibGodot session removed its unfinished marker.
  Reopening in the same Solar process used `backend=executable` and rendered
  the editor, matching Godot 4.7.1's one-instance-per-process limit.
- In an isolated smoke project, moved Solar from `(191, 76, 1440x900)` to
  `(240, 110, 1240x780)` and verified that Godot tracked the scene stage at
  `(248, 299, 877x583)`. Minimizing hid both windows; restoring returned Godot
  to the same stage bounds. Switching to Game hid the Godot window, and
  returning to 2D / 3D showed it again.
- Real pointer and keyboard input reached LibGodot: clicking the native 2D tab
  switched workspaces, clicking the viewport focused Godot, and `Ctrl+N`
  created a scene. Godot's save/open dialogs saved and reopened small `Node2D`
  and `Node3D` smoke scenes. No user project was modified.
- Only one display was connected during this run, so moving between monitors
  with different DPI settings remains unverified.
- The in-process session did not load `dinput8.dll`; its bundled executable
  recovery path remains upstream and is unaffected. A clean shutdown and the
  unfinished-session recovery path were validated in isolated profiles.

## Creation-time child HWND validation

- Solar's source-built standalone editor creates a real `WS_CHILD` `Engine`
  window, with Solar's HWND as its direct parent. The upstream owned-popup
  fallback used `WS_POPUP` and needed independent position updates during a
  drag; Solar no longer accepts that window as embedded.
- A live OpenGL compatibility editor opened in the child HWND but its surface
  stayed black. The same executable with `--rendering-driver vulkan` rendered
  the full 3D editor, scene tree, toolbar, and file browser inside Solar.
  Both editor backends now request Vulkan for the embedded scene workspace.
- During a native title-bar drag, seven screenshots taken roughly 25 ms apart
  showed the visible Vulkan editor aligned with Solar at every step. The
  `Engine` HWND kept the same `(8, 189)` offset from Solar's window rectangle.
  There is no scene-editor move hook or frame-tracking timer. Display scanout
  and Electron's compositor still have normal frame latency; these observations
  do not establish a literal zero-millisecond display latency.
- A normal Solar launch opened the user's existing project with
  `backend=libgodot`. The visible Vulkan 3D editor ran in Electron's main PID,
  and its `Engine` HWND had `WS_CHILD` with Solar as its direct parent. Closing
  the project removed the unfinished-session marker. Reopening the same
  project in the same Solar process selected `solar-godot.exe`; its Vulkan
  editor also rendered in a direct `WS_CHILD` of Solar. Title-bar drag captures
  for both sessions kept the editor contents aligned with the stage.
- The Windows **Run** preview now launches the same verified child-window
  executable with Vulkan. An existing Solar starter scene rendered visibly in
  the Game pane; its game HWND had `WS_CHILD` with Solar as its direct parent.
  Five title-bar drag captures kept the rendered logo and preview aligned with
  the Solar window. The game no longer needs a move callback to follow Solar.
- Closing the standalone scene editor now waits for Godot to exit before a
  project switch or Solar shutdown. Its window stays available while Godot
  handles any unsaved-changes prompt.
- LibGodot closure also waits for the actual Node worker thread exit. A native
  `exited` message can precede FFI/thread teardown and must not release the host
  or resolve the close promise early. Both graceful/error lifecycle regressions
  and the packaged real-worker shutdown ordering are checked.
- If standalone Godot fails before its editor window becomes ready, Solar hides
  the partial window and gives the process a short shutdown grace period
  before terminating it, so a failed startup cannot block retries indefinitely.
- LibGodot setup failures that occur before a worker session is returned also
  enter the same standalone fallback path instead of leaving the editor closed.

## Further reliability work

- Repeat save/open validation on existing nonempty projects and confirm their
  scenes and resources survive close and reopen without data loss.
- Keep later project sessions on the executable fallback until Godot supports
  reinitialization; switching projects must not construct a second LibGodot
  instance in the same Solar process.
- Move Solar between mixed-DPI monitors without a floating editor window or
  delayed position correction.
- Verify 3D camera drag, mouse capture, and input focus after switching panes.
- Verify IME input and native file dialogs.
- Restore the Solar UI and project state after a native crash on the next launch.
- Ship matching editor library and export templates with recorded version and
  license notices on each supported platform.

The staged DLL's SHA-256 is recorded in
`vendor/godot/win32/libgodot-manifest.json`.

The focused Windows interactions above passed on the pinned build. Production
readiness still depends on the remaining checks listed above, especially
existing projects, mixed-DPI displays, and 3D camera input. The executable
backend remains the recovery path while LibGodot's upstream lifetime and
native surface limitations remain.
