#!/bin/bash
# Phase 3: SSH hardening — отключаем пароль, оставляем только ключ.
# Запускать ПОСЛЕ того, как Claude подтвердил вход по ключу.

set -euo pipefail

# Бэкап
cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak.$(date +%s)

# Точечные правки
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#*PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sed -i 's/^#*ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#*UsePAM.*/UsePAM no/' /etc/ssh/sshd_config

# Drop-in для надёжности (Ubuntu 24)
mkdir -p /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/99-club-funnel.conf <<'EOF'
PasswordAuthentication no
PubkeyAuthentication yes
PermitRootLogin prohibit-password
KbdInteractiveAuthentication no
EOF

sshd -t
systemctl reload ssh
echo "OK — SSH password auth disabled"
grep -E '^(PasswordAuthentication|PubkeyAuthentication|PermitRootLogin)' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null
