#!/bin/bash
cd "$(dirname "$0")"
if ! python3 -c "import quality_guard" 2>/dev/null; then
  echo "Installing Quality Guard..."
  python3 -m pip install --user ".[vision]" || { echo "Install Python 3.11+ from python.org first."; read -r; exit 1; }
fi
echo "Starting Quality Guard... your browser will open. Close this window to quit."
python3 -m quality_guard "$@"
