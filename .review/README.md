# `.review/` — probeboard's own review rules

`rules/probeboard.md` holds the rules mined from this repository's merged pull
requests. `/probe-review` (in `.claude/skills/`) reads them, and nothing else.

## This corpus is sealed to this repository

probeboard is a separate environment on this machine. Its rules are written
here, read here, and never mixed with a personal or work corpus elsewhere —
those describe other stacks and other employers' conventions, and a rule from
one would argue against an ADR in the other.

`/probe-review` enforces this by construction: it reads `.review/rules/`,
`AGENTS.md`, `CLAUDE.md`, `docs/mN-plan.md` and the ADRs, and no path outside
the repository.

**If you also run the `review-kit` plugin here**, point its four locations
inside this repository first, or its global tier loads from `~/.claude/review`:

```json
// .claude/settings.json  (untracked, per checkout)
{
  "env": {
    "REVIEW_HOME": ".review",
    "REVIEW_RULES_DIR": ".review/rules",
    "REVIEW_PROJECT_DIR": ".review",
    "REVIEW_LOG_FILE": ".review/violations.jsonl"
  }
}
```

Relative paths resolve against the working directory, so this works in a
worktree as well as the main checkout. If the working directory is ever wrong,
the corpus reads as empty — rules stop loading rather than the wrong rules
loading, which is the failure mode to prefer.

`stacks` declares `probeboard` as the only stack, so review-kit's stack
detection cannot pull in `rules/stack/*.md` from outside.

## Keeping it alive

- A finding that recurs gets a rule here, with its `**Why:**` and source PR.
  Rules are numbered and never renumbered — the numbers are referenced from
  PR comments and from `Relates:` lines.
- A rule nobody has fought with in a milestone or two should be deleted. The
  corpus rots the same way a test suite does.
- The 20 rules here came from 114 findings across #28–#49. When a milestone
  closes, mine its PRs again rather than writing rules from memory.
