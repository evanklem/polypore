#!/bin/bash
# Screenshots for the README from a synthetic HOME (never your real sessions).
#   t.sh demo; t.sh start; t.sh keys j Enter; t.sh cap sessions; ROWS=34 t.sh png sessions; t.sh stop
# t.sh demo | start | keys <tmux keys...> | cap <name> | png <name> | stop
S=${SHOTS_OUT:-/tmp/polypore-shots}; mkdir -p $S
HERE=$(cd "$(dirname "$0")" && pwd)
DEMO=${POLYPORE_DEMO:-/tmp/polypore-demo}
BIN=$HERE/../../target/release/polypore
COLS=${COLS:-160}; ROWS=${ROWS:-44}
T="tmux -L ptest"
case "$1" in
  demo)
    [ -f $DEMO/holders.pid ] && kill $(cat $DEMO/holders.pid) 2>/dev/null
    python3 -I $HERE/mkdemo.py $DEMO > $S/env.sh ;;
  start)
    source $S/env.sh
    export XDG_RUNTIME_DIR=$DEMO-run
    mkdir -p "$XDG_RUNTIME_DIR"; chmod 700 "$XDG_RUNTIME_DIR"
    $T -f /dev/null new-session -d -x $COLS -y $ROWS -s demo \
      "cd $HOME && env -u DBUS_SESSION_BUS_ADDRESS HOME=$HOME XDG_CONFIG_HOME=$XDG_CONFIG_HOME XDG_STATE_HOME=$XDG_STATE_HOME XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR CODEX_HOME=$CODEX_HOME COLORTERM=truecolor TERM=tmux-256color SHELL=/bin/bash EDITOR=true $BIN"
    $T set -g default-terminal tmux-256color
    $T set -ga terminal-overrides ',*:RGB'
    $T set -g status off
    ;;
  keys) shift; $T send-keys -t demo "$@" ;;
  cap) $T capture-pane -t demo -e -p > $S/$2.ansi; $T capture-pane -t demo -p ;;
  png)
    python3 -I $HERE/ansi2html.py $S/$2.ansi $S/$2.html $COLS $ROWS "${3:-#0a0807}" "${4:-#f4efe8}"
    W=$(( COLS * 87 / 10 + 34 )); H=$(( ROWS * 19 + 28 ))
    chromium --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
      --window-size=$W,$H --screenshot=$S/$2.png "file://$S/$2.html" >/dev/null 2>&1
    echo "$S/$2.png"
    ;;
  stop)
    $T kill-server 2>/dev/null
    P=$DEMO/state/polypore/server.pid
    [ -f $P ] && kill $(cat $P) 2>/dev/null
    [ -f $DEMO/holders.pid ] && kill $(cat $DEMO/holders.pid) 2>/dev/null
    true ;;
esac
