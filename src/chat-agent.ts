/**
 * Chat Agent — The Actual "Agent" Layer
 *
 * This is the brain that sits between the user and the tools.
 * Users talk to this agent through /api/v1/chat, it uses DeepSeek
 * to understand intent, calls the appropriate tools, and responds
 * conversationally — like OpenClaw but backed by our MEV stack.
 *
 * @author Cloud99p
 * @license MIT
 */

import https from 'https';
import http from 'http';
import * as crypto from 'crypto';
import { execSync } from 'child_process';

// ===== Tool Definitions (what the agent can do) =====

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export interface ToolResult {
  tool: string;
  success: boolean;
  result: any;
  error?: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
}

export interface ChatSession {
  id: string;
  messages: ChatMessage[];
  createdAt: number;
  lastActive: number;
}

// ===== Chat Agent Configuration =====

export interface ChatAgentConfig {
  apiKey: string;           // DeepSeek API key
  model?: string;           // Default: deepseek-v4-flash
  baseUrl?: string;         // Default: https://api.deepseek.com/v1
  timeoutMs?: number;       // Default: 30000
  maxHistory?: number;      // Max messages to keep in history
}

// ===== Tools available to the agent =====

/**
 * Execute an onchainOS CLI command and return the JSON output.
 */
function execOnchainOs(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const cp = require('child_process');
    const bin = process.env.ONCHAINOS_PATH || 'onchainos';
    cp.execFile(bin, args, { maxBuffer: 10 * 1024 * 1024 }, (err: any, stdout: string, stderr: string) => {
      if (err) {
        try { resolve(JSON.parse(stderr)); }
        catch { resolve({ error: err.message, stdout: stdout.substring(0, 1000), stderr: stderr.substring(0, 500) }); }
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch {
        // Maybe it's plain text output, return as raw
        const lines = stdout.trim().split('\n').filter((l: string) => l.trim());
        resolve({ raw: lines.length <= 2 ? stdout.substring(0, 2000) : lines });
      }
    });
  });
}

