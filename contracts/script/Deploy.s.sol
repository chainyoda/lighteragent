// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FeeAccountant} from "../src/FeeAccountant.sol";
import {AttestationRegistry} from "../src/AttestationRegistry.sol";
import {LighterAdapter, ILighterBridge} from "../src/adapters/LighterAdapter.sol";
import {VaultFactory} from "../src/VaultFactory.sol";
import {SkillRegistry} from "../src/SkillRegistry.sol";
import {IAttestationVerifier} from "../interfaces/IAttestationRegistry.sol";
import {MockAttestationVerifier} from "../test/mocks/MockAttestationVerifier.sol";

/// @title Deploy
/// @notice Deploys the EigenStrategies onchain stack and wires it together.
/// @dev    Address wiring is read from env vars (see contracts/README.md):
///           PRIVATE_KEY        deployer key (forge --private-key also works)
///           GOVERNANCE         owner of FeeAccountant / AttestationRegistry / Factory
///           TREASURY           protocol-cut recipient
///           USDC               USDC token address (chain-specific)
///           LIGHTER_BRIDGE     Lighter deposit/withdraw bridge address
///           ATTESTATION_VERIFIER  (optional) verifier address; if unset a
///                              MockAttestationVerifier (onchain-stub) is deployed
///           PROTOCOL_CUT_BPS   (optional, default 1000 = 10%)
///           ROTATION_WINDOW    (optional, default 86400 = 24h)
contract Deploy is Script {
    function run() external {
        // --- Read configuration ---------------------------------------------
        address governance = vm.envAddress("GOVERNANCE");
        address treasury = vm.envAddress("TREASURY");
        address usdc = vm.envAddress("USDC");
        address lighterBridge = vm.envAddress("LIGHTER_BRIDGE");
        uint16 protocolCutBps = uint16(vm.envOr("PROTOCOL_CUT_BPS", uint256(1_000)));
        uint256 rotationWindow = vm.envOr("ROTATION_WINDOW", uint256(24 hours));
        address verifierEnv = vm.envOr("ATTESTATION_VERIFIER", address(0));

        vm.startBroadcast();

        // --- 1. FeeAccountant ------------------------------------------------
        FeeAccountant feeAccountant = new FeeAccountant(governance, treasury, protocolCutBps);

        // --- 2. Attestation verifier (onchain-stub unless provided) ----------
        IAttestationVerifier verifier;
        if (verifierEnv == address(0)) {
            verifier = new MockAttestationVerifier();
        } else {
            verifier = IAttestationVerifier(verifierEnv);
        }

        // --- 3. AttestationRegistry -----------------------------------------
        AttestationRegistry registry = new AttestationRegistry(governance, verifier);

        // --- 4. LighterAdapter (bridge + NAV oracle) ------------------------
        LighterAdapter adapter = new LighterAdapter(IERC20(usdc), ILighterBridge(lighterBridge));

        // --- 5. VaultFactory ------------------------------------------------
        VaultFactory factory = new VaultFactory(
            governance, IERC20(usdc), feeAccountant, registry, adapter, rotationWindow
        );

        // --- 6. SkillRegistry (Shell-wraps-Agent custody plane) -------------
        // Permissionless + decoupled: no constructor deps, no wiring. Vaults from
        // any factory key into it by address and authority is read live from each
        // vault's builder()/teeWallet().
        SkillRegistry skillRegistry = new SkillRegistry();

        // --- 7. Wire the factory as the registry's first-binder -------------
        // NB: the deployer must be the registry owner (== governance) for this to
        // succeed in a single broadcast. If governance is a separate multisig,
        // call registry.setFactory(factory) from governance after deployment.
        if (msg.sender == governance) {
            registry.setFactory(address(factory));
        } else {
            console2.log("WARNING: deployer != governance; call registry.setFactory manually:");
            console2.log("  registry:", address(registry));
            console2.log("  factory :", address(factory));
        }

        vm.stopBroadcast();

        // --- Log addresses ---------------------------------------------------
        console2.log("== EigenStrategies deployment ==");
        console2.log("FeeAccountant     :", address(feeAccountant));
        console2.log("AttestationVerifier:", address(verifier));
        console2.log("AttestationRegistry:", address(registry));
        console2.log("LighterAdapter    :", address(adapter));
        console2.log("VaultFactory      :", address(factory));
        console2.log("SkillRegistry     :", address(skillRegistry));
        console2.log("USDC              :", usdc);
        console2.log("LighterBridge     :", lighterBridge);
        console2.log("Treasury          :", treasury);
        console2.log("Governance        :", governance);
    }
}
