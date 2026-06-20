// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IFeeAccountant
/// @notice Pure fee-math oracle shared by every {EigenVault}. It converts a
///         builder-chosen basis-point schedule into the *gross* fee that should
///         be charged and reports the protocol's cut of that fee.
/// @dev    The accountant holds no funds and mints no shares itself. It is a
///         stateless (modulo governance config) calculator so that the same
///         fee policy is consistently applied across all vaults and is trivially
///         auditable. The vault is responsible for translating these quantities
///         into share mints and for routing the protocol cut to the treasury.
interface IFeeAccountant {
    /// @notice Quote the per-trade fee for a given notional.
    /// @param  notional Trade notional in asset units (USDC, 6 decimals).
    /// @param  bps      Builder-chosen per-trade fee in basis points (no cap).
    /// @return shares   Fee expressed in *asset* units (the vault converts to
    ///                  shares at the prevailing share price). Named `shares`
    ///                  to match the design-doc ABI; see {EigenVault.accrueTxFee}.
    function quoteTxFee(uint256 notional, uint16 bps) external view returns (uint256 shares);

    /// @notice Quote the performance fee on profit above the high-water mark.
    /// @param  pnlAboveHWM Profit (in asset units) earned above the HWM.
    /// @param  bps         Builder-chosen performance fee in basis points.
    /// @return shares      Fee in *asset* units (vault converts to shares).
    function quotePerfFee(uint256 pnlAboveHWM, uint16 bps) external view returns (uint256 shares);

    /// @notice Protocol's cut of every fee, in basis points of the gross fee.
    /// @dev    Applied by the vault when splitting a fee between builder and
    ///         treasury. e.g. a cut of 1000 (=10%) means the treasury receives
    ///         10% of the fee shares and the builder receives 90%.
    function protocolCutBps() external view returns (uint16);

    /// @notice Address that receives the protocol cut of all fees.
    function treasury() external view returns (address);
}
