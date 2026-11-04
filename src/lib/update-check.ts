// Tells the developer when a newer varis is out: "A newer varis is
// available: 1.1.0 (you have 1.0.2). Run varis upgrade."
//
// HOW IT STAYS OUT OF THE WAY
// - It asks GitHub at most once a day, and remembers the answer in
//   update-check.json beside the credentials file. Every other run reads that
//   file and makes no request.
// - The request starts alongside the command and has 2 seconds, so a slow or
//   missing network adds at most that, and only once a day.
// - Nothing it does can fail a command: any error means no notice.
// - The notice goes to stderr after the command's own output, so a command
//   piped into another program still gives that program only its result.
//
// WHEN IT DOESN'T RUN
// - VARIS_NO_UPDATE_CHECK is set, or CI is (no one reads it there).
// - stderr isn't a terminal: a script, a pipe, or a log.
// - The command is upgrade (it checks for itself) or dracarys (it deletes
//   the folder the file lives in, and must leave it deleted).
// - This copy runs from source, or was installed some way varis upgrade
//   can't upgrade, so "Run varis upgrade" would be wrong advice.
// - varis test reads the remembered answer but never asks GitHub: it
//   promises no network beyond the developer's own machine.
//
// It asks for the latest full release, so a pre-release is never offered,
// and a pre-release copy hears about the full release that follows it.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Env } from "./constants.ts";
import { credentialsPath } from "./credentials.ts";
import type { Channel } from "./install-channel.ts";
import { compareVersions, latestVersion } from "./release.ts";

/** How long a remembered answer stays good. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** How long the request to GitHub may take. */
const CHECK_TIMEOUT_MS = 2_000;

/** Commands that never check: see WHEN IT DOESN'T RUN above. */
const SKIPPED_COMMANDS = new Set(["upgrade", "dracarys"]);

/** Commands that read the remembered answer but never ask GitHub. */
const OFFLINE_COMMANDS = new Set(["test"]);

export const CACHE_FILE = "update-check.json";

export type UpdateCheckDeps = {
  env: Env;
  home: string;
  platform: NodeJS.Platform;
  /** This copy's version. */
  version: string;
  /** How this copy was installed. */
  channel: Channel;
  /** Whether stderr is a terminal a person reads. */
  interactive: boolean;
  fetch: typeof fetch;
  now: () => number;
};

/** What update-check.json remembers. */
type Remembered = { checkedAt: number; latest: string | null };

/**
 * Starts a check for `command`, alongside it. Resolves to the newer
 * version to announce, or null. Never rejects.
 */
export async function checkForUpdate(
  command: string,
  deps: UpdateCheckDeps,
): Promise<string | null> {
  try {
    if (!shouldCheck(command, deps)) return null;

    const file = cacheFile(deps);
    const remembered = await readRemembered(file);
    const fresh = remembered !== null &&
      deps.now() - remembered.checkedAt < CHECK_INTERVAL_MS;

    let latest = remembered?.latest ?? null;
    if (!fresh && !OFFLINE_COMMANDS.has(command)) {
      latest = await askLatest(deps.fetch) ?? latest;
      // Remembered even when the request failed, so an offline machine
      // tries once a day, not on every run.
      await writeRemembered(file, { checkedAt: deps.now(), latest });
    }

    return latest !== null && compareVersions(deps.version, latest) < 0 ? latest : null;
  } catch {
    return null;
  }
}

/** The line to print for `latest`. */
export function updateNotice(version: string, latest: string): string {
  return `A newer varis is available: ${latest} (you have ${version}). Run varis upgrade.`;
}

/** Whether this run checks at all. */
export function shouldCheck(command: string, deps: UpdateCheckDeps): boolean {
  if (deps.env.VARIS_NO_UPDATE_CHECK || deps.env.CI) return false;
  if (!deps.interactive) return false;
  if (SKIPPED_COMMANDS.has(command)) return false;
  // varis upgrade can upgrade only these.
  return ["homebrew", "scoop", "script"].includes(deps.channel.kind);
}

/** update-check.json, in the same folder as the credentials file. */
export function cacheFile(deps: Pick<UpdateCheckDeps, "env" | "home" | "platform">): string {
  const credentials = credentialsPath({ env: deps.env, home: deps.home, platform: deps.platform });
  const directory = deps.platform === "win32"
    ? path.win32.dirname(credentials)
    : path.dirname(credentials);
  return deps.platform === "win32"
    ? path.win32.join(directory, CACHE_FILE)
    : path.join(directory, CACHE_FILE);
}

/** The latest full release, or null when GitHub didn't answer in time. */
async function askLatest(fetchFn: typeof fetch): Promise<string | null> {
  try {
    return await latestVersion(fetchFn, CHECK_TIMEOUT_MS);
  } catch {
    return null;
  }
}

/** The remembered answer, or null when there's none or it can't be read. */
async function readRemembered(file: string): Promise<Remembered | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
  const { checked_at: checkedAt, latest } = (parsed ?? {}) as Record<string, unknown>;
  if (typeof checkedAt !== "string" || Number.isNaN(Date.parse(checkedAt))) return null;
  return {
    checkedAt: Date.parse(checkedAt),
    latest: typeof latest === "string" ? latest : null,
  };
}

async function writeRemembered(file: string, remembered: Remembered): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify({
      checked_at: new Date(remembered.checkedAt).toISOString(),
      latest: remembered.latest,
    })}\n`,
  );
}
