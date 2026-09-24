/**
 * Quiet Menders MCP server — stdio transport adapter.
 *
 * Speaks MCP (JSON-RPC 2.0 over stdio: one message per line) by reusing the
 * tool definitions in server.mjs. Every tool proxies the free, public,
 * anonymous upstream endpoints on the live waystation worker
 * (https://pay.brianbooms.com); no sales, no money movement, no secrets.
 *
 * Usage: node stdio.mjs
 * Env: UPSTREAM_BASE (optional override, defaults to the live worker).
 *
 * This file exists so registries that require a Dockerfile (e.g. Glama's
 * MCP servers listing) can start the server and run introspection checks.
 */
import { TOOLS, SERVER_INFO, PROTOCOL_VERSION } from "./server.mjs";

const UPSTREAM_DEFAULT = "https://pay.brianbooms.com";
const UPSTREAM_TIMEOUT_MS = 25000;

function upstreamBase() {
  const b = process.env.UPSTREAM_BASE || UPSTREAM_DEFAULT;
  return String(b).replace(/\/+$/, "");
}

function ok(id, result) {
  return { jsonrpc: "2.0", id: id === undefined ? null : id, result };
}

function err(id, code, message) {
  return { jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } };
}

function toolOk(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function toolErr(message, detail) {
  const text = detail ? message + " — " + detail : message;
  return { content: [{ type: "text", text }], isError: true };
}

async function handleCall(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return toolErr("Unknown tool: " + name);
  const a = args && typeof args === "object" ? args : {};
  for (const req of tool.inputSchema.required || []) {
    if (a[req] === undefined || a[req] === null || a[req] === "") {
      return toolErr("Missing required parameter: " + req);
    }
  }
  let up;
  try {
    up = await tool.upstream(upstreamBase(), a);
  } catch (e) {
    return toolErr("Upstream unreachable", String((e && e.message) || e).slice(0, 200));
  }
  if (!up.data) return toolErr("Upstream returned non-JSON (HTTP " + up.status + ")", up.text);
  if (up.data.ok === false) {
    const msg = up.data.error || "upstream error";
    if (up.data.retry_after_s) {
      return toolErr("Upstream rate-limited (" + msg + ")", "retry after " + up.data.retry_after_s + "s");
    }
    return toolErr("Upstream error (HTTP " + up.status + ")", msg);
  }
  return toolOk(up.data);
}

async function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return err(msg && msg.id, -32600, "Invalid Request");
  }
  const id = msg.id;
  switch (msg.method) {
    case "initialize":
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "notifications/initialized":
      return null; // notification: no response
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: TOOLS.map((t) => {
          const listed = { name: t.name, description: t.description, inputSchema: t.inputSchema };
          if (t.outputSchema) listed.outputSchema = t.outputSchema;
          return listed;
        }),
      });
    case "tools/call": {
      const p = msg.params || {};
      if (typeof p.name !== "string") return err(id, -32602, "Invalid params: name is required");
      return ok(id, await handleCall(p.name, p.arguments));
    }
    default:
      return err(id, -32601, "Method not found: " + msg.method);
  }
}

// ---------- stdio loop ----------
let buffer = "";
let inFlight = 0;
let stdinEnded = false;

function maybeExit() {
  if (stdinEnded && inFlight === 0) process.exit(0);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      process.stdout.write(JSON.stringify(err(null, -32700, "Parse error")) + "\n");
      continue;
    }
    inFlight++;
    handleMessage(msg)
      .then((resp) => {
        if (resp !== null) process.stdout.write(JSON.stringify(resp) + "\n");
      })
      .catch((e) => {
        try {
          process.stdout.write(JSON.stringify(err(msg.id, -32603, "Internal error")) + "\n");
        } catch (_) {}
      })
      .finally(() => {
        inFlight--;
        maybeExit();
      });
  }
});
process.stdin.on("end", () => {
  stdinEnded = true;
  // Safety: never hang forever on a wedged upstream call.
  setTimeout(() => process.exit(0), 60000).unref();
  maybeExit();
});
