Deploy punani-powerd. Repo: github.com/Nagacash/Punani-Power-Agent. `main` is protected, so everything goes through a PR.

## 0. Land the pending work first — **done**

Merged to `main` via PR #1 (`64bfdc8`).

Before any deploy command:

```bash
npm ci && npm run typecheck && npm test
```

## 1. npm — distribution

```bash
npm publish
```

`prepublishOnly` runs the build and the full test suite, so a broken publish cannot ship. Check the tarball first with `npm pack --dry-run`.

Package is `punani-powerd@1.0.0`, binary `punani`, no runtime dependencies. It is not on the registry yet.

## 2. GitHub Releases — standalone binaries, no Node needed

After `.github/workflows/release.yml` is on `main`, tag and push:

```bash
git tag v1.0.0 && git push origin v1.0.0
```

## 3. Docker — shared server

```bash
npm run docker:build
npm run docker:run
```

The `Dockerfile` already exists and runs as a non-root `node` user with the config mounted, not baked in. It binds `0.0.0.0` inside the container and publishes to `127.0.0.1` on the host.

Put it behind nginx with TLS and your own auth before anyone else can reach it — `DEPLOY.md` section 3 has the server block, including `proxy_buffering off` so the event stream works. The built-in token is a second lock, not the only one. The agent runs shell commands as the user that owns the process, so give it a dedicated unprivileged account inside a container or VM, and never run it as root.

## Pick

The three are independent. A deploy can do one, or all three.