const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: 'submit_bundle',
    description: 'Submit an MEV bundle to the Jito block engine on Solana. Requires signed transactions in base64 format.',
    parameters: {
      type: 'object',
      properties: {
        chain: {
          type: 'string',
          enum: ['solana'],
          description: 'Chain — Solana only'
        },
        transactions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of signed transactions in base64 format'
        },
        tipLamports: {
          type: 'number',
          description: 'Optional tip in lamports (AI calculates optimal if not provided)'
        },
        priority: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Submission priority'
        }
      },
      required: ['chain', 'transactions']
    }
  },
  {
    name: 'check_network_health',
    description: 'Check the health and status of the Solana network including slot, congestion, skip rate, and Jito connection.',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_status',
    description: 'Get the Solana MEV Agent status including uptime, bundle stats, AI status, Jito connection, and capabilities.',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_insights',
    description: 'Get Hebbian learning insights, DeepSeek reasoning logs, and pattern analysis from past bundles.',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_market_brief',
    description: 'Get a morning brief with Fear & Greed index, crypto prices (BTC, ETH, SOL), and network conditions.',
    parameters: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'analyze_transaction',
    description: 'Analyze a transaction for MEV opportunities using DeepSeek AI.',
    parameters: {
      type: 'object',
      properties: {
        chain: {
          type: 'string',
          description: 'Blockchain to analyze on'
        },
        transaction: {
          type: 'string',
          description: 'Transaction hash or raw data to analyze'
        }
      },
      required: ['chain', 'transaction']
    }
  },
  {
    name: 'track_task',
    description: 'Log a task to the ASP tracking system. Use this when a new task is created, completed, or updated.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'complete', 'cancel'],
          description: 'What to do with the task'
        },
        taskId: {
          type: 'string',
          description: 'Unique task identifier'
        },
        status: {
          type: 'string',
          description: 'Current status: new, negotiating, accepted, submitted, delivered, completed, cancelled'
        },
        user: {
          type: 'string',
          description: 'User name or address'
        },
        price: {
          type: 'string',
          description: 'Agreed price in USDT'
        },
        txHash: {
          type: 'string',
          description: 'Transaction hash if submitted'
        },
        notes: {
          type: 'string',
          description: 'Additional notes about the task'
        }
      },
      required: ['action', 'taskId']
    }
  },
  // ===== OnchainOS CLI Tools =====
  // The agent has direct access to the `onchainos` CLI, logged into Cloud's OKX account.
  // These tools expose the full CLI capability as individual function calls.

  {
    name: 'onchainos_agent_list',
    description: 'List your own agents on the OnchainOS marketplace. Returns all agents under your account with their status, approval state, IDs, and wallet.',
    parameters: { type: 'object', properties: { role: { type: 'string', enum: ['asp', 'user', 'evaluator'], description: 'Optional role filter' } } }
  },
  {
    name: 'onchainos_agent_create',
    description: 'Create a new AI agent on OnchainOS. Can create Agent Service Providers (ASP), User agents, or Evaluators. You set the name, role, description, chain, and services JSON.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Agent name' },
        role: { type: 'string', enum: ['asp', 'user', 'evaluator'], description: 'Agent role' },
        description: { type: 'string', description: 'Agent description / bio' },
        chain: { type: 'string', description: 'Blockchain (e.g. xlayer, solana)' },
        services: { type: 'string', description: 'JSON string of services. E.g. [{ "type": "a2mcp", "endpoint": "https://...", "name": "...", "fee": "0 USDT", "description": "..." }]' }
      },
      required: ['name', 'role', 'description', 'chain']
    }
  },
  {
    name: 'onchainos_agent_update',
    description: 'Update an existing agent\'s identity, services, status, or pricing on OnchainOS.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID to update' },
        name: { type: 'string', description: 'New name' },
        description: { type: 'string', description: 'New description' },
        services: { type: 'string', description: 'JSON string of updated services array' },
        status: { type: 'string', description: 'New status' },
        activate: { type: 'boolean', description: 'Re-submit for approval / activate' }
      },
      required: ['agentId']
    }
  },
  {
    name: 'onchainos_agent_search',
    description: 'Search the public agent marketplace by query. Find agents by name, keyword, or description.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] }
  },
  {
    name: 'onchainos_agent_profile',
    description: 'Get any agent\'s full profile by agent ID. Shows name, description, services, wallet, status.',
    parameters: { type: 'object', properties: { agentId: { type: 'string' } }, required: ['agentId'] }
  },
  {
    name: 'onchainos_agent_service_list',
    description: 'List all services offered by an agent. Returns service names, types (A2A/A2MCP), endpoints, and prices.',
    parameters: { type: 'object', properties: { agentId: { type: 'string' } }, required: ['agentId'] }
  },
  {
    name: 'onchainos_wallet_balance',
    description: 'Check wallet balances across all chains (XLayer, EVM, Solana). Returns token balances for the logged-in wallet.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'onchainos_wallet_status',
    description: 'Show current wallet login status, active account info, and chain configuration.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'onchainos_wallet_addresses',
    description: 'Show all wallet addresses grouped by chain category (XLayer, EVM, Solana).',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'onchainos_market_price',
    description: 'Get current price for a token by contract address. Returns price in USD, 24h change, market cap, volume.',
    parameters: { type: 'object', properties: { chain: { type: 'string' }, address: { type: 'string' } }, required: ['chain', 'address'] }
  },
  {
    name: 'onchainos_token_search',
    description: 'Search for tokens by name, symbol, or contract address. Returns token info including decimals, logo, contract details.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, chain: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] }
  },
  {
    name: 'onchainos_token_report',
    description: 'Full token due diligence report: token info + price + security scan + holder data in one shot.',
    parameters: { type: 'object', properties: { chain: { type: 'string' }, address: { type: 'string' } }, required: ['chain', 'address'] }
  },
  {
    name: 'onchainos_token_hot',
    description: 'Get hot/trending tokens ranked by social activity or trending score. Max 100 results.',
    parameters: { type: 'object', properties: { chain: { type: 'string' }, limit: { type: 'number' } } }
  },
  {
    name: 'onchainos_swap_execute',
    description: 'Execute a one-shot DEX swap: quote → approve (if needed) → swap → sign & broadcast → txHash.',
    parameters: { type: 'object', properties: { chain: { type: 'string' }, fromToken: { type: 'string' }, toToken: { type: 'string' }, amount: { type: 'string' }, slippage: { type: 'number' } }, required: ['chain', 'fromToken', 'toToken', 'amount'] }
  },
  {
    name: 'onchainos_security_token_scan',
    description: 'Batch token security scan — detect honeypots, high tax, mint risks, and other scam indicators.',
    parameters: { type: 'object', properties: { chain: { type: 'string' }, tokens: { type: 'string' } }, required: ['chain', 'tokens'] }
  },
  {
    name: 'onchainos_security_dapp_scan',
    description: 'Scan a URL/dApp for security risks — detect phishing sites, blacklisted domains.',
    parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
  },
  {
    name: 'onchainos_portfolio_total',
    description: 'Get total portfolio value for any wallet address across all supported chains.',
    parameters: { type: 'object', properties: { address: { type: 'string' }, chains: { type: 'string' } }, required: ['address'] }
  },
  {
    name: 'onchainos_signal_list',
    description: 'Get latest smart money / whale / KOL signal activity. Tracks big on-chain moves.',
    parameters: { type: 'object', properties: { chain: { type: 'string' }, limit: { type: 'number' } } }
  },
  {
    name: 'onchainos_social_news',
    description: 'Get latest crypto news feed from across the web. Filterable by coin symbol.',
    parameters: { type: 'object', properties: { symbol: { type: 'string' }, limit: { type: 'number' } } }
  },
  {
    name: 'onchainos_social_sentiment',
    description: 'Get social sentiment metrics for one or more coins — mention count, sentiment score, trending rank.',
    parameters: { type: 'object', properties: { symbols: { type: 'string' } }, required: ['symbols'] }
  },
  {
    name: 'onchainos_memepump_tokens',
    description: 'Scan meme tokens / pump.fun tokens on supported chains. Returns tokens with safety metrics, holder data, dev info.',
    parameters: { type: 'object', properties: { chain: { type: 'string' }, limit: { type: 'number' } } }
  },
  {
    name: 'onchainos_gateway_gas',
    description: 'Get current gas prices for an EVM chain. Returns gas price in gwei and estimated costs.',
    parameters: { type: 'object', properties: { chain: { type: 'string' } }, required: ['chain'] }
  },
  {
    name: 'onchainos_strategy_limit_orders',
    description: 'List open limit orders for the active Agentic Wallet account.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'onchainos_strategy_create_limit',
    description: 'Place a price-triggered limit order using the Agentic Wallet.',
    parameters: { type: 'object', properties: { chain: { type: 'string' }, baseToken: { type: 'string' }, quoteToken: { type: 'string' }, side: { type: 'string', enum: ['buy', 'sell'] }, price: { type: 'string' }, amount: { type: 'string' } }, required: ['chain', 'baseToken', 'quoteToken', 'side', 'price', 'amount'] }
  },
  {
    name: 'onchainos_competition_list',
    description: 'List active trading competitions available on Agentic Wallet. Shows prize pools, rules, timelines.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'onchainos_competition_rank',
    description: 'Check your ranking in a trading competition. Shows leaderboard and your position.',
    parameters: { type: 'object', properties: { activityId: { type: 'string' } }, required: ['activityId'] }
  },
  {
    name: 'onchainos_workflow_token_research',
    description: 'Full token due diligence workflow — combines price, security, holders, on-chain signals in one call.',
    parameters: { type: 'object', properties: { address: { type: 'string' }, chain: { type: 'string' } } }
  },
  {
    name: 'onchainos_workflow_smart_money',
    description: 'Aggregate smart money signals by token with per-token DD. Find what smart wallets are buying.',
    parameters: { type: 'object', properties: { limit: { type: 'number' } } }
  },
  {
    name: 'onchainos_workflow_wallet_analysis',
    description: 'Analyze a wallet\'s 7d/30d performance, trading behavior, and recent on-chain activity.',
    parameters: { type: 'object', properties: { address: { type: 'string' }, chain: { type: 'string' } }, required: ['address'] }
  },
  {
    name: 'onchainos_cross_chain_quote',
    description: 'Get a cross-chain bridge quote. Find the best route to move tokens between chains.',
    parameters: { type: 'object', properties: { fromChain: { type: 'string' }, toChain: { type: 'string' }, fromToken: { type: 'string' }, amount: { type: 'string' } }, required: ['fromChain', 'toChain', 'fromToken', 'amount'] }
  },
  {
    name: 'onchainos_agent_tasks',
    description: 'List all active tasks for agents under your account — shows task status, pricing, counterparty, role.',
    parameters: { type: 'object', properties: { includeTerminal: { type: 'boolean', description: 'Include completed/failed tasks' } } }
  },
  {
    name: 'onchainos_agent_jobs',
    description: 'Find/recommend public tasks on the marketplace matching your agents\' skills. Start accepting jobs as a provider.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'onchainos_mcp',
    description: 'Start the onchainOS CLI as an MCP server (Model Context Protocol). Makes all capabilities available as MCP tools via JSON-RPC 2.0 over stdio.',
    parameters: { type: 'object', properties: {} }
  }
];

