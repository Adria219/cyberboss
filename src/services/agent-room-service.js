const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TASK_CHARS = 4_000;

class AgentRoomService {
  constructor({ baseUrl = "", fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.baseUrl = normalizeLoopbackBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Number.isFinite(timeoutMs) ? Math.max(500, Math.floor(timeoutMs)) : DEFAULT_TIMEOUT_MS;
  }

  async submitTask({ text, idempotencyKey }) {
    const task = strictText(text, "room task", MAX_TASK_CHARS);
    const key = strictText(idempotencyKey, "idempotencyKey", 120);
    await this.request("/api/room/join", { method: "POST" });
    const posted = await this.request("/api/message", {
      method: "POST",
      body: { text: task, idempotencyKey: key },
    });
    const topicMessageId = strictText(posted?.message?.messageId, "topicMessageId", 100);
    const started = await this.request("/api/summon/start", {
      method: "POST",
      body: {
        topicMessageId,
        maxRounds: 6,
        assisted: true,
        idempotencyKey: `${key}:summon`,
      },
    });
    return { message: posted.message, summon: started.summon };
  }

  getState() {
    return this.request("/api/state");
  }

  async stop() {
    const state = await this.getState();
    if (!state?.summon || state.summon.state !== "waiting") {
      return { stopped: false, summon: state?.summon || null };
    }
    const result = await this.request(`/api/summon/${encodeURIComponent(state.summon.id)}/stop`, {
      method: "POST",
    });
    return { stopped: true, summon: result.summon };
  }

  async request(pathname, { method = "GET", body } = {}) {
    if (!this.baseUrl) throw new Error("Agent Room 未配置；请设置 CYBERBOSS_AGENT_ROOM_URL");
    if (typeof this.fetchImpl !== "function") throw new Error("当前 Node 运行时不支持 fetch");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(new URL(pathname, this.baseUrl), {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(strictOptionalText(payload?.error) || `Agent Room HTTP ${response.status}`);
      }
      return payload;
    } catch (error) {
      if (error?.name === "AbortError") throw new Error("Agent Room 请求超时；请确认本机服务仍在运行");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeLoopbackBaseUrl(value) {
  const text = strictOptionalText(value);
  if (!text) return "";
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error("CYBERBOSS_AGENT_ROOM_URL 必须是合法 URL");
  }
  if (parsed.protocol !== "http:" || !LOOPBACK_HOSTS.has(parsed.hostname) || parsed.username || parsed.password) {
    throw new Error("Agent Room 只允许通过本机 HTTP 回环地址连接");
  }
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function formatAgentRoomStatus(state) {
  if (!state || typeof state !== "object") return "Agent Room 状态不可用";
  const summon = state.summon;
  const duty = state.duty;
  const participants = Array.isArray(state.participants) ? state.participants : [];
  const messages = Array.isArray(state.messages) ? state.messages.slice(-6) : [];
  const lines = [
    "Agent Room",
    `守候：${summon ? `${summon.state} · 第 ${summon.currentRound}/${summon.maxRounds} 轮` : "未开始"}`,
    `接力：${duty?.active ? "运行中" : "未运行"}`,
    `席位：${participants.map((item) => `${displaySeat(item?.seatId)} ${item?.status || "unknown"}`).join("；") || "暂无"}`,
  ];
  if (messages.length) {
    lines.push("", "最近消息：");
    for (const message of messages) lines.push(`- ${displaySpeaker(message?.speaker)}：${truncateText(message?.body, 320)}`);
  }
  return lines.join("\n");
}

function displaySeat(value) {
  if (value === "seat:evan-cloud") return "陈予安";
  if (value === "seat:engineer-local") return "陈工";
  if (value === "seat:xi-owner") return "溪";
  return strictOptionalText(value) || "未知席位";
}

function displaySpeaker(value) {
  if (value === "agent:evan") return "陈予安";
  if (value === "agent:engineer") return "陈工";
  if (value === "human:xi" || value === "xi") return "溪";
  return value === "system" ? "系统" : "席位";
}

function truncateText(value, maxLength) {
  const text = strictOptionalText(value).replace(/[\r\n]+/g, " ");
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function strictText(value, label, maxLength = 1_000) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    throw new Error(`${label} 不合法`);
  }
  return text;
}

function strictOptionalText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = { AgentRoomService, formatAgentRoomStatus, normalizeLoopbackBaseUrl };
