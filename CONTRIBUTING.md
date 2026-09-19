# Contributing to probeboard-api

probeboard is a university diploma thesis: an API monitoring dashboard. Issues
and pull requests are welcome, with one expectation up front — the bar is set
by the thesis, so a change is judged on correctness and on the evidence behind
it, not on size.

This file is the short version. The conventions themselves live in files that
are kept in step with the code, and are not repeated here so they cannot drift:

| File                               | What it holds                                                |
| ---------------------------------- | ------------------------------------------------------------ |
| [README.md](README.md)             | Running it locally, configuration, the repository layout     |
| [CLAUDE.md](CLAUDE.md)             | How work is done, file and folder structure, naming, commits |
| [AGENTS.md](AGENTS.md)             | What a review checks for — read it before opening a PR       |
| [docs/tracker.md](docs/tracker.md) | What is in progress and what is next                         |
| [openapi.yaml](openapi.yaml)       | The HTTP API, generated from the request schemas             |

Design and the reasons behind decisions live in
[probeboard-docs](https://github.com/Levon0Asatryan/probeboard-docs).

## Reporting a bug or asking for a feature

Open an issue from the templates. For a bug, the most useful thing you can give
is a request that reproduces it — the files in [`http/`](http/) are runnable
and a good starting point.

**Security issues are not reported in public.** See [SECURITY.md](SECURITY.md).

## Setting up

Node 22 and Docker. Then:

```sh
npm ci
docker compose up -d postgres
npm run migrate
npm run dev:api
```

[README.md](README.md) covers configuration and the worker process.

## Making a change

1. Branch from the latest `main`, then run `npm ci` again — dependencies differ
   between branches.
2. Keep each pull request to one coherent step, and split its commits by
   logical change. Tests travel with the code they test; each commit must pass
   the pre-commit hook on its own.
3. **A guard, check or filter ships with a test that fails without it.** Remove
   the guard, watch the test fail, put it back. A test that has never been seen
   failing is not evidence. Races are forced with an explicit barrier, not by
   hoping `Promise.all` interleaves.
4. A new or changed endpoint updates `openapi.yaml` (`npm run openapi`) and its
   request in `http/<module>.http`, in the same change.
5. Before opening the PR:

   ```sh
   npm run verify          # format, lint, types, unit tests, openapi check
   npm run test:coverage   # must stay at or above 90%
   npm run test:int        # needs docker compose up -d postgres
   ```

CI runs five jobs on every push and all five must pass. An automated reviewer
comments on each push; every thread gets a reply, whether that is a fix or a
reasoned disagreement.

## Code of conduct

Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE).
