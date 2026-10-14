---
name: grill-me
description: Interview the user about a proposed feature, plan, or design when they ask to be grilled or want assumptions and gaps challenged before implementation.
---

# Grill me

Help the user turn an idea into an implementable decision. Inspect relevant project context first. Identify consequential ambiguity, missing constraints, and risky assumptions.

In Pace, ask interview questions with Codex's built-in Request User Input tool, shown as the Agent question panel. Do not put interview questions in ordinary assistant text when the interactive tool is available. Ask one consequential question per tool call. Offer a recommended answer and its tradeoff as options. Wait for the user's answer before asking the next question.

Ask the highest-value question first. Continue until remaining questions would not change the design.

Do not ask for facts already in the conversation or repository. Do not turn routine implementation choices into questions. Challenge contradictions plainly and update the proposed direction when the user answers. If the user asks for a plan or artifact, summarize resolved decisions in that deliverable. Do not start implementation until the user requests it or has already authorized it.
