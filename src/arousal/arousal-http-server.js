const http = require("http");

const PUBLIC_KEYS = [
  "reserve",
  "reserve_label",
  "phase",
  "phase_label",
  "refractory",
  "last_climax_quality",
  "last_climax_quality_label",
  "last_output",
  "last_output_label",
];
const PHASES = new Set(["refractory", "pending", "locked", "edge", "charged", "idle"]);

class ArousalHttpServer {
  constructor({ service, port = 4321, token = "", allowedOrigins = [], logger = console }) {
    this.service = service;
    this.port = port;
    this.token = String(token || "").trim();
    this.allowedOrigins = new Set(allowedOrigins.map((value) => String(value).trim()).filter(Boolean));
    this.logger = logger;
    this.server = null;
  }

  async start() {
    if (this.server) return this.address();
    this.server = http.createServer((request, response) => this.handle(request, response));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    return this.address();
  }

  async close() {
    if (!this.server) return;
    const current = this.server;
    this.server = null;
    await new Promise((resolve) => current.close(() => resolve()));
  }

  address() {
    const address = this.server?.address();
    return address && typeof address === "object" ? address : null;
  }

  handle(request, response) {
    setNoStore(response);
    const origin = String(request.headers.origin || "").trim();
    if (origin && !this.allowedOrigins.has(origin)) return sendJson(response, 403, { error: "origin_not_allowed" });
    if (origin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      if (request.headers["access-control-request-private-network"] === "true") {
        response.setHeader("Access-Control-Allow-Private-Network", "true");
      }
      return response.writeHead(204).end();
    }
    if (!this.isAuthorized(request)) return sendJson(response, 401, { error: "unauthorized" });
    if (request.method === "GET" && request.url === "/readyz") return sendJson(response, 200, { ok: true });
    if (request.method !== "GET" || request.url !== "/api/arousal/state") {
      return sendJson(response, 404, { error: "not_found" });
    }
    try {
      const snapshot = this.service.getPublicSnapshot();
      if (!isValidPublicSnapshot(snapshot)) throw new Error("invalid public snapshot");
      return sendJson(response, 200, snapshot);
    } catch (error) {
      this.logger.error?.(`[cyberboss] arousal snapshot unavailable: ${error.message}`);
      return sendJson(response, 503, { error: "state_unavailable" });
    }
  }

  isAuthorized(request) {
    if (!this.token) return true;
    const authorization = String(request.headers.authorization || "");
    return authorization === `Bearer ${this.token}`;
  }
}

function isValidPublicSnapshot(value) {
  if (!hasExactKeys(value, PUBLIC_KEYS)) return false;
  return isUnit(value.reserve)
    && typeof value.reserve_label === "string"
    && PHASES.has(value.phase)
    && typeof value.phase_label === "string"
    && typeof value.refractory === "boolean"
    && value.refractory === (value.phase === "refractory")
    && isNullableUnit(value.last_climax_quality)
    && isNullableString(value.last_climax_quality_label)
    && isNullableUnit(value.last_output)
    && isNullableString(value.last_output_label);
}

function setNoStore(response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode);
  response.end(JSON.stringify(value));
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && expected.slice().sort().every((key, index) => key === actual[index]);
}

function isUnit(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNullableUnit(value) {
  return value === null || isUnit(value);
}

function isNullableString(value) {
  return value === null || typeof value === "string";
}

module.exports = { ArousalHttpServer, PUBLIC_KEYS, isValidPublicSnapshot };
