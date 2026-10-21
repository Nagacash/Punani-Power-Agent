# Permissions hardening checklist (post PR #20)

PR #20 split **ordinary** vs **destructive** actions (`write`, `write-destructive`, `edit`, `edit-destructive`, `bash`, `bash-destructive`). This checklist tracks gaps and follow-ups.

## Priority 1 — Must not reach `allow` without user intent

- [x] Expand `isDestructiveCommand` (bare `rm`, `find -exec rm`, `git push -f`, `+ref`, other package managers’ `publish`, broad `chmod 777`, shell `> file` redirects, `unlink`, `docker prune`) — see `test/destructive-classifier.test.ts`
- [x] Tighten `isRewrite` for **small files** (&lt; 10 lines): large relative deletions count as rewrite
- [x] Web **Always allow** passes `alwaysPatterns` into `resolvePermission` / `engine.remember` (same as terminal `a`)
- [ ] Consider **`bash: ask`** as default instead of **`allow`** if classifier misses still worry you
- [ ] Document that **`/permissions … allow`** on `bash-destructive` is an intentional full bypass

## Priority 2 — Migration (`config/store.ts`)

- [ ] On first load after upgrade, **persist `permissionsVersion: 2`** (optional one-time save) so migration does not re-run from disk forever
- [ ] Known behavior: config whose `write`/`edit` rules **exactly match legacy** is upgraded to new **allow** ordinary write/edit — users who wanted ask-everywhere on those actions get looser defaults (destructive half still **ask**)
- [x] Custom rules not identical to legacy rows are **kept** (covered by `test/e2e.test.ts` migration test)

## Priority 3 — Tests to keep green

| File | What it guards |
|------|----------------|
| `test/permission-flow.test.ts` | Tool → action split (write/edit/bash) |
| `test/destructive-classifier.test.ts` | `isDestructiveCommand` / `isRewrite` edge cases |
| `test/permission-session.test.ts` | Session remember + web-style patterns |
| `test/e2e.test.ts` | Default rules + migration |

## Priority 4 — Out of scope (for now)

- SCIP / repo-wide analysis
- Sandboxing bash (Landlock, allowlisted commands)
- MCP / image / audio: separate actions; default **ask** when unset

## Manual smoke

1. `npm test` — includes classifier + session tests  
2. `punani web` — approve destructive card → **Always** → same pattern should not re-prompt (same action + pattern)  
3. `rm foo` / `git push -f` in agent → should prompt (**bash-destructive**), not silent allow