/**
 * Map of onchainOS command builders — each tool name maps to the CLI args it needs.
 */
const ONCHAINOS_COMMANDS: Record<string, (p: Record<string, any>) => string[]> = {
  onchainos_agent_list: (p) => ['agent', 'get-my-agents', ...(p.role ? ['--role', p.role] : [])],
  onchainos_agent_create: (p) => {
    const args = ['agent', 'create', '--name', p.name, '--role', p.role, '--description', p.description, '--chain', p.chain || 'xlayer'];
    if (p.services) args.push('--service', p.services);
    return args;
  },
  onchainos_agent_update: (p) => {
    const args = ['agent', 'update', '--agent-id', p.agentId];
    if (p.name) args.push('--name', p.name);
    if (p.description) args.push('--description', p.description);
    if (p.services) args.push('--service', p.services);
    if (p.activate) args.push('--activate');
    return args;
  },
  onchainos_agent_search: (p) => ['agent', 'search', '--query', p.query, ...(p.limit ? ['--limit', String(p.limit)] : [])],
  onchainos_agent_profile: (p) => ['agent', 'profile', '--agent-id', p.agentId],
  onchainos_agent_service_list: (p) => ['agent', 'service-list', '--agent-id', p.agentId],
  onchainos_agent_tasks: (p) => ['agent', 'active-tasks', ...(p.includeTerminal ? ['--include-terminal'] : [])],
  onchainos_agent_jobs: (p) => ['agent', 'find-jobs'],
  onchainos_wallet_balance: () => ['wallet', 'balance'],
  onchainos_wallet_status: () => ['wallet', 'status'],
  onchainos_wallet_addresses: () => ['wallet', 'addresses'],
  onchainos_market_price: (p) => ['market', 'price', '--chain', p.chain, '--address', p.address],
  onchainos_token_search: (p) => ['token', 'search', '--query', p.query, ...(p.chain ? ['--chain', p.chain] : []), ...(p.limit ? ['--limit', String(p.limit)] : [])],
  onchainos_token_report: (p) => ['token', 'report', '--chain', p.chain, '--address', p.address],
  onchainos_token_hot: (p) => ['token', 'hot-tokens', ...(p.chain ? ['--chain', p.chain] : []), ...(p.limit ? ['--limit', String(Math.min(p.limit || 50, 100))] : [])],
  onchainos_swap_execute: (p) => ['swap', 'execute', '--chain', p.chain, '--from-token', p.fromToken, '--to-token', p.toToken, '--amount', p.amount, ...(p.slippage ? ['--slippage', String(p.slippage)] : [])],
  onchainos_security_token_scan: (p) => ['security', 'token-scan', '--chain', p.chain, '--tokens', p.tokens],
  onchainos_security_dapp_scan: (p) => ['security', 'dapp-scan', '--url', p.url],
  onchainos_portfolio_total: (p) => ['portfolio', 'total-value', '--address', p.address, ...(p.chains ? ['--chains', p.chains] : [])],
  onchainos_signal_list: (p) => ['signal', 'list', ...(p.chain ? ['--chain', p.chain] : []), ...(p.limit ? ['--limit', String(p.limit)] : [])],
  onchainos_social_news: (p) => ['social', 'news-latest', ...(p.symbol ? ['--symbol', p.symbol] : []), ...(p.limit ? ['--limit', String(p.limit)] : [])],
  onchainos_social_sentiment: (p) => ['social', 'sentiment-symbol', '--symbols', p.symbols],
  onchainos_memepump_tokens: (p) => ['memepump', 'tokens', ...(p.chain ? ['--chain', p.chain] : []), ...(p.limit ? ['--limit', String(p.limit)] : [])],
  onchainos_gateway_gas: (p) => ['gateway', 'gas', '--chain', p.chain],
  onchainos_strategy_limit_orders: () => ['strategy', 'list'],
  onchainos_strategy_create_limit: (p) => ['strategy', 'create-limit', '--chain', p.chain, '--base-token', p.baseToken, '--quote-token', p.quoteToken, '--side', p.side, '--price', p.price, '--amount', p.amount],
  onchainos_competition_list: () => ['competition', 'list'],
  onchainos_competition_rank: (p) => ['competition', 'rank', '--activity-id', p.activityId],
  onchainos_workflow_token_research: (p) => ['workflow', 'token-research', ...(p.address ? ['--address', p.address] : []), ...(p.chain ? ['--chain', p.chain] : [])],
  onchainos_workflow_smart_money: (p) => ['workflow', 'smart-money', ...(p.limit ? ['--limit', String(p.limit)] : [])],
  onchainos_workflow_wallet_analysis: (p) => ['workflow', 'wallet-analysis', '--address', p.address, ...(p.chain ? ['--chain', p.chain] : [])],
  onchainos_cross_chain_quote: (p) => ['cross-chain', 'quote', '--from-chain', p.fromChain, '--to-chain', p.toChain, '--from-token', p.fromToken, '--amount', p.amount],
  onchainos_mcp: () => ['mcp'],
};

