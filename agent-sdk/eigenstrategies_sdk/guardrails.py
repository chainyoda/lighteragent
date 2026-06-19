"""Risk guardrails — enforced by the runtime, inside the TEE.

This is the layer that makes "verifiable" mean something for risk, not just
for code. The strategy's own limits (stops, sizing) live in `decide()` and are
*attested* — you can read them — but a buggy or malicious strategy could omit
them. These guardrails run in `run_agent`'s loop, between `decide()` and order
submission, so **no order the strategy emits can exceed them**. They are part
of the same attested image hash that trades, and their values come from the
vault's published parameters (EigenCompute-injected env), so investors can
verify the caps that are actually enforced.

Layering:
  * strategy `decide()`     — soft, strategy-specific logic (attested)
  * Guardrails (this file)  — hard caps, enforced in-TEE  ← you are here
  * vault contract          — custody (only the TEE wallet can move funds)
  * Lighter                 — margin / liquidation / venue max leverage
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Iterable

from .strategy import MarketState, Order


# Lighter venue maximum leverage per market (docs → contract specifications).
# A vault's own max_leverage is clamped to these regardless of configuration.
VENUE_MAX_LEVERAGE: dict[str, Decimal] = {
    "BTC-PERP": Decimal("50"),
    "ETH-PERP": Decimal("50"),
    "SOL-PERP": Decimal("25"),
}


def _denv(name: str, default: Decimal | None) -> Decimal | None:
    raw = os.environ.get(name)
    return Decimal(raw) if raw not in (None, "") else default


@dataclass
class Guardrails:
    """Hard risk limits enforced by the runtime. `None` = no limit for that rule."""

    allowed_markets: frozenset[str] | None = None     # whitelist; None = any traded market
    max_leverage: Decimal = Decimal("3")              # gross notional / account equity
    max_gross_notional: Decimal | None = None         # absolute USDC cap on total exposure
    max_notional_per_order: Decimal | None = None     # USDC cap per single order
    max_notional_per_market: Decimal | None = None    # USDC cap on any one market's exposure
    min_free_collateral: Decimal = Decimal(0)         # block new risk below this
    max_orders_per_tick: int = 20
    max_drawdown_pct: Decimal | None = None           # circuit breaker (e.g. 0.25 = 25%)
    flatten_on_halt: bool = True                      # emit reduce-only flatten when halted
    venue_max_leverage: dict[str, Decimal] = field(default_factory=lambda: dict(VENUE_MAX_LEVERAGE))

    # --- runtime state (not configuration) ---
    _peak_equity: Decimal = field(default=Decimal(0), repr=False)
    _halted: bool = field(default=False, repr=False)

    @classmethod
    def from_env(cls) -> "Guardrails":
        """Load the vault's published caps from EigenCompute-injected env.

        These values are set at vault creation and travel with the attested
        image, so the enforced limits are exactly what investors were shown.
        """
        markets = os.environ.get("GUARD_ALLOWED_MARKETS")
        return cls(
            allowed_markets=frozenset(m.strip() for m in markets.split(",")) if markets else None,
            max_leverage=_denv("GUARD_MAX_LEVERAGE", Decimal("3")),
            max_gross_notional=_denv("GUARD_MAX_GROSS_NOTIONAL", None),
            max_notional_per_order=_denv("GUARD_MAX_NOTIONAL_PER_ORDER", None),
            max_notional_per_market=_denv("GUARD_MAX_NOTIONAL_PER_MARKET", None),
            min_free_collateral=_denv("GUARD_MIN_FREE_COLLATERAL", Decimal(0)),
            max_orders_per_tick=int(os.environ.get("GUARD_MAX_ORDERS_PER_TICK", "20")),
            max_drawdown_pct=_denv("GUARD_MAX_DRAWDOWN_PCT", None),
            flatten_on_halt=os.environ.get("GUARD_FLATTEN_ON_HALT", "1") != "0",
        )

    @property
    def halted(self) -> bool:
        return self._halted

    def describe(self) -> str:
        parts = [
            f"max_leverage={self.max_leverage}x",
            f"max_gross_notional={self.max_gross_notional}",
            f"max_notional_per_order={self.max_notional_per_order}",
            f"max_notional_per_market={self.max_notional_per_market}",
            f"min_free_collateral={self.min_free_collateral}",
            f"max_drawdown_pct={self.max_drawdown_pct}",
            f"allowed_markets={sorted(self.allowed_markets) if self.allowed_markets else 'any'}",
        ]
        return "guardrails: " + ", ".join(parts)

    # ------------------------------------------------------------------ apply
    def apply(self, orders: Iterable[Order], state: MarketState, log: logging.Logger) -> list[Order]:
        """Filter/clamp the strategy's orders to satisfy every limit.

        Returns the orders that are safe to submit. Risk-reducing orders
        (reduce_only) are always allowed through. Anything that would breach a
        cap is shrunk to fit, or dropped if it can't.
        """
        orders = list(orders)
        equity = state.account_value if state.account_value > 0 else state.free_collateral

        # --- drawdown circuit breaker ---
        if equity > self._peak_equity:
            self._peak_equity = equity
        if self.max_drawdown_pct is not None and self._peak_equity > 0:
            dd = (self._peak_equity - equity) / self._peak_equity
            if dd >= self.max_drawdown_pct and not self._halted:
                self._halted = True
                log.error("GUARDRAIL halt: drawdown %.1f%% >= %.1f%% — blocking new risk",
                          dd * 100, self.max_drawdown_pct * 100)

        if self._halted:
            return self._halt_orders(orders, state, log)

        # current exposure from open positions
        per_market = self._market_notionals(state)
        gross = sum(per_market.values(), Decimal(0))

        out: list[Order] = []
        for order in orders:
            if len(out) >= self.max_orders_per_tick:
                log.warning("GUARDRAIL: max_orders_per_tick=%d reached, dropping rest", self.max_orders_per_tick)
                break

            # reduce-only orders only ever lower risk: always allow
            if order.reduce_only:
                out.append(order)
                continue

            kept = self._check_increasing(order, state, per_market, gross, equity, log)
            if kept is None:
                continue
            out.append(kept)
            notional = self._notional(kept, state)
            per_market[kept.market] = per_market.get(kept.market, Decimal(0)) + notional
            gross += notional

        return out

    # --------------------------------------------------------------- internals
    def _check_increasing(self, order, state, per_market, gross, equity, log) -> Order | None:
        m = order.market
        price = state.mid_prices.get(m)
        if price is None or price <= 0:
            log.warning("GUARDRAIL drop %s: no mid price to size-check", m)
            return None
        if self.allowed_markets is not None and m not in self.allowed_markets:
            log.warning("GUARDRAIL drop %s: not in allowed_markets", m)
            return None
        if state.free_collateral < self.min_free_collateral:
            log.warning("GUARDRAIL drop %s: free_collateral %s < min %s", m, state.free_collateral, self.min_free_collateral)
            return None
        if equity <= 0:
            log.warning("GUARDRAIL drop %s: non-positive equity", m)
            return None

        size = order.size
        if size <= 0:
            return None

        # collect the tightest notional cap that applies to this order
        cap = self._notional_cap(m, per_market.get(m, Decimal(0)), gross, equity)
        if cap is not None:
            max_size = cap / price
            if max_size <= 0:
                log.warning("GUARDRAIL drop %s: caps leave no room", m)
                return None
            if size > max_size:
                log.warning("GUARDRAIL clamp %s: size %s -> %s (notional cap)", m, size, max_size)
                size = max_size

        if size != order.size:
            return _resize(order, size)
        return order

    def _notional_cap(self, market, market_notional, gross, equity) -> Decimal | None:
        """Smallest *added* notional allowed for an order on `market`."""
        caps: list[Decimal] = []
        if self.max_notional_per_order is not None:
            caps.append(self.max_notional_per_order)
        if self.max_notional_per_market is not None:
            caps.append(max(Decimal(0), self.max_notional_per_market - market_notional))
        if self.max_gross_notional is not None:
            caps.append(max(Decimal(0), self.max_gross_notional - gross))
        # leverage caps (vault config + venue), both relative to equity
        lev = self.max_leverage
        venue = self.venue_max_leverage.get(market)
        if venue is not None:
            lev = min(lev, venue)
        caps.append(max(Decimal(0), lev * equity - gross))
        return min(caps) if caps else None

    def _halt_orders(self, orders, state, log) -> list[Order]:
        """While halted: allow only reduce-only orders, and (optionally) flatten."""
        out = [o for o in orders if o.reduce_only]
        if self.flatten_on_halt:
            for m, pos in state.positions.items():
                out.append(Order(
                    market=m,
                    side="short" if pos.side == "long" else "long",
                    size=pos.size,
                    reduce_only=True,
                    client_id=f"guard-flatten-{m}",
                ))
        if out:
            log.info("GUARDRAIL halted: passing %d reduce-only/flatten orders", len(out))
        return out

    def _market_notionals(self, state: MarketState) -> dict[str, Decimal]:
        out: dict[str, Decimal] = {}
        for m, pos in state.positions.items():
            price = state.mid_prices.get(m, pos.entry_price)
            out[m] = pos.size * price
        return out

    def _notional(self, order: Order, state: MarketState) -> Decimal:
        price = state.mid_prices.get(order.market, Decimal(0))
        return order.size * price


def _resize(order: Order, size: Decimal) -> Order:
    from dataclasses import replace
    return replace(order, size=size)
