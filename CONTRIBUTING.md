# Contributing

Thanks for helping improve Diffect.

## Setup

```sh
mise install
pnpm install --frozen-lockfile
mise run validate
```

## Before opening a PR

Run the broad parity gate, not targeted one-offs:

```sh
pnpm install --frozen-lockfile
mise run validate
```

## Dependencies

Keep dependencies boring. This repo intentionally blocks dependency lifecycle
scripts by default and waits 3 days before installing newly published npm
versions. If a new dependency needs install/build scripts, call that out in the
PR and add the smallest allowlist entry in `pnpm-workspace.yaml`.

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).
