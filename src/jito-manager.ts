/**
 * Jito Bundle Manager — gRPC via jito-ts gen modules
 *
 * Submission order:
 * 1. gRPC (real Jito bundles) ✅ — tested working
 * 2. Direct Solana RPC (fallback) ✅ — tested working
 *
 * Bundle submission requires at least one transaction to tip a Jito
 * tip account with >= 1000 lamports. If the submitted transactions
 * don't include one, a tip transaction is auto-added.
 *
 * The gen modules at node_modules/jito-ts/dist/gen/block-engine/ need
 * a small fix: create google/protobuf/timestamp.js stub for the
 * missing well-known type. This is already handled.
 */

import { Connection, Keypair, PublicKey, VersionedTransaction, Transaction, SystemProgram, TransactionMessage } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import * as grpc from '@grpc/grpc-js';
import { createRequire } from 'module';
const _require = createRequire(import.meta.url);

const DEFAULT_TIP_ACCOUNTS: string[] = [
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
];
const MIN_TIP = 1000; // lamports

export interface JitoConfig {
  blockEngineUrl: string;
  authKeypairPath: string;
  rpcUrl: string;
}

export class JitoManager {
  private connection: Connection;
  private config: JitoConfig;
  private tipAccounts: string[] = DEFAULT_TIP_ACCOUNTS;
  private currentTipIdx: number = 0;
  private keypair: Keypair | null = null;
  private payer: Keypair | null = null;
  private grpcClient: any = null;
  private grpcOk: boolean = false;
  private _available: boolean = false;

