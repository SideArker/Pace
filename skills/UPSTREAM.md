# Bundled engineering skills

`tdd`, `diagnosing-bugs`, `code-review`, and `prototype` are adapted from [Matt Pocock's skills](https://github.com/mattpocock/skills) at commit `49dd158d1076134a641b33efb035946536778336` (MIT; see [LICENSE.mattpocock](LICENSE.mattpocock)).

`unslop` is adapted from [Damir Sokolovsky's unslop](https://github.com/heydamir/unslop) at commit `620163eedb3529d9cd23a3994ed8d287d06f760d` (CC BY 4.0). It includes the snapshot script, design audit, visual guidance, RTL guidance, token references, and three finished-screen examples. The snapshot script was reviewed and adapted to refuse overwrites and strip executable or embedded active content from its saved copy. Story-video scripts and frames are omitted. The stale example link was removed, the contradictory meadow/crystal reference was excluded, and the signs are explicitly framed as heuristics. The original author and license are credited in the skill and references.

Pace adaptations make each skill usable without Claude's Skill tool, an issue-tracker setup skill, or mandatory subagent support. Consequential user questions use Pace's interactive question panel. Existing user authorization applies without repeated confirmation. Prototypes record their result without automatically publishing branches or issues.

The bundled files live under `skills/` and are discovered by the existing skill loader. User-installed skills with the same name take precedence. Bundling makes skills available; activation remains controlled by the user's commands and existing skill matching.
