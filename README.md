# bsc-mint-scanner

Scans new BSC blocks for free-mint and claim calls, notify-only.

Watches for contracts that get 3+ distinct wallets calling
`mint` / `claim` / `freeMint` / `join` selectors on value-0 transactions —
the signature of a fresh free mint opening. It only reports; it never
mints on its own.

## How it works

- `free_mint_watch.sh` — polls new blocks every 60s, keeps state under
  `state/`, wakes the verifier when a contract crosses the threshold.
- `free_mint_watch_scan.js` — the block scanner: fetches new blocks,
  decodes transaction input for the mint/claim selectors, counts distinct
  callers per contract.

## Usage

```bash
bash free_mint_watch.sh
```

Runs continuously. When a candidate appears, it prints the contract
address, the selector, and the caller count — then you verify the contract
(price 0, mint enabled, supply, eligibility) before minting anything.
