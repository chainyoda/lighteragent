"""Lighter API client.

Thin wrapper over the official lighter-v2-python SDK. Handles the bits
the strategy author shouldn't have to think about: API-key signing,
sub-account scoping, NAV computation, and fill polling.

Set USE_TESTNET=1 for testnet routing, otherwise mainnet.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

import httpx

from .strategy import MarketState, Order, Position


MAINNET_BASE = "https://mainnet.zklighter.elliot.ai"
TESTNET_BASE = "https://testnet.zklighter.elliot.ai"


@dataclass
class LighterConfig:
    api_key_private_key: str
    account_index: int
    sub_account_index: int = 0
    base_url: str = MAINNET_BASE


class LighterClient:
    """Read state, place orders, withdraw collateral. One instance per vault.

    The TEE wallet is the L1 owner of `account_index`; the API key registered
    against it is what signs every order. Do not log the API key.
    """

    def __init__(self, cfg: LighterConfig):
        self.cfg = cfg
        self._http = httpx.AsyncClient(base_url=cfg.base_url, timeout=10.0)
        self._signer = None  # Lazily import to keep the SDK importable without lighter_v2

    async def _get_signer(self):
        if self._signer is None:
            from lighter import SignerClient  # type: ignore

            self._signer = SignerClient(
                url=self.cfg.base_url,
                private_key=self.cfg.api_key_private_key,
                account_index=self.cfg.account_index,
                api_key_index=self.cfg.sub_account_index,
            )
        return self._signer

    async def fetch_state(self, markets: list[str]) -> MarketState:
        positions, mids, fundings = await asyncio.gather(
            self._positions(),
            self._mid_prices(markets),
            self._funding_rates(markets),
        )
        free = await self._free_collateral()
        return MarketState(
            timestamp=int(asyncio.get_event_loop().time()),
            free_collateral=free,
            positions=positions,
            mid_prices=mids,
            funding_rates=fundings,
            open_orders={},
        )

    async def submit(self, order: Order) -> dict[str, Any]:
        signer = await self._get_signer()
        side_is_ask = order.side == "short"
        size_int = int(order.size * Decimal(10**6))
        if order.type == "market":
            tx = await signer.create_market_order(
                market_index=self._market_index(order.market),
                client_order_index=hash(order.client_id) & 0xFFFFFFFF if order.client_id else 0,
                base_amount=size_int,
                avg_execution_price=0,
                is_ask=side_is_ask,
                reduce_only=order.reduce_only,
            )
        else:
            assert order.limit_price is not None, "limit order needs limit_price"
            price_int = int(order.limit_price * Decimal(10**6))
            tx = await signer.create_order(
                market_index=self._market_index(order.market),
                client_order_index=hash(order.client_id) & 0xFFFFFFFF if order.client_id else 0,
                base_amount=size_int,
                price=price_int,
                is_ask=side_is_ask,
                reduce_only=order.reduce_only,
            )
        return tx

    async def _positions(self) -> dict[str, Position]:
        r = await self._http.get(
            "/api/v1/account",
            params={"by": "index", "value": self.cfg.account_index},
        )
        r.raise_for_status()
        body = r.json()
        out: dict[str, Position] = {}
        for p in body.get("accounts", [{}])[0].get("positions", []):
            symbol = p["symbol"]
            size = Decimal(p["position"])
            if size == 0:
                continue
            out[symbol] = Position(
                market=symbol,
                side="long" if size > 0 else "short",
                size=abs(size),
                entry_price=Decimal(p["avg_entry_price"]),
                unrealized_pnl=Decimal(p.get("unrealized_pnl", 0)),
            )
        return out

    async def _free_collateral(self) -> Decimal:
        r = await self._http.get(
            "/api/v1/account",
            params={"by": "index", "value": self.cfg.account_index},
        )
        r.raise_for_status()
        body = r.json()
        acct = body.get("accounts", [{}])[0]
        return Decimal(acct.get("collateral", 0)) - Decimal(acct.get("position_margin", 0))

    async def _mid_prices(self, markets: list[str]) -> dict[str, Decimal]:
        r = await self._http.get("/api/v1/orderBookDetails")
        r.raise_for_status()
        out: dict[str, Decimal] = {}
        for m in r.json().get("order_book_details", []):
            if m["symbol"] in markets:
                bid = Decimal(m.get("best_bid", 0))
                ask = Decimal(m.get("best_ask", 0))
                if bid and ask:
                    out[m["symbol"]] = (bid + ask) / 2
        return out

    async def _funding_rates(self, markets: list[str]) -> dict[str, Decimal]:
        r = await self._http.get("/api/v1/funding-rates")
        r.raise_for_status()
        out: dict[str, Decimal] = {}
        for m in r.json().get("funding_rates", []):
            if m["symbol"] in markets:
                out[m["symbol"]] = Decimal(m["funding_rate"])
        return out

    def _market_index(self, symbol: str) -> int:
        # Static map for the few markets v1 supports. For a complete impl,
        # cache the response from /api/v1/orderBookDetails on startup.
        return {
            "BTC-PERP": 0, "ETH-PERP": 1, "SOL-PERP": 2,
            "ARB-PERP": 3, "OP-PERP": 4, "AVAX-PERP": 5,
        }.get(symbol, 0)

    async def close(self) -> None:
        await self._http.aclose()


def from_env() -> LighterClient:
    """Build a client from EigenCompute-injected env."""
    return LighterClient(
        LighterConfig(
            api_key_private_key=os.environ["LIGHTER_API_KEY"],
            account_index=int(os.environ["LIGHTER_ACCOUNT_INDEX"]),
            sub_account_index=int(os.environ.get("LIGHTER_SUBACCOUNT_INDEX", 0)),
            base_url=TESTNET_BASE if os.environ.get("USE_TESTNET") == "1" else MAINNET_BASE,
        )
    )
