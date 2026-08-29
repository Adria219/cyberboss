const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  CheckinConfigStore,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_MAX_INTERVAL_MS,
  isWithinQuietHours,
  parseCheckinRangeMinutes,
  parseQuietHours,
  resolveQuietHours,
} = require("../src/core/checkin-config-store");
const { CheckinRuntimeStore } = require("../src/core/checkin-runtime-store");
const { acquirePollerLock, waitForEnabledDelay } = require("../src/app/system-checkin-poller");
const { CyberbossApp } = require("../src/core/app");

function createStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-checkin-test-"));
  return new CheckinConfigStore({ filePath: path.join(dir, "checkin-config.json") });
}

test("parseCheckinRangeMinutes accepts min-max minute ranges", () => {
  assert.deepEqual(parseCheckinRangeMinutes("7-21"), { minMinutes: 7, maxMinutes: 21 });
  assert.deepEqual(parseCheckinRangeMinutes("5 - 10"), { minMinutes: 5, maxMinutes: 10 });
  assert.equal(parseCheckinRangeMinutes("10-3"), null);
  assert.equal(parseCheckinRangeMinutes("abc"), null);
});

test("quiet hours support an overnight Asia/Shanghai window", () => {
  assert.deepEqual(parseQuietHours("23:00-08:00"), {
    startMinuteOfDay: 23 * 60,
    endMinuteOfDay: 8 * 60,
  });
  assert.equal(parseQuietHours("24:00-08:00"), null);
  assert.equal(parseQuietHours("08:00-08:00"), null);
  assert.equal(isWithinQuietHours("2026-08-29T15:30:00.000Z", "23:00-08:00"), true);
  assert.equal(isWithinQuietHours("2026-08-30T00:30:00.000Z", "23:00-08:00"), false);
});

test("invalid quiet hours warn and fall back to the safe default", () => {
  const warnings = [];
  const resolved = resolveQuietHours("9:00~17:00", {
    warn(message) {
      warnings.push(message);
    },
  });

  assert.deepEqual(resolved, {
    startMinuteOfDay: 23 * 60,
    endMinuteOfDay: 8 * 60,
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /invalid CYBERBOSS_CHECKIN_QUIET_HOURS/);
  assert.equal(isWithinQuietHours("2026-08-29T15:30:00.000Z", resolved), true);
});

test("checkin config store falls back to defaults and persists overrides", () => {
  const store = createStore();
  assert.deepEqual(store.getRange(), {
    minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
    maxIntervalMs: DEFAULT_MAX_INTERVAL_MS,
  });
  store.setRange({ minIntervalMs: 4 * 60_000, maxIntervalMs: 25 * 60_000 });
  assert.deepEqual(store.getRange(), {
    minIntervalMs: 4 * 60_000,
    maxIntervalMs: 25 * 60_000,
  });
  store.setEnabled(false);
  assert.equal(store.getEnabled(true), false);
  assert.deepEqual(store.getRange(), {
    minIntervalMs: 4 * 60_000,
    maxIntervalMs: 25 * 60_000,
  });
});

test("checkin runtime store keeps only bounded operational receipts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-checkin-runtime-test-"));
  const store = new CheckinRuntimeStore({ filePath: path.join(dir, "runtime.json") });
  store.setScheduler({
    enabled: true,
    pollerStatus: "waiting",
    senderId: "user-123456789",
    workspaceRoot: "C:/workspace",
    nextWakeAt: "2026-08-29T12:00:00.000Z",
  });
  const toggled = store.setScheduler({ enabled: false, pollerStatus: "disabled", nextWakeAt: "" });
  assert.equal(toggled.senderId, "user-123456789");
  assert.equal(toggled.workspaceRoot, "C:/workspace");
  store.markQueued({
    runId: "run-1",
    senderId: "user-123456789",
    workspaceRoot: "C:/workspace",
    queuedAt: "2026-08-29T12:00:00.000Z",
    text: "must not persist",
  });
  store.markDispatched({ runId: "run-1", threadId: "thread-1", dispatchedAt: "2026-08-29T12:00:01.000Z" });
  const completed = store.completeRun({
    runId: "run-1",
    action: "leave_note",
    outcome: "held",
    completedAt: "2026-08-29T12:00:02.000Z",
    message: "must not persist",
  });
  assert.equal(completed.lastRun.action, "leave_note");
  assert.equal(completed.lastRun.outcome, "held");
  assert.equal(JSON.stringify(completed).includes("must not persist"), false);
});