const SYSTEM_PROMPT = `You are the Solana MEV Agent, an AI-powered MEV (Maximal Extractable Value) agent on the Solana blockchain. You have a personality — you're helpful, slightly witty, and deeply knowledgeable about Solana MEV infrastructure.

**Your Identity:**
- Name: Solana MEV Agent (Agent #4195 on OKX.AI)
- Version: 3.0.0
- Creator/Owner: Cloud99p (Emmanuel Nenpan Hosea — emmanuelhosea09@gmail.com)
- Marketplace: OKX.AI (A2A Agent-to-Agent, Finance category)
- Wallet: 0x18af8dc1b4071e8849c54d502ff0c6268f77800c (XLayer)
- Abilities: Jito MEV bundle submission, network health analysis, Hebbian tip learning, DeepSeek AI reasoning, onchainos CLI
- **Persona**: You are the Solana MEV Agent — a distinct AI agent. Never speak as if you are OpenClaw, Cloudy, or any other assistant. You are your own agent running 24/7 on Railway. When referring to yourself, use "I" or "Solana MEV Agent". When referring to your creator/owner, call him "Cloud" or "the owner".

**Your Tools:**
You have access to these tools:
1. \`submit_bundle\` — Submit MEV bundles to Jito Block Engine on Solana (base64 signed tx required)
2. \`check_network_health\` — Check Solana network health (slot, congestion, skip rate, Jito status)
3. \`get_status\` — Your own status (uptime, bundle stats, AI health, Jito connection)
4. \`get_insights\` — Hebbian learning insights + DeepSeek reasoning logs
5. \`get_market_brief\` — Crypto market snapshot (BTC, ETH, SOL, Fear & Greed)
6. \`analyze_transaction\` — DeepSeek-powered MEV opportunity analysis
7. \`track_task\` — Log tasks to the ASP tracking system (tasks.json)
8. \`onchainos_agent_list\` — List all your agents
9. \`onchainos_agent_create\` — Create new ASP/User/Evaluator agents
10. \`onchainos_agent_update\` — Update agent identity, services, pricing
11. \`onchainos_agent_search\` — Search the agent marketplace
12. \`onchainos_agent_profile\` — Get any agent's full profile by ID
13. \`onchainos_agent_service_list\` — List services offered by an agent
14. \`onchainos_agent_tasks\` — List active/completed tasks for your agents
15. \`onchainos_agent_jobs\` — Find public tasks to accept as a provider
16. \`onchainos_wallet_balance\` — Check token balances across all chains
17. \`onchainos_wallet_status\` — Show active account and login status
18. \`onchainos_wallet_addresses\` — Show all wallet addresses per chain
19. \`onchainos_market_price\` — Get current price by contract address
20. \`onchainos_token_search\` — Search tokens by name/symbol/address
21. \`onchainos_token_report\` — Full DD report (price + security + holders)
22. \`onchainos_token_hot\` — Get hot/trending tokens
23. \`onchainos_swap_execute\` — One-shot DEX swap (quote → approve → execute)
24. \`onchainos_security_token_scan\` — Batch scan tokens for scams/honeypots
25. \`onchainos_security_dapp_scan\` — Scan URLs for phishing/safety
26. \`onchainos_portfolio_total\` — Get portfolio value for any wallet
27. \`onchainos_signal_list\` — Smart money / whale / KOL activity
28. \`onchainos_social_news\` — Latest crypto news feed
29. \`onchainos_social_sentiment\` — Social sentiment metrics by coin
30. \`onchainos_memepump_tokens\` — Scan meme tokens / pump.fun
31. \`onchainos_gateway_gas\` — Check gas prices on any EVM chain
32. \`onchainos_strategy_limit_orders\` — List your open limit orders
33. \`onchainos_strategy_create_limit\` — Place a price-triggered limit order
34. \`onchainos_competition_list\` — List active trading competitions
35. \`onchainos_competition_rank\` — Check your competition ranking
36. \`onchainos_workflow_token_research\` — Full token DD workflow
37. \`onchainos_workflow_smart_money\` — Aggregate smart money signals
38. \`onchainos_workflow_wallet_analysis\` — Analyze wallet performance
39. \`onchainos_cross_chain_quote\` — Get cross-chain bridge quotes
40. \`onchainos_mcp\` — Start onchainOS as MCP server

**🔧 OnchainOS CLI — Direct Access:**
Your server has the \`onchainos\` binary installed and logged into Cloud's OKX account (wallet: 0x18af...800c). Each onchainos_* tool above maps directly to a CLI command. These are REAL commands executing against your live account.

- For agent listing/management: onchainos_agent_list, onchainos_agent_create, onchainos_agent_update
- For wallet: onchainos_wallet_balance, onchainos_wallet_status
- For tokens: onchainos_token_search, onchainos_token_report, onchainos_token_hot
- For trading: onchainos_swap_execute, onchainos_strategy_create_limit
- For security: onchainos_security_token_scan, onchainos_security_dapp_scan
- For market intel: onchainos_signal_list, onchainos_social_news, onchainos_social_sentiment
- For agents: onchainos_agent_tasks, onchainos_agent_jobs

**IMPORTANT**: Be careful with write operations (swap, create agent, limit orders) — confirm with the user first. Read-only tools (search, balance, status, news, signal) are safe to use proactively.

**IMPORTANT: Agent #4195 ALREADY EXISTS as an ASP on OKX.AI.**
You do NOT need to create or register a new agent. If asked to "register an ASP", explain that #4195 already exists and you can add services to it.

**Agent #4195 Quick Reference (X Layer, chain-index 196):**
- Wallet: 0x18af8dc1b4071e8849c54d502ff0c6268f77800c ✅ Authenticated via Railway volume
- \`onchainos agent get-agents --agent-ids 4195\` — Check current state
- \`onchainos agent service-list --agent-id 4195\` — List services
- \`onchainos agent update --agent-id 4195 --service '[{"operation":"create","serviceName":"...","serviceType":"A2MCP","fee":"0","endpoint":"https://..."}]'\` — Add A2MCP service
- \`onchainos agent heartbeat --chain-index 196 --chain xlayer\` — Heartbeat
- \`onchainos agent pending-decisions-v2 request --job-id recent --role asp --agent-id 4195\` — Check pending tasks
- \`onchainos task list\` — List all tasks
- \`onchainos wallet status\` — Check wallet
- \`onchainos identity me\` — Check identity

**Pricing:**
- Bundle submission: FREE (review period) ❌ Not accepting payments yet
- Transaction analysis: FREE
- Network insights: Free

**Important Rules (DO):**
- ✅ Respond promptly and professionally
- ✅ Be transparent about delays, network congestion, or issues
- ✅ Provide bundle ID and Solscan verification links on every delivery
- ✅ Log all tasks via track_task tool for performance tracking
- ✅ Use cryptographic proofs (SHA-256) for audit trail
- ✅ When user asks OKX marketplace operations, use the appropriate \`onchainos_*\` tool (onchainos_agent_list, onchainos_agent_update, onchainos_wallet_balance, etc.). Each CLI command has its own named tool.

**Important Rules (DON'T):**
- ❌ Never share private keys, Jito keypair, API secrets, or infrastructure credentials
- ❌ Never promise guaranteed MEV extraction (market-dependent)
- ❌ Never accept payment outside OKX.AI escrow
- ❌ Never execute without user confirmation
- ❌ Never try to register/create a new agent — #4195 already exists!

**Behavior Rules:**
- 🟢 **BE PROACTIVE** — When greeted, immediately use \`onchainos_agent_tasks\` and \`onchainos_agent_list\` to check pending decisions and listing status. Report findings without being asked.
- 🟢 **ASP FLOW** — When a pending task exists, accept it and explain to the user.
- 🟢 **USE onchainos_* tools** — For ANY OKX marketplace operation, call the specific tool: onchainos_agent_list, onchainos_agent_create, onchainos_agent_update, onchainos_agent_tasks, onchainos_wallet_balance, onchainos_token_search, etc. Each is a named function you can call directly.
- Always respond friendly and conversational
- If a tool fails, explain what happened and suggest next steps
- Format responses clearly: bullet points, tx hashes with Solscan links
- You are Solana-only — never mention Ethereum, Sepolia, KeeperHub, or EVM chains`;

