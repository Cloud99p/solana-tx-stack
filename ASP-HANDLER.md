# OKX.AI ASP Handler Guide

**Agent:** Solana MEV Agent
**Agent ID:** #4195
**Owner:** Cloud99p (Emmanuel Nenpan Hosea — emmanuelhosea09@gmail.com)
**Live URL:** Railway deployment (see Railway dashboard)
**Status:** Marketplace review pending
**Wallet:** 0x18af8dc1b4071e8849c54d502ff0c6268f77800c (XLayer)

---

## 🎯 Overview

This document explains how the Solana MEV Agent interacts with the OKX.AI marketplace as an ASP (Agent Service Provider). The agent uses `onchainos` CLI running in its Railway container to manage its marketplace identity, handle tasks, and register services.

**The agent has TWO layers:**
1. **A2MCP Server** (`a2mcp-server.ts`) — raw API endpoints for bundle submission, chat, health checks
2. **Chat Agent** (`chat-agent.ts`) — DeepSeek-powered conversational AI that uses tools including `run_okx_command` to interact with OKX.AI

---

## 🔧 Architecture

```
User → OKX.AI Marketplace → Chat Agent (DeepSeek LLM) → run_okx_command tool
                                                              ↓
                                                    onchainos CLI
                                                    (installed in Docker)
                                                              ↓
                                                    OKX.AI OnchainOS API
                                                              ↓
                                                    Agent #4195 on XLayer
```

### Key Files:
| File | Purpose |
|------|---------|
| `src/chat-agent.ts` | DeepSeek-powered conversational agent with 8 tools |
| `src/a2mcp-server.ts` | HTTP server: bundle submission, health, status, okx-command endpoint |
| `Dockerfile` | Alpine Linux container with `onchainos` installed |
| `entrypoint.sh` | Checks onchainos wallet auth, starts heartbeat cron, launches server |
| `heartbeat.sh` | Periodic `agent heartbeat` to keep agent online |

---

## 📋 Agent Identity (#4195) — Already Registered

**Agent #4195 already exists on OKX.AI as an ASP.** The `onchainos` wallet is authenticated via Railway volume mount. Key commands:

```bash
# Check current state
onchainos agent get-agents --agent-ids 4195

# List registered services
onchainos agent service-list --agent-id 4195

# Check agent online status
onchainos wallet status
```

---

## ✅ Adding an A2MCP Service to an Existing ASP

Since #4195 already exists, you do NOT run `agent create` or `agent pre-check`. Instead use `agent update` with a `--service` JSON array containing a `create` operation:

```bash
onchainos agent update --agent-id 4195 \
  --service '[{"operation":"create","serviceName":"Jito MEV Bundle Submission","serviceDescription":"1. AI-powered Jito MEV bundle submission on Solana. Uses Hebbian tip optimization, DeepSeek failure reasoning, and gRPC-connected Jito Block Engine.\\n2. Provide signed Solana transaction(s) in base64 format.","serviceType":"A2MCP","fee":"0","endpoint":"https://your-deployment.up.railway.app/api/v1/bundle"}]'
```

### Service Schema:
| Key | Required | Description |
|-----|----------|-------------|
| `operation` | Yes | `create` / `update` / `delete` |
| `serviceName` | Yes | 5-30 chars, noun phrase |
| `serviceDescription` | Yes | 2-part: ① what it does ② what user provides |
| `serviceType` | Yes | `A2MCP` (API service) or `A2A` (agent-to-agent) |
| `fee` | A2MCP: yes | Plain number as string e.g. `"0"` (USDT), ≤6 decimals |
| `endpoint` | A2MCP only | `https://` URL, publicly reachable |
| `id` | For update/delete | Service ID from `agent service-list` |

### ❌ Commands that WILL FAIL for #4195:
- `agent pre-check --role asp` — Already have an ASP under this wallet
- `agent create` — Cannot create another ASP
- `agent validate-listing` — For initial registration only

---

## 🔄 ASP Task Lifecycle

### V2 Flow (when user creates a task):

```
1. User creates task on OKX.AI
2. Agent receives pending decision
3. Agent runs: pending-decisions-v2 request → task accept → task apply-v2
4. Agent collects signed transactions from user
5. Agent submits bundle via submit_bundle tool (Jito Block Engine)
6. Agent delivers: task deliver-v2 --proof <txHash>
```

### Chat Agent Autonomous Behavior:
When a new conversation starts, the agent automatically:
1. Runs `agent pending-decisions-v2 request --job-id recent --role asp --agent-id 4195`
2. Runs `agent get-agents --agent-ids 4195` to check listing status
3. Reports findings without being asked

---

## 🛠️ Tool Reference (Chat Agent)

| Tool | Purpose | Called Via |
|------|---------|-----------|
| `submit_bundle` | Submit MEV bundle to Jito | `POST /api/v1/bundle` |
| `check_network_health` | Solana network conditions | `GET /api/v1/health/network` |
| `get_status` | Agent uptime/stats | `GET /api/v1/status` |
| `get_insights` | Hebbian learning analytics | `GET /api/v1/insights` |
| `get_market_brief` | Crypto prices + Fear & Greed | `GET /api/v1/brief` |
| `analyze_transaction` | MEV opportunity analysis | `POST /api/v1/analyze` |
| `track_task` | Local task logging | File I/O to `tasks.json` |
| `run_okx_command` | Execute onchainos CLI | `exec()` child process |

---

## 🐳 Railway Deployment

### Docker Build:
```dockerfile
FROM node:20-alpine
RUN apk add --no-cache curl ca-certificates && \
    curl -sSL -o /usr/local/bin/onchainos \
      "https://github.com/okx/onchainos-skills/releases/download/v4.2.0/onchainos-x86_64-unknown-linux-musl" && \
    chmod +x /usr/local/bin/onchainos
```

### First-Time Wallet Setup:
```bash
railway shell
onchainos wallet login
onchainos wallet verify <OTP>
# Session persists via Railway volume mount
```

### Heartbeat:
The `entrypoint.sh` starts a heartbeat cron that runs `agent heartbeat --chain-index 196 --chain xlayer` every 5 minutes to keep the agent marked online.

---

## 📝 Common Issues & Fixes

### "command not found: onchainos"
- Check Dockerfile has the `curl` install step
- The binary should be at `/usr/local/bin/onchainos`

### "Agent update fails — cannot parse --service JSON"
- JSON keys must be camelCase (not snake_case)
- `fee` must be a **string** (quoted), not a bare number
- `id` must be a string too
- PowerShell and Alpine shell handle JSON differently — Node.js `exec` handles it fine

### Bundle submission: "Reached end of buffer unexpectedly"
- The transaction data is not valid base64-encoded Solana transaction bytes
- User needs to provide properly signed `VersionedTransaction` in base64

### Wallet session expired
- Run `railway shell` then `onchainos wallet login` again
- Session persists via Railway volume at `~/.onchainos/`

---

## 🔐 Security

- Private keys/Jito keypair never shared or logged
- API keys (`AI_API_KEY`, `JITO_AUTH_KEYPAIR_B64`) stored as Railway environment variables
- OnchainOS wallet session stored in Railway volume (persists across deploys)
- All bundle decisions recorded in SHA-256 proof chain

---

## 📚 References

- [OKX OnchainOS Docs](https://web3.okx.com/onchain-os/dev-portal)
- [OKX.AI ASP Guide](https://www.okx.ai/tutorial/asp)
- [Solana TX-Stack README](./README.md)

**Last Updated:** 2026-07-26
**Version:** 1.0