test("checkin delay stops promptly when the persisted switch turns off", async () => {
  let enabled = true;
  let sleeps = 0;
  const completed = await waitForEnabledDelay(5_000, {
    isEnabled: () => enabled,
    async sleepFn() {
      sleeps += 1;
      enabled = false;
    },
  });
  assert.equal(completed, false);
  assert.equal(sleeps, 1);
});

test("checkin poller lock rejects a second local scheduler", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-checkin-lock-test-"));
  const lockPath = path.join(dir, "poller.lock");
  const release = acquirePollerLock(lockPath);
  assert.throws(() => acquirePollerLock(lockPath), /already running/);
  release();
  assert.equal(fs.existsSync(lockPath), false);
});

test("handleCheckinCommand stores the new range and replies in English", async () => {
  const sent = [];
  const store = createStore();
  const appLike = {
    checkinConfigStore: store,
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
      },
    },
  };

  await CyberbossApp.prototype.handleCheckinCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, {
    args: "7-21",
  });

  assert.deepEqual(store.getRange(), {
    minIntervalMs: 7 * 60_000,
    maxIntervalMs: 21 * 60_000,
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, "✅ Check-in interval reset to 7-21 minutes and will apply on the next polling cycle.");
});

test("handleCheckinCommand exposes persistent on off and status controls", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyberboss-checkin-command-test-"));
  const sent = [];
  const configStore = new CheckinConfigStore({ filePath: path.join(dir, "config.json") });
  const runtimeStore = new CheckinRuntimeStore({ filePath: path.join(dir, "runtime.json") });
  const appLike = {
    config: { startWithCheckin: false },
    activeAccountId: "account-1",
    checkinConfigStore: configStore,
    checkinRuntimeStore: runtimeStore,
    deferredSystemReplyQueue: {
      countForSender() {
        return 2;
      },
    },
    channelAdapter: {
      async sendText(payload) {
        sent.push(payload);
      },
    },
  };
  const message = { senderId: "user-123456789", contextToken: "ctx-1" };

  await CyberbossApp.prototype.handleCheckinCommand.call(appLike, message, { args: "on" });
  assert.equal(configStore.getEnabled(false), true);
  runtimeStore.setScheduler({
    enabled: true,
    pollerStatus: "ready",
    senderId: "user-123456789",
    workspaceRoot: "E:\\Projects\\secret-project",
    errorCode: "queue_busy",
  });
  await CyberbossApp.prototype.handleCheckinCommand.call(appLike, message, { args: "status" });
  assert.match(sent[1].text, /主动唤醒：开启/);
  assert.match(sent[1].text, /user…6789 · secret-project/);
  assert.match(sent[1].text, /待安排（上一条仍在队列）/);
  assert.doesNotMatch(sent[1].text, /E:\\Projects/);
  assert.match(sent[1].text, /未寄留言：2 条/);
  await CyberbossApp.prototype.handleCheckinCommand.call(appLike, message, { args: "off" });
  assert.equal(configStore.getEnabled(true), false);
});

test("handleChunkCommand reports current value and persists updates through the channel adapter", async () => {
  const sent = [];
  let minChunk = 20;
  const appLike = {
    channelAdapter: {
      getMinChunkChars() {
        return minChunk;
      },
      setMinChunkChars(value) {
        minChunk = value;
        return minChunk;
      },
      async sendText(payload) {
        sent.push(payload);
      },
    },
  };

  await CyberbossApp.prototype.handleChunkCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, {
    args: "",
  });
  await CyberbossApp.prototype.handleChunkCommand.call(appLike, {
    senderId: "user-1",
    contextToken: "ctx-1",
  }, {
    args: "50",
  });

  assert.equal(sent[0].text, "💡 Current minimum merge chunk is 20 characters. Usage: /chunk <number> (e.g. /chunk 50)");
  assert.equal(sent[1].text, "✅ Minimum merge chunk set to 50 characters. Shorter fragments will be merged into one message up to this size.");
  assert.equal(minChunk, 50);
});
