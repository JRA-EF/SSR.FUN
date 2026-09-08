#!/usr/bin/env bash
# Runs the agent-feedback daemon. Keep it alive under tmux/launchd/nohup.
#   ./run.sh                 # run in foreground
#   nohup ./run.sh >daemon.log 2>&1 &   # background
cd "$(dirname "$0")"
exec python3 feedback-daemon.py "$@"
