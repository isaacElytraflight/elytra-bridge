#!/usr/bin/env bash
# Starts the Elytra Bridge Vite frontend + Express backend after checking Docker and Node.
# First simulation connect from the UI may still build/download large Docker images.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

if [[ ! -f "$ROOT/projects/drone-2026/project.yaml" ]]; then
  echo "Initializing Git submodules (projects/drone-2026)..."
  git -C "$ROOT" submodule update --init --recursive
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[ERROR] Docker CLI not found. Install Docker Desktop or Docker Engine." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "[ERROR] Docker daemon not running. Start Docker Desktop." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found. Install Node.js 20+." >&2
  exit 1
fi

cd "$ROOT/application"

if [[ ! -d node_modules ]]; then
  echo "Installing npm dependencies (first run only; may take a minute)..."
  npm install
fi

echo ""
echo "Starting Elytra Bridge backend + frontend dev servers."
echo "Opening http://localhost:5173 in a few seconds."
echo "Press Ctrl+C here to stop."
echo ""

(
  sleep 4
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "http://localhost:5173" >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1; then
    open "http://localhost:5173" >/dev/null 2>&1 || true
  fi
) &

exec npm run dev
