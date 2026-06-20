// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ISkillRegistry
/// @notice On-chain custody-plane registry that realizes the
///         **"NemoClaw Shell wraps a mutable Agent"** trust model for a vault.
///
/// @dev    THE TRUST MODEL
///         ---------------
///         Each {EigenVault} runs inside an EigenCompute TEE. The attested,
///         on-chain-pinned artifact is the **NemoClaw Shell** — open-source and
///         measured. That is precisely what {AttestationRegistry.imageOf} pins to
///         the vault: a hash of the *shell*, not of the strategy.
///
///         Inside that shell runs a deployer-owned, **secret, mutable Agent**:
///         its mandate prompt, skills, models, and MCP wiring. The agent is the
///         builder's edge and is intentionally NOT published. The shell is the
///         trust boundary that makes a secret, mutable agent safe for investors:
///
///           1. POLICY ENFORCEMENT. The measured shell enforces the vault's
///              published policy/leverage/concentration limits regardless of what
///              the agent decides. A mutated agent still cannot exceed the vault's
///              limits, and it can only reach Lighter through the shell's gateway
///              (mirrored on-chain by the vault's `teeWallet`-gated bridge moves).
///
///           2. SKILL ALLOWLISTING. The shell hash-checks every skill the agent
///              loads against this registry's per-vault allowlist. Investors can
///              therefore see WHEN the agent's skill set changes — the skill
///              hashes are public, so changes are transparent — but NOT the skill
///              *content*, which stays secret inside the TEE. The agent is mutable
///              *because* the shell refuses to load any skill whose hash is not
///              allowlisted here.
///
///           3. HEARTBEAT / ATTESTATION ANCHOR. The live shell periodically posts
///              a {heartbeat}, anchoring its off-chain per-order attestation stream
///              (committed as a periodic `ordersRoot`) and the NAV oracle reading
///              (`navRoot`) on-chain. Only the vault's attested `teeWallet` — i.e.
///              the live shell — can post it.
///
///         AUTHORITY
///         ---------
///           - {allowSkill}/{revokeSkill} are gated to the vault's `builder()`
///             (the deployer who owns the secret agent and curates its skills).
///           - {heartbeat} is gated to the vault's `teeWallet()` (only the live,
///             attested shell can post the attestation anchor).
///
///         This interface is mirrored ABI-for-ABI by an off-chain Python client,
///         so the signatures below MUST NOT be changed.
interface ISkillRegistry {
    // --- Events -------------------------------------------------------------

    /// @notice Emitted when `builder()` adds `skillHash` to `vault`'s allowlist.
    /// @param  vault     The vault whose allowlist changed.
    /// @param  skillHash Hash the shell checks each loaded skill against.
    /// @param  uri       Off-chain pointer (e.g. IPFS) to the skill manifest; the
    ///                   manifest is public but the skill *content* may be sealed.
    event SkillAllowed(address indexed vault, bytes32 indexed skillHash, string uri);

    /// @notice Emitted when `builder()` removes `skillHash` from `vault`'s allowlist.
    event SkillRevoked(address indexed vault, bytes32 indexed skillHash);

    /// @notice Emitted on each {heartbeat} posted by the vault's live shell.
    /// @param  vault      The vault whose shell posted the heartbeat.
    /// @param  ordersRoot Commitment over the shell's per-order attestation batch.
    /// @param  navRoot    Commitment over the NAV oracle reading.
    /// @param  timestamp  `block.timestamp` of the heartbeat.
    event Heartbeat(address indexed vault, bytes32 ordersRoot, bytes32 navRoot, uint256 timestamp);

    // --- Skill allowlist (builder-gated) ------------------------------------

    /// @notice Add `skillHash` to `vault`'s skill allowlist.
    /// @dev    Only the vault's `builder()` may call. Idempotent: re-allowing an
    ///         already-allowed hash refreshes its `uri` and re-emits the event
    ///         without duplicating set membership.
    /// @param  vault     Vault to allowlist the skill for.
    /// @param  skillHash Hash the shell will accept for a loaded skill.
    /// @param  uri       Public pointer to the (possibly sealed) skill manifest.
    function allowSkill(address vault, bytes32 skillHash, string calldata uri) external;

    /// @notice Remove `skillHash` from `vault`'s skill allowlist.
    /// @dev    Only the vault's `builder()` may call. Reverts if not allowlisted.
    function revokeSkill(address vault, bytes32 skillHash) external;

    // --- Heartbeat (teeWallet-gated) ----------------------------------------

    /// @notice Post the live shell's periodic attestation anchor for `vault`.
    /// @dev    Only the vault's `teeWallet()` (the live, attested shell) may call.
    ///         Per-order attestations are produced off-chain and committed here as
    ///         a periodic `ordersRoot`; `navRoot` anchors the NAV oracle reading.
    /// @param  vault       Vault whose shell is posting.
    /// @param  ordersRoot  Commitment over the per-order attestation batch.
    /// @param  navRoot     Commitment over the NAV oracle reading.
    /// @param  attestation Opaque attestation blob (verified off-chain / by a
    ///                     future verifier); carried for transparency + anchoring.
    function heartbeat(address vault, bytes32 ordersRoot, bytes32 navRoot, bytes calldata attestation)
        external;

    // --- Views --------------------------------------------------------------

    /// @notice True iff `skillHash` is currently allowlisted for `vault`.
    function isAllowedSkill(address vault, bytes32 skillHash) external view returns (bool);

    /// @notice Enumerate every skill hash currently allowlisted for `vault`.
    function skillHashes(address vault) external view returns (bytes32[] memory);
}
