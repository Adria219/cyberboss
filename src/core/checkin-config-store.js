const fs = require("fs");
const path = require("path");

const DEFAULT_MIN_INTERVAL_MS = 3 * 60_000;
const DEFAULT_MAX_INTERVAL_MS = 60 * 60_000;

class CheckinConfigStore {
  constructor({ filePath }) {
    this.filePath = filePath;
    this.state = {};
    this.ensureParentDirectory();
    this.load();
  }

  ensureParentDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      this.state = normalizePersistedRange(parsed) || {};
    } catch {
      this.state = {};
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  getRange(fallbackRange = resolveDefaultCheckinRange()) {
    this.load();
    return normalizeIntervalRange(this.state, fallbackRange);
  }

  setRange(range) {
    const normalized = normalizeIntervalRange(range);
    this.state = normalized;
    this.save();
    return { ...normalized };
  }
}

function resolveDefaultCheckinRange(env = process.env) {
  const minIntervalMs = readIntervalMs(env?.CYBERBOSS_CHECKIN_MIN_INTERVAL_MS, DEFAULT_MIN_INTERVAL_MS);
  const maxIntervalMs = Math.max(
    minIntervalMs,
    readIntervalMs(env?.CYBERBOSS_CHECKIN_MAX_INTERVAL_MS, DEFAULT_MAX_INTERVAL_MS)
  );
  return { minIntervalMs, maxIntervalMs };
}

function parseCheckinRangeMinutes(input) {
  const normalized = typeof input === "string" ? input.trim() : "";
  const match = normalized.match(/^(\d+)\s*-\s*(\d+)$/);
  if (!match) {
    return null;
  }
  const minMinutes = Number.parseInt(match[1], 10);
  const maxMinutes = Number.parseInt(match[2], 10);
  if (!Number.isFinite(minMinutes) || !Number.isFinite(maxMinutes) || minMinutes <= 0 || maxMinutes <= 0 || maxMinutes < minMinutes) {
    return null;
  }
  return { minMinutes, maxMinutes };
}

function parseQuietHours(input) {
  const normalized = typeof input === "string" ? input.trim() : "";
  const match = normalized.match(/^(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const startHour = Number.parseInt(match[1], 10);
  const startMinute = Number.parseInt(match[2], 10);
  const endHour = Number.parseInt(match[3], 10);
  const endMinute = Number.parseInt(match[4], 10);
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) {
    return null;
  }
  const startMinuteOfDay = startHour * 60 + startMinute;
  const endMinuteOfDay = endHour * 60 + endMinute;
  if (startMinuteOfDay === endMinuteOfDay) {
    return null;
  }
  return { startMinuteOfDay, endMinuteOfDay };
}

function isWithinQuietHours(value, quietHours, timeZone = "Asia/Shanghai") {
  const window = typeof quietHours === "string" ? parseQuietHours(quietHours) : quietHours;
  const date = value instanceof Date ? value : new Date(value);
  if (!window || Number.isNaN(date.getTime())) {
    return false;
  }
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number.parseInt(parts.find((part) => part.type === "hour")?.value || "", 10);
  const minute = Number.parseInt(parts.find((part) => part.type === "minute")?.value || "", 10);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return false;
  }
  const minuteOfDay = hour * 60 + minute;
  if (window.startMinuteOfDay < window.endMinuteOfDay) {
    return minuteOfDay >= window.startMinuteOfDay && minuteOfDay < window.endMinuteOfDay;
  }
  return minuteOfDay >= window.startMinuteOfDay || minuteOfDay < window.endMinuteOfDay;
}

function normalizePersistedRange(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const minIntervalMs = normalizePositiveInteger(value.minIntervalMs);
  const maxIntervalMs = normalizePositiveInteger(value.maxIntervalMs);
  if (!minIntervalMs || !maxIntervalMs) {
    return null;
  }
  return {
    minIntervalMs,
    maxIntervalMs: Math.max(minIntervalMs, maxIntervalMs),
  };
}

function normalizeIntervalRange(value, fallbackRange = resolveDefaultCheckinRange()) {
  const fallback = normalizePersistedRange(fallbackRange) || {
    minIntervalMs: DEFAULT_MIN_INTERVAL_MS,
    maxIntervalMs: DEFAULT_MAX_INTERVAL_MS,
  };
  const normalized = normalizePersistedRange(value);
  return normalized || fallback;
}

function normalizePositiveInteger(value) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function readIntervalMs(rawValue, fallback) {
  const parsed = Number.parseInt(String(rawValue || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

module.exports = {
  CheckinConfigStore,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_MAX_INTERVAL_MS,
  parseCheckinRangeMinutes,
  parseQuietHours,
  isWithinQuietHours,
  resolveDefaultCheckinRange,
};
