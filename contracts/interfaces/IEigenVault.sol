// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

/// @title IEigenVault
/// @notice Per-agent ERC-4626 vault (USDC-denominated) whose trade authority is
///         bound to a TEE wallet attested on EigenCompute. Adds trade-authority,
///         fee accrual, and image-rotation on top of the standard 4626 surface.
/// @dev    Function signatures here MUST match the Python runtime's `VAULT_ABI`
///         (see agent-sdk/eigenstrategies_sdk/vault_client.py).
interface IEigenVault is IERC4626 {
    // --- Events -------------------------------------------------------------

    /// @notice Emitted when a new image/wallet pair is proposed for rotation.
    event ImageProposed(
        bytes32 indexed newImageHash, address indexed newWallet, uint256 acceptableAt
    );
    /// @notice Emitted when a previously-proposed rotation is accepted.
    event ImageRotated(bytes32 indexed imageHash, address indexed teeWallet);
    /// @notice Emitted on each per-trade fee accrual.
    event TxFeeAccrued(uint256 notional, uint256 builderShares, uint256 protocolShares);
    /// @notice Emitted when a performance fee is realized and the HWM advances.
    event PerfFeeRealized(
        uint256 builderShares, uint256 protocolShares, uint256 newHighWaterMarkPps
    );

    // --- Trade authority ----------------------------------------------------

    /// @notice The wallet currently authorized to bridge and accrue fees.
    function teeWallet() external view returns (address);

    /// @notice The EigenCompute image hash currently pinned to this vault.
    function imageHash() external view returns (bytes32);

    // --- Lighter bridge moves (teeWallet-only) ------------------------------

    /// @notice Move `assets` USDC from the vault into its Lighter sub-account.
    /// @dev    ONLY callable by `teeWallet`. Funds can only flow vault -> Lighter.
    function bridgeToLighter(uint256 assets) external;

    /// @notice Pull `assets` USDC from the Lighter sub-account back to the vault.
    /// @dev    ONLY callable by `teeWallet`. Funds can only flow Lighter -> vault.
    function bridgeFromLighter(uint256 assets) external;

    // --- Fee accrual --------------------------------------------------------

    /// @notice Accrue the builder's per-trade fee on `notional`.
    /// @dev    ONLY callable by `teeWallet` (the runtime calls this after a fill).
    ///         Mints fee shares to the builder (and protocol cut to treasury).
    function accrueTxFee(uint256 notional) external;

    /// @notice Realize the high-water-mark performance fee, if any.
    /// @return sharesMinted Total fee shares minted (builder + protocol).
    function realizePerfFee() external returns (uint256 sharesMinted);

    // --- Image rotation -----------------------------------------------------

    /// @notice Propose rotating to a new attested `(imageHash, teeWallet)`.
    /// @dev    Opens a redemption window; authority does NOT change until
    ///         {acceptImage} is called after the window elapses.
    function proposeImage(bytes32 newHash, address newWallet) external;

    /// @notice Accept a previously-proposed rotation once its window has elapsed.
    function acceptImage() external;

    // --- Views --------------------------------------------------------------

    /// @notice The builder (recipient of fee shares).
    function builder() external view returns (address);

    /// @notice Performance fee in basis points (builder-chosen, no cap).
    function perfFeeBps() external view returns (uint16);

    /// @notice Per-trade fee in basis points (builder-chosen, no cap).
    function txFeeBps() external view returns (uint16);

    /// @notice High-water mark, stored as price-per-share scaled by 1e18.
    function highWaterMarkPps() external view returns (uint256);

    /// @notice Duration of the redemption window opened by {proposeImage}.
    function rotationWindow() external view returns (uint256);
}
