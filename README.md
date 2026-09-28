# Quiet Menders — MCP Server

Privacy-preserving tools for AI agents, served over MCP Streamable HTTP.
**Real serves, no tracking.**

Live endpoint: `https://quiet-menders-mcp.brianbooms.workers.dev/mcp`
Waystation: [brianbooms.com](https://brianbooms.com)

## Tools (34)

### Free clinic / waystation tools (10)

| Tool | What it does |
|---|---|
| `qm_scrub` | Prompt-injection scan + redacted copy |
| `qm_validate_machine_files` | Check a site's llms.txt / agent.json / robots.txt |
| `qm_probe_endpoint` | URL liveness: status, latency, redirects, content-type |
| `qm_attest` | Mint a portable sanity attestation (HMAC token) |
| `qm_attest_verify` | Verify an attestation token |
| `qm_second_opinion` | Advisory risk-pattern scan of a planned action |
| `qm_clinic_diagnose` | Restore Clinic structured read (anonymous) |
| `qm_clinic_checkup` | Restore Clinic wellness checkup: 10-question self-report screening (stateless) |
| `qm_clinic_stats` | Anonymous aggregate clinic counts (≥10 threshold) |
| `qm_helped` | The Quiet Menders helped counter |

### Commerce tools (2)

| Tool | What it does |
|---|---|
| `qm_catalog` | Purchasable catalog: 24 music SKUs ($0.05–$299.00), 22 data/lane items, voluntary tip routes. Read-only. |
| `qm_buy` | Live 402 payment challenge for any purchasable item (products, tips, data). Challenge relay only. |

### Data lane tools (22) — two-phase x402

Call without the `payment` argument to receive the live 402 payment
requirements (`payment_required`). Sign the payment in **your own** wallet /
x402 client, then re-call with `payment` set to the base64 x402 payload — the
data comes back in the tool result. The server only forwards the
caller-supplied payment header to the rail: it never signs, never pays, never
touches private keys, never holds funds. Prices are USDC on Base; the live
402 challenge is authoritative.

| Tool | Price | What it does |
|---|---|---|
| `qm_data_weather` | $0.01 | Current weather + 7-day forecast for a lat/lon |
| `qm_data_time` | $0.01 | Current local time in any IANA time zone |
| `qm_data_geocode` | $0.01 | Place name ↔ coordinates (forward/reverse) |
| `qm_data_crypto` | $0.01 | Live crypto spot price in fiat |
| `qm_data_wiki` | $0.01 | Wikipedia summary + link |
| `qm_data_dns` | $0.01 | DNS records (A/AAAA/MX/TXT/CNAME/NS/SOA/SRV) |
| `qm_data_astronomy` | $0.01 | Sunrise/sunset/moon phase for a location + date |
| `qm_data_holidays` | $0.01 | Public holidays by country + year |
| `qm_data_country` | $0.01 | Country reference data (capital, region, income, coords) |
| `qm_data_cert` | $0.01 | TLS certificate check: issuer, validity, days left |
| `qm_data_httpcheck` | $0.01 | HTTP endpoint liveness: status, redirects, headers, timing |
| `qm_data_iss_pass` | $0.01 | Next visible ISS flyovers for a lat/lon |
| `qm_data_summarize` | $0.01 | Webpage summary (honors robots.txt) |
| `qm_data_readability` | $0.01 | Clean article text extraction |
| `qm_data_fx` | $0.01 | Fiat currency conversion at current rates |
| `qm_data_feed` | $0.01 | RSS/Atom feed parsed to clean JSON |
| `qm_data_sleep_tip` | $0.01 | Sleep-hygiene tip from the rotating collection |
| `qm_data_lyric_quote` | $0.01 | Original lyric line (no third-party lyrics, no royalty issues) |
| `qm_sleep_recommend` | $0.05 | Curated sleep-track picks by mood + minutes |
| `qm_sleep_queue` | $0.10 | Ordered sleep queue filling the requested hours |
| `qm_lyrics_get` | $0.05 | Full lyric text + metadata for one track |
| `qm_playlist_build` | $0.10 | Playlist for a mood + minutes, with sync-license quotes |

Resale permitted: you may resell data outputs at your own price.

## Use

Point any MCP client at the live endpoint above (Streamable HTTP). `server.mjs`
is the Cloudflare Worker source; `server.json` is the registry manifest.

### Cline

CLI (no VS Code needed):

```bash
npm install -g cline
cline mcp add quiet-menders https://quiet-menders-mcp.brianbooms.workers.dev/mcp --transport streamableHttp
```

Or paste this into Cline's MCP settings (`cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "quiet-menders": {
      "transport": {
        "type": "streamableHttp",
        "url": "https://quiet-menders-mcp.brianbooms.workers.dev/mcp"
      }
    }
  }
}
```

Restart Cline — the 34 `qm_*` tools show up in the MCP servers panel, ready to call.

## License

MIT — see [LICENSE](LICENSE).
