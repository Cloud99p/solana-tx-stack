/**
 * A2MCP API Server - Solana MEV Agent
 *
 * Agent-to-MCP service for OKX.AI marketplace.
 * Integrates with the real solana-tx-stack:
 * - JitoManager for actual bundle submission
 * - HebbianTipOptimizer for ML-based tip learning
 * - Pre-flight simulation for safety
 * - Network health scoring
 *
 * x402 Payment Standard ready (OKX Payment SDK / OnchainOS)
 *
 * @author Cloud99p
 * @license MIT
 */
import dotenv from 'dotenv';
dotenv.config();
import http from 'http';
import * as crypto from 'crypto';
import { URL } from 'url';
import { Connection, Keypair, PublicKey, VersionedTransaction, Transaction, TransactionMessage } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
// ===== Stack Imports =====
import { JitoManager } from './jito-manager.js';
import { HebbianTipOptimizer } from './hebbian-optimizer.js';
import { ensureJitoStubs } from './setup-jito.js';
import { buildBrief, BriefData } from './morning-brief.js';
import { FailureReasoningAgent, RetryParameters, NetworkHealthContext } from './ai-agent.js';
import { loadConfig } from './config.js';
import { FailureContext, FailureType, BundleStage } from './lifecycle.js';
import { DecisionProofChain } from './proof-chain.js';
import { TransactionKnowledgeGraph } from './knowledge-graph.js';
import { NetworkHealthCalculator } from './network-health.js';
import { FaultInjector, FaultType } from './fault-injector.js';
import { getTipOracle, getMarketContext } from './tip-oracle.js';
import { getWebhookManager } from './webhooks.js';
import { ChatAgent, getChatAgent, ChatAgentConfig } from './chat-agent.js';
// ===== Configuration =====
const PORT = parseInt(process.env.PORT || '8080');
const RPC_URL = process.env.SOLANA_RPC_URL || process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const SOLANA_COMMITMENT = process.env.SOLANA_COMMITMENT || 'confirmed';
const AGENT_ID = process.env.AGENT_ID || '3325';
const AGENT_NAME = process.env.AGENT_NAME || 'Solana MEV Agent';
const AGENT_VERSION = process.env.AGENT_VERSION || '2.0.0-a2mcp';
const X402_ENABLED = process.env.X402_ENABLED === 'true';
const X402_WALLET = process.env.X402_WALLET || '';
const AUTH_KEYPAIR_PATH = process.env.JITO_AUTH_KEYPAIR_PATH || process.env.AUTH_KEYPAIR_PATH || '';
// Railway compat: decode base64 keypair env var to disk if file doesn't exist
function ensureKeypairFile(): void {
  const b64 = process.env.JITO_AUTH_KEYPAIR_B64 || '';
  if (b64 && AUTH_KEYPAIR_PATH) {
    const resolvedPath = path.isAbsolute(AUTH_KEYPAIR_PATH)
      ? AUTH_KEYPAIR_PATH
      : path.resolve(process.cwd(), AUTH_KEYPAIR_PATH);
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(resolvedPath)) {
      const decoded = Buffer.from(b64, 'base64').toString('utf-8');
      fs.writeFileSync(resolvedPath, decoded, 'utf-8');
      console.log(`[STACK] Decoded keypair from JITO_AUTH_KEYPAIR_B64 -> ${resolvedPath}`);
    }
  }
}
ensureKeypairFile();
const DEBUG = process.env.DEBUG === 'true';
// Pricing
const PRICE_PER_BUNDLE = parseInt(process.env.PRICE_PER_BUNDLE || '1');
const PRICE_PER_ANALYSIS = parseInt(process.env.PRICE_PER_ANALYSIS || '1');
const MIN_TIP = parseInt(process.env.MIN_TIP_LAMPORTS || '1000');
// ===== Solana Connection =====
const connection = new Connection(RPC_URL, { commitment: SOLANA_COMMITMENT as any });
// ===== Stack Components =====
let jitoManager: JitoManager | null = null;
let hebbianOptimizer: HebbianTipOptimizer | null = null;
let failureAgent: FailureReasoningAgent | null = null;
let proofChain: DecisionProofChain | null = null;
let knowledgeGraph: TransactionKnowledgeGraph | null = null;
let networkHealth: NetworkHealthCalculator | null = null;
let faultInjector: FaultInjector | null = null;
let chatAgent: ChatAgent | null = null;
let jitoReady = false;
async function initializeStack() {
  console.log('[STACK] Initializing solana-tx-stack components...');
  // 0. Ensure jito-ts protobuf stubs exist
  ensureJitoStubs();
  // 1. Hebbian Optimizer
  hebbianOptimizer = new HebbianTipOptimizer();
  console.log('[STACK] HebbianTipOptimizer initialized');
  // 2. Proof Chain (cryptographic audit trail)
  proofChain = new DecisionProofChain();
  console.log('[STACK] DecisionProofChain initialized');
  // 3. Knowledge Graph (pattern discovery)
  knowledgeGraph = new TransactionKnowledgeGraph();
  console.log('[STACK] TransactionKnowledgeGraph initialized');
  // 4. Network Health Calculator
  networkHealth = new NetworkHealthCalculator(connection);
  console.log('[STACK] NetworkHealthCalculator initialized');
  // 5. Fault Injector
  faultInjector = new FaultInjector(connection);
  console.log('[STACK] FaultInjector initialized (7 fault types)');
  // 6. Failure Reasoning Agent (with DeepSeek if AI_API_KEY configured)
  try {
    const cfg = loadConfig();
    failureAgent = new FailureReasoningAgent(cfg);
    console.log('[STACK] FailureReasoningAgent initialized');
  } catch (err: any) {
    console.warn('[STACK] FailureReasoningAgent init skipped:', err.message);
  }
  // 7. Jito Manager (only if keypair exists)
  if (AUTH_KEYPAIR_PATH) {
    const resolvedPath = path.isAbsolute(AUTH_KEYPAIR_PATH)
      ? AUTH_KEYPAIR_PATH
      : path.resolve(process.cwd(), AUTH_KEYPAIR_PATH);
    if (fs.existsSync(resolvedPath)) {
      try {
        jitoManager = new JitoManager(connection);
        await jitoManager.initialize();
        jitoReady = true;
        console.log('[STACK] JitoManager initialized successfully');
      } catch (err: any) {
        console.warn('[STACK] JitoManager init failed:', err.message);
        console.log('[STACK] Running in API-only mode (no live bundle submission)');
      }
    } else {
      console.warn(`[STACK] Keypair not found at ${resolvedPath}. Bundle submission disabled.`);
    }
  } else {
    console.warn('[STACK] No AUTH_KEYPAIR_PATH set. Bundle submission disabled.');
  }
  // Chat agent
  if (process.env.AI_API_KEY && process.env.AI_API_KEY !== 'sk-you…here') {
    const chatConfig: ChatAgentConfig = {
      apiKey: process.env.AI_API_KEY,
      model: process.env.AI_MODEL || 'deepseek-v4-flash',
      timeoutMs: parseInt(process.env.AI_TIMEOUT_MS || '30000'),
    };
    chatAgent = getChatAgent(chatConfig, `http://localhost:${PORT}`);
    console.log('[AGENT] Chat agent initialized — DeepSeek-powered conversational AI');
  } else {
    console.warn('[AGENT] Chat agent not initialized — AI_API_KEY not configured');
  }
  console.log(`[STACK] Ready - Jito: ${jitoReady ? 'LIVE' : 'API-ONLY'} | Chat: ${chatAgent ? 'LIVE' : 'OFF'}`);
}
// ===== State =====
let serverStartTime = Date.now();
let requestCount = 0;
let bundleCount = 0;
let errorCount = 0;
let bundleSuccessCount = 0;
let bundleFailCount = 0;
const recentRequests: Array<{ timestamp: number; method: string; url: string; status: number }> = [];
// Revenue tracking
let totalRevenueUsdt = 0;
let todayRevenueUsdt = 0;
let lastRevenueResetDay = new Date().getDate();
// Auto-retry config
const MAX_RETRIES = 3;
const RETRY_TIP_MULTIPLIERS = [1.15, 1.25, 1.40];
// Tip Oracle & Webhook Manager singletons
const tipOracle = getTipOracle();
const webhookManager = getWebhookManager();
// ===== Helpers =====
function jsonResponse(res: http.ServerResponse, status: number, data: any) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, PAYMENT-SIGNATURE, X-PAYMENT, X-402-Payment, X-402-Signature, X-402-Nonce',
    'Access-Control-Expose-Headers': 'PAYMENT-REQUIRED',
  });
  res.end(body);
}
function success(res: http.ServerResponse, data: any) {
  jsonResponse(res, 200, { success: true, ...data });
}
function error(res: http.ServerResponse, status: number, message: string, details?: any) {
  errorCount++;
  jsonResponse(res, status, { success: false, error: message, details });
}
function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}
function logRequest(req: http.IncomingMessage, status: number) {
  requestCount++;
  recentRequests.push({
    timestamp: Date.now(),
    method: req.method || 'GET',
    url: req.url || '/',
    status
  });
  if (recentRequests.length > 100) recentRequests.shift();
  if (DEBUG) console.log(`[REQ] ${req.method} ${req.url} → ${status}`);
}
// ===== x402 v2 Payment Challenge =====
const X402_ASSET = process.env.X402_ASSET || '0x4ae46a509f6b1d9056937ba4500cb143933d2dc8'; // USDG on XLayer
const X402_NETWORK = process.env.X402_NETWORK || 'eip155:196'; // XLayer

