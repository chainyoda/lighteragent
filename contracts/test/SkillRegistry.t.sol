// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";

import {SkillRegistry} from "../src/SkillRegistry.sol";
import {ISkillRegistry} from "../interfaces/ISkillRegistry.sol";

/// @notice Tiny vault stub exposing just the authority surface the SkillRegistry
///         reads ({IVaultAuthority}: builder + teeWallet). Self-contained so the
///         test needs no factory/registry wiring.
contract MockVaultAuthority {
    address public builder;
    address public teeWallet;

    constructor(address builder_, address teeWallet_) {
        builder = builder_;
        teeWallet = teeWallet_;
    }

    function setTeeWallet(address w) external {
        teeWallet = w;
    }
}

contract SkillRegistryTest is Test {
    SkillRegistry internal skills;
    MockVaultAuthority internal vault;

    address internal builder = makeAddr("builder");
    address internal teeWallet = makeAddr("teeWallet");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant SKILL_A = keccak256("skill-A");
    bytes32 internal constant SKILL_B = keccak256("skill-B");
    bytes32 internal constant SKILL_C = keccak256("skill-C");

    event SkillAllowed(address indexed vault, bytes32 indexed skillHash, string uri);
    event SkillRevoked(address indexed vault, bytes32 indexed skillHash);
    event Heartbeat(address indexed vault, bytes32 ordersRoot, bytes32 navRoot, uint256 timestamp);

    function setUp() public {
        skills = new SkillRegistry();
        vault = new MockVaultAuthority(builder, teeWallet);
    }

    // --- allow / revoke happy path ------------------------------------------

    function test_BuilderCanAllowThenRevoke() public {
        address v = address(vault);

        vm.expectEmit(true, true, false, true, address(skills));
        emit SkillAllowed(v, SKILL_A, "ipfs://a");
        vm.prank(builder);
        skills.allowSkill(v, SKILL_A, "ipfs://a");

        assertTrue(skills.isAllowedSkill(v, SKILL_A), "should be allowed after allow");

        vm.expectEmit(true, true, false, true, address(skills));
        emit SkillRevoked(v, SKILL_A);
        vm.prank(builder);
        skills.revokeSkill(v, SKILL_A);

        assertFalse(skills.isAllowedSkill(v, SKILL_A), "should be revoked");
    }

    function test_IsAllowedSkillReflectsState() public {
        address v = address(vault);
        assertFalse(skills.isAllowedSkill(v, SKILL_A));

        vm.prank(builder);
        skills.allowSkill(v, SKILL_A, "ipfs://a");
        assertTrue(skills.isAllowedSkill(v, SKILL_A));

        vm.prank(builder);
        skills.revokeSkill(v, SKILL_A);
        assertFalse(skills.isAllowedSkill(v, SKILL_A));
    }

    // --- enumeration --------------------------------------------------------

    function test_SkillHashesEnumerates() public {
        address v = address(vault);

        vm.startPrank(builder);
        skills.allowSkill(v, SKILL_A, "ipfs://a");
        skills.allowSkill(v, SKILL_B, "ipfs://b");
        skills.allowSkill(v, SKILL_C, "ipfs://c");
        vm.stopPrank();

        bytes32[] memory hs = skills.skillHashes(v);
        assertEq(hs.length, 3, "three skills enumerated");

        // Revoke the middle one; swap-and-pop must keep the set intact (2 left).
        vm.prank(builder);
        skills.revokeSkill(v, SKILL_B);

        hs = skills.skillHashes(v);
        assertEq(hs.length, 2, "two skills after revoke");
        assertTrue(skills.isAllowedSkill(v, SKILL_A));
        assertTrue(skills.isAllowedSkill(v, SKILL_C));
        assertFalse(skills.isAllowedSkill(v, SKILL_B));

        // Surviving hashes are exactly A and C, in some order.
        bool sawA;
        bool sawC;
        for (uint256 i = 0; i < hs.length; i++) {
            if (hs[i] == SKILL_A) sawA = true;
            if (hs[i] == SKILL_C) sawC = true;
        }
        assertTrue(sawA && sawC, "A and C survive");
    }

    function test_ReallowIsIdempotent() public {
        address v = address(vault);
        vm.startPrank(builder);
        skills.allowSkill(v, SKILL_A, "ipfs://a");
        skills.allowSkill(v, SKILL_A, "ipfs://a-v2"); // refresh uri, no duplicate
        vm.stopPrank();

        bytes32[] memory hs = skills.skillHashes(v);
        assertEq(hs.length, 1, "no duplicate entry on re-allow");
        assertTrue(skills.isAllowedSkill(v, SKILL_A));
    }

    // --- authority reverts --------------------------------------------------

    function test_NonBuilderAllowReverts() public {
        address v = address(vault);
        vm.expectRevert(
            abi.encodeWithSelector(SkillRegistry.NotBuilder.selector, stranger, v)
        );
        vm.prank(stranger);
        skills.allowSkill(v, SKILL_A, "ipfs://a");
    }

    function test_RevokeNonExistentReverts() public {
        address v = address(vault);
        vm.expectRevert(
            abi.encodeWithSelector(SkillRegistry.SkillNotFound.selector, v, SKILL_A)
        );
        vm.prank(builder);
        skills.revokeSkill(v, SKILL_A);
    }

    // --- heartbeat ----------------------------------------------------------

    function test_OnlyTeeWalletCanHeartbeat() public {
        address v = address(vault);
        bytes32 ordersRoot = keccak256("orders");
        bytes32 navRoot = keccak256("nav");

        // Non-tee caller (even the builder) is rejected.
        vm.expectRevert(
            abi.encodeWithSelector(SkillRegistry.NotTeeWallet.selector, builder, v)
        );
        vm.prank(builder);
        skills.heartbeat(v, ordersRoot, navRoot, "");

        // The attested teeWallet succeeds and emits with block.timestamp.
        vm.warp(1_700_000_000);
        vm.expectEmit(true, false, false, true, address(skills));
        emit Heartbeat(v, ordersRoot, navRoot, block.timestamp);
        vm.prank(teeWallet);
        skills.heartbeat(v, ordersRoot, navRoot, hex"deadbeef");
    }

    function test_HeartbeatFollowsRotatedTeeWallet() public {
        address v = address(vault);
        address newTee = makeAddr("newTee");

        // Old wallet works before rotation...
        vm.prank(teeWallet);
        skills.heartbeat(v, bytes32(0), bytes32(0), "");

        // ...rotate the vault's teeWallet (mirrors image rotation)...
        vault.setTeeWallet(newTee);

        // ...old wallet is now rejected, new wallet works.
        vm.expectRevert(
            abi.encodeWithSelector(SkillRegistry.NotTeeWallet.selector, teeWallet, v)
        );
        vm.prank(teeWallet);
        skills.heartbeat(v, bytes32(0), bytes32(0), "");

        vm.prank(newTee);
        skills.heartbeat(v, bytes32(0), bytes32(0), "");
    }
}
