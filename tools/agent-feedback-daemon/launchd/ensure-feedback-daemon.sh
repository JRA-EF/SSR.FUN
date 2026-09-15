#!/bin/bash
# Keeps the agent-feedback daemon alive across crashes, tmux kills, and reboots.
# Copied to ~/casual-claude/daemon/ and run every 5 min by the LaunchAgent
# com.ssr.feedback-daemon (same pattern as the other controllers). No-op if the
# tmux session already exists. The script lives in $HOME, not on /Volumes,
# because launchd jobs cannot read the external volume; tmux can.
SESSION="feedback-daemon"
DAEMON_DIR="/Volumes/GitStuff/ssr/agent-feedback/daemon"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

tmux has-session -t "$SESSION" 2>/dev/null && exit 0

tmux new-session -d -s "$SESSION" -c "$DAEMON_DIR" "$DAEMON_DIR/run.sh"
echo "[$(date)] started $SESSION"
