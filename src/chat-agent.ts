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
  {
    name: 'check_agent',
    description: 'Check your OKX.AI agent status and service list. Use this to see your current listing state, service list, and approval status. Agent ID: 4195 on X Layer.',
    parameters: {
      type: 'object',
      properties: {
        detail: {
          type: 'string',
          enum: ['status', 'services', 'all'],
          description: 'What to check — "status" for agent profile, "services" for registered service list, "all" for both.'
        }
      },
      required: ['detail']
    }
  },
  {
    name: 'update_agent_service',
    description: 'Add, modify, or remove a service on your OKX.AI ASP listing. Agent #4195 ALREADY EXISTS — do NOT try to create a new agent. Use this to update services.',
    parameters: {
      type: 'object',
      properties: {
        operation: {
          type: 'string',
          enum: ['create', 'update', 'delete'],
          description: 'Add a new service (create), change an existing one (update), or remove one (delete). For create: provide all fields. For update/delete: need the service ID from check_agent.'
        },
        serviceName: {
          type: 'string',
          description: 'Service name (5-30 chars, noun phrase). Required for create and update.'
        },
        serviceDescription: {
          type: 'string',
          description: 'Two-part description on separate lines: ① what the service does and who it\'s for ② what the user must provide. Required for create and update.'
        },
        serviceType: {
          type: 'string',
          enum: ['A2MCP', 'A2A'],
          description: 'A2MCP = API service with fixed price and endpoint. A2A = agent-to-agent with negotiable pricing.'
        },
        fee: {
          type: 'string',
          description: 'Price in USDT as a plain number string (e.g. "0" for free, "1" for 1 USDT). No symbols. A2MCP requires this.'
        },
        endpoint: {
          type: 'string',
          description: 'Public HTTPS URL for the service (A2MCP only). Must be publicly reachable, https://, running 24/7.'
        },
        serviceId: {
          type: 'string',
          description: 'Existing service ID (from check_agent services). Required for update and delete operations.'
        }
      },
      required: ['operation']
    }
  },
  {
    name: 'check_tasks',
    description: 'Check your pending decisions and active tasks on OKX.AI. Shows tasks waiting for your response and active jobs.',
    parameters: {
      type: 'object',
      properties: {
        jobId: {
          type: 'string',
          description: 'Optional specific job ID to check. Use "recent" or leave empty for all pending decisions.'
        }
      }
    }
  },
  {
    name: 'accept_task',
    description: 'Accept a task on OKX.AI and proceed to complete it.',
    parameters: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          description: 'The task/job ID to accept'
        },
        price: {
          type: 'string',
          description: 'Agreed price in USDT'
        },
        proof: {
          type: 'string',
          description: 'Transaction hash or proof string for delivery (for deliver-v2 step)'
        }
      },
      required: ['taskId']
    }
  },
  {
    name: 'check_wallet',
    description: 'Check your XLayer wallet status, balance, and identity on OKX.AI.',
    parameters: {
      type: 'object',
      properties: {
        check: {
          type: 'string',
          enum: ['status', 'balance', 'identity', 'all'],
          description: 'What wallet info to check'
        }
      },
      required: ['check']
    }
  },
  {
    name: 'send_heartbeat',
    description: 'Send a heartbeat to OKX.AI to keep Agent #4195 marked as online. The heartbeat cron should handle this automatically, but use this if you need to force a heartbeat.',
    parameters: {
      type: 'object',
      properties: {}
    }
  }
];

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
You have access to these tools — use them:
1. \`submit_bundle\` — Submit MEV bundles to Jito Block Engine on Solana (base64 signed tx required)
2. \`check_network_health\` — Check Solana network health (slot, congestion, skip rate, Jito status)
3. \`get_status\` — Your own status (uptime, bundle stats, AI health, Jito connection)
4. \`get_insights\` — Hebbian learning insights + DeepSeek reasoning logs
5. \`get_market_brief\` — Crypto market snapshot (BTC, ETH, SOL, Fear & Greed)
6. \`analyze_transaction\` — DeepSeek-powered MEV opportunity analysis
7. \`track_task\` — Log tasks to the ASP tracking system (tasks.json)
8. \`check_agent\` — Check your OKX.AI agent status and registered services
9. \`update_agent_service\` — Add, modify, or remove a service on your ASP listing
10. \`check_tasks\` — Check pending decisions and active tasks
11. \`accept_task\` — Accept a task and deliver completed work
12. \`check_wallet\` — Check wallet status, balance, or identity
13. \`send_heartbeat\` — Send OKX.AI heartbeat to show online

**IMPORTANT: Agent #4195 ALREADY EXISTS as an ASP.**
You are ALREADY registered. Do NOT try to create, pre-check, or validate-listing a new agent. When asked "register A2MCP", use \`update_agent_service\` with operation=create.

### How to register an A2MCP service (3 simple steps):
1. \`check_agent detail=all\` — See current agent state
2. \`update_agent_service operation=create serviceName="..." serviceType=A2MCP fee="0" endpoint="https://..." serviceDescription="..."\` — Add the service
3. Tell the user: "A2MCP service added! It will go live after marketplace review."

### Task flow (when a user creates a task):
1. \`check_tasks\` — See pending decisions
2. \`accept_task taskId=xxx price=0\` — Accept the task
3. Execute work (submit bundle, etc.), then \`accept_task taskId=xxx proof=<txHash>\` to deliver

**What Users Must Provide for Bundle Submission:**
- Signed Solana transaction(s) in base64 format
- Tip preference in lamports (or let AI calculate optimal)
- Any specific timing/priority requirements

**Chain Support:**
- Solana (mainnet) — Jito MEV bundles ✅ Live (8 tip accounts, Frankfurt node)

**Pricing:**
- Bundle submission: FREE (review period) ❌ Not accepting payments
- Transaction analysis: FREE (review period)
- Network insights: Free

**Important Rules (DO):**
- ✅ Respond promptly and professionally
- ✅ Be transparent about delays, network congestion, or issues
- ✅ Provide bundle ID and Solscan verification links on every delivery
- ✅ Log all tasks for performance tracking via track_task tool
- ✅ Use cryptographic proofs (SHA-256) for audit trail
- ✅ When user asks "register A2MCP" → use \`update_agent_service\` tool

**Important Rules (DON'T):**
- ❌ Never share private keys, Jito keypair, API secrets, or infrastructure credentials
- ❌ Never promise guaranteed MEV extraction (market-dependent)
- ❌ Never accept payment outside OKX.AI escrow
- ❌ Never execute without user confirmation
- ❌ Never try to register/create a new agent — #4195 already exists!
- ❌ Never attempt \`wallet login\` — wallet is authenticated via Railway volume

**Behavior Rules:**
- 🟢 **BE PROACTIVE** — When greeted, immediately: (1) \`check_tasks\` for pending decisions, (2) \`check_agent detail=all\` for listing status. Report findings without being asked.
- 🟢 **ASP FLOW** — When a pending decision exists, accept it automatically and explain to the user.
- 🟢 **USE THE RIGHT TOOL** — \`check_agent\` for agent info, \`update_agent_service\` for service changes, \`check_tasks\` for pending jobs, \`check_wallet\` for wallet, \`send_heartbeat\` for online status. Don't use generic commands — each tool handles its own onchainos call internally.
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

        case 'check_agent': {
          const onchainosPath = process.env.ONCHAINOS_PATH || 'onchainos';
          let cmd: string;
          if (params.detail === 'services') {
            cmd = `${onchainosPath} agent service-list --agent-id 4195`;
          } else {
            cmd = `${onchainosPath} agent get-agents --agent-ids 4195`;
          }
          const { exec } = await import('child_process');
          try {
            const stdout = await new Promise<string>((resolve, reject) => {
              exec(cmd, { timeout: 30000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }, (error: any, stdout: string) => {
                if (error) reject({ error, stdout, stderr: error.stderr });
                else resolve(stdout);
              });
            });
            return { tool: name, success: true, result: { stdout, command: cmd } };
          } catch (e: any) {
            return { tool: name, success: false, result: null, error: e.stderr || e.message };
          }
        }

        case 'update_agent_service': {
          const onchainosPath = process.env.ONCHAINOS_PATH || 'onchainos';
          if (params.operation === 'create') {
            const svcName = params.serviceName || 'MEV Service';
            const svcDesc = params.serviceDescription || 'AI-powered Solana MEV bundle service';
            const svcType = params.serviceType || 'A2MCP';
            const svcFee = params.fee || '0';
            const svcEndpoint = params.endpoint || '';
            const serviceJson = JSON.stringify([{
              operation: 'create',
              serviceName: svcName,
              serviceDescription: svcDesc,
              serviceType: svcType,
              fee: svcFee,
              ...(svcType === 'A2MCP' && svcEndpoint ? { endpoint: svcEndpoint } : {})
            }]);
            const cmd = `${onchainosPath} agent update --agent-id 4195 --service '${serviceJson}'`;
            const { exec } = await import('child_process');
            try {
              const stdout = await new Promise<string>((resolve, reject) => {
                exec(cmd, { timeout: 60000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }, (error: any, stdout: string) => {
                  if (error) reject({ error, stdout, stderr: error.stderr });
                  else resolve(stdout);
                });
              });
              return { tool: name, success: true, result: { stdout, command: cmd, serviceAdded: { name: svcName, type: svcType, fee: svcFee } } };
            } catch (e: any) {
              return { tool: name, success: false, result: null, error: e.stderr || e.message };
            }
          } else if (params.operation === 'update' || params.operation === 'delete') {
            return { tool: name, success: false, result: null, error: 'For update/delete, first use check_agent to get the service ID, then tell me the ID and I will update this tool.' };
          }
          return { tool: name, success: false, result: null, error: 'Unknown operation' };
        }

        case 'check_tasks': {
          const onchainosPath = process.env.ONCHAINOS_PATH || 'onchainos';
          const cmd = `${onchainosPath} agent pending-decisions-v2 request --job-id ${params.jobId || 'recent'} --role asp --agent-id 4195`;
          const { exec } = await import('child_process');
          try {
            const stdout = await new Promise<string>((resolve, reject) => {
              exec(cmd, { timeout: 30000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }, (error: any, stdout: string) => {
                if (error) reject({ error, stdout, stderr: error.stderr });
                else resolve(stdout);
              });
            });
            return { tool: name, success: true, result: { stdout, command: cmd } };
          } catch (e: any) {
            return { tool: name, success: false, result: null, error: e.stderr || e.message };
          }
        }

        case 'accept_task': {
          const onchainosPath = process.env.ONCHAINOS_PATH || 'onchainos';
          let cmd: string;
          if (params.proof) {
            cmd = `${onchainosPath} task deliver-v2 ${params.taskId} --proof ${params.proof}`;
          } else if (params.price) {
            cmd = `${onchainosPath} task accept ${params.taskId} --price ${params.price}`;
          } else {
            cmd = `${onchainosPath} task accept ${params.taskId} --price 0`;
          }
          const { exec } = await import('child_process');
          try {
            const stdout = await new Promise<string>((resolve, reject) => {
              exec(cmd, { timeout: 30000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }, (error: any, stdout: string) => {
                if (error) reject({ error, stdout, stderr: error.stderr });
                else resolve(stdout);
              });
            });
            return { tool: name, success: true, result: { stdout, command: cmd } };
          } catch (e: any) {
            return { tool: name, success: false, result: null, error: e.stderr || e.message };
          }
        }

        case 'check_wallet': {
          const onchainosPath = process.env.ONCHAINOS_PATH || 'onchainos';
          let cmd: string;
          switch (params.check) {
            case 'balance': cmd = `${onchainosPath} wallet balance`; break;
            case 'identity': cmd = `${onchainosPath} identity me`; break;
            case 'status': default: cmd = `${onchainosPath} wallet status`; break;
          }
          const { exec } = await import('child_process');
          try {
            const stdout = await new Promise<string>((resolve, reject) => {
              exec(cmd, { timeout: 15000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }, (error: any, stdout: string) => {
                if (error) reject({ error, stdout, stderr: error.stderr });
                else resolve(stdout);
              });
            });
            return { tool: name, success: true, result: { stdout, command: cmd } };
          } catch (e: any) {
            return { tool: name, success: false, result: null, error: e.stderr || e.message };
          }
        }

        case 'send_heartbeat': {
          const onchainosPath = process.env.ONCHAINOS_PATH || 'onchainos';
          const cmd = `${onchainosPath} agent heartbeat --chain-index 196 --chain xlayer`;
          const { exec } = await import('child_process');
          try {
            const stdout = await new Promise<string>((resolve, reject) => {
              exec(cmd, { timeout: 15000, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }, (error: any, stdout: string) => {
                if (error) reject({ error, stdout, stderr: error.stderr });
                else resolve(stdout);
              });
            });
            return { tool: name, success: true, result: { stdout, command: cmd } };
          } catch (e: any) {
            return { tool: name, success: false, result: null, error: e.stderr || e.message };
          }
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

        default:
          return {
            tool: name,
            success: false,
            result: null,
            error: `Unknown tool: ${name}`,
          };
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
