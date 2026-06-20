// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {EigenVault} from "../src/EigenVault.sol";

/// @notice The "evil builder" case: proposing a new image opens a redemption
///         window; rotation cannot complete before it elapses; trade authority
///         does not change in the meantime; investors can exit during the window.
contract ImageRotationTest is BaseTest {
    EigenVault internal vault;

    bytes32 internal constant IMAGE_B = keccak256("image-B");
    address internal evilWallet = makeAddr("evilWallet");

    function setUp() public override {
        super.setUp();
        vault = _createVault();
        // Alice deposits before the builder tries to swap strategy.
        _deposit(vault, alice, 100_000 * USDC_UNIT);
    }

    function test_OnlyBuilderCanPropose() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(EigenVault.OnlyBuilder.selector, alice));
        vault.proposeImage(IMAGE_B, evilWallet);
    }

    function test_AcceptRevertsBeforeWindow() public {
        vm.prank(builder);
        vault.proposeImage(IMAGE_B, evilWallet);

        // Immediately accepting reverts.
        vm.expectRevert();
        vault.acceptImage();

        // Even one second before the window end, it reverts.
        vm.warp(block.timestamp + ROTATION_WINDOW - 1);
        vm.expectRevert();
        vault.acceptImage();
    }

    function test_AuthorityUnchangedDuringWindow() public {
        vm.prank(builder);
        vault.proposeImage(IMAGE_B, evilWallet);

        // During the window the OLD teeWallet is still the only authority.
        assertEq(vault.teeWallet(), teeWallet, "authority unchanged");
        assertEq(vault.imageHash(), IMAGE_A, "image unchanged");

        // The proposed (evil) wallet cannot bridge yet.
        vm.prank(evilWallet);
        vm.expectRevert(abi.encodeWithSelector(EigenVault.OnlyTeeWallet.selector, evilWallet));
        vault.bridgeToLighter(1 * USDC_UNIT);

        // The old wallet still works.
        vm.prank(teeWallet);
        vault.bridgeToLighter(1 * USDC_UNIT);
    }

    function test_InvestorRedeemsAtLastHwmDuringWindow() public {
        // Build up a profit and crystallize a HWM before proposing.
        uint256 bridged = 50_000 * USDC_UNIT;
        vm.prank(teeWallet);
        vault.bridgeToLighter(bridged);
        // Fund the bridge for a 10k profit and report NAV = 60k.
        usdc.mint(address(this), 10_000 * USDC_UNIT);
        usdc.approve(address(bridge), 10_000 * USDC_UNIT);
        bridge.fund(10_000 * USDC_UNIT);
        vm.prank(teeWallet);
        adapter.pushNav(address(vault), 60_000 * USDC_UNIT);

        uint256 hwmBefore = vault.highWaterMarkPps();

        // Builder proposes a strategy swap.
        vm.prank(builder);
        vault.proposeImage(IMAGE_B, evilWallet);

        // Pull funds back so the vault can pay the exiting investor.
        vm.prank(teeWallet);
        vault.bridgeFromLighter(60_000 * USDC_UNIT);
        vm.prank(teeWallet);
        adapter.pushNav(address(vault), 0);

        // Investor redeems during the window — gets paid at the realized price,
        // which is at/above the last HWM (perf fee crystallized on the way out).
        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 assetsOut = vault.redeem(aliceShares, alice, alice);
        assertGt(assetsOut, 100_000 * USDC_UNIT, "investor exits in profit");
        assertGe(vault.highWaterMarkPps(), hwmBefore, "HWM not regressed");

        // Authority STILL unchanged — the redemption happened before any rotation.
        assertEq(vault.teeWallet(), teeWallet);
        assertEq(vault.imageHash(), IMAGE_A);
    }

    function test_RotationCompletesAfterWindow() public {
        vm.prank(builder);
        vault.proposeImage(IMAGE_B, evilWallet);

        vm.warp(block.timestamp + ROTATION_WINDOW);
        vault.acceptImage();

        assertEq(vault.teeWallet(), evilWallet, "authority rotated");
        assertEq(vault.imageHash(), IMAGE_B, "image rotated");

        // The new wallet can now bridge; the old one cannot.
        vm.prank(evilWallet);
        vault.bridgeToLighter(1 * USDC_UNIT);
        vm.prank(teeWallet);
        vm.expectRevert(abi.encodeWithSelector(EigenVault.OnlyTeeWallet.selector, teeWallet));
        vault.bridgeToLighter(1 * USDC_UNIT);
    }

    function test_CannotDoubleProposet() public {
        vm.prank(builder);
        vault.proposeImage(IMAGE_B, evilWallet);
        vm.prank(builder);
        vm.expectRevert(EigenVault.PendingImageExists.selector);
        vault.proposeImage(IMAGE_B, evilWallet);
    }
}
