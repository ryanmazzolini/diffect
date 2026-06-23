# Security Policy

Diffect is pre-1.0. Security fixes are made on `main`; there are no supported
release branches yet.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's
private vulnerability reporting for this repository.

Include:

- what is affected
- how to reproduce it
- whether it exposes local files, repository contents, credentials, or network access

## Current security model

`diffectd` binds to `127.0.0.1` by default. It has no authentication yet, so do
not expose it to an untrusted network. If you override `--host`, treat every
client that can reach that address as trusted.
