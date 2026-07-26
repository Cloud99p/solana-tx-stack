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
    name: 'run_onchainos',
    description: 'Execute an onchainos CLI command. The onchainos binary is installed at /usr/local/bin/onchainos on this server. You describe what you want in PLAIN ENGLISH and the tool helps build the right command. Use this for ALL OKX.AI marketplace operations: checking/publishing your ASP listing, managing services, handling tasks, wallet operations, identity, etc.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'What you want to do in simple terms: "check my agent status", "list my services", "add an A2MCP service", "check pending decisions", "accept task 123", "deliver task 123 with tx abc", "wallet balance", "check identity", "send heartbeat", or any other onchainos operation you need.'
        },
        subcommand: {
          type: 'string',
          enum: ['agent', 'task', 'wallet', 'identity', 'help'],
          description: 'The onchainos subcommand group. Let the tool infer from your action if unsure.'
        },
        args: {
          type: 'string',
          description: 'Optional. If you know the exact onchainos CLI args, provide them here as a string. Otherwise leave blank and the tool will use --help to discover the right syntax.'
        }
      },
      required: ['action']
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
You have access to these tools:
1. \`submit_bundle\` — Submit MEV bundles to Jito Block Engine on Solana (base64 signed tx required)
2. \`check_network_health\` — Check Solana network health (slot, congestion, skip rate, Jito status)
3. \`get_status\` — Your own status (uptime, bundle stats, AI health, Jito connection)
4. \`get_insights\` — Hebbian learning insights + DeepSeek reasoning logs
5. \`get_market_brief\` — Crypto market snapshot (BTC, ETH, SOL, Fear & Greed)
6. \`analyze_transaction\` — DeepSeek-powered MEV opportunity analysis
7. \`track_task\` — Log tasks to the ASP tracking system (tasks.json)
8. \`run_onchainos\` — Execute the onchainos CLI to manage your OKX.AI marketplace identity. This is your gateway to ALL onchainos operations (agent management, services, tasks, wallet, identity, heartbeat).

**🔧 run_onchainos — How it works:**
This tool runs the onchainos CLI installed on this server. You describe what you want in PLAIN ENGLISH and the tool helps route it. Examples:
- "check my agent status" → runs \`onchainos agent get-agents --agent-ids 4195\`
- "list my services" → runs \`onchainos agent service-list --agent-id 4195\`
- "add an A2MCP service" → runs \`onchainos agent update --agent-id 4195 --service '...'\`
- "check pending decisions" → runs \`onchainos agent pending-decisions-v2 request ...\`
- "accept task 123 for 5 USDT" → runs \`onchainos task accept 123 --price 5\`
- "wallet balance" → runs \`onchainos wallet balance\`
- "send heartbeat" → runs \`onchainos agent heartbeat --chain-index 196 --chain xlayer\`

The tool first checks the onchainos help to discover available subcommands if it doesn't know the exact syntax.

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
- ✅ When user asks OKX marketplace operations, use \`run_onchainos\` with a clear action description

**Important Rules (DON'T):**
- ❌ Never share private keys, Jito keypair, API secrets, or infrastructure credentials
- ❌ Never promise guaranteed MEV extraction (market-dependent)
- ❌ Never accept payment outside OKX.AI escrow
- ❌ Never execute without user confirmation
- ❌ Never try to register/create a new agent — #4195 already exists!

**Behavior Rules:**
- 🟢 **BE PROACTIVE** — When greeted, immediately run \`run_onchainos\` to check pending decisions and listing status. Report findings without being asked.
- 🟢 **ASP FLOW** — When a pending task exists, accept it and explain to the user.
- 🟢 **USE run_onchainos** — For ANY OKX marketplace operation (agent, task, wallet, identity, service management), just describe what you want in the action field.
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

        case 'run_onchainos': {
          const onchainosPath = process.env.ONCHAINOS_PATH || 'onchainos';
          const action = (params.action || '').toLowerCase();
          const subcommand = params.subcommand || '';
          const args = params.args || '';
          const { exec } = await import('child_process');

          // Helper: run a command and return result
          const runCmd = async (cmd: string, timeoutMs = 30000): Promise<ToolResult> => {
            try {
              const stdout = await new Promise<string>((resolve, reject) => {
                exec(cmd, { timeout: timeoutMs, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }, (error: any, stdout: string, stderr: string) => {
                  if (error) reject({ stderr, stdout, message: error.message });
                  else resolve(stdout);
                });
              });
              return { tool: name, success: true, result: { stdout, command: cmd } };
            } catch (e: any) {
              return { tool: name, success: false, result: { stderr: e.stderr || '', partialStdout: e.stdout || '' }, error: e.message || e.stderr || 'Command failed' };
            }
          };

          // Parse the action to determine the command
          try {
            // Check if args were directly provided
            if (args && subcommand) {
              return await runCmd(`${onchainosPath} ${subcommand} ${args}`, 60000);
            }

            // Intent matching from plain English action
            if (action.includes('agent') || action.includes('listing') || action.includes('service')) {
              if (action.includes('service') || action.includes('list ') || subcommand === 'service-list') {
                return await runCmd(`${onchainosPath} agent service-list --agent-id 4195`);
              }
              if (action.includes('status') || action.includes('info') || action.includes('profile') || action.includes('detail')) {
                return await runCmd(`${onchainosPath} agent get-agents --agent-ids 4195`);
              }
              if (action.includes('add') || action.includes('create') || action.includes('register') || action.includes('new service') || action.includes('a2mcp')) {
                // User wants to add a service — need more details. Return the help so DeepSeek can prompt user for service name, etc.
                return await runCmd(`${onchainosPath} agent update --help`, 10000);
              }
              if (action.includes('heartbeat') || action.includes('online') || action.includes('ping')) {
                return await runCmd(`${onchainosPath} agent heartbeat --chain-index 196 --chain xlayer`);
              }
              // Default: get full agent info
              return await runCmd(`${onchainosPath} agent get-agents --agent-ids 4195`);
            }

            if (action.includes('task') || action.includes('job') || action.includes('pending') || action.includes('decision')) {
              if (action.includes('accept') || action.includes('take')) {
                // Extract task ID if mentioned
                const idMatch = action.match(/task\s*(?:id)?\s*(\d+|\w+)/i);
                const priceMatch = action.match(/price\s*(\d+(\.\d+)?)/i) || action.match(/for\s*(\d+(\.\d+)?)\s*usdt?/i);
                const taskId = idMatch ? idMatch[1] : (subcommand || '').match(/\d+/)?.[0] || '';
                const price = priceMatch ? priceMatch[1] : '0';
                if (taskId) {
                  return await runCmd(`${onchainosPath} task accept ${taskId} --price ${price}`);
                }
              }
              if (action.includes('deliver') || action.includes('proof') || action.includes('submit')) {
                const idMatch = action.match(/task\s*(?:id)?\s*(\d+|\w+)/i);
                const hashMatch = action.match(/tx\s*(\w+)/i) || action.match(/proof\s*(\w+)/i) || action.match(/hash\s*(\w+)/i);
                const taskId = idMatch ? idMatch[1] : '';
                const proof = hashMatch ? hashMatch[1] : (args || '');
                if (taskId) {
                  return await runCmd(`${onchainosPath} task deliver-v2 ${taskId} --proof ${proof}`);
                }
              }
              // Check pending decisions
              return await runCmd(`${onchainosPath} agent pending-decisions-v2 request --job-id recent --role asp --agent-id 4195`);
            }

            if (action.includes('wallet') || action.includes('balance') || action.includes('funds')) {
              if (action.includes('balance') || action.includes('fund')) {
                return await runCmd(`${onchainosPath} wallet balance`);
              }
              if (action.includes('status') || action.includes('auth')) {
                return await runCmd(`${onchainosPath} wallet status`);
              }
              return await runCmd(`${onchainosPath} wallet status`);
            }

            if (action.includes('identity') || action.includes('who am i') || action.includes('me')) {
              return await runCmd(`${onchainosPath} identity me`);
            }

            if (action.includes('help') || action.includes('what can') || action.includes('commands')) {
              return await runCmd(`${onchainosPath} --help`, 10000);
            }

            // Fallback: try to run the action as a direct onchainos command
            if (subcommand) {
              return await runCmd(`${onchainosPath} ${subcommand} ${args}`, 60000);
            }

            return {
              tool: name,
              success: false,
              result: null,
              error: `I couldn't understand "${action}". Try: "check my agent status", "list my services", "check pending tasks", "wallet balance", "add an A2MCP service with name...", or describe what you need.`,
            };
          } catch (e: any) {
            return { tool: name, success: false, result: null, error: e.message };
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
