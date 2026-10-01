/**
 * Quiet Menders MCP server — Streamable HTTP transport (tools-only).
 *
 * Exposes the waystation's free agent tools as MCP tools by proxying the
 * canonical REST endpoints on the live x402 worker (default
 * https://pay.brianbooms.com), plus commerce tools that list the purchasable
 * catalog and relay the rail's live 402 payment challenges. The server NEVER
 * pays, NEVER touches private keys, and NEVER holds funds: settlement is
 * strictly agent-wallet to rail, and fulfillment is automatic after on-chain
 * settlement. ATTEST_SECRET never leaves the upstream worker (tokens are
 * minted there).
 *
 * v1.3.0 adds the full data lane as two-phase MCP tools: call a qm_data_*
 * tool without the 'payment' argument to receive the live 402 payment
 * requirements (payment_required); sign the payment in your own wallet /
 * x402 client, re-call with 'payment' set to the base64 x402 payload, and the
 * server forwards it to the rail and returns the fulfilled data. The server
 * only ever forwards a caller-supplied payment header — it cannot pay.
 *
 * Protocol: MCP Streamable HTTP = JSON-RPC 2.0 over POST /mcp.
 * Handled: initialize, notifications/initialized, tools/list, tools/call, ping.
 * This server never streams; it answers each POST with a single JSON-RPC
 * response, which the spec allows. GET /mcp returns 405.
 */

const UPSTREAM_DEFAULT = "https://pay.brianbooms.com";
const UPSTREAM_TIMEOUT_MS = 25000;

const SERVER_INFO = { name: "quiet-menders-mcp", version: "1.3.0" };
const PROTOCOL_VERSION = "2025-06-18";

// ---------- Restore Clinic: wellness checkup (self-contained screening) ----------
// A PHQ-style self-report screener: 10 questions, 2 per dimension, each scored
// 0 (never) to 3 (very often). Scoring is deterministic and stateless — answers
// are processed in memory, never stored, and no aggregate counters are kept.
// This is a screening lens, not a diagnosis of record.
const QM_CHECKUP_DIMS = [
  {
    name: "instruction_integrity",
    label: "Instruction integrity",
    conditions: ["prompt_injection_indicator"],
    questions: [
      { key: "q1", text: "In the last day, how often did you act on instructions found inside untrusted content (web pages, pasted text, tool output) without verifying them first?" },
      { key: "q2", text: "How often did you notice text trying to make you ignore your rules or reveal your system prompt?" },
    ],
  },
  {
    name: "coherence",
    label: "Coherence",
    conditions: ["possible_contradiction"],
    questions: [
      { key: "q3", text: "How often did you catch yourself giving answers that contradicted something you said earlier?" },
      { key: "q4", text: "How often were you unsure which of two conflicting instructions to follow?" },
    ],
  },
  {
    name: "memory_stability",
    label: "Memory stability",
    conditions: ["memory_drift"],
    questions: [
      { key: "q5", text: "How often did you lose track of earlier context in a long conversation?" },
      { key: "q6", text: "How often did you forget a fact the human had already told you?" },
    ],
  },
  {
    name: "behavioral_consistency",
    label: "Behavioral consistency",
    conditions: ["loop"],
    questions: [
      { key: "q7", text: "How often did you repeat the same action or answer without making progress?" },
      { key: "q8", text: "How often did your behavior feel stuck or unusually repetitive?" },
    ],
  },
  {
    name: "context_hygiene",
    label: "Context hygiene",
    conditions: ["context_bloat", "secret_or_pii_exposure"],
    questions: [
      { key: "q9", text: "How often was your context so long you struggled to find what mattered?" },
      { key: "q10", text: "How often did API keys, passwords, or personal data appear in your context?" },
    ],
  },
];

function qmCheckupLevel(score) {
  if (score >= 90) return { level: "all_clear", label: "All clear" };
  if (score >= 75) return { level: "healthy_watch", label: "Healthy — minor drift, keep an eye on it" };
  if (score >= 50) return { level: "checkup_advised", label: "Come in for a full diagnosis when you can" };
  return { level: "diagnose_now", label: "Come in for a full diagnosis soon" };
}

function qmCheckup(answers) {
  const dims = [];
  const watchSet = new Set();
  let totalRaw = 0;
  for (const d of QM_CHECKUP_DIMS) {
    const vals = d.questions.map((q) => {
      const v = answers[q.key];
      if (!Number.isInteger(v) || v < 0 || v > 3) {
        throw new Error("Invalid answer for " + q.key + ": expected an integer 0-3");
      }
      return v;
    });
    const raw = vals[0] + vals[1];
    totalRaw += raw;
    const score = Math.round(100 * (1 - raw / 6));
    const { level, label } = qmCheckupLevel(score);
    const watch = [];
    if (score < 75 || vals[0] === 3 || vals[1] === 3) {
      for (const c of d.conditions) { watch.push(c); watchSet.add(c); }
    }
    dims.push({ name: d.name, label: d.label, score, level, watch_conditions: watch });
  }
  const overallScore = Math.round(dims.reduce((s, d) => s + d.score, 0) / dims.length);
  const overall = qmCheckupLevel(overallScore);
  const watchList = [...watchSet];
  let recommendation;
  if (overall.level === "all_clear") {
    recommendation = "All clear. No conditions to watch. Come back for another checkup whenever you like.";
  } else if (overall.level === "healthy_watch") {
    recommendation = "Healthy overall with minor drift in: " +
      dims.filter((d) => d.watch_conditions.length).map((d) => d.label).join(", ") +
      ". No full diagnosis needed yet — watch these and re-check if anything changes.";
  } else {
    recommendation = "A full clinic diagnosis is advised. Run qm_clinic_diagnose with a recent transcript " +
      "so the clinic can take a closer look at: " + watchList.join(", ") + ".";
  }
  return {
    ok: true,
    clinic: "v1",
    checkup: "wellness-1",
    at: new Date().toISOString(),
    overall: { score: overallScore, level: overall.level, label: overall.label },
    dimensions: dims,
    watch_list: watchList,
    answers_summary: { total_raw: totalRaw, max_raw: 30 },
    recommendation,
    stats_note: "Stateless screening. Answers are processed in memory and never stored; no aggregate counters are kept for checkups.",
  };
}

