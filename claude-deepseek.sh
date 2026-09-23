#!/usr/bin/env bash
set -euo pipefail
# usage:
#   ./claude-deepseek.sh [--effort low|medium|high|max] [claude args...]
#
# Effort defaults to "high", not "max". DeepSeek's reasoning effort scales
# output/context token volume directly — running "max" (xhigh) on every
# single call, combined with DeepSeek V4 Flash's documented verbosity, is
# almost certainly the biggest reason context and cost balloon fast.
# Pass --effort max explicitly when a task actually needs it.

SCRIPT_DIR="$(cd -P "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"

# Helper to load a .env-style file into the current shell
load_env_file() {
    local file="$1"
    if [[ -f "$file" ]]; then
        set -a   # auto-export everything sourced below
        # shellcheck disable=SC1090
        source "$file"
        set +a
        return 0
    fi
    return 1
}

# Load .env first, fall back to .env.local if needed
if [[ -f "$SCRIPT_DIR/.env" ]]; then
    load_env_file "$SCRIPT_DIR/.env"
elif [[ -f "$SCRIPT_DIR/.env.local" ]]; then
    echo "ℹ️  .env not found, loading from .env.local..."
    load_env_file "$SCRIPT_DIR/.env.local"
else
    echo "⚠️  Warning: Neither .env nor .env.local found in $SCRIPT_DIR"
fi

# Check specifically for the DeepSeek API key
if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
    echo "❌ Error: DEEPSEEK_API_KEY not found in environment files."
    exit 1
fi

# Effort level: default "high", override via --effort <level> or CLAUDE_EFFORT env var
EFFORT="${CLAUDE_EFFORT:-high}"
if [[ "${1:-}" == "--effort" ]]; then
    EFFORT="${2:?--effort requires a value}"
    shift 2
fi

# Set Claude Code environment variables for DeepSeek integration
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_AUTH_TOKEN="$DEEPSEEK_API_KEY"
export ANTHROPIC_MODEL="deepseek-v4-flash"
export ANTHROPIC_DEFAULT_OPUS_MODEL="deepseek-v4-pro"
export ANTHROPIC_DEFAULT_SONNET_MODEL="deepseek-v4-flash"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="deepseek-v4-flash"
export CLAUDE_CODE_SUBAGENT_MODEL="deepseek-v4-flash"
export CLAUDE_CODE_EFFORT_LEVEL="$EFFORT"

# Claude Code can't auto-detect the real context window for a custom
# ANTHROPIC_BASE_URL provider and silently assumes 200k — even though
# DeepSeek V4 Flash actually supports 1M. Without this, /context and
# auto-compaction trigger at ~1/5 of the model's real capacity.
# Keep this number in sync with the "hard limit" figure in AGENTS.md.
export CLAUDE_CODE_MAX_CONTEXT_TOKENS="${CLAUDE_CODE_MAX_CONTEXT_TOKENS:-1000000}"

# Optional: Enable 1-hour prompt caching to reduce token costs for long sessions
# (verify DeepSeek's Anthropic-compat endpoint actually honors this — not guaranteed)
export ENABLE_PROMPT_CACHING_1H=1

echo "🚀 Launching Claude Code with DeepSeek ($ANTHROPIC_MODEL, effort=$EFFORT, context=${CLAUDE_CODE_MAX_CONTEXT_TOKENS} tokens)..."

# Run Claude Code with all arguments passed to the script
exec claude "$@"