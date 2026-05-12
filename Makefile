SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help install build typecheck clean docker

help:
	@grep -E '^[a-zA-Z_-]+:.*?##' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?##"}{printf "  \033[36m%-12s\033[0m %s\n",$$1,$$2}'

install: ## Install dev deps
	npm install

build: ## Compile TS to dist
	npm run build

typecheck: ## Type check without emit
	npm run typecheck

clean: ## Remove build artifacts
	rm -rf dist .tsbuildinfo

docker: ## Build the docker image locally (requires `nuclei` binary pre-staged)
	docker buildx build --platform linux/amd64 -t am-pi-agent:dev .
