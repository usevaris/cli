// Signing `varis test` requests, and proving to the developer's own server
// that they came from this CLI.
//
// THE PROBLEM
// Every Varis service calls `varis.requests.verify(request)` before it does
// anything, and rejects requests Varis didn't sign. A real request is signed
// by the Varis gateway with a private key only Varis holds. `varis test`
// calls the developer's server directly, before the service is published, so
// it can't get the gateway's signature. Yet the test should still run the
// developer's verification exactly as production would, because a test that
// skipped verification wouldn't prove the handler works.
//
// THE MECHANISM
// For each test run, this file:
//   1. makes a brand-new Ed25519 key pair, used for this one request and
//      then thrown away;
//   2. makes a test invocation ID prefixed `var_tst_invk_` and a test
//      notification token prefixed `var_nt_test_`;
//   3. signs the request with the private half, over exactly the string the
//      gateway signs:
//      `${timestamp}.${invocationId}.${method}.${pathAndQuery}.${rawBody}`;
//   4. sends it with the key ID `varis-test` and a request ID prefixed
//      `var_tst_req_`;
//   5. meanwhile listens on one fixed loopback address, 127.0.0.1:47823,
//      and hands out the public half at /varis-test-key, but only when asked
//      for the request ID it just sent. The same listener takes the call's
//      notifications at /varis-test-notifications, but only with the token
//      it just issued.
//
// When the SDK's requests.verify sees the `varis-test` key ID, it fetches
// the public key from that loopback address and checks the signature with
// it. When it sends a notification for a test request, it sends it to the
// loopback too, never to Varis. See packages/sdk/src/verify.ts and
// packages/sdk/src/notifications.ts in the varis-ts repository.
//
// WHY THIS IS SAFE
// The fixed loopback address is the whole guarantee. 127.0.0.1 always means
// "this same machine", so only a program on the provider's own machine can
// answer there. On the developer's laptop, that's this CLI, during a test.
// On a production server, nothing listens there, so a test request can
// never verify, whatever an attacker sends and wherever they send it from.
//
// Two tempting alternatives were rejected:
//   - Letting the request say where to fetch the key from. An attacker would
//     point it at their own server, serve their own key, and forge requests
//     that verify anywhere.
//   - Accepting requests whose Host is localhost. The Host header is written
//     by the caller, so anyone could claim to be local.
//
// WHERE IT CAN'T WORK
// The server and this CLI must share a loopback. They don't when the server
// runs in a Docker container and the CLI on the host, or with
// `wrangler dev --remote`, which runs on Cloudflare's machines. Then the SDK
// can't reach this listener, the signature can't be checked, and the test
// fails with a 401. It fails safe: nothing is ever accepted that shouldn't
// be. src/commands/test.ts explains the likely cause when that happens.
//
// KEEP IN STEP WITH THE SDK
// TEST_KEY_ID, TEST_REQUEST_ID_PREFIX, and the listener's host, port, and
// paths must match packages/sdk/src/constants.ts in varis-ts exactly.

