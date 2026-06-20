// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IVaultFactory} from "../interfaces/IVaultFactory.sol";
import {IFeeAccountant} from "../interfaces/IFeeAccountant.sol";
import {IAttestationRegistry} from "../interfaces/IAttestationRegistry.sol";
import {ILighterAdapter} from "../interfaces/adapters/ILighterAdapter.sol";
import {EigenVault} from "./EigenVault.sol";

/// @title VaultFactory
/// @notice Permissionless entry point that deploys an {EigenVault} and binds it
///         in the {AttestationRegistry}.
/// @dev    The factory is registered as the registry's `factory`, so it is the
///         only caller allowed to perform a vault's *first* bind. Subsequent
///         re-binds (rotation) come from the vault itself.
///
///         createVault is permissionless by design (anyone can be a builder).
///         For v1 the attestation token is supplied by the caller and checked by
///         the registry's pluggable verifier. With the onchain-stub verifier this
///         is effectively a self-attestation; production swaps in a verifier that
///         validates the EigenCompute KMS signature.
contract VaultFactory is IVaultFactory, Ownable {
    /// @notice USDC asset for all vaults from this factory.
    IERC20 public immutable usdc;
    /// @notice Shared fee math oracle.
    IFeeAccountant public immutable feeAccountant;
    /// @notice Attestation registry.
    IAttestationRegistry public immutable registry;
    /// @notice Shared Lighter adapter / NAV oracle.
    ILighterAdapter public immutable adapter;
    /// @notice Redemption window applied to image rotations (e.g. 24h).
    uint256 public immutable rotationWindow;

    /// @inheritdoc IVaultFactory
    address[] public allVaults;

    error ZeroAddress();

    /// @param owner_          Governance (no special vault powers; reserved).
    /// @param usdc_           USDC token.
    /// @param feeAccountant_  Fee math oracle.
    /// @param registry_       Attestation registry (factory must be its `factory`).
    /// @param adapter_        Lighter adapter / NAV oracle.
    /// @param rotationWindow_ Redemption window for rotations.
    constructor(
        address owner_,
        IERC20 usdc_,
        IFeeAccountant feeAccountant_,
        IAttestationRegistry registry_,
        ILighterAdapter adapter_,
        uint256 rotationWindow_
    ) Ownable(owner_) {
        if (
            address(usdc_) == address(0) || address(feeAccountant_) == address(0)
                || address(registry_) == address(0) || address(adapter_) == address(0)
        ) revert ZeroAddress();
        usdc = usdc_;
        feeAccountant = feeAccountant_;
        registry = registry_;
        adapter = adapter_;
        rotationWindow = rotationWindow_;
    }

    /// @inheritdoc IVaultFactory
    function createVault(VaultParams calldata p) external returns (address vault) {
        if (p.teeWallet == address(0) || p.builder == address(0)) revert ZeroAddress();

        EigenVault v = new EigenVault(
            usdc,
            _name(p),
            _symbol(p),
            p.imageHash,
            p.teeWallet,
            p.builder,
            p.perfFeeBps,
            p.txFeeBps,
            feeAccountant,
            registry,
            adapter,
            rotationWindow,
            p.metadataURI
        );
        vault = address(v);

        // First bind: factory is the only authorized first-binder in the registry.
        // The empty attestation is accepted by the onchain-stub verifier; a real
        // verifier would require a genuine EigenCompute attestation token here,
        // threaded through VaultParams.
        registry.bind(vault, p.imageHash, p.teeWallet, "");

        allVaults.push(vault);
        emit VaultCreated(vault, p.builder, p.imageHash);
    }

    /// @inheritdoc IVaultFactory
    function vaultCount() external view returns (uint256) {
        return allVaults.length;
    }

    /// @dev Deterministic share-token name/symbol from the image hash prefix.
    function _name(VaultParams calldata p) internal pure returns (string memory) {
        return string.concat("EigenStrategies Vault ", _shortHash(p.imageHash));
    }

    function _symbol(VaultParams calldata) internal pure returns (string memory) {
        return "esVAULT";
    }

    /// @dev First 4 bytes of the image hash as hex, for a human-readable name.
    function _shortHash(bytes32 h) internal pure returns (string memory) {
        bytes memory hexChars = "0123456789abcdef";
        bytes memory out = new bytes(8);
        for (uint256 i = 0; i < 4; i++) {
            uint8 b = uint8(h[i]);
            out[i * 2] = hexChars[b >> 4];
            out[i * 2 + 1] = hexChars[b & 0x0f];
        }
        return string(out);
    }
}
