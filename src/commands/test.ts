// varis test <service_slug>: calls a service on the developer's own running
// server, exactly as the Varis gateway would, before they publish.
//
// WHAT IT CATCHES
// The failures that make a real call fail, and so refund its charge:
//   - an output that doesn't match the service's output schema, which the
//     gateway treats as the provider not delivering;
//   - an endpoint that errors, redirects, times out, or answers without JSON;
//   - an output larger than the 4 MB of JSON Varis can deliver.
// It also proves the handler's verifyRequest is wired correctly, because the
// request is signed and checked the same way a real one is.
//
// WHAT IT DOES, IN ORDER
//   1. Reads the service from varis.json, and test_base_url, which says where
//      the developer's server runs (usually http://localhost:3000). There is
//      no production testing: without test_base_url it stops and says how to
//      set it.
//   2. Works out the URL: the service's endpoint_url with its base_url
//      prefix replaced by test_base_url. With base_url
//      https://example.com/api, https://example.com/api/weather becomes
//      http://localhost:3000/api/weather when test_base_url is
//      http://localhost:3000/api. Without a matching base_url, the path of
//      endpoint_url is joined to test_base_url.
//   3. Takes the input from --input or --input-file and validates it against
//      the input schema, as the gateway does before it calls a provider. A
//      bad input is never sent.
//   4. Builds the request exactly as the gateway does: GET puts the input in
//      the query string, POST sends it as a JSON body.
//   5. Signs it with a throwaway key and opens the loopback listener the SDK
//      checks that signature against. src/lib/test-signing.ts explains how,
//      and why that's safe.
//   6. Sends it, with the gateway's 30-second timeout and no redirects.
//   7. Validates the response against the output schema, and prints the
//      output, or exactly what would make a real call fail.
//
// It reads varis.json as it is and doesn't run varis build first, so a test
// is instant. After changing a definition, run varis build, then test.
//
// Nothing here touches the Varis API: no sign-in, no network beyond the
// developer's own machine, nothing recorded, nothing charged.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { testUrlFor } from "../lib/base-url.ts";
import type { Command } from "../lib/command.ts";
import { MANIFEST_FILE, readManifest } from "../lib/manifest.ts";
import type { Output } from "../lib/output.ts";
import { toQueryString } from "../lib/query-string.ts";
import { type SchemaProblem, validate } from "../lib/schema.ts";
import { bold, dim, failure, success, yellow } from "../lib/style.ts";
import {
  type FailureCause,
  judgeAnswer,
  judgeError,
  MAX_OUTPUT_BYTES,
  type Outcome,
  PROVIDER_TIMEOUT_MS,
} from "../lib/test-outcome.ts";
import {
  createTestSigner,
  LISTENER_HOST,
  LISTENER_PORT,
  type ListenResult,
  openTestListener,
  type TestListener,
  type TestSigner,
} from "../lib/test-signing.ts";
import { VERSION } from "../lib/version.ts";

/** A response body is shown up to this many characters, then cut. */
const MAX_SHOWN_BODY = 2_000;

/**
 * Everything the command reaches outside itself. The tests swap these to run
 * a whole test call against an in-process server, or on a spare port.
 */
export type TestDeps = {
  cwd: string;
  fetch: typeof fetch;
  createSigner: () => TestSigner;
  listen: (signer: TestSigner) => Promise<ListenResult>;
  /** Milliseconds, for the timing in the success line. */
  now: () => number;
};

const defaultDeps = (): TestDeps => ({
  cwd: process.cwd(),
  fetch,
  createSigner: createTestSigner,
  listen: (signer) => openTestListener(signer),
  now: () => Date.now(),
});

/**
 * The fields of one varis.json service that a test reads. The generator
 * writes them all; `unknown` because a developer may have edited the file
 * by hand.
 */
type ManifestService = {
  slug?: unknown;
  endpoint_url?: unknown;
  method?: unknown;
  input_schema?: unknown;
  output_schema?: unknown;
};

type Args = { slug: string; input?: string; inputFile?: string };

