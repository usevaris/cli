// The notifications a long-running test call sends, and the answers Varis
// would give them. It mirrors the notification route in the varis
// repository (app/api/v1/invocations/[invocation_id]/notifications), so a
// provider's notifications are judged here exactly as in production.
//
// The SDK sends notifications for a test request to the CLI's loopback
// listener instead of Varis (src/lib/test-signing.ts). The listener checks
// the token and hands each body to an inbox, which:
//   1. parses it as one of the four shapes the route accepts, or answers 400;
//   2. answers a call that already ended as the route would, 200 or 410;
//   3. records `started` and `running` and answers `continue: true`;
//   4. checks a `completed` result, then answers 200, 413, or 422 with
//      `continue: false`, and records how the call ended;
//   5. records `failed` and answers `continue: false`.
// Before recording a notification, it records any notice about parts Varis
// would quietly drop: a field it doesn't read, or a message it cuts.
// src/commands/test.ts reads what's recorded, in order, through `next`.

import type { SchemaProblem } from "./schema.ts";
import type { FailureReason, OutputCheck } from "./test-outcome.ts";

/** A provider's message to agents is cut to this many characters (D8). */
export const MAX_MESSAGE_CHARS = 160;

/** Every call ends within 24 hours, so a longer ETA can't be true. */
const MAX_ETA_SECONDS = 86_400;

/** One notification, as the route reads it. */
export type NotificationBody =
  | { status: "started"; etaSeconds: number | null; message: string | null }
  | {
    status: "running";
    progressPercent: number | null;
    etaSeconds: number | null;
    message: string | null;
  }
  | { status: "completed"; result: unknown }
  | { status: "failed"; message: string | null; reason: "output_too_large" | null };

/** What the inbox recorded, in the order it arrived. */
export type ReceivedNotification =
  /** The `started` that accepted the call (D26). A later one is `running`. */
  | Extract<NotificationBody, { status: "started" }>
  | Extract<NotificationBody, { status: "running" }>
  /** `check` is how Varis judged the result. */
  | { status: "completed"; result: unknown; check: OutputCheck }
  | Extract<NotificationBody, { status: "failed" }>
  /**
   * Parts of the next notification Varis would accept but drop, so the
   * developer can fix them. Recorded just before that notification.
   */
  | { status: "notice"; notices: SchemaProblem[] }
  /** A body Varis would refuse with a 400, and why. */
  | { status: "invalid"; problems: SchemaProblem[] }
  /** A notification without the token sent with the call, refused with a 401. */
  | { status: "unauthorised" };

/** An answer to one notification. Every body carries `continue`. */
export type NotificationAnswer = { status: number; body: Record<string, unknown> };

export type NotificationInbox = {
  /** Records one notification that carried the right token, and answers it. */
  receive: (rawBody: string) => NotificationAnswer;
  /** Records a notification without the right token, and answers it. */
  refuseUnauthorised: () => NotificationAnswer;
  /** The call was accepted by a `202 started` answer. */
  markAccepted: () => void;
  /** Whether the call has been accepted, by a `started` notification or a 202. */
  accepted: () => boolean;
  /** The next notification recorded, waiting for one if none is pending. */
  next: () => Promise<ReceivedNotification>;
};

/** How the call ended, once a notification ended it. */
type Ending = { status: "success" } | { status: "failed"; reason: FailureReason };

/**
 * The error code a failure reason answers with, as FAILURE_RESPONSES in the
 * varis repository maps it.
 */
const FAILURE_CODES: Record<FailureReason, string> = {
  timeout: "timeout",
  provider_error: "provider_error",
  schema_violation: "schema_violation",
  output_too_large: "provider_error",
};

/**
 * An inbox for one test call. `checkResult` judges a completed result, as
 * the route judges it against the service's output schema.
 */
