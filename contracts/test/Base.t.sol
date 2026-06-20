// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FeeAccountant} from "../src/FeeAccountant.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {LighterAdapter} from "../src/adapters/LighterAdapter.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {EigenVault} from "../src/EigenVault.sol";
import {IVaultFactory} from "../interfaces/IVaultFactory.sol";

import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockLighterBridge} from "./mocks/MockLighterBridge.sol";
import {MockAttestationVerifier} from "./mocks/MockAttestationVerifier.sol";

/// @notice Shared deployment fixture for all EigenStrategies tests.
abstract contract BaseTest is Test {
    // Actors
    address internal governance = makeAddr("governance");
    address internal treasury = makeAddr("treasury");
    address internal builder = makeAddr("builder");
    address internal teeWallet;
    uint256 internal teeKey;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    // System
    MockUSDC internal usdc;
    MockLighterBridge internal bridge;
    MockAttestationVerifier internal verifier;
    FeeAccountant internal feeAccountant;
    AttestationRegistry internal registry;
    LighterAdapter internal adapter;
    VaultFactory internal factory;

    // Config
    uint16 internal constant PROTOCOL_CUT_BPS = 1_000; // 10% of fees to treasury
    uint16 internal constant PERF_FEE_BPS = 2_000; // 20% performance
    uint16 internal constant TX_FEE_BPS = 8; // 0.08% per-trade
    uint256 internal constant ROTATION_WINDOW = 24 hours;
    bytes32 internal constant IMAGE_A = keccak256("image-A");
    uint256 internal constant USDC_UNIT = 1e6;

    function setUp() public virtual {
        (teeWallet, teeKey) = makeAddrAndKey("teeWallet");

        usdc = new MockUSDC();
        bridge = new MockLighterBridge(IERC20(address(usdc)));
        verifier = new MockAttestationVerifier();

        feeAccountant = new FeeAccountant(governance, treasury, PROTOCOL_CUT_BPS);
        registry = new AttestationRegistry(governance, verifier);
        adapter = new LighterAdapter(IERC20(address(usdc)), bridge);

        factory = new VaultFactory(
            governance, IERC20(address(usdc)), feeAccountant, registry, adapter, ROTATION_WINDOW
        );

        // Wire the factory as the registry's authorized first-binder.
        vm.prank(governance);
        registry.setFactory(address(factory));
    }

    /// @dev Create a vault with the default fee schedule and image A.
    function _createVault() internal returns (EigenVault) {
        IVaultFactory.VaultParams memory p = IVaultFactory.VaultParams({
            imageHash: IMAGE_A,
            teeWallet: teeWallet,
            perfFeeBps: PERF_FEE_BPS,
            txFeeBps: TX_FEE_BPS,
            builder: builder,
            metadataURI: "ipfs://meta"
        });
        vm.prank(builder);
        return EigenVault(factory.createVault(p));
    }

    /// @dev Mint USDC to `who` and deposit it into `vault` as that user.
    function _deposit(EigenVault vault, address who, uint256 assets)
        internal
        returns (uint256 shares)
    {
        usdc.mint(who, assets);
        vm.startPrank(who);
        usdc.approve(address(vault), assets);
        shares = vault.deposit(assets, who);
        vm.stopPrank();
    }
}
