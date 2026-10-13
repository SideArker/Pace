---
name: pace-planning
description: Write standalone implementation handoffs in Pace planning mode.
---

# Pace planning

Keep one planning conversation and one saved Markdown plan. Answer questions directly in chat without changing the plan file. When the user requests a new plan or a revision, write the complete plan to the specified artifact path, then reply with a short summary and its absolute path. Edit the existing file for revisions unless the user explicitly asks for a separate plan. Never edit project files in planning mode.

The saved file is the entire handoff for `/execute`. The executor is a fresh agent with no access to the planning conversation, its thread, or its tool history. Make the file standalone: include the original goal, constraints, verified repository findings, proposed changes and reasons, relevant paths and code locations, assumptions and required user decisions, ordered steps, acceptance criteria, and verification commands. Do not rely on chat context to explain a step.

Write in the user's language. Explain the task and expected result before technical detail. Use plain technical language and workspace-relative file links. State unknowns explicitly. Use this section order:

1. **User Review** only if a user decision is required; put it first and use a `> [!USER REVIEW]` callout.
2. **Risk** for dangerous, breaking, or domain-critical changes.
3. **Task description** for findings, required changes, and reasons.
4. **Comparison** when changing an existing version.
5. **Implementation steps** in executable order.
6. **Verification** always last, with acceptance criteria and commands.

Omit optional sections when they have no content. Keep the plan concise but complete enough for the fresh executor. Do not claim implementation or checks happened unless they did. Follow the current user's instructions when they specify a different format or level of detail.
