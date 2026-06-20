// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ILighterAdapter} from "../../interfaces/adapters/ILighterAdapter.sol";
import {IEigenVault} from "../../interfaces/IEigenVault.sol";

/// @notice Minimal interface for the Lighter deposit/withdraw bridge that the
///         adapter wraps. The production Lighter bridge credits/debits a
///         vault-owned sub-account; in tests this is the MockLighterBridge.
interface ILighterBridge {
    /// @notice Pull `assets` USDC from the caller and credit `subAccount`.
    function deposit(address subAccount, uint256 assets) external;

    /// @notice Withdraw `assets` USDC from `subAccount` to the caller.
    function withdraw(address subAccount, uint256 assets) external;
}

/// @title LighterAdapter
/// @notice Wraps Lighter's bridge for vault-owned sub-accounts AND serves as the
///         v1 NAV oracle read by {EigenVault.totalAssets}.
/// @dev    Sub-account identity: each vault owns one sub-account whose L1 owner is
///         the vault contract; in this v1 onchain model the sub-account id is the
///         vault address itself. `bridgeToLighter`/`bridgeFromLighter` on the
///         vault are gated to the vault's `teeWallet`; this adapter simply
///         forwards USDC and trusts the caller to be a registered vault.
///
///         NAV: for v1 the Lighter-side value is a TEE-signed number pushed via
///         {pushNav}, authorized to the calling vault's `teeWallet`. v2 replaces
///         `navOf` with a Lighter-native ZK proof of sub-account balance.
contract LighterAdapter is ILighterAdapter {
    using SafeERC20 for IERC20;

    /// @notice The USDC token bridged to/from Lighter.
    IERC20 public immutable usdc;

    /// @notice The Lighter deposit/withdraw bridge.
    ILighterBridge public immutable bridge;

    /// @dev vault => last pushed NAV (USDC, 6 decimals).
    mapping(address => uint256) internal _nav;

    error ZeroAddress();
    error NotVaultTee(address caller, address vault);

    /// @param usdc_   USDC token address.
    /// @param bridge_ Lighter bridge address.
    constructor(IERC20 usdc_, ILighterBridge bridge_) {
        if (address(usdc_) == address(0) || address(bridge_) == address(0)) revert ZeroAddress();
        usdc = usdc_;
        bridge = bridge_;
    }

    /// @inheritdoc ILighterAdapter
    /// @dev Caller is the vault. We pull USDC from the vault and forward it to the
    ///      bridge, crediting the vault's sub-account (keyed by the vault address).
    function depositToLighter(uint256 assets) external {
        address vault = msg.sender;
        usdc.safeTransferFrom(vault, address(this), assets);
        usdc.forceApprove(address(bridge), assets);
        bridge.deposit(vault, assets);
        emit BridgedToLighter(vault, assets);
    }

    /// @inheritdoc ILighterAdapter
    /// @dev Caller is the vault. We pull USDC out of the bridge and forward it
    ///      back to the vault.
    function withdrawFromLighter(uint256 assets) external {
        address vault = msg.sender;
        bridge.withdraw(vault, assets);
        usdc.safeTransfer(vault, assets);
        emit BridgedFromLighter(vault, assets);
    }

    /// @inheritdoc ILighterAdapter
    /// @dev Only the vault's currently-authorized `teeWallet` may push NAV.
    function pushNav(address vault, uint256 nav) external {
        if (msg.sender != IEigenVault(vault).teeWallet()) revert NotVaultTee(msg.sender, vault);
        _nav[vault] = nav;
        emit NavUpdated(vault, nav);
    }

    /// @inheritdoc ILighterAdapter
    function navOf(address vault) external view returns (uint256) {
        return _nav[vault];
    }
}
