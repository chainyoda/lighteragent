// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IAttestationRegistry
/// @notice Onchain pin of `(vault -> imageHash, teeWallet)`. Before a binding is
///         accepted, the registry verifies an EigenCompute attestation token via
///         a pluggable verifier.
/// @dev    Two verifier paths were considered in the design doc (§3):
///         A. AVS-backed light verifier (trust an EigenLayer AVS that posts
///            attestation results), and
///         B. fully-onchain verifier (verify the attestation signature against a
///            known KMS root).
///         This codebase implements path B's *shape* with a pluggable
///         {IAttestationVerifier} so either backend can be slotted in.
interface IAttestationRegistry {
    /// @notice Emitted when a vault's `(imageHash, teeWallet)` is bound or rebound.
    event Bound(address indexed vault, bytes32 indexed imageHash, address indexed teeWallet);

    /// @notice Bind a vault to an attested image and its derived TEE wallet.
    /// @dev    Reverts if the attestation fails verification. Callable by the
    ///         vault (during rotation) or the factory (at creation); the
    ///         implementation gates who may (re)bind a given vault.
    /// @param  vault       The vault being attested.
    /// @param  imageHash   EigenCompute attested image digest.
    /// @param  teeWallet   KMS-derived wallet bound to `imageHash`.
    /// @param  attestation Opaque attestation token handed to the verifier.
    function bind(address vault, bytes32 imageHash, address teeWallet, bytes calldata attestation)
        external;

    /// @notice True if `vault` has a currently-valid binding.
    function isValid(address vault) external view returns (bool);

    /// @notice The image hash currently bound to `vault` (zero if unbound).
    function imageOf(address vault) external view returns (bytes32);

    /// @notice The TEE wallet currently bound to `vault` (zero if unbound).
    function walletOf(address vault) external view returns (address);
}

/// @title IAttestationVerifier
/// @notice Pluggable verifier for EigenCompute attestation tokens.
/// @dev    Swapping this contract is how the registry moves between the
///         AVS-backed and fully-onchain verification paths without touching
///         the registry's binding/storage logic.
interface IAttestationVerifier {
    /// @notice Verify that `attestation` proves `teeWallet` was derived from
    ///         `imageHash` for `vault`.
    /// @return ok True iff the attestation is valid.
    function verify(address vault, bytes32 imageHash, address teeWallet, bytes calldata attestation)
        external
        view
        returns (bool ok);
}
