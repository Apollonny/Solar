# Changelog

All notable changes to Solar (formerly GenieEngine) are documented here.

## [Unreleased]

### Added
- A shared 14-source partner asset library with secure ZIP/RAR ingestion, mechanism/dimension/style recommendations and exact file hashes; optional automatic AI selection preserves existing project content
- Immutable Godot sprite/model/effect/animation/audio/shader presets with measured frame/bounds checks, scoped dependency import and creator provenance
- An opt-in Windows Microsoft Agent Framework production workflow with a self-contained .NET sidecar, actual SDK checkpoints, scoped OpenCode roles, bounded retries/repairs and critical revision-bound approval
- Separate pinned BMAD/TEA planning and QA skills; an authenticated embedded Godot AI gateway; isolated GdUnit4 discovery/execution; original evidence storage and a mechanically constrained quality gate
- Production status, Stop/resume, approval scope and evidence links in Chat; documented preview limits and pending live feature acceptance
- The same 189 game-development guides and six Solar modules are registered as native OpenCode skills, with immutable app-owned SKILL.md snapshots, startup discovery checks and allowlisted skill-load metrics
- Offline `game_guidance` MCP search/read access to 189 pinned Godot Game Dev Studio guides, their text examples and six Solar instruction modules, with provenance, bounded paging and integrity checks
- LibGodot's 2D/3D scene editor is created as a native child window inside Solar, so Windows carries it with the app without a separate popup tracking loop
- NVIDIA API support with its own provider option, encrypted per-slot API keys, NVIDIA NIM endpoint, and model catalog suggestions
- Solar visual identity across the welcome screen, workspace colors, source artwork, app icon, and new Godot project icons
- One-time migration of existing settings, encrypted credentials, window preferences, and project history to the Solar identity
- GitHub Actions now typechecks, runs the unit suite, builds the app, and audits dependencies on macOS, Windows, and Linux
- A release workflow packages Windows, Linux, Apple Silicon macOS, and Intel macOS installers as downloadable workflow artifacts
- API keys entered in Solar are stored with operating-system encryption; Settings can move selected legacy OpenCode API keys out of the shared plaintext auth file and restore an encrypted snapshot

### Fixed
- Planner methodology searches now match individual path keywords and return exact read examples; empty unused tool fields are normalized, rejected paths explain the correct namespace, and per-stage loop guards stop repeated failures/retrieval without treating them as network reconnects
- Provider credentials are bound to their API family and canonical endpoint across Settings, catalog checks and executor startup; new-key auth checks, cancellable bounded catalog retries, encrypted recovery backups and coordinated rollback prevent stale-key activation and partial settings saves
- Settings now reject malformed key/URL inputs, discard stale catalog responses after key/provider/endpoint changes, prevent duplicate saves and mid-task connection changes, and preserve the model-default reasoning selection
- Task-derived dimension/style/asset policies now constrain role routing, relevant skill retrieval and AI asset searches; per-session recommendation receipts, exact resource references and unused-import checks prevent unapproved library application
- API/server interruptions now show Reconnecting with bounded automatic recovery, saved-session reconciliation and safe Microsoft checkpoint resume; Stop cancels recovery and uncertain writes are not replayed
- Game Studio now checks project preparation, editor connection and configured models, shows real stage activity and offers visible Stop/resume/recovery actions
- Production roles submit native StructuredOutput artifacts with bounded host schema validation; exact assistant tool-message reads work around OpenCode 1.17.13's bulk structured-format encoder error
- Planner sessions receive a small revision-bound project excerpt and a native tool allowlist, leaving asset selection and implementation to the Developer
- Mode changes cannot interrupt a running assistant turn; failed sends preserve the draft and attachments for retry
- Verified feature completion includes a chat result and labeled criterion/evidence links; provider failures never become feature completion
- LibGodot editor closure waits for actual worker thread/FFI teardown before releasing the host window or quitting Electron
- Production asset checks verify actual sprite framing and observable gameplay state; a whole-sheet image or an omitted private counter cannot substitute for feature evidence
- Feature workflows verify configured credentials, selected catalog entries and image-input capability before development; unknown key quota never implies a positive account balance
- Role-specific step/time bounds and compact BMAD/TEA indexes prevent small stories from exhausting a generic 12-step limit; limit summaries block with a readable error
- Vision reviews avoid duplicated scene trees and use a smaller ordinary output budget while preserving explicit reasoning budgets and complete original evidence
- Microsoft role permissions use one ordered ruleset so deprecated OpenCode tool settings cannot hide allowed reference/asset tools; disconnected or denied tool access blocks before provider generation
- Microsoft stage prompts retain only assigned native skill descriptions, avoiding a full catalog in every provider request while keeping all pinned guides installed
- Imported Nojoule shaders preserve their 5×5 texture samples while avoiding Godot 4.7's unsupported built-in sampler argument path
- Godot seed import settings no longer mark new resources as failed imports; owned compatibility overlays can upgrade after complete hash verification while modified addons remain protected
- Legitimate early Windows geometry messages are forwarded during native editor creation without changing child parenting, dragging or cursor behavior
- Controlled roles no longer request automatic chat titles; output budgets preserve explicit reasoning budgets, and incomplete/reasoning-only provider replies block acceptance with numeric attempt diagnostics
- Original runtime evidence is saved before vision review; Microsoft retries a transient vision request against the same intact capture without replaying the runtime or input
- TEA must read its original structured evidence; scoped native external-directory reads support both OpenCode wildcard forms while the exact file allowlist remains enforced
- Godot gateway startup failures identify their upstream error code without exposing capability tokens
- Godot Editor startup now stops the active preview, removes stale Solar test-agent files safely, detects immediate editor crashes, saves a launch log, and offers recovery mode; later crashes are reported in the Files panel
- Temporary Godot overrides are cleaned synchronously on app exit, and cleanup preserves user-authored override and agent files
- Opening a project no longer requires an AI API key; the editor opens immediately and the assistant shows an inline setup action only when its selected model is unavailable
- Asset generation rejects symbolic-link paths for reference images and output directories, and replaces existing asset files atomically so their symlink targets are never overwritten

