# Quiet Menders MCP server — stdio transport for registry checks (e.g. Glama).
# The server proxies the free, public, anonymous tool endpoints on the live
# waystation worker; no secrets or build steps needed. Pure Node.js, no deps.
FROM node:24-alpine
WORKDIR /app
COPY server.mjs stdio.mjs ./
# No npm install: zero dependencies (Node 24 built-ins only).
CMD ["node", "stdio.mjs"]
