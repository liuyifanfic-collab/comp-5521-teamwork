/**
 * ETHHTLC unit tests are written by AI.
 *
 * These tests run the real ETHHTLC on the local Hardhat network. They cover
 * deposits, queries, claim/refund permissions, deadline boundaries, failed
 * ETH payments, and reentrancy. MockETHParticipant is only used to control
 * how a contract wallet receives ETH and calls back into the HTLC.
 *
 * By default, alice is the ETH sender, bob is the recipient, and outsider is
 * an unrelated account. These names are not fixed roles in the two-chain swap.
 * Balance checks below exclude the caller's gas fee unless stated otherwise.
 * Run: npx hardhat test test/ETHHTLC.test.js
 * To append results with tee, see the Compile and test section in B角色交付说明.md.
 */
const { expect } = require("chai");
const { artifacts, ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const SECRET = ethers.encodeBytes32String("b-role-test-secret");
const BINARY_SECRET = "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1eff";
const HASH = ethers.keccak256(SECRET);
const BINARY_HASH = ethers.keccak256(BINARY_SECRET);
const AMOUNT = ethers.parseEther("1");
const MISSING = ethers.encodeBytes32String("missing-swap");
const { ZeroAddress, ZeroHash } = ethers;

const NONE = 0n;
const ACTIVE = 1n;
const CLAIMED = 2n;
const REFUNDED = 3n;
const EMPTY_SWAP = [ZeroAddress, ZeroAddress, ZeroAddress, 0n, ZeroHash, 0n, NONE];

// loadFixture restores this deployed state so one test does not affect another.
async function deployHTLC() {
  const [alice, bob, outsider] = await ethers.getSigners();
  const htlc = await (await ethers.getContractFactory("ETHHTLC")).deploy();
  await htlc.waitForDeployment();
  const timelock = (await time.latest()) + 3600;
  return { alice, bob, outsider, htlc, timelock };
}

// Add a contract wallet for rejection and callback cases that an ordinary account cannot trigger.
async function deployWithParticipant() {
  const x = await deployHTLC();
  const factory = await ethers.getContractFactory("MockETHParticipant");
  const participant = await factory.deploy(x.htlc.target);
  await participant.waitForDeployment();
  return { ...x, participant };
}

function lockArgs(x, {
  recipient = x.bob.address,
  hashlock = HASH,
  timelock = x.timelock,
  amount = AMOUNT
} = {}) {
  return [recipient, hashlock, timelock, { value: amount }];
}

// Compute the frozen ID formula independently to check the chain, contract, sender, and nonce.
async function expectedId(htlc, sender, nonce = 0) {
  const { chainId } = await ethers.provider.getNetwork();
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address", "address", "uint256"],
      [chainId, htlc.target, sender, nonce]
    )
  );
}

// Read the ID from the successful receipt, as C/D must do after submitting a real lock transaction.
async function lockedLog(htlc, tx) {
  const topic = htlc.interface.getEvent("Locked").topicHash;
  const receipt = await tx.wait();
  const log = receipt.logs.find((entry) =>
    entry.address === htlc.target && entry.topics[0] === topic
  );
  expect(log, "Locked event").to.exist;
  return log;
}

async function lockSwap(x, { signer = x.alice, ...options } = {}) {
  const tx = await x.htlc.connect(signer).lock(...lockArgs(x, options));
  return (await lockedLog(x.htlc, tx)).topics[1];
}

// Make the contract wallet itself the recorded sender, so refunds must pay that contract.
async function lockFromParticipant(x, options) {
  const [recipient, hashlock, timelock, overrides] = lockArgs(x, options);
  const data = x.htlc.interface.encodeFunctionData("lock", [recipient, hashlock, timelock]);
  const tx = await x.participant.execute(data, overrides);
  return (await lockedLog(x.htlc, tx)).topics[1];
}

