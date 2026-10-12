---
name: solar-bmad-planning
description: "Solar planning: GDD, game brief, epics, stories and production milestones."
compatibility: opencode
---

# solar-bmad-planning

Produce scoped planning artifacts. A new game needs a concise GDD, epics, milestones and the first playable story. A feature or bugfix needs a short story linked to existing design: user value, Given/When/Then acceptance, affected product files, dependencies, risks and concrete test/evidence requirements. Use stable criterion IDs. Research only unknown decisions. Preserve Solar ECS and user choices. Inspect the entry scene and directly relevant product/design files; ignore addon internals, generated import caches and unrelated files. For a small change this adapter supplies the method; read at most one story template if needed. Do not traverse the full GDD or upstream agent workflow. Asset selection and implementation belong to the Developer. The complete assigned skill and bounded Solar story contract provide the planning method; do not retrieve additional methodology pages in Planner stages. Return the stage JSON contract; Solar writes artifacts. Do not run BMAD customization scripts, install _bmad, greet/menu/wait, invoke party mode, spawn validators, implement code or run tests. Microsoft owns sequencing and approvals.

These are optional methodology starting points. Their activation/config/agent/tool instructions do not execute in Solar. Read only the relevant pages with solar_production_guidance; never load the whole bundle. Additional pinned sources can be found through a targeted broker search.

- bmad/src/workflows/4-production/gds-create-story/template.md
- bmad/src/workflows/2-design/gds-gdd/assets/gdd-template.md
- bmad/src/workflows/2-design/gds-gdd/references/headless.md
- bmad/src/workflows/3-technical/gds-create-epics-and-stories/templates/epics-template.md
