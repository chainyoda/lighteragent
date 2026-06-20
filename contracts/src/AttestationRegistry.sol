// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {
    IAttestationRegistry, IAttestationVerifier
} from "../interfaces/IAttestationRegistry.sol";

/// @title AttestationRegistry
/// @notice Onchain pin of `(vault -> imageHash, teeWallet)` for EigenStrategies.
/// @dev    Implements the *onchain-stub* verifier path (design doc §3, path B):
///         an attestation token is checked by a pluggable {IAttestationVerifier}
///         before a binding is accepted. A real verifier would check the KMS
///         signature over `(imageHash, teeWallet)`; the AVS-backed path (path A)
///         can be slotted in by swapping the verifier for one that consults an
///         EigenLayer AVS result. The registry's storage/auth logic is unchanged
///         either way.
///
///         Binding authority:
///           - The first bind for a vault may be performed by the factory (the
///             registered `factory`) at creation time.
///           - Subsequent re-binds (image rotation) must come from the vault
///             itself, so a third party cannot re-point a live vault.
contract AttestationRegistry is IAttestationRegistry, Ownable {
    struct Binding {
        bytes32 imageHash;
        address teeWallet;
        bool exists;
    }

    /// @notice Pluggable attestation verifier (onchain-stub or AVS-backed).
    IAttestationVerifier public verifier;

    /// @notice The factory permitted to perform the *first* bind of a vault.
    address public factory;

    /// @dev vault => current binding.
    mapping(address => Binding) internal _bindings;

    event VerifierUpdated(address oldVerifier, address newVerifier);
    event FactoryUpdated(address oldFactory, address newFactory);

    error ZeroVerifier();
    error NotAuthorizedToBind(address caller, address vault);
    error AttestationRejected(address vault, bytes32 imageHash, address teeWallet);
    error ZeroAddress();

    /// @param owner_    Governance (can swap verifier / factory).
    /// @param verifier_ Initial attestation verifier.
    constructor(address owner_, IAttestationVerifier verifier_) Ownable(owner_) {
        if (address(verifier_) == address(0)) revert ZeroVerifier();
        verifier = verifier_;
    }

    /// @inheritdoc IAttestationRegistry
    function bind(address vault, bytes32 imageHash, address teeWallet, bytes calldata attestation)
        external
    {
        if (vault == address(0) || teeWallet == address(0)) revert ZeroAddress();

        // Authorization: first bind => factory; re-bind => the vault itself.
        bool firstBind = !_bindings[vault].exists;
        if (firstBind) {
            if (msg.sender != factory) revert NotAuthorizedToBind(msg.sender, vault);
        } else {
            if (msg.sender != vault) revert NotAuthorizedToBind(msg.sender, vault);
        }

        // Verify the attestation token against the pluggable verifier.
        if (!verifier.verify(vault, imageHash, teeWallet, attestation)) {
            revert AttestationRejected(vault, imageHash, teeWallet);
        }

        _bindings[vault] = Binding({imageHash: imageHash, teeWallet: teeWallet, exists: true});
        emit Bound(vault, imageHash, teeWallet);
    }

    /// @inheritdoc IAttestationRegistry
    function isValid(address vault) external view returns (bool) {
        return _bindings[vault].exists;
    }

    /// @inheritdoc IAttestationRegistry
    function imageOf(address vault) external view returns (bytes32) {
        return _bindings[vault].imageHash;
    }

    /// @inheritdoc IAttestationRegistry
    function walletOf(address vault) external view returns (address) {
        return _bindings[vault].teeWallet;
    }

    // --- Governance ---------------------------------------------------------

    /// @notice Swap the attestation verifier (e.g. onchain-stub -> AVS-backed).
    function setVerifier(IAttestationVerifier newVerifier) external onlyOwner {
        if (address(newVerifier) == address(0)) revert ZeroVerifier();
        emit VerifierUpdated(address(verifier), address(newVerifier));
        verifier = newVerifier;
    }

    /// @notice Set the factory allowed to perform first binds.
    /// @dev    Set once, immediately after the factory is deployed.
    function setFactory(address newFactory) external onlyOwner {
        emit FactoryUpdated(factory, newFactory);
        factory = newFactory;
    }
}
