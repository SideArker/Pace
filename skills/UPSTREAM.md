# Bundled engineering skills

`tdd`, `diagnosing-bugs`, `code-review`, and `prototype` are adapted from [Matt Pocock's skills](https://github.com/mattpocock/skills) at commit `49dd158d1076134a641b33efb035946536778336` (MIT; see [LICENSE.mattpocock](LICENSE.mattpocock)).

Pace adaptations make each skill usable without Claude's Skill tool, an issue-tracker setup skill, or mandatory subagent support. Consequential user questions use Pace's interactive question panel. Existing user authorization applies without repeated confirmation. Prototypes record their result without automatically publishing branches or issues.

The bundled files live under `skills/` and are discovered by the existing skill loader. User-installed skills with the same name take precedence. Bundling makes skills available; activation remains controlled by the user's commands and existing skill matching.