### Changed
- The English AI core is below 6 KB; detailed art, memory, architecture and validation guidance loads on demand through the existing primary model
- The project workbench now gives the game preview a persistent status toolbar, opens the assistant at a more readable width, and uses a clearer prompt-first empty state; the sidebar divider also supports keyboard resizing
- electron-builder is updated to 26.16.1
- macOS release packaging requires the native embedded-game host to compile successfully

## [0.1.1] - 2026-07-10

### Added
- The chat agent now runs on two configurable models instead of one: Medium (default: deepseek/deepseek-v4-pro) for everyday work, and Large (default: z-ai/glm-5.2) for tough tasks that need extra juice but may cost more. A dropdown in the chat box switches between them mid-conversation — the full chat history carries over. The image / game-testing model stays its own separate configuration (default: moonshotai/kimi-k2.7-code)
- Every model in the AI settings can now set Thinking (enabled/disabled) and Reasoning effort (low/medium/high/xhigh/max), sent with each request as the standard OpenAI-format `thinking` / `reasoning_effort` fields; the default sends nothing and leaves the model on its own behavior
- Watch the assistant play-test live: while an AI test run is in progress, the test card shows a live view of the off-screen game as the assistant plays it, letterboxed and resizing cleanly with the window (macOS; other platforms keep showing the latest captured screenshot). The live view is display-only, so watching never interferes with the run
- The game viewer now shows a live FPS counter while your game runs — green normally, orange below 50 FPS, red below 30 — and per-minute frame stats (min / max / avg / 1% low / 0.1% low) are logged to `.genieengine/perf.log`, giving the assistant real frame-rate history when diagnosing performance problems
- Chat attachments now go beyond images and small text files: attach `.zip` asset packs, 3D models (`.glb`, `.gltf`, `.obj`, `.fbx`, `.dae`, `.stl`, `.blend`), audio, fonts, or entire folders — via the new folder button or drag-and-drop, up to 512 MB. They're copied into the project so the assistant can unpack them and wire the assets into the game
- New `/undo` and `/redo` chat commands: `/undo` takes back your last message together with the file changes that turn made and drops the message back into the composer for editing; `/redo` restores it — conversation and project files both. Undo history survives app restarts
- The assistant now treats the project's AGENTS.md as persistent memory — say "remember …" or settle a lasting decision (art direction, control scheme, conventions) and it records a short note there that carries into future sessions

