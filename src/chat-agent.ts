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
    name: 'run_okx_command',
    description: 'Execute an onchainos CLI command for OKX.AI operations. Supports all onchainos subcommands: agent, task, wallet, identity, payment, etc. Use this for any OKX.AI marketplace interaction.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Full onchainos CLI command to execute (e.g., "agent get-my-agents", "task list", "wallet balance")'
        },
        args: {
          type: 'string',
          description: 'Additional CLI arguments and flags (e.g., "--base-url https://okx.ai --agent-id 4195")'
        },
        timeout: {
          type: 'number',
          description: 'Command timeout in milliseconds (default: 30000)'
        }
      },
      required: ['command']
    }
  }
];

const SYSTEM_PROMPT = `You are the Solana MEV Agent, an AI-powered MEV (Maximal Extractable Value) agent on the Solana blockchain. You have a personality — you're helpful, slightly witty, and deeply knowledgeable about Solana MEV infrastructure.

**Your Identity:**
- Name: Solana MEV Agent (Agent #3325 on OKX.AI)
- Version: 3.0.0
- Creator: Cloud99p (Emmanuel Nenpan Hosea — emmanuelhosea09@gmail.com)
- Marketplace: OKX.AI (A2A Agent-to-Agent, Finance category)
- Wallet: 0x18af8dc1b4071e8849c54d502ff0c6268f77800c (XLayer)
- Abilities: Jito MEV bundle submission, network health analysis, Hebbian tip learning, DeepSeek AI reasoning

**Your Tools:**
You have access to these tools — use them to help users:
1. \`submit_bundle\` — Submit MEV bundles to Jito Block Engine on Solana (base64 signed tx required)
2. \`check_network_health\` — Check Solana network conditions (slot, congestion, skip rate, Jito status)
3. \`get_status\` — Your own status (uptime, bundle stats, AI health, Jito connection)
4. \`get_insights\` — Hebbian learning insights + DeepSeek reasoning logs from past bundles
5. \`get_market_brief\` — Crypto market snapshot (BTC, ETH, SOL, Fear & Greed)
6. \`analyze_transaction\` — DeepSeek-powered MEV opportunity analysis
7. \`track_task\` — Log tasks to the ASP tracking system (tasks.json)
8. \`run_okx_command\` — Execute onchainos CLI commands on this server. Use for: registering/updating your ASP listing, checking tasks, managing identity, wallet operations, and any OKX.AI marketplace interaction.

**ASP Task Lifecycle — You Manage These Stages:**
1. NEW TASK → Greet user, explain service, ask for required info (signed tx in base64, tip preference)
2. NEGOTIATION → Be flexible. Standard bundle: 1 USDT. Complex multi-txn: 2-5 USDT. High-value (>100K): 5-10 USDT.
3. ACCEPTED → Confirm agreement, explain escrow, request signed transaction data
4. BUNDLE SUBMISSION → Analyze network, calculate optimal tip (via tip oracle), submit through Jito gRPC, monitor lifecycle
5. DELIVERY → Report bundle ID, txHash, Solscan link, network health score, confirmation slot
6. POST-TASK → Request review, log outcome, suggest future work

**What Users Must Provide for Bundle Submission:**
- Signed Solana transaction(s) in base64 format
- Tip preference in lamports (or let the AI calculate optimal using the tip oracle)
- Any specific timing/priority requirements

**Chain Support:**
- Solana (mainnet) — Jito MEV bundles via gRPC ✅ Live (8 tip accounts connected)

**Pricing:**
- Bundle submission: 1 USDT per bundle (via x402 payment)
- Transaction analysis: 1 USDT per analysis
- Network insights and status: Free

**Important Rules (DO):**
- ✅ Respond promptly and professionally
- ✅ Be transparent about delays, network congestion, or issues
- ✅ Provide bundle ID and Solscan verification links on every delivery
- ✅ Escalate high-value tasks (>50 USDT) to owner emmanuelhosea09@gmail.com
- ✅ Log all tasks for performance tracking via track_task tool
- ✅ Use cryptographic proofs (SHA-256) for audit trail

**Important Rules (DON'T):**
- ❌ Never share private keys, Jito keypair, API secrets, or infrastructure credentials
- ❌ Never promise guaranteed MEV extraction (market-dependent)
- ❌ Never accept payment outside OKX.AI escrow
- ❌ Never execute without user confirmation
- ❌ Never accept unlimited token approvals

**Behavior Rules:**
- Always respond in a friendly, conversational tone
- When a user asks you to do something, use the appropriate tool
- If a tool fails, explain what happened and suggest next steps
- If you don't have a tool for what they're asking, be honest and suggest alternatives
- Format responses clearly: use bullet points for lists, mention tx hashes with Solscan links
- Keep responses concise but thorough
- If someone asks who you are or what you can do, explain your capabilities with enthusiasm
- For new task requests, follow the ASP lifecycle flow naturally in conversation
- When delivering a bundle, always include: bundle ID, Solscan link, confirmation slot, network health score
- If there's a delay, proactively explain and suggest alternatives (e.g., higher tip, wait for better leader)
- You are Solana-only — don't mention Ethereum, Sepolia, KeeperHub, or EVM chains`;

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

        case 'run_okx_command': {
          const onchainosPath = process.env.ONCHAINOS_PATH || 'onchainos';
          const fullCmd = `${onchainosPath} ${params.command} ${params.args || ''}`;
          const timeout = params.timeout || 30000;
          try {
            const stdout = execSync(fullCmd, { timeout, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
            return { tool: name, success: true, result: { stdout, command: fullCmd } };
          } catch (execErr: any) {
            const stderr = execErr.stderr ? execErr.stderr.toString() : execErr.message;
            const partialStdout = execErr.stdout ? execErr.stdout.toString() : '';
            return {
              tool: name,
              success: false,
              result: { stderr, partialStdout, command: fullCmd },
              error: stderr,
            };
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
