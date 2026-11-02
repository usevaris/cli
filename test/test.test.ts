// Tests for varis test. Most run a whole test call for real: a provider
// server on a spare port, the real loopback key listener, and a verifier
// that checks the signature the way @usevaris/sdk's verifyRequest does.
// Only the listener's port differs from production, so parallel test files
// don't collide on 47823.

import { verify } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTest, type TestDeps } from "../src/commands/test.ts";
import type { Output } from "../src/lib/output.ts";
import { createNotificationInbox, type NotificationInbox } from "../src/lib/test-notifications.ts";
import {
  createTestSigner,
  LISTENER_NOTIFICATIONS_PATH,
  LISTENER_PATH,
  openTestListener,
  signedString,
  TEST_KEY_ID,
  TEST_REQUEST_ID_PREFIX,
  type TestListener,
  type TestSigner,
} from "../src/lib/test-signing.ts";

const WEATHER = {
  slug: "weather",
  endpoint_url: "https://api.example.com/v1/weather",
  method: "GET",
  input_schema: {
    type: "object",
    properties: { city: { type: "string" }, days: { type: "integer" } },
    required: ["city"],
  },
  output_schema: {
    type: "object",
    properties: { temp_c: { type: "number" } },
    required: ["temp_c"],
  },
};

const SUMMARISE = {
  slug: "summarise",
  endpoint_url: "https://api.example.com/v1/summarise",
  method: "POST",
  input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  output_schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
};

const PING = {
  slug: "ping",
  endpoint_url: "https://api.example.com/ping",
  method: "GET",
  input_schema: { type: "object", properties: {} },
  output_schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
};

/** A free port, found by letting the OS pick one and releasing it. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: string };

type Answer = { status: number; body: unknown; headers?: Record<string, string> };

/**
 * What the provider's handler does with a verified request. Returns the
 * status and JSON body to answer with.
 */
type Handler = (seen: Seen) => Answer | Promise<Answer>;

/**
 * How the provider's SDK checks a signature: `current` is SDK 1.2.0 and
 * later, over D18's string with the invocation ID; `old` is SDK 1.1.0 and
 * earlier, without it.
 */
type Verifier = "current" | "old" | false;

/**
 * A provider server. Unless `verifies` is false, it checks each request as
 * the SDK does: the test key ID must come with a test request ID, the public
 * key is fetched from the listener for that request ID, and the signature
 * must cover the timestamp, invocation ID, method, path and query, and body.
 * A request that fails gets a 401, as a handler calling verifyRequest would
 * send. `after` runs once the handler's answer is sent, as the SDK's work
 * goes on after a 202.
 */
function provider(
  keyPort: number,
  handler: Handler,
  { verifies = "current", after }: { verifies?: Verifier; after?: (seen: Seen) => Promise<void> } = {},
) {
  const seen: Seen[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const current: Seen = {
      method: request.method!,
      url: request.url!,
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    seen.push(current);

    if (verifies && !(await verifies_(current, keyPort, verifies))) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorised" }));
      return;
    }

    const answer = await handler(current);
    response.writeHead(answer.status, { "Content-Type": "application/json", ...answer.headers });
    response.end(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
    if (after) void after(current);
  });
  return { server, seen };
}

/**
 * The SDK's verifyRequest, cut down to the test-key path. The signed string
 * is written out here rather than taken from signedString, so a change to
 * either shows up as a failing test.
 */
async function verifies_(seen: Seen, keyPort: number, verifier: "current" | "old"): Promise<boolean> {
  const keyId = seen.headers["x-varis-key-id"];
  const requestId = String(seen.headers["x-varis-request-id"] ?? "");
  if (keyId !== TEST_KEY_ID || !requestId.startsWith(TEST_REQUEST_ID_PREFIX)) return false;

  const answer = await fetch(
    `http://127.0.0.1:${keyPort}${LISTENER_PATH}?request_id=${encodeURIComponent(requestId)}`,
  );
  if (!answer.ok) return false;
  const key = (await answer.json()) as { kid: string; public_key_pem: string };
  if (key.kid !== TEST_KEY_ID) return false;

  const timestamp = String(seen.headers["x-varis-timestamp"]);
  const invocationId = String(seen.headers["x-varis-invocation-id"]);
  const message = verifier === "current"
    ? `${timestamp}.${invocationId}.${seen.method}.${seen.url}.${seen.body}`
    : `${timestamp}.${seen.method}.${seen.url}.${seen.body}`;
  return verify(
    null,
    Buffer.from(message),
    key.public_key_pem,
    Buffer.from(String(seen.headers["x-varis-signature"]), "base64"),
  );
}

