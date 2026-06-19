"""EigenStrategies agent SDK.

Build a trading agent by subclassing Strategy and calling run_agent().
Everything else (TEE attestation, vault accrual, Lighter signing,
NAV updates) is handled by the runtime.
"""

from .strategy import Strategy, MarketState, Order, Position
from .runtime import run_agent
from .guardrails import Guardrails
from .lighter_client import LighterClient
from .vault_client import VaultClient

__all__ = [
    "Strategy",
    "MarketState",
    "Order",
    "Position",
    "Guardrails",
    "LighterClient",
    "VaultClient",
    "run_agent",
]
