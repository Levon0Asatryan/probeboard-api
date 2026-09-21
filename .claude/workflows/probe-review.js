export const meta = {
  name: 'probe-review',
  description:
    'Adversarial pre-push review of the branch: independent reviewers by lens, each finding attacked by a separate agent, then ranked. Writes .review/.last-review.json so the pre-push gate passes.',
  phases: ['Gather', 'Review by lens', 'Attack the findings', 'Rank and record'],
};

// One reviewer per lens finds more than one reviewer doing every lens in turn:
// on #49 a single hostile self-review found one defect and Codex found seven,
// and it was strongest on resource lifetime, weakest on measurement semantics.
// Each lens here is a defect class this repository has actually shipped.

phase('Gather');

const ctx = await agent(
  `Collect the review context for the current branch of this repository. Do not review anything yet.

Return:
- the diff against origin/main (paths and the full patch),
- the contents of .review/rules/probeboard.md,
- the milestone plan docs/mN-plan.md that this branch implements, if one applies,
- the "Code Review Rules" section of AGENTS.md,
- the current HEAD sha from git rev-parse HEAD.`,
  {
    schema: {
      type: 'object',
      required: ['sha', 'files', 'diff', 'rules', 'plan', 'contract'],
      properties: {
        sha: { type: 'string' },
        files: { type: 'array', items: { type: 'string' } },
        diff: { type: 'string' },
        rules: { type: 'string' },
        plan: { type: 'string' },
        contract: { type: 'string' },
      },
    },
  },
);

if (!ctx) return 'Could not gather the branch context; nothing reviewed.';

const lenses = [
  {
    label: 'measurement',
    brief: `Wrong numbers that look plausible -- the worst defect class here, because the product IS the numbers.
Check every timestamp boundary (rule #6: the clock stops when the measured work ends, never after teardown), every partial result (rule #7: a discarded status becomes UNKNOWN, and M6 excludes UNKNOWN from uptime, so the outage goes unrecorded), and every unit, rounding and clock source. On #49 the dns_ms and total_ms defects were both deviations from sentences already written in the plan.`,
  },
  {
    label: 'concurrency',
    brief: `Duplicates, lost updates, races, deadlocks, lease expiry.
Check lock ordering and that rows are locked before the values that decide the outcome are read (rule #5), slow or fallible work done before a lock is taken (rule #4), durability ordering -- the recovery record committed before the destructive step (rule #3), and any claim/lease arithmetic against its stated bound. SKIP LOCKED removal blocks rather than duplicates, so a disjointness assertion proves nothing about it.`,
  },
  {
    label: 'security',
    brief: `SSRF, secrets, cross-user access, injection, prototype pollution.
Check owner scoping done in the query and not in a service, with ownership columns excluded from update patches (rule #10); SSRF ranges against the full IANA special-purpose registry with each entry cited (rule #11); own-property checks on any traversal of user-supplied paths or header names (rule #9); and that no secret header value, token, authorization code or response text reaches a log, a result or a recovery stream (rule #20).`,
  },
  {
    label: 'tests',
    brief: `Tests that cannot fail, and guards that are not proved.
For every guard this diff adds, name the test and say what removing the guard makes fail -- if the answer is "it still passes", that is the finding (rule #13). Check that no race is forced by a sleep or a bare Promise.all rather than a committed barrier (rule #12), that a test cannot be satisfied for a second reason (a loopback address is already in the SSRF blocklist), and that every branch of a constraint is covered including the shapes it rejects (rule #14).`,
  },
  {
    label: 'contract',
    brief: `The code against what the project already wrote down.
Walk the plan's normative sentences -- every "must", "is anchored on", "is excluded from" -- and point at the line implementing each; a missing one is a finding. Check limits come from validated config and not from a literal or a Postgres DEFAULT (rule #1), with a test proving omission is rejected (rule #2); openapi.yaml and http/ moving in the same change (rule #18); a :dist twin for any new CLI script (rule #16); and nothing contradicting an accepted ADR.`,
  },
  {
    label: 'architecture',
    brief: `Structure and the end-to-end path -- the part a diff review cannot do.
Trace one request or one probe hop by hop (controller -> guard/pipe -> service -> repository -> SQL, or tick -> claim -> loader -> probe() -> release) and say what this change alters at each hop. Check the boundaries: api serves HTTP and never probes, worker probes and never serves HTTP, shared logic lives in core (rule #15), a repository owns its SQL, and Kysely is deliberately a query builder rather than an ORM (ADR-0001). Check what the next milestone depends on. A change that cannot be traced is in the wrong place.`,
  },
];

phase('Review by lens');

