# B Role Delivery: ETHHTLC

B owns the native ETH HTLC for Arbitrum Sepolia. The shared interface follows A's Frozen v1.0, based on upstream commit `afa46cb1877a36e5c8fc5ad3d99baf6a4fa62040`.

B has reviewed the contract and updated its comments and code style. This delivery has been checked locally. A's review, C's frontend integration, and D's testnet deployment and two-chain tests are pending.

## Contributions and AI assistance

**The unit tests `ETHHTLC.test.js` were written by AI, and this Markdown document was mainly written and updated by B.** `MockETHParticipant.sol` was written by B and assisted by AI. `IETHHTLC.sol` and `ETHHTLC.sol` were written by B and reviewed by AI.


## Files

| File | Purpose |
|---|---|
| `contracts/ETHHTLC.sol` | Native ETH escrow |
| `contracts/IETHHTLC.sol` | B's own interface; it does not inherit the ERC20 interface |
| `contracts/mocks/MockETHParticipant.sol` | Test-only contract that can reject ETH or attempt reentrancy |
| `test/ETHHTLC.test.js` | Contract behavior and safety tests |
| `abi/ETHHTLC.abi.json` | Handoff copy of the compiled artifact's `abi` field for C/D |
| `abi/ETHHTLC.bytecode.txt` | Handoff copy of the artifact's `bytecode` field for D; no constructor arguments |
| `evidence/test-output.txt` | A's original output followed by appended local test runs |

B does not keep separate evidence files. Test results append to the shared log; existing entries are preserved.

## Compile and test

Run from the repository root. No wallet, private key, RPC, or testnet funds are needed for these local tests.

```bash
eval "$(fnm env --shell bash)"
fnm use 24.22.1
npm ci --registry=https://registry.npmmirror.com --no-audit --no-fund
npx hardhat compile --force
npm test
```

Use the existing lockfile. Do not upgrade dependencies as part of B's work. The explicit registry matches the tarball URLs in that lockfile.

To run all 56 tests and append the output in Bash or Zsh:

```bash
set -o pipefail
npx hardhat test 2>&1 | tee -a evidence/test-output.txt
```

`tee -a` displays the output and appends it without overwriting earlier runs. `2>&1` includes error output. `pipefail` makes the pipeline return a failure status if Hardhat fails, even if `tee` succeeds.

For B's 19 English tests only, use this command with `pipefail` enabled:

```bash
npx hardhat test test/ETHHTLC.test.js 2>&1 | tee -a evidence/test-output.txt
```

These commands append Hardhat's output directly; they do not add timestamp or exit-code lines. Earlier dated entries remain in the log. `npm test` still runs the full A+B suite; it only appends output when piped to `tee -a` in the same way.

## ABI and bytecode handoff

Hardhat creates `artifacts/contracts/ETHHTLC.sol/ETHHTLC.json` during compilation. There is no separate export step for normal Hardhat development.

- `abi`: the interface C uses with the deployed address to call the contract and read events/errors.
- `bytecode`: the creation bytecode D can use to deploy the contract. Do not substitute `deployedBytecode`, which is the runtime code.

C/D can use this JSON directly or copy the two fields into separate files. The existing `abi/ETHHTLC.abi.json` and `abi/ETHHTLC.bytecode.txt` are handoff copies. To refresh them, copy the full `abi` array as JSON and the full `bytecode` string as plain text without quotes, keeping its `0x` prefix.

After changing Solidity files, compile again before handing over the artifact or refreshing these copies. Comments and formatting can also change the bytecode metadata. Hardhat does not automatically update the copies in `abi/`.

`artifacts/` is ignored by Git. C/D can compile the same source with this project's lockfile and config, or receive the generated JSON separately. D can also deploy directly with Hardhat's `ethers.getContractFactory("ETHHTLC")`, without extracting the fields manually.

## Interface and state

Deploy with no constructor arguments. `lock`, `claim`, and `refund` use OpenZeppelin `ReentrancyGuard`. There is no owner withdrawal, upgrade function, or cross-chain call.

| Function | Behavior |
|---|---|
| `lock(address recipient, bytes32 hashlock, uint256 timelock) payable returns (bytes32 swapId)` | Checks recipient, ETH amount, hashlock, and future deadline, in that order |
| `claim(bytes32 swapId, bytes32 secret)` | Only the recipient can claim an active swap before the deadline with the correct secret |
| `refund(bytes32 swapId)` | Only the original sender can refund an active swap at or after the deadline |
| `getSwap(bytes32 swapId)` | Returns seven separate fields: sender, recipient, token, amount, hashlock, timelock, and uint8 status |

- `token` is `address(0)` for native ETH. It is an asset marker, not the payment destination.
- `amount` is the ETH deposited for that swap, not the contract's total balance.
- States are `0 None`, `1 Active`, `2 Claimed`, and `3 Refunded`. A completed swap cannot return to Active.
- An unknown ID returns seven zero values. Check `status == 0` to identify a missing swap.
- Expiry alone does not change stored status. An expired, unclaimed swap remains Active until a refund transaction succeeds.
- Claim requires `block.timestamp < timelock`; refund requires `block.timestamp >= timelock`. Equality belongs to refund.
- The secret is raw `bytes32`; hash it with `keccak256(abi.encodePacked(secret))`. In ethers, use `ethers.keccak256(secretHex)`, not the UTF-8 text of the hex string.
- A zero-valued secret is valid when its hash matches. A zero hashlock is rejected.
- The ID is `keccak256(abi.encode(block.chainid, address(this), msg.sender, nonce))`. The contract-wide nonce starts at zero and increases for each successful lock.
- Repeating the same lock parameters creates a new swap ID and a separate deposit.
- Claim/refund set the final status before sending ETH with `call`. A failed payment reverts the transaction, restoring the Active status and escrow.
- Ordinary direct ETH transfers and unknown calldata are rejected. ETH should enter through `lock`.

