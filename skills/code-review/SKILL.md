---
name: code-review
description: Review a branch, PR, commit range, or work in progress against repository standards and the requested behavior. Report actionable findings with file locations and evidence.
---

# Code review

Review the change along two independent axes: repository standards and the originating request or specification. Do not edit code unless the user also requests fixes.

## Establish scope

Use the comparison the user supplied. Resolve the base reference before reviewing. For a branch review, compare the merge base with HEAD and inspect the relevant commit list. For work in progress, include staged, unstaged, and relevant untracked files. If no scope is stated, use current uncommitted changes when present; otherwise infer the branch base from repository context. Ask through Pace's interactive Request User Input tool only if the comparison remains consequentially ambiguous.

Find the requested behavior in the conversation, linked issue, or repository specification. Use the project's existing tracker tools when available; no tracker setup or additional skill is required. If no specification is available, state the limitation and still review code correctness.

## Review standards

Read applicable AGENTS.md, CONTRIBUTING.md, and CODING_STANDARDS.md files plus surrounding code. Repository rules override general preferences. Trace changed callers and ownership boundaries before reporting a violation.

Consider misleading names, duplication, misplaced behavior, repeated switches, scattered changes for one responsibility, and abstractions without a current need. These are judgment calls, not automatic defects. Report a design concern only when the change causes a concrete maintenance or correctness problem. Skip issues already covered by deterministic tooling.

## Review requested behavior

Trace the user's acceptance conditions through the diff. Look for missing behavior, unrelated additions, broken edge cases, and plausible code that violates the request. Check whether verification exercises the actual behavior and failure paths. Distinguish observed defects from unverified risks.

Use independent review passes when delegation is available and allowed; otherwise perform both passes directly. Keep their conclusions separate so standards compliance cannot hide missing behavior.

## Report

For each actionable finding, give severity, path and line, triggering scenario, consequence, and the smallest responsible fix. Cite the applicable rule or requested behavior. Lead with defects and missing requirements. If no actionable findings remain, say so and report material verification gaps. Do not invent findings to fill a quota.
