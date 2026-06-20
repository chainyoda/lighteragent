// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ILighterBridge} from "../../src/adapters/LighterAdapter.sol";

/// @title MockLighterBridge
/// @notice Test-only stand-in for Lighter's deposit/withdraw bridge.
/// @dev    Custodies deposited USDC per sub-account and settles withdrawals
///         synchronously. This holds the *bridged collateral*; profit/loss in the
///         real venue is reflected via {LighterAdapter.pushNav}, not here, so the
///         mock does not need to model PnL on its own balance.
contract MockLighterBridge is ILighterBridge {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;

    /// @dev sub-account => collateral deposited into the bridge.
    mapping(address => uint256) public collateralOf;

    constructor(IERC20 usdc_) {
        usdc = usdc_;
    }

    /// @inheritdoc ILighterBridge
    function deposit(address subAccount, uint256 assets) external {
        usdc.safeTransferFrom(msg.sender, address(this), assets);
        collateralOf[subAccount] += assets;
    }

    /// @inheritdoc ILighterBridge
    /// @dev For test realism a withdrawal can exceed deposited collateral when the
    ///      sub-account is in profit; the test funds the bridge accordingly. We
    ///      only decrement the tracked collateral up to what was deposited.
    function withdraw(address subAccount, uint256 assets) external {
        uint256 tracked = collateralOf[subAccount];
        collateralOf[subAccount] = assets >= tracked ? 0 : tracked - assets;
        usdc.safeTransfer(msg.sender, assets);
    }

    /// @notice Test helper: seed the bridge with USDC so it can pay out simulated
    ///         trading profit on withdrawal.
    function fund(uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }
}
