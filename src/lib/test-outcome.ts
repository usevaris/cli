// What the Varis gateway would make of a provider's answer to a call, for
// varis test. It mirrors callProvider in the varis repository
// (app/api/v1/invocations/_lib/provider.ts) check for check and in the same
// order, so a test passes or fails exactly where a real call would.
//
// Each failure keeps what the developer needs to fix it: the status, the
// body, or the schema problems. src/commands/test.ts turns it into words.

import { type SchemaProblem, validate } from "./schema.ts";

/** The gateway gives a provider this long to answer, body included. */
export const PROVIDER_TIMEOUT_MS = 30_000;

/** An ETA past this is dropped: every call ends within 24 hours. */
const MAX_ETA_SECONDS = 86_400;

/** A provider's message to agents is cut to this many characters (D8). */
const MAX_MESSAGE_CHARS = 160;

/**
 * The largest output Varis delivers, as JSON text. Vercel caps a function's
 * response body at 4.5 MB, so the gateway fails a larger output as
 * output_too_large (D35). MAX_OUTPUT_BYTES in the varis repository.
 */
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/** The reasons a real call would be recorded as failed, as the gateway names them. */
export type FailureReason =
  | "timeout"
  | "provider_error"
  | "schema_violation"
  | "output_too_large";

/** Why the call failed, in enough detail to explain it. */
export type FailureCause =
  /** No answer within PROVIDER_TIMEOUT_MS. */
  | { kind: "no_answer" }
  /** The connection failed before an answer arrived. */
  | { kind: "unreachable"; error: unknown }
  /** A redirect or an error status. */
  | { kind: "status"; response: Response; text: string }
  /** A 202 without the body `{"status":"started"}`. */
  | { kind: "not_started"; text: string }
  /** An output over MAX_OUTPUT_BYTES, which Varis can't deliver. */
  | { kind: "too_large"; bytes: number }
  | { kind: "not_json"; statusCode: number; text: string }
  | { kind: "schema_mismatch"; problems: SchemaProblem[]; payload: unknown }
  /** The output schema itself doesn't compile. Publish would refuse it. */
  | { kind: "invalid_schema"; message: string };

export type Outcome =
  | { status: "success"; statusCode: number; payload: unknown }
  /** The provider accepted the call and will report on it by notification. */
  | { status: "started"; etaSeconds: number | null; message: string | null }
  | { status: "failed"; reason: FailureReason; cause: FailureCause };

/** Judges an answer that arrived, body and all. */
export function judgeAnswer(
  response: Response,
  text: string,
  outputSchema: unknown,
): Outcome {
  // A 202 is a promise to finish later, and only in Varis's own shape.
  // Anything else in a 202 is a provider bug, not an output.
  if (response.status === 202) {
    return readStarted(text) ??
      failed("provider_error", { kind: "not_started", text });
  }

  if (!response.ok) {
    // 408 and 504 are the provider saying it ran out of time.
    const reason = response.status === 408 || response.status === 504
      ? "timeout"
      : "provider_error";
    return failed(reason, { kind: "status", response, text });
  }

  // Checked before parsing: Varis couldn't deliver it, whatever its shape.
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_OUTPUT_BYTES) {
    return failed("output_too_large", { kind: "too_large", bytes });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return failed("schema_violation", { kind: "not_json", statusCode: response.status, text });
  }

  const check = checkOutput(payload, outputSchema);
  return check.ok
    ? { status: "success", statusCode: response.status, payload }
    : failed(check.reason, check.cause);
}

/** Judges a request that threw before an answer arrived. */
export function judgeError(error: unknown): Outcome {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError"
    ? failed("timeout", { kind: "no_answer" })
    : failed("provider_error", { kind: "unreachable", error });
}

/**
 * Whether the call goes on when this answer arrives after a `started`
 * notification already accepted it (D26). Only an answer the provider might
 * send after accepting can lose to its own `started`: a success, a 2xx with
 * the wrong shape, or no answer in time. Anything else fails the call.
 * mayLoseToAcceptance in the varis repository.
 */
export function keepsRunningOnceAccepted(outcome: Outcome): boolean {
  return outcome.status === "success" ||
    (outcome.status === "failed" &&
      (outcome.reason === "schema_violation" || outcome.reason === "timeout"));
}

export type OutputCheck =
  | { ok: true }
  | { ok: false; reason: FailureReason; cause: FailureCause };

/** Checks an output against the service's output schema. */
export function checkOutput(payload: unknown, outputSchema: unknown): OutputCheck {
  const check = validate(outputSchema ?? {}, payload);
  if (check.ok) return { ok: true };
  if ("invalidSchema" in check) {
    return {
      ok: false,
      reason: "provider_error",
      cause: { kind: "invalid_schema", message: check.invalidSchema },
    };
  }
  return {
    ok: false,
    reason: "schema_violation",
    cause: { kind: "schema_mismatch", problems: check.problems, payload },
  };
}

/**
 * Checks a result sent in a `completed` notification, as the notification
 * route does: at most 4 MB of JSON, then the output schema.
 */
export function checkResult(result: unknown, outputSchema: unknown): OutputCheck {
  const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");
  if (bytes > MAX_OUTPUT_BYTES) {
    return { ok: false, reason: "output_too_large", cause: { kind: "too_large", bytes } };
  }
  return checkOutput(result, outputSchema);
}

/**
 * The `started` outcome from a 202 body of `{"status": "started"}`, or null.
 * An invalid eta_seconds or message is dropped rather than failing the call:
 * the provider did accept it.
 */
function readStarted(text: string): Extract<Outcome, { status: "started" }> | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const { status, eta_seconds: eta, message } = body as Record<string, unknown>;
  if (status !== "started") return null;

  return {
    status: "started",
    etaSeconds: typeof eta === "number" && Number.isInteger(eta) && eta >= 0 &&
        eta <= MAX_ETA_SECONDS
      ? eta
      : null,
    message: typeof message === "string" && message.length > 0
      ? message.slice(0, MAX_MESSAGE_CHARS)
      : null,
  };
}

function failed(reason: FailureReason, cause: FailureCause): Outcome {
  return { status: "failed", reason, cause };
}
