import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { initialState, type WatcherState } from "./types.js";

const statePath = path.join(config.dataDir, "state.json");

export async function ensureDataDir(): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
}

export async function loadState(): Promise<WatcherState> {
  try {
    const raw = await fs.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<WatcherState>;
    // Merge over defaults so new fields added later don't break old state files.
    return { ...initialState, ...parsed };
  } catch {
    return { ...initialState };
  }
}

export async function saveState(state: WatcherState): Promise<void> {
  await ensureDataDir();
  const tmp = `${statePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await fs.rename(tmp, statePath);
}
