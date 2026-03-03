/**
 * Tests for the notification system.
 *
 * Covers:
 * - NotificationDispatcher (channel registration, sendTo, broadcast, error handling)
 * - WebhookChannel (payload formatting, HMAC signing, fetch behavior)
 * - EmailChannel (subject/body formatting, API call)
 * - SmsChannel (Twilio API call, multi-recipient, formatting)
 * - AlertManager → Notification integration (threshold evaluation, dispatch routing)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { Alert, AlertThreshold, ChannelPreference } from "../src/health/alert-types.js";
import type { NotificationChannel } from "../src/notifications/channel.js";

// ─── Test helpers ────────────────────────────────────────────────────────────

/** Create a minimal Alert fixture for testing. */
function createTestAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: "alert_test_1",
    thresholdId: "memory:rss",
    checkName: "memory",
    metric: "rss",
    severity: "warning",
    state: "firing",
    value: 512,
    threshold: 400,
    message: "Memory RSS is 512 (warning threshold: 400)",
    firedAt: "2026-02-28T12:00:00.000Z",
    ...overrides,
  };
}

/** Create a mock notification channel. */
function createMockChannel(
  name: string,
  opts: { enabled?: boolean; sendResult?: boolean; throwError?: Error } = {},
): NotificationChannel {
  const { enabled = true, sendResult = true, throwError } = opts;
  return {
    name,
    enabled,
    send: vi.fn(async () => {
      if (throwError) throw throwError;
      return sendResult;
    }),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// NotificationDispatcher
// ═════════════════════════════════════════════════════════════════════════════

describe("NotificationDispatcher", () => {
  let dispatcher: import("../src/notifications/channel.js").NotificationDispatcher;

  beforeEach(async () => {
    const mod = await import("../src/notifications/channel.js");
    dispatcher = new mod.NotificationDispatcher();
  });

  describe("channel management", () => {
    it("registers and retrieves a channel", () => {
      const channel = createMockChannel("webhook");
      dispatcher.add(channel);
      expect(dispatcher.get("webhook")).toBe(channel);
    });

    it("lists registered channel names", () => {
      dispatcher.add(createMockChannel("email"));
      dispatcher.add(createMockChannel("sms"));
      expect(dispatcher.list()).toEqual(["email", "sms"]);
    });

    it("removes a channel by name", () => {
      dispatcher.add(createMockChannel("webhook"));
      dispatcher.remove("webhook");
      expect(dispatcher.get("webhook")).toBeUndefined();
      expect(dispatcher.list()).toEqual([]);
    });

    it("overwrites a channel with the same name", () => {
      const ch1 = createMockChannel("webhook", { sendResult: true });
      const ch2 = createMockChannel("webhook", { sendResult: false });
      dispatcher.add(ch1);
      dispatcher.add(ch2);
      expect(dispatcher.get("webhook")).toBe(ch2);
    });
  });

  describe("sendTo", () => {
    it("sends alert to a specific enabled channel", async () => {
      const channel = createMockChannel("webhook");
      dispatcher.add(channel);
      const alert = createTestAlert();
      const result = await dispatcher.sendTo("webhook", alert);
      expect(result).toBe(true);
      expect(channel.send).toHaveBeenCalledWith(alert);
    });

    it("returns false for non-existent channel", async () => {
      const result = await dispatcher.sendTo("nonexistent", createTestAlert());
      expect(result).toBe(false);
    });

    it("returns false for disabled channel", async () => {
      const channel = createMockChannel("webhook", { enabled: false });
      dispatcher.add(channel);
      const result = await dispatcher.sendTo("webhook", createTestAlert());
      expect(result).toBe(false);
      expect(channel.send).not.toHaveBeenCalled();
    });

    it("returns false when channel.send returns false", async () => {
      const channel = createMockChannel("webhook", { sendResult: false });
      dispatcher.add(channel);
      const result = await dispatcher.sendTo("webhook", createTestAlert());
      expect(result).toBe(false);
    });

    it("catches errors from channel.send and returns false", async () => {
      const channel = createMockChannel("webhook", {
        throwError: new Error("network error"),
      });
      dispatcher.add(channel);
      const result = await dispatcher.sendTo("webhook", createTestAlert());
      expect(result).toBe(false);
    });
  });

  describe("broadcast", () => {
    it("sends to all enabled channels and returns results map", async () => {
      const webhook = createMockChannel("webhook");
      const email = createMockChannel("email");
      dispatcher.add(webhook);
      dispatcher.add(email);

      const alert = createTestAlert();
      const results = await dispatcher.broadcast(alert);

      expect(results).toEqual({ webhook: true, email: true });
      expect(webhook.send).toHaveBeenCalledWith(alert);
      expect(email.send).toHaveBeenCalledWith(alert);
    });

    it("skips disabled channels (marks as false)", async () => {
      const enabled = createMockChannel("webhook");
      const disabled = createMockChannel("email", { enabled: false });
      dispatcher.add(enabled);
      dispatcher.add(disabled);

      const results = await dispatcher.broadcast(createTestAlert());

      expect(results.webhook).toBe(true);
      expect(results.email).toBe(false);
      expect(disabled.send).not.toHaveBeenCalled();
    });

    it("handles mixed success/failure across channels", async () => {
      const success = createMockChannel("webhook", { sendResult: true });
      const failure = createMockChannel("email", { sendResult: false });
      const crash = createMockChannel("sms", {
        throwError: new Error("twilio down"),
      });
      dispatcher.add(success);
      dispatcher.add(failure);
      dispatcher.add(crash);

      const results = await dispatcher.broadcast(createTestAlert());

      expect(results.webhook).toBe(true);
      expect(results.email).toBe(false);
      expect(results.sms).toBe(false);
    });

    it("returns empty object when no channels registered", async () => {
      const results = await dispatcher.broadcast(createTestAlert());
      expect(results).toEqual({});
    });

    it("all channels receive the same alert object", async () => {
      const ch1 = createMockChannel("a");
      const ch2 = createMockChannel("b");
      dispatcher.add(ch1);
      dispatcher.add(ch2);

      const alert = createTestAlert({ id: "shared_alert" });
      await dispatcher.broadcast(alert);

      expect(ch1.send).toHaveBeenCalledWith(alert);
      expect(ch2.send).toHaveBeenCalledWith(alert);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// WebhookChannel
// ═════════════════════════════════════════════════════════════════════════════

describe("WebhookChannel", () => {
  let WebhookChannel: typeof import("../src/notifications/webhook.js").WebhookChannel;

  beforeEach(async () => {
    const mod = await import("../src/notifications/webhook.js");
    WebhookChannel = mod.WebhookChannel;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has name 'webhook' and respects enabled config", () => {
    const ch = new WebhookChannel({ url: "https://hooks.example.com/test" });
    expect(ch.name).toBe("webhook");
    expect(ch.enabled).toBe(true);

    const disabled = new WebhookChannel({
      url: "https://hooks.example.com/test",
      enabled: false,
    });
    expect(disabled.enabled).toBe(false);
  });

  it("sends correct JSON payload structure", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const ch = new WebhookChannel({ url: "https://hooks.example.com/test" });
    const alert = createTestAlert();
    const result = await ch.send(alert);

    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://hooks.example.com/test");
    expect(opts?.method).toBe("POST");

    const body = JSON.parse(opts?.body as string);
    expect(body.event).toBe("alert");
    expect(body.timestamp).toBeTruthy();
    expect(body.alert.id).toBe("alert_test_1");
    expect(body.alert.checkName).toBe("memory");
    expect(body.alert.metric).toBe("rss");
    expect(body.alert.severity).toBe("warning");
    expect(body.alert.state).toBe("firing");
    expect(body.alert.value).toBe(512);
    expect(body.alert.threshold).toBe(400);
    expect(body.alert.message).toBe("Memory RSS is 512 (warning threshold: 400)");
    expect(body.alert.firedAt).toBe("2026-02-28T12:00:00.000Z");
  });

  it("includes custom headers in the request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const ch = new WebhookChannel({
      url: "https://hooks.example.com/test",
      headers: { "X-Custom": "my-value" },
    });
    await ch.send(createTestAlert());

    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Custom"]).toBe("my-value");
  });

  it("signs payload with HMAC-SHA256 when secret is configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const ch = new WebhookChannel({
      url: "https://hooks.example.com/test",
      secret: "my-webhook-secret",
    });
    await ch.send(createTestAlert());

    const headers = fetchSpy.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["X-Signature-256"]).toBeDefined();
    expect(headers["X-Signature-256"]).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("returns false on non-OK HTTP response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("error", { status: 500 }),
    );

    const ch = new WebhookChannel({ url: "https://hooks.example.com/test" });
    const result = await ch.send(createTestAlert());
    expect(result).toBe(false);
  });

  it("returns false on network error (fetch throws)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("DNS resolution failed"));

    const ch = new WebhookChannel({ url: "https://hooks.example.com/test" });
    const result = await ch.send(createTestAlert());
    expect(result).toBe(false);
  });

  it("includes resolved alert fields when present", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const ch = new WebhookChannel({ url: "https://hooks.example.com/test" });
    const alert = createTestAlert({
      state: "resolved",
      acknowledgedAt: "2026-02-28T12:05:00.000Z",
      resolvedAt: "2026-02-28T12:10:00.000Z",
    });
    await ch.send(alert);

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.alert.state).toBe("resolved");
    expect(body.alert.acknowledgedAt).toBe("2026-02-28T12:05:00.000Z");
    expect(body.alert.resolvedAt).toBe("2026-02-28T12:10:00.000Z");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// EmailChannel
// ═════════════════════════════════════════════════════════════════════════════

describe("EmailChannel", () => {
  let EmailChannel: typeof import("../src/notifications/email.js").EmailChannel;

  beforeEach(async () => {
    const mod = await import("../src/notifications/email.js");
    EmailChannel = mod.EmailChannel;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has name 'email' and respects enabled config", () => {
    const ch = new EmailChannel({
      endpoint: "https://api.resend.com/emails",
      apiKey: "re_test_123",
      from: "dash@example.com",
      to: ["user@example.com"],
    });
    expect(ch.name).toBe("email");
    expect(ch.enabled).toBe(true);
  });

  it("sends email with correct subject and HTML body", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }),
    );

    const ch = new EmailChannel({
      endpoint: "https://api.resend.com/emails",
      apiKey: "re_test_123",
      from: "dash@example.com",
      to: ["user@example.com"],
    });

    const alert = createTestAlert({ severity: "critical" });
    const result = await ch.send(alert);

    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(opts?.method).toBe("POST");

    const headers = opts?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer re_test_123");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(opts?.body as string);
    expect(body.from).toBe("dash@example.com");
    expect(body.to).toEqual(["user@example.com"]);
    expect(body.subject).toBe("[CRITICAL] Memory RSS is 512 (warning threshold: 400)");

    // HTML body should contain alert details
    expect(body.html).toContain("CRITICAL Alert");
    expect(body.html).toContain("memory");
    expect(body.html).toContain("rss");
    expect(body.html).toContain("512");
    expect(body.html).toContain("400");
    expect(body.html).toContain("alert_test_1");
  });

  it("formats warning alerts with amber color", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const ch = new EmailChannel({
      endpoint: "https://api.resend.com/emails",
      apiKey: "key",
      from: "from@test.com",
      to: ["to@test.com"],
    });

    await ch.send(createTestAlert({ severity: "warning" }));

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.subject).toContain("[WARNING]");
    expect(body.html).toContain("#f59e0b"); // amber color for warning
  });

  it("formats critical alerts with red color", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const ch = new EmailChannel({
      endpoint: "https://api.resend.com/emails",
      apiKey: "key",
      from: "from@test.com",
      to: ["to@test.com"],
    });

    await ch.send(createTestAlert({ severity: "critical" }));

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.html).toContain("#dc2626"); // red color for critical
  });

  it("returns false on API error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("unauthorized", { status: 401 }),
    );

    const ch = new EmailChannel({
      endpoint: "https://api.resend.com/emails",
      apiKey: "bad_key",
      from: "from@test.com",
      to: ["to@test.com"],
    });

    const result = await ch.send(createTestAlert());
    expect(result).toBe(false);
  });

  it("returns false on network error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const ch = new EmailChannel({
      endpoint: "https://api.resend.com/emails",
      apiKey: "key",
      from: "from@test.com",
      to: ["to@test.com"],
    });

    const result = await ch.send(createTestAlert());
    expect(result).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SmsChannel
