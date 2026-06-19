"""Strategy interface — what every agent author implements."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Iterable, Literal


Side = Literal["long", "short"]
OrderType = Literal["market", "limit"]


@dataclass(frozen=True)
class Position:
    market: str
    side: Side
    size: Decimal
    entry_price: Decimal
    unrealized_pnl: Decimal


@dataclass(frozen=True)
class MarketState:
    """A snapshot the runtime hands the strategy on each tick."""

    timestamp: int
    free_collateral: Decimal
    positions: dict[str, Position]
    mid_prices: dict[str, Decimal]
    funding_rates: dict[str, Decimal]
    open_orders: dict[str, list]


@dataclass(frozen=True)
class Order:
    market: str
    side: Side
    size: Decimal
    type: OrderType = "market"
    limit_price: Decimal | None = None
    reduce_only: bool = False
    client_id: str | None = None


class Strategy:
    """Subclass this. Override `decide`. The runtime does the rest.

    The runtime guarantees:
      * `decide` is called on a fixed cadence (default 30s, override via tick_seconds).
      * Returned orders are signed with the TEE-derived API key, submitted to
        Lighter, and reported to the vault contract for fee accrual.
      * `state.free_collateral` is the vault's total trading balance — sized
        for the whole pool, not per investor. Investors hold ERC-4626 shares.
    """

    tick_seconds: int = 30

    def name(self) -> str:
        return self.__class__.__name__

    def on_start(self) -> None:
        """Called once after attestation is bound and before the first tick."""

    def decide(self, state: MarketState) -> Iterable[Order]:
        """Return any orders you want submitted this tick."""
        return ()

    def on_fill(self, order: Order, fill_price: Decimal, fill_size: Decimal) -> None:
        """Called after each fill. Good place for your own bookkeeping."""

    def on_error(self, exc: BaseException) -> None:
        """Called if a tick raises. Default: re-raise."""
        raise exc
