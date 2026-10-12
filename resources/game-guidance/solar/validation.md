---
name: solar-validation
description: Targeted saved-file Godot validation, runtime input and visual checks, test budgets and performance diagnostics.
---

Respect the user's limits on testing. Load the relevant checks, avoid a full regression for a small edit, and report unverified behavior explicitly. Run the game only when gameplay or visual evidence is needed and permitted.

# Targeted validation

When image inspection requires a configured helper, use the **game-tester** subagent (task tool): it launches
the game (off-screen on macOS, in a separate window on Windows/Linux), drives it with
input, inspects state and logs, and — unlike you, possibly — actually sees the
screenshots it takes. Tell it what changed and exactly what
to verify; it reports what works and what's broken, and you fix and re-test.

You also have the same MCP tools (server `solar`) yourself — fine for quick
targeted probes without a full test pass (use game-tester for image inspection
unless your model views images):

1. `run_game_test` — starts the game (full engine, real rendering; off-screen on macOS,
   in its own visible window on Windows/Linux — the tools work the same either way).
2. `game_scene_tree` — discover node paths; `game_state` — evaluate a GDScript expression
   (e.g. `get_node("/root/Main/Score").text`) to assert state.
3. `game_input` — send scripted keys/mouse (DOM-style key names like "ArrowLeft", "Space").
4. `game_screenshot` — capture a PNG of the running game. It returns the image AND saves
   it inside the project at `.solar/test-shots/`; if you can't view images, hand that
   in-project path to **image-reader** — never copy screenshots or look for them anywhere
   else. `game_logs` — read the game's console output (prints and script errors). It also
   includes output from the **user's own play sessions** — when the user reports a bug or
   crash, call `game_logs` first to see what actually happened.
5. `stop_game_test` — always stop the run when you're finished.

### When to test — use judgment, testing takes real time

**Do test** after changes that are large or gameplay-critical:
- New mechanics or systems (movement, collision, scoring, spawning, win/lose, save/load).
- Refactors that touch several functions or scenes, or change the scene structure.
- Changes to input handling, the main loop, or anything that could break launch.
- Risky changes that might cause the game not to start or have broken modules.

**Don't test** after trivial edits: tuning a single constant, colors/text/labels, comments, or
renames with no behavior change. Also don't test after changes that are easily verified by
human eyes.

The first playable version is a visual launch milestone: run it and inspect a screenshot of
the actual game preview before calling it done. A Running status, high FPS, successful
process launch, or changing game state does not prove that anything is drawn. If the preview
shows only a blank background, starter screen, or unrelated placeholder, fix the scene/rendering
and inspect it again.

### How to test — keep it cheap and targeted

- Test what changed, not everything. Give game-tester a focused brief: which mechanic you
  touched, the controls that exercise it, and the expected outcome. (Doing it yourself:
  run → `game_logs` → probe the mechanic via `game_state` → a few `game_input` actions →
  `game_logs` again → `stop_game_test`.)
- {{SOLAR_GAME_TEST_BUDGET}} An open-ended brief like "verify everything" will exhaust
  the available budget before concluding. Ask
  for a handful of specific checks; split genuinely broad verification into separate runs.

### Saved-project validation

- After changing scripts or scenes, call `project_validate` before gameplay checks when
  validation is permitted by the user. If verification is disallowed, report it as unverified.
  It imports an isolated copy and returns structured diagnostics with file/line information.
- `pass` covers only the stated saved-file scope. It does not verify gameplay, visuals,
  dynamic resource targets or unsaved editor changes. Keep those claims separate.
- On `fail`, fix the reported cause and validate again. On `stale`, refresh the project
  files and repeat the check. `partial`, `timeout`, `cancelled` and `unavailable` are
  incomplete checks; report that limitation instead of claiming success.
- Use `paths` for a small explicit batch when the project exceeds validation limits.
- If script errors turn up at any point, fix them and re-run the test before reporting.
- Save full regression passes (controls + scoring + game over + restart) for major milestones.
- Always report what you verified — or that you deliberately skipped testing and why.

### Performance — `.solar/perf.log`

While the game runs (the user playing OR a test run), Solar measures every frame and
logs frame-rate stats per 60-second window: `avg`, `min`, `max`, `1%low`, `0.1%low`.
The lines appear in `game_logs` as they are produced, and the persistent history lives in
`.solar/perf.log`.

When the user reports lag, stutter, or slowness: read `.solar/perf.log` FIRST — it
holds real measurements from their own play sessions. A low `avg` means sustained load
(too much per-frame work); a good `avg` with bad `1%low`/`0.1%low` means hitches
(spikes from allocations, node spawning, loading in `_process`, etc.). After optimizing,
run the game again and compare new windows against the old ones.