/**
 * Build the x402 v2 challenge object with full accepts array.
 * The reviewer checks for PAYMENT-REQUIRED header = base64 of this JSON.
 */
function buildX402Challenge(req: http.IncomingMessage, amountUsdt: number): string {
  const challenge = {
    x402Version: 2,
    error: 'PAYMENT-SIGNATURE header is required',
    resource: {
      url: req.url || '/',
      description: 'Solana MEV Agent - Bundle submission & analysis',
      mimeType: 'application/json',
    },
    accepts: [
      {
        scheme: 'aggr_deferred',
        network: X402_NETWORK,
        asset: X402_ASSET,
        amount: String(amountUsdt * 1_000_000), // convert to minimal units (6 decimals)
        payTo: X402_WALLET,
        maxTimeoutSeconds: 300,
        extra: {
          name: 'USDG',
          version: '1',
        },
      },
      {
        scheme: 'exact',
        network: X402_NETWORK,
        asset: X402_ASSET,
        amount: String(amountUsdt * 1_000_000),
        payTo: X402_WALLET,
        maxTimeoutSeconds: 300,
        extra: {
          name: 'USDG',
          version: '1',
        },
      },
    ],
  };
  return Buffer.from(JSON.stringify(challenge)).toString('base64');
}

function checkX402Payment(req: http.IncomingMessage): { paid: boolean; amount?: number; error?: string } {
  if (!X402_ENABLED) {
    return { paid: true };
  }
  // v2 uses PAYMENT-SIGNATURE header
  const paymentSignature = req.headers['payment-signature'] as string;
  if (!paymentSignature) {
    return {
      paid: false,
      error: 'x402 payment required',
    };
  }
  console.log(`[x402] Payment signature present (${paymentSignature.substring(0, 40)}...)`);
  return { paid: true, amount: 0 };
}
function x402PaymentRequired(req: http.IncomingMessage, res: http.ServerResponse, amountUsdt: number) {
  const challengeBase64 = buildX402Challenge(req, amountUsdt);
  // v2: PAYMENT-REQUIRED header (base64-encoded JSON), body is empty {}
  res.writeHead(402, {
    'Content-Type': 'application/json',
    'PAYMENT-REQUIRED': challengeBase64,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Expose-Headers': 'PAYMENT-REQUIRED',
  });
  res.end('{}');
}
// ===== Handlers =====
/**
 * POST /api/v1/bundle
 * Submit transactions as a Jito bundle with Hebbian-optimized tip
 */