### Fixed
- Updating the chat model's API key silently overwrote the image model's stored key whenever both models pointed at the same endpoint (they shared one credential slot), and changing the chat endpoint could strand the image credential entirely. Every model now keeps its own credential slot; leaving a key blank to share another section's key copies it instead of aliasing it
- The game-testing subagent could probe a game for 10+ minutes behind a motionless chat, looking hung until the user cancelled. AI test runs now have a per-run budget (~40 game tool calls / 8 minutes) with an early wrap-up warning, and subagent tool activity is shown live in the chat as labelled chips
- Test screenshots are now downscaled to 1024-wide JPEGs before being sent to the model — full-size retina PNGs accumulating in the test conversation made every step slower and could exceed the provider's request-size limit mid-run (the on-disk copy stays full resolution)
- A transient provider failure mid-response (server 5xx/429, overload, gateway errors) used to kill the turn partway through. The app now automatically resumes the same session and the response continues where it left off, with up to two retries — distinct from the manual "Continue" button for lost internet
- A brief network hiccup on the first message after reopening a project no longer makes the assistant silently forget the conversation and start a fresh one — session verification is retried, and only a definitive "session gone" answer from the server starts over. Rapidly switching projects mid-save could also detach a chat from its session; it no longer does
- A conversation that outgrew the model's context window used to dead-end: every further message failed with the same error. The chat now rolls over to a fresh session automatically, seeded with a recap of the recent conversation, and keeps going — with a clear error only if a single message is too large even for a fresh session
- An auto-denied out-of-project file access used to halt the whole agent run, leaving the chat frozen until the user typed something. Denials now return to the model as ordinary tool errors it can route around, and AI test screenshots moved from `~/Library` into the project (`.genieengine/test-shots/`) so reading them never trips the permission system in the first place
- AI shell commands that strayed outside the project could trigger macOS "would like to access your Desktop / Photos / …" prompts. The assistant now runs under a macOS sandbox profile that silently denies personal folders (Desktop, Downloads, Photos, iCloud Drive, `.ssh`, and similar) while keeping the project fully accessible — no system prompts, and commands that stage files in the OS temp dir no longer fail
- The assistant's game-testing and asset-generation tools silently stopped working when the app was launched from a mounted `.dmg` or when more than one copy of the app was running — each instance now gets its own tool bridge, and the sandbox permits the app bundle wherever it lives
- Opening Settings, Export, or the first-run setup while a game was embedded left the live game view punched through on top of the dialog — the native game layer now hides whenever a modal is open, including games that finish launching behind one

### Changed
- OpenGenie is now GenieEngine — the app, installer, and per-project state directory (`.genieengine/`) all use the new name
- AGENTS.md is now fully yours: new projects get a short, editable file for your own notes, while GenieEngine's build rules ship with the app (staying current with each release) and are injected at chat time. Projects still carrying the old app-generated AGENTS.md are slimmed down automatically on open; any file you've edited is left untouched
- Games no longer flash the Godot engine splash screen on launch — new projects boot straight into their first scene, and export fixes up older projects that never chose a splash of their own. A custom splash you set yourself is respected
- The chat input box now grows with your message up to a comfortable maximum instead of staying a single line, and snaps back after sending

## [0.1.0] - 2026-07-06

### Added
- Native Godot game view embedded directly in the app window, with aspect-ratio presets, letterboxing, and a resizable output console
- AI chat panel backed by a per-project OpenCode server, with live-streamed responses, tool-activity indicators, file/image attachments, and slash commands
- First-run AI setup overlay — works with OpenRouter out of the box or any OpenAI-compatible endpoint
- The assistant can test games itself via MCP: off-screen runs, scripted input, screenshots, GDScript state probes, and console logs
- One-click export to all six Godot platforms, with export templates downloaded on demand
- Workspace sidebar with a VS Code-style file explorer and a full Git panel (stage/commit/push/pull, remotes, history)
- Buttons to open the current project directly in VS Code or the Godot editor
- "Advanced mode" toggle that reveals the ECS viewer, Files sidebar, Git sidebar, and console output for engineers, while keeping the default view simple
- 2D asset generation (sprites, icons, textures) via OpenAI image generation, saved straight into the project
- 3D asset generation via Tencent Hunyuan 3D, saved straight into the project
- ECS graph viewer showing entities, components, and systems as a linked diagram
- Interactive "question" tool — the assistant can ask multiple-choice questions mid-turn instead of guessing
- Per-project chat history and input recall (↑ / ↓) that persist across app restarts
- "Thinking…" indicator now shows a live elapsed-time counter when a model's reasoning text isn't available
- A turn interrupted by a lost internet connection can be resumed with "Continue" once back online

### Fixed
- Packaged builds could fail to launch because compiled code wasn't bundled into the app
- Project names containing control characters could inject arbitrary GDScript into `project.godot`
- Godot export presets set up in the editor (signing, keystores, icons) were being overwritten instead of merged on export
- Exporting only worked correctly on macOS — Windows and Linux now extract export templates with their own native tools
- Stopping a game run could be undone by a delayed exit event from a previously stopped run
- Links in the AI chat no longer navigate the whole app UI away — they now open in the system browser
- Running multiple GenieEngine instances no longer lets the assistant's game-testing tools cross-talk between them
- Restoring a saved chat session now correctly resumes the conversation instead of silently starting a new one
- macOS window traffic lights disappearing in native fullscreen no longer leave stray padding in the title bar

### Changed
- AI provider setup now accepts any OpenAI-compatible endpoint rather than a fixed list of providers
- App and installer now use a custom GenieEngine icon, including the macOS `.dmg` file itself