  constructor(connection: Connection) {
    this.connection = connection;
    // Strip protocol prefix from block engine URL (gRPC needs host:port, not https://host)
    // e.g. https://frankfurt.mainnet.block-engine.jito.wtf -> frankfurt.mainnet.block-engine.jito.wtf:443
    let rawBeUrl = process.env.JITO_BLOCK_ENGINE_URL || 'frankfurt.mainnet.block-engine.jito.wtf:443';
    rawBeUrl = rawBeUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!rawBeUrl.includes(':')) rawBeUrl += ':443';
    this.config = {
      blockEngineUrl: rawBeUrl,
      authKeypairPath: process.env.JITO_AUTH_KEYPAIR_PATH || '.keypair/auth-id.json',
      rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    };
  }

  async initialize(): Promise<void> {
    console.log('[JITO] Init...');
    try {
      const rp = path.isAbsolute(this.config.authKeypairPath)
        ? this.config.authKeypairPath
        : path.resolve(process.cwd(), this.config.authKeypairPath);
      const raw = JSON.parse(fs.readFileSync(rp, 'utf-8'));
      this.payer = Keypair.fromSecretKey(Uint8Array.from(raw));
      console.log(`[JITO] Payer: ${this.payer.publicKey.toBase58()}`);

      await this.tryGrpc();
      this._available = true;
      console.log(`[JITO] Ready — gRPC:${this.grpcOk?'✅':'❌'} tips:${this.tipAccounts.length}`);
    } catch (e: any) {
      console.warn('[JITO] Init fail:', e.message);
    }
  }

  private async tryGrpc(): Promise<void> {
    try {
      const gen = path.resolve(process.cwd(), 'node_modules/jito-ts/dist/gen/block-engine/searcher.js');
      if (!fs.existsSync(gen)) { console.log('[JITO] gen not found'); return; }
      const s = _require(gen);
      if (!s.SearcherServiceClient) { console.log('[JITO] no client'); return; }

      const creds = grpc.credentials.createSsl();
      this.grpcClient = new s.SearcherServiceClient(this.config.blockEngineUrl, creds);

      const tips: string[] = await new Promise((res, rej) => {
        const d = new Date(Date.now() + 10_000);
        this.grpcClient.getTipAccounts({}, { deadline: d }, (e: any, r: any) =>
          e ? rej(e) : res(r?.accounts || [])
        );
      });
      if (tips.length > 0) { this.tipAccounts = tips; this.grpcOk = true; }
      console.log(`[JITO] gRPC ok — ${tips.length} tips`);
    } catch (e: any) {
      console.log('[JITO] gRPC fail:', e.message);
    }
  }

  getNextTipAccount(): PublicKey {
    const a = this.tipAccounts[this.currentTipIdx];
    this.currentTipIdx = (this.currentTipIdx + 1) % this.tipAccounts.length;
    return new PublicKey(a);
  }

  async submitBundle(
    txs: VersionedTransaction[],
    payerPubkey: PublicKey,
    tipAmount: number = 1000
  ): Promise<{ bundleId: string; healthScore?: number; grpcError?: string }> {
    if (this.grpcOk && this.grpcClient && this.payer) {
      try { return await this.submitGRPC(txs, tipAmount); } catch (e: any) {
        console.log('[JITO] gRPC fail, fallback:', e.message, e.stack?.split('\n').slice(0,3).join(' | '));
        return this.submitRPC(txs, e.message);
      }
    }
    return this.submitRPC(txs);
  }

  private async submitGRPC(txs: VersionedTransaction[], tipAmount: number = 1000): Promise<{ bundleId: string; healthScore?: number }> {
    const searcherPath = path.resolve(process.cwd(), 'node_modules/jito-ts/dist/gen/block-engine/searcher.js');
    const bundlePath = path.resolve(process.cwd(), 'node_modules/jito-ts/dist/gen/block-engine/bundle.js');
    const packetPath = path.resolve(process.cwd(), 'node_modules/jito-ts/dist/gen/block-engine/packet.js');
    if (!fs.existsSync(searcherPath) || !fs.existsSync(bundlePath) || !fs.existsSync(packetPath)) {
      throw new Error('Jito gen modules not found — run ensureJitoStubs first');
    }
    const s = _require(searcherPath);
    const bm = _require(bundlePath);
    const pm = _require(packetPath);

    // Check if any tx in the bundle already tips a Jito account
    const needsTip = !txs.some(tx => {
      const m = (tx as any).message;
      return m?.staticAccountKeys?.some((k: PublicKey) =>
        this.tipAccounts.some(t => k.toBase58() === t)
      );
    });

    let finalTxs = txs;
    if (needsTip && this.payer) {
      console.log('[JITO] Adding tip tx to bundle');
      const tipAcct = this.getNextTipAccount();
      const bh = await this.connection.getLatestBlockhash('finalized');
      const ix = SystemProgram.transfer({
        fromPubkey: this.payer.publicKey,
        toPubkey: tipAcct,
        lamports: tipAmount,
      });
      const msg = new TransactionMessage({
        payerKey: this.payer.publicKey,
        recentBlockhash: bh.blockhash,
        instructions: [ix],
      }).compileToV0Message();
      const tipTx = new VersionedTransaction(msg);
      tipTx.sign([this.payer]);
      finalTxs = [...txs, tipTx];
    }

    const packets = finalTxs.map((tx: VersionedTransaction) =>
      pm.Packet.create({ data: Buffer.from(tx.serialize()), meta: { size: 0, addr: '', port: 0, senderStake: 0 } })
    );
    const bundle = bm.Bundle.create({ packets });
    const req = s.SendBundleRequest.create({ bundle });

    return new Promise((res, rej) => {
      const d = new Date(Date.now() + 60_000);
      this.grpcClient.sendBundle(req, { deadline: d }, (err: any, resp: any) => {
        if (err) return rej(new Error(err.message));
        const id = resp?.uuid || `bundle_${Date.now()}`;
        console.log(`[JITO] Bundle sent ✅ ${id}`);
        res({ bundleId: id, healthScore: 75 });
      });
    });
  }

  private async submitRPC(txs: VersionedTransaction[], grpcError?: string): Promise<{ bundleId: string; healthScore?: number; grpcError?: string }> {
    console.log(`[JITO] Direct RPC: ${txs.length} tx(s)`);
    const sigs: string[] = [];
    for (const tx of txs) {
      const s = await this.connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 2 });
      sigs.push(s);
    }
    return { bundleId: sigs[0] || `direct_${Date.now()}`, healthScore: 50, grpcError };
  }

  isAvailable() { return this._available; }
  hasGrpc() { return this.grpcOk; }
}
