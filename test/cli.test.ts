import { describe, expect, it, vi } from "vitest";
import { publish } from "../src/commands/publish.ts";
import { COMMANDS, helpText, runCli } from "../src/lib/cli.ts";
import { apiOrigin, VARIS_API_ORIGIN } from "../src/lib/constants.ts";
import type { Output } from "../src/lib/output.ts";
import { VERSION } from "../src/lib/version.ts";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  const output: Output = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    status: (t) => err.push(t),
    styled: false,
  };
  return { output, out, err };
}

describe("varis", () => {
  it("lists exactly the eight commands, in order", () => {
    expect(COMMANDS.map((c) => c.name)).toEqual([
      "login",
      "init",
      "build",
      "publish",
      "test",
      "logout",
      "upgrade",
      "dracarys",
    ]);
  });

  it("prints help for --help, -h, and no arguments, exiting 0", async () => {
    for (const argv of [["--help"], ["-h"], []]) {
      const { output, out } = capture();
      expect(await runCli(argv, output)).toBe(0);
      expect(out.join("\n")).toBe(helpText());
    }
  });

  it("names every command with its summary in the help", () => {
    const help = helpText();
    for (const command of COMMANDS) {
      expect(help).toContain(command.name);
      expect(help).toContain(command.summary);
    }
  });

  it("prints the version", async () => {
    const { output, out } = capture();
    expect(await runCli(["--version"], output)).toBe(0);
    expect(out).toEqual([VERSION]);
  });

  it("prints a command's own help", async () => {
    const { output, out } = capture();
    expect(await runCli(["publish", "--help"], output)).toBe(0);
    expect(out.join("\n")).toContain("Usage: varis publish");
  });

  it("rejects an unknown command on stderr, exiting 2", async () => {
    const { output, out, err } = capture();
    expect(await runCli(["invoke"], output)).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("Unknown command: invoke");
  });
});

describe("a command that crashes", () => {
  it("says it's a bug and gives a pre-filled GitHub issue link, exiting 2", async () => {
    const spy = vi.spyOn(publish, "run").mockRejectedValue(new Error("boom"));
    const { output, err } = capture();

    expect(await runCli(["publish", "weather"], output)).toBe(2);

    const printed = err.join("\n");
    expect(printed).toContain("varis publish crashed: boom");
    expect(printed).toContain("issues/new?");
    expect(printed).toContain("command=varis+publish+weather");
    expect(printed).toContain("reporting-issues.md");
    spy.mockRestore();
  });
});

describe("the update notice", () => {
  it("prints after the command's own output, on stderr, when a newer varis is out", async () => {
    const spy = vi.spyOn(publish, "run").mockImplementation(async (_args, output) => {
      output.out("published");
      return 0;
    });
    const asked: string[] = [];
    const { output, out, err } = capture();

    const code = await runCli(["publish"], output, {
      checkForUpdate: async (command) => {
        asked.push(command);
        return "9.0.0";
      },
    });

    expect(code).toBe(0);
    expect(asked).toEqual(["publish"]);
    expect(out).toEqual(["published"]);
    expect(err).toEqual(["", `A newer varis is available: 9.0.0 (you have ${VERSION}). Run varis upgrade.`]);
    spy.mockRestore();
  });

  it("keeps the command's exit code, and prints after a failure too", async () => {
    const spy = vi.spyOn(publish, "run").mockResolvedValue(1);
    const { output, err } = capture();

    expect(await runCli(["publish"], output, { checkForUpdate: async () => "9.0.0" })).toBe(1);
    expect(err.at(-1)).toContain("Run varis upgrade.");
    spy.mockRestore();
  });

  it("prints nothing when there's no newer version", async () => {
    const spy = vi.spyOn(publish, "run").mockResolvedValue(0);
    const { output, err } = capture();

    await runCli(["publish"], output, { checkForUpdate: async () => null });

    expect(err).toEqual([]);
    spy.mockRestore();
  });

  it("doesn't check for help, the version, or an unknown command", async () => {
    let checks = 0;
    const deps = { checkForUpdate: async () => (checks++, "9.0.0") };

    for (const argv of [["--help"], ["--version"], ["publish", "--help"], ["invoke"]]) {
      await runCli(argv, capture().output, deps);
    }
    expect(checks).toBe(0);
  });
});

describe("apiOrigin", () => {
  it("defaults to the Varis API", () => {
    expect(apiOrigin({})).toBe(VARIS_API_ORIGIN);
    expect(VARIS_API_ORIGIN).toBe("https://api.usevaris.com");
  });

  it("takes VARIS_API_URL for local development, dropping a trailing slash", () => {
    expect(apiOrigin({ VARIS_API_URL: "http://localhost:3000/api/" })).toBe(
      "http://localhost:3000/api",
    );
  });

  it("ignores a blank override", () => {
    expect(apiOrigin({ VARIS_API_URL: "  " })).toBe(VARIS_API_ORIGIN);
  });
});
