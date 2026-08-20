const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AgentRoomService,
  formatAgentRoomStatus,
  normalizeLoopbackBaseUrl,
} = require("../src/services/agent-room-service");
const { CyberbossApp } = require("../src/core/app");

test("Agent Room bridge only accepts local loopback HTTP", () => {
  assert.equal(normalizeLoopbackBaseUrl("http://127.0.0.1:5178"), "http://127.0.0.1:5178/");
  assert.throws(() => normalizeLoopbackBaseUrl("https://example.com"), /回环地址/);
  assert.throws(() => normalizeLoopbackBaseUrl("http://192.168.1.8:5178"), /回环地址/);
});

test("submitTask joins, posts idempotently, then starts bounded assisted watch", async () => {
  const calls = [];
  const responses = [
    { ok: true, participant: { seatId: "seat:xi-owner" } },
    { ok: true, message: { messageId: "message-1" } },
    { ok: true, summon: { id: "summon-1", currentRound: 1, maxRounds: 6 } },
  ];
  const service = new AgentRoomService({
    baseUrl: "http://127.0.0.1:5178",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return { ok: true, json: async () => responses.shift() };
    },
  });
  const result = await service.submitTask({ text: "虚构手机工单", idempotencyKey: "wechat-room-fictional" });
  assert.equal(result.summon.id, "summon-1");
  assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
    "/api/room/join",
    "/api/message",
    "/api/summon/start",
  ]);
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    topicMessageId: "message-1",
    maxRounds: 6,
    assisted: true,
    idempotencyKey: "wechat-room-fictional:summon",
  });
});

test("status output is bounded and excludes hidden runtime fields", () => {
  const text = formatAgentRoomStatus({
    summon: { state: "waiting", currentRound: 2, maxRounds: 6 },
    duty: { active: true },
    participants: [{ seatId: "seat:engineer-local", status: "online", secret: "never" }],
    messages: [{ speaker: "agent:engineer", body: "虚构回执", tool_result: "private" }],
  });
  assert.match(text, /第 2\/6 轮/);
  assert.match(text, /陈工：虚构回执/);
  assert.doesNotMatch(text, /never|private|tool_result/);
});

test("WeChat room command sends one deterministic task and returns visible progress", async () => {
  const submitted = [];
  const replies = [];
  const appLike = {
    agentRoomService: {
      async submitTask(input) {
        submitted.push(input);
        return { summon: { currentRound: 1, maxRounds: 6 } };
      },
    },
    channelAdapter: {
      async sendText(input) { replies.push(input); },
    },
  };
  const normalized = {
    accountId: "fictional-account",
    senderId: "fictional-owner",
    messageId: "fictional-message-1",
    contextToken: "fictional-context",
  };
  await CyberbossApp.prototype.handleRoomCommand.call(appLike, normalized, { args: "虚构手机工单" });
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].text, "虚构手机工单");
  assert.match(submitted[0].idempotencyKey, /^wechat-room-[a-f0-9]{40}$/);
  assert.match(replies[0].text, /已送入 Agent Room/);
});
