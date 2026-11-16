# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use the
**Security → Report a vulnerability** button on this repository (private
vulnerability reporting) or contact the maintainer through the address listed
on the project site. Include:

- affected component (coordinator, browser worker/wasm, key explorer, desktop
  tools) and version/commit,
- reproduction steps or a proof of concept,
- impact assessment (key exposure, fund loss, denial of service, privacy),
- whether the report may be credited publicly.

We aim to acknowledge a report within 72 hours and to ship a fix or mitigation
for confirmed high-severity issues as soon as practical. Please give us a
reasonable window before public disclosure.

## Scope and expectations

- The private key explorer and transaction tools promise that keys never leave
  the browser. A report showing a key, WIF or seed leaving the page, reaching a
  server, a URL, storage or a log is in scope and high severity.
- The coordinator never holds user funds and never signs transactions. Reports
  about signing or sweeping on the user's behalf are out of scope because those
  features do not exist.
- Provider lookups only send derived public addresses, and only after the user
  explicitly enables them.
- Vulnerabilities in third-party dependencies should also be reported through
  GitHub's Dependabot alerts; we triage those separately.

## Supported versions

The `main` branch is the supported version; release assets are rebuilt from it.
Older tags receive fixes only when the issue is critical and the fix applies
cleanly.
