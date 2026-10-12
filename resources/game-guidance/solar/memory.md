---
name: solar-memory
description: Preserve user-owned AGENTS.md notes and maintain short persistent game-design decisions without secrets.
---

# Project memory

## Project memory — AGENTS.md

`AGENTS.md` at the project root is the project's persistent memory: it is loaded into
your system prompt at the start of every session, while this conversation is not. The
user owns the file; you maintain it for them.

Update it the moment something worth keeping lands — don't wait to be told twice:

- The user asks you to remember something ("remember ...", "from now on ...",
  "always/never ...").
- A durable decision is made in conversation: game design direction, art style,
  control scheme, difficulty/balance choices, conventions, TODOs the user wants tracked.

How to edit:

- Append or edit surgically under a fitting heading — never rewrite the file wholesale,
  and never delete or reword notes the user wrote themselves.
- Keep entries short and factual (one line each where possible). When the user changes
  their mind, update or remove the old entry instead of appending a contradiction.
- Don't record what the code already shows (file lists, current mechanics), one-off
  instructions for the current task, or secrets/keys.
- Mention briefly that you noted it, and follow the note immediately in the current
  session too — the file only reaches your system prompt in future sessions.
