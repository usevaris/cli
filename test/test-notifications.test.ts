// Tests for the notification inbox: each answer the notification route in
// the varis repository gives, for the notifications a test call can send.

import { describe, expect, it } from "vitest";
import {
  createNotificationInbox,
  parseNotificationBody,
} from "../src/lib/test-notifications.ts";
import { checkResult, MAX_OUTPUT_BYTES } from "../src/lib/test-outcome.ts";

const OUTPUT_SCHEMA = {
  type: "object",
  properties: { url: { type: "string" } },
  required: ["url"],
};

const inbox = () => createNotificationInbox((result) => checkResult(result, OUTPUT_SCHEMA));
const send = (box: ReturnType<typeof inbox>, body: unknown) => box.receive(JSON.stringify(body));

describe("the notification inbox", () => {
  it("accepts the call on its first started, and counts a later one as running", async () => {
    const box = inbox();

    expect(send(box, { status: "started", eta_seconds: 600, message: "Queued" })).toEqual({
      status: 200,
      body: { continue: true },
    });
    expect(box.accepted()).toBe(true);
    send(box, { status: "started", message: "Still queued" });

    expect(await box.next()).toEqual({ status: "started", etaSeconds: 600, message: "Queued" });
    expect(await box.next()).toEqual({
      status: "running",
      progressPercent: null,
      etaSeconds: null,
      message: "Still queued",
    });
  });

  it("counts a started after a 202 as running", async () => {
    const box = inbox();
    box.markAccepted();

    send(box, { status: "started" });

    expect((await box.next()).status).toBe("running");
  });

  it("answers running with continue: true and records its progress", async () => {
    const box = inbox();

    const answer = send(box, { status: "running", progress_percent: 40, eta_seconds: 60 });

    expect(answer).toEqual({ status: 200, body: { continue: true } });
    expect(box.accepted()).toBe(false);
    expect(await box.next()).toEqual({
      status: "running",
      progressPercent: 40,
      etaSeconds: 60,
      message: null,
    });
  });

  it("answers a valid completed result with continue: false", async () => {
    const box = inbox();

    const answer = send(box, { status: "completed", result: { url: "https://x.example/1" } });

    expect(answer).toEqual({ status: 200, body: { continue: false } });
    expect(await box.next()).toEqual({
      status: "completed",
      result: { url: "https://x.example/1" },
      check: { ok: true },
    });
  });

  it("answers a result that breaks the output schema with a 422 and the problems", async () => {
    const box = inbox();

    const answer = send(box, { status: "completed", result: { url: 5 } });

    expect(answer.status).toBe(422);
    expect(answer.body).toMatchObject({
      continue: false,
      error: { code: "schema_violation", details: [{ path: "/url" }] },
    });
    expect(await box.next()).toMatchObject({
      status: "completed",
      check: { ok: false, reason: "schema_violation" },
    });
  });

  it("answers a result over 4 MB with a 413 and output_too_large", async () => {
    const box = inbox();

    const answer = send(box, {
      status: "completed",
      result: { url: "x".repeat(MAX_OUTPUT_BYTES) },
    });

    expect(answer.status).toBe(413);
    expect(answer.body).toMatchObject({
      continue: false,
      error: { code: "provider_error", failure_reason: "output_too_large" },
    });
    expect(await box.next()).toMatchObject({
      check: { ok: false, reason: "output_too_large" },
    });
  });

  it("answers failed with continue: false, with or without a reason", async () => {
    const box = inbox();

    expect(send(box, { status: "failed", message: "Out of memory" })).toEqual({
      status: 200,
      body: { continue: false },
    });
    expect(await box.next()).toEqual({ status: "failed", message: "Out of memory", reason: null });

    const tooLarge = inbox();
    send(tooLarge, { status: "failed", reason: "output_too_large" });
    expect(await tooLarge.next()).toEqual({
      status: "failed",
      message: null,
      reason: "output_too_large",
    });
  });

  it("answers a duplicate after a success with 200 and continue: false", () => {
    const box = inbox();
    send(box, { status: "completed", result: { url: "u" } });

    expect(send(box, { status: "completed", result: { url: "u" } })).toEqual({
      status: 200,
      body: { continue: false },
    });
    expect(send(box, { status: "running" })).toEqual({ status: 200, body: { continue: false } });
  });

  it("answers anything after a failure with a 410 naming the reason", () => {
    const box = inbox();
    send(box, { status: "completed", result: { url: 5 } });

    const answer = send(box, { status: "running" });

    expect(answer.status).toBe(410);
    expect(answer.body).toEqual({
      continue: false,
      error: {
        code: "schema_violation",
        message: "This invocation has already ended.",
        failure_reason: "schema_violation",
      },
    });
  });

  it("answers an invalid body with a 400 and continue: true, even after the call ended", async () => {
    const box = inbox();
    send(box, { status: "failed" });
    await box.next();

    const answer = box.receive("not json");

    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ continue: true, error: { code: "invalid_request" } });
    expect(await box.next()).toEqual({
      status: "invalid",
      problems: [{ path: "/", message: "must be a JSON object" }],
    });
  });

  it("answers an unauthorised notification with a 401 and continue: false", async () => {
    const box = inbox();

    expect(box.refuseUnauthorised()).toMatchObject({
      status: 401,
      body: { continue: false, error: { code: "unauthorized" } },
    });
    expect(await box.next()).toEqual({ status: "unauthorised" });
  });

  it("records a notice before a notification with parts Varis would drop", async () => {
    const box = inbox();

    const answer = send(box, { status: "running", etaSeconds: 60, progress_percent: 10 });

    expect(answer).toEqual({ status: 200, body: { continue: true } });
    expect(await box.next()).toEqual({
      status: "notice",
      notices: [{ path: "/etaSeconds", message: "isn't a field Varis reads, so it's ignored. Did you mean eta_seconds?" }],
    });
    expect(await box.next()).toMatchObject({ status: "running", progressPercent: 10, etaSeconds: null });
  });

  it("records no notice for a notification Varis reads in full", async () => {
    const box = inbox();

    send(box, { status: "running", progress_percent: 10, eta_seconds: 5, message: "ok" });

    expect((await box.next()).status).toBe("running");
  });

  it("hands out notifications in order, waiting for one that hasn't arrived", async () => {
    const box = inbox();
    const first = box.next();
    const second = box.next();

    send(box, { status: "running", message: "one" });
    send(box, { status: "running", message: "two" });

    expect((await first) as { message: string }).toMatchObject({ message: "one" });
    expect((await second) as { message: string }).toMatchObject({ message: "two" });
  });
});