// Shared claim/refund check: reject payment, verify full rollback, then accept and retry.
// A failed payment must leave the original swap usable, and the retry must pay only once.
async function retryRejectedPayment(x, swapId, paymentData, status) {
  const { htlc, participant } = x;
  const activeSwap = [...(await htlc.getSwap(swapId))];
  expect(activeSwap[6]).to.equal(ACTIVE);
  await participant.setRejectPayments(true);

  await expect(participant.execute(paymentData))
    .to.be.revertedWithCustomError(htlc, "ETHTransferFailed").withArgs(swapId);
  expect([...(await htlc.getSwap(swapId))]).to.deep.equal(activeSwap);
  expect(await ethers.provider.getBalance(htlc.target)).to.equal(AMOUNT);
  expect(await ethers.provider.getBalance(participant.target)).to.equal(0n);
  expect(await participant.paymentCount()).to.equal(0n);

  await participant.setRejectPayments(false);
  const tx = await participant.execute(paymentData);
  await expect(tx).to.changeEtherBalances([htlc, participant], [-AMOUNT, AMOUNT]);
  expect([...(await htlc.getSwap(swapId))]).to.deep.equal([...activeSwap.slice(0, 6), status]);
  expect(await participant.paymentCount()).to.equal(1n);
  return tx;
}

// Shared reentrancy check: the outer payment succeeds, but a valid nested call is blocked.
// Check the exact guard error so invalid parameters cannot make this test pass by accident.
async function expectBlockedCallback(x, {
  swapId, paymentData, status, callbackData, callbackValue = 0n
}) {
  const { htlc, participant } = x;

  // Simulate the same call without saving state. It must work outside the payout callback.
  await participant.execute.staticCall(callbackData, { value: callbackValue });
  await participant.configureCallback(swapId, callbackData, callbackValue);
  const tx = await participant.execute(paymentData);

  await expect(tx).to.changeEtherBalances([htlc, participant], [-AMOUNT, AMOUNT]);
  expect(await participant.observedStatus()).to.equal(status);
  expect(await participant.callbackSucceeded()).to.equal(false);
  expect(await participant.callbackResult()).to.equal(
    htlc.interface.getError("ReentrancyGuardReentrantCall").selector
  );
  expect(await participant.paymentCount()).to.equal(1n);
  expect((await htlc.getSwap(swapId)).status).to.equal(status);
  return tx;
}