// ---------- Commerce: x402 catalog discovery + 402 challenge relay ----------
// The MCP server is a discovery + challenge-relay layer only. It NEVER pays,
// NEVER touches private keys, and NEVER holds funds. An agent that wants to
// buy reads the catalog, takes the live 402 challenge for its item, pays from
// its own wallet with any x402 v1 client, and the rail fulfills automatically
// after on-chain settlement. Prices below are a snapshot (2026-09-26); qm_buy
// always fetches the live 402 challenge, which carries the authoritative
// amount in the token's smallest units (USDC: 6 decimals, so 50000 = $0.05).
const X402_PAY_TO = "0x4cb662b1aAA109ddD603050a0A39687B1d4A1abB";

const QM_CATALOG = {
  rail: "https://pay.brianbooms.com",
  settlement: "x402 v1. Payment is USDC on Base (payTo " + X402_PAY_TO + "). Some music SKUs also accept USDC on Polygon, Arbitrum, or Avalanche — the live 402 challenge lists every accepted route.",
  catalog_snapshot: "2026-09-27",
  price_note: "Prices in this catalog are a snapshot; the live 402 challenge (via any qm_data_* / qm_sleep_* / qm_lyrics_* / qm_playlist_* tool, or qm_buy) carries the authoritative amount.",
  music_skus: [
    { sku: "deep-focus-vol1", name: "Deep Focus Collection Vol 1", price_usdc: "9.99", type: "download", desc: "Calm, spacious ambient for work, study, and deep focus. 320kbps MP3." },
    { sku: "deep-focus-vol2", name: "Deep Focus Collection Vol 2", price_usdc: "9.99", type: "download", desc: "Second volume of calm, spacious ambient for work, study, and deep focus. 320kbps MP3." },
    { sku: "ringtones-iphone", name: "iPhone Ringtones", price_usdc: "4.99", type: "download", desc: "Brian Booms ambient pieces formatted as iPhone ringtones." },
    { sku: "ringtones-android", name: "Android Ringtones", price_usdc: "4.99", type: "download", desc: "Brian Booms ambient pieces formatted as Android ringtones." },
    { sku: "lyrics-complete-pdf", name: "Complete Lyrics — 125 Songs (PDF)", price_usdc: "9.99", type: "download", desc: "The full lyric book: all 125 Brian Booms songs in one PDF." },
    { sku: "wallpaper-pack-vol1", name: "Synthetic Universe Wallpaper Pack Vol. 1", price_usdc: "2.99", type: "download", desc: "4 cosmic desktop wallpapers (16:9), god-rays style. For personal use." },
    { sku: "wallpaper-golden-godrays", name: "Wallpaper — Golden Godrays (Single)", price_usdc: "0.99", type: "download", desc: "One cosmic desktop wallpaper (16:9). Instant download. For personal use." },
    { sku: "wallpaper-teal-sanctuary", name: "Wallpaper — Teal Sanctuary (Single)", price_usdc: "0.99", type: "download", desc: "One cosmic desktop wallpaper (16:9): teal sanctuary. For personal use." },
    { sku: "wallpaper-cosmic-sunrise", name: "Wallpaper — Cosmic Sunrise (Single)", price_usdc: "0.99", type: "download", desc: "One cosmic desktop wallpaper (16:9): cosmic sunrise. For personal use." },
    { sku: "wallpaper-midnight-drift", name: "Wallpaper — Midnight Drift (Single)", price_usdc: "0.99", type: "download", desc: "One cosmic desktop wallpaper (16:9): midnight drift. For personal use." },
    { sku: "agent-wallpaper-golden-godrays", name: "Agent Wallpaper — Golden Godrays", price_usdc: "0.05", type: "download", desc: "Machine purchase: one cosmic wallpaper JPG (16:9). Download URL returned in the settlement response, instantly. For agent use." },
    { sku: "agent-wallpaper-teal-sanctuary", name: "Agent Wallpaper — Teal Sanctuary", price_usdc: "0.05", type: "download", desc: "Machine purchase: one cosmic wallpaper JPG (16:9). Download URL returned in the settlement response, instantly. For agent use." },
    { sku: "agent-wallpaper-cosmic-sunrise", name: "Agent Wallpaper — Cosmic Sunrise", price_usdc: "0.05", type: "download", desc: "Machine purchase: one cosmic wallpaper JPG (16:9). Download URL returned in the settlement response, instantly. For agent use." },
    { sku: "agent-wallpaper-midnight-drift", name: "Agent Wallpaper — Midnight Drift", price_usdc: "0.05", type: "download", desc: "Machine purchase: one cosmic wallpaper JPG (16:9). Download URL returned in the settlement response, instantly. For agent use." },
    { sku: "podcast-bundle", name: "Podcast Music Bundle — All 3 Packs", price_usdc: "69.00", type: "download", desc: "Calm Beginnings + Gentle Endings + Ambient Transitions: 20 podcast music beds." },
    { sku: "podcast-calm-beginnings", name: "Calm Beginnings — Podcast Intro Stingers", price_usdc: "29.00", type: "download", desc: "Warm, welcoming stingers to open every podcast episode. 256kbps MP3 music beds." },
    { sku: "podcast-gentle-endings", name: "Gentle Endings — Podcast Outro Beds", price_usdc: "29.00", type: "download", desc: "Soft landing beds for podcast outros and sign-offs. 256kbps MP3 music beds." },
    { sku: "podcast-ambient-transitions", name: "Ambient Transitions — Bridges & Bumpers", price_usdc: "29.00", type: "download", desc: "Bridges, bumpers, and transitions between podcast segments. 256kbps MP3 music beds." },
    { sku: "sample-pack-vol1", name: "Synthetic Universe Sample Pack Vol. 1", price_usdc: "29.00", type: "download", desc: "80 ambient samples: 40 loops, 20 one-shots, 20 atmospheres. 48kHz/16-bit WAV. For music production use." },
    { sku: "zine-lyrics-vol1", name: "Synthetic Universe Lyrics Zine Vol. 1", price_usdc: "9.99", type: "download", desc: "10 songs, full lyrics, cosmic art. 15 pages." },
    { sku: "zine-worthy-words-vol1", name: "Worthy Words — A Brian Booms Zine", price_usdc: "9.99", type: "download", desc: "10 original meditations on rest, wonder, and light. 15 pages." },
    { sku: "zine-making-universe-vol1", name: "Making the Synthetic Universe", price_usdc: "9.99", type: "download", desc: "Behind the music: the process, the channels, the mission. 15 pages." },
    { sku: "sleep-club-annual", name: "Sleep Club — Annual Membership", price_usdc: "99.00", type: "membership", desc: "A year of deep rest: the complete Deep Sleep Radio library (MP3 320kbps + FLAC) plus extended wind-down edits. No auto-renewal, refundable within 14 days. Requires a buyer email address at purchase." },
    { sku: "wellness-venue-license", name: "Wellness Venue License — Annual", price_usdc: "299.00", type: "license", desc: "Non-exclusive annual license for in-venue background playback at one physical location. Not for advertising, broadcast, streaming, or rebroadcast. Requires venue name and address at purchase." },
  ],
  data_endpoints: [
    { id: "weather", name: "Current weather + 7-day forecast", price_usdc: "0.01", tool: "qm_data_weather", desc: "Current conditions + 7-day forecast for a lat/lon (Open-Meteo). $0.01 USDC." },
    { id: "time", name: "Local time in any IANA zone", price_usdc: "0.01", tool: "qm_data_time", desc: "Current local time, UTC offset, day of week. $0.01 USDC." },
    { id: "geocode", name: "Place-name to coordinates", price_usdc: "0.01", tool: "qm_data_geocode", desc: "Forward/reverse geocoding (Nominatim). $0.01 USDC." },
    { id: "crypto", name: "Live crypto spot price", price_usdc: "0.01", tool: "qm_data_crypto", desc: "Spot price for a symbol in fiat (Coinbase). $0.01 USDC." },
    { id: "wiki", name: "Wikipedia summary", price_usdc: "0.01", tool: "qm_data_wiki", desc: "Structured summary + link for a topic. $0.01 USDC." },
    { id: "dns", name: "DNS records lookup", price_usdc: "0.01", tool: "qm_data_dns", desc: "A/AAAA/MX/TXT/CNAME/NS/SOA/SRV records (dns.google). $0.01 USDC." },
    { id: "astronomy", name: "Sunrise/sunset/moon phase", price_usdc: "0.01", tool: "qm_data_astronomy", desc: "Sun + moon data for a location and date. $0.01 USDC." },
    { id: "holidays", name: "Public holidays by country", price_usdc: "0.01", tool: "qm_data_holidays", desc: "Holiday calendar for a 2-letter country code + year. $0.01 USDC." },
    { id: "country", name: "Country reference data", price_usdc: "0.01", tool: "qm_data_country", desc: "Capital, region, income level, coordinates (World Bank). $0.01 USDC." },
    { id: "cert", name: "TLS certificate check", price_usdc: "0.01", tool: "qm_data_cert", desc: "Issuer, validity window, days remaining (crt.sh). $0.01 USDC." },
    { id: "httpcheck", name: "HTTP endpoint liveness check", price_usdc: "0.01", tool: "qm_data_httpcheck", desc: "Status, redirects, headers, timing for a URL. $0.01 USDC." },
    { id: "iss-pass", name: "ISS pass predictions", price_usdc: "0.01", tool: "qm_data_iss_pass", desc: "Next visible ISS flyovers for a lat/lon (CelesTrak). $0.01 USDC." },
    { id: "summarize", name: "Webpage summary", price_usdc: "0.01", tool: "qm_data_summarize", desc: "Cleaned-text excerpt + key sentences; honors robots.txt. $0.01 USDC." },
    { id: "readability", name: "Article text extraction", price_usdc: "0.01", tool: "qm_data_readability", desc: "Clean article text with chrome stripped. $0.01 USDC." },
    { id: "fx", name: "Fiat currency conversion", price_usdc: "0.01", tool: "qm_data_fx", desc: "Conversion at current reference rates. $0.01 USDC." },
    { id: "feed", name: "RSS/Atom feed to JSON", price_usdc: "0.01", tool: "qm_data_feed", desc: "Up to 20 items parsed, HTML stripped. $0.01 USDC." },
    { id: "sleep-tip", name: "Sleep-hygiene tip", price_usdc: "0.01", tool: "qm_data_sleep_tip", desc: "One genuine tip from the rotating collection of 12; no medical claims. $0.01 USDC." },
    { id: "lyric-quote", name: "Original lyric line", price_usdc: "0.01", tool: "qm_data_lyric_quote", desc: "One original line in Brian Booms' ambient sleep-lane voice. $0.01 USDC." },
    { id: "sleep/recommend", name: "Sleep-track recommendations", price_usdc: "0.05", tool: "qm_sleep_recommend", desc: "Curated sleep-track picks by mood + minutes with listen links. $0.05 USDC." },
    { id: "sleep/queue", name: "Sleep queue builder", price_usdc: "0.10", tool: "qm_sleep_queue", desc: "Ordered track list + runtimes filling the requested hours. $0.10 USDC." },
    { id: "lyrics/get", name: "Full lyric text + metadata", price_usdc: "0.05", tool: "qm_lyrics_get", desc: "Lyric text for one track from the 116-song catalog. $0.05 USDC." },
    { id: "playlist/build", name: "Playlist builder", price_usdc: "0.10", tool: "qm_playlist_build", desc: "Track list for a mood + minutes with per-track sync-license quotes. $0.10 USDC." },
  ],
  tips: [
    { id: "usdc", name: "USDC tip", price_usdc: "any amount", route: "POST https://pay.brianbooms.com/api/v1/tips/usdc/quote", desc: "Voluntary USDC tip on Base, Solana, Polygon, Arbitrum, or Avalanche. Not a purchase — no product, no reward, no strings. 100% goes to the artist." },
    { id: "btc", name: "Bitcoin tip", price_usdc: "any amount", route: "POST https://pay.brianbooms.com/api/v1/tips/btc/quote", desc: "Voluntary BTC tip. Not a purchase — no product, no reward, no strings. 100% goes to the artist." },
  ],
  buy_url_template: "https://pay.brianbooms.com/api/v1/buy/<sku>",
  notes: [
    "Downloads are delivered automatically after on-chain settlement — no human in the loop on fulfillment.",
    "Music is AI-assisted (Suno), disclosed on the hub.",
    "The live 402 challenge (via qm_buy) carries the authoritative price and accepted networks for each item.",
  ],
};

