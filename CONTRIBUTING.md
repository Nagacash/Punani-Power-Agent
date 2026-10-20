# Contributing to Punani Power Agent

Thank you for helping improve **punani-powerd**. This project is open source (MIT), but **`main` is protected** — we do not accept direct pushes or drive-by edits on the default branch.

## How to contribute

1. **Fork** [Punani-Power-Agent](https://github.com/Nagacash/Punani-Power-Agent) on GitHub (do not clone expecting push access to `main`).
2. **Branch** from `main` (`feat/…`, `fix/…`, `docs/…`).
3. **Change** only what your PR needs. Run locally:
   ```bash
   npm ci
   npm run typecheck
   npm test
   ```
4. **Open a pull request** into `Nagacash/Punani-Power-Agent` `main`. Describe the problem and the approach.
5. **CI must pass** (GitHub Actions runs typecheck + tests on every PR).
6. A maintainer **reviews and merges**. Until then, your fork is the place to iterate.

## What we do not merge

- Drive-by refactors unrelated to the issue or PR description
- Changes that disable permissions, logging, or security checks without a clear, reviewed reason
- Commits that include secrets, API keys, or personal config paths
- Direct commits to `main` (use a PR)

## Reporting bugs

Open a [GitHub issue](https://github.com/Nagacash/Punani-Power-Agent/issues) with steps to reproduce, Node version, and provider/model if relevant. Do not paste real API keys.

## Related repos

| Repo | Role |
| --- | --- |
| [Punani-Power-Agent](https://github.com/Nagacash/Punani-Power-Agent) | This agent (`punani` / `punani web`) |
| [Punani-AI](https://github.com/Nagacash/Punani-AI) | Landing site and waitlist ([punani.agency](https://punani.agency)) |

## License

By contributing, you agree that your contributions are licensed under the same [MIT License](./LICENSE) as the project.
