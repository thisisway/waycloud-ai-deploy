#!/usr/bin/env bash
# Installs (or removes) the Way Cloud deploy agent on a Plesk server. Run as root.
#   install.sh --api https://<service>/agent/v1 --token <64 hex> [--le-email you@example.com]
#   install.sh --uninstall
# Read it before running: it only creates the files listed below and starts one systemd service.
#   /opt/waycloud/waycloud-agent.sh      the agent
#   /etc/waycloud-agent.env               its settings, including the token (root only, mode 600)
#   /etc/systemd/system/waycloud-agent.service
#   /var/lib/waycloud-agent, /var/www/vhosts/.waycloud-agent   work files and snapshots (root only)
set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { printf 'ERRO: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "rode como root."

if [ "${1:-}" = "--uninstall" ]; then
  systemctl disable --now waycloud-agent 2>/dev/null || true
  rm -f /etc/systemd/system/waycloud-agent.service /etc/waycloud-agent.env
  rm -rf /opt/waycloud
  systemctl daemon-reload
  say "Agente removido. Snapshots e arquivos de trabalho foram mantidos em /var/www/vhosts/.waycloud-agent (apague se quiser)."
  exit 0
fi

API=""; TOKEN=""; LE_EMAIL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --api) API="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --le-email) LE_EMAIL="${2:-}"; shift 2 ;;
    *) die "opção desconhecida: $1" ;;
  esac
done
[[ "$API" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?/agent/v1$ ]] || die "--api deve ser https://<serviço>/agent/v1"
[[ "$TOKEN" =~ ^[0-9a-f]{64}$ ]] || die "--token deve ter 64 caracteres hexadecimais"
[ -z "$LE_EMAIL" ] || [[ "$LE_EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "--le-email inválido"

here="$(cd "$(dirname "$0")" && pwd)"
[ -f "$here/waycloud-agent.sh" ] || die "waycloud-agent.sh precisa estar na mesma pasta do instalador"

say "1/5 Conferindo o servidor..."
command -v plesk >/dev/null || die "o comando 'plesk' não foi encontrado: este não parece ser um servidor Plesk."
for c in curl jq unzip openssl flock sha256sum; do
  command -v "$c" >/dev/null && continue
  say "    instalando $c..."
  if command -v dnf >/dev/null; then dnf install -y "$c" >/dev/null; elif command -v apt-get >/dev/null; then apt-get install -y "$c" >/dev/null; else die "instale '$c' e rode de novo"; fi
done
say "    Plesk: $(plesk version 2>/dev/null | head -1)"
for w in httpd apache2 nginx lswsctrl; do command -v "$w" >/dev/null && say "    servidor web encontrado: $w"; done

say "2/5 Testando a conexão e o token..."
code=$(curl -sS -m 20 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$API/ping" || echo 000)
case "$code" in
  200) say "    ok" ;;
  401) die "o serviço recusou o token (401). Confira o token." ;;
  *) die "não consegui falar com $API (HTTP $code)" ;;
esac

say "3/5 Instalando o agente..."
install -d -m 755 /opt/waycloud
install -m 750 "$here/waycloud-agent.sh" /opt/waycloud/waycloud-agent.sh
check_addr=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)
umask 077
cat > /etc/waycloud-agent.env <<ENV
WC_API=$API
WC_TOKEN=$TOKEN
WC_LE_EMAIL=$LE_EMAIL
WC_CHECK_ADDR=${check_addr:-127.0.0.1}
ENV
chmod 600 /etc/waycloud-agent.env

say "4/5 Criando o serviço systemd..."
cat > /etc/systemd/system/waycloud-agent.service <<'UNIT'
[Unit]
Description=Way Cloud deploy agent
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/waycloud-agent.env
ExecStart=/opt/waycloud/waycloud-agent.sh
Restart=always
RestartSec=10
User=root
NoNewPrivileges=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload

say "5/5 Iniciando..."
systemctl enable --now waycloud-agent
sleep 2
systemctl --no-pager --lines=5 status waycloud-agent || true
say ""
say "Pronto. Acompanhe com: journalctl -u waycloud-agent -f"
