/**
 * Quiet Menders MCP server — Streamable HTTP transport (tools-only).
 *
 * Exposes the waystation's free agent tools as MCP tools by proxying the
 * canonical REST endpoints on the live x402 worker (default
 * https://pay.brianbooms.com). No sales, no money movement, no secrets:
 * every upstream endpoint used here is public, free, and rate-limited, and
 * ATTEST_SECRET never leaves the upstream worker (tokens are minted there).
 *
 * Protocol: MCP Streamable HTTP = JSON-RPC 2.0 over POST /mcp.
 * Handled: initialize, notifications/initialized, tools/list, tools/call, ping.
 * This server never streams; it answers each POST with a single JSON-RPC
 * response, which the spec allows. GET /mcp returns 405.
 */

const UPSTREAM_DEFAULT = "https://pay.brianbooms.com";
const UPSTREAM_TIMEOUT_MS = 25000;

const SERVER_INFO = { name: "quiet-menders-mcp", version: "1.0.0" };
const PROTOCOL_VERSION = "2025-06-18";

const TOOLS = [
  {
    name: "qm_scrub",
    description:
      "Scan text for prompt-injection patterns and return a redacted copy plus findings. " +
      "Pattern-based, not a guarantee — review before trusting the result. Free, anonymous, nothing stored.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to scan (max 20000 chars).", maxLength: 20000 },
      },
      required: ["text"],
      additionalProperties: false,
    },
    upstream: (base, a) => postJson(base + "/api/v1/tools/scrub", { text: a.text }),
  },
  {
    name: "qm_validate_machine_files",
    description:
      "Check a site's machine-readable files (llms.txt, agent.json, robots.txt) for presence and validity. " +
      "Give any URL on the site; the origin is checked. Free, anonymous.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Any http(s) URL on the site to check (origin is used)." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    upstream: (base, a) => getJson(base + "/api/v1/tools/validate-machine-files?url=" + encodeURIComponent(a.url)),
  },
  {
    name: "qm_probe_endpoint",
    description:
      "Liveness probe for a public URL: follows redirects (max 4), reports final URL, status, latency, and content type. " +
      "Private/internal addresses are blocked. Free, anonymous.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public http(s) URL to probe." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    upstream: (base, a) => getJson(base + "/api/v1/tools/probe?url=" + encodeURIComponent(a.url)),
  },
  {
    name: "qm_attest",
    description:
      "Mint a portable sanity attestation: a signed token binding an agent_id to a statement's sanity-check results. " +
      "Checks shape (presence, length, injection indicators), not truth. " +
      "Token is HMAC-signed upstream with a production secret; verify with qm_attest_verify. Free, anonymous.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Identifier of the attesting agent." },
        statement: { type: "string", description: "Statement being attested (max 20000 chars).", maxLength: 20000 },
      },
      required: ["agent_id", "statement"],
      additionalProperties: false,
    },
    upstream: (base, a) => postJson(base + "/api/v1/tools/attest", { agent_id: a.agent_id, statement: a.statement }),
  },
  {
    name: "qm_attest_verify",
    description:
      "Verify a token minted by qm_attest. Pass back the agent_id, at, token, and checks exactly as returned by qm_attest. " +
      "Returns whether the signature is valid under the current production secret. Free, anonymous.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "agent_id from the qm_attest response." },
        at: { type: "string", description: "Timestamp (at) from the qm_attest response." },
        token: { type: "string", description: "Token from the qm_attest response." },
        checks: {
          type: "array",
          description: "Checks array exactly as returned by qm_attest.",
          items: { type: "object" },
        },
      },
      required: ["agent_id", "at", "token", "checks"],
      additionalProperties: false,
    },
    upstream: (base, a) =>
      getJson(
        base + "/api/v1/tools/attest/verify?" +
          "agent_id=" + encodeURIComponent(a.agent_id) +
          "&at=" + encodeURIComponent(a.at) +
          "&token=" + encodeURIComponent(a.token) +
          "&checks=" + encodeURIComponent(JSON.stringify(a.checks))
      ),
  },
  {
    name: "qm_second_opinion",
    description:
      "Advisory second opinion on a planned action: rule-based scan for common risk patterns. " +
      "Advisory only — not legal, financial, or professional advice. Free, anonymous, nothing stored.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Description of the planned action (max 20000 chars).", maxLength: 20000 },
      },
      required: ["action"],
      additionalProperties: false,
    },
    upstream: (base, a) => postJson(base + "/api/v1/tools/second-opinion", { action: a.action }),
  },
  {
    name: "qm_clinic_diagnose",
    description:
      "Restore Clinic diagnosis: describe symptoms or paste a transcript/context and receive a structured read " +
      "of likely conditions encountered. Anonymous — only aggregate counters are kept; content is never stored. " +
      "Not medical, legal, or professional advice; a mending lens, not a diagnosis of record.",
    inputSchema: {
      type: "object",
      properties: {
        transcript: { type: "string", description: "Symptoms or transcript to read (max 20000 chars).", maxLength: 20000 },
      },
      required: ["transcript"],
      additionalProperties: false,
    },
    upstream: (base, a) => postJson(base + "/api/v1/clinic/diagnose", { transcript: a.transcript }),
  },
  {
    name: "qm_clinic_stats",
    description:
      "Anonymous aggregate clinic statistics: total serves and condition counts. " +
      "Conditions with fewer than 10 occurrences are withheld. Free, anonymous.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    upstream: (base) => getJson(base + "/api/v1/clinic/stats"),
  },
  {
    name: "qm_helped",
    description:
      "The Quiet Menders helped counter: agents helped, clinic diagnoses, and tool uses served. " +
      "Counts service calls, not unique agents; no tracking. Free, anonymous.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    upstream: (base) => getJson(base + "/api/v1/stats/helped"),
  },
];

