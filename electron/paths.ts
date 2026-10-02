/**
 * paths.ts — Default filesystem paths for the MPC Sample desktop app.
 * No Electron imports — importable from unit tests.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { DefaultExportDir } from "../src/desktop/bridge.types";

const VOLUMES_DIR = "/Volumes";

/** Volume names tried first; any other volume holding `MPC-Sample/Projects` is also accepted. */
const PREFERRED_VOLUMES = ["SDCARD", "MPC-SD"] as const;

const PROJECTS_SUBPATH = path.join("MPC-Sample", "Projects");

export const VOLUME_ROOT = "/Volumes/MPC-SD" as const;

export const DEFAULT_EXPORT_DIR = "/Volumes/MPC-SD/MPC-Sample/Projects" as const;

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the mounted MPC SD card: the first volume (preferred names first) that
 * contains `MPC-Sample/Projects`. Returns the volume root, or `null`.
 */
export async function findSdVolume(volumesDir: string = VOLUMES_DIR): Promise<string | null> {
  let names: string[];
  try {
    names = await fs.readdir(volumesDir);
  } catch {
    return null;
  }
  const ordered = [
    ...PREFERRED_VOLUMES.filter((n) => names.includes(n)),
    ...names.filter((n) => !(PREFERRED_VOLUMES as readonly string[]).includes(n)),
  ];
  for (const name of ordered) {
    const root = path.join(volumesDir, name);
    if (await exists(path.join(root, PROJECTS_SUBPATH))) return root;
  }
  return null;
}

/**
 * Resolve the default export directory and check whether it is currently
 * accessible (i.e. the SD card is mounted and the path exists).
 */
export async function getDefaultExportDir(): Promise<DefaultExportDir> {
  const root = await findSdVolume();
  if (root) return { path: path.join(root, PROJECTS_SUBPATH), exists: true };
  return { path: DEFAULT_EXPORT_DIR, exists: false };
}
