#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

[ -f config.json ] || { cp config.example.json config.json; echo "[start] created config.json"; }
[ -d worker/node_modules ] || { echo "[start] installing worker deps..."; npm ci --prefix worker; }
[ -f bin/qoder-free ] || { echo "[start] building..."; go build -o bin/qoder-free ./cmd/server; }

echo "[start] starting qoder-free..."
exec ./bin/qoder-free
