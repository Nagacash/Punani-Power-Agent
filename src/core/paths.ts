import os from "node:os"
import path from "node:path"

export const APP_NAME = "punani-powerd"
export const APP_TITLE = "Punani powerd by Naga Codex"

function xdg(env: string, fallback: string[]): string {
  const value = process.env[env]
  if (value && value.trim() !== "") return value
  return path.join(...fallback)
}

export const paths = {
  /** XDG config dir. Holds the single secure config file that also stores API keys. */
  configDir: xdg("XDG_CONFIG_HOME", [os.homedir(), ".config", APP_NAME]),
  /** XDG data dir. Holds session history. */
  dataDir: xdg("XDG_DATA_HOME", [os.homedir(), ".local", "share", APP_NAME]),
  /** XDG state dir. Holds caches and the recent-model list. */
  stateDir: xdg("XDG_STATE_HOME", [os.homedir(), ".local", "state", APP_NAME]),
  get configFile(): string {
    return process.env.PUNANI_CONFIG ?? path.join(this.configDir, "config.json")
  },
  get sessionsDir(): string {
    return path.join(this.dataDir, "sessions")
  },
  get stateFile(): string {
    return path.join(this.stateDir, "state.json")
  },
  get logFile(): string {
    return path.join(this.stateDir, "punani.log")
  },
}
