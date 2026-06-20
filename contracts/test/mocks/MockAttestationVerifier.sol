// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAttestationVerifier} from "../../interfaces/IAttestationRegistry.sol";

/// @title MockAttestationVerifier
/// @notice Trivial onchain-stub verifier used for tests and the v1 onchain path.
/// @dev    Approves every binding. A production onchain verifier would recover the
///         EigenCompute KMS signature over `(imageHash, teeWallet)` from
///         `attestation` and check it against a known KMS root; an AVS-backed
///         verifier would instead consult a posted AVS result. The registry treats
///         all three identically through {IAttestationVerifier}.
contract MockAttestationVerifier is IAttestationVerifier {
    /// @notice Toggle to exercise the rejection path in tests.
    bool public acceptAll = true;

    function setAcceptAll(bool v) external {
        acceptAll = v;
    }

    /// @inheritdoc IAttestationVerifier
    function verify(address, bytes32, address, bytes calldata) external view returns (bool) {
        return acceptAll;
    }
}
