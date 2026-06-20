// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IFeeAccountant} from "../interfaces/IFeeAccountant.sol";

/// @title FeeAccountant
/// @notice Stateless fee-math oracle shared by every {EigenVault}.
/// @dev    Holds no funds and mints no shares. Vaults call the `quote*` views to
///         size a fee (in *asset* units), then mint the corresponding shares and
///         route `protocolCutBps()` of them to `treasury()`. Centralizing the
///         math here keeps the policy uniform and auditable, and lets governance
///         tune the protocol cut without redeploying vaults.
contract FeeAccountant is IFeeAccountant, Ownable {
    /// @dev Basis-point denominator.
    uint256 internal constant BPS_DENOMINATOR = 10_000;

    /// @notice Hard ceiling on the protocol cut (50%). Builder-facing fee bps
    ///         themselves are uncapped by design; only the protocol's *slice* of
    ///         those fees is bounded, to bound governance power.
    uint16 public constant MAX_PROTOCOL_CUT_BPS = 5_000;

    /// @inheritdoc IFeeAccountant
    uint16 public protocolCutBps;

    /// @inheritdoc IFeeAccountant
    address public treasury;

    event ProtocolCutUpdated(uint16 oldBps, uint16 newBps);
    event TreasuryUpdated(address oldTreasury, address newTreasury);

    error ZeroTreasury();
    error ProtocolCutTooHigh(uint16 bps);

    /// @param owner_          Governance address (can tune cut + treasury).
    /// @param treasury_       Recipient of the protocol cut.
    /// @param protocolCutBps_ Initial protocol cut, in bps of each fee.
    constructor(address owner_, address treasury_, uint16 protocolCutBps_) Ownable(owner_) {
        if (treasury_ == address(0)) revert ZeroTreasury();
        if (protocolCutBps_ > MAX_PROTOCOL_CUT_BPS) revert ProtocolCutTooHigh(protocolCutBps_);
        treasury = treasury_;
        protocolCutBps = protocolCutBps_;
    }

    /// @inheritdoc IFeeAccountant
    /// @dev Per-trade fee = notional * bps / 1e4, in asset units.
    function quoteTxFee(uint256 notional, uint16 bps) external pure returns (uint256) {
        return (notional * bps) / BPS_DENOMINATOR;
    }

    /// @inheritdoc IFeeAccountant
    /// @dev Performance fee = pnlAboveHWM * bps / 1e4, in asset units.
    function quotePerfFee(uint256 pnlAboveHWM, uint16 bps) external pure returns (uint256) {
        return (pnlAboveHWM * bps) / BPS_DENOMINATOR;
    }

    // --- Governance ---------------------------------------------------------

    /// @notice Update the protocol cut applied to every fee.
    function setProtocolCutBps(uint16 newBps) external onlyOwner {
        if (newBps > MAX_PROTOCOL_CUT_BPS) revert ProtocolCutTooHigh(newBps);
        emit ProtocolCutUpdated(protocolCutBps, newBps);
        protocolCutBps = newBps;
    }

    /// @notice Update the treasury that receives the protocol cut.
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroTreasury();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }
}
