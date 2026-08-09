# Security boundary

This project supports authorized public puzzle events only.

Allowed input: public target keys/addresses, published puzzle ranges, and event-owned test fixtures.

Forbidden scope: mass scanning, de-anonymization, credential collection/testing, secret extraction, and reuse of third-party bot/API credentials.

## Credentials

- Git commits, fetch, push, PR, and review actions must use the user's personal GitHub identity.
- Run Git operations from WSL repository root `/home/test/Rotor-Cuda`.
- Do not use Windows Git against `\\wsl.localhost` paths.
- Never put tokens in source, specs, handoff docs, examples, logs, or commits.
- The supplied external PowerShell launcher contained a hardcoded Telegram credential. Treat it as compromised: revoke/rotate it before reuse. This repository intentionally does not copy it.
- Future notifications must use environment variables, Windows Credential Manager, or another approved secret store. Environment variable values must not be logged.

## Output and failure behavior

GPU-BSGS must fail loudly on invalid device, no device, launcher failure, allocation/copy failure, and output truncation. CPU fallback is explicit only; it must never happen silently.

## Reporting

Do not publish target lists, discovered private keys, or operational coverage data outside the authorized event context. Keep test fixtures synthetic or officially public.