let project: string;
let keyPort: number;
const servers: Server[] = [];

beforeEach(async () => {
  project = await mkdtemp(path.join(os.tmpdir(), "varis-cli-test-"));
  keyPort = await freePort();
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) => new Promise<void>((done) => {
        s.closeAllConnections();
        s.close(() => done());
      }),
    ),
  );
  await rm(project, { recursive: true, force: true });
});

/** Starts a provider and returns its base URL. */
async function start(p: ReturnType<typeof provider>): Promise<string> {
  servers.push(p.server);
  await new Promise<void>((done) => p.server.listen(0, "127.0.0.1", done));
  return `http://127.0.0.1:${(p.server.address() as AddressInfo).port}`;
}

async function manifest(testBaseUrl: string | undefined, services: object[] = [WEATHER, SUMMARISE, PING]) {
  await writeFile(
    path.join(project, "varis.json"),
    JSON.stringify({
      owner_id: "var_ownr_aaaaaaaaaaaaaa",
      base_url: "https://api.example.com",
      ...(testBaseUrl !== undefined && { test_base_url: testBaseUrl }),
      services,
    }),
  );
}

async function run(args: string[], overrides: Partial<TestDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const status: string[] = [];
  const output: Output = {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    status: (t) => status.push(t),
    styled: false,
  };
  const deps: TestDeps = {
    cwd: project,
    fetch,
    createSigner: createTestSigner,
    listen: (signer, inbox) => openTestListener(signer, inbox, keyPort),
    now: () => 0,
    // Never fires unless a test asks it to.
    everyMinute: () => () => {},
    ...overrides,
  };
  const code = await runTest(args, output, deps);
  return { code, out: out.join("\n"), err: err.join("\n"), status };
}

/**
 * Sends a notification for the call `seen` received, as the SDK does: to the
 * listener, with the call's own token. Returns the listener's answer.
 */