The events match A's field order and indexed fields:

```solidity
event Locked(bytes32 indexed swapId, address indexed sender, address indexed recipient,
             address token, uint256 amount, bytes32 hashlock, uint256 timelock);
event Claimed(bytes32 indexed swapId, bytes32 secret);
event Refunded(bytes32 indexed swapId);
```

## Errors

| Error | Meaning |
|---|---|
| `InvalidAddress()` | Zero recipient address |
| `InvalidAmount()` | Zero ETH deposit |
| `InvalidHashlock()` | Zero hashlock |
| `InvalidTimelock()` | Deadline is not in the future |
| `UnexpectedEther()` | Ordinary direct transfer or unknown calldata |
| `SwapAlreadyExists(bytes32)` | Generated ID is already used |
| `SwapNotFound(bytes32)` | Claim/refund target does not exist; getSwap itself returns zeros |
| `SwapNotActive(bytes32)` | Swap is already claimed or refunded |
| `UnauthorizedReceiver(bytes32,address)` | Caller is not the recipient |
| `UnauthorizedSender(bytes32,address)` | Caller is not the original sender |
| `SwapExpired(bytes32)` | Claim attempted at or after expiry |
| `SwapNotExpired(bytes32)` | Refund attempted before expiry |
| `InvalidSecret(bytes32)` | Secret hash does not match |
| `ETHTransferFailed(bytes32)` | ETH payment failed; state and funds roll back |
| `ReentrancyGuardReentrantCall()` | OpenZeppelin blocked a nested protected call |
| `InvalidToken()` | Reserved for A's frozen error ABI; ETH operations do not use it |

Claim check order: NotFound -> NotActive -> UnauthorizedReceiver -> Expired -> InvalidSecret.

Refund check order: NotFound -> NotActive -> UnauthorizedSender -> NotExpired.

C/D should also handle generic reverts and wallet/RPC errors. For example, sending ETH to a non-payable function can revert without a custom error.

## Tests

Latest local verification: **56 passing** on 15 November 2026: 37 A tests and 19 B tests. Compilation used Solidity 0.8.28 and EVM target Paris, with Node.js 24.22.1. The handoff copies in `abi/` were copied from the generated artifact and checked against it. The latest full-suite output was appended to `evidence/test-output.txt` using `tee -a`; the command returned exit code 0.

The test file starts with an AI authorship note and an overview of the test scope and account roles. Each test has a short English comment explaining its purpose, the scenario, and the expected result. The payment-rejection and reentrancy helpers also explain why their checks are needed. `MockETHParticipant` is a test-only contract wallet: it forwards calls to ETHHTLC, can reject ETH payments, and can call back into ETHHTLC during a payment to test reentrancy protection.

B tests cover:

- Valid locks, 1 wei, input checks, rollback of failed locks, and unique IDs across senders.
- Seven-field queries, frozen ABI compatibility, and event fields.
- Correct/wrong secrets, caller permissions, and the exact deadline boundary.
- Repeated claims/refunds and operations after completion.
- Rejected ETH payments and successful retries.
- A rejected claim followed by a sender refund at the deadline, while the recipient still rejects ETH.
- Valid callback attempts into lock, claim, and refund, checking the actual reentrancy-guard error and one payment only.

The recovery test checks that a failed claim leaves the escrow and Active state intact, does not allow an early refund, and does not allow another payout after the refund.

## Handoff to A, C, and D

- A reviews shared ABI compatibility, error order, time boundaries, payment rollback, and reentrancy handling. Shared interface changes must go through A.
- C uses the artifact's `abi` field (or its handoff copy) and D's deployed address. ETH needs no ERC20 approval. Read the swap ID from the successful Locked receipt, not from the transaction's Solidity return value.
- D deploys ETHHTLC to Arbitrum Sepolia and handles the two-chain configuration and end-to-end tests. This repository's current Hardhat config is for local tests.
- C/D must check both chains independently: the correct network, HTLC and MST addresses, parties, amounts, hashlock, status, and deadlines. Use `T_ETH < T_MST` with enough time for observation and transaction confirmation.
- Use a successful Claimed event to confirm payment and read the revealed secret. Derive claimable/refundable actions from the stored state, chain time, caller, and secret availability.
- D must ensure someone owns the off-chain coordination scripts. They are outside B's scope but remain required for the full project.

## Limits

- Contract-wallet senders and recipients must call from the recorded address and accept ETH with empty calldata. A permanently rejecting address has no admin rescue or alternate payment destination.
- A failed claim can still reveal the secret in transaction calldata. Reverting state does not make the secret private again. Observing a secret is not proof that the ETH payment succeeded.
- Forced ETH transfers can increase the contract balance without creating a swap. Each payout remains limited to its recorded amount.
- Local tests do not prove testnet deployment or a two-chain swap. A review, C integration, and D's deployed success/refund demonstrations are still needed.
- No privacy Challenge, bridge, oracle, or cross-chain messaging is implemented.
