#!/usr/bin/env bash
# MR EDU MOBILE 2.0 관리자 서버 실행 (Linux/macOS)
set -e
cd "$(dirname "$0")/../backend"
if [ -d ../.venv ]; then source ../.venv/bin/activate; fi
python -m app.cli init-db >/dev/null
echo "관리자 화면: http://$(hostname -I 2>/dev/null | awk '{print $1}'):${MR_EDU_PORT:-8000}"
exec python -m app.main
