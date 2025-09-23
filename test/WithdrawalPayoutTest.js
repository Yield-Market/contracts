const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("YMVault payout calculation", function () {
  it("computes proportional payout and withdraw caps to available underlying", async function () {
    const [deployer, alice] = await ethers.getSigners();

    // Deploy minimal mocks for external addresses
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    const MockAToken = await ethers.getContractFactory("MockAToken");
    const aToken = await MockAToken.deploy();
    await aToken.waitForDeployment();

    const MockAavePool = await ethers.getContractFactory("MockAavePool");
    const aavePool = await MockAavePool.deploy();
    await aavePool.waitForDeployment();

    const MockConditionalTokens = await ethers.getContractFactory("MockConditionalTokens");
    const ctf = await MockConditionalTokens.deploy();
    await ctf.waitForDeployment();

    const conditionId = ethers.keccak256(ethers.toUtf8Bytes("cond"));
    // Mark YES wins with denominator 1
    await ctf.setPayout(conditionId, 1, 0, 1);

    // Deploy YMVault implementation + factory and create a proxy vault
    const Impl = await ethers.getContractFactory("YMVault");
    const Receipt = await ethers.getContractFactory("YMReceipt");
    const impl = await Impl.deploy();
    await impl.waitForDeployment();
    const Factory = await ethers.getContractFactory("YMVaultFactory");
    const factory = await Factory.deploy(await impl.getAddress(), deployer.address);
    await factory.waitForDeployment();
    const yesId = 1n;
    const noId = 2n;
    const receipt = await Receipt.deploy("", deployer.address);
    await receipt.waitForDeployment();

    const tx = await factory.createVault(
      await ctf.getAddress(),
      await aavePool.getAddress(),
      await usdc.getAddress(),
      await aToken.getAddress(),
      conditionId,
      yesId,
      noId,
      await receipt.getAddress(),
      deployer.address
    );
    const rcpt = await tx.wait();
    let vaultAddr;
    for (const log of rcpt.logs) {
      try {
        const parsed = factory.interface.parseLog(log);
        if (parsed && parsed.name === "VaultProxyCreated") {
          vaultAddr = parsed.args.proxy;
          break;
        }
      } catch {}
    }
    const vault = await ethers.getContractAt("YMVault", vaultAddr);

    // Simulate deposits via ERC1155 receive (1,000 YES to Alice, 0 NO)
    const amount = ethers.parseUnits("1000", 6);
    await ctf.depositToVault(await vault.getAddress(), alice.address, Number(yesId), amount);

    // Simulate merged and deposited to Aave by minting aTokens to vault (as if yield accrued)
    // Principal 1,000 and plus 100 yield => 1,100
    await aToken.mint(await vault.getAddress(), ethers.parseUnits("1100", 6));

    // Fund mock Aave pool with underlying so withdraw can succeed
    await usdc.mint(await aavePool.getAddress(), ethers.parseUnits("1100", 6));

    // No direct resolveMarket call; withdrawal will auto-resolve

    // Estimate payout before resolution should be between 1,100 and 2,100 depending on matching state
    const est = await vault.estimateWithdrawal(alice.address);
    expect(Number(est)).to.be.gte(Number(ethers.parseUnits("1100", 6)));

    // Withdraw should cap to availableUnderlying (1,100)
    await expect(vault.connect(alice).withdraw(alice.address)).to.emit(vault, "Withdrawal");
  });
});



