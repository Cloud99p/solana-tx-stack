const https = require('https');

function rpcCall(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = https.request({
      hostname: 'api.mainnet-beta.solana.com',
      port: 443,
      path: '/',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
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

async function main() {
  const sig = '15e0489327d18a142be9ad62cfa95d9dedc694e7cdff719e36cfd799da320875';

  const tx = await rpcCall('getTransaction', [sig, { encoding: 'json', maxSupportedTransactionVersion: 0 }]);
  console.log('=== Bundle Transaction Status ===');
  console.log(JSON.stringify(tx, null, 2));

  if (tx.result) {
    console.log('\n✅ LANDED — slot ' + tx.result.slot);
    console.log('   Block time: ' + new Date((tx.result.blockTime || 0) * 1000).toISOString());
    console.log('   Fee: ' + (tx.result.meta?.fee || 0) + ' lamports');
    console.log('   Status: ' + (tx.result.meta?.err ? '❌ Failed' : '✅ Success'));
  } else if (tx.error) {
    console.log('\n❌ Not found on-chain');
    const wallet = '8ifrorg6DFECBXFA6fikQ5YkZAhihcqCi72A9shiuuxU';
    const sigs = await rpcCall('getSignaturesForAddress', [wallet, { limit: 5 }]);
    console.log('\n=== Recent txns (wallet ' + wallet + ') ===');
    if (sigs.result) {
      for (const s of sigs.result) {
        console.log('  ' + s.signature + ' — slot ' + s.slot + ' — ' + (s.err ? '❌' : '✅') + ' — ' + new Date((s.blockTime || 0) * 1000).toISOString());
      }
    } else {
      console.log('  No recent transactions');
    }
  }
}

main().catch(e => console.error(e));