const reviews = await pipeline(lenses, (lens) =>
  agent(
    `You are reviewing one lens of a probeboard branch: ${lens.label}.

${lens.brief}

Report ONLY findings this repository's severity contract allows: wrong results, security holes, data loss, concurrency defects, broken or unfailable tests, resource leaks, violated documented contracts. Never style, "consider...", defensive code the types already exclude, coverage as a number, or hardening that only pays off at a scale this thesis project will never reach.

One finding per defect, not per occurrence. For each, give file:line, one sentence stating the defect, and a concrete failure: the input or state, and the wrong output or crash that follows. If a finding asserts a fact -- a limit, a default, a specification, a library's behaviour -- cite it, because it will be checked.

Finding nothing is a valid and useful answer.

HEAD: ${ctx.sha}
Changed files:
${ctx.files.join('\n')}

Rules corpus:
${ctx.rules}

Severity contract:
${ctx.contract}

Plan:
${ctx.plan}

Diff:
${ctx.diff}`,
    {
      label: lens.label,
      schema: {
        type: 'object',
        required: ['findings'],
        properties: {
          findings: {
            type: 'array',
            items: {
              type: 'object',
              required: ['file', 'line', 'claim', 'failure'],
              properties: {
                file: { type: 'string' },
                line: { type: 'number' },
                claim: { type: 'string' },
                failure: { type: 'string' },
                rule: { type: 'string' },
                severity: { type: 'string' },
              },
            },
          },
        },
      },
    },
  ),
);

// Index-aligned with `lenses`: a stopped or failed agent resolves to null and
// must keep its slot, or every later finding is attributed to the wrong lens.
const found = reviews.flatMap((r, i) =>
  (r?.findings ?? []).map((f) => ({ ...f, lens: lenses[i].label })),
);

const lost = reviews.filter((r) => !r).length;
if (lost > 0)
  log(`${lost} of ${lenses.length} lenses returned nothing — findings may be incomplete.`);

if (found.length === 0) {
  log('No findings from any lens.');
}

phase('Attack the findings');

// A finding is reviewed by someone other than its author. Two of Codex's
// findings in M2 and M3 were wrong on their own numbers, and implementing a
// finding whose premise is false costs a round AND a defect.
const verdicts = await pipeline(found, (f) =>
  agent(
    `Try to knock this review finding down. You did not write it and you are not obliged to agree.

FINDING (${f.lens}) ${f.file}:${f.line}
${f.claim}
Failure claimed: ${f.failure}
${f.rule ? `Cites rule: ${f.rule}` : ''}

Read the actual code at that location and decide:
1. Is the premise TRUE? If it cites a limit, a default, a specification or a library's behaviour, verify it against the source, not against memory.
2. Does the claimed failure actually follow? Construct the input or state that produces it. If you cannot, the finding does not survive.
3. Is it excluded by the severity contract -- style, preference, defensive code the types exclude, fleet-scale hardening, or something already deferred in docs/tracker.md?

Return CONFIRMED only when you built the failing case, PLAUSIBLE when the defect is real but you could not construct the case, and REJECTED with the reason when the premise is false or the contract excludes it.`,
    {
      label: `${f.file}:${f.line}`,
      schema: {
        type: 'object',
        required: ['verdict', 'reason'],
        properties: {
          verdict: { type: 'string', enum: ['CONFIRMED', 'PLAUSIBLE', 'REJECTED'] },
          reason: { type: 'string' },
          severity: { type: 'string' },
        },
      },
    },
  ),
);

const survived = found
  .map((f, i) => ({ ...f, ...(verdicts[i] ?? { verdict: 'PLAUSIBLE', reason: 'not attacked' }) }))
  .filter((f) => f.verdict !== 'REJECTED');

phase('Rank and record');

const report = await agent(
  `Rank these surviving review findings for a probeboard branch, most severe first, and deduplicate findings that are the same defect seen through two lenses.

Then write the receipt the pre-push gate reads. Write the file .review/.last-review.json containing exactly:

{"sha": "${ctx.sha}", "at": "<ISO timestamp from the date command>", "findings_open": <number of CONFIRMED or PLAUSIBLE findings after deduplication>, "method": "probe-review-workflow", "lenses": ${lenses.length}, "attacked": ${found.length}, "rejected": ${found.length - survived.length}}

findings_open must be the deduplicated count of findings the author still has to act on. If it is zero the gate will let the push through, so do not round it down.

Findings:
${JSON.stringify(survived, null, 2)}

Return a short report: the ranked findings with file:line, the claim, the concrete failure, and the verdict; then one line saying how many were raised, how many were rejected on attack, and what the receipt now says.`,
  { label: 'rank and write receipt' },
);

return report ?? 'Review ran but the ranking agent returned nothing; receipt not written.';
