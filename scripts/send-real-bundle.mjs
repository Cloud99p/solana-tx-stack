const solanaWeb3 = require('@solana/web3.js');
const https = require('https');
const http = require('http');

const RAILWAY_URL = 'https://solana-mev-agent-okx-production.up.railway.app';
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';

async function main() {
  const b64 = 'WzIxMywzLDQ2LDIzNywyMiwxNzQsMTc3LDE4OCwxMTksMjMwLDE4LDE2MywxMSw4NiwxODksMTE4LDIxMywyNTUsMjQ0LDE3MCwyMTAsMTM3LDkyLDIxMCwxOTIsMjQ1LDE3OSw1NCwxODIsMjksMTE2LDIwMCwxMTQsMTc0LDE0Myw1Miw4OCwzLDEwNyw1NCwyNDQsNywyNDMsMTY5LDE2OCwyMTEsMzcsNzYsMTg0LDE1MCw0OSwxMzUsMjEzLDE5Niw5OSw5NCwxODksOTYsNDgsMjMzLDI1NCwxNzcsNjQsMTdd';
  const decoded = Buffer.from(b64, 'base64').toString('utf-8');
  const secretKey = new Uint8Array(JSON.parse(decoded));
  const keypair = solanaWeb3.Keypair.fromSecretKey(secretKey);
  const pubkey = keypair.publicKey.toBase58();

  console.log('🔑 Keypair: ' + pubkey);

  const connection = new solanaWeb3.Connection(RPC_URL, { commitment: 'confirmed' });
  const balance = await connection.getBalance(keypair.publicKey);
  console.log('💰 Balance: ' + (balance / solanaWeb3.LAMPORTS_PER_SOL).toFixed(5) + ' SOL');

  if (balance < 5000) return console.log('❌ Insufficient balance');

  // Health check
  await fetchJSON(RAILWAY_URL + '/api/v1/health');
  await fetchJSON(RAILWAY_URL + '/api/v1/health/network');

  // Create self-transfer
  console.log('\n📝 Creating transaction...');
  const { blockhash } = await connection.getLatestBlockhash('finalized');

  const ix = solanaWeb3.SystemProgram.transfer({
    fromPubkey: keypair.publicKey,
    toPubkey: keypair.publicKey,
    lamports: 1000,
  });

  const msg = new solanaWeb3.TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();

  const tx = new solanaWeb3.VersionedTransaction(msg);
  tx.sign([keypair]);
  const b64Tx = Buffer.from(tx.serialize()).toString('base64');
  console.log('✅ Signed (' + b64Tx.length + ' chars)');

  // Submit to Railway
  console.log('\n📡 Submitting to Railway...');
  const result = await postJSON(RAILWAY_URL + '/api/v1/bundle', {
    transactions: [b64Tx],
    tipLamports: 5000,
    priority: 'low',
  });

  console.log(JSON.stringify(result, null, 2));

  // Stats
  console.log('\n📊 Stats:');
  const stats = await fetchJSON(RAILWAY_URL + '/api/v1/stats');
  console.log('   Bundles: ' + (stats.bundles?.total || 0) + ', Success: ' + (stats.bundles?.successful || 0));
  console.log('   Revenue: ' + (stats.revenue?.totalUsdt || 0) + ' USDT');
  console.log('   Jito: ' + (stats.stack?.jito || 'unknown'));
  console.log('   TipOracle: ' + !!stats.stack?.tipOracle);
  console.log('   Webhooks: ' + !!stats.stack?.webhooks);
  console.log('   AutoRetry: ' + !!stats.stack?.autoRetry);
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          console.log('✅ ' + url.substring(0, 55) + ' — ' + res.statusCode);
          resolve(j);
        } catch {
          console.log('✅ ' + url.substring(0, 55) + ' — ' + res.statusCode + ' (non-json)');
          resolve(d);
        }
      });
    }).on('error', e => reject(e));
  });
}

function postJSON(url, data) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const client = url.startsWith('https') ? https : http;
    const body = JSON.stringify(data);
    const req = client.request({
      hostname: u.hostname,
      port: 443,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-402-Payment': 'paid',
        'X-402-Signature': 'test',
        'X-402-Nonce': Date.now().toString(),
      },
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve(d); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

main().catch(e => console.error('FATAL:', e.message));
