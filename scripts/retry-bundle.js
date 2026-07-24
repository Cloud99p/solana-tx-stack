import { Keypair, Connection, SystemProgram, TransactionMessage, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import https from 'https';

const RAILWAY = 'https://solana-mev-agent-okx-production.up.railway.app';
const RPC = 'https://api.mainnet-beta.solana.com';

async function main() {
  const b64 = 'WzIxMywzLDQ2LDIzNywyMiwxNzQsMTc3LDE4OCwxMTksMjMwLDE4LDE2MywxMSw4NiwxODksMTE4LDIxMywyNTUsMjQ0LDE3MCwyMTAsMTM3LDkyLDIxMCwxOTIsMjQ1LDE3OSw1NCwxODIsMjksMTE2LDIwMCwxMTQsMTc0LDE0Myw1Miw4OCwzLDEwNyw1NCwyNDQsNywyNDMsMTY5LDE2OCwyMTEsMzcsNzYsMTg0LDE1MCw0OSwxMzUsMjEzLDE5Niw5OSw5NCwxODksOTYsNDgsMjMzLDI1NCwxNzcsNjQsMTdd';
  const secretKey = new Uint8Array(JSON.parse(Buffer.from(b64, 'base64').toString()));
  const keypair = Keypair.fromSecretKey(secretKey);
  console.log('Keypair: ' + keypair.publicKey.toBase58());

  const conn = new Connection(RPC, { commitment: 'confirmed' });
  const bal = await conn.getBalance(keypair.publicKey);
  console.log('Balance: ' + (bal / LAMPORTS_PER_SOL).toFixed(5) + ' SOL');

  // Create tx
  const { blockhash } = await conn.getLatestBlockhash('finalized');
  const msg = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: keypair.publicKey, lamports: 1000 }),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([keypair]);
  const b64Tx = Buffer.from(tx.serialize()).toString('base64');
  console.log('Tx signed (' + b64Tx.length + ' chars)');

  // Submit - Railway uses its tip oracle with real Jito API data
  console.log('\nSubmitting bundle...');
  const result = await postJSON(RAILWAY + '/api/v1/bundle', {
    transactions: [b64Tx],
    priority: 'high',
  });
  console.log(JSON.stringify(result, null, 2));

  const sig = result.bundleId || result.details?.bundleId;
  if (sig) {
    console.log('\nBundle UUID: ' + sig);
    console.log('Jito Explorer: https://explorer.jito.wtf/bundle/' + sig);
  }

  // Check stats
  const stats = await getJSON(RAILWAY + '/api/v1/stats');
  console.log('\nStats: ' + (stats.bundles?.total || 0) + ' bundles');
  console.log('  Revenue: ' + (stats.revenue?.totalUsdt || 0) + ' USDT');
  console.log('  TipOracle: ' + !!stats.stack?.tipOracle);
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); }).on('error', reject);
  });
}

function postJSON(url, data) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = JSON.stringify(data);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-402-Payment': 'paid',
        'X-402-Signature': 'test',
        'X-402-Nonce': Date.now().toString(),
      },
    }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

main().catch(e => console.error('FATAL:', e.message));
