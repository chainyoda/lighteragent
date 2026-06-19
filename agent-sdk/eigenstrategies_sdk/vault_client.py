"""Onchain vault client.

Calls EigenVault contract from inside the TEE. The vault contract gates
the trade-authority functions on the TEE wallet, so this is the only
place that holds the KMS-injected mnemonic.
"""

from __future__ import annotations

import os
from decimal import Decimal

from eth_account import Account
from web3 import Web3


VAULT_ABI = [
    {"name": "bridgeToLighter", "type": "function", "stateMutability": "nonpayable",
     "inputs": [{"name": "assets", "type": "uint256"}], "outputs": []},
    {"name": "bridgeFromLighter", "type": "function", "stateMutability": "nonpayable",
     "inputs": [{"name": "assets", "type": "uint256"}], "outputs": []},
    {"name": "accrueTxFee", "type": "function", "stateMutability": "nonpayable",
     "inputs": [{"name": "notional", "type": "uint256"}], "outputs": []},
    {"name": "realizePerfFee", "type": "function", "stateMutability": "nonpayable",
     "inputs": [], "outputs": [{"name": "", "type": "uint256"}]},
    {"name": "totalAssets", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"name": "", "type": "uint256"}]},
    {"name": "imageHash", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"name": "", "type": "bytes32"}]},
    {"name": "teeWallet", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"name": "", "type": "address"}]},
]

ATTESTATION_REGISTRY_ABI = [
    {"name": "bind", "type": "function", "stateMutability": "nonpayable",
     "inputs": [
         {"name": "vault", "type": "address"},
         {"name": "imageHash", "type": "bytes32"},
         {"name": "teeWallet", "type": "address"},
         {"name": "attestation", "type": "bytes"},
     ], "outputs": []},
]


class VaultClient:
    def __init__(
        self,
        rpc_url: str,
        vault_address: str,
        registry_address: str,
        private_key: str,
    ):
        self.w3 = Web3(Web3.HTTPProvider(rpc_url))
        self.account = Account.from_key(private_key)
        self.vault = self.w3.eth.contract(
            address=Web3.to_checksum_address(vault_address), abi=VAULT_ABI
        )
        self.registry = self.w3.eth.contract(
            address=Web3.to_checksum_address(registry_address),
            abi=ATTESTATION_REGISTRY_ABI,
        )

    @property
    def address(self) -> str:
        return self.account.address

    def bind_attestation(
        self, image_hash: bytes, tee_wallet: str, attestation: bytes
    ) -> str:
        return self._send(
            self.registry.functions.bind(
                self.vault.address,
                image_hash,
                Web3.to_checksum_address(tee_wallet),
                attestation,
            )
        )

    def bridge_to_lighter(self, assets_usdc: Decimal) -> str:
        return self._send(self.vault.functions.bridgeToLighter(self._u6(assets_usdc)))

    def bridge_from_lighter(self, assets_usdc: Decimal) -> str:
        return self._send(self.vault.functions.bridgeFromLighter(self._u6(assets_usdc)))

    def accrue_tx_fee(self, notional_usdc: Decimal) -> str:
        return self._send(self.vault.functions.accrueTxFee(self._u6(notional_usdc)))

    def realize_perf_fee(self) -> str:
        return self._send(self.vault.functions.realizePerfFee())

    def _send(self, fn) -> str:
        tx = fn.build_transaction(
            {
                "from": self.account.address,
                "nonce": self.w3.eth.get_transaction_count(self.account.address),
                "chainId": self.w3.eth.chain_id,
                "gas": 250_000,
                "maxFeePerGas": self.w3.eth.gas_price * 2,
                "maxPriorityFeePerGas": self.w3.to_wei(1, "gwei"),
            }
        )
        signed = self.account.sign_transaction(tx)
        h = self.w3.eth.send_raw_transaction(signed.raw_transaction)
        return h.hex()

    @staticmethod
    def _u6(amount: Decimal) -> int:
        return int(amount * Decimal(10**6))


def from_env() -> VaultClient:
    return VaultClient(
        rpc_url=os.environ["RPC_URL"],
        vault_address=os.environ["VAULT_ADDRESS"],
        registry_address=os.environ["ATTESTATION_REGISTRY"],
        private_key=os.environ["TEE_PRIVATE_KEY"],
    )