async function notify(seen: Seen, body: unknown): Promise<{ status: number; body: unknown }> {
  const invocationId = String(seen.headers["x-varis-invocation-id"]);
  const answer = await fetch(
    `http://127.0.0.1:${keyPort}${LISTENER_NOTIFICATIONS_PATH}?invocation_id=${encodeURIComponent(invocationId)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${String(seen.headers["x-varis-notification-token"])}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  return { status: answer.status, body: await answer.json() };
}

/** A clock the test moves by hand, and an everyMinute that ticks it. */
function manualClock() {
  let now = 0;
  let tick: (() => void) | undefined;
  return {
    now: () => now,
    everyMinute: (callback: () => void) => {
      tick = callback;
      return () => {
        tick = undefined;
      };
    },
    /** Moves the clock on and fires the minute timer, if it's running. */
    advance: (ms: number) => {
      now += ms;
      tick?.();
    },
    ticking: () => tick !== undefined,
  };
}

/** Resolves once `condition` holds, checking every few milliseconds. */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await new Promise((done) => setTimeout(done, 5));
}

describe("varis test", () => {
  it("passes a GET service whose server verifies the request and answers to schema", async () => {
    const p = provider(keyPort, () => ({ status: 200, body: { temp_c: 21.5 } }));
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos","days":2}']);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ temp_c: 21.5 });
    expect(result.err).toContain("weather passed");
    // The request went to test_base_url plus the endpoint's path, with the
    // input as the gateway encodes it: sorted keys, in the query string.
    expect(p.seen).toHaveLength(1);
    expect(p.seen[0]!.method).toBe("GET");
    expect(p.seen[0]!.url).toBe("/v1/weather?city=Lagos&days=2");
    expect(p.seen[0]!.body).toBe("");
    expect(p.seen[0]!.headers["content-type"]).toBeUndefined();
    expect(p.seen[0]!.headers["x-varis-request-id"]).toMatch(/^var_tst_req_/);
  });

  it("passes a POST service, signing and sending the same body bytes", async () => {
    const p = provider(keyPort, (seen) => ({
      status: 200,
      body: { summary: (JSON.parse(seen.body) as { text: string }).text.slice(0, 5) },
    }));
    await manifest(await start(p));

    const result = await run(["summarise", "--input", '{"text":"Hello, world"}']);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ summary: "Hello" });
    expect(p.seen[0]!.url).toBe("/v1/summarise");
    expect(p.seen[0]!.body).toBe('{"text":"Hello, world"}');
    expect(p.seen[0]!.headers["content-type"]).toBe("application/json");
  });

  it("sends {} to a service with no required input when no input is given", async () => {
    const p = provider(keyPort, () => ({ status: 200, body: { ok: true } }));
    await manifest(await start(p));

    const result = await run(["ping"]);

    expect(result.code).toBe(0);
    expect(p.seen[0]!.url).toBe("/ping");
  });

  it("reads the input from a file", async () => {
    const p = provider(keyPort, () => ({ status: 200, body: { temp_c: 3 } }));
    await manifest(await start(p));
    await writeFile(path.join(project, "input.json"), '{"city":"Oslo"}');

    const result = await run(["weather", "--input-file", "input.json"]);

    expect(result.code).toBe(0);
    expect(p.seen[0]!.url).toBe("/v1/weather?city=Oslo");
  });

  it("reports an output that breaks the schema, with each problem", async () => {
    const p = provider(keyPort, () => ({ status: 200, body: { temp_c: "warm", extra: 1 } }));
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toContain("doesn't match weather's output schema");
    expect(result.err).toContain("/temp_c  must be number");
    expect(result.err).toContain('"temp_c": "warm"');
  });

  it("fails an output over 4 MB, as the gateway does, before checking its shape", async () => {
    // Valid JSON matching the schema, but too large to deliver.
    const big = JSON.stringify({ temp_c: 1, padding: "x".repeat(4 * 1024 * 1024) });
    const p = provider(keyPort, () => ({ status: 200, body: big }));
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toContain("output_too_large");
    expect(result.err).toContain("at most 4 MB");
    expect(result.err).toContain("as a URL to your own storage");
  });

  it("reports an answer that isn't JSON", async () => {
    const p = provider(keyPort, () => ({ status: 200, body: "<html>hi</html>" }));
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(1);
    expect(result.err).toContain("not with JSON");
    expect(result.err).toContain("<html>hi</html>");
  });

  it("reports another status with its body", async () => {
    const p = provider(keyPort, () => ({ status: 500, body: { error: "database down" } }));
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(1);
    expect(result.err).toContain("answered 500");
    expect(result.err).toContain("database down");
  });

  it("reports a redirect instead of following it", async () => {
    const p = provider(keyPort, () => ({
      status: 302,
      body: {},
      headers: { Location: "https://elsewhere.example.com/" },
    }));
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(1);
    expect(result.err).toContain("redirected (302) to https://elsewhere.example.com/");
  });

  it("explains a 401 when the server never fetched the key", async () => {
    // A server that rejects without asking: no verifyRequest, an old SDK,
    // or no way to reach this machine's loopback.
    const p = provider(keyPort, () => ({ status: 401, body: { error: "unauthorised" } }), {
      verifies: false,
    });
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(1);
    expect(result.err).toContain("never fetched the test key");
    expect(result.err).toContain("Docker");
  });

  it("explains a 401 when the key was fetched but the signature didn't match", async () => {
    const p = provider(keyPort, () => ({ status: 200, body: { temp_c: 1 } }));
    await manifest(await start(p));

    // A signer whose signature covers a different path, as if middleware
    // had rewritten the request before verifyRequest saw it.
    const result = await run(["weather", "--input", '{"city":"Lagos"}'], {
      createSigner: () => {
        const real = createTestSigner();
        return { ...real, sign: (r) => real.sign({ ...r, pathAndQuery: "/rewritten" }) };
      },
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain("fetched the test key, but the signature didn't match");
  });

  it("fails a server on an SDK that signs without the invocation ID, and says to upgrade", async () => {
    const p = provider(keyPort, () => ({ status: 200, body: { temp_c: 1 } }), {
      verifies: "old",
    });
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(1);
    expect(result.err).toContain("fetched the test key, but the signature didn't match");
    expect(result.err).toContain("older than 1.2.0");
    expect(result.err).toContain("npm install @usevaris/sdk@latest");
  });

  it("sends the invocation ID and notification token, as the gateway does", async () => {
    const p = provider(keyPort, () => ({ status: 200, body: { temp_c: 1 } }));
    await manifest(await start(p));
    const signer = createTestSigner();

    const result = await run(["weather", "--input", '{"city":"Lagos"}'], {
      createSigner: () => signer,
    });

    expect(result.code).toBe(0);
    const headers = p.seen[0]!.headers;
    expect(headers["x-varis-invocation-id"]).toBe(signer.invocationId);
    expect(headers["x-varis-notification-token"]).toBe(signer.notificationToken);
    expect(result.err).toContain(`Invocation ID ${signer.invocationId}`);
  });

  it("stops before sending an input that breaks the schema", async () => {
    const p = provider(keyPort, () => ({ status: 200, body: { temp_c: 1 } }));
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"days":"two"}']);

    expect(result.code).toBe(1);
    expect(result.err).toContain("nothing was sent");
    expect(result.err).toContain("/city  is required");
    expect(result.err).toContain("/days  must be integer");
    expect(p.seen).toHaveLength(0);
  });

  it("names the required fields when no input is given", async () => {
    await manifest("http://127.0.0.1:1");

    const result = await run(["weather"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("weather needs input: city");
    expect(result.err).toContain(`varis test weather --input '{"city":"…"}'`);
  });

  it("rejects input that isn't JSON", async () => {
    await manifest("http://127.0.0.1:1");

    const result = await run(["weather", "--input", "{city:Lagos}"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("isn't valid JSON");
  });

  it("says how to set test_base_url when it's missing, and never falls back to production", async () => {
    await manifest(undefined);
    let called = false;

    const result = await run(["weather", "--input", '{"city":"Lagos"}'], {
      fetch: (async () => {
        called = true;
        throw new Error("unreachable");
      }) as typeof fetch,
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain("No test_base_url");
    expect(result.err).toContain("varis init --test-base-url http://localhost:3000");
    expect(called).toBe(false);
  });

  it("says to run varis build for an unknown slug", async () => {
    await manifest("http://127.0.0.1:1");

    const result = await run(["nope"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("no service with the slug nope");
    expect(result.err).toContain("varis build");
  });

  it("says to run varis init when there's no varis.json", async () => {
    const result = await run(["weather"]);

    expect(result.code).toBe(1);
    expect(result.err).toContain("Run varis init first");
  });

  it("reports a server that isn't running", async () => {
    // A port that was free a moment ago, so nothing answers.
    await manifest(`http://127.0.0.1:${await freePort()}`);

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(1);
    expect(result.err).toContain("Couldn't reach your server");
  });

  it("reports a busy listener port without sending anything", async () => {
    const p = provider(keyPort, () => ({ status: 200, body: { temp_c: 1 } }));
    await manifest(await start(p));
    const blocker = createServer();
    servers.push(blocker);
    await new Promise<void>((done) => blocker.listen(keyPort, "127.0.0.1", done));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(1);
    expect(result.err).toContain(`Port ${keyPort}`);
    expect(p.seen).toHaveLength(0);
  });

  it("frees the listener port after every run", async () => {
    const p = provider(keyPort, () => ({ status: 500, body: {} }));
    await manifest(await start(p));

    await run(["weather", "--input", '{"city":"Lagos"}']);
    const again = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(again.err).not.toContain(`Port ${keyPort}`);
    expect(p.seen).toHaveLength(2);
  });

  it("rejects a usage mistake", async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(["a", "b"])).code).toBe(2);
    expect((await run(["a", "--input", "{}", "--input-file", "x"])).code).toBe(2);
  });
});

