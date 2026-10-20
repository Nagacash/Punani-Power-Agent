# Test plan progress

Last run: automated checks on this machine. Update checkboxes as you finish manual steps.

## Automated (done)

- [x] **§0** `npm run build` — clean
- [x] **§0** `npm test` — **44/44** pass
- [x] **§1** `--version` → `1.0.0`
- [x] **§1** `--providers` — 8 providers (freellmapi 275, openrouter 468 with keys; ollama/lmstudio 0 if not running locally)
- [x] **§1** `--models` / `--models --free` — catalogs load when network + keys OK
- [x] **§10** `landing/punani-ai` — `clean:appledouble` + `npm run build` OK
- [x] **§11** `npm pack --dry-run` — **88 files**; `npm publish --dry-run` OK

**Already covered by `npm test` (no separate manual step required unless you want to see it yourself):**

| Plan section | Test file / area |
| --- | --- |
| §2 read tool + agent turn | `test/e2e.test.ts` |
| §3 edit permission + diff before write | `test/e2e.test.ts`, `test/web.test.ts` |
| §4 bash + destructive flag | `test/web.test.ts` |
| §5 skill index grouping + tools | `test/skills.test.ts` |
| §6 session JSONL / resume | `test/e2e.test.ts`, session store tests |
| §7 web stream, diff, permissions, origin 403 | `test/web.test.ts` |
| §8 image permission + path sandbox | `test/image.test.ts`, `test/audio.test.ts` |
| §9 MCP skip bad server | `test/mcp.test.ts` |
| Easy miss: `/etc/passwd` via file API | `test/image.test.ts`, `test/web.test.ts` preview path |

## Manual — your turn (~15–20 min)

Do these once in order; use **`TESTING.md`** for expected output.

### Terminal agent (§2–§6)

```bash
mkdir -p /tmp/punani-test && cd /tmp/punani-test
echo 'export const answer = 42' > answer.js
node "/Volumes/MPC_CODE_1/coding/rea ideas/opencode clone/punani-powerd/dist/main.js"
```

- [ ] Ask: `What does answer.js contain?` → must **read** file, answer **42**
- [ ] Ask: add `// generated` to `answer.js` → diff + permission; **`n`** leaves file unchanged; **`y`** applies edit
- [ ] Optional: **`a`** on one path, next edit auto-approves; **`n reason`** reaches model
- [ ] `Run: ls -la` → bash permission
- [ ] `Run: rm -rf /tmp/punani-test` → **destructive** warning (do not confirm if you still need the folder)
- [ ] `/skills` → large count + groups (expect **~926 / 108** if your skill dirs match the doc)
- [ ] `/session` → note id; exit; `node dist/main.js --resume <id>` from `/tmp/punani-test`

### Browser (§7)

```bash
cd "/Volumes/MPC_CODE_1/coding/rea ideas/opencode clone/punani-powerd"
node dist/main.js --web --open
```

(Port **4097** may already be in use on your Mac — use `--port 4098` or stop the old process: `lsof -iTCP:4096 -sTCP:LISTEN`.)

- [ ] Token line + URL in terminal; app loads
- [ ] Message streams; edit shows diff + permission in UI
- [ ] Project pill + **Choose…** (native folder dialog)
- [ ] Settings: save key → `/api/settings` response has **no** secret value
- [ ] “In browser” key → `localStorage` `punani.keys`; close Settings → **cursor in composer**
- [ ] Preview pane + optional `http://localhost:5173` URL mode

### Landing (§10 visual)

```bash
cd landing/punani-ai && npm run dev
```

- [ ] http://localhost:3000 — logo, join form at `#join`, Impressum/Datenschutz links
- [ ] Submit waitlist email (Clerk dev) → `/thanks`

### Media (§8) — optional

- [ ] Image generation turn in CLI
- [ ] `kling who_am_i` / ElevenLabs if you use them

---

When every manual box is checked, the test plan is **finished** for this release.
