---
name: work-plan
description: Maintain an accurate todo plan for substantial multi-step work so users can follow progress in external surfaces.
---

# Work plan

Use the built-in `todo` tool as the sole authoritative plan. Do not duplicate
the plan in prose unless the user asks for it.

- Create a plan only for substantial work with multiple meaningful steps.
- Write short, outcome-oriented task titles that a user can understand without
  internal implementation context.
- Keep exactly one item `in_progress` while work is actively underway.
- Send the complete list on every `todo` write; the tool uses replacement
  semantics.
- Update the list when scope changes. Mark finished work `completed`, work that
  is intentionally dropped `cancelled`, and future work `pending`.
- Do not rename an item merely to report status. Renames are treated as a new
  task by progress renderers.
- Before the final response, reconcile every item with the actual outcome. Do
  not mark blocked, unverified, or incomplete work as completed.
