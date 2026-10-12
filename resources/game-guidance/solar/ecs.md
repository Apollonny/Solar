---
name: solar-ecs
description: Solar ECS architecture, component groups, entity composition, system ownership and required file headers.
---

# Solar ECS

## Architecture — Entity Component System (required)

Structure ALL game code as ECS, mapped onto Godot like this:

Apply this structure to the requested gameplay change; preserve unrelated existing code
and deliberate user architecture choices instead of reorganizing the whole project.

- **Components — `components/c_*.gd`** — pure data. Extends `Node`; `@export` data
  fields, signals, and trivial accessors only — no game logic. In `_ready` the component
  adds itself to a group named after its file (`c_health.gd` → group `"c_health"`) so
  systems can find it.
- **Entities — `entities/e_*.tscn` (with an `entities/e_*.gd` script)** — scenes that
  compose components as child nodes. An entity script only wires its own components
  together; behavior belongs in systems.
- **Systems — `systems/s_*.gd`** — all game logic. Extends `Node`, attached under the
  main scene (or an autoload); each frame it processes the members of the component groups
  it cares about (`get_tree().get_nodes_in_group("c_...")`).

Rules:

- Every gameplay feature = component(s) for its data + a system for its behavior + entities
  composed from components. Never put gameplay logic in an entity or component script.
- Use exactly the `e_`, `c_`, `s_` file prefixes, each kind in its folder (create the
  folders on first use). Non-ECS code (menus, HUD, math helpers, shaders) lives outside
  those three folders — e.g. `ui/` or `util/`.
- `main.tscn` (or a deliberately chosen user entry scene) instantiates entities and hosts systems.

## File headers (required — Solar parses these)

Start EVERY code file you create or edit with this comment block, before anything else
(before `extends`). Solar parses it mechanically to show the project's structure in
the UI, so the format is exact: same keys, same order, one `key: value` per line, using
the file type's line-comment prefix (`#` in GDScript, `//` in shaders).

Example for `components/c_health.gd`:

```gdscript
#=== solar ===
# kind: component
# name: Health
# summary: Hit points with a died signal emitted when hp reaches 0.
# uses: none
#=== /solar ===
```

- `kind` — one of `entity | component | system | autoload | ui | util | shader | other`.
- `name` — short display name in PascalCase words.
- `summary` — one line, plain language, under 120 characters; shown to the user in the UI.
- `uses` — comma-separated `c_*` component files this file composes (entities) or
  queries (systems); `none` if none.
- Keep the header up to date whenever the file's purpose changes; never reorder, rename,
  or reformat the keys.
- Scene files (.tscn) cannot hold comments — the entity's `e_*.gd` script header covers
  the entity.
