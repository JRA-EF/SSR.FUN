#!/usr/bin/env bash
# Runs the agent-feedback daemon under a restart loop, so a crash never leaves
# feedback un-raised. Use it inside tmux session `feedback-daemon`:
#   ./run.sh              # supervised: restarts the daemon whenever it exits
#   ./run.sh --list       # any argument = one-shot command, no restart loop
# Ctrl-C stops the loop.
cd "$(dirname "$0")" || exit 1
if [ "$#" -gt 0 ]; then exec python3 feedback-daemon.py "$@"; fi
trap 'echo "$(date +%H:%M:%S) supervisor stopping"; exit 0' INT TERM
delay="${RESTART_DELAY:-30}"
while true; do
  python3 feedback-daemon.py
  code=$?
  echo "$(date +%H:%M:%S) daemon exited with code $code; restarting in ${delay}s"
  sleep "$delay"
done
