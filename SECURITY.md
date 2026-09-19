# Security policy

probeboard makes outbound HTTP requests to URLs its users supply, and stores
credentials those requests send. Both make it a natural target, so security
reports are taken seriously even though this is a university thesis project.

## Reporting a vulnerability

**Do not open a public issue.** Report it privately through GitHub:

1. Go to the repository's [Security tab](https://github.com/Levon0Asatryan/probeboard-api/security).
2. Choose **Report a vulnerability**.

That opens a private advisory visible only to you and the maintainer. Please
include what an attacker can do, the steps or request that demonstrate it, and
the commit you tested against.

You can expect an acknowledgement within a week. A fix for a confirmed issue is
developed privately and released before the advisory is published; you are
credited unless you ask not to be.

## Supported versions

There are no releases yet. Only the latest commit on `main` is supported, and
fixes land there.

## What is in scope

The areas where a finding matters most:

- **Server-side request forgery.** A monitored URL must not be able to reach
  loopback, private, link-local, cloud-metadata or other non-global addresses —
  at save time, at connect time, or through a redirect or a DNS answer that
  changes between the two.
- **Secret headers.** Header values marked secret are encrypted at rest and must
  never appear in a response, a log line, an error or a probe result.
- **Authentication and sessions.** Password and social sign-in, session
  handling, and the account-linking rules.
- **Access between users.** One user reaching another user's services,
  endpoints, headers or results.
- **Injection** of any kind through request fields.

## Out of scope

- Findings that need an already-compromised host, database or configuration.
- Denial of service by sheer volume against a deployment you run yourself.
- Missing hardening headers or best practices with no demonstrated impact.
- Vulnerabilities in dependencies with no exploitable path through probeboard —
  those are tracked by Dependabot.
