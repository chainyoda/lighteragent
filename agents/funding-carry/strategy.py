"""Funding-rate carry agent.

Pairs a long perp with a short perp on the same asset basket whenever the
two markets' funding rates diverge enough to cover round-trip fees plus a
margin. Closes when the spread compresses or hits a stop.

This is intentionally simple — it's a reference implementation, not
investment advice. Real strategies should add per-market sizing limits,
correlation guards, and a model for funding-payout cadence.
"""

from __future__ import annotations

import logging
from decimal import Decimal
from itertools import combinations
from typing import Iterable

from eigenstrategies_sdk import MarketState, Order, Strategy, run_agent


log = logging.getLogger("funding-carry")

MARKETS = ["BTC-PERP", "ETH-PERP", "SOL-PERP"]
ENTRY_SPREAD_BPS = Decimal("12")        # open if |Δfunding| ≥ 12 bps / 8h
EXIT_SPREAD_BPS = Decimal("4")          # close if |Δfunding| ≤ 4 bps
MAX_NOTIONAL_PER_PAIR = Decimal("5000")
MIN_FREE_COLLATERAL = Decimal("500")
LEVERAGE = Decimal("1")


class FundingCarry(Strategy):
    tick_seconds = 60

    def decide(self, state: MarketState) -> Iterable[Order]:
        funding = {m: state.funding_rates.get(m, Decimal(0)) for m in MARKETS if m in state.mid_prices}
        if len(funding) < 2 or state.free_collateral < MIN_FREE_COLLATERAL:
            return

        best_pair, best_spread = None, Decimal(0)
        for a, b in combinations(funding, 2):
            spread = funding[a] - funding[b]
            if abs(spread) > abs(best_spread):
                best_pair, best_spread = (a, b), spread

        if best_pair is None:
            return

        a, b = best_pair
        spread_bps = abs(best_spread) * Decimal(10_000)
        long_market, short_market = (b, a) if best_spread > 0 else (a, b)

        already_paired = long_market in state.positions and short_market in state.positions
        if already_paired:
            if spread_bps <= EXIT_SPREAD_BPS:
                log.info("closing pair %s/%s (spread %.1f bps)", long_market, short_market, spread_bps)
                yield from _flatten(state, long_market, short_market)
            return

        if spread_bps < ENTRY_SPREAD_BPS:
            return

        notional = min(MAX_NOTIONAL_PER_PAIR, state.free_collateral * LEVERAGE / 2)
        long_size = (notional / state.mid_prices[long_market]).quantize(Decimal("0.0001"))
        short_size = (notional / state.mid_prices[short_market]).quantize(Decimal("0.0001"))

        if long_size <= 0 or short_size <= 0:
            return

        log.info(
            "opening pair long=%s short=%s spread=%.1f bps notional=%s",
            long_market, short_market, spread_bps, notional,
        )
        yield Order(market=long_market, side="long", size=long_size, client_id=f"carry-l-{state.timestamp}")
        yield Order(market=short_market, side="short", size=short_size, client_id=f"carry-s-{state.timestamp}")


def _flatten(state: MarketState, *markets: str) -> Iterable[Order]:
    for m in markets:
        pos = state.positions.get(m)
        if not pos:
            continue
        yield Order(
            market=m,
            side="short" if pos.side == "long" else "long",
            size=pos.size,
            reduce_only=True,
        )


if __name__ == "__main__":
    run_agent(FundingCarry(), markets=MARKETS)
