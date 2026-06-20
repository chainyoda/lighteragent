"""Skill loader + on-chain hash registry check — FAIL CLOSED.

This is the Shell's responsibility #3: "Skill loader + skill-hash registry
check". Given an Agent, the vault address, and a ``SkillRegistry`` client, it:

  1. computes each skill's ``.hash`` (sha256 of its canonical spec),
  2. verifies ``isAllowedSkill(vault, hash)`` on-chain,
  3. **refuses to load/run any skill whose hash isn't registered** — fail closed.

A skill the Agent ships but the builder never registered on-chain is treated as
hostile-by-default: the Shell will not run it. This is what makes the Agent's
mutability safe — a hot-swapped skill that isn't pre-registered is rejected, so
new behavior can only ship after the builder pins its hash in the registry.

The loader logs every skill's pass/fail with its hash, so the attested logs show
exactly which capabilities the Shell admitted.
"""

from __future__ import annotations

import logging

from .agent import Agent, Skill
from .skill_registry_client import SkillRegistryClient


log = logging.getLogger("shell.skill_loader")


class SkillLoadError(RuntimeError):
    """Raised when one or more of the Agent's skills are not registered on-chain.

    Carries the rejected skills so the caller can log/report precisely which
    hashes failed the registry check.
    """

    def __init__(self, rejected: list[Skill]):
        self.rejected = rejected
        names = ", ".join(f"{s.name}@{s.version} ({s.hash})" for s in rejected)
        super().__init__(
            f"fail-closed: {len(rejected)} skill(s) not registered on-chain: {names}"
        )


def load_and_verify_skills(
    agent: Agent,
    vault_address: str,
    registry: SkillRegistryClient,
    *,
    log_: logging.Logger | None = None,
) -> list[Skill]:
    """Verify every Agent skill against the on-chain registry. Fail closed.

    Returns the list of verified (loadable) skills on success. Raises
    ``SkillLoadError`` if ANY skill is unregistered — the Shell must not run a
    partially-verified agent, since an unregistered skill could be the exec path.

    A network/registry error is also fail-closed: it propagates (the Shell does
    not proceed to trade if it cannot prove skills are registered).
    """
    lg = log_ or log

    if not agent.skills:
        # An agent with no skills proposes nothing; nothing to verify, but make
        # the empty set explicit in the logs.
        lg.warning("agent %s exposes no skills — nothing to load", agent.name())
        return []

    verified: list[Skill] = []
    rejected: list[Skill] = []

    for skill in agent.skills:
        skill_hash = skill.hash
        allowed = registry.is_allowed_skill(vault_address, skill_hash)
        if allowed:
            lg.info("skill OK  %s kind=%s hash=%s", skill.name, skill.kind, skill_hash)
            verified.append(skill)
        else:
            lg.error(
                "skill DENY %s kind=%s hash=%s (not in SkillRegistry for vault %s)",
                skill.name, skill.kind, skill_hash, vault_address,
            )
            rejected.append(skill)

    if rejected:
        # Fail closed: refuse the whole agent rather than run a subset, since an
        # unregistered skill might be the exec path that actually trades.
        raise SkillLoadError(rejected)

    lg.info(
        "skill loader: %d/%d skills verified against on-chain SkillRegistry for vault %s",
        len(verified), len(agent.skills), vault_address,
    )
    return verified
