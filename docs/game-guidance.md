# Solar — on-demand game development guidance

Solar's primary assistant uses 189 pinned Godot Game Dev Studio skills and six
Solar modules through OpenCode's native `skill` tool. The model sees their names
and concise descriptions, then loads only the selected full instructions.
`game_guidance` provides catalog lookup and supporting file reads. Neither skill
preparation nor supporting reads writes to a game, launches Godot, calls a model
or changes the selected provider/reasoning level.

## Native skill use

These instructions describe the legacy assistant's native loading. In Microsoft
Game Studio stages, Solar supplies only the assigned complete, verified documents
in context. Native loads are optional and recorded separately. Scoped MCP search
and supporting reads stay within that stage's assigned guides. See
[production workflow](production-workflow.md) for delivery receipts and limits.

For gameplay, first load the relevant Solar module:

```json
{"name":"solar-ecs"}
```

Then load a matching specialist with OpenCode's native `skill` tool:

```json
{"name":"solar-godot-characterbody-2d"}
```

These are actual `SKILL.md` files containing the full skill instructions, not
wrappers that only ask the model to fetch the guide over MCP. Solar derives their
names/descriptions, adaptation rules, source hashes and notices from the verified
bundle. Files are prepared once under userData in an immutable snapshot and
shared by projects. No skill installation is written to game projects or global
OpenCode settings.

An app-owned local OpenCode plugin appends the prepared root to `skills.paths`
after the user's config layers merge, preserving existing paths, URLs and plugins.
Solar enables the native skill tool in its process config; per-agent/user skill
permission rules still apply. Startup calls OpenCode's read-only `/skill` route
with a 30-second/8 MB limit and checks the expected 195 names and cache locations.
An incomplete registration is an explicit startup error. This code follows the
packaged OpenCode 1.17.13 skill/config/plugin interfaces.

Successful primary-agent native loads emit an allowlisted `skill_loaded` event
with the skill name in `.solar/run-metrics/`; source content and general tool
arguments are not recorded. The chat displays the native skill tool activity.

## Tool contract

Search:

```json
{"action":"search","query":"characterbody 2d jump","limit":6}
```

An empty query lists the six Solar modules. Search returns concise matches with
id, native `skillName`, title, description, family and source. Prefer English topic terms. Select a
relevant Solar module plus one to three specialist guides.

The main instructions are loaded by native `skill`. For a bounded source page,
the supporting reader can also read the original guide:

```json
{"action":"read","id":"godot-characterbody-2d"}
```

Read a returned available example:

```json
{
  "action":"read",
  "id":"godot-characterbody-2d",
  "file":"upstream/skills/godot-characterbody-2d/scripts/variable_jump_height.gd"
}
```

Long documents return `nextStartLine`; pass it as `start_line` to continue. Default
page size is 160 lines; maximum 240 lines and 12,000 characters. Search returns
six matches by default, at most eight. Files have a 1 MB cap and the catalog 2 MB.
Every read is an exact catalog path, rejects linked/outside paths and verifies
the raw byte count/SHA-256 before expanding the shared test-budget placeholder.
The output's hash/bytes describe the bundled raw file, while line numbers describe
the expanded text. Missing example links are explicitly marked unavailable.

The authenticated, per-instance Solar harness exposes the tool to OpenCode. Calls
are associated with the existing run/tool metrics and obey its stop/project
transition cancellation. A corrupt/missing library returns a tool error; the
core tells the assistant to continue from project files and report that limitation.

## Adaptation

- Solar modules preserve ECS ownership, exact code headers, asset paths, entry
  scenes, user notes and targeted verification rules.
- Upstream guides and scripts are reference material. Their architecture, editor
  plugins, studio roles, helper scripts and engine defaults do not override the
  user's game or Solar's rules. The loader does not execute them.
- Preserve existing code. Adapt only the required patterns; verify unfamiliar
  APIs against the actual engine and validate saved files when permitted.
- Reuse current/local art or coherent primitives to establish visible gameplay;
  follow supplied reference/custom-art requests. External pack downloads still
  require the user's selection and carry their own license information.
- Keep the selected primary model and manual reasoning. Image helpers remain
  available when configured; importing studio guidance does not create an agent team.

The English core prompt targets 6 KB including the generated test budget. Native
skill names/descriptions add separate catalog context; that overhead is not part
of the core-size measurement. Larger art, memory and validation bodies load only
when selected. No per-guide
OpenCode restart is required. Restart the application to activate this release
in an already running app/chat server.

## Packaging and limitations

The bundle adds approximately 8 MB of text/catalog resources and is covered by
the existing `resources/**` package/asar-unpack rules on all platforms. Startup
does not download content. Source is pinned to commit
`9e2b2beaf0bc7ba2e27a40326d058ff2c7a619a9`; see
[bundle provenance and licenses](../resources/game-guidance/README.md).

Native cache copies add instruction text in userData; they are reused across
projects and preserved while another instance may still use a snapshot. Normal
app builds do not install or update the upstream repository.

This integration does not prove that every upstream example is compatible or
that generation is faster. Type checks, syntax checks and the production build
are checked during implementation; no paid generation benchmark or live model
acceptance run is implied. OpenCode compaction tuning, incremental
`project_context` and declarative runtime verification remain later work.
