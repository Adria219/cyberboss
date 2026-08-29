const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const path = require("path");

const { ArousalHttpServer, PUBLIC_KEYS } = require("../src/arousal/arousal-http-server");
const { CyberbossApp } = require("../src/core/app");

test("loopback API returns exactly the nine public fields", async () => {
  const server = await startServer(validSnapshot());
  try {
    const response = await request(server, "/api/arousal/state");
    assert.equal(response.statusCode, 200);
    assert.deepEqual(Object.keys(response.body).sort(), [...PUBLIC_KEYS].sort());
    assert.equal(server.address().address, "127.0.0.1");
    assert.equal(response.headers["cache-control"], "no-store");
  } finally {
    await server.close();
  }
});

test("extra key, missing key, out-of-range value, and unknown phase fail the whole card", async () => {
  const mutations = [
    (snapshot) => { snapshot.memory = "must-not-leak"; },
    (snapshot) => { delete snapshot.reserve_label; },
    (snapshot) => { snapshot.reserve = 2; },
    (snapshot) => { snapshot.phase = "unknown"; },
    (snapshot) => { snapshot.phase = "refractory"; },
  ];
  for (const mutate of mutations) {
    const snapshot = validSnapshot();
    mutate(snapshot);
    const server = await startServer(snapshot);
    try {
      const response = await request(server, "/api/arousal/state");
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.body, { error: "state_unavailable" });
    } finally {
      await server.close();
    }
  }
});

test("optional bearer token and exact origin allowlist are enforced", async () => {
  const server = await startServer(validSnapshot(), {
    token: "test-token",
    allowedOrigins: ["http://127.0.0.1:5173"],
  });
  try {
    assert.equal((await request(server, "/api/arousal/state")).statusCode, 401);
    assert.equal((await request(server, "/api/arousal/state", {
      authorization: "Bearer test-token",
      origin: "https://outside.invalid",
    })).statusCode, 403);
    const allowed = await request(server, "/api/arousal/state", {
      authorization: "Bearer test-token",
      origin: "http://127.0.0.1:5173",
    });
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.headers["access-control-allow-origin"], "http://127.0.0.1:5173");
    const preflight = await request(server, "/api/arousal/state", {
      origin: "http://127.0.0.1:5173",
      "access-control-request-private-network": "true",
    }, "OPTIONS");
    assert.equal(preflight.statusCode, 204);
    assert.equal(preflight.headers["access-control-allow-private-network"], "true");
  } finally {
    await server.close();
  }
});

test("pure core has no IO/network imports and app connector uses only canonical writes", () => {
  const coreSource = fs.readFileSync(path.join(__dirname, "../src/arousal/arousal-core.js"), "utf8");
  assert.doesNotMatch(coreSource, /require\s*\(/u);
  assert.doesNotMatch(coreSource, /\b(?:fetch|http|https|fs|openai|anthropic)\b/u);
  const appSource = fs.readFileSync(path.join(__dirname, "../src/core/app.js"), "utf8");
  assert.match(appSource, /recordUserFinal/u);
  assert.match(appSource, /recordAssistantFinal/u);
  assert.match(appSource, /getStatusLine/u);
  assert.doesNotMatch(appSource, /getPublicSnapshot/u);
  assert.doesNotMatch(appSource, /pending_release_receipt|processed_event_ids|release_gate/u);
  assert.doesNotMatch(appSource, /(?:applyControlEvent|acknowledgeReleaseEffect|recordControl|acknowledgeEffect)/u);
  const ignoreSource = fs.readFileSync(path.join(__dirname, "../.gitignore"), "utf8");
  assert.match(ignoreSource, /\*\*\/lexicon\.private\.json/u);
  assert.match(ignoreSource, /\*\*\/body-state-unit\.json/u);
  assert.match(ignoreSource, /\*\*\/body-state-unit\.backup\.json/u);
  assert.match(ignoreSource, /\*\*\/body-state-unit\.json\.initialized/u);
});

test("app records one landed user message but never a system wakeup", async () => {
  const events = [];
  const appLike = preparedAppLike(events);
  await CyberbossApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default", accountId: "acc", senderId: "user", contextToken: "ctx",
    provider: "weixin", messageId: "message-1", text: "ACTION_ALPHA",
  }, { allowCommands: true });
  await CyberbossApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default", accountId: "acc", senderId: "user", contextToken: "ctx",
    provider: "system", messageId: "system-1", text: "scheduled wakeup",
  }, { allowCommands: false });
  assert.deepEqual(events, [{ eventId: "weixin:acc:user:message-1", text: "ACTION_ALPHA" }]);
});

test("only proactive check-ins read the qualitative status without turning it into an event", async () => {
  let reads = 0;
  const appLike = {
    config: { startWithArousal: true },
    arousalService: {
      getStatusLine() {
        reads += 1;
        return "射精值：正在充能";
      },
    },
  };

  const checkin = await CyberbossApp.prototype.buildRuntimeTurn.call(appLike, {
    prepared: {
      provider: "system",
      systemKind: "checkin",
      text: "SYSTEM ACTION MODE",
    },
  });
  assert.match(checkin.text, /本地身体状态/u);
  assert.match(checkin.text, /不是必须联系用户的指令/u);
  assert.match(checkin.text, /silent 或 leave_note/u);

  const ordinarySystemTurn = await CyberbossApp.prototype.buildRuntimeTurn.call(appLike, {
    prepared: {
      provider: "system",
      systemKind: "system",
      text: "SYSTEM ACTION MODE",
    },
  });
  assert.equal(ordinarySystemTurn.text, "SYSTEM ACTION MODE");
  assert.equal(reads, 1);
});

