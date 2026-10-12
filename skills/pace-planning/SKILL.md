---
name: pace-planning
description: Write concise, reviewer-first implementation plans for Pace, including its Markdown plan reader and approval callouts. Use for planning work in Pace.
---

# Pace planning

Write in the user's language. Explain the task and expected result before technical detail. Use plain technical language. Remove filler, repeated points, generic advice, and raw research notes. Explain uncommon terms once.

For a final Markdown plan, start with a short title and task summary. Put a **User Review** section before technical sections, with a `> [!USER REVIEW]` blockquote. State what the user asked for, the expected result, important assumptions, and every approval or unresolved choice. If none need approval, say so briefly. Do not create a separate Decision section or Decision callout. Use `> [!INFO]` and `> [!WARNING]` only for useful context or real risks.

After User Review, cover the relevant current state, proposed approach, ordered implementation steps, verification, and material risks. Keep each section focused; omit empty or redundant sections. Start steps with actions. Name relevant workspace files and explain why each change matters. Use workspace-relative Markdown links for file references, with line numbers only when known. Keep unknowns explicit. Do not invent scope or claim implementation has begun.

When Pace asks for a structured planning handoff, keep its required schema and apply the same concise style to its content. Follow the current user's instructions when they specify a different format or level of detail.