import {
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
  sign,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { NotificationAnswer, NotificationInbox } from "./test-notifications.ts";

/** The key ID on every test request. The SDK routes on it. */
export const TEST_KEY_ID = "varis-test";

/**
 * Every test request ID starts with this. Gateway request IDs start with
 * `var_req_`, so providers can tell a test apart in their logs, and the SDK
 * rejects a request whose key ID and request ID prefix disagree.
 */
export const TEST_REQUEST_ID_PREFIX = "var_tst_req_";

/**
 * Where the listener serves the public key. Loopback only (never 0.0.0.0),
 * so nothing off this machine can reach it. The port is fixed because the
 * SDK has to know it in advance: the address can't travel with the request,
 * or an attacker could change it.
 */
export const LISTENER_HOST = "127.0.0.1";
export const LISTENER_PORT = 47823;
export const LISTENER_PATH = "/varis-test-key";

/**
 * Where the listener takes the call's notifications, as
 * `?invocation_id=<id>`: LOCAL_TEST_NOTIFICATIONS_URL in the SDK.
 */
export const LISTENER_NOTIFICATIONS_PATH = "/varis-test-notifications";

/**
 * Every test invocation ID starts with this. Gateway invocation IDs start
 * with `var_invk_`, so a test call never looks like a real one in a
 * provider's logs.
 */
export const TEST_INVOCATION_ID_PREFIX = "var_tst_invk_";

/**
 * Every test notification token starts with this. It works only against
 * this listener, during this one test.
 */
export const TEST_NOTIFICATION_TOKEN_PREFIX = "var_nt_test_";

/** Everything needed to sign and vouch for one test request. */
export type TestSigner = {
  requestId: string;
  invocationId: string;
  /** Sent as X-Varis-Notification-Token; notifications must carry it back. */
  notificationToken: string;
  /** The public key, as the listener serves it: SPKI PEM. */
  publicKeyPem: string;
  /** The signature headers for the exact bytes about to be sent. */
  sign: (request: SignedRequest) => Record<string, string>;
};

export type SignedRequest = {
  invocationId: string;
  method: "GET" | "POST";
  /** The path and query exactly as sent, for example "/v1/weather?city=Lagos". */
  pathAndQuery: string;
  /** The exact body bytes sent. Empty for GET. */
  rawBody: string;
};

/**
 * The string the signature covers. Identical to the gateway's
 * (lib/crypto/signing.ts in the varis repository), so a test exercises the
 * same verification a real call does.
 */
export function signedString(timestamp: string, request: SignedRequest): string {
  return `${timestamp}.${request.invocationId}.${request.method}.${request.pathAndQuery}.${request.rawBody}`;
}

/**
 * A fresh key pair, request ID, invocation ID, and notification token for
 * one test. Nothing is written to disk; when the test ends, all are gone.
 */
export function createTestSigner(): TestSigner {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const requestId = `${TEST_REQUEST_ID_PREFIX}${randomUUID()}`;

  return {
    requestId,
    invocationId: `${TEST_INVOCATION_ID_PREFIX}${randomUUID()}`,
    notificationToken: `${TEST_NOTIFICATION_TOKEN_PREFIX}${randomUUID()}`,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    sign: (request) => signHeaders(privateKey, requestId, request),
  };
}

function signHeaders(
  privateKey: KeyObject,
  requestId: string,
  request: SignedRequest,
): Record<string, string> {
  // Whole seconds, as the gateway sends. The SDK rejects a timestamp more
  // than 300 seconds from its own clock.
  const timestamp = Math.floor(Date.now() / 1000).toString();
  // Ed25519 takes no separate digest algorithm, hence null.
  const signature = sign(
    null,
    Buffer.from(signedString(timestamp, request)),
    privateKey,
  ).toString("base64");

  return {
    "X-Varis-Timestamp": timestamp,
    "X-Varis-Signature": signature,
    "X-Varis-Key-Id": TEST_KEY_ID,
    "X-Varis-Request-Id": requestId,
  };
}

/**
 * A running listener. Always close it: an open listener keeps the process
 * alive and holds the port for the next test.
 */
export type TestListener = {
  /** How many times the key was fetched, so a failure can say whether the server asked. */
  fetches: () => number;
  close: () => Promise<void>;
};

/** How long close waits for answers still being written. */
const CLOSE_GRACE_MS = 1_000;

export type ListenResult =
  | { ok: true; listener: TestListener }
  /** The port is taken, most likely by another varis test still running. */
  | { ok: false; reason: "port_in_use" | "failed"; message: string };

/**
 * Serves `signer`'s public key at the fixed loopback address, for its
 * request ID only, and takes the call's notifications into `inbox`. Every
 * other path gets a 404, so the listener answers for exactly one call and
 * nothing else.
 */
export function openTestListener(
  signer: TestSigner,
  inbox: NotificationInbox,
  port = LISTENER_PORT,
): Promise<ListenResult> {
  let fetches = 0;

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${LISTENER_HOST}`);

    if (request.method === "POST" && url.pathname === LISTENER_NOTIFICATIONS_PATH) {
      void receiveNotification(signer, inbox, url, request, response);
      return;
    }

    if (
      request.method !== "GET" || url.pathname !== LISTENER_PATH ||
      url.searchParams.get("request_id") !== signer.requestId
    ) {
      response.writeHead(404, { "Content-Type": "text/plain" }).end("unknown");
      return;
    }

    fetches++;
    response
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ kid: TEST_KEY_ID, public_key_pem: signer.publicKeyPem }));
  });

  return new Promise((resolve) => {
    server.once("error", (error: Error & { code?: string }) => {
      resolve(
        error.code === "EADDRINUSE"
          ? {
            ok: false,
            reason: "port_in_use",
            message:
              `Port ${port} on ${LISTENER_HOST} is in use, probably by another varis test still running. Wait for it to finish, then try again.`,
          }
          : { ok: false, reason: "failed", message: error.message },
      );
    });

    server.listen(port, LISTENER_HOST, () => {
      resolve({
        ok: true,
        listener: {
          fetches: () => fetches,
          close: () =>
            new Promise<void>((done) => {
              // An answer still being written, such as the one to the
              // notification that ended the call, gets a moment to reach the
              // SDK, or it would retry. Idle keep-alive connections close
              // now, and anything still open after the grace period is cut.
              const force = setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS);
              server.close(() => {
                clearTimeout(force);
                done();
              });
              server.closeIdleConnections();
            }),
        },
      });
    });
  });
}

/**
 * One notification. It must name this call's invocation and carry the token
 * sent with it, as the route requires; otherwise it gets a 401, as a wrong
 * token or another invocation's token does from Varis.
 */
async function receiveNotification(
  signer: TestSigner,
  inbox: NotificationInbox,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const token = request.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  const authorised = token === signer.notificationToken &&
    url.searchParams.get("invocation_id") === signer.invocationId;

  let answer: NotificationAnswer;
  if (!authorised) {
    // Drained so the connection can be reused, but never read.
    request.resume();
    answer = inbox.refuseUnauthorised();
  } else {
    try {
      answer = inbox.receive(await readBody(request));
    } catch {
      // The connection dropped mid-body: nothing to answer.
      return;
    }
  }
  response
    .writeHead(answer.status, { "Content-Type": "application/json" })
    .end(JSON.stringify(answer.body));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
