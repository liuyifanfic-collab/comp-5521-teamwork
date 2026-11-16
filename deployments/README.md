# Deployment records

`testnet.json` is written by:

```bash
node scripts/cli.js deploy
```

It contains the public addresses, deployment transaction hashes, block numbers
and bytecode hashes for Ethereum Sepolia and Arbitrum Sepolia. It is safe to
commit: it never contains a private key or the swap preimage. Add the addresses
to `.env` (or leave them here and the scripts will read this file) before running
the success/refund flows.

Local deployments are written to `.runtime/local/deployments.json`, which is
ignored by Git because the local Hardhat chain is disposable.