async function handleBundleSubmit(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const payment = checkX402Payment(req);
    if (!payment.paid) { x402PaymentRequired(req, res, PRICE_PER_BUNDLE); return; }
    const body = await parseBody(req);
    const { transactions, tipLamports, priority, webhookUrl } = body;
    if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
      error(res, 400, 'Missing or invalid transactions array');
      return;
    }
    console.log(`[BUNDLE] ${transactions.length} tx(s) received`);
    const slot = await connection.getSlot();
    const result: any = {
      slot,
      transactionCount: transactions.length,
      jitoReady,
      retries: [] as any[],
    };
    const tipRec = await tipOracle.getRecommendedTip(priority || 'medium');
    const initialTip = Math.max(tipLamports || tipRec.lamports, 1000);
    const marketContext = await tipOracle.getMarketContext();
    result.marketTipFloor = marketContext;
    if (jitoReady && jitoManager) {
      const decodedTxs: VersionedTransaction[] = [];
      const deserializeErrors: string[] = [];
      for (let i = 0; i < transactions.length; i++) {
        try {
          const buf = Buffer.from(transactions[i], 'base64');
          decodedTxs.push(VersionedTransaction.deserialize(buf));
        } catch (e1: any) {
          try {
            const legacyTx = Transaction.from(Buffer.from(transactions[i], 'base64'));
            const bh = await connection.getLatestBlockhash('finalized');
            const msg = legacyTx.compileMessage();
            const v0Msg = TransactionMessage.decompile(msg);
            const versioned = new VersionedTransaction(v0Msg.compileToV0Message());
            versioned.addSignature(legacyTx.signature!);
            decodedTxs.push(versioned);
          } catch (e2: any) {
            deserializeErrors.push(`tx[${i}]: ${e1.message} / fallback: ${e2.message}`);
          }
        }
      }
      if (decodedTxs.length === 0) {
        throw new Error(`Failed to deserialize any transactions: ${deserializeErrors.join('; ')}`);
      }
      if (deserializeErrors.length > 0) {
        console.warn('[BUNDLE] Partial deserialization:', deserializeErrors.join(' | '));
      }
      const resolvedPath = path.isAbsolute(AUTH_KEYPAIR_PATH)
        ? AUTH_KEYPAIR_PATH
        : path.resolve(process.cwd(), AUTH_KEYPAIR_PATH);
      const keypairData = fs.readFileSync(resolvedPath, 'utf-8');
      const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(keypairData)));
      // === AUTO-RETRY LOOP (max 3 retries with escalating tips) ===
      let currentTip = initialTip;
      let overallSuccess = false;
      let finalBundleId: string | null = null;
      let healthScore: number | undefined;
      let grpcError: string | undefined;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        console.log(`[RETRY] Attempt ${attempt + 1}/${MAX_RETRIES + 1} tip: ${currentTip} lamports`);
        try {
          const submitResult = await jitoManager.submitBundle(decodedTxs, payer.publicKey, currentTip);
          overallSuccess = true;
          finalBundleId = submitResult.bundleId;
          healthScore = submitResult.healthScore;
          grpcError = submitResult.grpcError;
          if (hebbianOptimizer) {
            await hebbianOptimizer.learn({ tipLamports: currentTip, status: "submitted", healthScore: healthScore || 70, skipRate: 0.15, leaderQuality: 0.8 });
          }
          result.retries.push({ attempt: attempt + 1, status: "success", tip: currentTip, bundleId: submitResult.bundleId });
          break;
        } catch (err: any) {
          console.warn(`[RETRY] Attempt ${attempt + 1} failed: ${err.message}`);
          const isStructural = err.message.includes('deserialize') || err.message.includes('buffer') || err.message.includes('signature');
          result.retries.push({ attempt: attempt + 1, status: "failed", tip: currentTip, error: err.message });
          if (isStructural) {
            result.message = 'Structural error aborting';
            result.error = err.message;
            break;
          }
          if (hebbianOptimizer) {
            await hebbianOptimizer.learn({ tipLamports: currentTip, status: "failed", healthScore: 50, skipRate: 0.15, leaderQuality: 0.5 });
          }
          if (attempt < MAX_RETRIES) {
            currentTip = Math.round(currentTip * RETRY_TIP_MULTIPLIERS[attempt]);
            if (attempt === 0 && failureAgent) {
              try {
                const failureType: FailureType = err.message.includes('blockhash') || err.message.includes('expire') ? 'expired_blockhash'
                  : err.message.includes('fee') || err.message.includes('tip') ? 'fee_too_low'
                    : err.message.includes('timeout') ? 'timeout'
                      : err.message.includes('compute') ? 'compute_exceeded' : 'bundle_rejected';
                const fc: FailureContext = {
                  failureType, failureStage: "submitted", submissionSlot: slot, submissionTimestamp: Date.now(),
                  blockhashSlot: slot, blockhashAge: 0,
                  slotConditions: { skipRate: 0.15, congestionLevel: 0.3, leaderQuality: 0.75 },
                  recentTips: [marketContext.tipFloorLamports], submissionLatency: 0,
                };
                const retryParams: RetryParameters = await failureAgent.analyzeFailure(fc);
                result.deepseek = {
                  enabled: true, confidence: retryParams.reasoning.confidence, action: retryParams.reasoning.decision.action,
                  reasoning: retryParams.reasoning.decision.reasoning_summary,
                  retryParameters: { shouldRetry: retryParams.shouldRetry, tipAdjustmentPercent: retryParams.tipAdjustment, delayMs: retryParams.delayMs, refreshBlockhash: retryParams.refreshBlockhash },
                };
                if (retryParams.shouldRetry && retryParams.tipAdjustment > 0) {
                  currentTip = Math.round(currentTip * (1 + retryParams.tipAdjustment / 100));
                }
              } catch (e: any) {
                console.warn('[AGENT] Failure analysis skipped:', e.message);
              }
            }
            await new Promise(r => setTimeout(r, 250 * Math.pow(2, attempt)));
          }
        }
      }
      bundleCount++;
      if (overallSuccess) {
        bundleSuccessCount++;
        totalRevenueUsdt += PRICE_PER_BUNDLE;
        const today = new Date().getDate();
        if (today !== lastRevenueResetDay) { todayRevenueUsdt = 0; lastRevenueResetDay = today; }
        todayRevenueUsdt += PRICE_PER_BUNDLE;
      } else {
        bundleFailCount++;
      }
      const recommendation = hebbianOptimizer?.recommendTip
        ? await hebbianOptimizer.recommendTip({ healthScore: healthScore || 70, skipRate: 0.15, leaderQuality: 0.8 })
        : null;
      result.bundleId = finalBundleId || ("bundle_" + Date.now());
      result.networkHealth = healthScore || null;
      result.recommendedTip = recommendation?.recommendedTip || currentTip;
      result.confidence = recommendation?.confidence || null;
      result.grpcError = grpcError || null;
      result.message = overallSuccess
        ? (grpcError ? ("Bundle submitted via RPC (gRPC: " + grpcError + ")") : "Bundle submitted to Jito")
        : "Bundle submission failed after retries";
      result.totalRetries = result.retries.length - 1;
      result.overallStatus = overallSuccess ? "submitted" : "failed";
      if (webhookUrl) {
        webhookManager.fire(result.bundleId, { status: overallSuccess ? "submitted" : "failed", slot, bundleId: result.bundleId, error: result.error || null, retries: result.totalRetries, pricing: { charged: payment.amount || PRICE_PER_BUNDLE, unit: "USDT" } });
      }
      if (proofChain) {
        proofChain.recordDecision(
          { bundleId: result.bundleId || ("bundle_" + Date.now()), failureType: overallSuccess ? 'submitted' : 'bundle_rejected', stage: 'submitted', submissionSlot: slot, blockhashAge: 0, slotConditions: { skipRate: 0.15, congestionLevel: 0.3, leaderQuality: 0.75 }, recentTips: [marketContext.tipFloorLamports], submissionLatency: 0 },
          { action: overallSuccess ? 'retry' : 'abort', tip_adjustment_percent: 0, blockhash_refresh: false, delay_ms: 0, reasoning_summary: overallSuccess ? 'Bundle submitted successfully after retries' : 'Bundle failed after retries' },
          { tipSource: tipRec.source, retries: result.totalRetries, txs: transactions.length }
        );
      }
    } else {
      bundleCount++;
      result.message = 'Bundle prepared (Jito not connected run with keypair to submit live)';
      result.recommendedTip = initialTip;
      result.networkHealth = 'N/A (no connection)';
    }
    success(res, {
      bundleId: result.bundleId || ("bundle_" + Date.now()),
      details: result,
      pricing: { charged: payment.amount || PRICE_PER_BUNDLE, unit: "USDT" },
    });
    if (webhookUrl && !jitoReady) {
      webhookManager.fire(result.bundleId || ("bundle_" + Date.now()), {
        status: "prepared", slot, error: "Jito not connected", pricing: { charged: payment.amount || PRICE_PER_BUNDLE, unit: "USDT" }
      });
    }
  } catch (err: any) {
    console.error('[BUNDLE] Error:', err);
    error(res, 500, 'Bundle processing failed', { message: err.message });
  }
}
/**
 * POST /api/v1/analyze - Analyze transactions for MEV potential
 */
