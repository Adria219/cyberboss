const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { resolveSelectedAccount } = require("../adapters/channel/weixin/account-store");
const { SessionStore } = require("../adapters/runtime/codex/session-store");
const { CheckinConfigStore, resolveDefaultCheckinRange } = require("../core/checkin-config-store");
const { CheckinRuntimeStore } = require("../core/checkin-runtime-store");
const { resolvePreferredSenderId, resolvePreferredWorkspaceRoot } = require("../core/default-targets");
const { SystemMessageQueueStore } = require("../core/system-message-queue-store");

const INTERNAL_CHECKIN_TRIGGER_TEMPLATE = "%USER% comes to mind again.";

async function runSystemCheckinPoller(config, {
  signal = null,
  sleepFn = sleep,
  random = Math.random,
  now = () => new Date(),
  disabledPollMs = 1_000,
  targetRetryMs = 5_000,
  skipLock = false,
} = {}) {
  const account = resolveSelectedAccount(config);
  const queue = new SystemMessageQueueStore({ filePath: config.systemMessageQueueFile });
  const checkinConfigStore = new CheckinConfigStore({ filePath: config.checkinConfigFile });
  const stateDir = normalizeText(config.stateDir) || path.dirname(config.checkinConfigFile);
  const runtimeStore = new CheckinRuntimeStore({
    filePath: config.checkinRuntimeFile || path.join(stateDir, "checkin-runtime.json"),
  });
  const sessionStore = new SessionStore({ filePath: config.sessionsFile });
  const defaultRange = resolveDefaultCheckinRange();
  const defaultEnabled = Boolean(config.startWithCheckin);
  let releaseLock = () => {};

  if (!skipLock) {
    try {
      releaseLock = acquirePollerLock(
        config.checkinPollerLockFile || path.join(stateDir, "checkin-poller.lock")
      );
    } catch (error) {
      throw error;
    }
  }

  console.log("[cyberboss] checkin poller ready");

  try {
    while (!signal?.aborted) {
      const enabled = checkinConfigStore.getEnabled(defaultEnabled);
      if (!enabled) {
        runtimeStore.setScheduler({
          enabled: false,
          pollerStatus: "disabled",
          nextWakeAt: "",
          errorCode: "",
        });
        await sleepInterruptibly(disabledPollMs, { signal, sleepFn });
        continue;
      }

      let target;
      try {
        target = resolvePollerTarget({ config, account, sessionStore });
      } catch (error) {
        runtimeStore.setScheduler({
          enabled: true,
          pollerStatus: "error",
          errorCode: "target_unavailable",
        });
        console.error(`[cyberboss] checkin target unavailable: ${error.message}`);
        await sleepInterruptibly(targetRetryMs, { signal, sleepFn });
        continue;
      }

      const currentRange = checkinConfigStore.getRange(defaultRange);
      const delayMs = pickRandomDelayMs(currentRange.minIntervalMs, currentRange.maxIntervalMs, random);
      const currentTime = now();
      const wakeAt = new Date(currentTime.getTime() + delayMs).toISOString();
      runtimeStore.setScheduler({
        enabled: true,
        pollerStatus: "waiting",
        senderId: target.senderId,
        workspaceRoot: target.workspaceRoot,
        nextWakeAt: wakeAt,
        errorCode: "",
      });
      console.log(`[cyberboss] next checkin in ${Math.round(delayMs / 60000)}m at ${formatLocalTime(wakeAt)}`);
      const stillEnabled = await waitForEnabledDelay(delayMs, {
        signal,
        sleepFn,
        isEnabled: () => checkinConfigStore.getEnabled(defaultEnabled),
      });
      if (!stillEnabled || signal?.aborted) {
        runtimeStore.setScheduler({
          enabled: false,
          pollerStatus: "disabled",
          nextWakeAt: "",
          errorCode: "",
        });
        continue;
      }

      if (queue.hasPendingForAccount(account.accountId)) {
        runtimeStore.setScheduler({
          enabled: true,
          pollerStatus: "ready",
          senderId: target.senderId,
          workspaceRoot: target.workspaceRoot,
          errorCode: "queue_busy",
        });
        console.log("[cyberboss] checkin skipped: pending system message still in queue");
        continue;
      }

      const queuedAt = now().toISOString();
      const queued = queue.enqueue({
        id: crypto.randomUUID(),
        accountId: account.accountId,
        senderId: target.senderId,
        workspaceRoot: target.workspaceRoot,
        text: buildCheckinTrigger(config),
        kind: "checkin",
        createdAt: queuedAt,
      });
      runtimeStore.markQueued({
        runId: queued.id,
        senderId: target.senderId,
        workspaceRoot: target.workspaceRoot,
        queuedAt,
      });
      console.log(`[cyberboss] checkin queued id=${queued.id}`);
    }
  } finally {
    releaseLock();
  }
}