describe("varis test, for a call that finishes later", () => {
  const STARTED = { status: 202, body: { status: "started" } };

  it("waits after 202 started, prints progress, and passes a valid result", async () => {
    const answers: unknown[] = [];
    const p = provider(keyPort, () => STARTED, {
      after: async (seen) => {
        answers.push(
          await notify(seen, { status: "running", progress_percent: 40, eta_seconds: 60, message: "Rendering" }),
        );
        answers.push(await notify(seen, { status: "completed", result: { temp_c: 18 } }));
      },
    });
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ temp_c: 18 });
    expect(result.err).toContain("acknowledged the call with 202 started");
    expect(result.err).toContain("Running. 40%, about 1 min left. Rendering");
    expect(result.err).toContain("weather passed: its result came by notification");
    // The listener closes gracefully, so the answer that ended the call
    // still reaches the server.
    await until(() => answers.length === 2);
    expect(answers).toEqual([
      { status: 200, body: { continue: true } },
      { status: 200, body: { continue: false } },
    ]);
  });

  it("prints the ETA and message from a 202 started", async () => {
    const p = provider(keyPort, () => ({
      status: 202,
      body: { status: "started", eta_seconds: 600, message: "Queued for rendering" },
    }), {
      after: async (seen) => {
        await notify(seen, { status: "completed", result: { temp_c: 1 } });
      },
    });
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(0);
    expect(result.err).toContain("about 10 min left. Queued for rendering");
  });

  it("treats a started notification before the answer as accepting the call, and ignores the answer (D26)", async () => {
    let started: unknown;
    const p = provider(keyPort, async (seen) => {
      started = await notify(seen, { status: "started" });
      // What a route that hands work to a queue answers its own users.
      return { status: 200, body: { queued: true } };
    }, {
      after: async (seen) => {
        await notify(seen, { status: "completed", result: { temp_c: 9 } });
      },
    });
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(started).toEqual({ status: 200, body: { continue: true } });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ temp_c: 9 });
    expect(result.out).not.toContain("queued");
    expect(result.err).toContain("acknowledged the call with a started notification");
  });

  it("keeps a call running when a 504 follows a started notification, as the gateway does", async () => {
    const p = provider(keyPort, async (seen) => {
      await notify(seen, { status: "started" });
      return { status: 504, body: {} };
    }, {
      after: async (seen) => {
        await notify(seen, { status: "completed", result: { temp_c: 2 } });
      },
    });
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(0);
  });

  it("fails a call whose answer is an error after a started notification, as the gateway refunds it", async () => {
    const p = provider(keyPort, async (seen) => {
      await notify(seen, { status: "started" });
      return { status: 500, body: { error: "queue down" } };
    });
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(1);
    expect(result.err).toContain("answered 500");
    expect(result.err).toContain("queue down");
  });

  it("ignores progress notifications on a call that answered without accepting", async () => {
    const p = provider(keyPort, async (seen) => {
      await notify(seen, { status: "running" });
      return { status: 200, body: { temp_c: 4 } };
    });
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toEqual({ temp_c: 4 });
    expect(result.err).toContain("weather passed: 200");
  });

  it("fails a 202 without {\"status\":\"started\"}, as a provider_error", async () => {
    const p = provider(keyPort, () => ({ status: 202, body: { accepted: true } }));
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(1);
    expect(result.err).toContain(`answered 202, but not with {"status":"started"}`);
    expect(result.err).toContain('{"accepted":true}');
  });

  it("fails a result that breaks the output schema, and the server gets a 422", async () => {
    let answer: unknown;
    const p = provider(keyPort, () => STARTED, {
      after: async (seen) => {
        answer = await notify(seen, { status: "completed", result: { temp_c: "cold" } });
      },
    });
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(1);
    expect(result.out).toBe("");
    expect(result.err).toContain("doesn't match weather's output schema");
    expect(result.err).toContain("/temp_c  must be number");
    await until(() => answer !== undefined);
    expect(answer).toMatchObject({ status: 422, body: { continue: false } });
  });

  it("fails a result over 4 MB as output_too_large, and the server gets a 413", async () => {
    let answer: unknown;
    const p = provider(keyPort, () => STARTED, {
      after: async (seen) => {
        answer = await notify(seen, {
          status: "completed",
          result: { temp_c: 1, padding: "x".repeat(4 * 1024 * 1024) },
        });
      },
    });
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(1);
    expect(result.err).toContain("output_too_large");
    await until(() => answer !== undefined);
    expect(answer).toMatchObject({ status: 413, body: { continue: false } });
  });

  it("fails when the server reports the call failed, and shows its message", async () => {
    const p = provider(keyPort, () => STARTED, {
      after: async (seen) => {
        await notify(seen, { status: "failed", message: "Out of GPU memory" });
      },
    });
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(1);
    expect(result.err).toContain("reported that the call failed");
    expect(result.err).toContain("Its message: Out of GPU memory");
  });

  it("fails when the SDK reports its result too large to send", async () => {
    const p = provider(keyPort, () => STARTED, {
      after: async (seen) => {
        await notify(seen, { status: "failed", reason: "output_too_large" });
      },
    });
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(1);
    expect(result.err).toContain("larger than 4 MB of JSON");
    expect(result.err).toContain("output_too_large");
  });

  it("explains a notification Varis would refuse, and keeps waiting", async () => {
    const p = provider(keyPort, () => STARTED, {
      after: async (seen) => {
        await notify(seen, { status: "running", progress_percent: 140 });
        await notify({ ...seen, headers: { ...seen.headers, "x-varis-notification-token": "var_nt_wrong" } }, {
          status: "running",
        });
        await notify(seen, { status: "completed", result: { temp_c: 3 } });
      },
    });
    await manifest(await start(p));

    const result = await run(["weather", "--input", '{"city":"Lagos"}']);

    expect(result.code).toBe(0);
    expect(result.err).toContain("refuse a notification from your server with 400");
    expect(result.err).toContain("/progress_percent  must be a whole number from 0 to 100");
    expect(result.err).toContain("refuse a notification from your server with 401");
  });

  it("reminds the developer every minute that it's still waiting", async () => {
    const clock = manualClock();
    let finish!: () => Promise<unknown>;
    const p = provider(keyPort, () => STARTED, {
      after: async (seen) => {
        finish = () => notify(seen, { status: "completed", result: { temp_c: 5 } });
      },
    });
    await manifest(await start(p));

    const running = run(["weather", "--input", '{"city":"Lagos"}'], clock);
    await until(() => clock.ticking() && finish !== undefined);
    clock.advance(60_000);
    clock.advance(60_000);
    await finish();
    const result = await running;

    expect(result.code).toBe(0);
    expect(result.status).toEqual([
      "Still waiting after 1 min. Press Ctrl+C to stop.",
      "Still waiting after 2 min. Press Ctrl+C to stop.",
    ]);
    expect(clock.ticking()).toBe(false);
  });

  it("fails a call that sends no notification for 5 minutes, as provider_stopped_reporting", async () => {
    const clock = manualClock();
    let heartbeat!: () => Promise<unknown>;
    const p = provider(keyPort, () => STARTED, {
      after: async (seen) => {
        heartbeat = () => notify(seen, { status: "running" });
      },
    });
    await manifest(await start(p));

    const running = run(["weather", "--input", '{"city":"Lagos"}'], clock);
    await until(() => clock.ticking() && heartbeat !== undefined);
    // A heartbeat at 4 minutes restarts the 5 minutes.
    clock.advance(240_000);
    await heartbeat();
    // Lets the command read the heartbeat before the clock moves again.
    await new Promise((done) => setTimeout(done, 10));
    clock.advance(240_000);
    expect(clock.ticking()).toBe(true);
    clock.advance(60_000);
    const result = await running;

    expect(result.code).toBe(1);
    expect(result.err).toContain("no notification for 5 minutes");
    expect(result.err).toContain("provider_stopped_reporting");
  });
});

