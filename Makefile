# EigenStrategies — top-level orchestration across all three planes.
#
#   custody    -> contracts/      (Solidity / Foundry)
#   execution  -> agent-runtime/  (NemoClaw-sandboxed image on EigenCompute)
#   settlement -> Lighter         (reached from inside the TEE)
#
# Targets are defensive: a missing dir or tool prints a friendly hint instead
# of a raw error, so you can run `make help` on a half-checked-out tree.
# Full runbook: ./BUILD.md   Architecture: ./ARCHITECTURE.md

.DEFAULT_GOAL := help
.PHONY: help all contracts-build contracts-test agent-build deploy web

# Image tag for the agent-runtime container (override: make agent-build IMAGE=...)
IMAGE ?= eigenstrategies/agent-runtime:dev
# Port the static prototype is served on (override: make web PORT=8080)
PORT  ?= 8000

help: ## Show this help
	@echo "EigenStrategies — make targets:"
	@grep -hE '^[a-zA-Z0-9_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

contracts-build: ## Compile the Solidity contracts (forge build)
	@if [ ! -f contracts/foundry.toml ]; then \
		echo "skip: contracts/ not present (sibling agent owns it)"; \
	elif ! command -v forge >/dev/null 2>&1; then \
		echo "skip: 'forge' not found — install Foundry (see BUILD.md)"; \
	else \
		cd contracts && forge build; \
	fi

contracts-test: ## Run the Foundry test suite (forge test)
	@if [ ! -f contracts/foundry.toml ]; then \
		echo "skip: contracts/ not present (sibling agent owns it)"; \
	elif ! command -v forge >/dev/null 2>&1; then \
		echo "skip: 'forge' not found — install Foundry (see BUILD.md)"; \
	else \
		cd contracts && forge test -vv; \
	fi

agent-build: ## Build the agent-runtime Docker image
	@if [ ! -f agent-runtime/Dockerfile ]; then \
		echo "skip: agent-runtime/Dockerfile not present (sibling agent owns it)"; \
	elif ! command -v docker >/dev/null 2>&1; then \
		echo "skip: 'docker' not found — install Docker (see BUILD.md)"; \
	else \
		docker build --platform linux/amd64 -t $(IMAGE) agent-runtime; \
	fi

deploy: ## Deploy the agent to EigenCompute under NemoClaw (deploy/deploy.sh)
	@if [ ! -f deploy/deploy.sh ]; then \
		echo "skip: deploy/deploy.sh not present (sibling agent owns it)"; \
	else \
		IMAGE=$(IMAGE) bash deploy/deploy.sh; \
	fi

web: ## Serve the frontend prototype on http://localhost:$(PORT)
	@if ! command -v python3 >/dev/null 2>&1; then \
		echo "skip: 'python3' not found — needed to serve the static prototype"; \
	else \
		echo "serving prototype on http://localhost:$(PORT) (Ctrl-C to stop)"; \
		python3 -m http.server $(PORT); \
	fi

all: contracts-build contracts-test agent-build ## Build + test contracts, then build the agent image
	@echo "build complete — see BUILD.md for deploy + run steps"
