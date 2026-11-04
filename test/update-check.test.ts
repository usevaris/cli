// Tests for the update check: when it asks GitHub, what it remembers, and
// when it stays quiet.

import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHECK_INTERVAL_MS,
  cacheFile,
  checkForUpdate,
  type UpdateCheckDeps,
  updateNotice,
} from "../src/lib/update-check.ts";

let home: string;
let requests: number;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "varis-update-check-"));
  requests = 0;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** A fetch that answers /releases/latest as GitHub does: a redirect to the tag. */
function githubLatest(version: string): typeof fetch {
  return (async () => {
    requests++;
    return new Response(null, {
      status: 302,
      headers: { location: `https://github.com/usevaris/cli/releases/tag/v${version}` },
    });
  }) as typeof fetch;
}

const failingFetch = (async () => {
  requests++;
  throw new TypeError("fetch failed");
}) as typeof fetch;

function deps(overrides: Partial<UpdateCheckDeps> = {}): UpdateCheckDeps {
  return {
    env: {},
    home,
    platform: "darwin",
    version: "1.0.2",
    channel: { kind: "script", binary: path.join(home, ".varis", "bin", "varis") },
    interactive: true,
    fetch: githubLatest("1.1.0"),
    now: () => Date.parse("2026-11-02T12:00:00Z"),
    ...overrides,
  };
}

async function remember(checkedAt: string, latest: string | null) {
  const file = cacheFile(deps());
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ checked_at: checkedAt, latest }));
}

describe("checkForUpdate", () => {
  it("announces a newer full release, and remembers it beside the credentials", async () => {
    expect(await checkForUpdate("publish", deps())).toBe("1.1.0");

    expect(requests).toBe(1);
    const file = path.join(home, ".config", "varis", "update-check.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      checked_at: "2026-11-02T12:00:00.000Z",
      latest: "1.1.0",
    });
  });

  it("stays quiet on the latest version, or a newer one", async () => {
    expect(await checkForUpdate("publish", deps({ version: "1.1.0" }))).toBeNull();
    expect(await checkForUpdate("publish", deps({ version: "1.2.0" }))).toBeNull();
  });

  it("tells a pre-release copy about the full release that follows it", async () => {
    expect(await checkForUpdate("publish", deps({ version: "1.1.0-rc.1" }))).toBe("1.1.0");
    expect(await checkForUpdate("build", deps({ version: "1.2.0-rc.1" }))).toBeNull();
  });

  it("uses a remembered answer for a day without asking again", async () => {
    await remember("2026-11-02T00:00:00.000Z", "1.1.0");

    expect(await checkForUpdate("publish", deps({ fetch: githubLatest("9.9.9") }))).toBe("1.1.0");
    expect(requests).toBe(0);
  });

  it("asks again once the remembered answer is a day old", async () => {
    await remember(new Date(Date.parse("2026-11-02T12:00:00Z") - CHECK_INTERVAL_MS).toISOString(), "1.0.2");

    expect(await checkForUpdate("publish", deps())).toBe("1.1.0");
    expect(requests).toBe(1);
  });

  it("remembers a failed request too, so an offline machine tries once a day", async () => {
    await remember("2026-10-01T00:00:00.000Z", "1.0.5");

    expect(await checkForUpdate("publish", deps({ fetch: failingFetch }))).toBe("1.0.5");
    expect(await checkForUpdate("publish", deps({ fetch: failingFetch }))).toBe("1.0.5");
    expect(requests).toBe(1);
  });

  it("never asks GitHub during varis test, but uses a remembered answer", async () => {
    expect(await checkForUpdate("test", deps())).toBeNull();
    expect(requests).toBe(0);

    await remember("2026-10-01T00:00:00.000Z", "1.1.0");
    expect(await checkForUpdate("test", deps())).toBe("1.1.0");
    expect(requests).toBe(0);
  });

  it("ignores a remembered file it can't read, and replaces it", async () => {
    const file = cacheFile(deps());
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "not json");

    expect(await checkForUpdate("publish", deps())).toBe("1.1.0");
    expect(JSON.parse(await readFile(file, "utf8")).latest).toBe("1.1.0");
  });

  it("never throws, even when the folder can't be written", async () => {
    // A file where the config folder should be.
    await writeFile(path.join(home, ".config"), "");

    expect(await checkForUpdate("publish", deps())).toBeNull();
  });

  it.each([
    ["VARIS_NO_UPDATE_CHECK is set", { env: { VARIS_NO_UPDATE_CHECK: "1" } }],
    ["CI is set", { env: { CI: "true" } }],
    ["stderr isn't a terminal", { interactive: false }],
    ["it runs from source", { channel: { kind: "source" as const } }],
    ["varis upgrade can't upgrade this copy", { channel: { kind: "unknown" as const, binary: "/opt/varis" } }],
  ])("doesn't check when %s", async (_, overrides) => {
    expect(await checkForUpdate("publish", deps(overrides))).toBeNull();
    expect(requests).toBe(0);
  });

  it.each(["upgrade", "dracarys"])("doesn't check, or write anything, for varis %s", async (command) => {
    expect(await checkForUpdate(command, deps())).toBeNull();
    expect(requests).toBe(0);
    await expect(readFile(cacheFile(deps()), "utf8")).rejects.toThrow();
  });

  it("keeps the file beside the credentials on Windows", () => {
    expect(cacheFile({ env: { APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, home: "C:\\Users\\a", platform: "win32" }))
      .toBe("C:\\Users\\a\\AppData\\Roaming\\varis\\update-check.json");
  });
});

describe("updateNotice", () => {
  it("names both versions and what to run", () => {
    expect(updateNotice("1.0.2", "1.1.0")).toBe(
      "A newer varis is available: 1.1.0 (you have 1.0.2). Run varis upgrade.",
    );
  });
});