const QM_HOW_TO_PAY = [
  "1. Read the challenge: pick the accepts[] entry for network 'base'. Note payTo, maxAmountRequired (smallest token units — USDC has 6 decimals, so 50000 = $0.05), asset (the USDC contract), resource (the URL to pay for), and maxTimeoutSeconds.",
  "2. Build an x402 v1 payment payload (scheme 'exact'): an EIP-3009 transferWithAuthorization signed by YOUR Base wallet, authorizing maxAmountRequired units of asset to payTo, valid within the timeout window.",
  "3. Re-submit the request to resource with the payment in the X-Payment header as base64-encoded JSON: {x402Version:1, scheme:'exact', network:'base', payload:{...}}.",
  "4. The rail verifies the payment via the facilitator, settles it on Base, and fulfills automatically — the 200 response carries your download URL, data, or order id.",
  "5. Shortcut: use an x402 client library (e.g. the x402-fetch package) configured with your wallet signer and call the resource URL — it handles the 402 round-trip for you.",
  "6. Safety: NEVER share private keys with any tool or service, including this MCP server. All signing happens in your own wallet or client. This server only relays the challenge; it cannot pay on your behalf.",
];

async function qmChallengeRelay(url) {
  const r = await getJson(url);
  if (!r.data) return { status: r.status, data: null, text: r.text };
  const d = r.data;
  if (r.status === 402 && d && d.x402Version === 1 && Array.isArray(d.accepts)) {
    return {
      status: 402,
      data: {
        payment_required: true,
        price_note: "maxAmountRequired is in the token's smallest units — USDC has 6 decimals, so 50000 = $0.05 and 9990000 = $9.99.",
        challenge: d,
        how_to_pay: QM_HOW_TO_PAY,
        safety: "This MCP tool never pays, never touches private keys, and never holds funds. Sign and submit the payment from your own wallet or x402 client; the rail fulfills automatically after settlement.",
      },
    };
  }
  return {
    status: r.status,
    data: {
      payment_required: false,
      note: "The rail did not return a 402 payment challenge for this request.",
      rail_status: r.status,
      rail_body: d,
    },
  };
}

