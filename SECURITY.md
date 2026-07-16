# Security policy

## Reporting a vulnerability

Please email **mail.hamza.ali@gmail.com** — do not open a public issue for
security reports. You'll get a response within a few days.

## Scope notes

starfall is a fully client-side app. Your GitHub token is stored only in your
own browser's localStorage and is sent only to `api.github.com`. There is no
server, no database, and no third-party analytics. Reports about token
handling, XSS via repo metadata rendering, or supply-chain issues in the
build are especially welcome.

## Supported versions

Only the latest `main` / deployed Pages version is supported.
