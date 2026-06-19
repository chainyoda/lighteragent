"""Agent runtime.

The single function `run_agent(strategy)` is the entrypoint. It:

  1. Reads attestation + KMS env from EigenCompute (MNEMONIC, IMAGE_HASH).
  2. Derives the TEE wallet, posts attestation to the registry once.
  3. Connects to Lighter using the API key the builder pre-registered.
  4. Loops: fetch state → strategy.decide() → submit orders →
     accrueTxFee on each fill.

Strategy authors only ever see the strategy.py types. Everything else
runs here.
"""

from __future__ import annotations

import asyncio
import logging
import os
import signal
from decimal import Decimal
from pathlib import Path

from eth_account import Account

from .lighter_client import LighterClient, from_env as lighter_from_env
from .strategy import Strategy
from .vault_client import VaultClient, from_env as vault_from_env


log = logging.getLogger("eigenstrategies.runtime")


async def _run(strategy: Strategy, markets: list[str]) -> None:
    lighter = lighter_from_env()
    vault = vault_from_env()

    log.info("agent starting: tee_wallet=%s vault=%s", vault.address, os.environ.get("VAULT_ADDRESS"))

    if attestation_path := os.environ.get("ATTESTATION_TOKEN_PATH"):
        token = Path(attestation_path).read_bytes()
        image_hash = bytes.fromhex(os.environ["IMAGE_HASH"].removeprefix("0x"))
        try:
            tx = vault.bind_attestation(image_hash, vault.address, token)
            log.info("attestation bound: tx=%s", tx)
        except Exception as e:
            log.warning("attestation bind failed (may already be bound): %s", e)

    strategy.on_start()

    stopping = asyncio.Event()
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stopping.set)

    try:
        while not stopping.is_set():
            try:
                state = await lighter.fetch_state(markets)
                orders = list(strategy.decide(state))
                for order in orders:
                    log.info("submit %s %s %s", order.side, order.size, order.market)
                    result = await lighter.submit(order)
                    if result and (price := result.get("avg_fill_price")):
                        notional = Decimal(price) * order.size
                        try:
                            vault.accrue_tx_fee(notional)
                        except Exception as e:
                            log.error("accrue_tx_fee failed: %s", e)
                        strategy.on_fill(order, Decimal(price), order.size)
            except Exception as exc:
                strategy.on_error(exc)

            try:
                await asyncio.wait_for(stopping.wait(), timeout=strategy.tick_seconds)
            except asyncio.TimeoutError:
                pass
    finally:
        await lighter.close()
        log.info("agent stopped")


def run_agent(strategy: Strategy, markets: list[str]) -> None:
    """Blocking entrypoint. Call this from your agent's __main__."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    asyncio.run(_run(strategy, markets))