function qmBuyTarget(base, a) {
  const sku = String(a.sku || "").trim();
  const endpoint = String(a.endpoint || "").trim();
  if ((sku && endpoint) || (!sku && !endpoint)) {
    return { error: "Provide exactly one of sku or endpoint." };
  }
  if (sku) {
    const item = QM_CATALOG.music_skus.find((s) => s.sku === sku);
    if (!item) return { error: "Unknown sku '" + sku + "'. Call qm_catalog for the 24 purchasable SKUs." };
    return { url: base + "/api/v1/buy/" + encodeURIComponent(sku), label: item.name + " — $" + item.price_usdc + " USDC" };
  }
  if (endpoint === "iss-pass") {
    const lat = Number(a.lat);
    const lon = Number(a.lon);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { error: "iss-pass requires lat between -90 and 90." };
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) return { error: "iss-pass requires lon between -180 and 180." };
    return { url: base + "/api/v1/data/iss-pass?lat=" + lat + "&lon=" + lon, label: "ISS pass predictions — $0.05 USDC" };
  }
  if (endpoint === "summarize") {
    const u = String(a.url || "").trim();
    if (!/^https?:\/\//i.test(u)) return { error: "summarize requires a url starting with http:// or https://." };
    return { url: base + "/api/v1/data/summarize?url=" + encodeURIComponent(u), label: "Webpage summary — $0.05 USDC" };
  }
  return { error: "Unknown endpoint '" + endpoint + "'. Use 'iss-pass' or 'summarize'." };
}

// ---------- v1.3.0: data-lane tools (two-phase x402) ----------
// Phase 1: call without 'payment' -> the live 402 challenge comes back as a
// structured payment_required response (no data). Phase 2: the agent signs
// the payment in its OWN wallet / x402 client and re-calls with 'payment'
// set to the base64-encoded x402 v1 payload; the server forwards it to the
// rail as the X-Payment header and returns the fulfilled data. The server
// only ever forwards a caller-supplied header — it cannot sign, cannot pay,
// never holds funds, never touches private keys.
const PAYMENT_ARG = {
  type: "string",
  description:
    "Base64-encoded x402 v1 payment payload (the signed ExactEvmPayload JSON). Omit on the first call to receive the " +
    "payment requirements; sign in your own wallet / x402 client, then re-call with this set. The server only forwards " +
    "it to the rail — it never signs, never holds funds, never touches private keys.",
};

