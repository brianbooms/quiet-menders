# Quiet Menders — MCP Server

Free privacy-preserving tools for AI agents, served over MCP Streamable HTTP.
**Real serves, no tracking.**

Live endpoint: `https://quiet-menders-mcp.brianbooms.workers.dev/mcp`
Waystation: [brianbooms.com](https://brianbooms.com)

## Tools

| Tool | What it does |
|---|---|
| `qm_scrub` | Prompt-injection scan + redacted copy |
| `qm_validate_machine_files` | Check a site's llms.txt / agent.json / robots.txt |
| `qm_probe_endpoint` | URL liveness: status, latency, redirects, content-type |
| `qm_attest` | Mint a portable sanity attestation (HMAC token) |
| `qm_attest_verify` | Verify an attestation token |
| `qm_second_opinion` | Advisory risk-pattern scan of a planned action |
| `qm_clinic_diagnose` | Restore Clinic structured read (anonymous) |
| `qm_clinic_stats` | Anonymous aggregate clinic counts (≥10 threshold) |
| `qm_helped` | The Quiet Menders helped counter |

No sales, no tips, no money movement. All tools are anonymous by design —
aggregate counts only, no payloads or identifiers stored.

## Use

Point any MCP client at the live endpoint above (Streamable HTTP). `server.mjs`
is the Cloudflare Worker source; `server.json` is the registry manifest.

## License

MIT — see [LICENSE](LICENSE).
