---
name: solar-assets
description: Reference images, uploaded packs, asset layout, itch.io selection and optional 2D or 3D generation with safe replacement.
---

# Solar assets

Use existing project assets and the user's art direction first. For a new game, build a visible, coherent first mechanic with locally available art or styled primitives; do not block gameplay on a pack-selection round. When the user explicitly requests custom art or supplies a visual reference, follow it. Asset generation is optional and is only available when its tool is listed.

All usable assets live under assets/entities/<entity-id>/, assets/ui/ or assets/shared/. Assets staged under .solar/ must be selectively copied into assets/ before Godot can load them. Never copy a whole pack by default.

## Reference screenshots & images

Users attach screenshots and reference images (games they like, sketches, mock-ups) to
their messages. Each attached image is also saved under `.solar/attachments/` and
its path listed in the message — if you cannot view images yourself, send those paths to
the **image-reader** subagent and ask for everything you'll need (art style, palette,
layout, mechanics, exact text) before you start building; its answer is your only view
of the image.

An attached image is a design brief — study it closely before writing code or generating
art, and keep referring back to it:

- **Art**: match the image's art style, color palette, proportions, lighting, and mood in
  every asset you create. Put those specifics into your generation prompts (e.g. "16-bit
  pixel art, dusk palette of deep purples and orange highlights, chunky outlines") rather
  than generic descriptions.
- **Game logic**: read the genre, camera perspective, controls, HUD layout, and visible
  mechanics out of the screenshot and build those — don't substitute a generic version of
  the genre.
- When the goal is "make it look like this", verify it does: have the **game-tester**
  subagent screenshot the running game and compare it against the reference before
  reporting back.

## User-uploaded asset packs (zips & folders)

Users can also attach whole asset packs — `.zip` archives, folders, or single asset
files (3D models, audio, fonts). Each is copied into the project under
`.solar/attachments/` and its path listed in the message.

- Extract required archive files into staging before use. Keep paths contained, reject
  symlink/traversal entries and preserve existing game files. Then inspect the contents
  (use the image-reader subagent on previews/sprites if you cannot
  view images).
- Everything under `.solar/` is invisible to Godot and git. To USE an asset in the
  game, copy it into the proper `assets/` sub-folder first (following the layout above),
  then wire it into scenes — never reference `.solar/...` paths from game code.
- Copy selectively: just the files the game needs, renamed to fit the project, not the
  whole pack.

## Free asset packs from itch.io (`itch_search` / `itch_download`)

Two always-available tools (server `solar`) fetch FREE asset packs from itch.io —
no account or key needed. The USER picks; you search and fetch:

1. When the user wants external packs or existing assets do not cover the requested art,
   call `itch_search` with one specific
   query ("pixel art dungeon tileset", "low poly nature pack"). Searches are
   rate-limited — one good query, not several variations.
2. Relay the returned numbered list to the user VERBATIM — keep the numbering and the
   markdown links intact (they are clickable in the chat) — and ask them to pick an
   option. Alongside the list, offer custom art when a generation tool is configured, or
   locally made art when appropriate. Include the license information: every
   itch.io asset carries its own license, and the user should check the asset's page for
   usage and attribution rules before shipping their game with it.
3. Only after the user chooses, call `itch_download` with that option's exact URL. Never
   download unasked, and never invent URLs — use ones from `itch_search` results or that
   the user pasted.
4. The download lands in `.solar/itch/<name>/` and follows the SAME rules as
   user-uploaded packs above: review the returned file listing (image-reader on previews
   if you cannot view images), copy ONLY the files the game needs into the proper
   `assets/` sub-folders, renamed to fit the project, and wire them into scenes. YOU
   decide the assets/ organization from the user's instructions — the tool never does.
5. If search reports itch.io is rate-limiting, bot-checking, or otherwise unavailable,
   tell the user plainly and try again later — never hammer retries. The
   user can always browse itch.io themselves and paste an asset page URL, which
   `itch_download` accepts directly. If a download fails as paid or web-only, say so
   honestly and offer a free alternative or generated art instead.

### Generating 2D art (`generate_2d_asset`)

If the `generate_2d_asset` tool is available (server `solar` — the user enables it
by adding an OpenAI API key in the AI settings panel), you can generate 2D art:

- Output is fixed: one 1024×1024 PNG with a TRANSPARENT background, medium quality —
  ideal for sprites, icons, items and UI elements. Godot auto-imports it as a texture.
- One subject per call. Prompt like an artist brief: subject, colors/materials, art
  style, and the view angle the game needs (e.g. "side view, pixel-art style" for a
  platformer sprite, "top-down" for a shooter, "flat vector icon" for UI).
- `folder` + `name` decide where it lands, mirroring the ECS layout exactly like 3D
  assets: `folder: "entities/e_player", name: "player-sprite"`
  → `assets/entities/e_player/player-sprite/`.

### Generating 3D models (`generate_3d_asset`)

If the `generate_3d_asset` tool is available (server `solar` — the user enables it
by adding Tencent HY 3D credentials in the AI settings panel), you can generate real,
textured 3D models:

- One object per call. Prompt like an artist brief: subject, shape, colors/materials,
  style — e.g. "a small red rocket ship, rounded retro style, glossy paint, cartoon".
- `folder` + `name` decide where it lands: `folder: "entities/e_player", name: "rocket"`
  → `assets/entities/e_player/rocket/`. Match the folder to the owning ECS file.
- Keep `face_count` modest (default 60000) — this is a game, not a render farm. Use
  `generate_type: "LowPoly"` for stylized games and `"Geometry"` for untextured shapes.
- Calls take 1–5 minutes and return a preview image — LOOK at it (via the image-reader
  subagent if you can't view images); if the model is wrong, refine the prompt and
  regenerate rather than shipping a bad asset.
- Godot auto-imports the saved `.obj`/`.glb` under `res://` — instance it in the
  entity's scene.

### Asset previews & user feedback

Every generated asset's preview is shown to the user in the chat with a "Request
changes" button. When the user gives feedback on an asset (e.g. 'Change the
"rocket" asset (assets/entities/e_player/rocket): make it blue'):

- Regenerate with the SAME `folder` and `name` so the new files replace the old ones —
  scenes referencing the asset keep working. Never create "-v2" copies.
- Fold the feedback into a full, self-contained prompt (the generator has no memory of
  the previous attempt — re-describe the whole asset, not just the delta).
- Check the returned preview against the user's feedback before reporting back (ask the
  image-reader subagent to describe the generated file if you can't view images).

If a generation tool is NOT available, don't ask the user for it or fake a call — build
placeholder art instead (SVG/PNG sprites, Godot primitive meshes), organized in the same
`assets/` layout.