export function createNotificationInbox(
  checkResult: (result: unknown) => OutputCheck,
): NotificationInbox {
  const pending: ReceivedNotification[] = [];
  const waiting: ((notification: ReceivedNotification) => void)[] = [];
  let accepted = false;
  let ending: Ending | null = null;

  const record = (notification: ReceivedNotification) => {
    const waiter = waiting.shift();
    if (waiter) waiter(notification);
    else pending.push(notification);
  };

  const recordCompletion = (result: unknown): NotificationAnswer => {
    const check = checkResult(result);
    record({ status: "completed", result, check });
    if (check.ok) {
      ending = { status: "success" };
      return answer(200, false);
    }
    ending = { status: "failed", reason: check.reason };
    return rejectedResultAnswer(check);
  };

  return {
    receive: (rawBody) => {
      const parsed = parseNotificationBody(readJson(rawBody));
      if (!parsed.ok) {
        record({ status: "invalid", problems: parsed.problems });
        return answer(400, true, {
          code: "invalid_request",
          message: "The notification body is invalid.",
          details: parsed.problems,
        });
      }
      if (ending) return endedAnswer(ending);

      if (parsed.notices.length > 0) record({ status: "notice", notices: parsed.notices });
      const body = parsed.body;
      switch (body.status) {
        case "started":
          if (!accepted) {
            accepted = true;
            record(body);
          } else {
            record({ ...body, status: "running", progressPercent: null });
          }
          return answer(200, true);
        case "running":
          record(body);
          return answer(200, true);
        case "completed":
          return recordCompletion(body.result);
        case "failed":
          record(body);
          ending = { status: "failed", reason: body.reason ?? "provider_error" };
          return answer(200, false);
      }
    },
    refuseUnauthorised: () => {
      record({ status: "unauthorised" });
      return answer(401, false, {
        code: "unauthorized",
        message: "The notification token is missing, invalid, or expired.",
      });
    },
    markAccepted: () => {
      accepted = true;
    },
    accepted: () => accepted,
    next: () => {
      const notification = pending.shift();
      return notification
        ? Promise.resolve(notification)
        : new Promise((resolve) => waiting.push(resolve));
    },
  };
}

/** The parsed body, or undefined when it isn't JSON. */
function readJson(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return undefined;
  }
}

/** The fields each notification reads. The route ignores any others. */
const FIELDS: Record<NotificationBody["status"], readonly string[]> = {
  started: ["status", "eta_seconds", "message"],
  running: ["status", "progress_percent", "eta_seconds", "message"],
  completed: ["status", "result"],
  failed: ["status", "message", "reason"],
};

/** Names a developer might write for a field, beyond its spelling and case. */
const LIKELY_MEANT: Record<string, string> = {
  progress: "progress_percent",
  percent: "progress_percent",
  percentage: "progress_percent",
  eta: "eta_seconds",
  msg: "message",
  output: "result",
  data: "result",
};

/**
 * The body as one of the four notifications, or its problems. The same
 * rules as the route's zod schema: unknown fields are ignored, an optional
 * field may be left out but not null, and `message` is cut to 160
 * characters. What's ignored or cut comes back as notices.
 */
export function parseNotificationBody(
  raw: unknown,
):
  | { ok: true; body: NotificationBody; notices: SchemaProblem[] }
  | { ok: false; problems: SchemaProblem[] } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, problems: [{ path: "/", message: "must be a JSON object" }] };
  }
  const fields = raw as Record<string, unknown>;
  const problems: SchemaProblem[] = [];

  // Each shape reads only its own fields, as zod does.
  let body: NotificationBody;
  switch (fields.status) {
    case "started":
      body = {
        status: "started",
        etaSeconds: readInteger(fields, "eta_seconds", MAX_ETA_SECONDS, problems),
        message: readMessage(fields, problems),
      };
      break;
    case "running":
      body = {
        status: "running",
        progressPercent: readInteger(fields, "progress_percent", 100, problems),
        etaSeconds: readInteger(fields, "eta_seconds", MAX_ETA_SECONDS, problems),
        message: readMessage(fields, problems),
      };
      break;
    case "completed":
      // `result` may be any JSON, null included, but it must be there.
      if (!Object.hasOwn(fields, "result")) {
        problems.push({ path: "/result", message: "result is required" });
      }
      body = { status: "completed", result: fields.result };
      break;
    case "failed":
      body = {
        status: "failed",
        message: readMessage(fields, problems),
        reason: readReason(fields, problems),
      };
      break;
    default:
      return {
        ok: false,
        problems: [{ path: "/status", message: "must be started, running, completed, or failed" }],
      };
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, body, notices: findNotices(fields, body.status) };
}

