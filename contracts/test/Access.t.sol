// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {EigenVault} from "../src/EigenVault.sol";
import {LighterAdapter} from "../src/adapters/LighterAdapter.sol";

/// @notice Access-control invariants: only the bound teeWallet can move funds or
///         accrue per-trade fees; only it can push NAV.
contract AccessTest is BaseTest {
    EigenVault internal vault;

    function setUp() public override {
        super.setUp();
        vault = _createVault();
        _deposit(vault, alice, 10_000 * USDC_UNIT);
    }

    function test_NonTeeCannotBridgeToLighter() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(EigenVault.OnlyTeeWallet.selector, alice));
        vault.bridgeToLighter(1 * USDC_UNIT);

        // Even the builder cannot bridge.
        vm.prank(builder);
        vm.expectRevert(abi.encodeWithSelector(EigenVault.OnlyTeeWallet.selector, builder));
        vault.bridgeToLighter(1 * USDC_UNIT);
    }

    function test_NonTeeCannotBridgeFromLighter() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(EigenVault.OnlyTeeWallet.selector, bob));
        vault.bridgeFromLighter(1 * USDC_UNIT);
    }

    function test_NonTeeCannotAccrueTxFee() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(EigenVault.OnlyTeeWallet.selector, alice));
        vault.accrueTxFee(1_000 * USDC_UNIT);
    }

    function test_NonTeeCannotPushNav() public {
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(LighterAdapter.NotVaultTee.selector, alice, address(vault))
        );
        adapter.pushNav(address(vault), 1);
    }

    function test_TeeCanBridgeAndAccrue() public {
        vm.prank(teeWallet);
        vault.bridgeToLighter(1_000 * USDC_UNIT);
        vm.prank(teeWallet);
        vault.accrueTxFee(1_000 * USDC_UNIT);
        vm.prank(teeWallet);
        adapter.pushNav(address(vault), 1_000 * USDC_UNIT);
        assertEq(adapter.navOf(address(vault)), 1_000 * USDC_UNIT);
    }

    function test_RealizePerfFeeIsPermissionless() public {
        // realizePerfFee is intentionally callable by anyone (it only ever mints
        // the builder's own fee and advances the HWM; no value can be extracted).
        vm.prank(bob);
        vault.realizePerfFee();
    }
}
