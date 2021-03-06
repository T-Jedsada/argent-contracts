/* global accounts */
const ethers = require("ethers");

const Wallet = require("../build/BaseWallet");
const Registry = require("../build/ModuleRegistry");
const GuardianStorage = require("../build/GuardianStorage");
const GuardianManager = require("../build/GuardianManager");
const TransferModule = require("../build/ApprovedTransfer");
const KyberNetwork = require("../build/KyberNetworkTest");
const TokenPriceProvider = require("../build/TokenPriceProvider");
const ERC20 = require("../build/TestERC20");
const TestContract = require("../build/TestContract");

const TestManager = require("../utils/test-manager");
const { sortWalletByAddress, parseRelayReceipt } = require("../utils/utilities.js");

const ETH_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const DECIMALS = 12; // number of decimal for TOKN contract
const KYBER_RATE = 51 * 10 ** 13; // 1 TOKN = 0.00051 ETH

const ZERO_BYTES32 = ethers.constants.HashZero;

describe("Test Approved Transfer", function () {
  this.timeout(10000);

  const manager = new TestManager();

  const infrastructure = accounts[0].signer;
  const owner = accounts[1].signer;
  const guardian1 = accounts[3].signer;
  const guardian2 = accounts[4].signer;
  const guardian3 = accounts[5].signer;
  const recipient = accounts[6].signer;

  let deployer;
  let wallet;
  let guardianManager;
  let transferModule;
  let priceProvider;
  let kyber;
  let erc20;

  before(async () => {
    deployer = manager.newDeployer();
    const registry = await deployer.deploy(Registry);
    const guardianStorage = await deployer.deploy(GuardianStorage);
    kyber = await deployer.deploy(KyberNetwork);
    priceProvider = await deployer.deploy(TokenPriceProvider, {}, kyber.contractAddress);
    await priceProvider.addManager(infrastructure.address);
    guardianManager = await deployer.deploy(GuardianManager, {}, registry.contractAddress, guardianStorage.contractAddress, 24, 12);
    transferModule = await deployer.deploy(TransferModule, {}, registry.contractAddress, guardianStorage.contractAddress);
  });

  beforeEach(async () => {
    wallet = await deployer.deploy(Wallet);
    await wallet.init(owner.address, [transferModule.contractAddress, guardianManager.contractAddress]);
    erc20 = await deployer.deploy(ERC20, {}, [infrastructure.address, wallet.contractAddress], 10000000, DECIMALS); // TOKN contract with 10M tokens (5M TOKN for wallet and 5M TOKN for account[0])
    await kyber.addToken(erc20.contractAddress, KYBER_RATE, DECIMALS);
    await priceProvider.syncPrice(erc20.contractAddress);
    await infrastructure.sendTransaction({ to: wallet.contractAddress, value: 50000000 });
  });

  async function addGuardians(guardians) {
    // guardians can be Wallet or ContractWrapper objects
    const guardianAddresses = guardians.map((guardian) => {
      if (guardian.address) return guardian.address;
      return guardian.contractAddress;
    });

    for (const address of guardianAddresses) {
      await guardianManager.from(owner).addGuardian(wallet.contractAddress, address, { gasLimit: 500000 });
    }

    await manager.increaseTime(30);
    for (let i = 1; i < guardianAddresses.length; i += 1) {
      await guardianManager.confirmGuardianAddition(wallet.contractAddress, guardianAddresses[i]);
    }
    const count = (await guardianManager.guardianCount(wallet.contractAddress)).toNumber();
    assert.equal(count, guardians.length, `${guardians.length} guardians should be added`);
  }

  async function createSmartContractGuardians(guardians) {
    const wallets = [];
    for (const g of guardians) {
      const guardianWallet = await deployer.deploy(Wallet);
      await guardianWallet.init(g.address, [guardianManager.contractAddress]);
      wallets.push(guardianWallet);
    }
    return wallets;
  }

  describe("Transfer approved by EOA guardians", () => {
    it("should transfer ETH with 1 confirmations for 1 guardians", async () => {
      const amountToTransfer = 10000;
      await addGuardians([guardian1]);
      const count = (await guardianManager.guardianCount(wallet.contractAddress)).toNumber();
      assert.equal(count, 1, "1 guardians should be active");
      const before = await deployer.provider.getBalance(recipient.address);
      // should succeed with one confirmation
      await manager.relay(transferModule, "transferToken",
        [wallet.contractAddress, ETH_TOKEN, recipient.address, amountToTransfer, ZERO_BYTES32], wallet, [owner, guardian1]);
      const after = await deployer.provider.getBalance(recipient.address);
      assert.equal(after.sub(before).toNumber(), amountToTransfer, "should have transfered the ETH amount");
    });
    it("should transfer ETH with 1 confirmations for 2 guardians", async () => {
      const amountToTransfer = 10000;
      await addGuardians([guardian1, guardian2]);
      const count = (await guardianManager.guardianCount(wallet.contractAddress)).toNumber();
      assert.equal(count, 2, "2 guardians should be active");
      const before = await deployer.provider.getBalance(recipient.address);
      // should succeed with one confirmation
      await manager.relay(transferModule, "transferToken",
        [wallet.contractAddress, ETH_TOKEN, recipient.address, amountToTransfer, ZERO_BYTES32], wallet, [owner, guardian1]);
      const after = await deployer.provider.getBalance(recipient.address);
      assert.equal(after.sub(before).toNumber(), amountToTransfer, "should have transfered the ETH amount");
    });
    it("should only transfer ETH with 2 confirmations for 3 guardians", async () => {
      const amountToTransfer = 10000;
      await addGuardians([guardian1, guardian2, guardian3]);
      const count = (await guardianManager.guardianCount(wallet.contractAddress)).toNumber();
      assert.equal(count, 3, "3 guardians should be active");
      const before = await deployer.provider.getBalance(recipient.address);
      // should fail with one confirmation
      const txReceipt = await manager.relay(transferModule, "transferToken",
        [wallet.contractAddress, ETH_TOKEN, recipient.address, amountToTransfer, ZERO_BYTES32], wallet, [owner, guardian1]);
      const success = parseRelayReceipt(txReceipt);
      assert.isNotOk(success, "transfer should fail with 1 guardian confirmation");
      // should succeed with 2 confirmations
      await manager.relay(transferModule, "transferToken",
        [wallet.contractAddress, ETH_TOKEN, recipient.address, amountToTransfer, ZERO_BYTES32], wallet,
        [owner, ...sortWalletByAddress([guardian1, guardian2])]);
      const after = await deployer.provider.getBalance(recipient.address);
      assert.equal(after.sub(before).toNumber(), amountToTransfer, "should have transfered the ETH amount");
    });
    it("should fail to transfer ETH when signer is not a guardians", async () => {
      const amountToTransfer = 10000;
      const count = (await guardianManager.guardianCount(wallet.contractAddress)).toNumber();
      assert.equal(count, 0, "0 guardians should be active");
      // should fail
      const txReceipt = await manager.relay(transferModule, "transferToken",
        [wallet.contractAddress, ETH_TOKEN, recipient.address, amountToTransfer, ZERO_BYTES32], wallet, [owner, guardian1]);
      const success = parseRelayReceipt(txReceipt);
      assert.isNotOk(success, "transfer should fail when signer is not a guardian");
    });
    it("should transfer ERC20 with 1 confirmations for 1 guardians", async () => {
      const amountToTransfer = 10000;
      await addGuardians([guardian1]);
      const count = (await guardianManager.guardianCount(wallet.contractAddress)).toNumber();
      assert.equal(count, 1, "1 guardians should be active");
      const before = await erc20.balanceOf(recipient.address);
      // should succeed with one confirmation
      await manager.relay(transferModule, "transferToken",
        [wallet.contractAddress, erc20.contractAddress, recipient.address, amountToTransfer, ZERO_BYTES32], wallet, [owner, guardian1]);
      const after = await erc20.balanceOf(recipient.address);
      assert.equal(after.sub(before).toNumber(), amountToTransfer, "should have transfered the ERC20 amount");
    });
    it("should only transfer ERC20 with 2 confirmations for 3 guardians", async () => {
      const amountToTransfer = 10000;
      await addGuardians([guardian1, guardian2, guardian3]);
      const count = (await guardianManager.guardianCount(wallet.contractAddress)).toNumber();
      assert.equal(count, 3, "3 guardians should be active");
      const before = await erc20.balanceOf(recipient.address);
      // should fail with one confirmation
      const txReceipt = await manager.relay(transferModule, "transferToken",
        [wallet.contractAddress, erc20.contractAddress, recipient.address, amountToTransfer, ZERO_BYTES32], wallet, [owner, guardian1]);
      const success = parseRelayReceipt(txReceipt);
      assert.isNotOk(success, "transfer with 1 guardian signature should fail");
      // should succeed with 2 confirmations
      await manager.relay(transferModule, "transferToken",
        [wallet.contractAddress, erc20.contractAddress, recipient.address, amountToTransfer, ZERO_BYTES32], wallet,
        [owner, ...sortWalletByAddress([guardian1, guardian2])]);
      const after = await erc20.balanceOf(recipient.address);
      assert.equal(after.sub(before).toNumber(), amountToTransfer, "should have transfered the ERC20 amount");
    });
  });

  describe("Transfer approved by smart-contract guardians", () => {
    it("should transfer ETH with 1 confirmations for 1 guardians", async () => {
      const amountToTransfer = 10000;
      await addGuardians(await createSmartContractGuardians([guardian1]));
      const count = (await guardianManager.guardianCount(wallet.contractAddress)).toNumber();
      assert.equal(count, 1, "1 guardians should be active");
      const before = await deployer.provider.getBalance(recipient.address);
      // should succeed with one confirmation
      await manager.relay(transferModule, "transferToken",
        [wallet.contractAddress, ETH_TOKEN, recipient.address, amountToTransfer, ZERO_BYTES32], wallet, [owner, guardian1]);
      const after = await deployer.provider.getBalance(recipient.address);
      assert.equal(after.sub(before).toNumber(), amountToTransfer, "should have transfered the ETH amount");
    });
    it("should transfer ETH with 1 confirmations for 2 guardians", async () => {
      const amountToTransfer = 10000;
      await addGuardians(await createSmartContractGuardians([guardian1, guardian2]));
      const count = (await guardianManager.guardianCount(wallet.contractAddress)).toNumber();
      assert.equal(count, 2, "2 guardians should be active");
      const before = await deployer.provider.getBalance(recipient.address);
      // should succeed with one confirmation
      await manager.relay(transferModule, "transferToken",
        [wallet.contractAddress, ETH_TOKEN, recipient.address, amountToTransfer, ZERO_BYTES32], wallet, [owner, guardian1]);
      const after = await deployer.provider.getBalance(recipient.address);
      assert.equal(after.sub(before).toNumber(), amountToTransfer, "should have transfered the ETH amount");
    });
    it("should only transfer ETH with 2 confirmations for 3 guardians", async () => {
      const amountToTransfer = 10000;
      await addGuardians(await createSmartContractGuardians([guardian1, guardian2, guardian3]));
      const count = (await guardianManager.guardianCount(wallet.contractAddress)).toNumber();
      assert.equal(count, 3, "3 guardians should be active");
      const before = await deployer.provider.getBalance(recipient.address);
      // should fail with one confirmation
      const txReceipt = await manager.relay(transferModule, "transferToken",
        [wallet.contractAddress, ETH_TOKEN, recipient.address, amountToTransfer, ZERO_BYTES32], wallet, [owner, guardian1]);
      const success = parseRelayReceipt(txReceipt);
      assert.isNotOk(success, "transfer with 1 guardian signature should fail");
      // should succeed with 2 confirmations
      await manager.relay(transferModule, "transferToken",
        [wallet.contractAddress, ETH_TOKEN, recipient.address, amountToTransfer, ZERO_BYTES32], wallet,
        [owner, ...sortWalletByAddress([guardian1, guardian2])]);
      const after = await deployer.provider.getBalance(recipient.address);
      assert.equal(after.sub(before).toNumber(), amountToTransfer, "should have transfered the ETH amount");
    });
    it("should transfer ERC20 with 1 confirmations for 1 guardians", async () => {
      const amountToTransfer = 10000;
      await addGuardians(await createSmartContractGuardians([guardian1]));
      const count = (await guardianManager.guardianCount(wallet.contractAddress)).toNumber();
      assert.equal(count, 1, "1 guardians should be active");
      const before = await erc20.balanceOf(recipient.address);
      // should succeed with one confirmation
      await manager.relay(transferModule, "transferToken",
        [wallet.contractAddress, erc20.contractAddress, recipient.address, amountToTransfer, ZERO_BYTES32], wallet, [owner, guardian1]);
      const after = await erc20.balanceOf(recipient.address);
      assert.equal(after.sub(before).toNumber(), amountToTransfer, "should have transfered the ETH amount");
    });
    it("should only transfer ERC20 with 2 confirmations for 3 guardians", async () => {
      const amountToTransfer = 10000;
      await addGuardians(await createSmartContractGuardians([guardian1, guardian2, guardian3]));
      const count = (await guardianManager.guardianCount(wallet.contractAddress)).toNumber();
      assert.equal(count, 3, "3 guardians should be active");
      const before = await erc20.balanceOf(recipient.address);
      // should fail with one confirmation
      const txReceipt = await manager.relay(transferModule, "transferToken",
        [wallet.contractAddress, erc20.contractAddress, recipient.address, amountToTransfer, ZERO_BYTES32], wallet, [owner, guardian1]);
      const success = parseRelayReceipt(txReceipt);
      assert.isNotOk(success, "transfer with 1 guardian signature should throw");
      // should succeed with 2 confirmations
      await manager.relay(transferModule, "transferToken",
        [wallet.contractAddress, erc20.contractAddress, recipient.address, amountToTransfer, ZERO_BYTES32], wallet,
        [owner, ...sortWalletByAddress([guardian1, guardian2])]);
      const after = await erc20.balanceOf(recipient.address);
      assert.equal(after.sub(before).toNumber(), amountToTransfer, "should have transfered the ERC20 amount");
    });
  });

  describe("Transfer approved by EOA and smart-contract guardians", () => {
    it("should transfer ETH with 1 EOA guardian and 2 smart-contract guardians", async () => {
      const amountToTransfer = 10000;
      await addGuardians([guardian1, ...(await createSmartContractGuardians([guardian2, guardian3]))]);
      const count = (await guardianManager.guardianCount(wallet.contractAddress)).toNumber();
      assert.equal(count, 3, "3 guardians should be active");
      let before = await deployer.provider.getBalance(recipient.address);
      // should succeed with 2 confirmations
      await manager.relay(transferModule, "transferToken",
        [wallet.contractAddress, ETH_TOKEN, recipient.address, amountToTransfer, ZERO_BYTES32], wallet,
        [owner, ...sortWalletByAddress([guardian1, guardian2])]);
      let after = await deployer.provider.getBalance(recipient.address);
      assert.equal(after.sub(before).toNumber(), amountToTransfer, "should have transfered the ETH amount");
      // should succeed with 2 confirmations
      before = after;
      await manager.relay(transferModule, "transferToken",
        [wallet.contractAddress, ETH_TOKEN, recipient.address, amountToTransfer, ZERO_BYTES32], wallet,
        [owner, ...sortWalletByAddress([guardian1, guardian3])]);
      after = await deployer.provider.getBalance(recipient.address);
      assert.equal(after.sub(before).toNumber(), amountToTransfer, "should have transfered the ETH amount");
      // should succeed with 2 confirmations
      before = after;
      await manager.relay(transferModule, "transferToken",
        [wallet.contractAddress, ETH_TOKEN, recipient.address, amountToTransfer, ZERO_BYTES32], wallet,
        [owner, ...sortWalletByAddress([guardian2, guardian3])]);
      after = await deployer.provider.getBalance(recipient.address);
      assert.equal(after.sub(before).toNumber(), amountToTransfer, "should have transfered the ETH amount");
    });
    it("should transfer ETH with 2 EOA guardian and 1 smart-contract guardians", async () => {
      const amountToTransfer = 10000;
      await addGuardians([guardian1, guardian2, ...await createSmartContractGuardians([guardian3])]);
      const count = (await guardianManager.guardianCount(wallet.contractAddress)).toNumber();
      assert.equal(count, 3, "3 guardians should be active");
      let before = await deployer.provider.getBalance(recipient.address);
      // should succeed with 2 confirmations
      await manager.relay(transferModule, "transferToken",
        [wallet.contractAddress, ETH_TOKEN, recipient.address, amountToTransfer, ZERO_BYTES32], wallet,
        [owner, ...sortWalletByAddress([guardian1, guardian2])]);
      let after = await deployer.provider.getBalance(recipient.address);
      assert.equal(after.sub(before).toNumber(), amountToTransfer, "should have transfered the ETH amount");
      // should succeed with 2 confirmations
      before = after;
      await manager.relay(transferModule, "transferToken",
        [wallet.contractAddress, ETH_TOKEN, recipient.address, amountToTransfer, ZERO_BYTES32], wallet,
        [owner, ...sortWalletByAddress([guardian1, guardian3])]);
      after = await deployer.provider.getBalance(recipient.address);
      assert.equal(after.sub(before).toNumber(), amountToTransfer, "should have transfered the ETH amount");
      // should succeed with 2 confirmations
      before = after;
      await manager.relay(transferModule, "transferToken",
        [wallet.contractAddress, ETH_TOKEN, recipient.address, amountToTransfer, ZERO_BYTES32], wallet,
        [owner, ...sortWalletByAddress([guardian2, guardian3])]);
      after = await deployer.provider.getBalance(recipient.address);
      assert.equal(after.sub(before).toNumber(), amountToTransfer, "should have transfered the ETH amount");
    });
  });

  describe("Contract call approved by EOA and smart-contract guardians", () => {
    let contract;
    let dataToTransfer;

    beforeEach(async () => {
      contract = await deployer.deploy(TestContract);
      assert.equal(await contract.state(), 0, "initial contract state should be 0");
    });

    it("should call a contract and transfer ETH with 1 EOA guardian and 2 smart-contract guardians", async () => {
      const amountToTransfer = 10000;
      await addGuardians([guardian1, ...(await createSmartContractGuardians([guardian2, guardian3]))]);
      const count = (await guardianManager.guardianCount(wallet.contractAddress)).toNumber();
      assert.equal(count, 3, "3 guardians should be active");
      let before = await deployer.provider.getBalance(contract.contractAddress);
      // should succeed with 2 confirmations
      dataToTransfer = contract.contract.interface.functions.setState.encode([2]);
      await manager.relay(transferModule, "callContract",
        [wallet.contractAddress, contract.contractAddress, amountToTransfer, dataToTransfer], wallet,
        [owner, ...sortWalletByAddress([guardian1, guardian2])]);
      let after = await deployer.provider.getBalance(contract.contractAddress);
      assert.equal(after.sub(before).toNumber(), amountToTransfer, "should have transfered the ETH amount");
      assert.equal((await contract.state()).toNumber(), 2, "the state of the external contract should have been changed");
      // should succeed with 2 confirmations
      before = after;
      dataToTransfer = contract.contract.interface.functions.setState.encode([3]);
      await manager.relay(transferModule, "callContract",
        [wallet.contractAddress, contract.contractAddress, amountToTransfer, dataToTransfer], wallet,
        [owner, ...sortWalletByAddress([guardian1, guardian3])]);
      after = await deployer.provider.getBalance(contract.contractAddress);
      assert.equal(after.sub(before).toNumber(), amountToTransfer, "should have transfered the ETH amount");
      assert.equal((await contract.state()).toNumber(), 3, "the state of the external contract should have been changed");
      // should succeed with 2 confirmations
      before = after;
      dataToTransfer = contract.contract.interface.functions.setState.encode([4]);
      await manager.relay(transferModule, "callContract",
        [wallet.contractAddress, contract.contractAddress, amountToTransfer, dataToTransfer], wallet,
        [owner, ...sortWalletByAddress([guardian2, guardian3])]);
      after = await deployer.provider.getBalance(contract.contractAddress);
      assert.equal(after.sub(before).toNumber(), amountToTransfer, "should have transfered the ETH amount");
      assert.equal((await contract.state()).toNumber(), 4, "the state of the external contract should have been changed");
    });
  });

  describe("Approve token and Contract call approved by EOA and smart-contract guardians", () => {
    let contract;
    let consumer;
    let dataToTransfer;
    let amountToApprove;

    beforeEach(async () => {
      contract = await deployer.deploy(TestContract);
      consumer = await contract.tokenConsumer();
      assert.equal(await contract.state(), 0, "initial contract state should be 0");
      amountToApprove = 10000;
    });

    it("should revert when target contract is the wallet", async () => {
      await addGuardians([guardian1, ...(await createSmartContractGuardians([guardian2, guardian3]))]);
      const count = (await guardianManager.guardianCount(wallet.contractAddress)).toNumber();
      assert.equal(count, 3, "3 guardians should be active");

      dataToTransfer = contract.contract.interface.functions.setStateAndPayToken.encode([2, erc20.contractAddress, amountToApprove]);
      const txReceipt = await manager.relay(transferModule, "approveTokenAndCallContract",
        [wallet.contractAddress, erc20.contractAddress, wallet.contractAddress, amountToApprove, wallet.contractAddress, dataToTransfer],
        wallet, [owner, ...sortWalletByAddress([guardian1, guardian2])]);
      const success = parseRelayReceipt(txReceipt);
      assert.isNotOk(success, "approveTokenAndCall should fail when target contract is the wallet");
    });

    it("should revert when target contract is an authorised module", async () => {
      await addGuardians([guardian1, ...(await createSmartContractGuardians([guardian2, guardian3]))]);
      const count = (await guardianManager.guardianCount(wallet.contractAddress)).toNumber();
      assert.equal(count, 3, "3 guardians should be active");

      dataToTransfer = contract.contract.interface.functions.setStateAndPayToken.encode([2, erc20.contractAddress, amountToApprove]);
      const txReceipt = await manager.relay(transferModule, "approveTokenAndCallContract",
        [wallet.contractAddress, erc20.contractAddress, transferModule.contractAddress,
          amountToApprove, transferModule.contractAddress, dataToTransfer],
        wallet, [owner, ...sortWalletByAddress([guardian1, guardian2])]);
      const success = parseRelayReceipt(txReceipt);
      assert.isNotOk(success, "approveTokenAndCall should fail when target contract is an authorised module");
    });

    it("should approve token for a spender then call a contract with 3 guardians, spender = contract", async () => {
      await addGuardians([guardian1, ...(await createSmartContractGuardians([guardian2, guardian3]))]);
      const count = (await guardianManager.guardianCount(wallet.contractAddress)).toNumber();
      assert.equal(count, 3, "3 guardians should be active");
      let before = await erc20.balanceOf(contract.contractAddress);
      // should succeed with 2 confirmations
      dataToTransfer = contract.contract.interface.functions.setStateAndPayToken.encode([2, erc20.contractAddress, amountToApprove]);
      await manager.relay(transferModule, "approveTokenAndCallContract",
        [wallet.contractAddress, erc20.contractAddress, contract.contractAddress, amountToApprove, contract.contractAddress, dataToTransfer],
        wallet, [owner, ...sortWalletByAddress([guardian1, guardian2])]);
      let after = await erc20.balanceOf(contract.contractAddress);
      assert.equal(after.sub(before).toNumber(), amountToApprove, "should have approved and transfered the token amount");
      assert.equal((await contract.state()).toNumber(), 2, "the state of the external contract should have been changed");
      // should succeed with 2 confirmations
      before = after;
      dataToTransfer = contract.contract.interface.functions.setStateAndPayToken.encode([3, erc20.contractAddress, amountToApprove]);
      await manager.relay(transferModule, "approveTokenAndCallContract",
        [wallet.contractAddress, erc20.contractAddress, contract.contractAddress, amountToApprove, contract.contractAddress, dataToTransfer],
        wallet, [owner, ...sortWalletByAddress([guardian1, guardian3])]);
      after = await erc20.balanceOf(contract.contractAddress);
      assert.equal(after.sub(before).toNumber(), amountToApprove, "should have approved and transfered the token amount");
      assert.equal((await contract.state()).toNumber(), 3, "the state of the external contract should have been changed");
      // should succeed with 2 confirmations
      before = after;
      dataToTransfer = contract.contract.interface.functions.setStateAndPayToken.encode([4, erc20.contractAddress, amountToApprove]);
      await manager.relay(transferModule, "approveTokenAndCallContract",
        [wallet.contractAddress, erc20.contractAddress, contract.contractAddress, amountToApprove, contract.contractAddress, dataToTransfer],
        wallet, [owner, ...sortWalletByAddress([guardian2, guardian3])]);
      after = await erc20.balanceOf(contract.contractAddress);
      assert.equal(after.sub(before).toNumber(), amountToApprove, "should have approved and transfered the token amount");
      assert.equal((await contract.state()).toNumber(), 4, "the state of the external contract should have been changed");
    });

    it("should approve token for a spender then call a contract with 3 guardians, spender != contract", async () => {
      await addGuardians([guardian1, ...(await createSmartContractGuardians([guardian2, guardian3]))]);
      const count = (await guardianManager.guardianCount(wallet.contractAddress)).toNumber();
      assert.equal(count, 3, "3 guardians should be active");
      let before = await erc20.balanceOf(contract.contractAddress);
      // should succeed with 2 confirmations
      dataToTransfer = contract.contract.interface.functions.setStateAndPayTokenWithConsumer.encode([2, erc20.contractAddress, amountToApprove]);
      await manager.relay(transferModule, "approveTokenAndCallContract",
        [wallet.contractAddress, erc20.contractAddress, consumer, amountToApprove, contract.contractAddress, dataToTransfer],
        wallet, [owner, ...sortWalletByAddress([guardian1, guardian2])]);
      let after = await erc20.balanceOf(contract.contractAddress);
      assert.equal(after.sub(before).toNumber(), amountToApprove, "should have approved and transfered the token amount");
      assert.equal((await contract.state()).toNumber(), 2, "the state of the external contract should have been changed");
      // should succeed with 2 confirmations
      before = after;
      dataToTransfer = contract.contract.interface.functions.setStateAndPayTokenWithConsumer.encode([3, erc20.contractAddress, amountToApprove]);
      await manager.relay(transferModule, "approveTokenAndCallContract",
        [wallet.contractAddress, erc20.contractAddress, consumer, amountToApprove, contract.contractAddress, dataToTransfer],
        wallet, [owner, ...sortWalletByAddress([guardian1, guardian3])]);
      after = await erc20.balanceOf(contract.contractAddress);
      assert.equal(after.sub(before).toNumber(), amountToApprove,
        "should have approved and transfered the token amount");
      assert.equal((await contract.state()).toNumber(), 3, "the state of the external contract should have been changed");
      // should succeed with 2 confirmations
      before = after;
      dataToTransfer = contract.contract.interface.functions.setStateAndPayTokenWithConsumer.encode([4, erc20.contractAddress, amountToApprove]);
      await manager.relay(transferModule, "approveTokenAndCallContract",
        [wallet.contractAddress, erc20.contractAddress, consumer, amountToApprove, contract.contractAddress, dataToTransfer],
        wallet, [owner, ...sortWalletByAddress([guardian2, guardian3])]);
      after = await erc20.balanceOf(contract.contractAddress);
      assert.equal(after.sub(before).toNumber(), amountToApprove, "should have approved and transfered the token amount");
      assert.equal((await contract.state()).toNumber(), 4, "the state of the external contract should have been changed");
    });
  });
});
