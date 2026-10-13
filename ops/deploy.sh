#!/bin/sh
# Sync this repo to x-opencode.exe.xyz:/opt/x-opencode and (re)install units.
# Usage: ops/deploy.sh [--restart-server]
set -eu
cd "$(dirname "$0")/.."
HOST=x-opencode.exe.xyz
SSH="$HOME/.local/bin/wssh -o BatchMode=yes"

COPYFILE_DISABLE=1 tar --no-xattrs --exclude=node_modules --exclude=.git -czf - gateway web ops | $SSH $HOST '
  set -e
  sudo mkdir -p /opt/x-opencode.new
  sudo tar -xzf - -C /opt/x-opencode.new
  sudo rm -rf /opt/x-opencode.old
  [ -d /opt/x-opencode ] && sudo mv /opt/x-opencode /opt/x-opencode.old
  sudo mv /opt/x-opencode.new /opt/x-opencode
  sudo chown -R root:root /opt/x-opencode
  sudo chmod 755 /opt/x-opencode/ops/*.sh
  cd /opt/x-opencode/gateway && sudo /usr/local/bin/bun install --frozen-lockfile >/dev/null 2>&1 || sudo /usr/local/bin/bun install >/dev/null
  sudo install -d -m 755 /etc/opencode
  sudo install -m 644 /opt/x-opencode/ops/opencode.json /etc/opencode/opencode.json
  sudo install -d -m 755 -o root -g root /srv/ocsrv/.config /srv/ocsrv/.config/opencode
  sudo install -m 644 -o root -g root /opt/x-opencode/ops/AGENTS.md /srv/ocsrv/.config/opencode/AGENTS.md
  sudo install -m 440 -o root -g root /opt/x-opencode/ops/sudoers /etc/sudoers.d/x-opencode
  sudo visudo -cq
  for u in /opt/x-opencode/ops/*.service; do sudo install -m 644 "$u" /etc/systemd/system/; done
  sudo systemctl daemon-reload
'
if [ "${1:-}" = "--restart-server" ]; then
  $SSH $HOST 'sudo systemctl restart x-opencode-server'
fi
$SSH $HOST 'sudo systemctl enable --now x-opencode-firewall x-opencode-server x-opencode-gateway >/dev/null 2>&1; sudo systemctl restart x-opencode-gateway; sleep 1; systemctl is-active x-opencode-firewall x-opencode-server x-opencode-gateway'
