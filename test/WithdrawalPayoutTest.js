const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("YPMVault payout calculation", function () {
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

    const YPMVault = await ethers.getContractFactory("YPMVault");
    const yesId = 1n;
    const noId = 2n;
    const vault = await YPMVault.deploy(
      await ctf.getAddress(),
      await aavePool.getAddress(),
      await usdc.getAddress(),
      await aToken.getAddress(),
      conditionId,
      yesId,
      noId
    );
    await vault.waitForDeployment();

    // Simulate deposits via ERC1155 receive (1,000 YES to Alice, 0 NO)
    const amount = ethers.parseUnits("1000", 6);
    await ctf.depositToVault(await vault.getAddress(), alice.address, Number(yesId), amount);

    // Simulate merged and deposited to Aave by minting aTokens to vault (as if yield accrued)
    // Principal 1,000 and plus 100 yield => 1,100
    await aToken.mint(await vault.getAddress(), ethers.parseUnits("1100", 6));

    // No direct resolveMarket call; withdrawal will auto-resolve

    // Estimate payout ~ 1,100
    const est = await vault.estimateWithdrawal(alice.address);
    expect(Number(est)).to.equal(Number(ethers.parseUnits("1100", 6)));

    // Withdraw should cap to availableUnderlying (1,100)
    await expect(vault.connect(alice).withdraw(alice.address)).to.emit(vault, "Withdrawal");
  });
});