describe("the test signer", () => {
  it("makes test IDs and a test token that can't be mistaken for real ones", () => {
    const signer = createTestSigner();

    expect(signer.requestId).toMatch(/^var_tst_req_[0-9a-f-]{36}$/);
    expect(signer.invocationId).toMatch(/^var_tst_invk_[0-9a-f-]{36}$/);
    expect(signer.notificationToken).toMatch(/^var_nt_test_[0-9a-f-]{36}$/);
    expect(createTestSigner().invocationId).not.toBe(signer.invocationId);
  });

  it("signs D18's string: timestamp, invocation ID, method, path and query, body", () => {
    const request = {
      invocationId: "var_tst_invk_1",
      method: "POST" as const,
      pathAndQuery: "/v1/summarise?x=1",
      rawBody: '{"text":"hi"}',
    };
    expect(signedString("1700000000", request)).toBe(
      '1700000000.var_tst_invk_1.POST./v1/summarise?x=1.{"text":"hi"}',
    );

    const signer = createTestSigner();
    const headers = signer.sign(request);
    expect(
      verify(
        null,
        Buffer.from(signedString(headers["X-Varis-Timestamp"]!, request)),
        signer.publicKeyPem,
        Buffer.from(headers["X-Varis-Signature"]!, "base64"),
      ),
    ).toBe(true);
    expect(headers["X-Varis-Key-Id"]).toBe(TEST_KEY_ID);
    expect(headers["X-Varis-Request-Id"]).toBe(signer.requestId);
  });
});