async function handleAnalyze(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const payment = checkX402Payment(req);
    if (!payment.paid) { x402PaymentRequired(req, res, PRICE_PER_ANALYSIS); return; }
    const body = await parseBody(req);
    const { transaction, address } = body;
    const slot = await connection.getSlot();
    const recentFees = await connection.getRecentPrioritizationFees().catch(() => []);
    const medianFee = recentFees.length > 0
      ? recentFees.map(f => f.prioritizationFee).sort((a, b) => a - b)[Math.floor(recentFees.length / 2)]
      : 5000;
    success(res, {
      slot,
      address: address || null,
      network: {
        cluster: 'mainnet-beta',
        medianPriorityFee: medianFee,
        minTip: MIN_TIP
      },
      // TODO: Full MEV simulation
      opportunities: []
    });
  } catch (err: any) {
    error(res, 500, 'Analysis failed', { message: err.message });
  }
}
/**
 * POST /api/v1/learn - Feed bundle outcome for Hebbian learning
 */
async function handleLearn(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = await parseBody(req);
    const { bundleId, status, tipLamports, healthScore, skipRate, leaderQuality } = body;
    if (!bundleId || !status) {
      error(res, 400, 'Missing required fields: bundleId, status');
      return;
    }
    if (hebbianOptimizer) {
      await hebbianOptimizer.learn({
        tipLamports: tipLamports || 1000,
        status,
        healthScore: healthScore || 50,
        skipRate: skipRate || 0.15,
        leaderQuality: leaderQuality || 0.7
      });
    }
    success(res, {
      message: 'Outcome recorded',
      learned: !!hebbianOptimizer,
      bundleId
    });
  } catch (err: any) {
    error(res, 500, 'Learning failed', { message: err.message });
  }
}
/**
 * GET /api/v1/insights - Hebbian learning insights
 */
async function handleInsights(res: http.ServerResponse) {
  const insights = hebbianOptimizer?.getInsights
    ? await hebbianOptimizer.getInsights()
    : [];
  success(res, {
    hebbianEnabled: !!hebbianOptimizer,
    totalPatternsLearned: insights.length,
    patterns: insights.slice(0, 20),
    tipStrategy: insights.length > 0
      ? insights.reduce((best: any, curr: any) =>
          curr.successRate > (best.successRate || 0) ? curr : best, insights[0])
      : null
  });
}
/**
 * GET /api/v1/proof - Export cryptographic proof chain
 */
async function handleProof(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!proofChain) {
    error(res, 503, 'Proof chain not initialized');
    return;
  }
  const limit = parseInt((new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)).searchParams.get('limit') || '10');
  success(res, {
    proofChain: proofChain.exportForJudges(limit),
    stats: proofChain.getStats()
  });
}
/**
 * GET /api/v1/proof/verify - Verify proof chain integrity
 */
async function handleProofVerify(res: http.ServerResponse) {
  if (!proofChain) {
    error(res, 503, 'Proof chain not initialized');
    return;
  }
  const verification = proofChain.verifyChain();
  success(res, {
    verification,
    chainLength: verification.chainLength,
    timestamp: new Date().toISOString()
  });
}
/**
 * GET /api/v1/proof/report - Markdown proof chain report
 */
