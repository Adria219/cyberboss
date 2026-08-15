const fs = require("fs");
const path = require("path");

function resolveCodexProjectToolMcpServerConfig({
  cyberbossHome = "",
  enabled = readBoolEnv("CYBERBOSS_ENABLE_PROJECT_TOOLS"),
} = {}) {
  if (!enabled) return null;
  const home = normalizeNonEmptyString(cyberbossHome)
    || process.env.CYBERBOSS_HOME
    || path.resolve(__dirname, "..", "..", "..", "..");
  const scriptPath = path.join(home, "bin", "cyberboss.js");
  if (!fs.existsSync(scriptPath)) {
    return null;
  }
  return {
    name: "cyberboss_tools",
    command: process.execPath,
    args: [scriptPath, "tool-mcp-server", "--runtime-id", "codex"],
  };
}

function buildCodexMcpConfigArgs(mcpServerConfig, {
  autoApproveTools = readListEnv("CYBERBOSS_AUTO_APPROVE_PROJECT_TOOLS"),
} = {}) {
  if (!mcpServerConfig || typeof mcpServerConfig !== "object") {
    return [];
  }
  const name = normalizeNonEmptyString(mcpServerConfig.name) || "cyberboss_tools";
  const command = normalizeNonEmptyString(mcpServerConfig.command);
  const args = Array.isArray(mcpServerConfig.args)
    ? mcpServerConfig.args.map((value) => normalizeNonEmptyString(value)).filter(Boolean)
    : [];
  if (!command) {
    return [];
  }
  const configArgs = [
    "-c",
    `mcp_servers.${name}.command=${quoteTomlString(command)}`,
    "-c",
    `mcp_servers.${name}.args=${formatTomlArray(args)}`,
  ];
  const { listProjectToolNames } = require("../../../tools/tool-host");
  const knownTools = new Set(listProjectToolNames());
  for (const toolName of normalizeToolNames(autoApproveTools)) {
    if (!knownTools.has(toolName)) {
      throw new Error(`Unknown Cyberboss project tool in auto-approve list: ${toolName}`);
    }
    configArgs.push(
      "-c",
      `mcp_servers.${name}.tools.${toolName}.approval_mode=${quoteTomlString("auto")}`,
    );
  }
  return configArgs;
}

function buildRemoteMcpConfigArgs({ name, url, bearerTokenEnvVar, autoApproveTools = [] } = {}) {
  const normalizedName = normalizeIdentifier(name);
  const normalizedUrl = normalizeNonEmptyString(url);
  const normalizedTokenEnv = normalizeIdentifier(bearerTokenEnvVar);
  if (!normalizedUrl && !normalizedTokenEnv) return [];
  if (!normalizedName || !normalizedUrl || !normalizedTokenEnv) {
    throw new Error("Remote MCP config requires name, url, and bearerTokenEnvVar together.");
  }
  const configArgs = [
    "-c",
    `mcp_servers.${normalizedName}.url=${quoteTomlString(normalizedUrl)}`,
    "-c",
    `mcp_servers.${normalizedName}.bearer_token_env_var=${quoteTomlString(normalizedTokenEnv)}`,
  ];
  for (const toolName of normalizeToolNames(autoApproveTools)) {
    configArgs.push(
      "-c",
      `mcp_servers.${normalizedName}.tools.${toolName}.approval_mode=${quoteTomlString("auto")}`,
    );
  }
  return configArgs;
}

function quoteTomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function formatTomlArray(values) {
  return `[${values.map((value) => quoteTomlString(value)).join(",")}]`;
}

function normalizeNonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function normalizeIdentifier(value) {
  const normalized = normalizeNonEmptyString(value);
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(normalized) ? normalized : "";
}

function normalizeToolNames(values) {
  const list = Array.isArray(values) ? values : [];
  return [...new Set(list.map((value) => normalizeIdentifier(value)).filter(Boolean))];
}

function readListEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function readBoolEnv(name) {
  const value = normalizeNonEmptyString(process.env[name]).toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

module.exports = {
  buildCodexMcpConfigArgs,
  buildRemoteMcpConfigArgs,
  resolveCodexProjectToolMcpServerConfig,
};
