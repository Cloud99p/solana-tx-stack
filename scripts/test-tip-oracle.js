import { getTipOracle } from '../src/tip-oracle.js';

(async () => {
  const oracle = getTipOracle(0);
  const floor = await oracle.getTipFloor();
  console.log('Tip floor:', JSON.stringify(floor, null, 2));
  const rec = await oracle.getRecommendedTip('high');
  console.log('Recommended (high):', rec.lamports + ' lamports (' + (rec.lamports / 1e9) + ' SOL) src:', rec.source);
  const ctx = await oracle.getMarketContext();
  console.log('Market ctx:', JSON.stringify(ctx));
})().catch(e => console.error('FAIL:', e.message));
