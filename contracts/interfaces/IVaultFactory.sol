// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IVaultFactory
/// @notice Permissionless entry point: deploys an {EigenVault}, binds it in the
///         {AttestationRegistry}, and emits the publish event the indexer/
///         frontend consume.
interface IVaultFactory {
    /// @notice Parameters supplied by a builder when creating a vault.
    /// @param imageHash    EigenCompute attested image digest.
    /// @param teeWallet    KMS-derived wallet bound to `imageHash`.
    /// @param perfFeeBps   Builder-chosen performance fee (no protocol cap).
    /// @param txFeeBps     Builder-chosen per-trade fee on notional (no cap).
    /// @param builder      Recipient of fee shares.
    /// @param metadataURI  IPFS URI: name, description, risk profile.
    struct VaultParams {
        bytes32 imageHash;
        address teeWallet;
        uint16 perfFeeBps;
        uint16 txFeeBps;
        address builder;
        string metadataURI;
    }

    /// @notice Emitted once per deployed vault.
    event VaultCreated(address vault, address builder, bytes32 imageHash);

    /// @notice Deploy a new vault and bind it in the attestation registry.
    /// @param  p Vault parameters.
    /// @return vault The address of the freshly-deployed vault.
    function createVault(VaultParams calldata p) external returns (address vault);

    /// @notice All vaults created by this factory, in creation order.
    function allVaults(uint256 index) external view returns (address);

    /// @notice Number of vaults created by this factory.
    function vaultCount() external view returns (uint256);
}
