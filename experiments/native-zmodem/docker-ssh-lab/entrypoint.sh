#!/bin/sh
set -eu

lab_dir=/run/openshell-zmodem-lab
install -d -m 0700 "$lab_dir" /run/sshd
install -d -m 0700 -o zmodemlab -g zmodemlab /home/zmodemlab/.ssh

# Both the client identity and sshd host identity are generated on container
# startup. No private key is baked into the image or checked into Git.
ssh-keygen -q -t ed25519 -N '' -f "$lab_dir/client_ed25519"
ssh-keygen -A >/dev/null

install -m 0600 -o zmodemlab -g zmodemlab \
  "$lab_dir/client_ed25519.pub" /home/zmodemlab/.ssh/authorized_keys

/usr/sbin/sshd -t -f /etc/ssh/sshd_config
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