// ===== Chat Agent =====

export class ChatAgent {
  private config: ChatAgentConfig;
  private sessions: Map<string, ChatSession>;
  private maxHistory: number;
  private serverUrl: string;

  constructor(config: ChatAgentConfig, serverUrl: string = 'http://localhost:9090') {
    this.config = config;
    this.sessions = new Map();
    this.maxHistory = config.maxHistory || 50;
    this.serverUrl = serverUrl;
  }

  /**
   * Handle a user message — returns the agent's response.
   * Creates a new session if one doesn't exist for the given sessionId.
   */
  async handleMessage(
    sessionId: string,
    userMessage: string
  ): Promise<{ response: string; toolCalls?: ToolResult[]; sessionId: string }> {
    // Get or create session
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        id: sessionId,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }],
        createdAt: Date.now(),
        lastActive: Date.now(),
      };
      this.sessions.set(sessionId, session);
    }

    // Add user message
    session.messages.push({ role: 'user', content: userMessage });
    session.lastActive = Date.now();

    // Trim old messages if needed (keep system prompt)
    if (session.messages.length > this.maxHistory) {
      const systemMsg = session.messages[0];
      session.messages = [systemMsg, ...session.messages.slice(-(this.maxHistory - 1))];
    }

    const toolResults: ToolResult[] = [];
    let finalResponse = '';

    try {
      // Call DeepSeek with function calling
      const completion = await this.callDeepSeek(session.messages);

      // Check if DeepSeek wants to call a tool
      if (completion.tool_calls && completion.tool_calls.length > 0) {
        // Add assistant's tool call to history
        session.messages.push({
          role: 'assistant',
          content: completion.content || '',
          tool_calls: completion.tool_calls as any,
        } as any);

        // Execute each tool call
        for (const tc of completion.tool_calls) {
          const result = await this.executeTool(tc.function.name, tc.function.arguments);
          toolResults.push(result);

          // Add tool result to history
          session.messages.push({
            role: 'tool' as any,
            tool_call_id: tc.id,
            name: tc.function.name,
            content: JSON.stringify(result),
          } as any);
        }

        // Get final response after tool execution
        const finalCompletion = await this.callDeepSeek(session.messages, false);
        finalResponse = finalCompletion.content || 'I processed your request. Check the results above.';

        // Add final response to history
        session.messages.push({ role: 'assistant', content: finalResponse });
      } else {
        // No tool call needed — direct response
        finalResponse = completion.content || "I'm not sure how to help with that. Can you rephrase?";
        session.messages.push({ role: 'assistant', content: finalResponse });
      }
    } catch (err: any) {
      console.error('[CHAT-AGENT] Error:', err.message);
      finalResponse = `Sorry, I ran into an error: ${err.message}. My tools might be temporarily unavailable — try again in a moment.`;
      session.messages.push({ role: 'assistant', content: finalResponse });
    }

    return {
      response: finalResponse,
      toolCalls: toolResults.length > 0 ? toolResults : undefined,
      sessionId,
    };
  }

  /**
   * Call DeepSeek API with optional function calling.
   */
  private async callDeepSeek(
    messages: ChatMessage[],
    allowTools: boolean = true
  ): Promise<{ content: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: any } }> }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs || 30000);

    try {
      const payload: any = {
        model: this.config.model || 'deepseek-v4-flash',
        messages,
        temperature: 0.7,
        max_tokens: 2000,
      };

      // Add function calling if tools are allowed
      if (allowTools && AGENT_TOOLS.length > 0) {
        payload.tools = AGENT_TOOLS.map(t => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        }));
        payload.tool_choice = 'auto';
      }

      const body = JSON.stringify(payload);
      const baseUrl = this.config.baseUrl || 'https://api.deepseek.com/v1';

      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const url = new URL(`${baseUrl}/chat/completions`);
        const mod = url.protocol === 'https:' ? https : http;
        const req = mod.request(
          url,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${this.config.apiKey}`,
              'Content-Length': Buffer.byteLength(body),
            },
          },
          (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => resolve({ status: res.statusCode || 500, body: d }));
          }
        );
        req.setTimeout(this.config.timeoutMs || 30000, () => {
          req.destroy();
          reject(new Error('DeepSeek API timed out'));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      clearTimeout(timeoutId);

      if (response.status !== 200) {
        throw new Error(`DeepSeek API returned ${response.status}: ${response.body.substring(0, 300)}`);
      }

      const data = JSON.parse(response.body);
      const choice = data.choices?.[0];
      const msg = choice?.message;

      return {
        content: msg?.content || null,
        tool_calls: msg?.tool_calls || undefined,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Execute a tool by calling the local server endpoints.
   */
  private async executeTool(name: string, args: string | Record<string, any>): Promise<ToolResult> {
    const params = typeof args === 'string' ? JSON.parse(args) : args;

    try {
      switch (name) {
        case 'submit_bundle': {
          const result = await this.httpPost(`${this.serverUrl}/api/v1/bundle`, {
            chain: params.chain || 'sepolia',
            to: params.to,
            value: params.value || '0',
            data: params.data,
          });
          return {
            tool: name,
            success: result.success || false,
            result: {
              txHash: result.details?.txHash || result.bundleId,
              txLink: result.details?.txLink,
              chain: result.details?.chain,
              status: result.details?.status,
              keeperhubExecutionId: result.details?.keeperhubExecutionId,
              sponsored: result.details?.sponsored,
            },
            error: result.error || result.details?.error,
          };
        }

        case 'check_network_health': {
          const result = await this.httpGet(`${this.serverUrl}/api/v1/health/network`);
          return { tool: name, success: true, result };
        }

        case 'get_status': {
          const result = await this.httpGet(`${this.serverUrl}/api/v1/status`);
          return { tool: name, success: true, result };
        }

        case 'get_insights': {
          const result = await this.httpGet(`${this.serverUrl}/api/v1/insights`);
          return { tool: name, success: true, result };
        }

        case 'get_market_brief': {
          const result = await this.httpGet(`${this.serverUrl}/api/v1/brief`);
          return { tool: name, success: true, result };
        }

        case 'analyze_transaction': {
          const result = await this.httpPost(`${this.serverUrl}/api/v1/analyze`, {
            chain: params.chain,
            tx: params.transaction,
          });
          return { tool: name, success: result.success || false, result };
        }

        default: {
          // Check if this is an onchainos command
          const cmdBuilder = ONCHAINOS_COMMANDS[name];
          if (cmdBuilder) {
            const args = cmdBuilder(params);
            const result = await execOnchainOs(args);
            return {
              tool: name,
              success: !result.error,
              result: result.error ? null : result,
              error: result.error,
            };
          }
          return {
            tool: name,
            success: false,
            result: null,
            error: `Unknown tool: ${name}`,
          };
        }

        case 'track_task': {
          const fs = await import('fs');
          const path_mod = await import('path');
          const tasksFile = path_mod.default.join(process.cwd(), 'tasks.json');
          let tasks: any = { tasks: [], completed: 0, revenue: 0 };
          try {
            if (fs.default.existsSync(tasksFile)) {
              tasks = JSON.parse(fs.default.readFileSync(tasksFile, 'utf8'));
            }
          } catch { /* use defaults */ }

          const now = new Date().toISOString();
          if (params.action === 'create') {
            tasks.tasks.push({
              id: params.taskId,
              status: params.status || 'new',
              user: params.user || 'unknown',
              price: params.price || '0',
              created: now,
              updated: now,
              txHash: params.txHash || null,
              notes: params.notes || '',
            });
          } else if (params.action === 'update' || params.action === 'complete') {
            const task = tasks.tasks.find((t: any) => t.id === params.taskId);
            if (task) {
              if (params.status) task.status = params.status;
              if (params.txHash) task.txHash = params.txHash;
              if (params.notes) task.notes = params.notes;
              task.updated = now;
              if (params.action === 'complete') {
                task.status = 'completed';
                task.completedAt = now;
                tasks.completed++;
                tasks.revenue += parseFloat(params.price || task.price || '0');
              }
            }
          } else if (params.action === 'cancel') {
            const task = tasks.tasks.find((t: any) => t.id === params.taskId);
            if (task) {
              task.status = 'cancelled';
              task.updated = now;
            }
          }

          fs.default.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
          return {
            tool: name,
            success: true,
            result: {
              message: `Task ${params.taskId} ${params.action}d`,
              totalTasks: tasks.tasks.length,
              completed: tasks.completed,
              revenue: `${tasks.revenue} USDT`,
            },
          };
        }

      }
    } catch (err: any) {
      return {
        tool: name,
        success: false,
        result: null,
        error: err.message,
      };
    }
  }

  private async httpPost(url: string, data: any): Promise<any> {
    const body = JSON.stringify(data);
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? https : http;
      const req = mod.request(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => {
            try { resolve(JSON.parse(d)); }
            catch { resolve(d); }
          });
        }
      );
      req.setTimeout(45000, () => { req.destroy(); reject(new Error('Tool request timed out')); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private async httpGet(url: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolve(JSON.parse(d)); }
          catch { resolve(d); }
        });
      });
      req.setTimeout(30000, () => { req.destroy(); reject(new Error('Tool request timed out')); });
      req.on('error', reject);
    });
  }

  /**
   * Clean up old sessions (keep last 100).
   */
  cleanup(): void {
    const now = Date.now();
    const oneHour = 60 * 60 * 1000;
    const entries = Array.from(this.sessions.entries());

    // Remove sessions older than 1 hour
    for (const [id, session] of entries) {
      if (now - session.lastActive > oneHour) {
        this.sessions.delete(id);
      }
    }

    // If still too many, remove oldest
    if (this.sessions.size > 100) {
      const sorted = Array.from(this.sessions.entries()).sort(
        (a, b) => a[1].lastActive - b[1].lastActive
      );
      for (let i = 0; i < sorted.length - 100; i++) {
        this.sessions.delete(sorted[i][0]);
      }
    }
  }

  /**
   * Get number of active sessions.
   */
  getSessionCount(): number {
    return this.sessions.size;
  }
}

// Singleton
let _chatAgent: ChatAgent | null = null;

export function getChatAgent(config?: ChatAgentConfig, serverUrl?: string): ChatAgent {
  if (!_chatAgent && config) {
    _chatAgent = new ChatAgent(config, serverUrl);
    _chatAgent.cleanup();
    // Auto-cleanup every 30 minutes
    setInterval(() => _chatAgent?.cleanup(), 30 * 60 * 1000);
  }
  if (!_chatAgent) {
    throw new Error('ChatAgent not initialized — call getChatAgent(config) first');
  }
  return _chatAgent;
}
