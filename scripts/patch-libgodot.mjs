/** Solar-specific C ABI over GodotInstance. Kept small and version-locked. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function replaceOnce(path, original, replacement) {
  const text = readFileSync(path, 'utf8')
  if (text.includes(replacement)) return
  if (!text.includes(original)) throw new Error(`Godot source layout changed: ${path}`)
  writeFileSync(path, text.replace(original, replacement))
}

export function patchLibGodot(source) {
  // Windows may send geometry/non-client messages while CreateWindowEx is on
  // the stack, before WM_NCCREATE registers the HWND. Forward these early
  // geometry notification to the existing user/default procedure. The normal
  // registered-window path, parenting, dragging and cursor handling stay intact.
  const displayPath = join(source, 'platform', 'windows', 'display_server_windows.cpp')
  const earlyHeader = 'LRESULT DisplayServerWindows::_handle_early_window_message(HWND hWnd, UINT uMsg, WPARAM wParam, LPARAM lParam) {\n\tswitch (uMsg) {\n'
  const oldGeometry = '\t\tcase WM_WINDOWPOSCHANGING: {\n\t\t\t// Solar: a valid early geometry message needs no initialized WindowData.\n\t\t} break;\n'
  const priorGeometry = '\t\tcase WM_NCCALCSIZE:\n' + oldGeometry
  const geometry = '#ifndef LIBGODOT_ENABLED\n\t\tcase WM_WINDOWPOSCHANGED:\n\t\tcase WM_MOVE:\n\t\tcase WM_SIZE:\n#endif\n' + priorGeometry
  if (readFileSync(displayPath, 'utf8').includes(earlyHeader + oldGeometry)) replaceOnce(displayPath, earlyHeader + oldGeometry, earlyHeader + geometry)
  if (readFileSync(displayPath, 'utf8').includes(earlyHeader + priorGeometry)) replaceOnce(displayPath, earlyHeader + priorGeometry, earlyHeader + geometry)
  replaceOnce(displayPath,
    earlyHeader + '\t\tcase WM_GETMINMAXINFO:',
    earlyHeader + geometry + '\t\tcase WM_GETMINMAXINFO:')
  const instancePath = join(source, 'core', 'extension', 'godot_instance.cpp')
  replaceOnce(instancePath,
    'bool GodotInstance::initialize(GDExtensionInitializationFunction p_init_func) {\n\tprint_verbose("Godot Instance initialization");',
    'bool GodotInstance::initialize(GDExtensionInitializationFunction p_init_func) {\n\tprint_verbose("Godot Instance initialization");\n\tif (p_init_func == nullptr) {\n\t\treturn true; // Solar does not register a host GDExtension.\n\t}')

  // Godot's editor launches its own executable for renderer probes, running
  // projects and import helpers. Inside Electron, GetModuleFileNameW points at
  // Solar.exe; launching that would block editor startup waiting for a pipe.
  const osPath = join(source, 'platform', 'windows', 'os_windows.cpp')
  replaceOnce(osPath,
    'String OS_Windows::get_executable_path() const {\n\tWCHAR bufname[4096];',
    'String OS_Windows::get_executable_path() const {\n\tWCHAR solar_helper[4096];\n\tDWORD solar_helper_size = GetEnvironmentVariableW(L"SOLAR_GODOT_HELPER_EXECUTABLE", solar_helper, 4096);\n\tif (solar_helper_size > 0 && solar_helper_size < 4096) {\n\t\treturn String::utf16((const char16_t *)solar_helper).replace_char(\'\\\\\', \'/\');\n\t}\n\tWCHAR bufname[4096];')

  // Godot's Windows input optimization eagerly loads dinput8.dll so it can
  // patch two imports. On the captured Windows 11 image, dinput8's delay-load
  // request for CreateInputHostForProcess fails against InputHost.dll and
  // terminates the host process. Patch the helper to inspect only an already
  // loaded module; Solar must not load DirectInput just to install this hook.
  replaceOnce(osPath,
    'LPVOID image_base = LoadLibraryA(p_target.ascii().get_data());',
    'LPVOID image_base = GetModuleHandleA(p_target.ascii().get_data());')

  // Solar's in-process build omits SDL's legacy DirectInput backend. That
  // backend loads dinput8.dll, whose delay-loaded InputHost export is missing
  // on some Windows images and can terminate the Electron host process.
  const sdlConfigPath = join(source, 'drivers', 'sdl', 'SDL_build_config_private.h')
  replaceOnce(sdlConfigPath,
    '#define HAVE_DINPUT_H 1',
    '#if 0 // Solar LibGodot deliberately omits legacy DirectInput.\n#define HAVE_DINPUT_H 1\n#endif')
  replaceOnce(sdlConfigPath,
    '#define SDL_JOYSTICK_DINPUT 1',
    '#if 0 // Solar LibGodot deliberately omits legacy DirectInput.\n#define SDL_JOYSTICK_DINPUT 1\n#endif')
  replaceOnce(sdlConfigPath,
    '#define SDL_HAPTIC_DINPUT 1',
    '#if 0 // Solar LibGodot deliberately omits legacy DirectInput.\n#define SDL_HAPTIC_DINPUT 1\n#endif')
  replaceOnce(sdlConfigPath,
    '#endif\n#define SDL_THREAD_GENERIC_COND_SUFFIX 1',
    '#endif\n#define SDL_HAPTIC_DUMMY 1 // Solar LibGodot has no DirectInput haptics backend.\n#define SDL_THREAD_GENERIC_COND_SUFFIX 1')

  // SDL still needs its platform haptic interface symbols when the Windows
  // DirectInput backend is removed. Use SDL's no-device dummy implementation
  // for this in-process editor build instead of leaving unresolved symbols.
  const sdlSourcesPath = join(source, 'drivers', 'sdl', 'SCsub')
  replaceOnce(sdlSourcesPath,
    '            "core/windows/pch.c",\n            "haptic/windows/SDL_dinputhaptic.c",\n            "haptic/windows/SDL_windowshaptic.c",\n            "joystick/windows/SDL_dinputjoystick.c",',
    '            "core/windows/pch.c",\n            "haptic/dummy/SDL_syshaptic.c",\n            "joystick/windows/SDL_dinputjoystick.c",')

  // Keep the upstream Windows executable configuration intact while omitting
  // the DirectInput import libraries from Solar's LibGodot DLL.
  const windowsDetectPath = join(source, 'platform', 'windows', 'detect.py')
  replaceOnce(windowsDetectPath,
    '    if env.debug_features:\n        LIBS += ["psapi", "dbghelp"]',
    '    LIBS = [lib for lib in LIBS if lib.lower() != "dinput8"]\n\n    if env.debug_features:\n        LIBS += ["psapi", "dbghelp"]')
  replaceOnce(windowsDetectPath,
    '    env.Append(\n        LIBS=[\n            "mingw32",',
    '    directinput_libs = ["dxguid"]\n    env.Append(\n        LIBS=[\n            "mingw32",')
  replaceOnce(windowsDetectPath,
    '            "dinput8",\n            "dxguid",',
    '            *directinput_libs,')

  const windowsPath = join(source, 'platform', 'windows', 'libgodot_windows.cpp')
  replaceOnce(windowsPath,
    '#include "main/main.h"',
    '#include "main/main.h"\n\n#include <string>\n#include <vector>')
  const bridge = `

// Solar's small C ABI keeps Electron's FFI independent of Godot's C++ ABI.
bool solar_libgodot_child_window = false;

extern "C" LIBGODOT_API int solar_libgodot_bridge_abi() {
	return 2;
}

extern "C" LIBGODOT_API GDExtensionObjectPtr solar_godot_create_editor(const char *p_project_path, const char *p_parent_hwnd, const char *p_log_path, int p_x, int p_y, int p_width, int p_height) {
	if (!p_project_path || !p_parent_hwnd || !*p_project_path || !*p_parent_hwnd) {
		return nullptr;
	}
	std::vector<std::string> arguments = {
		"solar-libgodot", "--editor", "--single-window", "--path", p_project_path,
		"--wid", p_parent_hwnd, "--position", std::to_string(p_x) + "," + std::to_string(p_y),
		"--resolution", std::to_string(p_width) + "x" + std::to_string(p_height),
		"--rendering-driver", "vulkan"
	};
	if (p_log_path && *p_log_path) {
		arguments.push_back("--log-file");
		arguments.push_back(p_log_path);
	}
	std::vector<char *> argv;
	argv.reserve(arguments.size());
	for (std::string &argument : arguments) {
		argv.push_back(argument.data());
	}
	solar_libgodot_child_window = true;
	return libgodot_create_godot_instance((int)argv.size(), argv.data(), nullptr);
}

extern "C" LIBGODOT_API int solar_godot_start(GDExtensionObjectPtr p_instance) {
	return p_instance && ((GodotInstance *)p_instance)->start();
}

extern "C" LIBGODOT_API int solar_godot_iteration(GDExtensionObjectPtr p_instance) {
	return p_instance && ((GodotInstance *)p_instance)->iteration();
}

extern "C" LIBGODOT_API void solar_godot_destroy(GDExtensionObjectPtr p_instance) {
	if (p_instance) {
		libgodot_destroy_godot_instance(p_instance);
	}
}
`
  const text = readFileSync(windowsPath, 'utf8')
  if (!text.includes('solar_libgodot_bridge_abi')) {
    writeFileSync(windowsPath, text + bridge)
  } else if (!text.includes('const char *p_log_path')) {
    // Upgrade an existing repo-local build tree without modifying upstream code.
    const marker = '// Solar\'s small C ABI'
    const offset = text.indexOf(marker)
    if (offset < 0) throw new Error('Solar bridge marker is missing from Godot source')
    writeFileSync(windowsPath, text.slice(0, offset) + bridge.trimStart())
  }
  replaceOnce(windowsPath,
    '// Solar\'s small C ABI keeps Electron\'s FFI independent of Godot\'s C++ ABI.\nextern "C" LIBGODOT_API int solar_libgodot_bridge_abi()',
    '// Solar\'s small C ABI keeps Electron\'s FFI independent of Godot\'s C++ ABI.\nbool solar_libgodot_child_window = false;\n\nextern "C" LIBGODOT_API int solar_libgodot_bridge_abi()')
  replaceOnce(windowsPath,
    '\treturn libgodot_create_godot_instance((int)argv.size(), argv.data(), nullptr);',
    '\tsolar_libgodot_child_window = true;\n\treturn libgodot_create_godot_instance((int)argv.size(), argv.data(), nullptr);')
  replaceOnce(windowsPath,
    '\t\t"--resolution", std::to_string(p_width) + "x" + std::to_string(p_height)\n\t};',
    '\t\t"--resolution", std::to_string(p_width) + "x" + std::to_string(p_height),\n\t\t"--rendering-driver", "vulkan"\n\t};')

  // Both the in-process editor and Solar's pinned standalone recovery editor
  // create their surfaces as native child HWNDs from birth. The executable
  // enables this only when its --wid parent matches Solar's explicit handle;
  // Godot helper/game processes therefore retain their normal window style.
  const displayServerPath = join(source, 'platform', 'windows', 'display_server_windows.cpp')
  const displayServerText = readFileSync(displayServerPath, 'utf8')
  const displayServerInclude = '#include "display_server_windows.h"\n'
  const oldChildDeclaration = `${displayServerInclude}\nextern bool solar_libgodot_child_window;\n`
  const childDeclaration = `${displayServerInclude}\n#ifdef LIBGODOT_ENABLED\nextern bool solar_libgodot_child_window;\n#else\nstatic bool solar_libgodot_child_window = false;\n#endif\n`
  if (!displayServerText.includes(childDeclaration)) {
    const original = displayServerText.includes(oldChildDeclaration) ? oldChildDeclaration : displayServerInclude
    if (!displayServerText.includes(original)) throw new Error(`Godot source layout changed: ${displayServerPath}`)
    writeFileSync(displayServerPath, displayServerText.replace(original, childDeclaration))
  }
  replaceOnce(displayServerPath,
    '\tKeyMappingWindows::initialize();\n\n\ttested_drivers.clear();',
    '\tKeyMappingWindows::initialize();\n\n#if !defined(LIBGODOT_ENABLED)\n\tif (p_parent_window != 0) {\n\t\tWCHAR solar_parent[32] = {};\n\t\tDWORD solar_parent_length = GetEnvironmentVariableW(L"SOLAR_GODOT_CHILD_PARENT", solar_parent, 32);\n\t\tif (solar_parent_length > 0 && solar_parent_length < 32 &&\n\t\t\t\tString::utf16((const char16_t *)solar_parent) == String::num_int64(p_parent_window)) {\n\t\t\tsolar_libgodot_child_window = true;\n\t\t}\n\t}\n#endif\n\n\ttested_drivers.clear();')
  replaceOnce(displayServerPath,
    'if (p_embed_child) {\n\t\tr_style |= WS_POPUP;',
    'if (p_embed_child) {\n\t\tr_style |= solar_libgodot_child_window ? WS_CHILD : WS_POPUP;')
  replaceOnce(displayServerPath,
    '\tr_style_ex = WS_EX_WINDOWEDGE;',
    '\tr_style_ex = p_embed_child && solar_libgodot_child_window ? 0 : WS_EX_WINDOWEDGE;')
  replaceOnce(displayServerPath,
    '\tWindowRect.left += offset.x;\n\tWindowRect.right += offset.x;\n\tWindowRect.top += offset.y;\n\tWindowRect.bottom += offset.y;\n\n\tif (p_mode != DisplayServerEnums::WINDOW_MODE_FULLSCREEN && p_mode != DisplayServerEnums::WINDOW_MODE_EXCLUSIVE_FULLSCREEN) {',
    '\tWindowRect.left += offset.x;\n\tWindowRect.right += offset.x;\n\tWindowRect.top += offset.y;\n\tWindowRect.bottom += offset.y;\n\n\tif (p_parent_hwnd && solar_libgodot_child_window) {\n\t\tPOINT child_position = { WindowRect.left, WindowRect.top };\n\t\tif (!ScreenToClient(p_parent_hwnd, &child_position)) {\n\t\t\tERR_FAIL_V_MSG(ERR_CANT_CREATE, "Failed to convert the Solar scene rectangle to child-window coordinates.");\n\t\t}\n\t\tint width = WindowRect.right - WindowRect.left;\n\t\tint height = WindowRect.bottom - WindowRect.top;\n\t\tWindowRect.left = child_position.x;\n\t\tWindowRect.top = child_position.y;\n\t\tWindowRect.right = child_position.x + width;\n\t\tWindowRect.bottom = child_position.y + height;\n\t}\n\n\tif (p_mode != DisplayServerEnums::WINDOW_MODE_FULLSCREEN && p_mode != DisplayServerEnums::WINDOW_MODE_EXCLUSIVE_FULLSCREEN) {')
  // System cursors live in user32, not in Electron's executable resources.
  replaceOnce(displayServerPath,
    'SetCursor(LoadCursor(hInstance, win_cursors[p_shape]));',
    'SetCursor(LoadCursor(solar_libgodot_child_window ? nullptr : hInstance, win_cursors[p_shape]));')
  // Keep the embedded Godot editor in charge of its client-area cursor.
  // Otherwise WM_SETCURSOR falls through to Electron's parent window, where
  // Chromium can replace Godot's cursor with its own style.
  replaceOnce(displayServerPath,
    '\t\tcase WM_SETCURSOR: {\n\t\t\tif (LOWORD(lParam) == HTCLIENT) {\n\t\t\t\tif (windows[window_id].window_focused && (mouse_mode == DisplayServerEnums::MOUSE_MODE_HIDDEN || mouse_mode == DisplayServerEnums::MOUSE_MODE_CAPTURED || mouse_mode == DisplayServerEnums::MOUSE_MODE_CONFINED_HIDDEN)) {\n\t\t\t\t\t// Hide the cursor.\n\t\t\t\t\tif (hCursor == nullptr) {\n\t\t\t\t\t\thCursor = SetCursor(nullptr);\n\t\t\t\t\t} else {\n\t\t\t\t\t\tSetCursor(nullptr);\n\t\t\t\t\t}\n\t\t\t\t} else {\n\t\t\t\t\tif (hCursor != nullptr) {\n\t\t\t\t\t\tDisplayServerEnums::CursorShape c = cursor_shape;\n\t\t\t\t\t\tcursor_shape = DisplayServerEnums::CURSOR_MAX;\n\t\t\t\t\t\tcursor_set_shape(c);\n\t\t\t\t\t\thCursor = nullptr;\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}\n\t\t} break;',
    '\t\tcase WM_SETCURSOR: {\n\t\t\tif (LOWORD(lParam) == HTCLIENT) {\n\t\t\t\tif (windows[window_id].window_focused && (mouse_mode == DisplayServerEnums::MOUSE_MODE_HIDDEN || mouse_mode == DisplayServerEnums::MOUSE_MODE_CAPTURED || mouse_mode == DisplayServerEnums::MOUSE_MODE_CONFINED_HIDDEN)) {\n\t\t\t\t\t// Hide the cursor.\n\t\t\t\t\tif (hCursor == nullptr) {\n\t\t\t\t\t\thCursor = SetCursor(nullptr);\n\t\t\t\t\t} else {\n\t\t\t\t\t\tSetCursor(nullptr);\n\t\t\t\t\t}\n\t\t\t\t} else {\n\t\t\t\t\tif (hCursor != nullptr) {\n\t\t\t\t\t\tDisplayServerEnums::CursorShape c = cursor_shape;\n\t\t\t\t\t\tcursor_shape = DisplayServerEnums::CURSOR_MAX;\n\t\t\t\t\t\tcursor_set_shape(c);\n\t\t\t\t\t\thCursor = nullptr;\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}\n\t\t\tif (solar_libgodot_child_window && LOWORD(lParam) == HTCLIENT) {\n\t\t\t\tconst bool keep_cursor_hidden = windows[window_id].window_focused && (mouse_mode == DisplayServerEnums::MOUSE_MODE_HIDDEN || mouse_mode == DisplayServerEnums::MOUSE_MODE_CAPTURED || mouse_mode == DisplayServerEnums::MOUSE_MODE_CONFINED_HIDDEN);\n\t\t\t\tif (!keep_cursor_hidden) {\n\t\t\t\t\tconst DisplayServerEnums::MouseMode previous_mouse_mode = mouse_mode;\n\t\t\t\t\tif (mouse_mode != DisplayServerEnums::MOUSE_MODE_VISIBLE && mouse_mode != DisplayServerEnums::MOUSE_MODE_CONFINED) {\n\t\t\t\t\t\tmouse_mode = DisplayServerEnums::MOUSE_MODE_VISIBLE;\n\t\t\t\t\t}\n\t\t\t\t\tDisplayServerEnums::CursorShape shape = cursor_shape == DisplayServerEnums::CURSOR_MAX ? DisplayServerEnums::CURSOR_ARROW : cursor_shape;\n\t\t\t\t\tcursor_shape = DisplayServerEnums::CURSOR_MAX;\n\t\t\t\t\tcursor_set_shape(shape);\n\t\t\t\t\tmouse_mode = previous_mouse_mode;\n\t\t\t\t\thCursor = nullptr;\n\t\t\t\t}\n\t\t\t\treturn TRUE;\n\t\t\t}\n\t\t} break;')
}
