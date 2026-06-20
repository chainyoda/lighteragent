// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISkillRegistry} from "../interfaces/ISkillRegistry.sol";

/// @notice Minimal view of {EigenVault} this registry needs to gate authority.
/// @dev    Declared locally so the registry is fully self-contained and carries no
///         constructor dependency on other custody-plane contracts. {IEigenVault}
///         exposes both getters; any vault that returns a `builder` and a
///         `teeWallet` is compatible.
interface IVaultAuthority {
    /// @notice The deployer who owns the vault's secret agent and curates skills.
    function builder() external view returns (address);

    /// @notice The attested wallet bound to the live shell (only it can heartbeat).
    function teeWallet() external view returns (address);
}

/// @title SkillRegistry
/// @notice On-chain custody-plane registry realizing the **NemoClaw Shell wraps a
///         mutable Agent** trust model (see {ISkillRegistry} for the full model).
///
/// @dev    DESIGN
///         ------
///         Permissionless and decoupled: it has no constructor, no owner, and no
///         wiring to the factory or registry. It keys everything by `vault` and
///         reads authority live from each vault via {IVaultAuthority}, so a vault
///         created by any factory can use it, and rotating a vault's `teeWallet`
///         (image rotation) automatically rotates who may {heartbeat} it.
///
///         WHY THIS IS SAFE WITH A SECRET, MUTABLE AGENT
///         The deployer's agent is secret and mutable, but the measured shell only
///         loads a skill whose hash appears in this allowlist. So:
///           - The allowlist is PUBLIC (transparency): investors see exactly when
///             the skill set changes, via {SkillAllowed}/{SkillRevoked}.
///           - The skill *content* stays SECRET inside the TEE (only the hash and
///             an opaque manifest `uri` are on-chain).
///           - The shell — not this contract — enforces policy/leverage/limits, so
///             allowlisting a skill never lets the agent exceed the vault's caps.
contract SkillRegistry is ISkillRegistry {
    /// @dev Per-vault membership flag for O(1) `isAllowedSkill` lookups.
    mapping(address vault => mapping(bytes32 skillHash => bool allowed)) internal _allowed;

    /// @dev Per-vault enumerable array of allowlisted skill hashes.
    mapping(address vault => bytes32[] hashes) internal _hashes;

    /// @dev Position (1-based) of `skillHash` within `_hashes[vault]`, for O(1)
    ///      swap-and-pop removal. Zero means "not present".
    mapping(address vault => mapping(bytes32 skillHash => uint256 indexPlusOne)) internal _index;

    // --- Errors -------------------------------------------------------------

    /// @notice Caller is not the vault's `builder()`.
    error NotBuilder(address caller, address vault);
    /// @notice Caller is not the vault's `teeWallet()`.
    error NotTeeWallet(address caller, address vault);
    /// @notice Attempted to revoke a skill that is not allowlisted.
    error SkillNotFound(address vault, bytes32 skillHash);

    // --- Modifiers ----------------------------------------------------------

    /// @dev Restrict to the vault's curator (the deployer who owns the agent).
    modifier onlyBuilder(address vault) {
        if (msg.sender != IVaultAuthority(vault).builder()) {
            revert NotBuilder(msg.sender, vault);
        }
        _;
    }

    /// @dev Restrict to the vault's live, attested shell wallet.
    modifier onlyTeeWallet(address vault) {
        if (msg.sender != IVaultAuthority(vault).teeWallet()) {
            revert NotTeeWallet(msg.sender, vault);
        }
        _;
    }

    // --- Skill allowlist (builder-gated) ------------------------------------

    /// @inheritdoc ISkillRegistry
    function allowSkill(address vault, bytes32 skillHash, string calldata uri)
        external
        onlyBuilder(vault)
    {
        // Add to the enumerable set only on first allow; re-allowing simply
        // re-emits with a (possibly updated) manifest uri and does not duplicate.
        if (!_allowed[vault][skillHash]) {
            _allowed[vault][skillHash] = true;
            _hashes[vault].push(skillHash);
            _index[vault][skillHash] = _hashes[vault].length; // 1-based
        }
        emit SkillAllowed(vault, skillHash, uri);
    }

    /// @inheritdoc ISkillRegistry
    function revokeSkill(address vault, bytes32 skillHash) external onlyBuilder(vault) {
        uint256 idxPlusOne = _index[vault][skillHash];
        if (idxPlusOne == 0) revert SkillNotFound(vault, skillHash);

        // Swap-and-pop removal to keep the enumeration array compact.
        bytes32[] storage arr = _hashes[vault];
        uint256 idx = idxPlusOne - 1;
        uint256 lastIdx = arr.length - 1;
        if (idx != lastIdx) {
            bytes32 moved = arr[lastIdx];
            arr[idx] = moved;
            _index[vault][moved] = idx + 1; // re-point the moved element
        }
        arr.pop();

        delete _allowed[vault][skillHash];
        delete _index[vault][skillHash];

        emit SkillRevoked(vault, skillHash);
    }

    // --- Heartbeat (teeWallet-gated) ----------------------------------------

    /// @inheritdoc ISkillRegistry
    /// @dev The `attestation` blob is carried for transparency/anchoring; it is
    ///      not verified on-chain in v1 (a future verifier can be slotted in the
    ///      same way {AttestationRegistry} swaps its verifier).
    function heartbeat(address vault, bytes32 ordersRoot, bytes32 navRoot, bytes calldata attestation)
        external
        onlyTeeWallet(vault)
    {
        attestation; // silence unused-parameter warning; reserved for verification
        emit Heartbeat(vault, ordersRoot, navRoot, block.timestamp);
    }

    // --- Views --------------------------------------------------------------

    /// @inheritdoc ISkillRegistry
    function isAllowedSkill(address vault, bytes32 skillHash) external view returns (bool) {
        return _allowed[vault][skillHash];
    }

    /// @inheritdoc ISkillRegistry
    function skillHashes(address vault) external view returns (bytes32[] memory) {
        return _hashes[vault];
    }
}
