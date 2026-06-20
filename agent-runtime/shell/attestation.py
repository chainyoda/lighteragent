"""Attestation producer — per-order + heartbeat.

This is the Shell's responsibility #4. Two kinds of attestation:

  * **Per-order**: ``attest_order(order, fill)`` signs a canonical hash of the
    (order, fill) tuple with the TEE key. The signature is attributable to the
    attested TEE wallet (the same key that signs vault txs), so a verifier who
    knows the on-chain-pinned ``teeWallet = f(imageHash)`` can confirm the order
    was emitted by the measured Shell — not by something impersonating it.

  * **Heartbeat**: ``heartbeat(orders, nav)`` builds a simple Merkle/sequence
    root over the period's per-order attestations (``ordersRoot``) plus a
    ``navRoot`` committing to the period's NAV, signs the pair, and posts
    ``SkillRegistry.heartbeat(vault, ordersRoot, navRoot, attestation)`` on-chain.
    This gives investors a periodic, tamper-evident commitment to what the Shell
    did and what the vault was worth, even between per-order events.

Crypto is intentionally minimal: stdlib ``hashlib`` for hashing/Merkle, and
``eth_account`` (already an SDK dependency) for signing with the TEE key. No new
heavy dependencies. The hashing scheme is documented inline so a verifier can
reproduce the roots from the published per-order attestations.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from dataclasses import dataclass
from decimal import Decimal

from eth_account import Account
from eth_account.messages import encode_defunct

from eigenstrategies_sdk import Order

from .order_gateway import Fill
from .skill_registry_client import SkillRegistryClient


log = logging.getLogger("shell.attestation")


def _canonical_json(obj: dict) -> bytes:
    """Deterministic JSON encoding for hashing (sorted keys, no spaces)."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


def _merkle_root(leaves: list[bytes]) -> bytes:
    """A simple binary Merkle root over 32-byte leaves.

    Empty -> 32 zero bytes. Odd levels duplicate the last node (standard).
    Documented so a verifier can recompute the root from the published leaves.
    """
    if not leaves:
        return b"\x00" * 32
    level = list(leaves)
    while len(level) > 1:
        if len(level) % 2 == 1:
            level.append(level[-1])
        level = [_sha256(level[i] + level[i + 1]) for i in range(0, len(level), 2)]
    return level[0]


@dataclass(frozen=True)
class OrderAttestation:
    """A signed per-order attestation.

    ``order_hash`` is the 32-byte sha256 of the canonical (order, fill) payload;
    ``signature`` is the TEE wallet's signature over it. ``leaf`` (== order_hash)
    is what gets accumulated into the heartbeat's ordersRoot.
    """

    order_hash: bytes
    signature: str
    signer: str
    payload: dict

    @property
    def order_hash_hex(self) -> str:
        return "0x" + self.order_hash.hex()

    @property
    def leaf(self) -> bytes:
        return self.order_hash


class AttestationProducer:
    """Produces per-order and heartbeat attestations from inside the TEE.

    ``tee_account`` is an ``eth_account`` Account (the TEE wallet) used to sign.
    ``skill_registry_client`` posts heartbeats on-chain. ``vault_address`` is the
    vault these attestations are for.
    """

    def __init__(
        self,
        tee_account: Account,
        skill_registry_client: SkillRegistryClient,
        vault_address: str,
    ):
        self._account = tee_account
        self._registry = skill_registry_client
        self._vault = vault_address

    @property
    def signer(self) -> str:
        return self._account.address

    # ---- per-order ----------------------------------------------------------
    def attest_order(self, order: Order, fill: Fill) -> OrderAttestation:
        """Sign a canonical hash of the (order, fill) tuple with the TEE key.

        The payload commits to the order's economic content and the realized
        fill so the attestation is meaningful (not just "an order existed").
        """
        payload = {
            "kind": "order",
            "vault": self._vault,
            "market": order.market,
            "side": order.side,
            "size": str(order.size),
            "type": order.type,
            "reduce_only": order.reduce_only,
            "client_id": order.client_id,
            "fill_price": (str(fill.fill_price) if fill.fill_price is not None else None),
            "fill_size": (str(fill.fill_size) if fill.fill_size is not None else None),
            "ts": int(time.time()),
        }
        order_hash = _sha256(_canonical_json(payload))
        signed = self._account.sign_message(encode_defunct(order_hash))
        sig = signed.signature.hex()
        if not sig.startswith("0x"):
            sig = "0x" + sig
        log.info(
            "attest order %s %s %s hash=0x%s",
            order.side, order.size, order.market, order_hash.hex(),
        )
        return OrderAttestation(
            order_hash=order_hash,
            signature=sig,
            signer=self._account.address,
            payload=payload,
        )

    # ---- heartbeat ----------------------------------------------------------
    def build_orders_root(self, attestations: list[OrderAttestation]) -> bytes:
        """Merkle/seq root over the period's per-order attestation leaves."""
        return _merkle_root([a.leaf for a in attestations])

    def build_nav_root(self, nav: Decimal, *, period_index: int | None = None) -> bytes:
        """Commit to the period's NAV (and optional period index) as a leaf hash.

        A single-leaf commitment is sufficient here; structured as a hash so the
        on-chain ``navRoot`` is opaque/bytes32 and a verifier reproduces it from
        the published NAV.
        """
        payload = {"kind": "nav", "vault": self._vault, "nav": str(nav), "period": period_index}
        return _sha256(_canonical_json(payload))

    def heartbeat(
        self,
        orders: list[OrderAttestation],
        nav: Decimal,
        *,
        period_index: int | None = None,
    ) -> str:
        """Build roots, sign them, and post on-chain. Returns the tx hash.

        On-chain call: ``SkillRegistry.heartbeat(vault, ordersRoot, navRoot,
        attestation)``. The ``attestation`` bytes are the TEE signature over
        ``sha256(ordersRoot || navRoot)``, so the on-chain ``Heartbeat`` event is
        bound to the attested TEE wallet.
        """
        orders_root = self.build_orders_root(orders)
        nav_root = self.build_nav_root(nav, period_index=period_index)

        commitment = _sha256(orders_root + nav_root)
        signed = self._account.sign_message(encode_defunct(commitment))
        attestation_bytes = signed.signature

        log.info(
            "heartbeat: orders=%d ordersRoot=0x%s navRoot=0x%s nav=%s",
            len(orders), orders_root.hex(), nav_root.hex(), nav,
        )
        return self._registry.heartbeat(
            vault=self._vault,
            orders_root=orders_root,
            nav_root=nav_root,
            attestation=attestation_bytes,
        )


def from_env(skill_registry_client: SkillRegistryClient) -> AttestationProducer:
    """Build a producer from the unchanged identity env contract.

    Derives the TEE account from ``TEE_PRIVATE_KEY`` (same key as ``VaultClient``)
    and reads ``VAULT_ADDRESS``; takes the already-built registry client.
    """
    import os

    return AttestationProducer(
        tee_account=Account.from_key(os.environ["TEE_PRIVATE_KEY"]),
        skill_registry_client=skill_registry_client,
        vault_address=os.environ["VAULT_ADDRESS"],
    )
