# Contributing to starfall

Thanks for wanting to help. The project is deliberately small: no framework,
no backend, plain ES modules.

## Dev setup

```bash
npm install
npm run dev
```

Open http://localhost:5173. For the full experience add a GitHub fine-grained
token (public repos, read-only) via the ⚙ button — it stays in your browser's
localStorage.

## Before you open a PR

```bash
npm run build
```

The build must pass clean. Keep changes small and focused; match the existing
code style (no semicolons where absent, single quotes, small modules).

## House rules

- No backend, no build-time secrets, no analytics/tracking of visitors.
- API budgets are a feature: anything that adds GitHub API calls must respect
  the existing rate-limit guards and document its cost.
