#!/bin/sh
# Refuses a push until /probe-review has been run against exactly this commit
# and came back with nothing outstanding. The receipt is written by the skill's
# final step to .review/.last-review.json.
#
# The point is that the review happens BEFORE Codex sees the branch: a defect
# found here costs minutes, the same defect found by Codex costs a review round
# of five to seven minutes of waiting, and #49 spent 48 of its 89 minutes that
# way.
set -eu

receipt=".review/.last-review.json"
head=$(git rev-parse HEAD)

if [ "${SKIP_REVIEW_GATE:-}" = "1" ]; then
  echo "review gate: skipped by SKIP_REVIEW_GATE=1. Say so in the PR's 'Not verified'." >&2
  exit 0
fi

# Docs-only pushes do not need a code review.
base=$(git merge-base HEAD origin/main 2>/dev/null || echo "")
if [ -n "$base" ]; then
  changed=$(git diff --name-only "$base" HEAD | grep -vE '^(docs/|\.review/|.*\.md$)' || true)
  if [ -z "$changed" ]; then
    echo "review gate: docs-only push, nothing to review." >&2
    exit 0
  fi
fi

if [ ! -f "$receipt" ]; then
  cat >&2 <<MSG
refusing: no review receipt.

Run /probe-review and fix what it finds, then push. It writes
$receipt when it finishes clean.

This is the review that has to happen before the first push -- once Codex is
looking at the branch, every finding costs a round.

To push anyway: SKIP_REVIEW_GATE=1 git push ... , and say so in the PR.
MSG
  exit 1
fi

reviewed=$(sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p' "$receipt" | head -1)
open=$(sed -n 's/.*"findings_open"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' "$receipt" | head -1)

if [ "$reviewed" != "$head" ]; then
  cat >&2 <<MSG
refusing: the review receipt is for $reviewed, HEAD is $head.

Commits landed after the review. Re-run /probe-review -- on a fix round,
/probe-review --fix-round covers pass 0 plus the fix's blast radius.
MSG
  exit 1
fi

if [ "${open:-0}" != "0" ]; then
  echo "refusing: /probe-review left ${open} finding(s) open on this commit. Fix or defer them explicitly, then re-run it." >&2
  exit 1
fi

method=$(sed -n 's/.*"method"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$receipt" | head -1)

case "${method:-unset}" in
  probe-review | probe-review-workflow)
    echo "review gate: reviewed clean at ${head} by ${method}." >&2
    ;;
  *)
    # A receipt written by hand is still a receipt -- the review may genuinely
    # have happened, for instance when /probe-review is not loadable in that
    # session. But it is an attestation rather than a tool's output, so it says
    # so in the push output where it cannot be missed, and belongs in the PR.
    cat >&2 <<MSG
review gate: reviewed clean at ${head}, method "${method:-unset}".

This receipt was not written by /probe-review. Name the method in the PR's
"Evidence" section and say which passes actually ran.
MSG
    ;;
esac