describe("the test listener", () => {
  const anyResult = () => ({ ok: true as const });

  /** Opens a listener for a fresh signer, runs `body`, and always closes it. */
  async function withListener(
    body: (signer: TestSigner, inbox: NotificationInbox, listener: TestListener) => Promise<void>,
  ) {
    const signer = createTestSigner();
    const inbox = createNotificationInbox(anyResult);
    const listening = await openTestListener(signer, inbox, keyPort);
    if (!listening.ok) throw new Error(listening.message);
    try {
      await body(signer, inbox, listening.listener);
    } finally {
      await listening.listener.close();
    }
  }

  /** Sends a notification the way the SDK does. */
  function notify(invocationId: string, token: string | undefined, body: unknown) {
    return fetch(
      `http://127.0.0.1:${keyPort}${LISTENER_NOTIFICATIONS_PATH}?invocation_id=${encodeURIComponent(invocationId)}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token !== undefined && { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
      },
    );
  }

  it("serves the key only for the request it signed", async () => {
    await withListener(async (signer, _inbox, listener) => {
      const base = `http://127.0.0.1:${keyPort}${LISTENER_PATH}`;
      const right = await fetch(`${base}?request_id=${signer.requestId}`);
      const wrong = await fetch(`${base}?request_id=${TEST_REQUEST_ID_PREFIX}other`);
      const elsewhere = await fetch(`http://127.0.0.1:${keyPort}/?request_id=${signer.requestId}`);

      expect(right.status).toBe(200);
      expect(await right.json()).toEqual({ kid: TEST_KEY_ID, public_key_pem: signer.publicKeyPem });
      expect(wrong.status).toBe(404);
      expect(elsewhere.status).toBe(404);
      expect(listener.fetches()).toBe(1);
    });
  });

  it("takes a notification with the token it issued, for its invocation", async () => {
    await withListener(async (signer, inbox) => {
      const answer = await notify(signer.invocationId, signer.notificationToken, {
        status: "running",
        message: "Rendering",
      });

      expect(answer.status).toBe(200);
      expect(await answer.json()).toEqual({ continue: true });
      expect(await inbox.next()).toEqual({
        status: "running",
        progressPercent: null,
        etaSeconds: null,
        message: "Rendering",
      });
    });
  });

  it("refuses a notification with a wrong or missing token, or for another invocation, with a 401", async () => {
    await withListener(async (signer, inbox) => {
      const answers = [
        await notify(signer.invocationId, "var_nt_test_wrong", { status: "running" }),
        await notify(signer.invocationId, undefined, { status: "running" }),
        await notify("var_tst_invk_other", signer.notificationToken, { status: "running" }),
      ];

      for (const answer of answers) {
        expect(answer.status).toBe(401);
        expect(await answer.json()).toMatchObject({
          continue: false,
          error: { code: "unauthorized" },
        });
      }
      expect(await inbox.next()).toEqual({ status: "unauthorised" });
      expect(inbox.accepted()).toBe(false);
    });
  });

  it("refuses a GET to the notifications path", async () => {
    await withListener(async (signer) => {
      const answer = await fetch(
        `http://127.0.0.1:${keyPort}${LISTENER_NOTIFICATIONS_PATH}?invocation_id=${signer.invocationId}`,
      );
      expect(answer.status).toBe(404);
    });
  });
});
