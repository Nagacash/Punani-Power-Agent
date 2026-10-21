---
name: browser
description: Drive a real browser: open a page, click through it, fill a form, take a screenshot, or test a page that is running. Use this whenever the work needs to see a page, not just read the code.
triggers:
  - the user wants a page opened in a browser
  - the user wants a screenshot of a page or of the running app
  - the user wants a page tested, clicked through or filled in
  - the user wants the running app looked at
  - the task needs to see what a page actually looks like
anti-triggers:
  - a page that is only read as source
---

# Browser

A browser the agent can see. It drives Chrome over CDP, so a screenshot
comes back as an image the turn can look at, and a click lands on the page
rather than in the dark.

**Never open a browser with `open`, `start` or `xdg-open`.** That opens a
window on a machine nobody is watching, the turn ends with nothing to show,
and the user has to describe the page themselves. The browser is driven, not
opened.

## How to drive it

Two ways, in this order.

1. **The `browser-use` skill**, when the skill index lists it. Load it with
   `skill_load` and follow it. It is the full workflow, and it is the one to
   use.
2. **The `browser-use` command**, when the skill is not there. It is the same
   thing without the skill around it:

   ```bash
   browser-use <<'PY'
   print(page_info())
   PY
   ```

   The helpers are pre-imported. The first navigation is `new_tab(url)`, not
   `goto_url(url)`.

## What it is for

- Looking at a page the turn just wrote, before saying it looks right.
- Taking a screenshot to show the user.
- Clicking through a flow: sign in, submit a form, follow a link.
- Reading what a page actually says when the source does not say it.

## What it is not for

- Reading a file. `read` and `grep` are faster and they do not need a
  browser.
- Starting the app. `dev` starts the server; the browser opens what it
  serves.