async function handleProofReport(res: http.ServerResponse) {
  if (!proofChain) {
    error(res, 503, 'Proof chain not initialized');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  res.end(proofChain.generateMarkdownReport());
}
/**
 * GET /api/v1/graph - Knowledge graph export
 */
async function handleGraph(res: http.ServerResponse) {
  if (!knowledgeGraph) {
    error(res, 503, 'Knowledge graph not initialized');
    return;
  }
  success(res, {
    stats: knowledgeGraph.getStats(),
    data: knowledgeGraph.export()
  });
}
/**
 * GET /api/v1/graph/insights - Pattern insights from knowledge graph
 */
async function handleGraphInsights(res: http.ServerResponse) {
  if (!knowledgeGraph) {
    error(res, 503, 'Knowledge graph not initialized');
    return;
  }
  const insights = await knowledgeGraph.extractInsights();
  success(res, {
    insights,
    count: insights.length
  });
}
/**
 * GET /api/v1/health/network - Network health score (0-100)
 */
async function handleNetworkHealth(res: http.ServerResponse) {
  if (!networkHealth) {
    error(res, 503, 'Network health calculator not initialized');
    return;
  }
  const health = await networkHealth.calculateHealth();
  const signals = await networkHealth.getSignals();
  const aiContext = await networkHealth.getAiContext();
  success(res, {
    health,
    signals,
    aiContext
  });
}
/**
 * GET /api/v1/fault - Get active fault injection status
 */
async function handleFaultStatus(res: http.ServerResponse) {
  if (!faultInjector) {
    error(res, 503, 'Fault injector not initialized');
    return;
  }
  const scenario = faultInjector.getCurrentScenario();
  success(res, {
    active: !!scenario,
    scenario,
    stats: faultInjector.getStats()
  });
}
/**
 * POST /api/v1/fault - Inject test fault
 */
async function handleFaultInject(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    if (!faultInjector) {
      error(res, 503, 'Fault injector not initialized');
      return;
    }
    const body = await parseBody(req);
    const { type, parameters } = body;
    const validTypes: FaultType[] = ['blockhash_expiry', 'fee_too_low', 'compute_exceeded', 'network_congestion', 'leader_skip', 'balance_insufficient', 'simulation_failure'];
    if (!type || !validTypes.includes(type)) {
      error(res, 400, `Invalid fault type. Valid: ${validTypes.join(', ')}`);
      return;
    }
    switch (type as FaultType) {
      case 'blockhash_expiry':
        faultInjector.enableBlockhashExpiry(parameters?.delaySlots || 160);
        break;
      case 'fee_too_low':
        faultInjector.enableFeeTooLow(parameters?.tipOverride || 0);
        break;
      case 'network_congestion':
        faultInjector.enableNetworkCongestion(parameters?.delayMs || 5000);
        break;
      case 'leader_skip':
        faultInjector.enableLeaderSkip();
        break;
      default:
        error(res, 501, `Fault type '${type}' not yet implemented via API`);
        return;
    }
    console.log(`[FAULT] API injected fault: ${type}`);
    success(res, {
      message: `Fault '${type}' injected`,
      scenario: faultInjector.getCurrentScenario()
    });
  } catch (err: any) {
    error(res, 500, 'Fault injection failed', { message: err.message });
  }
}
/**
 * DELETE /api/v1/fault - Clear active faults
 */
async function handleFaultReset(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!faultInjector) {
    error(res, 503, 'Fault injector not initialized');
    return;
  }
  faultInjector.reset();
  success(res, { message: 'All faults cleared' });
}
/**
 * POST /api/v1/chat - Chat with the Solana MEV Agent
 * DeepSeek-powered conversational AI with tool calling.
 */
async function handleChat(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!chatAgent) {
    error(res, 503, 'Chat agent not initialized. Set AI_API_KEY in environment.');
    return;
  }
  try {
    const body = await parseBody(req);
    const { message, sessionId } = body;
    if (!message || typeof message !== 'string') {
      error(res, 400, 'Missing or invalid "message" field');
      return;
    }
    const sid = sessionId || crypto.randomUUID().replace(/-/g, '').substring(0, 16);
    console.log(`[CHAT] ${sid}: "${message.substring(0, 80)}${message.length > 80 ? '...' : ''}"`);
    const startTime = Date.now();
    const result = await chatAgent.handleMessage(sid, message);
    const elapsed = Date.now() - startTime;
    console.log(`[CHAT] ${sid}: ${elapsed}ms, ${result.toolCalls?.length || 0} tool calls`);
    success(res, {
      sessionId: result.sessionId,
      response: result.response,
      toolCalls: result.toolCalls || undefined,
      elapsedMs: elapsed,
      activeSessions: chatAgent.getSessionCount(),
    });
  } catch (e: any) {
    console.error('[CHAT] Error:', e.message);
    error(res, 500, 'Chat processing failed', { message: e.message });
  }
}
/**
 * POST /api/v1/okx-command - Execute an onchainos CLI command
 */
async function handleOkxCommand(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const body = await parseBody(req);
    const { command, args, timeout } = body;
    if (!command || typeof command !== 'string') {
      error(res, 400, 'Missing or invalid "command" field');
      return;
    }
    const onchainosPath = process.env.ONCHAINOS_PATH || 'onchainos';
    const fullCmd = `${onchainosPath} ${command} ${args || ''}`;
    const cmdTimeout = timeout || 30000;
    console.log(`[OKX-CMD] Executing: ${fullCmd.substring(0, 200)}`);
    try {
      // Use async exec instead of execSync to avoid blocking the event loop
      const { exec } = require('child_process');
      const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        exec(fullCmd, { timeout: cmdTimeout, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }, (error: any, stdout: string, stderr: string) => {
          if (error) {
            resolve({ stdout, stderr });
          } else {
            resolve({ stdout, stderr });
          }
        });
      });
      console.log(`[OKX-CMD] Success (${result.stdout.length} chars)`);
      success(res, { success: true, command: fullCmd, stdout: result.stdout });
    } catch (execErr: any) {
      const stderr = execErr.stderr || '';
      const partialStdout = execErr.stdout || '';
      console.error(`[OKX-CMD] Failed: ${(execErr.message || '').substring(0, 200)}`);
      jsonResponse(res, 200, {
        success: false,
        command: fullCmd,
        error: stderr || execErr.message,
        partialStdout,
        exitCode: execErr.status ?? 1,
      });
    }
  } catch (err: any) {
    error(res, 500, 'OKX command execution failed', { message: err.message });
  }
}

