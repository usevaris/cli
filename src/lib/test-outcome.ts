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
  /** An output over MAX_OUTPUT_BYTES, which Varis can't deliver. */
  | { kind: "too_large"; bytes: number }
  | { kind: "not_json"; statusCode: number; text: string }
  | { kind: "schema_mismatch"; problems: SchemaProblem[]; payload: unknown }
  /** The output schema itself doesn't compile. Publish would refuse it. */
  | { kind: "invalid_schema"; message: string };

export type Outcome =
  | { status: "success"; statusCode: number; payload: unknown }
  | { status: "failed"; reason: FailureReason; cause: FailureCause };

/** Judges an answer that arrived, body and all. */
export function judgeAnswer(
  response: Response,
  text: string,
  outputSchema: unknown,
): Outcome {
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

function failed(reason: FailureReason, cause: FailureCause): Outcome {
  return { status: "failed", reason, cause };
}