/** The fields Varis would ignore in a notification, and a message it would cut. */
function findNotices(
  fields: Record<string, unknown>,
  status: NotificationBody["status"],
): SchemaProblem[] {
  const notices: SchemaProblem[] = [];
  for (const name of Object.keys(fields)) {
    if (FIELDS[status].includes(name)) continue;
    notices.push({ path: `/${name}`, message: describeIgnoredField(name, status) });
  }
  const message = fields.message;
  if (FIELDS[status].includes("message") && typeof message === "string" && message.length > MAX_MESSAGE_CHARS) {
    notices.push({
      path: "/message",
      message: `is ${message.length} characters. Varis keeps the first ${MAX_MESSAGE_CHARS}, so agents see it cut.`,
    });
  }
  return notices;
}

/** "a", "a and b", or "a, b, and c". */
function listInWords(items: string[]): string {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

/** Why Varis ignores `name`, and what the developer probably meant. */
function describeIgnoredField(name: string, status: NotificationBody["status"]): string {
  const known = Object.values(FIELDS).flat();
  if (known.includes(name)) {
    const readers = Object.entries(FIELDS)
      .filter(([, names]) => names.includes(name))
      .map(([reader]) => reader);
    return `is ignored on ${status} notifications. Varis reads it only on ${listInWords(readers)}.`;
  }
  const normalised = name.toLowerCase().replace(/[^a-z]/g, "");
  const meant = LIKELY_MEANT[normalised] ??
    known.find((field) => field.replace(/_/g, "") === normalised);
  return meant
    ? `isn't a field Varis reads, so it's ignored. Did you mean ${meant}?`
    : "isn't a field Varis reads, so it's ignored.";
}

/** `message`, cut to 160 characters, or null when absent or empty. */
function readMessage(fields: Record<string, unknown>, problems: SchemaProblem[]): string | null {
  if (!Object.hasOwn(fields, "message")) return null;
  const message = fields.message;
  if (typeof message !== "string") {
    problems.push({ path: "/message", message: "must be a string" });
    return null;
  }
  return message === "" ? null : message.slice(0, MAX_MESSAGE_CHARS);
}

/** An optional whole number from 0 to `max`, or null when absent. */
function readInteger(
  fields: Record<string, unknown>,
  name: string,
  max: number,
  problems: SchemaProblem[],
): number | null {
  if (!Object.hasOwn(fields, name)) return null;
  const value = fields[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    problems.push({ path: `/${name}`, message: `must be a whole number from 0 to ${max}` });
    return null;
  }
  return value;
}

/** A failed notification's optional `reason`; only output_too_large exists. */
function readReason(
  fields: Record<string, unknown>,
  problems: SchemaProblem[],
): "output_too_large" | null {
  if (!Object.hasOwn(fields, "reason")) return null;
  if (fields.reason !== "output_too_large") {
    problems.push({ path: "/reason", message: "must be output_too_large" });
    return null;
  }
  return "output_too_large";
}

function answer(
  status: number,
  keepReporting: boolean,
  error?: Record<string, unknown>,
): NotificationAnswer {
  return { status, body: { continue: keepReporting, ...(error && { error }) } };
}

/**
 * The answer to a notification on a call that already ended. A success is a
 * duplicate, and fine; a failure says why.
 */
function endedAnswer(ending: Ending): NotificationAnswer {
  if (ending.status === "success") return answer(200, false);
  return answer(410, false, {
    code: FAILURE_CODES[ending.reason],
    message: "This invocation has already ended.",
    failure_reason: ending.reason,
  });
}

/**
 * The answer to a completed result Varis refused. A schema that doesn't
 * compile fails the call quietly, as provider_error with a 200.
 */
function rejectedResultAnswer(check: Extract<OutputCheck, { ok: false }>): NotificationAnswer {
  if (check.cause.kind === "too_large") {
    return answer(413, false, {
      code: "provider_error",
      message:
        "result is larger than 4 MB of JSON. Return a large result as a URL to your own storage instead.",
      failure_reason: "output_too_large",
    });
  }
  if (check.cause.kind === "schema_mismatch") {
    return answer(422, false, {
      code: "schema_violation",
      message: "result does not match the service's output schema.",
      details: check.cause.problems,
    });
  }
  return answer(200, false);
}
