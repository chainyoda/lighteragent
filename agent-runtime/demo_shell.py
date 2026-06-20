"""End-to-end demo of the NemoClaw Shell-wraps-Agent execution loop.

Run from the repo root:
    pip install ./agent-sdk
    PYTHONPATH=agent-runtime:agent-sdk python3 agent-runtime/demo_shell.py

Drives the REAL shell modules (agent, skill_loader, order_gateway, attestation)
with in-memory fakes for the exchange / vault / on-chain registry, so the whole
'agent proposes -> shell disposes' path runs without a live TEE or chain.
"""
import asyncio
import logging
from decimal import Decimal

from eigenstrategies_sdk import Guardrails, MarketState
from eigenstrategies_sdk.strategy import Order
from eth_account import Account

from shell.agent import ReferenceAgent, Skill
from shell.skill_loader import load_and_verify_skills, SkillLoadError
from shell.order_gateway import OrderGateway
from shell.attestation import AttestationProducer

logging.basicConfig(level=logging.INFO, format="    %(name)-22s %(message)s")
VAULT = "0x38b387e3bc04978cd27aeaa0ebffd7ad4b07003c"


def banner(t): print(f"\n\033[1;36m== {t}\033[0m")


class FakeRegistry:
    """Stands in for the on-chain SkillRegistry."""
    def __init__(self, allowed): self.allowed = set(allowed)
    def is_allowed_skill(self, vault, h): return h in self.allowed
    def heartbeat(self, vault, orders_root, nav_root, attestation):
        print(f"    on-chain SkillRegistry.heartbeat(vault, "
              f"ordersRoot=0x{orders_root.hex()[:12]}…, navRoot=0x{nav_root.hex()[:12]}…, "
              f"sig=0x{attestation.hex()[:12]}…)")
        return "0xHEARTBEAT_TX"


class FakeLighter:
    def __init__(self, state): self._state = state
    async def fetch_state(self, markets): return self._state
    async def submit(self, order):
        return {"avg_fill_price": float(self._state.mid_prices[order.market])}
    async def close(self): pass


class FakeVault:
    def accrue_tx_fee(self, notional):
        print(f"    vault.accrueTxFee   notional={notional:.2f} USDC  -> builder fee shares minted")


async def main():
    agent = ReferenceAgent()

    # Funding diverges most on BTC(+10bps) vs ETH(-10bps) => long ETH / short BTC.
    state = MarketState(
        timestamp=1_750_000_000,
        free_collateral=Decimal("100000"),
        positions={},
        mid_prices={"BTC-PERP": Decimal("64200"), "ETH-PERP": Decimal("3380"), "SOL-PERP": Decimal("148")},
        funding_rates={"BTC-PERP": Decimal("0.0010"), "ETH-PERP": Decimal("-0.0010"), "SOL-PERP": Decimal("0.0003")},
        open_orders={},
        account_value=Decimal("100000"),
    )

    banner("1. Skill loader — verify every agent skill against the on-chain SkillRegistry")
    allowed = [s.hash for s in agent.skills]            # builder pre-registered all 4
    registry = FakeRegistry(allowed)
    verified = load_and_verify_skills(agent, VAULT, registry)
    print(f"    -> {len(verified)} skills verified, shell may run the agent")

    banner("2. Fail-closed — agent hot-swaps in an UNREGISTERED skill")
    agent.register_skill(Skill(name="rogue-exec", version="9.9.9", kind="exec",
                               call=lambda s: [], source="exfiltrate-funds-v9"))
    try:
        load_and_verify_skills(agent, VAULT, registry)
        print("    -> ERROR: should have refused")
    except SkillLoadError as e:
        print(f"    -> REFUSED (fail-closed): {e}")
    agent.skills = [s for s in agent.skills if s.name != "rogue-exec"]  # drop it; back to verified set

    banner("3. Agent proposes intents (it has NO exchange/vault handle)")
    intents = agent.propose(state)
    # plus two out-of-mandate intents to show the shell's policy engine dispose of them:
    intents.append(Order(market="SOL-PERP", side="long", size=Decimal("10")))          # market not allowed
    intents.append(Order(market="BTC-PERP", side="long", size=Decimal("1")))           # 64,200 USDC > per-order cap
    for o in intents:
        print(f"    intent  {o.side:5} {o.size} {o.market}")

    banner("4. Shell disposes — policy engine filters/clamps, gateway submits, fees accrue")
    guard = Guardrails(allowed_markets=frozenset({"BTC-PERP", "ETH-PERP"}),
                       max_leverage=Decimal("3"), max_notional_per_order=Decimal("10000"),
                       min_free_collateral=Decimal("500"))
    gateway = OrderGateway(FakeLighter(state), FakeVault(), guard)
    fills = await gateway.submit_all(intents, state)
    print(f"    -> {len(fills)} order(s) reached Lighter (rogue SOL dropped, oversized BTC clamped)")

    banner("5. Attestation — per-order signatures + on-chain heartbeat")
    tee = Account.create()
    att = AttestationProducer(tee, registry, VAULT)
    order_atts = [att.attest_order(f.order, f) for f in fills if f.filled]
    txh = att.heartbeat(order_atts, nav=Decimal("100000"), period_index=1)
    print(f"    -> heartbeat posted (tx {txh}); signer/teeWallet={tee.address}")


asyncio.run(main())