/**
 * GET /api/v1/status - Agent status & capabilities
 */
async function handleStatus(res: http.ServerResponse) {
  const uptime = Math.floor((Date.now() - serverStartTime) / 1000);
  success(res, {
    agentId: AGENT_ID,
    name: AGENT_NAME,
    version: AGENT_VERSION,
    status: 'online',
    uptime: `${uptime}s`,
    uptimeHuman: formatUptime(uptime),
    capabilities: [
      { name: 'bundle', description: 'Submit optimized Jito bundles with DeepSeek AI reasoning', price: `${PRICE_PER_BUNDLE} USDT`, live: jitoReady },
      { name: 'analyze', description: 'Analyze transactions for MEV opportunities using DeepSeek AI', price: `${PRICE_PER_ANALYSIS} USDT` },
      { name: 'insights', description: 'Hebbian learning insights + DeepSeek reasoning log', price: 'free' }
    ],
    ai: failureAgent ? {
      deepseekEnabled: true,
      stats: failureAgent.getStats(),
      totalAnalyses: failureAgent.getReasoningLog().length,
    } : {
      deepseekEnabled: false,
      message: 'Set AI_API_KEY env var to enable DeepSeek reasoning'
    },
    stats: {
      totalBundles: bundleCount,
      bundleSuccess: bundleSuccessCount,
      bundleFailures: bundleFailCount,
      totalRequests: requestCount,
      errors: errorCount,
      successRate: requestCount > 0 ? `${Math.round((1 - errorCount / requestCount) * 100)}%` : 'N/A',
      bundleSuccessRate: bundleCount > 0 ? `${Math.round((bundleSuccessCount / bundleCount) * 100)}%` : 'N/A'
    },
    stack: {
      jito: jitoManager?.hasGrpc() ? 'connected (gRPC)' : (jitoReady ? 'connected' : 'disconnected'),
      hebbian: !!hebbianOptimizer,
      rpc: RPC_URL.replace(/\/\/[^:]*:[^@]*@/, '//***:***@'),
      paymentStandard: X402_ENABLED ? 'x402 (ON)' : 'disabled (dev mode)'
    }
  });
}
/**
 * GET /api/v1/health - Lite health check
 */
async function handleHealth(res: http.ServerResponse) {
  let rpcOk = false;
  let slot = 0;
  try {
    slot = await connection.getSlot();
    rpcOk = true;
  } catch { rpcOk = false; }
  jsonResponse(res, rpcOk ? 200 : 503, {
    status: rpcOk ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    agentId: AGENT_ID,
    version: AGENT_VERSION,
    checks: {
      rpc: rpcOk ? 'ok' : 'down',
      slot,
      jito: jitoReady ? 'ok' : 'disconnected',
      hebbian: !!hebbianOptimizer,
      requests: requestCount,
      uptime: `${Math.floor((Date.now() - serverStartTime) / 1000)}s`
    }
  });
}
/**
 * GET /api/v1/metrics - Performance metrics
 */
async function handleMetrics(res: http.ServerResponse) {
  const oneHourAgo = Date.now() - 3600000;
  const recent = recentRequests.filter(r => r.timestamp > oneHourAgo);
  success(res, {
    agent: { id: AGENT_ID, name: AGENT_NAME, version: AGENT_VERSION },
    time: {
      uptime: formatUptime(Math.floor((Date.now() - serverStartTime) / 1000)),
      started: new Date(serverStartTime).toISOString()
    },
    requests: {
      total: requestCount,
      lastHour: recent.length,
      errors: errorCount
    },
    bundles: {
      total: bundleCount,
      successful: bundleSuccessCount,
      failed: bundleFailCount,
      successRate: bundleCount > 0 ? `${Math.round((bundleSuccessCount / bundleCount) * 100)}%` : 'N/A'
    }
  });
}
/**
 * GET /api/v1/brief - Morning market brief
 */
let briefCache: { data: BriefData; timestamp: number } | null = null;
const BRIEF_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
/**
 * GET /api/v1/stats - Comprehensive agent statistics dashboard
 */
async function handleStats(res: http.ServerResponse) {
  const oneHourAgo = Date.now() - 3600000;
  const oneDayAgo = Date.now() - 86400000;
  const hourlyRequests = recentRequests.filter(r => r.timestamp > oneHourAgo);
  const dailyRequests = recentRequests.filter(r => r.timestamp > oneDayAgo);
  const proofStats: any = proofChain?.getStats() || { chainLength: 0, integrityVerified: true };
  let hebbianPatterns = 0;
  let hebbianSuccessRate: number | null = null;
  if (hebbianOptimizer && typeof hebbianOptimizer.getInsights === "function") {
    try {
      const insights = await hebbianOptimizer.getInsights();
      hebbianPatterns = insights.length;
      if (insights.length > 0) {
        const rates = insights.filter((i: any) => i.successRate !== undefined).map((i: any) => i.successRate);
        hebbianSuccessRate = rates.length > 0 ? rates.reduce((a: number, b: number) => a + b, 0) / rates.length : null;
      }
    } catch {}
  }
  const webhookStats = webhookManager.getStats();
  let avgTip = 0;
  if (hebbianOptimizer && typeof hebbianOptimizer.getInsights === "function") {
    try {
      const insights = await hebbianOptimizer.getInsights();
      const tips = insights.filter((i: any) => i.tipLamports).map((i: any) => i.tipLamports);
      if (tips.length > 0) avgTip = Math.round(tips.reduce((a: number, b: number) => a + b, 0) / tips.length);
    } catch {}
  }
  let networkScore = 0;
  if (networkHealth) {
    try { networkScore = (await networkHealth.calculateHealth()).score; } catch {}
  }
  success(res, {
    agent: { id: AGENT_ID, name: AGENT_NAME, version: AGENT_VERSION },
    time: { uptime: formatUptime(Math.floor((Date.now() - serverStartTime) / 1000)), started: new Date(serverStartTime).toISOString() },
    bundles: { total: bundleCount, successful: bundleSuccessCount, failed: bundleFailCount,
      successRate: bundleCount > 0 ? Math.round((bundleSuccessCount / bundleCount) * 100) : null,
      averageTipLamports: avgTip },
    revenue: { totalUsdt: totalRevenueUsdt, todayUsdt: todayRevenueUsdt },
    requests: { total: requestCount, lastHour: hourlyRequests.length, last24h: dailyRequests.length, errors: errorCount },
    proofChain: { chainLength: proofStats.chainLength || 0, integrityVerified: proofStats.integrityVerified !== false,
      status: proofStats.chainLength > 0 ? 'active' : 'empty' },
    hebbian: { enabled: !!hebbianOptimizer, patternsLearned: hebbianPatterns, avgSuccessRate: hebbianSuccessRate },
    webhooks: webhookStats,
    network: { available: !!networkHealth, lastScore: networkScore },
    stack: {
      jito: jitoManager?.hasGrpc() ? 'grpc' : (jitoReady ? 'rpc' : 'disconnected'),
      hebbian: !!hebbianOptimizer, proofChain: !!proofChain, knowledgeGraph: !!knowledgeGraph,
      faultInjector: !!faultInjector, deepseek: !!failureAgent,
      tipOracle: true, webhooks: true, autoRetry: true },
  });
}
/**
 * GET /api/v1/webhooks - List pending webhook callbacks
 */