function parseCommandArgs(args: string[]): Args | { error: string } {
  try {
    const { values, positionals } = parseArgs({
      args,
      options: {
        input: { type: "string" },
        "input-file": { type: "string" },
      },
      strict: true,
      allowPositionals: true,
    });
    if (positionals.length !== 1) {
      return { error: "Give one service slug, for example varis test weather." };
    }
    if (values.input !== undefined && values["input-file"] !== undefined) {
      return { error: "Give --input or --input-file, not both." };
    }
    return {
      slug: positionals[0]!,
      input: values.input,
      inputFile: values["input-file"],
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * A service from varis.json, ready to call on the developer's server: the
 * request exactly as the gateway would send it.
 */
type TestCall = {
  slug: string;
  service: ManifestService;
  method: "GET" | "POST";
  target: URL;
  /** The exact body bytes, both signed and sent. Empty for GET. */
  rawBody: string;
};

export async function runTest(
  args: string[],
  output: Output,
  deps: TestDeps = defaultDeps(),
): Promise<number> {
  const parsed = parseCommandArgs(args);
  if ("error" in parsed) {
    output.err(`${parsed.error} Run varis test --help.`);
    return 2;
  }

  const call = await prepareTestCall(parsed, deps.cwd, output);
  if (call === undefined) return 1;

  // 5. A key for this one request, and the listener that vouches for it.
  const signer = deps.createSigner();
  const listening = await deps.listen(signer);
  if (!listening.ok) {
    output.err(failure(output, listening.message));
    return 1;
  }

  // The listener stays open for the whole run, because the server fetches
  // the key while handling the request. It closes in `finally`, whatever
  // happens, so the port is free for the next test and the process can exit.
  try {
    return await runTestCall(call, signer, listening.listener, output, deps);
  } finally {
    await listening.listener.close();
  }
}

/**
 * Steps 1 to 4: the service, its test URL, and its input, checked and built
 * into the request. Undefined after saying what's wrong; nothing is sent.
 */
async function prepareTestCall(
  parsed: Args,
  cwd: string,
  output: Output,
): Promise<TestCall | undefined> {
  const found = await readTestService(parsed.slug, cwd, output);
  if (found === undefined) return undefined;

  const input = await readInput(parsed, found.service, cwd, output);
  if (input === undefined) return undefined;
  if (!checkInput(parsed.slug, found.service, input, output)) return undefined;

  return buildTestCall(parsed.slug, found.service, found.target, input, output);
}

/**
 * Steps 1 and 2: the service from varis.json, and the URL a test sends it
 * to on the developer's server.
 */
async function readTestService(
  slug: string,
  cwd: string,
  output: Output,
): Promise<{ service: ManifestService; target: URL } | undefined> {
  const found = await readManifest(cwd);
  if (found.status === "missing") {
    output.err(failure(output, `No ${MANIFEST_FILE} in this folder. Run varis init first.`));
    return undefined;
  }
  if (found.status === "invalid") {
    output.err(failure(output, `${MANIFEST_FILE} can't be read: ${found.reason}.`));
    return undefined;
  }
  const manifest = found.manifest;

  if (typeof manifest.test_base_url !== "string" || manifest.test_base_url === "") {
    output.err(failure(output, `No test_base_url in ${MANIFEST_FILE}.`));
    output.err(
      "varis test calls your own running server, so it needs its address. Set it once:",
    );
    output.err("");
    output.err("  varis init --test-base-url http://localhost:3000");
    return undefined;
  }

  const services = (manifest.services ?? []) as ManifestService[];
  const service = services.find((s) => s?.slug === slug);
  if (!service) {
    output.err(
      failure(
        output,
        `${MANIFEST_FILE} has no service with the slug ${slug}. If you just defined it, run varis build.`,
      ),
    );
    return undefined;
  }

  // endpoint_url is where the service runs in production; a test goes to
  // the developer's server instead, by swapping base_url for test_base_url
  // (testUrlFor explains the fallback). endpoint_url never carries a query
  // string: publish forbids one, because the gateway owns the query of a
  // GET service.
  try {
    const target = testUrlFor(
      String(service.endpoint_url),
      typeof manifest.base_url === "string" ? manifest.base_url : undefined,
      manifest.test_base_url,
    );
    return { service, target };
  } catch {
    output.err(
      failure(
        output,
        `Can't build a test URL from ${slug}'s endpoint_url and test_base_url. Check both in ${MANIFEST_FILE}.`,
      ),
    );
    return undefined;
  }
}

/** Step 3: the input, checked before anything is sent, as the gateway checks it. */
function checkInput(
  slug: string,
  service: ManifestService,
  input: unknown,
  output: Output,
): boolean {
  const inputCheck = validate(service.input_schema ?? {}, input);
  if (inputCheck.ok) return true;

  if ("invalidSchema" in inputCheck) {
    output.err(
      failure(output, `${slug}'s input schema is invalid: ${inputCheck.invalidSchema}`),
    );
  } else {
    output.err(
      failure(output, `The input doesn't match ${slug}'s input schema, so nothing was sent.`),
    );
    printProblems(inputCheck.problems, output);
  }
  return false;
}

/**
 * Step 4: the request, built exactly as the gateway builds it. varis.json
 * writes GET or POST; anything else is treated as the API's default, GET.
 */
function buildTestCall(
  slug: string,
  service: ManifestService,
  target: URL,
  input: unknown,
  output: Output,
): TestCall | undefined {
  const method = service.method === "POST" ? "POST" : "GET";
  if (method === "POST") {
    // Serialised once. These exact bytes are both signed and sent: sending a
    // second serialisation could differ, and the signature would fail.
    return { slug, service, method, target, rawBody: JSON.stringify(input) };
  }

  try {
    target.search = toQueryString(input, service.input_schema);
  } catch (error) {
    output.err(
      failure(
        output,
        `${slug} is a GET service, so its input must fit in a query string: ${
          error instanceof Error ? error.message : String(error)
        }.`,
      ),
    );
    return undefined;
  }
  return { slug, service, method, target, rawBody: "" };
}

/** Steps 6 and 7: sends the call, then judges the answer as the gateway would. */
async function runTestCall(
  call: TestCall,
  signer: TestSigner,
  listener: TestListener,
  output: Output,
  deps: TestDeps,
): Promise<number> {
  output.err(`${bold(output, call.method)} ${call.target.href}`);
  output.err(dim(output, `Request ID ${signer.requestId}`));
  output.err(dim(output, `Invocation ID ${signer.invocationId}`));

  const started = deps.now();
  const outcome = await sendTestCall(call, signer, deps.fetch);
  const elapsed = deps.now() - started;

  if (outcome.status === "failed") {
    return reportFailure(call, outcome.cause, listener.fetches(), output);
  }
  return reportSuccess(call, outcome.statusCode, outcome.payload, elapsed, output);
}

/**
 * Signs and sends the call, with the gateway's 30-second timeout and no
 * redirects, and judges what comes back.
 */
async function sendTestCall(
  call: TestCall,
  signer: TestSigner,
  fetcher: typeof fetch,
): Promise<Outcome> {
  const { method, target, rawBody } = call;
  try {
    const response = await fetcher(target.href, {
      method,
      headers: {
        ...signer.sign({
          invocationId: signer.invocationId,
          method,
          // Signed exactly as the URL goes out: URL serialises the path and
          // query the same way the gateway does.
          pathAndQuery: `${target.pathname}${target.search}`,
          rawBody,
        }),
        Accept: "application/json",
        "User-Agent": `varis-cli/${VERSION} (varis test)`,
        "X-Varis-Invocation-Id": signer.invocationId,
        // Not signed, as the gateway sends it. The SDK sends notifications
        // for this call back to the listener with it.
        "X-Varis-Notification-Token": signer.notificationToken,
        // The gateway sends Content-Type only with a body. So does the test,
        // so a handler that trips over it fails here, not in production.
        ...(method === "POST" && { "Content-Type": "application/json" }),
      },
      body: method === "POST" ? rawBody : undefined,
      // The gateway doesn't follow redirects, since a redirect could send a
      // signed request somewhere the provider never meant. A service that
      // redirects fails in production, so it fails here too.
      redirect: "manual",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    const text = await response.text();
    return judgeAnswer(response, text, call.service.output_schema);
  } catch (error) {
    return judgeError(error);
  }
}

/** The output matched its schema: the call passed. */
function reportSuccess(
  call: TestCall,
  statusCode: number,
  payload: unknown,
  elapsed: number,
  output: Output,
): number {
  output.err(
    success(output, `${call.slug} passed: ${statusCode} in ${elapsed} ms, and the output matches its schema.`),
  );
  // Messages go to stderr and the output alone to stdout, so
  // `varis test weather | jq .temp_c` works.
  output.out(JSON.stringify(payload, null, 2));
  return 0;
}

/** Says what would make a real call fail, and how to fix it. */
function reportFailure(
  call: TestCall,
  cause: FailureCause,
  keyFetches: number,
  output: Output,
): number {
  switch (cause.kind) {
    case "no_answer":
      output.err(
        failure(
          output,
          `Your server didn't answer within ${PROVIDER_TIMEOUT_MS / 1000} seconds. Varis would count this as a timeout and refund the call.`,
        ),
      );
      return 1;
    case "unreachable":
      return reportUnreachable(call.target, keyFetches, output);
    case "status":
      return reportStatus(cause.response, cause.text, keyFetches, output);
    case "too_large":
      output.err(
        failure(
          output,
          `Your server's output is ${formatMegabytes(cause.bytes)} of JSON. Varis delivers at most ${formatMegabytes(MAX_OUTPUT_BYTES)}, so it would fail this call as output_too_large and refund it.`,
        ),
      );
      output.err("Return a large result as a URL to your own storage instead.");
      return 1;
    case "not_json":
      output.err(
        failure(
          output,
          `Your server answered ${cause.statusCode}, but not with JSON. Varis would count this as a failed call and refund it.`,
        ),
      );
      showBody(cause.text, output);
      return 1;
    case "invalid_schema":
      output.err(
        failure(output, `${call.slug}'s output schema is invalid: ${cause.message}`),
      );
      return 1;
    case "schema_mismatch":
      output.err(
        failure(
          output,
          `The response doesn't match ${call.slug}'s output schema. Varis would count this as a failed call and refund it.`,
        ),
      );
      printProblems(cause.problems, output);
      showBody(JSON.stringify(cause.payload, null, 2), output);
      return 1;
  }
}

/**
 * The parsed input, or undefined after saying why there isn't one.
 *
 * With neither flag, it sends {} when the input schema has no required
 * fields, so a service that takes no input needs no flag at all. When fields
 * are required, it names them and shows the flag to use, rather than sending
 * a request that's bound to fail.
 */
async function readInput(
  parsed: Args,
  service: ManifestService,
  cwd: string,
  output: Output,
): Promise<unknown | undefined> {
  let text = parsed.input;
  let source = "--input";

  if (parsed.inputFile !== undefined) {
    source = parsed.inputFile;
    try {
      text = await readFile(path.resolve(cwd, parsed.inputFile), "utf8");
    } catch {
      output.err(failure(output, `Can't read the input file ${parsed.inputFile}.`));
      return undefined;
    }
  }

  if (text === undefined) {
    const required = (service.input_schema as { required?: unknown } | null | undefined)
      ?.required;
    if (Array.isArray(required) && required.length > 0) {
      output.err(
        failure(output, `${parsed.slug} needs input: ${required.join(", ")}. Give it as JSON:`),
      );
      output.err("");
      output.err(`  varis test ${parsed.slug} --input '${exampleInput(required)}'`);
      output.err(`  varis test ${parsed.slug} --input-file input.json`);
      return undefined;
    }
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    output.err(failure(output, `The input from ${source} isn't valid JSON.`));
    return undefined;
  }
}

/** {"city":"…"}, to show the shape --input takes. */
function exampleInput(required: unknown[]): string {
  return JSON.stringify(Object.fromEntries(required.map((key) => [String(key), "…"])));
}

/** The connection failed: the server is down or unreachable. */
function reportUnreachable(
  target: URL,
  keyFetches: number,
  output: Output,
): number {
  output.err(
    failure(
      output,
      `Couldn't reach your server at ${target.origin}. Is it running? test_base_url in ${MANIFEST_FILE} says it's there.`,
    ),
  );
  if (keyFetches > 0) {
    output.err(dim(output, "It fetched the test key, then dropped the connection."));
  }
  return 1;
}

/**
 * A redirect or an error status. A 401 gets the most help: it usually means
 * verifyRequest said no, and whether the server fetched the test key tells
 * two very different causes apart.
 */
function reportStatus(
  response: Response,
  text: string,
  keyFetches: number,
  output: Output,
): number {
  const status = response.status;

  if (status >= 300 && status < 400) {
    const location = response.headers.get("location");
    output.err(
      failure(
        output,
        `Your server redirected (${status})${location ? ` to ${location}` : ""}. Varis doesn't follow redirects, so point the service at the final address.`,
      ),
    );
    return 1;
  }

  output.err(
    failure(output, `Your server answered ${status}. Varis would count this as a failed call and refund it.`),
  );

  if (status === 401) {
    output.err("");
    if (keyFetches === 0) {
      // Nothing asked the listener, so verifyRequest never tried the test
      // key: it's missing, too old to know test requests, or can't reach
      // this machine's loopback.
      output.err(
        yellow(output, "Your server never fetched the test key, so it couldn't verify the request. Either:"),
      );
      output.err("  - the handler doesn't call verifyRequest from @usevaris/sdk 0.1.0 or later, or");
      output.err(
        `  - your server can't reach ${LISTENER_HOST}:${LISTENER_PORT} on this machine. That happens when it runs in`,
      );
      output.err(
        "    Docker (run varis test inside the container) or under wrangler dev --remote (drop --remote).",
      );
    } else {
      // The key was fetched, so the signature was checked and didn't match:
      // the SDK predates the invocation ID in the signed string, or the
      // request changed between the wire and verifyRequest.
      output.err(
        yellow(output, "Your server fetched the test key, but the signature didn't match. Usually one of:"),
      );
      output.err(
        "  - your server uses @usevaris/sdk older than 1.2.0, which doesn't check the invocation ID Varis signs.",
      );
      output.err("    Upgrade it: npm install @usevaris/sdk@latest");
      output.err("  - middleware rewrote the path or query before verifyRequest saw it;");
      output.err("  - the body was read or parsed before calling verifyRequest.");
      output.err("verifyRequest must see the request exactly as it arrived.");
    }
  }

  if (text.trim() !== "") showBody(text, output);
  return 1;
}

/** Bytes as megabytes, for example "4.2 MB". */
function formatMegabytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
}

function printProblems(problems: SchemaProblem[], output: Output): void {
  for (const problem of problems) {
    output.err(`  ${problem.path}  ${problem.message}`);
  }
}

function showBody(text: string, output: Output): void {
  const shown = text.length > MAX_SHOWN_BODY ? `${text.slice(0, MAX_SHOWN_BODY)}…` : text;
  output.err("");
  output.err("Your server sent:");
  output.err(dim(output, shown));
}

export const test: Command = {
  name: "test",
  summary: "Call a service on your own server, as Varis would",
  usage: `Usage: varis test <service_slug> [--input '<json>' | --input-file <path>]

  Calls the service on your own running server, at test_base_url in
  varis.json, exactly as Varis would in production: the same method, the
  same signed request, the same checks on the input and the output. Prints
  the output, or exactly what would make a real call fail. Nothing is
  published, charged, or recorded.

  Set test_base_url once, for example:
    varis init --test-base-url http://localhost:3000

  It reads varis.json as it is. After changing a service, run varis build
  first.

  --input '<json>'     The input to send, as JSON.
  --input-file <path>  Read the input from a JSON file.

  With neither, it sends {} when the service needs no input.`,
  run: (args, output) => runTest(args, output),
};