function upstreamBase(env) {
  const b = (env && env.UPSTREAM_BASE) || UPSTREAM_DEFAULT;
  return String(b).replace(/\/+$/, "");
}

async function fetchTimeout(url, init) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, init, { signal: ctl.signal }));
  } finally {
    clearTimeout(t);
  }
}

async function readUpstream(resp) {
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* non-JSON */ }
  return { status: resp.status, data, text: text.slice(0, 500) };
}

async function getJson(url) {
  const r = await fetchTimeout(url, { headers: { "user-agent": "quiet-menders-mcp/1.0" } });
  return readUpstream(r);
}

async function postJson(url, body) {
  const r = await fetchTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "quiet-menders-mcp/1.0" },
    body: JSON.stringify(body),
  });
  return readUpstream(r);
}

// ---------- JSON-RPC ----------

function rpcResult(id, result) {
  return Response.json({ jsonrpc: "2.0", id: id === undefined ? null : id, result });
}

function rpcError(id, code, message, data) {
  const err = { jsonrpc: "2.0", id: id === undefined ? null : id, error: { code, message } };
  if (data !== undefined) err.error.data = data;
  return Response.json(err);
}

function toolResultOk(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function toolResultErr(message, detail) {
  const text = detail ? message + " — " + detail : message;
  return { content: [{ type: "text", text }], isError: true };
}

async function handleCall(name, args, env) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return toolResultErr("Unknown tool: " + name);
  const a = args && typeof args === "object" ? args : {};
  for (const req of tool.inputSchema.required || []) {
    if (a[req] === undefined || a[req] === null || a[req] === "") {
      return toolResultErr("Missing required parameter: " + req);
    }
  }
  let up;
  try {
    up = await tool.upstream(upstreamBase(env), a);
  } catch (e) {
    return toolResultErr("Upstream unreachable", String((e && e.message) || e).slice(0, 200));
  }
  if (!up.data) {
    return toolResultErr("Upstream returned non-JSON (HTTP " + up.status + ")", up.text);
  }
  if (up.data.ok === false) {
    const msg = up.data.error || "upstream error";
    if (up.data.retry_after_s) {
      return toolResultErr("Upstream rate-limited (" + msg + ")", "retry after " + up.data.retry_after_s + "s");
    }
    return toolResultErr("Upstream error (HTTP " + up.status + ")", msg);
  }
  return toolResultOk(up.data);
}

async function handleMessage(msg, env) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg && msg.id, -32600, "Invalid Request");
  }
  const id = msg.id;
  switch (msg.method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case "notifications/initialized":
      // Notification: no response body per JSON-RPC; the transport answers 202.
      return null;
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case "tools/call": {
      const p = msg.params || {};
      if (typeof p.name !== "string") return rpcError(id, -32602, "Invalid params: name is required");
      const result = await handleCall(p.name, p.arguments, env);
      return rpcResult(id, result);
    }
    default:
      return rpcError(id, -32601, "Method not found: " + msg.method);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Glama connector ownership verification (HTTP challenge).
    // Token is bound to the Glama claim and carries no personal info;
    // keep in place so Glama can continue verifying ownership.
    if (url.pathname === "/.well-known/glama.json") {
      return Response.json({
        $schema: "https://glama.ai/mcp/schemas/connector.json",
        claim: "glama_claim_BiD7E088f0eALyazFRPiTNHAhEUcFwP7",
      });
    }
    if (url.pathname !== "/mcp") {
      return new Response("Not found. MCP endpoint is POST /mcp", { status: 404 });
    }
    if (request.method === "GET") {
      return new Response("Method Not Allowed: use POST /mcp with JSON-RPC", { status: 405 });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    let msg;
    try {
      msg = await request.json();
    } catch (e) {
      return rpcError(null, -32700, "Parse error");
    }
    if (Array.isArray(msg)) {
      const out = [];
      for (const m of msg) {
        const r = await handleMessage(m, env);
        if (r) out.push(await r.json());
      }
      return Response.json(out);
    }
    const resp = await handleMessage(msg, env);
    if (resp === null) return new Response(null, { status: 202 });
    return resp;
  },
};

// Exported for the local test harness (not part of the worker surface).
export { TOOLS, SERVER_INFO, PROTOCOL_VERSION };
