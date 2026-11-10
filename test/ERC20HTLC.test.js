/**
 * 按 ERC20HTLC_测试矩阵.md 编写的单元测试。
 * 覆盖 P0：L01-L13 / C01-C08 / R01-R08 / G01-G05；P1：L14 / C09 / R09。
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const SECRET = ethers.encodeBytes32String("a-role-test-secret");
const WRONG = ethers.encodeBytes32String("wrong-secret");
const SECRET2 = ethers.encodeBytes32String("another-secret");
const HASH = ethers.keccak256(SECRET);
const HASH2 = ethers.keccak256(SECRET2);
const AMOUNT = ethers.parseUnits("100", 18);
const INITIAL = ethers.parseUnits("1000", 18);
const ZERO = ethers.ZeroHash;
const NONE = 0, ACTIVE = 1, CLAIMED = 2, REFUNDED = 3;

async function fixture() {
  const [deployer, alice, bob, attacker] = await ethers.getSigners();
  const mst = await (await ethers.getContractFactory("MockMST")).deploy();
  await mst.waitForDeployment();
  const htlc = await (await ethers.getContractFactory("ERC20HTLC")).deploy();
  await htlc.waitForDeployment();
  await mst.mint(alice.address, INITIAL);
  await mst.connect(alice).approve(htlc.target, AMOUNT);
  const timelock = (await time.latest()) + 3600;
  return { deployer, alice, bob, attacker, mst, htlc, timelock };
}
const setup = () => loadFixture(fixture);

function lockArgs(x, o = {}) {
  return [
    o.token ?? x.mst.target,
    o.recipient ?? x.bob.address,
    o.amount ?? AMOUNT,
    o.hashlock ?? HASH,
    o.timelock ?? x.timelock
  ];
}

function lockedEvent(receipt, htlc) {
  for (const log of receipt.logs) {
    try {
      const p = htlc.interface.parseLog({ topics: log.topics, data: log.data });
      if (p && p.name === "Locked") return p;
    } catch (_) {
      // 其它合约的事件
    }
  }
  return null;
}

async function expectedId(htlc, sender, nonce = 0) {
  const { chainId } = await ethers.provider.getNetwork();
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "address", "address", "uint256"],
      [chainId, htlc.target, sender, nonce]
    )
  );
}

async function lock(x, o = {}) {
  const tx = await x.htlc.connect(o.signer ?? x.alice).lock(...lockArgs(x, o));
  const ev = lockedEvent(await tx.wait(), x.htlc);
  expect(ev).to.not.equal(null);
  return ev.args[0];
}

async function assertClean(x, sender) {
  expect((await x.htlc.getSwap(await expectedId(x.htlc, sender))).status).to.equal(NONE);
  expect(await x.mst.balanceOf(x.htlc.target)).to.equal(0n);
  expect(await x.mst.balanceOf(x.alice.address)).to.equal(INITIAL);
}

describe("ERC20HTLC（测试矩阵 P0 + P1）", function () {
  describe("查询与正常锁定", function () {
    it("G01 不存在的 swap 返回七字段零值", async function () {
      const x = await setup();
      const s = await x.htlc.getSwap(ethers.encodeBytes32String("missing"));
      expect(s.length).to.equal(7);
      expect(s[0]).to.equal(ethers.ZeroAddress);
      expect(s[1]).to.equal(ethers.ZeroAddress);
      expect(s[2]).to.equal(ethers.ZeroAddress);
      expect(s[3]).to.equal(0n);
      expect(s[4]).to.equal(ZERO);
      expect(s[5]).to.equal(0n);
      expect(s[6]).to.equal(NONE);
    });

    it("L01 正常 lock：swapId、七字段、状态、余额、事件", async function () {
      const x = await setup();
      const id = await expectedId(x.htlc, x.alice.address);
      expect(await x.htlc.connect(x.alice).lock.staticCall(...lockArgs(x))).to.equal(id);

      const before = await x.mst.balanceOf(x.alice.address);
      const tx = await x.htlc.connect(x.alice).lock(...lockArgs(x));
      const ev = lockedEvent(await tx.wait(), x.htlc);
      expect(ev.args[0]).to.equal(id);
      expect(ev.args[1]).to.equal(x.alice.address);
      expect(ev.args[2]).to.equal(x.bob.address);
      expect(ev.args[3]).to.equal(x.mst.target);
      expect(ev.args[4]).to.equal(AMOUNT);
      expect(ev.args[5]).to.equal(HASH);
      expect(ev.args[6]).to.equal(x.timelock);

      const s = await x.htlc.getSwap(id);
      expect(s[0]).to.equal(x.alice.address);
      expect(s[1]).to.equal(x.bob.address);
      expect(s[2]).to.equal(x.mst.target);
      expect(s[3]).to.equal(AMOUNT);
      expect(s[4]).to.equal(HASH);
      expect(s[5]).to.equal(x.timelock);
      expect(s[6]).to.equal(ACTIVE);
      expect(await x.mst.balanceOf(x.alice.address)).to.equal(before - AMOUNT);
      expect(await x.mst.balanceOf(x.htlc.target)).to.equal(AMOUNT);
    });

    it("G02 getSwap 返回顺序与类型正确", async function () {
      const x = await setup();
      const id = await lock(x, { amount: 7n, hashlock: HASH2, timelock: x.timelock + 100 });
      const s = await x.htlc.getSwap(id);
      expect(s.length).to.equal(7);
      expect(s[3]).to.equal(7n);
      expect(s[4]).to.equal(HASH2);
      expect(s[5]).to.equal(x.timelock + 100);
      expect(s[6]).to.equal(ACTIVE);
    });
  });

  describe("L：lock 校验与失败路径", function () {
    const bad = [
      ["L02", "token=0", { token: ethers.ZeroAddress }, "InvalidToken"],
      ["L03", "recipient=0", { recipient: ethers.ZeroAddress }, "InvalidAddress"],
      ["L04", "amount=0", { amount: 0n }, "InvalidAmount"],
      ["L05", "hashlock=0", { hashlock: ZERO }, "InvalidHashlock"]
    ];
    for (const [id, desc, o, err] of bad) {
      it(`${id} ${desc} -> ${err}，无状态污染`, async function () {
        const x = await setup();
        await expect(x.htlc.connect(x.alice).lock(...lockArgs(x, o)))
          .to.be.revertedWithCustomError(x.htlc, err);
        await assertClean(x, x.alice.address);
      });
    }

    it("L06 过去 / 恰等于当前时间的 timelock -> InvalidTimelock", async function () {
      const x = await setup();
      await expect(
        x.htlc.connect(x.alice).lock(...lockArgs(x, { timelock: (await time.latest()) - 1 }))
      ).to.be.revertedWithCustomError(x.htlc, "InvalidTimelock");
      const exact = (await time.latest()) + 1;
      await time.setNextBlockTimestamp(exact);
      await expect(
        x.htlc.connect(x.alice).lock(...lockArgs(x, { timelock: exact }))
      ).to.be.revertedWithCustomError(x.htlc, "InvalidTimelock");
      await assertClean(x, x.alice.address);
    });

    it("L07 未 approve -> revert，无状态污染", async function () {
      const x = await setup();
      await x.mst.connect(x.alice).approve(x.htlc.target, 0n);
      await expect(x.htlc.connect(x.alice).lock(...lockArgs(x))).to.be.reverted;
      await assertClean(x, x.alice.address);
    });

    it("L08 allowance 不足 -> revert", async function () {
      const x = await setup();
      await x.mst.connect(x.alice).approve(x.htlc.target, AMOUNT - 1n);
      await expect(x.htlc.connect(x.alice).lock(...lockArgs(x))).to.be.reverted;
      await assertClean(x, x.alice.address);
    });

    it("L09 余额不足但 allowance 足够 -> revert", async function () {
      const x = await setup();
      await x.mst.connect(x.attacker).approve(x.htlc.target, AMOUNT);
      await expect(x.htlc.connect(x.attacker).lock(...lockArgs(x))).to.be.reverted;
      expect((await x.htlc.getSwap(await expectedId(x.htlc, x.attacker.address))).status)
        .to.equal(NONE);
      expect(await x.mst.balanceOf(x.htlc.target)).to.equal(0n);
    });

    it("L10 同参数两次 lock -> 两个不同 swapId、两笔独立 Active", async function () {
      const x = await setup();
      await x.mst.connect(x.alice).approve(x.htlc.target, AMOUNT * 2n);
      const a = await lock(x);
      const b = await lock(x);
      expect(a).to.not.equal(b);
      expect(a).to.equal(await expectedId(x.htlc, x.alice.address, 0));
      expect(b).to.equal(await expectedId(x.htlc, x.alice.address, 1));
      expect((await x.htlc.getSwap(a)).status).to.equal(ACTIVE);
      expect((await x.htlc.getSwap(b)).status).to.equal(ACTIVE);
      expect(await x.mst.balanceOf(x.htlc.target)).to.equal(AMOUNT * 2n);
    });

    it("L11 lock 附带 ETH -> revert，无 swap", async function () {
      const x = await setup();
      await expect(
        x.htlc.connect(x.alice).lock(...lockArgs(x), { value: 1n })
      ).to.be.reverted;
      await assertClean(x, x.alice.address);
    });

    it("L12 直接转 ETH -> UnexpectedEther", async function () {
      const x = await setup();
      await expect(x.alice.sendTransaction({ to: x.htlc.target, value: 1n }))
        .to.be.revertedWithCustomError(x.htlc, "UnexpectedEther");
    });

    it("L13 直接转 MST 不形成 swap、不改变已有 amount", async function () {
      const x = await setup();
      const id = await lock(x);
      const extra = ethers.parseUnits("50", 18);
      await expect(x.mst.connect(x.alice).transfer(x.htlc.target, extra))
        .to.not.emit(x.htlc, "Locked");
      expect((await x.htlc.getSwap(id)).amount).to.equal(AMOUNT);
      await x.htlc.connect(x.bob).claim(id, SECRET);
      expect(await x.mst.balanceOf(x.bob.address)).to.equal(AMOUNT);
      expect(await x.mst.balanceOf(x.htlc.target)).to.equal(extra);
    });

    it("L14 (P1) 非标准 ERC20 返回 false -> SafeERC20 revert、状态回滚", async function () {
      const x = await setup();
      const bad = await (await ethers.getContractFactory("MockMaliciousERC20")).deploy();
      await bad.waitForDeployment();
      await bad.mint(x.alice.address, AMOUNT);
      await bad.connect(x.alice).approve(x.htlc.target, AMOUNT);
      await bad.configure(1, x.htlc.target, ZERO, SECRET);
      await expect(
        x.htlc.connect(x.alice).lock(...lockArgs(x, { token: bad.target }))
      ).to.be.reverted;
      expect((await x.htlc.getSwap(await expectedId(x.htlc, x.alice.address))).status)
        .to.equal(NONE);
      expect(await bad.balanceOf(x.htlc.target)).to.equal(0n);
    });
  });

  describe("C：claim 领取路径", function () {
    it("C01 正确 secret 领取：余额、状态、事件公开 secret", async function () {
      const x = await setup();
      const id = await lock(x);
      await expect(x.htlc.connect(x.bob).claim(id, SECRET))
        .to.emit(x.htlc, "Claimed").withArgs(id, SECRET);
      expect(await x.mst.balanceOf(x.bob.address)).to.equal(AMOUNT);
      expect(await x.mst.balanceOf(x.htlc.target)).to.equal(0n);
      expect((await x.htlc.getSwap(id)).status).to.equal(CLAIMED);
    });

    it("C02 不存在的 swapId -> SwapNotFound", async function () {
      const x = await setup();
      const id = ethers.encodeBytes32String("nonexistent");
      await expect(x.htlc.connect(x.bob).claim(id, SECRET))
        .to.be.revertedWithCustomError(x.htlc, "SwapNotFound").withArgs(id);
    });

    it("C03 越权领取 -> UnauthorizedReceiver", async function () {
      const x = await setup();
      const id = await lock(x);
      for (const who of [x.alice, x.attacker]) {
        await expect(x.htlc.connect(who).claim(id, SECRET))
          .to.be.revertedWithCustomError(x.htlc, "UnauthorizedReceiver")
          .withArgs(id, who.address);
      }
      expect((await x.htlc.getSwap(id)).status).to.equal(ACTIVE);
    });

    it("C04 错误 secret -> InvalidSecret，之后仍可正确领取", async function () {
      const x = await setup();
      const id = await lock(x);
      await expect(x.htlc.connect(x.bob).claim(id, WRONG))
        .to.be.revertedWithCustomError(x.htlc, "InvalidSecret").withArgs(id);
      expect((await x.htlc.getSwap(id)).status).to.equal(ACTIVE);
      await x.htlc.connect(x.bob).claim(id, SECRET);
      expect(await x.mst.balanceOf(x.bob.address)).to.equal(AMOUNT);
    });

    it("C05 到期后 claim -> SwapExpired", async function () {
      const x = await setup();
      const id = await lock(x);
      await time.increaseTo(x.timelock + 10);
      await expect(x.htlc.connect(x.bob).claim(id, SECRET))
        .to.be.revertedWithCustomError(x.htlc, "SwapExpired").withArgs(id);
      expect((await x.htlc.getSwap(id)).status).to.equal(ACTIVE);
    });

    it("C06 now == timelock 时 claim -> SwapExpired", async function () {
      const x = await setup();
      const id = await lock(x);
      await time.setNextBlockTimestamp(x.timelock);
      await expect(x.htlc.connect(x.bob).claim(id, SECRET))
        .to.be.revertedWithCustomError(x.htlc, "SwapExpired").withArgs(id);
      expect((await x.htlc.getSwap(id)).status).to.equal(ACTIVE);
    });

    it("C07 重复 claim -> SwapNotActive，不重复转账", async function () {
      const x = await setup();
      const id = await lock(x);
      await x.htlc.connect(x.bob).claim(id, SECRET);
      await expect(x.htlc.connect(x.bob).claim(id, SECRET))
        .to.be.revertedWithCustomError(x.htlc, "SwapNotActive").withArgs(id);
      expect(await x.mst.balanceOf(x.bob.address)).to.equal(AMOUNT);
    });

    it("C08 refund 后 claim -> SwapNotActive", async function () {
      const x = await setup();
      const id = await lock(x);
      await time.increaseTo(x.timelock);
      await x.htlc.connect(x.alice).refund(id);
      await expect(x.htlc.connect(x.bob).claim(id, SECRET))
        .to.be.revertedWithCustomError(x.htlc, "SwapNotActive").withArgs(id);
    });

    it("C09 (P1) 恶意代币回调重入：资产只释放一次", async function () {
      const x = await setup();
      const bad = await (await ethers.getContractFactory("MockMaliciousERC20")).deploy();
      await bad.waitForDeployment();
      await bad.mint(x.alice.address, AMOUNT);
      await bad.connect(x.alice).approve(x.htlc.target, AMOUNT);
      await bad.configure(0, x.htlc.target, ZERO, SECRET);
      const id = await lock(x, { token: bad.target });
      await bad.configure(3, x.htlc.target, id, SECRET);

      await expect(x.htlc.connect(x.bob).claim(id, SECRET))
        .to.emit(x.htlc, "Claimed").withArgs(id, SECRET);
      expect(await bad.reenterAttempts()).to.equal(3n);
      expect(await bad.reenterSuccesses()).to.equal(0n);
      expect(await bad.balanceOf(x.bob.address)).to.equal(AMOUNT);
      expect(await bad.balanceOf(x.htlc.target)).to.equal(0n);
      expect((await x.htlc.getSwap(id)).status).to.equal(CLAIMED);
    });
  });

  describe("R：refund 退款路径", function () {
    it("R01 到期后退款：金额、状态、事件", async function () {
      const x = await setup();
      const id = await lock(x);
      await time.increaseTo(x.timelock + 5);
      const before = await x.mst.balanceOf(x.alice.address);
      await expect(x.htlc.connect(x.alice).refund(id))
        .to.emit(x.htlc, "Refunded").withArgs(id);
      expect(await x.mst.balanceOf(x.alice.address)).to.equal(before + AMOUNT);
      expect(await x.mst.balanceOf(x.htlc.target)).to.equal(0n);
      expect((await x.htlc.getSwap(id)).status).to.equal(REFUNDED);
    });

    it("R02 到期前退款 -> SwapNotExpired", async function () {
      const x = await setup();
      const id = await lock(x);
      await expect(x.htlc.connect(x.alice).refund(id))
        .to.be.revertedWithCustomError(x.htlc, "SwapNotExpired").withArgs(id);
      expect((await x.htlc.getSwap(id)).status).to.equal(ACTIVE);
    });

    it("R03 非 sender 退款 -> UnauthorizedSender", async function () {
      const x = await setup();
      const id = await lock(x);
      await time.increaseTo(x.timelock);
      for (const who of [x.bob, x.attacker]) {
        await expect(x.htlc.connect(who).refund(id))
          .to.be.revertedWithCustomError(x.htlc, "UnauthorizedSender")
          .withArgs(id, who.address);
      }
    });

    it("R04 不存在的 swapId -> SwapNotFound", async function () {
      const x = await setup();
      const id = ethers.encodeBytes32String("nonexistent");
      await expect(x.htlc.connect(x.alice).refund(id))
        .to.be.revertedWithCustomError(x.htlc, "SwapNotFound").withArgs(id);
    });

    it("R05 重复退款 -> SwapNotActive", async function () {
      const x = await setup();
      const id = await lock(x);
      await time.increaseTo(x.timelock);
      await x.htlc.connect(x.alice).refund(id);
      const after = await x.mst.balanceOf(x.alice.address);
      await expect(x.htlc.connect(x.alice).refund(id))
        .to.be.revertedWithCustomError(x.htlc, "SwapNotActive").withArgs(id);
      expect(await x.mst.balanceOf(x.alice.address)).to.equal(after);
    });

    it("R06 claim 后退款 -> SwapNotActive", async function () {
      const x = await setup();
      const id = await lock(x);
      await x.htlc.connect(x.bob).claim(id, SECRET);
      await time.increaseTo(x.timelock);
      await expect(x.htlc.connect(x.alice).refund(id))
        .to.be.revertedWithCustomError(x.htlc, "SwapNotActive").withArgs(id);
    });

    it("R07 now == timelock 时 refund 成功", async function () {
      const x = await setup();
      const id = await lock(x);
      await time.setNextBlockTimestamp(x.timelock);
      const receipt = await (await x.htlc.connect(x.alice).refund(id)).wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);
      expect(block.timestamp).to.equal(x.timelock);
      expect((await x.htlc.getSwap(id)).status).to.equal(REFUNDED);
      expect(await x.mst.balanceOf(x.alice.address)).to.equal(INITIAL);
    });

    it("R08 到期后失败的 claim 不污染状态，refund 成功", async function () {
      const x = await setup();
      const id = await lock(x);
      await time.increaseTo(x.timelock);
      await expect(x.htlc.connect(x.bob).claim(id, WRONG))
        .to.be.revertedWithCustomError(x.htlc, "SwapExpired").withArgs(id);
      expect((await x.htlc.getSwap(id)).status).to.equal(ACTIVE);
      await x.htlc.connect(x.alice).refund(id);
      expect((await x.htlc.getSwap(id)).status).to.equal(REFUNDED);
    });

    it("R09 (P1) 恶意代币重入 refund：资产仅退一次", async function () {
      const x = await setup();
      const bad = await (await ethers.getContractFactory("MockMaliciousERC20")).deploy();
      await bad.waitForDeployment();
      await bad.mint(x.alice.address, AMOUNT);
      await bad.connect(x.alice).approve(x.htlc.target, AMOUNT);
      await bad.configure(0, x.htlc.target, ZERO, SECRET);
      const id = await lock(x, { token: bad.target });
      await bad.configure(3, x.htlc.target, id, SECRET);
      await time.increaseTo(x.timelock);

      const before = await bad.balanceOf(x.alice.address);
      await expect(x.htlc.connect(x.alice).refund(id))
        .to.emit(x.htlc, "Refunded").withArgs(id);
      expect(await bad.reenterAttempts()).to.equal(3n);
      expect(await bad.reenterSuccesses()).to.equal(0n);
      expect(await bad.balanceOf(x.alice.address)).to.equal(before + AMOUNT);
      expect(await bad.balanceOf(x.htlc.target)).to.equal(0n);
      expect((await x.htlc.getSwap(id)).status).to.equal(REFUNDED);
    });
  });

  describe("G：状态与通用性", function () {
    it("G03 claim / refund 后查询终态、其它字段不变", async function () {
      const x = await setup();
      await x.mst.connect(x.alice).approve(x.htlc.target, AMOUNT * 2n);
      const a = await lock(x);
      const b = await lock(x);
      await x.htlc.connect(x.bob).claim(a, SECRET);
      expect((await x.htlc.getSwap(a)).status).to.equal(CLAIMED);
      expect((await x.htlc.getSwap(a)).amount).to.equal(AMOUNT);
      await time.increaseTo(x.timelock);
      await x.htlc.connect(x.alice).refund(b);
      expect((await x.htlc.getSwap(b)).status).to.equal(REFUNDED);
      expect((await x.htlc.getSwap(b)).amount).to.equal(AMOUNT);
    });

    it("G04 两个 swap 交叉操作互不影响", async function () {
      const x = await setup();
      await x.mst.connect(x.alice).approve(x.htlc.target, AMOUNT * 3n);
      const a = await lock(x);
      const b = await lock(x);
      await x.htlc.connect(x.bob).claim(a, SECRET);
      expect((await x.htlc.getSwap(b)).status).to.equal(ACTIVE);
      expect(await x.mst.balanceOf(x.htlc.target)).to.equal(AMOUNT);
      await time.increaseTo(x.timelock);
      await x.htlc.connect(x.alice).refund(b);
      expect((await x.htlc.getSwap(a)).status).to.equal(CLAIMED);
      expect((await x.htlc.getSwap(b)).status).to.equal(REFUNDED);
      expect(await x.mst.balanceOf(x.htlc.target)).to.equal(0n);
    });

    it("G05 更换账户 / 1 wei / hashlock / deadline，无硬编码", async function () {
      const x = await setup();
      await x.mst.mint(x.deployer.address, 1n);
      await x.mst.connect(x.deployer).approve(x.htlc.target, 1n);
      const id = await lock(x, {
        signer: x.deployer,
        recipient: x.attacker.address,
        amount: 1n,
        hashlock: HASH2,
        timelock: x.timelock + 777
      });
      expect(id).to.equal(await expectedId(x.htlc, x.deployer.address, 0));
      await x.htlc.connect(x.attacker).claim(id, SECRET2);
      expect(await x.mst.balanceOf(x.attacker.address)).to.equal(1n);
      expect((await x.htlc.getSwap(id)).status).to.equal(CLAIMED);
    });
  });
});