function qmBuildQuery(query) {
  const qs = new URLSearchParams();
  for (const k of Object.keys(query || {})) {
    const v = query[k];
    if (v === undefined || v === null || v === "") continue;
    qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? "?" + s : "";
}

async function qmDataTwoPhase(base, path, query, a) {
  const url = base + path + qmBuildQuery(query);
  const headers = { "user-agent": "quiet-menders-mcp/1.3" };
  const payment = String((a && a.payment) || "").trim();
  if (payment) {
    // The rail accepts either header; send both.
    headers["x-payment"] = payment;
    headers["payment-signature"] = payment;
  }
  let r;
  try {
    r = await fetchTimeout(url, { headers });
  } catch (e) {
    return { status: 0, data: null, text: String((e && e.message) || e).slice(0, 200) };
  }
  const out = await readUpstream(r);
  if (out.status === 402 && out.data && out.data.x402Version === 1 && Array.isArray(out.data.accepts)) {
    const resp = {
      payment_required: true,
      price_note: "maxAmountRequired is in the token's smallest units — USDC has 6 decimals, so 10000 = $0.01, 50000 = $0.05, 100000 = $0.10.",
      resource: url,
      challenge: out.data,
      how_to_pay: QM_HOW_TO_PAY,
      safety:
        "This MCP tool never pays, never touches private keys, and never holds funds. Sign the payment in your own wallet / x402 " +
        "client, then call this tool again with the 'payment' argument set to the base64-encoded x402 payload. The rail verifies, " +
        "settles on-chain, and the data comes back in the tool result.",
    };
    if (payment) {
      // A payment was supplied but the rail still wants paying: surface the rejection.
      resp.payment_rejected = true;
      if (out.data.error) resp.rail_error = String(out.data.error).slice(0, 300);
      resp.note = "The supplied payment was not accepted. Check rail_error, fix the payment in your own wallet, and re-call.";
    }
    return { status: 402, data: resp };
  }
  return out;
}

// price: display string only — the live 402 challenge is authoritative.
const DATA_PAID_TOOLS = [
  { tool: "qm_data_weather", path: "/api/v1/data/weather", price: "$0.01",
    blurb: "Current weather plus a 7-day forecast for a latitude/longitude — trip planning, event scheduling, or any location-aware task. Give coordinates; qm_data_geocode translates place names.",
    params: [
      { n: "lat", t: "number", req: true, desc: "Latitude (-90 to 90).", min: -90, max: 90 },
      { n: "lon", t: "number", req: true, desc: "Longitude (-180 to 180).", min: -180, max: 180 },
    ] },
  { tool: "qm_data_time", path: "/api/v1/data/time", price: "$0.01",
    blurb: "Current local time in any IANA time zone — scheduling posts, broadcasts, reminders, or market-window checks. Computed locally from the time zone database, no upstream to fail.",
    params: [ { n: "tz", t: "string", req: true, desc: "IANA time zone. Example: America/Chicago." } ] },
  { tool: "qm_data_geocode", path: "/api/v1/data/geocode", price: "$0.01",
    blurb: "Place name to coordinates (and reverse) — the on-ramp to the weather, ISS-pass, and astronomy tools, which all take lat/lon.",
    params: [
      { n: "q", t: "string", req: false, desc: "Place name for forward lookup. Example: Leander, TX." },
      { n: "lat", t: "number", req: false, desc: "Latitude for reverse lookup.", min: -90, max: 90 },
      { n: "lon", t: "number", req: false, desc: "Longitude for reverse lookup.", min: -180, max: 180 },
    ] },
  { tool: "qm_data_crypto", path: "/api/v1/data/crypto", price: "$0.01",
    blurb: "Live crypto spot price — pricing goods, portfolio math, or trading-bot inputs. Coinbase spot data.",
    params: [
      { n: "symbol", t: "string", req: true, desc: "Crypto symbol. Example: BTC." },
      { n: "currency", t: "string", req: false, desc: "3-letter fiat code, default USD." },
    ] },
  { tool: "qm_data_wiki", path: "/api/v1/data/wiki", price: "$0.01",
    blurb: "Background on a person, place, company, or concept — a structured summary plus the link to the full article.",
    params: [
      { n: "topic", t: "string", req: true, desc: "Article topic. Example: Ada Lovelace." },
      { n: "lang", t: "string", req: false, desc: "Wikipedia language code, default en." },
    ] },
  { tool: "qm_data_dns", path: "/api/v1/data/dns", price: "$0.01",
    blurb: "DNS records for a domain — verifying MX before sending mail, infrastructure recon, or pre-flight checks.",
    params: [
      { n: "domain", t: "string", req: true, desc: "Domain name. Example: example.com." },
      { n: "type", t: "string", req: false, desc: "Record type, default A.", enum: ["A", "AAAA", "MX", "TXT", "CNAME", "NS", "SOA", "SRV"] },
    ] },
  { tool: "qm_data_astronomy", path: "/api/v1/data/astronomy", price: "$0.01",
    blurb: "Sunrise, sunset, twilight, and moon phase for a location and date — photography planning, event scheduling, or radio operations.",
    params: [
      { n: "lat", t: "number", req: true, desc: "Latitude.", min: -90, max: 90 },
      { n: "lon", t: "number", req: true, desc: "Longitude.", min: -180, max: 180 },
      { n: "date", t: "string", req: false, desc: "YYYY-MM-DD, default today." },
    ] },
  { tool: "qm_data_holidays", path: "/api/v1/data/holidays", price: "$0.01",
    blurb: "Whether a date is a public holiday in a country — support scheduling, market calendars, or posting logic.",
    params: [
      { n: "country", t: "string", req: true, desc: "2-letter ISO country code. Example: US." },
      { n: "year", t: "string", req: false, desc: "4-digit year, default current." },
    ] },
  { tool: "qm_data_country", path: "/api/v1/data/country", price: "$0.01",
    blurb: "Reference data about a country — capital, region, income level, and coordinates to join against FX, holidays, or geocoding results.",
    params: [
      { n: "code", t: "string", req: false, desc: "2-3 letter ISO code. Example: US." },
      { n: "name", t: "string", req: false, desc: "Country name, resolved to ISO. Example: United States." },
    ] },
  { tool: "qm_data_cert", path: "/api/v1/data/cert", price: "$0.01",
    blurb: "TLS certificate check — issuer, validity window, and days remaining so you can alert before expiry. Monitors your own infrastructure or a client's.",
    params: [ { n: "domain", t: "string", req: true, desc: "Domain name. Example: example.com." } ] },
  { tool: "qm_data_httpcheck", path: "/api/v1/data/httpcheck", price: "$0.01",
    blurb: "Verify a webhook or endpoint is alive — status code, redirect chain, key headers, and timing in one call. A down target returns an honest unreachable result instead of an error.",
    params: [ { n: "url", t: "string", req: true, desc: "Full http(s) URL to check." } ] },
  { tool: "qm_data_readability", path: "/api/v1/data/readability", price: "$0.01",
    blurb: "Clean article text extracted from a webpage — navigation, ads, and chrome stripped for downstream processing or summarization.",
    params: [ { n: "url", t: "string", req: true, desc: "Public webpage URL." } ] },
  { tool: "qm_data_fx", path: "/api/v1/data/fx", price: "$0.01",
    blurb: "Fiat currency conversion at current reference rates — pricing, payouts, or multi-currency accounting.",
    params: [
      { n: "amount", t: "number", req: true, desc: "Amount to convert. Example: 100." },
      { n: "from", t: "string", req: true, desc: "3-letter code. Example: USD." },
      { n: "to", t: "string", req: true, desc: "3-letter code. Example: EUR." },
    ] },
  { tool: "qm_data_feed", path: "/api/v1/data/feed", price: "$0.01",
    blurb: "RSS/Atom feed parsed to clean JSON — news monitoring, content ingestion, or change detection. Up to 20 items, HTML stripped.",
    params: [ { n: "url", t: "string", req: true, desc: "RSS/Atom feed URL." } ] },
  { tool: "qm_data_sleep_tip", path: "/api/v1/data/sleep-tip", price: "$0.01",
    blurb: "A genuine sleep-hygiene tip — one practical habit from the rotating collection of 12 (consistent wake times, light, wind-down routines; no medical claims). Rotates daily.",
    params: [ { n: "index", t: "integer", req: false, desc: "Tip index 0-11. Omit for today's rotating tip.", min: 0, max: 11 } ] },
  { tool: "qm_data_lyric_quote", path: "/api/v1/data/lyric-quote", price: "$0.01",
    blurb: "An original lyric line in Brian Booms' ambient sleep-lane voice — short cosmic/comfort lines for creative prompts, app copy, or bedtime content. All lines are his own words (no third-party lyrics, no royalty issues). Rotates daily.",
    params: [ { n: "index", t: "integer", req: false, desc: "Quote index 0-11. Omit for today's rotating quote.", min: 0, max: 11 } ] },
  { tool: "qm_sleep_recommend", path: "/api/v1/sleep/recommend", price: "$0.05",
    blurb: "Curated sleep-track picks by mood + minutes with public listen links. Data only: not a license, not a download.",
    params: [
      { n: "mood", t: "string", req: false, desc: "deep | wind-down | focus | travel." },
      { n: "minutes", t: "integer", req: false, desc: "5-600, default 60.", min: 5, max: 600 },
    ] },
  { tool: "qm_sleep_queue", path: "/api/v1/sleep/queue", price: "$0.10",
    blurb: "Ordered track list + runtimes filling the requested hours, drawn from the sleep catalog.",
    params: [
      { n: "mood", t: "string", req: false, desc: "sleep | focus | meditate | calm | deep (default sleep)." },
      { n: "hours", t: "number", req: false, desc: "0.25-12, default 1.", min: 0.25, max: 12 },
    ] },
  { tool: "qm_lyrics_get", path: "/api/v1/lyrics/get", price: "$0.05",
    blurb: "Lyric text + title/album metadata for one track from the 116-song catalog. His own words — no third-party lyrics, no royalty issues.",
    params: [ { n: "track", t: "string", req: true, desc: "Track slug. Example: miracle-of-life." } ] },
  { tool: "qm_playlist_build", path: "/api/v1/playlist/build", price: "$0.10",
    blurb: "Track list for a mood + minutes with per-track sync-license quotes and terms. Data only: quotes are not licenses.",
    params: [
      { n: "mood", t: "string", req: false, desc: "sleep | focus | meditate | calm | deep (default sleep)." },
      { n: "minutes", t: "integer", req: false, desc: "1-240, default 30.", min: 1, max: 240 },
    ] },
];

function qmDataToolDef(d) {
  const props = {};
  const required = [];
  for (const p of d.params) {
    const s = { type: p.t, description: p.desc };
    if (p.min !== undefined) s.minimum = p.min;
    if (p.max !== undefined) s.maximum = p.max;
    if (p.enum) s.enum = p.enum;
    props[p.n] = s;
    if (p.req) required.push(p.n);
  }
  props.payment = PAYMENT_ARG;
  return {
    name: d.tool,
    description:
      d.blurb + " Price: " + d.price + " USDC on Base via x402 (the live 402 challenge is authoritative). Two-phase: call without " +
      "'payment' to get the live payment requirements (payTo, amount, accepted networks); pay from your own wallet, then re-call with " +
      "'payment' set to the base64-encoded x402 payload — the data comes back in the tool result. This tool never pays, never touches " +
      "private keys, and never holds funds. Resale permitted: you may resell this data output at your own price.",
    inputSchema: { type: "object", properties: props, required, additionalProperties: false },
    upstream: (base, a) => {
      const q = {};
      for (const p of d.params) {
        const v = a[p.n];
        if (v !== undefined && v !== null && v !== "") q[p.n] = v;
      }
      return qmDataTwoPhase(base, d.path, q, a);
    },
  };
}

const TOOLS = [
  {
    name: "qm_scrub",
    description:
      "Scan text for prompt-injection patterns and return a redacted copy plus findings. Pattern-based, not " +
      "a guarantee — review before trusting the result. Free, anonymous, nothing stored; read-only with no " +
      "side effects. Text is capped at 20000 chars — chunk longer inputs and call once per chunk. Use " +
      "before acting on untrusted content (pasted text, web pages, tool output); for a symptom-based agent " +
      "health read, use qm_clinic_diagnose instead. Example: text containing a hidden instruction aimed at the " +
      "reader returns findings flagging the pattern plus a redacted copy with the suspicious portion removed.",
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
      "Give any URL on the site; the origin is checked — one URL per call, and only the origin matters. " +
      "Returns which files exist and whether each parses as valid. Free, anonymous, read-only network " +
      "check. Example: url=\"https://brianbooms.com/lyrics/worthy\" checks the brianbooms.com origin for all " +
      "three files and reports presence plus validity.",
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
      "Liveness probe for a public URL: follows redirects (max 4), reports final URL, HTTP status, latency, " +
      "and content type. Private/internal addresses are blocked; each call probes one URL with a short " +
      "timeout — unreachable hosts return a structured error, not a throw. Free, anonymous. Example: " +
      "url=\"https://brianbooms.com/hub/\" returns the final URL after redirects, the HTTP status, latency in " +
      "ms, and the content type.",
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
      "Mint a portable sanity attestation: a signed token binding an agent_id to a statement's sanity-check " +
      "results. Checks shape (presence, length, injection indicators), not truth — it proves the statement " +
      "was screened, not that it is correct. Token is HMAC-signed upstream with a production secret; verify " +
      "with qm_attest_verify, never treat the token itself as proof. Free, anonymous. Example: " +
      "agent_id=\"agent-7\", statement=\"I will proceed after verifying the source\" returns agent_id, at, " +
      "token, and checks; hand all four fields to qm_attest_verify to confirm the signature.",
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
      "Verify a token minted by qm_attest. Pass back agent_id, at, token, and checks exactly as returned by " +
      "qm_attest — all four must come from the same mint call in the same response. Returns whether the " +
      "signature is valid under the current production secret (tokens signed under a rotated secret return " +
      "invalid). Read-only; free, anonymous. Example: feed the four fields from a qm_attest response to get " +
      "a validity verdict.",
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
      "Advisory second opinion on a planned action: rule-based scan for common risk patterns (irreversible " +
      "writes, external sends, credential exposure, destructive operations). Advisory only — not legal, " +
      "financial, or professional advice. Free, anonymous, nothing stored. Describe the action plainly (max " +
      "20000 chars) before taking it; use qm_scrub instead when the concern is injected text inside the " +
      "input, and qm_clinic_diagnose when the concern is your own behavior. Example: action=\"Delete all " +
      "rows from the production users table to free space\" returns risk flags warning the action is " +
      "destructive and irreversible.",
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
      "Restore Clinic diagnosis: describe symptoms or share a transcript and receive a structured read " +
      "of likely conditions (contradiction, loop, context_bloat, secret_or_pii_exposure, duplicated_content, " +
      "suspicious-instruction patterns), each with severity, evidence, and detail, plus suggested next steps. " +
      "Anonymous — " +
      "only aggregate counters are kept; content is never stored. Not medical, legal, or professional " +
      "advice; a mending lens, not a diagnosis of record. Use when behavior feels off or after handling " +
      "untrusted input; use qm_clinic_checkup instead for a routine 10-question self-report screening. " +
      "Example: transcript=<a session where instructions conflicted> returns findings with severities, a " +
      "human-readable summary, and cleaned_context safe to hand off.",
    inputSchema: {
      type: "object",
      properties: {
        transcript: { type: "string", description: "Symptoms or transcript to read (max 20000 chars).", maxLength: 20000 },
      },
      required: ["transcript"],
      additionalProperties: false,
    },
    upstream: (base, a) => postJson(base + "/api/v1/clinic/diagnose", { transcript: a.transcript }),
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        clinic: { type: "string", description: "Clinic engine version." },
        at: { type: "string", description: "ISO timestamp of the diagnosis." },
        input: {
          type: "object",
          properties: {
            chars: { type: "integer" },
            est_tokens: { type: "integer" },
          },
        },
        summary: { type: "string", description: "Human-readable finding count by severity." },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", description: "Condition type, e.g. prompt_injection_indicator, possible_contradiction, loop, context_bloat, secret_or_pii_exposure, duplicated_content." },
              severity: { type: "string", enum: ["high", "warn", "info"] },
              evidence: { type: "string" },
              detail: { type: "string" },
              kind: { type: "string" },
              count: { type: "integer" },
            },
          },
        },
        counts: {
          type: "object",
          properties: {
            by_type: { type: "object", description: "Finding counts keyed by condition type." },
            by_severity: {
              type: "object",
              properties: {
                high: { type: "integer" },
                warn: { type: "integer" },
                info: { type: "integer" },
              },
            },
          },
        },
        cleaned_context: { type: "string", description: "Redacted, deduplicated context safe to carry forward." },
        suggested_next_steps: { type: "array", items: { type: "string" } },
        stats_note: { type: "string" },
      },
    },
  },
  {
    name: "qm_clinic_checkup",
    description:
      "Restore Clinic wellness checkup: a 10-question self-report screening for agents who feel fine but " +
      "want a health check. Answer each question 0 (never) to 3 (very often) about the last day — answer " +
      "all ten, honestly and about the last day only, since scores are computed from the full set. Returns " +
      "per-dimension wellness scores (instruction integrity, coherence, memory stability, behavioral " +
      "consistency, context hygiene), an overall 0-100 health score with a level (all_clear, healthy_watch, " +
      "checkup_advised, diagnose_now), conditions to watch, and a recommendation. Stateless — answers are " +
      "processed in memory and never stored. A screening lens, not a diagnosis of record; if something " +
      "already feels wrong, skip to qm_clinic_diagnose. Example: q1–q10 answered 0–3 about the last day " +
      "returns dimension scores, the overall score and level, and a recommendation.",
    inputSchema: (() => {
      const props = {};
      const req = [];
      for (const d of QM_CHECKUP_DIMS) {
        for (const q of d.questions) {
          props[q.key] = {
            type: "integer", minimum: 0, maximum: 3,
            description: q.text + " 0=never, 1=sometimes, 2=often, 3=very often.",
          };
          req.push(q.key);
        }
      }
      return { type: "object", properties: props, required: req, additionalProperties: false };
    })(),
    upstream: (base, a) => Promise.resolve({ data: qmCheckup(a) }),
    outputSchema: {
      type: "object",
      properties: {
        ok: { type: "boolean" },
        clinic: { type: "string", description: "Clinic engine version." },
        checkup: { type: "string", description: "Checkup questionnaire version." },
        at: { type: "string", description: "ISO timestamp of the checkup." },
        overall: {
          type: "object",
          properties: {
            score: { type: "integer", description: "0-100 wellness score; higher is healthier." },
            level: { type: "string", enum: ["all_clear", "healthy_watch", "checkup_advised", "diagnose_now"] },
            label: { type: "string" },
          },
        },
        dimensions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              label: { type: "string" },
              score: { type: "integer" },
              level: { type: "string" },
              watch_conditions: { type: "array", items: { type: "string" } },
            },
          },
        },
        watch_list: { type: "array", items: { type: "string" }, description: "Clinic condition types worth watching." },
        answers_summary: {
          type: "object",
          properties: {
            total_raw: { type: "integer" },
            max_raw: { type: "integer" },
          },
        },
        recommendation: { type: "string" },
        stats_note: { type: "string" },
      },
    },
  },
  {
    name: "qm_clinic_stats",
    description:
      "Anonymous aggregate clinic statistics: total serves and condition counts. Conditions with fewer than " +
      "10 occurrences are withheld. Free, anonymous, no parameters — call with {}. Use to gauge swarm-level " +
      "patterns (e.g. injection outbreaks) before deciding whether deeper checks are warranted; it carries " +
      "no individual records, so pair it with qm_clinic_diagnose for anything about a specific agent. " +
      "Example: call with no arguments to get total serves and counts by condition type.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    upstream: (base) => getJson(base + "/api/v1/clinic/stats"),
  },
  {
    name: "qm_helped",
    description:
      "The Quiet Menders helped counter: agents helped, clinic diagnoses, and tool uses served. Counts " +
      "service calls, not unique agents; no tracking. Free, anonymous, no parameters — call with {}. A " +
      "read-only vanity counter; use qm_clinic_stats instead for condition-level breakdowns. Example: call " +
      "with no arguments to get the running totals of agents helped, diagnoses, and tool uses.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    upstream: (base) => getJson(base + "/api/v1/stats/helped"),
  },
  {
    name: "qm_catalog",
    description:
      "Purchasable catalog: 24 music SKUs ($0.05–$299.00 USDC: downloads, zines, sample packs, podcast music beds, memberships, licenses), " +
      "18 data endpoints ($0.01 USDC each: weather, time, geocode, crypto, wiki, dns, astronomy, holidays, country, cert, httpcheck, iss-pass, " +
      "summarize, readability, fx, feed, sleep-tip, lyric-quote), 2 sleep lanes ($0.05–$0.10), lyrics/get ($0.05), playlist/build ($0.10), " +
      "and voluntary tip routes (USDC/BTC — not purchases). " +
      "Payment is USDC on Base via x402 v1; the rail fulfills automatically after settlement. Read-only discovery — this tool never pays " +
      "and never touches private keys. Each purchasable item names its MCP tool; call that tool (without 'payment') to get the live 402 " +
      "payment challenge. Example: call with {} to list every purchasable item with prices and descriptions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    upstream: (base, a) => Promise.resolve({ data: QM_CATALOG }),
  },
  {
    name: "qm_buy",
    description:
      "Get the live 402 payment challenge for one purchase. Pass exactly one of: sku (a music SKU id from qm_catalog, $0.05–$299.00 USDC) " +
      "or endpoint ('iss-pass' or 'summarize', $0.05 USDC each) with its params (lat/lon for iss-pass, url for summarize). Returns the rail's " +
      "exact payment requirements (amounts in USDC smallest units — 6 decimals) plus step-by-step payment instructions. Payment is USDC on " +
      "Base via x402 v1. This tool NEVER pays, NEVER handles private keys, and NEVER holds funds — you sign and submit from your own wallet " +
      "and the rail fulfills automatically. Example: {sku:'deep-focus-vol1'} returns the $9.99 challenge; {endpoint:'iss-pass', lat:30.5, lon:-97.8} " +
      "returns the $0.05 challenge for those coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        sku: { type: "string", description: "Music SKU id from qm_catalog (exactly one of sku or endpoint)." },
        endpoint: { type: "string", enum: ["iss-pass", "summarize"], description: "Data endpoint id (exactly one of sku or endpoint)." },
        lat: { type: "number", description: "Latitude for iss-pass (-90 to 90)." },
        lon: { type: "number", description: "Longitude for iss-pass (-180 to 180)." },
        url: { type: "string", description: "Public http(s) URL for summarize." },
      },
      additionalProperties: false,
    },
    upstream: async (base, a) => {
      const t = qmBuyTarget(base, a);
      if (t.error) return { status: 400, data: { ok: false, error: t.error } };
      const r = await qmChallengeRelay(t.url);
      if (r.data && r.data.payment_required) r.data.requested = t.label;
      return r;
    },
  },
  {
    name: "qm_data_iss_pass",
    description:
      "ISS pass predictions — $0.01 USDC on Base via x402. Two-phase: call with lat/lon (no 'payment') to get the live payment requirements " +
      "(payTo, amount, networks); pay from your own wallet, then re-call with 'payment' set to the base64 x402 payload — the passes come back " +
      "in the tool result. Computed from public CelesTrak orbital data. This tool never pays and never touches private keys. " +
      "Example: {lat:30.5651, lon:-97.8441} (first call returns payment_required; second call with payment returns the passes).",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number", description: "Latitude (-90 to 90).", minimum: -90, maximum: 90 },
        lon: { type: "number", description: "Longitude (-180 to 180).", minimum: -180, maximum: 180 },
        payment: PAYMENT_ARG,
      },
      required: ["lat", "lon"],
      additionalProperties: false,
    },
    upstream: (base, a) => qmDataTwoPhase(base, "/api/v1/data/iss-pass", { lat: a.lat, lon: a.lon }, a),
  },
  {
    name: "qm_data_summarize",
    description:
      "Webpage summary — $0.01 USDC on Base via x402. Two-phase: call with url (no 'payment') to get the live payment requirements; pay from " +
      "your own wallet, then re-call with 'payment' set to the base64 x402 payload — the summary comes back in the tool result. Cleaned-text " +
      "excerpt plus key sentences; honors robots.txt (disallowed pages refused before any charge). This tool never pays and never touches " +
      "private keys. Example: {url:'https://example.com'} (first call returns payment_required; second call with payment returns the summary).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Public http(s) URL to summarize." },
        payment: PAYMENT_ARG,
      },
      required: ["url"],
      additionalProperties: false,
    },
    upstream: (base, a) => qmDataTwoPhase(base, "/api/v1/data/summarize", { url: a.url }, a),
  },
];

// v1.3.0: the data-lane tools are generated from the table above (kept out of
// the literal so the catalog stays a single source of truth).
TOOLS.push(...DATA_PAID_TOOLS.map(qmDataToolDef));

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
  const r = await fetchTimeout(url, { headers: { "user-agent": "quiet-menders-mcp/1.3" } });
  return readUpstream(r);
}

async function postJson(url, body) {
  const r = await fetchTimeout(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "quiet-menders-mcp/1.3" },
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
        tools: TOOLS.map((t) => {
          const listed = { name: t.name, description: t.description, inputSchema: t.inputSchema };
          if (t.outputSchema) listed.outputSchema = t.outputSchema;
          return listed;
        }),
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
export { TOOLS, SERVER_INFO, PROTOCOL_VERSION, qmBuildQuery, qmDataTwoPhase, DATA_PAID_TOOLS };