test("disabled system performs no event writes", async () => {
  const events = [];
  const appLike = preparedAppLike(events);
  appLike.config.startWithArousal = false;
  await CyberbossApp.prototype.handlePreparedMessage.call(appLike, {
    workspaceId: "default", accountId: "acc", senderId: "user", contextToken: "ctx",
    provider: "weixin", messageId: "message-disabled", text: "ACTION_ALPHA",
  }, { allowCommands: true });
  assert.deepEqual(events, []);
});

test("local state write failure cannot block the normal chat route", async () => {
  let routed = false;
  const appLike = preparedAppLike([]);
  appLike.arousalService.recordUserFinal = () => { throw new Error("disk unavailable"); };
  appLike.routePreparedInbound = async () => { routed = true; return true; };
  const originalError = console.error;
  console.error = () => {};
  try {
    await CyberbossApp.prototype.handlePreparedMessage.call(appLike, {
      workspaceId: "default", accountId: "acc", senderId: "user", contextToken: "ctx",
      provider: "weixin", messageId: "message-disk-error", text: "ACTION_ALPHA",
    }, { allowCommands: true });
  } finally {
    console.error = originalError;
  }
  assert.equal(routed, true);
});

test("app settles only a completed assistant final, linked to its landed user", async () => {
  const assistantEvents = [];
  const appLike = runtimeEventAppLike(assistantEvents);
  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.reply.completed",
    payload: { threadId: "thread", turnId: "turn", text: "我 ACTION_ALPHA" },
  });
  await CyberbossApp.prototype.handleRuntimeEvent.call(appLike, {
    type: "runtime.turn.completed",
    payload: { threadId: "thread", turnId: "turn" },
  });
  assert.deepEqual(assistantEvents, [{
    eventId: "thread:turn:assistant-final",
    sourceUserEventId: "weixin:acc:user:message-1",
    text: "我 ACTION_ALPHA",
    complete: true,
  }]);

  const failedEvents = [];
  const failedApp = runtimeEventAppLike(failedEvents);
  await CyberbossApp.prototype.handleRuntimeEvent.call(failedApp, {
    type: "runtime.turn.failed",
    payload: { threadId: "thread", turnId: "turn", text: "failed" },
  });
  assert.deepEqual(failedEvents, []);

  const unlinkedEvents = [];
  const unlinkedApp = runtimeEventAppLike(unlinkedEvents);
  unlinkedApp.arousalSourceEventByRunKey.clear();
  await CyberbossApp.prototype.handleRuntimeEvent.call(unlinkedApp, {
    type: "runtime.reply.completed",
    payload: { threadId: "thread", turnId: "turn", text: "system wakeup reply" },
  });
  await CyberbossApp.prototype.handleRuntimeEvent.call(unlinkedApp, {
    type: "runtime.turn.completed",
    payload: { threadId: "thread", turnId: "turn" },
  });
  assert.deepEqual(unlinkedEvents, []);
});

async function startServer(snapshot, options = {}) {
  const server = new ArousalHttpServer({
    service: { getPublicSnapshot() { return snapshot; } },
    port: 0,
    logger: { error() {} },
    ...options,
  });
  await server.start();
  return server;
}

function request(server, url, headers = {}, method = "GET") {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: address.port,
      path: url,
      method,
      headers,
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          statusCode: response.statusCode,
          headers: response.headers,
          body: text ? JSON.parse(text) : null,
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function validSnapshot() {
  return {
    reserve: 1,
    reserve_label: "充足",
    phase: "idle",
    phase_label: "平静",
    refractory: false,
    last_climax_quality: null,
    last_climax_quality_label: null,
    last_output: null,
    last_output_label: null,
  };
}

function preparedAppLike(events) {
  return {
    config: { startWithArousal: true },
    runtimeAdapter: { getSessionStore: () => ({ buildBindingKey: () => "binding" }) },
    streamDelivery: { setReplyTarget() {} },
    arousalService: { recordUserFinal(value) { events.push(value); } },
    resolveWorkspaceRoot: () => "/workspace",
    prepareIncomingMessageForRuntime: async (value) => value,
    hasPendingImageInbound: () => false,
    routePreparedInbound: async () => true,
  };
}

function runtimeEventAppLike(events) {
  return {
    config: { startWithArousal: true },
    arousalSourceEventByRunKey: new Map([["thread:turn", "weixin:acc:user:message-1"]]),
    arousalFinalTextByRunKey: new Map(),
    arousalService: { recordAssistantFinal(value) { events.push(value); } },
    pendingOperationByRunKey: new Map(),
    streamDelivery: {
      async handleRuntimeEvent() {},
      resolveReplyTargetForRun() { return null; },
    },
    runtimeAdapter: {
      getSessionStore() {
        return { clearApprovalPrompt() {}, findBindingForThreadId() { return null; } };
      },
    },
    turnBoundaryScopeKeys: new Set(),
    turnGateStore: { releaseThread() {} },
    async sendFailureToThread() {},
    async flushPendingInboundMessages() {},
    async flushPendingSystemMessages() {},
    async stopTypingForThread() {},
  };
}
