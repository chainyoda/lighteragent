// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ILighterAdapter
/// @notice Thin onchain helper that (1) wraps Lighter's deposit/withdraw bridge
///         for a vault-owned sub-account, and (2) acts as the NAV oracle that
///         {EigenVault.totalAssets} reads for the Lighter-side balance.
/// @dev    Each vault owns exactly one Lighter sub-account, deterministically
///         derived from the vault address; the vault contract is the L1 owner of
///         that sub-account and `teeWallet` is the API-key signer.
///         For v1 the NAV is a TEE-signed/pushed sub-account balance (the same
///         trust assumption as the attestation). v2 would replace `navOf` with a
///         Lighter-native ZK proof of sub-account balance.
interface ILighterAdapter {
    /// @notice Emitted when the vault moves USDC into its Lighter sub-account.
    event BridgedToLighter(address indexed vault, uint256 assets);
    /// @notice Emitted when the vault pulls USDC back from its sub-account.
    event BridgedFromLighter(address indexed vault, uint256 assets);
    /// @notice Emitted when the pushed NAV for a vault is updated.
    event NavUpdated(address indexed vault, uint256 nav);

    /// @notice Deposit `assets` USDC from the caller (the vault) into the vault's
    ///         Lighter sub-account via the bridge.
    /// @dev    The caller MUST have approved this adapter for `assets`. The
    ///         adapter pulls the USDC and forwards it to the Lighter bridge.
    function depositToLighter(uint256 assets) external;

    /// @notice Withdraw `assets` USDC from the vault's Lighter sub-account back
    ///         to the caller (the vault).
    /// @dev    In production this is asynchronous (Lighter withdrawal queue); the
    ///         v1 mock settles synchronously. The adapter returns USDC to `msg.sender`.
    function withdrawFromLighter(uint256 assets) external;

    /// @notice Push the latest NAV for `vault`'s Lighter sub-account.
    /// @dev    Authorized to the vault's `teeWallet` (TEE-signed in v1).
    /// @param  vault The vault whose sub-account NAV is being reported.
    /// @param  nav   Sub-account value (free collateral + open-position value)
    ///               in USDC units (6 decimals).
    function pushNav(address vault, uint256 nav) external;

    /// @notice Latest reported NAV (USDC, 6 decimals) of `vault`'s sub-account.
    /// @dev    Read by {EigenVault.totalAssets}.
    function navOf(address vault) external view returns (uint256);
}
