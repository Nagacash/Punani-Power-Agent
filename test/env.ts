import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * The state directory, for tests that read the log.
 *
 * The logger resolves the state directory when its module loads, so the
 * environment has to be set before anything else is imported. This module
 * must stay the first import in the test file that needs it.
 */
export const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "punani-state-"))
process.env.XDG_STATE_HOME = stateDir
