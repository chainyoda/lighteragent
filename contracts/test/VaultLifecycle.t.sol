// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BaseTest} from "./Base.t.sol";
import {EigenVault} from "../src/EigenVault.sol";

/// @notice Full deposit -> trade -> profit -> fees -> redeem cycle, asserting the
///         USDC accounting closes and the builder receives the right fee shares.
contract VaultLifecycleTest is BaseTest {
    EigenVault internal vault;

    function setUp() public override {
        super.setUp();
        vault = _createVault();
    }

    function test_FullLifecycle() public {
        // --- 1. createVault: bound and valid ---------------------------------
        assertTrue(registry.isValid(address(vault)), "vault should be bound");
        assertEq(registry.imageOf(address(vault)), IMAGE_A);
        assertEq(vault.teeWallet(), teeWallet);
        assertEq(vault.imageHash(), IMAGE_A);
        assertEq(vault.decimals(), 12, "6 asset decimals + 6 offset");

        // --- 2. investor deposits 100,000 USDC -------------------------------
        uint256 deposit = 100_000 * USDC_UNIT;
        uint256 shares = _deposit(vault, alice, deposit);
        assertEq(vault.totalAssets(), deposit, "totalAssets == deposit");
        assertEq(vault.balanceOf(alice), shares);
        assertEq(usdc.balanceOf(address(vault)), deposit, "vault holds the USDC");

        // --- 3. teeWallet bridges 80,000 USDC to Lighter ---------------------
        uint256 bridged = 80_000 * USDC_UNIT;
        vm.prank(teeWallet);
        vault.bridgeToLighter(bridged);
        assertEq(usdc.balanceOf(address(vault)), deposit - bridged, "vault USDC reduced");
        assertEq(bridge.collateralOf(address(vault)), bridged, "bridge holds collateral");

        // NAV oracle must report the Lighter-side balance for totalAssets to hold.
        vm.prank(teeWallet);
        adapter.pushNav(address(vault), bridged);
        assertEq(vault.totalAssets(), deposit, "totalAssets unchanged after bridge");

        // --- 4. simulate trading profit: sub-account NAV rises to 100k -------
        // Strategy makes 20k profit on the bridged 80k -> sub-account worth 100k.
        uint256 navAfterProfit = 100_000 * USDC_UNIT;
        // The bridge must be funded to be able to pay out the extra USDC later.
        uint256 extraProfit = navAfterProfit - bridged; // 20k
        usdc.mint(address(this), extraProfit);
        usdc.approve(address(bridge), extraProfit);
        bridge.fund(extraProfit);

        vm.prank(teeWallet);
        adapter.pushNav(address(vault), navAfterProfit);

        // totalAssets = 20k vault USDC + 100k NAV = 120k.
        uint256 expectedTotal = (deposit - bridged) + navAfterProfit;
        assertEq(vault.totalAssets(), expectedTotal, "120k total");

        // --- 5. accrueTxFee on a 50,000 notional trade -----------------------
        uint256 notional = 50_000 * USDC_UNIT;
        uint256 builderBefore = vault.balanceOf(builder);
        uint256 treasuryBefore = vault.balanceOf(treasury);

        // Expected total fee shares: 40 USDC of fee converted at the current
        // price via the same previewDeposit the contract uses.
        uint256 feeAssets = (notional * TX_FEE_BPS) / 10_000; // 40 USDC
        uint256 feeShares = vault.previewDeposit(feeAssets);

        vm.prank(teeWallet);
        vault.accrueTxFee(notional);

        uint256 builderDelta = vault.balanceOf(builder) - builderBefore;
        uint256 treasuryDelta = vault.balanceOf(treasury) - treasuryBefore;

        // Split matches the protocol cut: treasury gets floor(cut), builder the rest.
        uint256 expProtocol = (feeShares * PROTOCOL_CUT_BPS) / 10_000;
        assertEq(treasuryDelta, expProtocol, "treasury tx fee cut");
        assertEq(builderDelta, feeShares - expProtocol, "builder tx fee shares");
        assertEq(builderDelta + treasuryDelta, feeShares, "total tx fee shares");

        // --- 6. realizePerfFee: HWM-based -----------------------------------
        // Profit above HWM (par) across supply -> 20% perf fee in shares.
        uint256 builderBeforePerf = vault.balanceOf(builder);
        uint256 treasuryBeforePerf = vault.balanceOf(treasury);
        uint256 hwmBeforePerf = vault.highWaterMarkPps();
        vm.prank(teeWallet);
        uint256 perfMinted = vault.realizePerfFee();
        assertGt(perfMinted, 0, "perf fee minted");
        assertGt(vault.balanceOf(builder), builderBeforePerf, "builder got perf shares");
        assertGt(vault.balanceOf(treasury), treasuryBeforePerf, "treasury got perf cut");
        // HWM advanced above the par price captured at deposit.
        assertGt(vault.highWaterMarkPps(), hwmBeforePerf, "HWM advanced");

        // Realizing again immediately yields nothing (no new gains).
        vm.prank(teeWallet);
        assertEq(vault.realizePerfFee(), 0, "no double charge");

        // --- 7. investor redeems everything ----------------------------------
        // Pull all Lighter collateral back so the vault can pay out.
        uint256 navNow = adapter.navOf(address(vault));
        vm.prank(teeWallet);
        vault.bridgeFromLighter(navNow);
        vm.prank(teeWallet);
        adapter.pushNav(address(vault), 0);

        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 assetsOut = vault.redeem(aliceShares, alice, alice);
        assertEq(usdc.balanceOf(alice), assetsOut, "alice received USDC");
        assertGt(assetsOut, deposit, "alice profited net of fees");

        // --- 8. builder + treasury redeem fee shares -------------------------
        uint256 builderShares = vault.balanceOf(builder);
        uint256 treasuryShares = vault.balanceOf(treasury);
        assertGt(builderShares, 0);

        vm.prank(builder);
        uint256 builderUsdc = vault.redeem(builderShares, builder, builder);
        vm.prank(treasury);
        uint256 treasuryUsdc = vault.redeem(treasuryShares, treasury, treasury);
        assertGt(builderUsdc, 0, "builder claimed fees in USDC");
        assertGt(treasuryUsdc, 0, "treasury claimed protocol cut");

        // --- 9. accounting closes -------------------------------------------
        // All shares burned, residual vault USDC is dust (rounding only).
        assertEq(vault.totalSupply(), 0, "all shares burned");
        assertLe(usdc.balanceOf(address(vault)), 10, "only rounding dust remains");

        // Builder earned strictly less than the gross profit (took a cut, not all).
        uint256 grossProfit = expectedTotal - deposit; // 20k
        assertLt(builderUsdc + treasuryUsdc, grossProfit, "fees are a slice of profit");
    }
}
