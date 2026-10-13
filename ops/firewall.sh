#!/bin/sh
# Visitors' TUI processes run as `octui`. They only ever need the gateway's
# local OpenCode proxy, so that user may not open any connection that leaves
# the machine. Idempotent: flushes and recreates its own chain.
set -eu
iptables -N X_OPENCODE_TUI 2>/dev/null || iptables -F X_OPENCODE_TUI
iptables -C OUTPUT -m owner --uid-owner octui -j X_OPENCODE_TUI 2>/dev/null \
  || iptables -I OUTPUT 1 -m owner --uid-owner octui -j X_OPENCODE_TUI
iptables -A X_OPENCODE_TUI -o lo -d 127.0.0.1 -p tcp --dport 4097 -j ACCEPT
iptables -A X_OPENCODE_TUI -j REJECT

ip6tables -N X_OPENCODE_TUI 2>/dev/null || ip6tables -F X_OPENCODE_TUI
ip6tables -C OUTPUT -m owner --uid-owner octui -j X_OPENCODE_TUI 2>/dev/null \
  || ip6tables -I OUTPUT 1 -m owner --uid-owner octui -j X_OPENCODE_TUI
ip6tables -A X_OPENCODE_TUI -j REJECT

# The shared OpenCode server (`ocsrv`) talks to the model gateway on the
# internet, but has no business reaching link-local metadata endpoints.
# exe.dev's DNS resolver lives at 169.254.169.254, so only port 53 is allowed.
iptables -N X_OPENCODE_SRV 2>/dev/null || iptables -F X_OPENCODE_SRV
iptables -C OUTPUT -m owner --uid-owner ocsrv -j X_OPENCODE_SRV 2>/dev/null \
  || iptables -I OUTPUT 1 -m owner --uid-owner ocsrv -j X_OPENCODE_SRV
iptables -A X_OPENCODE_SRV -d 169.254.169.254 -p udp --dport 53 -j ACCEPT
iptables -A X_OPENCODE_SRV -d 169.254.169.254 -p tcp --dport 53 -j ACCEPT
iptables -A X_OPENCODE_SRV -d 169.254.0.0/16 -j REJECT
# Nothing local: replies on its own listening socket are allowed, but it may
# not open connections to other services on this machine.
iptables -A X_OPENCODE_SRV -o lo -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A X_OPENCODE_SRV -o lo -j REJECT
ip6tables -N X_OPENCODE_SRV 2>/dev/null || ip6tables -F X_OPENCODE_SRV
ip6tables -C OUTPUT -m owner --uid-owner ocsrv -j X_OPENCODE_SRV 2>/dev/null \
  || ip6tables -I OUTPUT 1 -m owner --uid-owner ocsrv -j X_OPENCODE_SRV
ip6tables -A X_OPENCODE_SRV -o lo -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -A X_OPENCODE_SRV -o lo -j REJECT

# The gateway serves the public site and talks to the OpenCode server; it
# needs no other outbound connections (locally or to the internet).
iptables -N X_OPENCODE_GW 2>/dev/null || iptables -F X_OPENCODE_GW
iptables -C OUTPUT -m owner --uid-owner ocgw -j X_OPENCODE_GW 2>/dev/null \
  || iptables -I OUTPUT 1 -m owner --uid-owner ocgw -j X_OPENCODE_GW
iptables -A X_OPENCODE_GW -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A X_OPENCODE_GW -o lo -d 127.0.0.1 -p tcp -m multiport --dports 4096,4097 -j ACCEPT
iptables -A X_OPENCODE_GW -d 169.254.169.254 -p udp --dport 53 -j ACCEPT
iptables -A X_OPENCODE_GW -j REJECT
ip6tables -N X_OPENCODE_GW 2>/dev/null || ip6tables -F X_OPENCODE_GW
ip6tables -C OUTPUT -m owner --uid-owner ocgw -j X_OPENCODE_GW 2>/dev/null \
  || ip6tables -I OUTPUT 1 -m owner --uid-owner ocgw -j X_OPENCODE_GW
ip6tables -A X_OPENCODE_GW -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -A X_OPENCODE_GW -j REJECT
