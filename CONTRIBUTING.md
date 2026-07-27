# Contributing

## Prerequisites

- Windows x64
- Node.js 22.13 or later
- pnpm 11

## Local checks

```powershell
pnpm install --frozen-lockfile
pnpm electron:install
pnpm typecheck
pnpm test
pnpm build
```

Run `pnpm test:e2e` from a normal local terminal when browser policy permits localhost access. Do not commit runtime state, credentials, generated installers, or personal machine paths.

## Pull requests

Keep changes focused, add or update tests when behavior changes, and explain security-sensitive changes in the pull request description.
