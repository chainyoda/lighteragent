"""Lighter order gateway — the ONLY path to the exchange.

This is the Shell's responsibility #2, and it embodies responsibilities #1 and
#5 at the point of execution:

  * It is the *sole* holder of the ``LighterClient`` (the Agent never sees it).
  * Every intent the Agent proposes is run through the **policy engine**
    (``eigenstrategies_sdk.guardrails.Guardrails.apply``) before it can touch the
    exchange — asset/leverage/concentration/drawdown limits enforced in-TEE.
  * Survivors are submitted via the Lighter client; each resulting fill accrues a
    tx fee through the **vault accounting** client (``VaultClient.accrue_tx_fee``).

This deliberately mirrors the existing ``eigenstrategies_sdk.runtime._run`` loop
body (decide -> guardrails.apply -> submit -> accrue -> on_fill) so the Shell's
execution semantics are identical to the legacy simple path; the only difference
is *who proposes* (a hash-verified Agent instead of a Strategy) and that each
fill is additionally attested by the Shell's ``AttestationProducer``.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from decimal import Decimal

from eigenstrategies_sdk import Guardrails, LighterClient, MarketState, Order, VaultClient


log = logging.getLogger("shell.order_gateway")


@dataclass(frozen=True)
class Fill:
    """The result of submitting one order through the gateway.

    ``raw`` is the venue's response dict (from ``LighterClient.submit``).
    ``fill_price`` / ``fill_size`` are populated when the venue reported an
    average fill price; ``None`` price means submitted-but-not-(yet)-filled.
    """

    order: Order
    raw: dict
    fill_price: Decimal | None = None
    fill_size: Decimal | None = None

    @property
    def filled(self) -> bool:
        return self.fill_price is not None


class OrderGateway:
    """The sole conduit between the Agent's intents and Lighter.

    Construct with the three SDK clients/engines (use ``from_env`` to wire them
    from the unchanged env contract). The Agent has NO handle to ``lighter`` —
    only the Shell holds this gateway, and only the gateway holds the client.
    """

    def __init__(
        self,
        lighter_client: LighterClient,
        vault_client: VaultClient,
        guardrails: Guardrails,
    ):
        # Private attribute names underscore the intent: nothing outside the
        # gateway should reach the exchange client.
        self._lighter = lighter_client
        self._vault = vault_client
        self._guard = guardrails

    @property
    def guardrails(self) -> Guardrails:
        return self._guard

    async def fetch_state(self, markets: list[str]) -> MarketState:
        """Read the market snapshot the Agent reasons over. Gateway-mediated so
        the Agent never speaks to Lighter directly, even for reads."""
        return await self._lighter.fetch_state(markets)

    async def submit_all(self, intents: list[Order], state: MarketState) -> list[Fill]:
        """Policy-check intents, submit survivors, accrue fees. Returns fills.

        Steps (identical ordering to the SDK runtime loop):
          1. ``guardrails.apply(intents, state)`` — the policy engine filters and
             clamps; reduce-only/flatten always pass, anything over a cap is
             shrunk or dropped, drawdown halts new risk.
          2. submit each survivor via the Lighter client (the only egress to the
             venue).
          3. on each reported fill, accrue the tx fee on the notional via the
             vault client, and report the fill.
        """
        approved = self._guard.apply(intents, state, log)
        if len(approved) != len(intents):
            log.info("policy engine: %d intent(s) -> %d approved order(s)", len(intents), len(approved))

        fills: list[Fill] = []
        for order in approved:
            log.info("gateway submit %s %s %s", order.side, order.size, order.market)
            result = await self._lighter.submit(order)
            result = result or {}

            price = result.get("avg_fill_price")
            if price is not None:
                fill_price = Decimal(str(price))
                notional = fill_price * order.size
                try:
                    self._vault.accrue_tx_fee(notional)
                except Exception as e:  # accrual failure must not lose the fill record
                    log.error("accrue_tx_fee failed: %s", e)
                fills.append(Fill(order=order, raw=result, fill_price=fill_price, fill_size=order.size))
            else:
                # Submitted but no average fill price reported this tick.
                fills.append(Fill(order=order, raw=result))

        return fills

    async def close(self) -> None:
        await self._lighter.close()


def from_env(guardrails: Guardrails | None = None) -> OrderGateway:
    """Build a gateway from the unchanged SDK env contract.

    Reuses the SDK's own ``from_env`` constructors for the Lighter and vault
    clients, so this introduces no new env vars on the execution path. If
    ``guardrails`` is not supplied, falls back to ``Guardrails.from_env()`` (the
    vault's published caps), exactly like the SDK runtime.
    """
    from eigenstrategies_sdk.lighter_client import from_env as lighter_from_env
    from eigenstrategies_sdk.vault_client import from_env as vault_from_env

    return OrderGateway(
        lighter_client=lighter_from_env(),
        vault_client=vault_from_env(),
        guardrails=guardrails or Guardrails.from_env(),
    )