describe("ETHHTLC", function () {
  // C/D depend on the shared ABI staying compatible with A's contract.
  // Compare shared fields/types/indexing, then check the ETH-specific payable lock and payout error.
  it("matches the frozen ERC20 ABI for shared functions, events, and errors", async function () {
    const { abi: erc20Abi } = await artifacts.readArtifact("IERC20HTLC");
    const expectedLock = {
      type: "function",
      name: "lock",
      stateMutability: "payable",
      inputs: [
        { name: "recipient", type: "address", internalType: "address" },
        { name: "hashlock", type: "bytes32", internalType: "bytes32" },
        { name: "timelock", type: "uint256", internalType: "uint256" }
      ],
      outputs: [{ name: "swapId", type: "bytes32", internalType: "bytes32" }]
    };
    const expectedTransferError = {
      type: "error",
      name: "ETHTransferFailed",
      inputs: [{ name: "swapId", type: "bytes32", internalType: "bytes32" }]
    };

    for (const contract of ["IETHHTLC", "ETHHTLC"]) {
      const { abi } = await artifacts.readArtifact(contract);
      const expected = erc20Abi.filter((item) => item.name !== "lock");
      for (const fragment of [...expected, expectedLock, expectedTransferError]) {
        expect(abi, contract + "." + fragment.name).to.deep.include(fragment);
      }
      expect(abi.filter((item) => item.name === "lock")).to.deep.equal([expectedLock]);
    }
  });

  // A missing swap should be safe to query, but must never be claimable or refundable.
  // Try an unused ID and the zero ID: getSwap returns zeros, while claim/refund reject them.
  it("returns seven zero fields and rejects operations on unknown IDs", async function () {
    const { alice, bob, htlc } = await loadFixture(deployHTLC);
    for (const id of [MISSING, ZeroHash]) {
      expect([...(await htlc.getSwap(id))]).to.deep.equal(EMPTY_SWAP);
      await expect(htlc.connect(bob).claim(id, SECRET))
        .to.be.revertedWithCustomError(htlc, "SwapNotFound").withArgs(id);
      await expect(htlc.connect(alice).refund(id))
        .to.be.revertedWithCustomError(htlc, "SwapNotFound").withArgs(id);
    }
    expect(await ethers.provider.getBalance(htlc.target)).to.equal(0n);
  });

  // A successful deposit must record the agreed terms and give C/D the correct Locked event.
  // Check the ID, seven stored fields, indexed topics, and exact transfer of ETH into escrow.
  it("locks msg.value under the expected swap ID and emits the indexed fields", async function () {
    const x = await loadFixture(deployHTLC);
    const { alice, bob, htlc, timelock } = x;
    const id = await expectedId(htlc, alice.address);
    const lock = htlc.connect(alice).lock;
    expect(await lock.staticCall(...lockArgs(x))).to.equal(id);

    const tx = await lock(...lockArgs(x));
    await expect(tx).to.emit(htlc, "Locked")
      .withArgs(id, alice.address, bob.address, ZeroAddress, AMOUNT, HASH, timelock);
    expect((await lockedLog(htlc, tx)).topics).to.deep.equal([
      ethers.id("Locked(bytes32,address,address,address,uint256,bytes32,uint256)"),
      id,
      ethers.zeroPadValue(alice.address, 32),
      ethers.zeroPadValue(bob.address, 32)
    ]);
    await expect(tx).to.changeEtherBalances([alice, bob, htlc], [-AMOUNT, 0n, AMOUNT]);
    expect([...(await htlc.getSwap(id))]).to.deep.equal([
      alice.address, bob.address, ZeroAddress, AMOUNT, HASH, BigInt(timelock), ACTIVE
    ]);
  });

  // Bad deposits must not create a swap, keep ETH, or consume a nonce.
  // Combine invalid inputs to check error order; reject past/current deadlines, then make a valid lock.
  it("checks lock inputs in order and preserves the first nonce after failure", async function () {
    const x = await loadFixture(deployHTLC);
    const { alice, htlc } = x;
    const id = await expectedId(htlc, alice.address);
    const lock = htlc.connect(alice).lock;
    const past = (await time.latest()) - 1;
    const invalidCases = [
      [{ recipient: ZeroAddress, amount: 0n, hashlock: ZeroHash, timelock: past }, "InvalidAddress"],
      [{ amount: 0n, hashlock: ZeroHash, timelock: past }, "InvalidAmount"],
      [{ hashlock: ZeroHash, timelock: past }, "InvalidHashlock"],
      [{ timelock: past }, "InvalidTimelock"]
    ];
    for (const [options, error] of invalidCases) {
      await expect(lock(...lockArgs(x, options))).to.be.revertedWithCustomError(htlc, error);
      expect([...(await htlc.getSwap(id))]).to.deep.equal(EMPTY_SWAP);
      expect(await ethers.provider.getBalance(htlc.target)).to.equal(0n);
    }

    const exact = (await time.latest()) + 1;
    await time.setNextBlockTimestamp(exact);
    await expect(lock(...lockArgs(x, { timelock: exact })))
      .to.be.revertedWithCustomError(htlc, "InvalidTimelock");
    expect([...(await htlc.getSwap(id))]).to.deep.equal(EMPTY_SWAP);
    expect(await ethers.provider.getBalance(htlc.target)).to.equal(0n);

    const next = exact + 1;
    await time.setNextBlockTimestamp(next);
    const tx = await lock(...lockArgs(x, { timelock: next + 1 }));
    const block = await ethers.provider.getBlock((await tx.wait()).blockNumber);
    expect(block.timestamp).to.equal(next);
    expect((await lockedLog(htlc, tx)).topics[1]).to.equal(id);
    expect((await htlc.getSwap(id)).status).to.equal(ACTIVE);
  });

  // Repeated parameters and different senders must still create separate deposits.
  // Create three swaps, mix claims with a refund, and check that each affects only its own funds/state.
  it("increments the contract nonce across senders and settles each active swap independently", async function () {
    const x = await loadFixture(deployHTLC);
    const { alice, bob, outsider, htlc, timelock } = x;
    const first = await lockSwap(x);
    const second = await lockSwap(x);
    const third = await lockSwap(x, {
      signer: outsider,
      recipient: alice.address,
      amount: 2n,
      hashlock: BINARY_HASH,
      timelock: timelock + 100
    });

    expect([first, second, third]).to.deep.equal([
      await expectedId(htlc, alice.address, 0),
      await expectedId(htlc, alice.address, 1),
      await expectedId(htlc, outsider.address, 2)
    ]);
    expect(new Set([first, second, third]).size).to.equal(3);
    expect(await ethers.provider.getBalance(htlc.target)).to.equal(AMOUNT * 2n + 2n);

    const claim = await htlc.connect(bob).claim(first, SECRET);
    await expect(claim).to.changeEtherBalances([bob, htlc], [AMOUNT, -AMOUNT]);
    expect((await htlc.getSwap(first)).status).to.equal(CLAIMED);
    expect((await htlc.getSwap(second)).status).to.equal(ACTIVE);
    expect((await htlc.getSwap(third)).status).to.equal(ACTIVE);

    await time.increaseTo(timelock);
    const refund = await htlc.connect(alice).refund(second);
    await expect(refund).to.changeEtherBalances([alice, htlc], [AMOUNT, -AMOUNT]);
    expect((await htlc.getSwap(first)).status).to.equal(CLAIMED);
    expect((await htlc.getSwap(second)).status).to.equal(REFUNDED);
    expect((await htlc.getSwap(third)).status).to.equal(ACTIVE);

    const finalClaim = await htlc.connect(alice).claim(third, BINARY_SECRET);
    await expect(finalClaim).to.changeEtherBalances([alice, htlc], [2n, -2n]);
    expect((await htlc.getSwap(third)).status).to.equal(CLAIMED);
    expect(await ethers.provider.getBalance(htlc.target)).to.equal(0n);
  });

  // Both caller permission and the secret must be correct before any ETH can leave escrow.
  // Try wrong callers and a wrong secret, then use the matching binary secret and check payment/event.
  it("requires the recipient and exact bytes32 preimage to claim", async function () {
    const x = await loadFixture(deployHTLC);
    const { alice, bob, outsider, htlc } = x;
    const id = await lockSwap(x, { hashlock: BINARY_HASH });
    const activeSwap = [...(await htlc.getSwap(id))];

    for (const signer of [alice, outsider]) {
      await expect(htlc.connect(signer).claim(id, SECRET))
        .to.be.revertedWithCustomError(htlc, "UnauthorizedReceiver").withArgs(id, signer.address);
    }
    await expect(htlc.connect(bob).claim(id, SECRET))
      .to.be.revertedWithCustomError(htlc, "InvalidSecret").withArgs(id);
    expect([...(await htlc.getSwap(id))]).to.deep.equal(activeSwap);
    expect(await ethers.provider.getBalance(htlc.target)).to.equal(AMOUNT);

    const tx = await htlc.connect(bob).claim(id, BINARY_SECRET);
    await expect(tx).to.emit(htlc, "Claimed").withArgs(id, BINARY_SECRET);
    await expect(tx).to.changeEtherBalances([alice, bob, htlc], [0n, AMOUNT, -AMOUNT]);
    expect([...(await htlc.getSwap(id))]).to.deep.equal([...activeSwap.slice(0, 6), CLAIMED]);
  });

  // Valid edge values must work: one wei is a valid amount, and a zero secret can have a valid hash.
  // Claim at T-1 to check the last valid second before the deadline, using a different sender/recipient.
  it("claims one wei for a zero bytes32 preimage at timelock minus one", async function () {
    const x = await loadFixture(deployHTLC);
    const { alice, outsider, htlc, timelock } = x;
    const id = await lockSwap(x, {
      signer: outsider, recipient: alice.address, amount: 1n, hashlock: ethers.keccak256(ZeroHash)
    });

    await time.setNextBlockTimestamp(timelock - 1);
    const tx = await htlc.connect(alice).claim(id, ZeroHash);
    expect((await ethers.provider.getBlock((await tx.wait()).blockNumber)).timestamp)
      .to.equal(timelock - 1);
    await expect(tx).to.emit(htlc, "Claimed").withArgs(id, ZeroHash);
    await expect(tx).to.changeEtherBalances([alice, htlc], [1n, -1n]);
    expect((await htlc.getSwap(id)).status).to.equal(CLAIMED);
  });

  // The time boundary must allow claim before T and refund from T, without an overlap or a gap.
  // At T-1 reject early/wrong-caller refunds; at T reject claim and let the original sender refund.
  it("rejects early and unauthorized refunds and allows refund at the exact deadline", async function () {
    const x = await loadFixture(deployHTLC);
    const { alice, bob, htlc, timelock } = x;
    const id = await lockSwap(x);
    const activeSwap = [...(await htlc.getSwap(id))];

    await time.setNextBlockTimestamp(timelock - 1);
    await expect(htlc.connect(bob).refund(id))
      .to.be.revertedWithCustomError(htlc, "UnauthorizedSender").withArgs(id, bob.address);
    await time.setNextBlockTimestamp(timelock - 1);
    await expect(htlc.connect(alice).refund(id))
      .to.be.revertedWithCustomError(htlc, "SwapNotExpired").withArgs(id);

    await time.setNextBlockTimestamp(timelock);
    await expect(htlc.connect(bob).claim(id, BINARY_SECRET))
      .to.be.revertedWithCustomError(htlc, "SwapExpired").withArgs(id);
    expect([...(await htlc.getSwap(id))]).to.deep.equal(activeSwap);

    await time.setNextBlockTimestamp(timelock);
    const tx = await htlc.connect(alice).refund(id);
    expect((await ethers.provider.getBlock((await tx.wait()).blockNumber)).timestamp)
      .to.equal(timelock);
    await expect(tx).to.emit(htlc, "Refunded").withArgs(id);
    await expect(tx).to.changeEtherBalances([alice, bob, htlc], [AMOUNT, 0n, -AMOUNT]);
    expect([...(await htlc.getSwap(id))]).to.deep.equal([...activeSwap.slice(0, 6), REFUNDED]);
  });

  // Expiry does not give unrelated accounts permission to act on the swap.
  // After T, check caller errors before time errors, reject the recipient's claim, and refund the sender.
  it("checks the caller before expiration and refunds after the deadline", async function () {
    const x = await loadFixture(deployHTLC);
    const { alice, bob, outsider, htlc, timelock } = x;
    const id = await lockSwap(x);
    await time.increaseTo(timelock + 1);

    await expect(htlc.connect(outsider).claim(id, SECRET))
      .to.be.revertedWithCustomError(htlc, "UnauthorizedReceiver").withArgs(id, outsider.address);
    await expect(htlc.connect(bob).claim(id, SECRET))
      .to.be.revertedWithCustomError(htlc, "SwapExpired").withArgs(id);
    await expect(htlc.connect(outsider).refund(id))
      .to.be.revertedWithCustomError(htlc, "UnauthorizedSender").withArgs(id, outsider.address);

    const tx = await htlc.connect(alice).refund(id);
    await expect(tx).to.changeEtherBalances([alice, htlc], [AMOUNT, -AMOUNT]);
    expect((await htlc.getSwap(id)).status).to.equal(REFUNDED);
  });

  // Run one case for each final state. Once paid, neither operation may release ETH again.
  // Try both the rightful accounts and an outsider to confirm the final-state check takes priority.
  for (const terminalStatus of [CLAIMED, REFUNDED]) {
    const terminal = terminalStatus === CLAIMED ? "Claimed" : "Refunded";
    it("rejects both operations on a " + terminal + " swap", async function () {
      const x = await loadFixture(deployHTLC);
      const { alice, bob, outsider, htlc, timelock } = x;
      const id = await lockSwap(x);
      if (terminalStatus === CLAIMED) {
        await htlc.connect(bob).claim(id, SECRET);
      } else {
        await time.increaseTo(timelock);
        await htlc.connect(alice).refund(id);
      }

      await expect(htlc.connect(bob).claim(id, SECRET))
        .to.be.revertedWithCustomError(htlc, "SwapNotActive").withArgs(id);
      await expect(htlc.connect(alice).refund(id))
        .to.be.revertedWithCustomError(htlc, "SwapNotActive").withArgs(id);
      await expect(htlc.connect(outsider).claim(id, BINARY_SECRET))
        .to.be.revertedWithCustomError(htlc, "SwapNotActive").withArgs(id);
      await expect(htlc.connect(outsider).refund(id))
        .to.be.revertedWithCustomError(htlc, "SwapNotActive").withArgs(id);
      expect((await htlc.getSwap(id)).status).to.equal(terminalStatus);
      expect(await ethers.provider.getBalance(htlc.target)).to.equal(0n);
    });
  }

  // Funds should enter through lock, where their owner and swap terms can be recorded.
  // Try direct ETH and unknown calldata with/without ETH; the existing swap and escrow must not change.
  it("rejects direct transfers and calls with unknown calldata", async function () {
    const x = await loadFixture(deployHTLC);
    const { alice, htlc } = x;
    const id = await lockSwap(x);
    const activeSwap = [...(await htlc.getSwap(id))];

    for (const input of [{ value: 1n }, { value: 1n, data: "0xdeadbeef" }, { data: "0xdeadbeef" }]) {
      await expect(alice.sendTransaction({ to: htlc.target, ...input }))
        .to.be.revertedWithCustomError(htlc, "UnexpectedEther");
    }
    expect([...(await htlc.getSwap(id))]).to.deep.equal(activeSwap);
    expect(await ethers.provider.getBalance(htlc.target)).to.equal(AMOUNT);
  });

  // Querying or settling a swap must not accidentally accept another ETH deposit.
  // Send value with valid calldata for all three non-payable functions and check that escrow is unchanged.
  it("rejects ETH attached to claim, refund, or getSwap", async function () {
    const x = await loadFixture(deployHTLC);
    const { alice, bob, htlc, timelock } = x;
    const id = await lockSwap(x);
    const calls = [
      [bob, "getSwap", [id]],
      [bob, "claim", [id, SECRET]],
      [alice, "refund", [id]]
    ];

    for (const [signer, method, args] of calls) {
      if (method === "refund") await time.increaseTo(timelock);
      await expect(signer.sendTransaction({
        to: htlc.target,
        data: htlc.interface.encodeFunctionData(method, args),
        value: 1n
      })).to.be.revertedWithoutReason();
    }
    expect((await htlc.getSwap(id)).status).to.equal(ACTIVE);
    expect(await ethers.provider.getBalance(htlc.target)).to.equal(AMOUNT);
  });

  describe("contract recipients and senders", function () {
    // A recipient may know the secret but still reject the ETH in its receive function.
    // Check that the failed claim fully rolls back, then allow payment and claim exactly once.
    it("rolls back a rejected claim payment and lets the recipient retry", async function () {
      const x = await loadFixture(deployWithParticipant);
      const { htlc, participant } = x;
      const id = await lockSwap(x, { recipient: participant.target });
      const data = htlc.interface.encodeFunctionData("claim", [id, SECRET]);

      const tx = await retryRejectedPayment(x, id, data, CLAIMED);
      await expect(tx).to.emit(htlc, "Claimed").withArgs(id, SECRET);
    });

    // The sender's timeout recovery must not depend on the recipient agreeing to receive ETH.
    // Keep the recipient rejecting: claim fails, early refund fails, refund at T succeeds, and repeats fail.
    it("lets the sender refund at expiry after the recipient rejects a claim", async function () {
      const x = await loadFixture(deployWithParticipant);
      const { alice, htlc, participant, timelock } = x;
      const id = await lockSwap(x, { recipient: participant.target });
      const activeSwap = [...(await htlc.getSwap(id))];
      const claimData = htlc.interface.encodeFunctionData("claim", [id, SECRET]);
      await participant.setRejectPayments(true);

      // The authorized recipient knows the secret, but rejects the ETH payment.
      expect(await time.latest()).to.be.lessThan(timelock);
      await expect(participant.execute(claimData))
        .to.be.revertedWithCustomError(htlc, "ETHTransferFailed").withArgs(id);
      expect([...(await htlc.getSwap(id))]).to.deep.equal(activeSwap);
      expect(await ethers.provider.getBalance(htlc.target)).to.equal(AMOUNT);
      expect(await ethers.provider.getBalance(participant.target)).to.equal(0n);
      expect(await participant.paymentCount()).to.equal(0n);

      // A rejected claim does not let the sender bypass the original deadline.
      await expect(htlc.connect(alice).refund(id))
        .to.be.revertedWithCustomError(htlc, "SwapNotExpired").withArgs(id);

      // Expiry alone leaves the stored status Active. The recipient still rejects ETH.
      await time.increaseTo(timelock);
      expect([...(await htlc.getSwap(id))]).to.deep.equal(activeSwap);
      await time.setNextBlockTimestamp(timelock);
      const tx = await htlc.connect(alice).refund(id);
      expect((await ethers.provider.getBlock((await tx.wait()).blockNumber)).timestamp)
        .to.equal(timelock);
      await expect(tx).to.emit(htlc, "Refunded").withArgs(id);
      await expect(tx).to.changeEtherBalances([alice, participant, htlc], [AMOUNT, 0n, -AMOUNT]);
      expect([...(await htlc.getSwap(id))]).to.deep.equal([...activeSwap.slice(0, 6), REFUNDED]);
      expect(await ethers.provider.getBalance(htlc.target)).to.equal(0n);
      expect(await participant.paymentCount()).to.equal(0n);

      await expect(participant.execute(claimData))
        .to.be.revertedWithCustomError(htlc, "SwapNotActive").withArgs(id);
      await expect(htlc.connect(alice).refund(id))
        .to.be.revertedWithCustomError(htlc, "SwapNotActive").withArgs(id);
    });

    // The original sender can also be a contract that rejects ETH.
    // After expiry, reject its refund payment, check rollback, then accept ETH and retry the same refund.
    it("rolls back a rejected refund payment and lets the sender retry", async function () {
      const x = await loadFixture(deployWithParticipant);
      const { htlc, timelock } = x;
      const id = await lockFromParticipant(x);
      await time.increaseTo(timelock);
      const data = htlc.interface.encodeFunctionData("refund", [id]);

      const tx = await retryRejectedPayment(x, id, data, REFUNDED);
      await expect(tx).to.emit(htlc, "Refunded").withArgs(id);
    });

    // A receiving contract tries to claim a different Active swap during the first payout.
    // Require the guard error, one payment, a visible Claimed state, and the other swap still Active.
    it("blocks a valid reentrant claim while exposing Claimed in the payout callback", async function () {
      const x = await loadFixture(deployWithParticipant);
      const { htlc, participant } = x;
      const id = await lockSwap(x, { recipient: participant.target });
      const other = await lockSwap(x, { recipient: participant.target, amount: 2n });
      const tx = await expectBlockedCallback(x, {
        swapId: id,
        status: CLAIMED,
        paymentData: htlc.interface.encodeFunctionData("claim", [id, SECRET]),
        callbackData: htlc.interface.encodeFunctionData("claim", [other, SECRET])
      });

      await expect(tx).to.emit(htlc, "Claimed").withArgs(id, SECRET);
      expect((await htlc.getSwap(other)).status).to.equal(ACTIVE);
      expect(await ethers.provider.getBalance(htlc.target)).to.equal(2n);
    });

    // A sender contract tries to refund a second expired swap while receiving the first refund.
    // Require the guard error, one payment, a visible Refunded state, and the other swap still Active.
    it("blocks a valid reentrant refund while exposing Refunded in the payout callback", async function () {
      const x = await loadFixture(deployWithParticipant);
      const { htlc, timelock } = x;
      const id = await lockFromParticipant(x);
      const other = await lockFromParticipant(x, { amount: 2n });
      await time.increaseTo(timelock);
      const tx = await expectBlockedCallback(x, {
        swapId: id,
        status: REFUNDED,
        paymentData: htlc.interface.encodeFunctionData("refund", [id]),
        callbackData: htlc.interface.encodeFunctionData("refund", [other])
      });

      await expect(tx).to.emit(htlc, "Refunded").withArgs(id);
      expect((await htlc.getSwap(other)).status).to.equal(ACTIVE);
      expect(await ethers.provider.getBalance(htlc.target)).to.equal(2n);
    });

    // A recipient uses one wei of its payout to try opening a new valid swap during the callback.
    // Check that lock is guarded too: no new swap or Locked event, and the original claim pays only once.
    it("blocks a valid reentrant lock funded from a claim payment", async function () {
      const x = await loadFixture(deployWithParticipant);
      const { bob, htlc, participant, timelock } = x;
      const id = await lockSwap(x, { recipient: participant.target });
      const blockedId = await expectedId(htlc, participant.target, 1);
      const tx = await expectBlockedCallback(x, {
        swapId: id,
        status: CLAIMED,
        paymentData: htlc.interface.encodeFunctionData("claim", [id, SECRET]),
        callbackData: htlc.interface.encodeFunctionData("lock", [bob.address, BINARY_HASH, timelock]),
        callbackValue: 1n
      });

      await expect(tx).to.emit(htlc, "Claimed").withArgs(id, SECRET);
      await expect(tx).not.to.emit(htlc, "Locked");
      expect([...(await htlc.getSwap(blockedId))]).to.deep.equal(EMPTY_SWAP);
      expect(await ethers.provider.getBalance(htlc.target)).to.equal(0n);
    });
  });
});
