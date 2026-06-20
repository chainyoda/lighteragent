"""Thin web3 client for the on-chain SkillRegistry.

Mirrors ``eigenstrategies_sdk.vault_client.VaultClient`` in style: a small web3
contract wrapper that reads ``SKILL_REGISTRY`` + ``RPC_URL`` + ``TEE_PRIVATE_KEY``
from the EigenCompute-injected env. It exposes exactly the registry surface the
Shell needs:

  * ``is_allowed_skill(vault, skill_hash) -> bool``   (view; gates skill loading)
  * ``skill_hashes(vault) -> list[bytes32]``          (view; enumerate registered)
  * ``heartbeat(vault, ordersRoot, navRoot, attestation)`` (tx; attestation post)

The ABI below matches the SkillRegistry a sibling agent is writing EXACTLY:

    allowSkill(address vault, bytes32 skillHash, string uri)
    revokeSkill(address vault, bytes32 skillHash)
    isAllowedSkill(address vault, bytes32 skillHash) view returns (bool)
    skillHashes(address vault) view returns (bytes32[])
    heartbeat(address vault, bytes32 ordersRoot, bytes32 navRoot, bytes attestation)
    events: SkillAllowed(vault, skillHash, uri)
            SkillRevoked(vault, skillHash)
            Heartbeat(vault, ordersRoot, navRoot, timestamp)

``allowSkill`` / ``revokeSkill`` are *builder-side* operations (the deployer
registers skill hashes from outside the TEE); they are included in the ABI for
completeness but the Shell only ever calls the view fns + ``heartbeat``. The
heartbeat tx is signed with the TEE key (same key as ``VaultClient``), so the
on-chain ``Heartbeat`` event is attributable to the attested TEE wallet.
"""

from __future__ import annotations

import os

from eth_account import Account
from web3 import Web3


SKILL_REGISTRY_ABI = [
    {"name": "allowSkill", "type": "function", "stateMutability": "nonpayable",
     "inputs": [
         {"name": "vault", "type": "address"},
         {"name": "skillHash", "type": "bytes32"},
         {"name": "uri", "type": "string"},
     ], "outputs": []},
    {"name": "revokeSkill", "type": "function", "stateMutability": "nonpayable",
     "inputs": [
         {"name": "vault", "type": "address"},
         {"name": "skillHash", "type": "bytes32"},
     ], "outputs": []},
    {"name": "isAllowedSkill", "type": "function", "stateMutability": "view",
     "inputs": [
         {"name": "vault", "type": "address"},
         {"name": "skillHash", "type": "bytes32"},
     ], "outputs": [{"name": "", "type": "bool"}]},
    {"name": "skillHashes", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "vault", "type": "address"}],
     "outputs": [{"name": "", "type": "bytes32[]"}]},
    {"name": "heartbeat", "type": "function", "stateMutability": "nonpayable",
     "inputs": [
         {"name": "vault", "type": "address"},
         {"name": "ordersRoot", "type": "bytes32"},
         {"name": "navRoot", "type": "bytes32"},
         {"name": "attestation", "type": "bytes"},
     ], "outputs": []},
    # Events (declared so callers can decode logs if they want to).
    {"name": "SkillAllowed", "type": "event", "anonymous": False, "inputs": [
        {"name": "vault", "type": "address", "indexed": True},
        {"name": "skillHash", "type": "bytes32", "indexed": True},
        {"name": "uri", "type": "string", "indexed": False},
    ]},
    {"name": "SkillRevoked", "type": "event", "anonymous": False, "inputs": [
        {"name": "vault", "type": "address", "indexed": True},
        {"name": "skillHash", "type": "bytes32", "indexed": True},
    ]},
    {"name": "Heartbeat", "type": "event", "anonymous": False, "inputs": [
        {"name": "vault", "type": "address", "indexed": True},
        {"name": "ordersRoot", "type": "bytes32", "indexed": False},
        {"name": "navRoot", "type": "bytes32", "indexed": False},
        {"name": "timestamp", "type": "uint256", "indexed": False},
    ]},
]


def _to_bytes32(value: bytes | str) -> bytes:
    """Coerce a 0x-hex string or raw bytes to a 32-byte value for web3."""
    if isinstance(value, bytes):
        b = value
    else:
        b = bytes.fromhex(value.removeprefix("0x"))
    if len(b) != 32:
        raise ValueError(f"expected 32 bytes for bytes32, got {len(b)}")
    return b


class SkillRegistryClient:
    """web3 client for the SkillRegistry contract.

    The view methods (``is_allowed_skill``, ``skill_hashes``) need no key, but we
    construct with the TEE key (like ``VaultClient``) because ``heartbeat`` is a
    signed tx from the attested TEE wallet.
    """

    def __init__(self, rpc_url: str, registry_address: str, private_key: str):
        self.w3 = Web3(Web3.HTTPProvider(rpc_url))
        self.account = Account.from_key(private_key)
        self.registry = self.w3.eth.contract(
            address=Web3.to_checksum_address(registry_address),
            abi=SKILL_REGISTRY_ABI,
        )

    @property
    def address(self) -> str:
        return self.account.address

    # ---- views (gate skill loading) ----------------------------------------
    def is_allowed_skill(self, vault: str, skill_hash: bytes | str) -> bool:
        return bool(
            self.registry.functions.isAllowedSkill(
                Web3.to_checksum_address(vault), _to_bytes32(skill_hash)
            ).call()
        )

    def skill_hashes(self, vault: str) -> list[bytes]:
        return list(
            self.registry.functions.skillHashes(
                Web3.to_checksum_address(vault)
            ).call()
        )

    # ---- heartbeat (signed tx) ---------------------------------------------
    def heartbeat(
        self,
        vault: str,
        orders_root: bytes | str,
        nav_root: bytes | str,
        attestation: bytes,
    ) -> str:
        return self._send(
            self.registry.functions.heartbeat(
                Web3.to_checksum_address(vault),
                _to_bytes32(orders_root),
                _to_bytes32(nav_root),
                attestation,
            )
        )

    def _send(self, fn) -> str:
        tx = fn.build_transaction(
            {
                "from": self.account.address,
                "nonce": self.w3.eth.get_transaction_count(self.account.address),
                "chainId": self.w3.eth.chain_id,
                "gas": 300_000,
                "maxFeePerGas": self.w3.eth.gas_price * 2,
                "maxPriorityFeePerGas": self.w3.to_wei(1, "gwei"),
            }
        )
        signed = self.account.sign_transaction(tx)
        h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        return h.hex()


def from_env() -> SkillRegistryClient:
    """Build a client from EigenCompute-injected env.

    Reads ``SKILL_REGISTRY`` + ``RPC_URL`` + ``TEE_PRIVATE_KEY`` — the same RPC
    and TEE key the ``VaultClient`` uses, plus the new registry address.
    """
    return SkillRegistryClient(
        rpc_url=os.environ["RPC_URL"],
        registry_address=os.environ["SKILL_REGISTRY"],
        private_key=os.environ["TEE_PRIVATE_KEY"],
    )
