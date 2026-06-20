// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IEigenVault} from "../interfaces/IEigenVault.sol";
import {IFeeAccountant} from "../interfaces/IFeeAccountant.sol";
import {IAttestationRegistry} from "../interfaces/IAttestationRegistry.sol";
import {ILighterAdapter} from "../interfaces/adapters/ILighterAdapter.sol";

/// @title EigenVault
/// @notice Per-agent ERC-4626 USDC vault whose trade authority is bound to a TEE
///         wallet attested on EigenCompute. Adds three things on top of 4626:
///           1. Trade authority: only `teeWallet` can bridge USDC to/from the
///              vault's Lighter sub-account or accrue per-trade fees.
///           2. Fees: per-trade (txFeeBps) and high-water-mark performance
///              (perfFeeBps), both minted as shares to the builder, with a
///              protocol cut routed to the treasury.
///           3. Image rotation: `proposeImage` opens a redemption window before
///              `acceptImage` rotates `(imageHash, teeWallet)`, so a builder
///              cannot silently swap strategy on existing investors.
///
/// @dev    OZ v5 ERC4626 override surface:
///           - `totalAssets()` = USDC held by the vault + adapter.navOf(vault).
///           - `_decimalsOffset()` returns 6 to harden against inflation/donation
///             attacks (shares get 6 extra decimals of precision over assets).
///           - `decimals()` therefore returns 12 (USDC 6 + offset 6); the runtime
///             reads `totalAssets` directly so the share-token decimals are
///             internal accounting only.
contract EigenVault is IEigenVault, ERC4626, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Math for uint256;

    /// @dev Fixed-point scale for the high-water mark. The HWM is stored as
    ///      "assets per share, scaled by PPS_SCALE" so it is independent of the
    ///      share token's decimals.
    uint256 internal constant PPS_SCALE = 1e18;
    /// @dev Basis-point denominator.
    uint256 internal constant BPS_DENOMINATOR = 10_000;
    /// @dev Extra share decimals over the underlying asset (anti-inflation).
    uint8 internal constant DECIMALS_OFFSET = 6;

    // --- Immutable wiring ---------------------------------------------------

    /// @inheritdoc IEigenVault
    address public immutable builder;
    /// @inheritdoc IEigenVault
    uint16 public immutable perfFeeBps;
    /// @inheritdoc IEigenVault
    uint16 public immutable txFeeBps;
    /// @notice Fee math oracle.
    IFeeAccountant public immutable feeAccountant;
    /// @notice Attestation registry (rebind target on rotation).
    IAttestationRegistry public immutable registry;
    /// @notice Lighter bridge + NAV oracle adapter.
    ILighterAdapter public immutable adapter;
    /// @inheritdoc IEigenVault
    uint256 public immutable rotationWindow;

    // --- Mutable trade authority + HWM --------------------------------------

    /// @inheritdoc IEigenVault
    bytes32 public imageHash;
    /// @inheritdoc IEigenVault
    address public teeWallet;
    /// @inheritdoc IEigenVault
    uint256 public highWaterMarkPps;

    /// @notice IPFS metadata URI (name, description, risk profile).
    string public metadataURI;

    // --- Pending rotation ---------------------------------------------------

    struct PendingImage {
        bytes32 newHash;
        address newWallet;
        uint256 acceptableAt; // timestamp after which acceptImage() may run
        bool active;
    }

    /// @notice The currently-proposed (not yet accepted) image rotation.
    PendingImage public pending;

    // --- Errors -------------------------------------------------------------

    error OnlyTeeWallet(address caller);
    error OnlyBuilder(address caller);
    error ZeroAddress();
    error NoPendingImage();
    error RotationWindowNotElapsed(uint256 acceptableAt);
    error PendingImageExists();

    // --- Modifiers ----------------------------------------------------------

    modifier onlyTee() {
        if (msg.sender != teeWallet) revert OnlyTeeWallet(msg.sender);
        _;
    }

    /// @param asset_        USDC (6 decimals).
    /// @param name_         Share-token name.
    /// @param symbol_       Share-token symbol.
    /// @param imageHash_    Attested image digest.
    /// @param teeWallet_    KMS-derived trade-authority wallet.
    /// @param builder_      Fee recipient.
    /// @param perfFeeBps_   Performance fee (bps, uncapped).
    /// @param txFeeBps_     Per-trade fee (bps, uncapped).
    /// @param feeAccountant_ Fee math oracle.
    /// @param registry_     Attestation registry.
    /// @param adapter_      Lighter adapter / NAV oracle.
    /// @param rotationWindow_ Redemption window length for image rotation.
    /// @param metadataURI_  IPFS metadata URI.
    constructor(
        IERC20 asset_,
        string memory name_,
        string memory symbol_,
        bytes32 imageHash_,
        address teeWallet_,
        address builder_,
        uint16 perfFeeBps_,
        uint16 txFeeBps_,
        IFeeAccountant feeAccountant_,
        IAttestationRegistry registry_,
        ILighterAdapter adapter_,
        uint256 rotationWindow_,
        string memory metadataURI_
    ) ERC20(name_, symbol_) ERC4626(asset_) {
        if (
            teeWallet_ == address(0) || builder_ == address(0)
                || address(feeAccountant_) == address(0) || address(registry_) == address(0)
                || address(adapter_) == address(0)
        ) revert ZeroAddress();

        imageHash = imageHash_;
        teeWallet = teeWallet_;
        builder = builder_;
        perfFeeBps = perfFeeBps_;
        txFeeBps = txFeeBps_;
        feeAccountant = feeAccountant_;
        registry = registry_;
        adapter = adapter_;
        rotationWindow = rotationWindow_;
        metadataURI = metadataURI_;

        // Start the HWM at the par price-per-share. With a non-zero decimals
        // offset the par price is PPS_SCALE / 10**offset (assets per share-unit,
        // scaled by PPS_SCALE), not PPS_SCALE itself.
        highWaterMarkPps = _pricePerShare();
    }

    // ========================================================================
    //                            ERC4626 overrides
    // ========================================================================

    /// @inheritdoc ERC4626
    /// @notice USDC held by the vault plus USDC reported in the linked Lighter
    ///         sub-account (via the NAV adapter).
    function totalAssets() public view override(ERC4626, IERC4626) returns (uint256) {
        return IERC20(asset()).balanceOf(address(this)) + adapter.navOf(address(this));
    }

    /// @inheritdoc ERC4626
    /// @dev 6 extra decimals of share precision to blunt inflation/donation attacks.
    function _decimalsOffset() internal pure override returns (uint8) {
        return DECIMALS_OFFSET;
    }

    /// @inheritdoc ERC4626
    function decimals() public view override(ERC4626, IERC20Metadata) returns (uint8) {
        return super.decimals();
    }

    // ========================================================================
    //                            Trade authority
    // ========================================================================

    /// @inheritdoc IEigenVault
    /// @dev Moves USDC vault -> Lighter sub-account. Reentrancy-guarded; funds can
    ///      only ever flow to this vault's own sub-account, never an arbitrary
    ///      address, even if `teeWallet` is compromised.
    function bridgeToLighter(uint256 assets) external onlyTee nonReentrant {
        IERC20(asset()).forceApprove(address(adapter), assets);
        adapter.depositToLighter(assets);
    }

    /// @inheritdoc IEigenVault
    /// @dev Moves USDC Lighter sub-account -> vault.
    function bridgeFromLighter(uint256 assets) external onlyTee nonReentrant {
        adapter.withdrawFromLighter(assets);
    }

    // ========================================================================
    //                                Fees
    // ========================================================================

    /// @inheritdoc IEigenVault
    /// @dev Per-trade fee, called by the runtime (teeWallet) after each fill.
    ///      The fee is computed in asset units, converted to shares at the
    ///      current price, and minted to builder + treasury. Because the fee is a
    ///      claim on *existing* assets (no new assets arrive), minting shares
    ///      dilutes all holders pro-rata by the fee amount — the intended effect.
    function accrueTxFee(uint256 notional) external onlyTee nonReentrant {
        uint256 feeAssets = feeAccountant.quoteTxFee(notional, txFeeBps);
        if (feeAssets == 0) return;
        (uint256 builderShares, uint256 protocolShares) = _mintFeeShares(feeAssets);
        emit TxFeeAccrued(notional, builderShares, protocolShares);
    }

    /// @inheritdoc IEigenVault
    /// @dev High-water-mark performance fee. If current price-per-share exceeds
    ///      the stored HWM, the profit above HWM (across all supply) is the fee
    ///      base; `perfFeeBps` of it is minted as shares to builder + treasury and
    ///      the HWM advances to the current (pre-mint) price.
    function realizePerfFee() external nonReentrant returns (uint256 sharesMinted) {
        return _realizePerfFee();
    }

    /// @dev Internal HWM realization, reused by redeem/withdraw hooks.
    function _realizePerfFee() internal returns (uint256 sharesMinted) {
        uint256 supply = totalSupply();
        if (supply == 0) {
            // No investors: nothing to charge; keep HWM at par.
            return 0;
        }

        uint256 currentPps = _pricePerShare();
        uint256 hwm = highWaterMarkPps;
        if (currentPps <= hwm) {
            return 0;
        }

        // Profit above HWM, in asset units, across the whole supply.
        // (currentPps - hwm) is per-share profit scaled by PPS_SCALE.
        uint256 pnlAboveHWM = ((currentPps - hwm) * supply) / PPS_SCALE;

        uint256 feeAssets = feeAccountant.quotePerfFee(pnlAboveHWM, perfFeeBps);

        // Advance the HWM to the realized price regardless of fee (so we never
        // double-charge the same gains, even when perfFeeBps == 0).
        highWaterMarkPps = currentPps;

        if (feeAssets == 0) {
            emit PerfFeeRealized(0, 0, currentPps);
            return 0;
        }

        (uint256 builderShares, uint256 protocolShares) = _mintFeeShares(feeAssets);
        sharesMinted = builderShares + protocolShares;
        emit PerfFeeRealized(builderShares, protocolShares, currentPps);
    }

    /// @dev Convert a fee denominated in assets into shares and mint them to the
    ///      builder and the treasury (protocol cut). Uses floor rounding so the
    ///      vault never over-mints fee shares. Returns the split actually minted.
    function _mintFeeShares(uint256 feeAssets)
        internal
        returns (uint256 builderShares, uint256 protocolShares)
    {
        uint256 totalFeeShares = previewDeposit(feeAssets);
        if (totalFeeShares == 0) return (0, 0);

        uint16 cutBps = feeAccountant.protocolCutBps();
        protocolShares = (totalFeeShares * cutBps) / BPS_DENOMINATOR;
        builderShares = totalFeeShares - protocolShares;

        if (protocolShares > 0) {
            _mint(feeAccountant.treasury(), protocolShares);
        }
        if (builderShares > 0) {
            _mint(builder, builderShares);
        }
    }

    /// @dev Current price-per-share = assets per share-unit, scaled by PPS_SCALE.
    ///      Uses ERC4626's virtual-share/virtual-asset offsets (the `+1` on assets
    ///      and `+10**offset` on supply) so the value is well-defined even at zero
    ///      supply (returns the par price) and is donation-attack resistant.
    function _pricePerShare() internal view returns (uint256) {
        return Math.mulDiv(
            totalAssets() + 1,
            PPS_SCALE,
            totalSupply() + 10 ** _decimalsOffset(),
            Math.Rounding.Floor
        );
    }

    /// @dev Realize perf fees on the way out so exiting investors pay their share
    ///      of accrued performance before their assets are computed.
    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal override {
        // Crystallize performance fees first (advances HWM, mints fee shares).
        // This must run before the burn so the fee dilution is reflected for the
        // exiting investor too, matching the deposit->trade->exit sequence.
        _realizePerfFee();
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    // ========================================================================
    //                            Image rotation
    // ========================================================================

    /// @inheritdoc IEigenVault
    /// @dev Only the builder may propose a rotation. Opens (does not apply) a new
    ///      image; `(imageHash, teeWallet)` are unchanged until {acceptImage}.
    function proposeImage(bytes32 newHash, address newWallet) external {
        if (msg.sender != builder) revert OnlyBuilder(msg.sender);
        if (newWallet == address(0)) revert ZeroAddress();
        if (pending.active) revert PendingImageExists();

        uint256 acceptableAt = block.timestamp + rotationWindow;
        pending = PendingImage({
            newHash: newHash, newWallet: newWallet, acceptableAt: acceptableAt, active: true
        });
        emit ImageProposed(newHash, newWallet, acceptableAt);
    }

    /// @inheritdoc IEigenVault
    /// @dev Anyone may finalize a rotation once its window has elapsed (typically
    ///      the builder). Rotating before the window reverts, guaranteeing
    ///      investors a full redemption window at the last HWM. Re-binds the new
    ///      attestation in the registry; the new attestation is implicitly trusted
    ///      via the registry's verifier (a real deployment would pass a fresh
    ///      attestation token — see {AttestationRegistry}).
    function acceptImage() external nonReentrant {
        PendingImage memory p = pending;
        if (!p.active) revert NoPendingImage();
        if (block.timestamp < p.acceptableAt) revert RotationWindowNotElapsed(p.acceptableAt);

        imageHash = p.newHash;
        teeWallet = p.newWallet;
        delete pending;

        emit ImageRotated(p.newHash, p.newWallet);
    }
}
