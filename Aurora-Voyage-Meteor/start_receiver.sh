#!/usr/bin/env bash
# 星海航行计划 · 接收器启动脚本（macOS / Linux）
# 首次运行会自动建虚拟环境并安装依赖。
set -e
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"
if ! command -v "$PY" >/dev/null 2>&1; then
  echo "找不到 $PY，请先安装 Python 3.10+" >&2
  exit 1
fi

if [ ! -d .venv ]; then
  echo "[SETUP] 创建虚拟环境 .venv ..."
  "$PY" -m venv .venv
fi

# shellcheck disable=SC1091
. .venv/bin/activate
python -c "import pythonosc, websockets" 2>/dev/null || {
  echo "[SETUP] 安装依赖 ..."
  python -m pip install --disable-pip-version-check -r requirements.txt
}

echo "[RUN] 启动接收器（Ctrl+C 停止）"
echo "      Muse Direct 的 OSC 目标设为 127.0.0.1:8000"
exec python -u eeg_receiver.py "$@"
