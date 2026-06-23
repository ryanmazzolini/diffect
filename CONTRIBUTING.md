# Contributing

Thanks for helping improve Diffect.

## Setup

```sh
mise install
pnpm install
pnpm build
pnpm --filter @diffect/e2e test
```

For the desktop shell:

```sh
cargo check --manifest-path packages/desktop/src-tauri/Cargo.toml
```

## Before opening a PR

Run the broad checks, not targeted one-offs:

```sh
pnpm build
pnpm --filter @diffect/e2e test
cargo check --manifest-path packages/desktop/src-tauri/Cargo.toml
```

## Dependencies

Keep dependencies boring. This repo intentionally blocks dependency lifecycle
scripts by default and waits 3 days before installing newly published npm
versions. If a new dependency needs install/build scripts, call that out in the
PR and add the smallest allowlist entry in `pnpm-workspace.yaml`.

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).
