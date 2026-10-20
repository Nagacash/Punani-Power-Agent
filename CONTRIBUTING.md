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

## What `main` requires

| Rule | Why |
| --- | --- |
| A pull request, always | No direct pushes, so every change is reviewed and CI runs on it |
| CI green and up to date | The branch has to be current with `main`, not just green once |
| Conversations resolved | No leaving a review comment unanswered |
| Linear history, no force pushes, no deletions | The history stays readable |

**One approving review is not required.** This is a single-maintainer project, and GitHub does not let an author approve their own pull request — so requiring one would mean no pull request could ever be merged. Review comments still happen; they just do not block the merge. If a second maintainer joins, turn the requirement back on in the branch protection settings.

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
