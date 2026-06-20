"""NemoClaw Shell — the measured, on-chain-bound execution plane wrapper.

This subpackage realizes the nested **"NemoClaw Shell wraps a mutable Agent"**
model from the product diagram. One EigenCompute instance per vault runs the
attested Shell; the Shell wraps a deployer-owned, secret, *mutable* Agent.

The security invariant: the Agent is private and mutable, but it can ONLY act
through the Shell. The Shell owns the five responsibilities the diagram pins:

  1. Policy engine        — asset/leverage/concentration limits
                            (reuses ``eigenstrategies_sdk.guardrails.Guardrails``)
  2. Lighter order gateway — the ONLY path to the exchange
                            (``order_gateway.OrderGateway``)
  3. Skill loader          — hash-checks every skill against the on-chain
                            ``SkillRegistry`` and FAILS CLOSED
                            (``skill_loader`` + ``skill_registry_client``)
  4. Attestation producer  — per-order + heartbeat attestations
                            (``attestation.AttestationProducer``)
  5. Vault accounting       — deposits/shares/fees/HWM
                            (reuses ``eigenstrategies_sdk.vault_client.VaultClient``)

The Agent (``agent.Agent``) supplies a thematic *mandate* prompt and a list of
hash-registered ``Skill`` objects; it ``propose()``s order intents but never
submits. ``shell.Shell`` ties everything together in a run loop.

Nothing here imports ``lighter_client`` into the Agent's reach: the Agent has no
handle to the exchange. Backward compatibility: the legacy ``run_agent`` simple
path in ``entrypoint.py`` is untouched and selectable via ``SHELL_MODE=0``.
"""

from .agent import Agent, ReferenceAgent, Skill
from .order_gateway import OrderGateway, Fill
from .skill_loader import SkillLoadError, load_and_verify_skills
from .attestation import AttestationProducer, OrderAttestation
from .skill_registry_client import SkillRegistryClient
from .shell import Shell

__all__ = [
    "Agent",
    "ReferenceAgent",
    "Skill",
    "OrderGateway",
    "Fill",
    "SkillLoadError",
    "load_and_verify_skills",
    "AttestationProducer",
    "OrderAttestation",
    "SkillRegistryClient",
    "Shell",
]
