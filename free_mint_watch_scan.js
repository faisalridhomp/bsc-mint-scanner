// Scanner for the BSC free-mint chain watch hook.
// Fetches new BSC blocks, finds value-0 txs calling mint/claim/freeMint/join
// functions, and tracks distinct callers per contract. A contract only
// becomes a wake candidate once >=3 different wallets called its
// mint/claim function (a public mint many people want, not a one-off
// owner mint or single-user claim). State lives under
// ~/hooks/state/free_mint_watch/. On dry run (FREE_MINT_WATCH_DRY=1)
// nothing is written, so detections are not consumed.
const fs = require('fs');
const path = require('path');

const HOME = process.env.HOME || '/home/hatch';
const STATE_DIR = path.join(HOME, 'hooks', 'state', 'free_mint_watch');
const LAST_BLOCK_FILE = path.join(STATE_DIR, 'last_block');
const CALLERS_FILE = path.join(STATE_DIR, 'caller_counts.json');
const WOKEN_FILE = path.join(STATE_DIR, 'woken.json');

const RPCS = [
  'https://bsc-dataseed3.bnbchain.org',
  'https://bsc-rpc.publicnode.com',
  'https://bsc.meowrpc.com',
];
// 4-byte selectors for free-mint/claim/join functions (ethers.id).
// claimReward() deliberately excluded: it is almost always staking rewards.
const SELECTORS = new Set(
  'a0712d68|94bf804d|40c10f19|056b01ce|d85d3d27|1249c58b|8ab53447|a4146733|e55fcf2d|5b70ea9f|7c928fe9|fa07ce1d|4db159f5|26308e03|b1aa90a1|c68e45b7|f366afc9|18c99c4e|dac9021f|4e71d92d|379607f5|6ba4c138|1e83409a|48c54b9d|5b88349d|a0e848c7|3335252b|2e7ba6ef|5312df0f|049878f3|be040fb0|db006a75'.split('|')
);
const OWN_WALLET = (process.env.FMW_OWN_WALLET || '0x3bc96b2528f686f27b04897bd819bc10d8981b1b').toLowerCase(); // your own wallet: its txs don't count toward the 3-caller threshold
const MIN_CALLERS = 3;      // distinct wallets before a contract wakes
const MAX_WINDOW = 120;     // blocks scanned per poll at most
const PRUNE_AFTER = 7200;   // drop contracts unseen for ~2h of blocks
const DRY = process.env.FREE_MINT_WATCH_DRY === '1';

function out(decision, reason, payload) {
  console.log(JSON.stringify({ decision, reason, payload }));
  process.exit(0);
}

async function rpcPost(url, body, timeoutMs) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

(async () => {
  fs.mkdirSync(STATE_DIR, { recursive: true });

  // latest block
  let latestHex = null;
  let rpcUsed = null;
  for (const rpc of RPCS) {
    try {
      const j = await rpcPost(rpc, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }, 10000);
      if (j.result) { latestHex = j.result; rpcUsed = rpc; break; }
    } catch { /* try next RPC */ }
  }
  if (!latestHex) out('silent', 'bsc rpc unavailable', {});
  const latest = parseInt(latestHex, 16);

  let last = latest - 5;
  try { last = parseInt(fs.readFileSync(LAST_BLOCK_FILE, 'utf8').trim(), 10); } catch { /* first run */ }
  if (!Number.isFinite(last)) last = latest - 5;
  if (last >= latest) out('silent', 'no new blocks', { latest });
  if (latest - last > MAX_WINDOW) last = latest - MAX_WINDOW;

  // batch-fetch full blocks last+1..latest
  const batch = [];
  for (let b = last + 1; b <= latest; b++) {
    batch.push({ jsonrpc: '2.0', id: b, method: 'eth_getBlockByNumber', params: ['0x' + b.toString(16), true] });
  }
  let blocks;
  try {
    blocks = await rpcPost(rpcUsed, batch, 60000);
  } catch (e) {
    out('silent', 'bsc rpc batch fetch failed', { error: String(e.message).slice(0, 120) });
  }

  // collect value-0 mint/claim matches
  const matches = [];
  for (const blk of blocks) {
    if (!blk || !blk.result) continue;
    for (const tx of blk.result.transactions || []) {
      if (!tx.to || tx.value !== '0x0' || !tx.input || tx.input.length < 10) continue;
      const sel = tx.input.slice(2, 10).toLowerCase();
      if (!SELECTORS.has(sel)) continue;
      if (tx.from.toLowerCase() === OWN_WALLET) continue;
      matches.push({ contract: tx.to.toLowerCase(), selector: sel, from: tx.from.toLowerCase(), tx: tx.hash, block: tx.blockNumber });
    }
  }

  const scanned = latest - last;
  const callers = readJson(CALLERS_FILE, {});
  const woken = new Set(readJson(WOKEN_FILE, []));

  for (const m of matches) {
    const entry = callers[m.contract] || { callers: [], lastBlock: 0 };
    if (!entry.callers.includes(m.from)) {
      entry.callers.push(m.from);
      if (entry.callers.length > 5) entry.callers = entry.callers.slice(0, 5);
    }
    entry.lastBlock = latest;
    if (!entry.firstTx) entry.firstTx = m.tx;
    if (!entry.selector) entry.selector = m.selector;
    callers[m.contract] = entry;
  }

  // prune stale contracts
  for (const c of Object.keys(callers)) {
    if (callers[c].lastBlock < latest - PRUNE_AFTER) delete callers[c];
  }

  const candidates = [];
  for (const [contract, entry] of Object.entries(callers)) {
    if (entry.callers.length >= MIN_CALLERS && !woken.has(contract)) {
      candidates.push({ contract, selector: entry.selector, callers: entry.callers.length, firstTx: entry.firstTx });
    }
  }

  if (!DRY) {
    fs.writeFileSync(LAST_BLOCK_FILE, String(latest));
    fs.writeFileSync(CALLERS_FILE, JSON.stringify(callers));
    if (candidates.length > 0) {
      for (const c of candidates) woken.add(c.contract);
      fs.writeFileSync(WOKEN_FILE, JSON.stringify([...woken]));
    }
  }

  if (candidates.length === 0) {
    out('silent', 'no new free-mint contracts', { scanned_blocks: scanned, latest, matching_txs: matches.length });
  }
  out('wake', 'new free-mint candidate contracts on BSC', {
    candidates,
    scanned_blocks: scanned,
    latest,
  });
})().catch((e) => {
  out('silent', 'scanner error', { error: String(e && e.message ? e.message : e).slice(0, 120) });
});