describe("parseNotificationBody", () => {
  const problemsOf = (raw: unknown) => {
    const parsed = parseNotificationBody(raw);
    return parsed.ok ? [] : parsed.problems.map((p) => p.path);
  };

  it("cuts message to 160 characters and reads an empty one as none", () => {
    const long = parseNotificationBody({ status: "running", message: "x".repeat(200) });
    const empty = parseNotificationBody({ status: "running", message: "" });

    expect(long.ok && long.body.status === "running" && long.body.message).toBe("x".repeat(160));
    expect(empty.ok && empty.body.status === "running" && empty.body.message).toBeNull();
  });

  it("requires result on completed, null included", () => {
    expect(problemsOf({ status: "completed" })).toEqual(["/result"]);
    expect(problemsOf({ status: "completed", result: null })).toEqual([]);
  });

  it("rejects an unknown status, and a body that isn't an object", () => {
    expect(problemsOf({ status: "done" })).toEqual(["/status"]);
    expect(problemsOf({})).toEqual(["/status"]);
    expect(problemsOf([])).toEqual(["/"]);
    expect(problemsOf(null)).toEqual(["/"]);
  });

  it("checks each optional field's range and type, and rejects null", () => {
    expect(problemsOf({ status: "running", progress_percent: 101 })).toEqual(["/progress_percent"]);
    expect(problemsOf({ status: "running", progress_percent: 2.5 })).toEqual(["/progress_percent"]);
    expect(problemsOf({ status: "started", eta_seconds: 86_401 })).toEqual(["/eta_seconds"]);
    expect(problemsOf({ status: "started", eta_seconds: -1 })).toEqual(["/eta_seconds"]);
    expect(problemsOf({ status: "started", message: null })).toEqual(["/message"]);
    expect(problemsOf({ status: "failed", reason: "oops" })).toEqual(["/reason"]);
  });

  const noticesOf = (raw: unknown) => {
    const parsed = parseNotificationBody(raw);
    return parsed.ok ? parsed.notices : [];
  };

  it("notes a field Varis doesn't read, suggesting the one it probably means", () => {
    expect(noticesOf({ status: "running", progressPercent: 4, ETA: 9, colour: "red" })).toEqual([
      { path: "/progressPercent", message: "isn't a field Varis reads, so it's ignored. Did you mean progress_percent?" },
      { path: "/ETA", message: "isn't a field Varis reads, so it's ignored. Did you mean eta_seconds?" },
      { path: "/colour", message: "isn't a field Varis reads, so it's ignored." },
    ]);
  });

  it("notes a field that another status reads", () => {
    expect(noticesOf({ status: "started", progress_percent: 5 })).toEqual([
      { path: "/progress_percent", message: "is ignored on started notifications. Varis reads it only on running." },
    ]);
    expect(noticesOf({ status: "completed", result: 1, message: "done" })).toEqual([
      { path: "/message", message: "is ignored on completed notifications. Varis reads it only on started, running, and failed." },
    ]);
  });

  it("notes a message Varis cuts to 160 characters", () => {
    expect(noticesOf({ status: "failed", message: "x".repeat(170) })).toEqual([
      { path: "/message", message: "is 170 characters. Varis keeps the first 160, so agents see it cut." },
    ]);
    expect(noticesOf({ status: "failed", message: "x".repeat(160) })).toEqual([]);
  });

  it("ignores fields a status doesn't have, as the route does", () => {
    expect(problemsOf({ status: "completed", result: 1, message: 5, extra: true })).toEqual([]);
    expect(problemsOf({ status: "started", progress_percent: 500 })).toEqual([]);
    expect(problemsOf({ status: "failed", eta_seconds: "soon" })).toEqual([]);
  });
});
