# bsc-mint-scanner

Scans new BSC blocks for free-mint and claim calls, notify-only.

Watches for contracts that get 3+ distinct wallets calling
`mint` / `claim` / `freeMint` / `join` selectors on value-0 transactions —
the signature of a fresh free mint opening. It only reports; it never
mints on its own.

## How it works

- `free_mint_watch_scan.js` — the block scanner: fetches new blocks,
  decodes transaction input for the mint/claim selectors, counts distinct
  callers per contract. Prints one JSON line per run:
  `{"decision":"wake"|"silent","reason":"...","payload":{...}}`.
  State lives under `~/hooks/state/free_mint_watch/`.
- `free_mint_watch.sh` — a wrapper for the Muse hook runtime: it sources
  `$HATCH_HOOK_RUNTIME` and turns the scanner's JSON into a `silent()` or
  `wake()` call. It is NOT a standalone script — it only runs inside the
  hook system. It calls the scanner next to itself, so it works both from
  a repo clone and from `~/hooks/scripts/`.

## Usage

Standalone (the scanner is plain Node, no dependencies, Node 18+):

```bash
node free_mint_watch_scan.js
```

Run it on a schedule (every 60s) to poll new blocks. When a candidate
appears, it prints the contract address, the selector, and the caller
count — then you verify the contract (price 0, mint enabled, supply,
eligibility) before minting anything.

Set `FMW_OWN_WALLET` to your own wallet address so your own transactions
don't count toward the 3-caller threshold (default is the author's).
