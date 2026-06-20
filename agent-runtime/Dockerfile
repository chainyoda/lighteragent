# LighterClaw agent-runtime image.
#
# This is the artifact EigenCompute attests (its digest becomes IMAGE_HASH) and
# that NemoClaw supervises inside the OpenShell sandbox. It bundles the local
# agent SDK + the chosen strategy and runs entrypoint.py, which boots the
# healthcheck server and then the SDK trade loop.
#
# BUILD CONTEXT = REPO ROOT (so we can COPY ./agent-sdk and ./agent-runtime):
#   docker build --platform linux/amd64 -f agent-runtime/Dockerfile -t lighterclaw-agent:latest .
#
# Pinned to linux/amd64 so the attested digest is deterministic across builders
# (EigenCompute TEEs are amd64; an arm64 host must build with --platform).
FROM --platform=linux/amd64 python:3.12-slim AS base

# - PYTHONUNBUFFERED: stream logs straight to NemoClaw/EigenCompute stdout.
# - PYTHONDONTWRITEBYTECODE: no .pyc churn on the read-only rootfs.
# - PORT: healthcheck port the sandbox/EigenCompute probes.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8080

WORKDIR /app

# Install the local SDK first so its (heavier) dependency layer caches well.
# Copying only pyproject.toml + package dir keeps the layer stable across
# strategy edits.
COPY agent-sdk/ /tmp/agent-sdk/
RUN pip install /tmp/agent-sdk && rm -rf /tmp/agent-sdk

# Runtime code: entrypoint, healthcheck, and the default (funding-carry)
# strategy shim. Add additional strategy modules here and select via
# $STRATEGY_MODULE at deploy time.
COPY agent-runtime/entrypoint.py     /app/entrypoint.py
COPY agent-runtime/healthcheck.py    /app/healthcheck.py
COPY agent-runtime/funding_carry.py  /app/funding_carry.py
COPY agent-runtime/requirements.txt  /app/requirements.txt
# NemoClaw Shell package (Shell-wraps-Agent execution plane). Selected by
# SHELL_MODE (default on); the legacy funding_carry path above still works.
COPY agent-runtime/shell/            /app/shell/

# Run as a non-root, unprivileged user. NemoClaw drops all caps regardless, but
# defense-in-depth: the container itself shouldn't run as root. UID 10001 owns
# only /app (read-only at runtime) and the scratch /tmp mount.
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin agent \
    && chown -R agent:agent /app
USER 10001

# Liveness/health endpoint for EigenCompute + NemoClaw probes.
EXPOSE 8080

# Container-level healthcheck (belt-and-suspenders with the platform probe).
# Pure-stdlib urllib so no extra binary is needed in the sandbox.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD ["python", "-c", "import os,urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8080')+'/healthz', timeout=4).status==200 else 1)"]

# The entrypoint NemoClaw supervises.
ENTRYPOINT ["python", "-u", "/app/entrypoint.py"]