// ═════════════════════════════════════════════════════════════════════════════

describe("SmsChannel", () => {
  let SmsChannel: typeof import("../src/notifications/sms.js").SmsChannel;

  beforeEach(async () => {
    const mod = await import("../src/notifications/sms.js");
    SmsChannel = mod.SmsChannel;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has name 'sms' and respects enabled config", () => {
    const ch = new SmsChannel({
      accountSid: "AC_test",
      authToken: "token",
      from: "+15551234567",
      to: ["+15559876543"],
    });
    expect(ch.name).toBe("sms");
    expect(ch.enabled).toBe(true);
  });

  it("sends SMS via Twilio API with correct auth and format", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ sid: "SM_test" }), { status: 201 }),
    );

    const ch = new SmsChannel({
      accountSid: "AC_test",
      authToken: "my-token",
      from: "+15551234567",
      to: ["+15559876543"],
    });

    const alert = createTestAlert({ severity: "critical" });
    const result = await ch.send(alert);

    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC_test/Messages.json");
    expect(opts?.method).toBe("POST");

    // Check Basic auth
    const headers = opts?.headers as Record<string, string>;
    const decoded = Buffer.from(
      headers["Authorization"].replace("Basic ", ""),
      "base64",
    ).toString();
    expect(decoded).toBe("AC_test:my-token");

    // Check URL-encoded body
    const bodyStr = opts?.body as string;
    const params = new URLSearchParams(bodyStr);
    expect(params.get("From")).toBe("+15551234567");
    expect(params.get("To")).toBe("+15559876543");

    // SMS body contains alert info
    const smsBody = params.get("Body")!;
    expect(smsBody).toContain("CRITICAL");
    expect(smsBody).toContain("memory");
    expect(smsBody).toContain("512");
    expect(smsBody).toContain("400");
  });

  it("formats warning SMS with warning emoji", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 201 }),
    );

    const ch = new SmsChannel({
      accountSid: "AC_test",
      authToken: "token",
      from: "+15551234567",
      to: ["+15559876543"],
    });

    await ch.send(createTestAlert({ severity: "warning" }));

    const bodyStr = fetchSpy.mock.calls[0][1]?.body as string;
    const smsBody = new URLSearchParams(bodyStr).get("Body")!;
    expect(smsBody).toContain("WARNING");
    expect(smsBody).toContain("\u26a0\ufe0f"); // ⚠️
  });

  it("formats critical SMS with siren emoji", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 201 }),
    );

    const ch = new SmsChannel({
      accountSid: "AC_test",
      authToken: "token",
      from: "+15551234567",
      to: ["+15559876543"],
    });

    await ch.send(createTestAlert({ severity: "critical" }));

    const bodyStr = fetchSpy.mock.calls[0][1]?.body as string;
    const smsBody = new URLSearchParams(bodyStr).get("Body")!;
    expect(smsBody).toContain("\ud83d\udea8"); // 🚨
  });

  it("sends to multiple recipients", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 201 }),
    );

    const ch = new SmsChannel({
      accountSid: "AC_test",
      authToken: "token",
      from: "+15551234567",
      to: ["+15559876543", "+15551111111", "+15552222222"],
    });

    const result = await ch.send(createTestAlert());

    expect(result).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(3);

    const recipients = fetchSpy.mock.calls.map((call) => {
      const bodyStr = call[1]?.body as string;
      return new URLSearchParams(bodyStr).get("To");
    });
    expect(recipients).toEqual(["+15559876543", "+15551111111", "+15552222222"]);
  });

  it("returns true if at least one recipient succeeds", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("error", { status: 500 }))
      .mockResolvedValueOnce(new Response("ok", { status: 201 }));

    const ch = new SmsChannel({
      accountSid: "AC_test",
      authToken: "token",
      from: "+15551234567",
      to: ["+15559876543", "+15551111111"],
    });

    const result = await ch.send(createTestAlert());
    expect(result).toBe(true); // at least one succeeded
  });

  it("returns false when all recipients fail", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("error", { status: 500 }),
    );

    const ch = new SmsChannel({
      accountSid: "AC_test",
      authToken: "token",
      from: "+15551234567",
      to: ["+15559876543", "+15551111111"],
    });

    const result = await ch.send(createTestAlert());
    expect(result).toBe(false);
  });

  it("handles fetch throwing for individual recipients", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce(new Response("ok", { status: 201 }));

    const ch = new SmsChannel({
      accountSid: "AC_test",
      authToken: "token",
      from: "+15551234567",
      to: ["+15559876543", "+15551111111"],
    });

    const result = await ch.send(createTestAlert());
    expect(result).toBe(true); // second recipient succeeded
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// AlertManager → Notification integration
// ═════════════════════════════════════════════════════════════════════════════

describe("AlertManager + NotificationDispatcher integration", () => {
  let AlertManager: typeof import("../src/health/alerting.js").AlertManager;
  let NotificationDispatcher: typeof import("../src/notifications/channel.js").NotificationDispatcher;
  let HealthChecker: typeof import("../src/health/checker.js").HealthChecker;

  beforeEach(async () => {
    const alertMod = await import("../src/health/alerting.js");
    const channelMod = await import("../src/notifications/channel.js");
    const checkerMod = await import("../src/health/checker.js");
    AlertManager = alertMod.AlertManager;
    NotificationDispatcher = channelMod.NotificationDispatcher;
    HealthChecker = checkerMod.HealthChecker;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setupAlertSystem(opts: {
    memoryValue: number;
    warningThreshold?: number;
    criticalThreshold?: number;
    channels?: NotificationChannel[];
    preferences?: ChannelPreference[];
    cooldownMs?: number;
  }) {
    const checker = new HealthChecker();
    checker.register("memory", () => ({
      status: "healthy",
      detail: `heap ${opts.memoryValue}MB, rss ${opts.memoryValue}MB`,
    }));

    const dispatcher = new NotificationDispatcher();
    for (const ch of opts.channels ?? []) {
      dispatcher.add(ch);
    }

    const thresholds: AlertThreshold[] = [
      {
        checkName: "memory",
        metric: "rss",
        warningThreshold: opts.warningThreshold ?? 400,
        criticalThreshold: opts.criticalThreshold ?? 800,
        label: "Memory RSS",
      },
    ];

    const preferences: ChannelPreference[] = opts.preferences ?? [
      { channel: "webhook", minSeverity: "warning" },
    ];

    const manager = new AlertManager(
      checker,
      {
        enabled: true,
        thresholds,
        notifications: preferences,
        notificationCooldownMs: opts.cooldownMs ?? 0, // disable cooldown for tests
      },
      dispatcher,
    );

    return { checker, dispatcher, manager };
  }

  it("fires alert and dispatches to channel when threshold breached", async () => {
    const webhook = createMockChannel("webhook");
    const { manager } = setupAlertSystem({
      memoryValue: 500,
      warningThreshold: 400,
      channels: [webhook],
    });

    const { fired } = await manager.evaluate();

    expect(fired).toHaveLength(1);
    expect(webhook.send).toHaveBeenCalledOnce();

    const sentAlert = (webhook.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as Alert;
    expect(sentAlert.severity).toBe("warning");
    expect(sentAlert.checkName).toBe("memory");
    expect(sentAlert.metric).toBe("rss");
    expect(sentAlert.value).toBe(500);
  });

  it("fires critical alert when critical threshold breached", async () => {
    const webhook = createMockChannel("webhook");
    const { manager } = setupAlertSystem({
      memoryValue: 900,
      warningThreshold: 400,
      criticalThreshold: 800,
      channels: [webhook],
    });

    const { fired } = await manager.evaluate();

    expect(fired).toHaveLength(1);
    const sentAlert = (webhook.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as Alert;
    expect(sentAlert.severity).toBe("critical");
  });

  it("does not fire alert when value is below thresholds", async () => {
    const webhook = createMockChannel("webhook");
    const { manager } = setupAlertSystem({
      memoryValue: 200,
      warningThreshold: 400,
      channels: [webhook],
    });

    const { fired } = await manager.evaluate();

    expect(fired).toHaveLength(0);
    expect(webhook.send).not.toHaveBeenCalled();
  });

  it("resolves alert when value drops below thresholds", async () => {
    const webhook = createMockChannel("webhook");
    const checker = new HealthChecker();
    let memValue = 500;
    checker.register("memory", () => ({
      status: "healthy",
      detail: `heap ${memValue}MB, rss ${memValue}MB`,
    }));

    const dispatcher = new NotificationDispatcher();
    dispatcher.add(webhook);

    const manager = new AlertManager(
      checker,
      {
        enabled: true,
        thresholds: [{
          checkName: "memory",
          metric: "rss",
          warningThreshold: 400,
          criticalThreshold: 800,
          label: "Memory RSS",
        }],
        notifications: [{ channel: "webhook", minSeverity: "warning" }],
        notificationCooldownMs: 0,
      },
      dispatcher,
    );

    // First eval: fire alert
    const { fired } = await manager.evaluate();
    expect(fired).toHaveLength(1);

    // Drop value below threshold
    memValue = 200;
    const { resolved } = await manager.evaluate();
    expect(resolved).toHaveLength(1);

    // Resolve notification should also be sent
    expect(webhook.send).toHaveBeenCalledTimes(2);
  });

  it("respects minSeverity filter on channel preferences", async () => {
    const webhook = createMockChannel("webhook");
    const { manager } = setupAlertSystem({
      memoryValue: 500, // triggers warning
      warningThreshold: 400,
      criticalThreshold: 800,
      channels: [webhook],
      preferences: [
        { channel: "webhook", minSeverity: "critical" }, // only critical
      ],
    });

    await manager.evaluate();

    // Warning alert fired but webhook has minSeverity=critical, so no notification
    expect(webhook.send).not.toHaveBeenCalled();
    expect(manager.getActive()).toHaveLength(1);
  });

  it("dispatches to multiple channels based on preferences", async () => {
    const webhook = createMockChannel("webhook");
    const email = createMockChannel("email");
    const sms = createMockChannel("sms");

    const checker = new HealthChecker();
    checker.register("memory", () => ({
      status: "healthy",
      detail: "heap 900MB, rss 900MB",
    }));

    const dispatcher = new NotificationDispatcher();
    dispatcher.add(webhook);
    dispatcher.add(email);
    dispatcher.add(sms);

    const manager = new AlertManager(
      checker,
      {
        enabled: true,
        thresholds: [{
          checkName: "memory",
          metric: "rss",
          warningThreshold: 400,
          criticalThreshold: 800,
        }],
        notifications: [
          { channel: "webhook", minSeverity: "warning" },
          { channel: "email", minSeverity: "critical" },
          { channel: "sms", minSeverity: "critical" },
        ],
        notificationCooldownMs: 0,
      },
      dispatcher,
    );

    await manager.evaluate();

    // Critical alert: webhook (warning+), email (critical), sms (critical) all get notified
    expect(webhook.send).toHaveBeenCalledOnce();
    expect(email.send).toHaveBeenCalledOnce();
    expect(sms.send).toHaveBeenCalledOnce();
  });

  it("acknowledge and resolve lifecycle works correctly", async () => {
    const webhook = createMockChannel("webhook");
    const { manager } = setupAlertSystem({
      memoryValue: 500,
      warningThreshold: 400,
      channels: [webhook],
    });

    const { fired } = await manager.evaluate();
    const alertId = fired[0];

    // Acknowledge
    const ackResult = manager.acknowledge(alertId, "operator");
    expect(ackResult).toBe(true);

    const alert = manager.getAlert(alertId);
    expect(alert?.state).toBe("acknowledged");
    expect(alert?.acknowledgedBy).toBe("operator");

    // Manual resolve
    const resolveResult = manager.resolve(alertId);
    expect(resolveResult).toBe(true);

    expect(manager.getActive()).toHaveLength(0);
    expect(manager.getHistory()).toHaveLength(1);
  });

  it("getSummary returns correct breakdown", async () => {
    const { manager } = setupAlertSystem({
      memoryValue: 500,
      warningThreshold: 400,
    });

    await manager.evaluate();

    const summary = manager.getSummary();
    expect(summary.activeCount).toBe(1);
    expect(summary.bySeverity.warning).toBe(1);
    expect(summary.bySeverity.critical).toBe(0);
    expect(summary.firing).toHaveLength(1);
    expect(summary.acknowledged).toHaveLength(0);
    expect(summary.lastEvaluation).toBeTruthy();
  });

  it("respects notification cooldown", async () => {
    const webhook = createMockChannel("webhook");
    const { manager } = setupAlertSystem({
      memoryValue: 500,
      warningThreshold: 400,
      channels: [webhook],
      cooldownMs: 300_000, // 5 min cooldown
    });

    // First evaluation fires and notifies
    await manager.evaluate();
    expect(webhook.send).toHaveBeenCalledOnce();

    // Second evaluation: alert already active, cooldown prevents re-notification
    await manager.evaluate();
    expect(webhook.send).toHaveBeenCalledOnce(); // still just once
  });

  it("escalates warning to critical and re-notifies", async () => {
    const webhook = createMockChannel("webhook");
    const checker = new HealthChecker();
    let memValue = 500;
    checker.register("memory", () => ({
      status: "healthy",
      detail: `heap ${memValue}MB, rss ${memValue}MB`,
    }));

    const dispatcher = new NotificationDispatcher();
    dispatcher.add(webhook);

    const manager = new AlertManager(
      checker,
      {
        enabled: true,
        thresholds: [{
          checkName: "memory",
          metric: "rss",
          warningThreshold: 400,
          criticalThreshold: 800,
        }],
        notifications: [{ channel: "webhook", minSeverity: "warning" }],
        notificationCooldownMs: 0,
      },
      dispatcher,
    );

    // First: warning
    await manager.evaluate();
    expect(manager.getActive()[0].severity).toBe("warning");

    // Escalate to critical
    memValue = 900;
    await manager.evaluate();
    expect(manager.getActive()[0].severity).toBe("critical");

    // Should have notified twice (warning + escalation)
    expect(webhook.send).toHaveBeenCalledTimes(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Cross-channel message formatting consistency
// ═════════════════════════════════════════════════════════════════════════════

describe("Cross-channel formatting consistency", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("all channels include alert severity, check name, value, and threshold", async () => {
    const { WebhookChannel } = await import("../src/notifications/webhook.js");
    const { EmailChannel } = await import("../src/notifications/email.js");
    const { SmsChannel } = await import("../src/notifications/sms.js");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 }),
    );

    const alert = createTestAlert({
      severity: "critical",
      checkName: "cpu",
      metric: "usage",
      value: 95,
      threshold: 90,
      message: "CPU usage is 95 (critical threshold: 90)",
    });

    // Send via all channels
    const webhook = new WebhookChannel({ url: "https://hooks.example.com/test" });
    const email = new EmailChannel({
      endpoint: "https://api.resend.com/emails",
      apiKey: "key",
      from: "from@test.com",
      to: ["to@test.com"],
    });
    const sms = new SmsChannel({
      accountSid: "AC_test",
      authToken: "token",
      from: "+15551234567",
      to: ["+15559876543"],
    });

    await webhook.send(alert);
    await email.send(alert);
    await sms.send(alert);

    expect(fetchSpy).toHaveBeenCalledTimes(3);

    // Webhook payload
    const webhookBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(webhookBody.alert.severity).toBe("critical");
    expect(webhookBody.alert.checkName).toBe("cpu");
    expect(webhookBody.alert.value).toBe(95);
    expect(webhookBody.alert.threshold).toBe(90);

    // Email body
    const emailBody = JSON.parse(fetchSpy.mock.calls[1][1]?.body as string);
    expect(emailBody.subject).toContain("CRITICAL");
    expect(emailBody.html).toContain("cpu");
    expect(emailBody.html).toContain("95");
    expect(emailBody.html).toContain("90");

    // SMS body
    const smsBodyStr = fetchSpy.mock.calls[2][1]?.body as string;
    const smsText = new URLSearchParams(smsBodyStr).get("Body")!;
    expect(smsText).toContain("CRITICAL");
    expect(smsText).toContain("cpu");
    expect(smsText).toContain("95");
    expect(smsText).toContain("90");
  });
});