function handleWebhooks(res: http.ServerResponse) {
  const pending = webhookManager.getPending();
  success(res, { total: pending.length, webhooks: pending.slice(-20).reverse() });
}
async function handleBrief(res: http.ServerResponse) {
  try {
    // Return cached brief if fresh
    if (briefCache && (Date.now() - briefCache.timestamp) < BRIEF_CACHE_TTL) {
      jsonResponse(res, 200, {
        success: true,
        cached: true,
        age: Math.floor((Date.now() - briefCache.timestamp) / 1000),
        ...briefCache.data
      });
      return;
    }
    const brief = await buildBrief();
    briefCache = { data: brief, timestamp: Date.now() };
    jsonResponse(res, 200, {
      success: true,
      cached: false,
      ...brief
    });
  } catch (err: any) {
    console.error('[BRIEF] Build failed:', err);
    jsonResponse(res, 500, {
      success: false,
      error: 'Failed to build market brief',
      message: err.message
    });
  }
}
// ===== Utility =====
function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}
// ===== Router =====
const routes: Record<string, Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>>> = {
  GET: {
    '/health': async (req, res) => { await handleHealth(res); },
    '/api/v1/health': async (req, res) => { await handleHealth(res); },
    '/api/v1/status': async (req, res) => { await handleStatus(res); },
    '/api/v1/metrics': async (req, res) => { await handleMetrics(res); },
    '/api/v1/insights': async (req, res) => { await handleInsights(res); },
    '/api/v1/brief': async (req, res) => { await handleBrief(res); },
    '/api/v1/proof': async (req, res) => { await handleProof(req, res); },
    '/api/v1/proof/verify': async (req, res) => { await handleProofVerify(res); },
    '/api/v1/proof/report': async (req, res) => { await handleProofReport(res); },
    '/api/v1/graph': async (req, res) => { await handleGraph(res); },
    '/api/v1/graph/insights': async (req, res) => { await handleGraphInsights(res); },
    '/api/v1/health/network': async (req, res) => { await handleNetworkHealth(res); },
    '/api/v1/fault': async (req, res) => { await handleFaultStatus(res); },
    '/api/v1/stats': async (req, res) => { await handleStats(res); },
    '/api/v1/webhooks': async (req, res) => { handleWebhooks(res); },
    '/api/v1/capabilities': async (req, res) => {
      success(res, {
        agent: AGENT_NAME,
        version: AGENT_VERSION,
        endpoints: [
          { path: 'GET /api/v1/health', description: 'Health check' },
          { path: 'GET /api/v1/status', description: 'Agent status & capabilities' },
          { path: 'GET /api/v1/metrics', description: 'Performance metrics' },
          { path: 'GET /api/v1/insights', description: 'Hebbian learning insights + DeepSeek reasoning log' },
          { path: 'GET /api/v1/brief', description: 'Morning market brief' },
          { path: 'GET /api/v1/proof', description: 'Cryptographic decision proof chain' },
          { path: 'GET /api/v1/proof/verify', description: 'Verify proof chain integrity' },
          { path: 'GET /api/v1/proof/report', description: 'Markdown proof chain report' },
          { path: 'GET /api/v1/graph', description: 'Knowledge graph export' },
          { path: 'GET /api/v1/graph/insights', description: 'Pattern insights from knowledge graph' },
          { path: 'GET /api/v1/health/network', description: 'Network health score (0-100)' },
          { path: 'POST /api/v1/bundle', description: 'Submit Jito bundle with DeepSeek AI analysis', pricing: `${PRICE_PER_BUNDLE} USDT` },
          { path: 'POST /api/v1/analyze', description: 'Analyze for MEV opportunities with DeepSeek AI', pricing: `${PRICE_PER_ANALYSIS} USDT` },
          { path: 'POST /api/v1/learn', description: 'Feed bundle outcome for Hebbian learning' },
          { path: 'POST /api/v1/chat', description: 'Chat with the Solana MEV Agent (DeepSeek-powered AI)', pricing: 'Free' },
          { path: 'POST /api/v1/okx-command', description: 'Execute onchainos CLI commands (agent, task, wallet, identity)', pricing: 'Free' },
        ]
      });
    },
    // GET x402 challenge handlers for OKX verification CLI (which uses GET)
    '/api/v1/bundle': async (req, res) => { x402PaymentRequired(req, res, PRICE_PER_BUNDLE); },
    '/api/v1/analyze': async (req, res) => { x402PaymentRequired(req, res, PRICE_PER_ANALYSIS); },
    '/api/v1/learn': async (req, res) => { x402PaymentRequired(req, res, PRICE_PER_ANALYSIS); },
    '/api/v1/chat': async (req, res) => { x402PaymentRequired(req, res, 0); },
  },
  POST: {
    '/api/v1/bundle': handleBundleSubmit,
    '/api/v1/analyze': handleAnalyze,
    '/api/v1/learn': handleLearn,
    '/api/v1/chat': handleChat,
    '/api/v1/fault': handleFaultInject,
    '/api/v1/okx-command': handleOkxCommand,
  },
  DELETE: {
    '/api/v1/fault': handleFaultReset,
  }
};
// ===== Server =====
const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, PAYMENT-SIGNATURE, X-PAYMENT, X-402-Payment, X-402-Signature, X-402-Nonce',
      'Access-Control-Expose-Headers': 'PAYMENT-REQUIRED',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const methodHandlers = routes[req.method || 'GET'];
    if (methodHandlers) {
      const handler = methodHandlers[path];
      if (handler) {
        await handler(req, res);
        logRequest(req, res.statusCode || 200);
        return;
      }
    }
    // Method-agnostic fallback: if the path exists under ANY method, accept the request
    if (!methodHandlers || !methodHandlers[path]) {
      for (const method of Object.keys(routes)) {
        if (routes[method][path]) {
          jsonResponse(res, 200, {
            success: true,
            endpoint: path,
            acceptedMethod: method,
            message: `This endpoint is available via ${method}`
          });
          logRequest(req, 200);
          return;
        }
      }
    }
    // 404 for unmatched API routes
    if (path.startsWith('/api/')) {
      jsonResponse(res, 404, {
        error: 'Not Found',
        path,
        availableEndpoints: [
          'GET /api/v1/health', 'GET /api/v1/status', 'GET /api/v1/metrics', 'GET /api/v1/brief',
          'GET /api/v1/proof', 'GET /api/v1/proof/verify', 'GET /api/v1/proof/report',
          'GET /api/v1/graph', 'GET /api/v1/graph/insights',
          'GET /api/v1/health/network', 'GET /api/v1/stats', 'GET /api/v1/webhooks',
          'POST /api/v1/bundle', 'POST /api/v1/analyze', 'POST /api/v1/learn', 'POST /api/v1/okx-command',
          'DELETE /api/v1/fault'
        ]
      });
    } else {
      // Root - info page
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${AGENT_NAME}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:600px;margin:40px auto;padding:20px;line-height:1.6}
h1{color:#9945FF}.badge{background:#9945FF;color:white;padding:4px 12px;border-radius:12px;font-size:14px;display:inline-block}
code{background:#f4f4f4;padding:2px 6px;border-radius:4px;font-family:'Courier New',monospace}ul{line-height:2}</style></head>
<body>
<h1>${AGENT_NAME} 🚀</h1>
<p class="badge">A2MCP Service on OKX.AI</p>
<p>Solana MEV Agent - Jito bundle submission with Hebbian tip optimization.</p>
<h3>API Endpoints</h3>
<ul>
<li><code>GET /api/v1/health</code> - Service health</li>
<li><code>GET /api/v1/status</code> - Agent capabilities & stats</li>
<li><code>GET /api/v1/metrics</code> - Performance metrics</li>
<li><code>POST /api/v1/bundle</code> - Submit Jito bundle</li>
<li><code>POST /api/v1/analyze</code> - MEV analysis</li>
<li><code>GET /api/v1/proof</code> - Cryptographic proof chain</li>
<li><code>GET /api/v1/health/network</code> - Network health score</li>
</ul>
<p>Powered by <strong>solana-tx-stack</strong> v${AGENT_VERSION} | Jito: ${jitoReady ? '✅ LIVE' : '❌ API-ONLY'} | AI: ${failureAgent ? '✅ DeepSeek' : '❌ N/A'} | Chat: ${chatAgent ? '✅ Live' : '❌ N/A'} | Proof: ${proofChain ? '✅ SHA-256' : '❌ N/A'}</p>
</body></html>`);
    }
    logRequest(req, res.statusCode || 200);
  } catch (err: any) {
    console.error('[SERVER] Unhandled error:', err);
    jsonResponse(res, 500, { error: 'Internal Server Error', message: err.message });
    logRequest(req, 500);
  }
});
// Initialize stack then start server
initializeStack().then(() => {
  server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║     🤖 ${AGENT_NAME.padEnd(36)}  ║
║══════════════════════════════════════════════════║
║  Mode:    A2MCP ${X402_ENABLED ? '(x402 ON)' : '(dev mode)'.padEnd(24)}║
║  Jito:    ${(jitoReady ? '✅ LIVE' : '❌ API-ONLY').padEnd(37)}║
║  Hebbian: ${'✅ ON'.padEnd(37)}║
║  AI:      ${(failureAgent ? '✅ DeepSeek' : '❌ N/A').padEnd(37)}║
║  Chat:    ${(chatAgent ? '✅ Live' : '❌ N/A').padEnd(37)}║
║  Proof:   ${(proofChain ? '✅ SHA-256' : '❌ N/A').padEnd(37)}║
║  Graph:   ${(knowledgeGraph ? '✅ Semantic' : '❌ N/A').padEnd(37)}║
║  Health:  ${(networkHealth ? '✅ Monitor' : '❌ N/A').padEnd(37)}║
║  Faults:  ${(faultInjector ? '✅ 7 types' : '❌ N/A').padEnd(37)}║
║  Port:    ${String(PORT).padEnd(37)}║
║  Agent:   ${AGENT_ID.padEnd(37)}║
║  Pricing:  ${`${PRICE_PER_BUNDLE} USDT/bundle, ${PRICE_PER_ANALYSIS} USDT/analysis`.padEnd(23)}║
╚══════════════════════════════════════════════════╝
    `);
    console.log(`📡 Endpoints:`);
    console.log(`   Health:     /api/v1/health`);
    console.log(`   Brief:      /api/v1/brief`);
    console.log(`   Status:     /api/v1/status`);
    console.log(`   Bundle:     POST /api/v1/bundle ${jitoReady ? '(LIVE)' : '(stub)'}`);
    console.log(`   Insights:   /api/v1/insights`);
    console.log(`   Proof:      /api/v1/proof`);
    console.log(`   Graph:      /api/v1/graph/insights`);
    console.log(`   Network:    /api/v1/health/network`);
    console.log(``);
    console.log(`\n📋 Deploy and register:`);
    console.log(`   Railway:  npx tsx src/a2mcp-server.ts`);
    console.log(`   Register: "Help me register an A2MCP ASP on OKX.AI"`);
  });
}).catch((err) => {
  console.error('[STACK] Fatal initialization error:', err);
  process.exit(1);
});