function resolvePollerTarget({ config, account, sessionStore }) {
  const senderId = resolvePreferredSenderId({
    config,
    accountId: account.accountId,
    explicitUser: process.env.CYBERBOSS_CHECKIN_USER_ID || "",
    sessionStore,
  });
  const workspaceRoot = resolvePreferredWorkspaceRoot({
    config,
    accountId: account.accountId,
    senderId,
    explicitWorkspace: process.env.CYBERBOSS_CHECKIN_WORKSPACE || "",
    sessionStore,
  });

  if (!senderId) {
    throw new Error("Cannot determine the WeChat user for the checkin poller. Set CYBERBOSS_CHECKIN_USER_ID or let the only active user talk to the bot once first.");
  }
  if (!workspaceRoot) {
    throw new Error("Cannot determine the workspace for the checkin poller. Set CYBERBOSS_WORKSPACE_ROOT first.");
  }

  return { senderId, workspaceRoot };
}

function pickRandomDelayMs(minIntervalMs, maxIntervalMs, random = Math.random) {
  if (maxIntervalMs <= minIntervalMs) {
    return minIntervalMs;
  }
  return minIntervalMs + Math.floor(random() * (maxIntervalMs - minIntervalMs + 1));
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEnabledDelay(delayMs, { signal = null, sleepFn = sleep, isEnabled }) {
  let remainingMs = Math.max(0, delayMs);
  while (remainingMs > 0 && !signal?.aborted) {
    if (!isEnabled()) {
      return false;
    }
    const sliceMs = Math.min(1_000, remainingMs);
    await sleepFn(sliceMs);
    remainingMs -= sliceMs;
  }
  return !signal?.aborted && isEnabled();
}

async function sleepInterruptibly(delayMs, { signal = null, sleepFn = sleep }) {
  let remainingMs = Math.max(0, delayMs);
  while (remainingMs > 0 && !signal?.aborted) {
    const sliceMs = Math.min(1_000, remainingMs);
    await sleepFn(sliceMs);
    remainingMs -= sliceMs;
  }
}

function acquirePollerLock(filePath) {
  const normalizedPath = normalizeText(filePath);
  if (!normalizedPath) {
    return () => {};
  }
  fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(normalizedPath, "wx");
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          const ownerPid = Number.parseInt(fs.readFileSync(normalizedPath, "utf8"), 10);
          if (ownerPid === process.pid) fs.unlinkSync(normalizedPath);
        } catch {}
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const ownerPid = readLockPid(normalizedPath);
      if (ownerPid && isProcessRunning(ownerPid)) {
        throw new Error(`checkin poller already running pid=${ownerPid}`);
      }
      try {
        fs.unlinkSync(normalizedPath);
      } catch {}
    }
  }
  throw new Error("checkin poller lock could not be acquired");
}

function readLockPid(filePath) {
  try {
    const parsed = Number.parseInt(fs.readFileSync(filePath, "utf8"), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function formatLocalTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value || "");
  }
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date).replace(/\//g, "-");
}

function formatRangeMinutes(range) {
  return `${Math.round(range.minIntervalMs / 60000)}m-${Math.round(range.maxIntervalMs / 60000)}m`;
}

function buildCheckinTrigger(config) {
  const userName = normalizeText(config?.userName) || "the user";
  return INTERNAL_CHECKIN_TRIGGER_TEMPLATE.replace("%USER%", userName);
}

module.exports = {
  runSystemCheckinPoller,
  resolvePollerTarget,
  pickRandomDelayMs,
  waitForEnabledDelay,
  acquirePollerLock,
};
