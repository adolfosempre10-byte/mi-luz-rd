#!/usr/bin/env bash
# Instala Centinela como servicio de systemd en un servidor Linux.
# Uso:  sudo bash instalar/instalar-linux.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"

if [ "$(id -u)" -ne 0 ]; then echo "Ejecuta con sudo."; exit 1; fi
if [ -z "$NODE" ]; then echo "Falta Node.js 20 o superior (apt install nodejs)."; exit 1; fi
if ! command -v iptables >/dev/null; then echo "Aviso: no se encontro iptables; Centinela avisara pero no podra bloquear."; fi

# Si UFW esta activo, que registre los paquetes que bloquea (asi Centinela detecta escaneos de puertos).
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw logging low >/dev/null && echo "UFW: registro de paquetes bloqueados activado."
fi

cat > /etc/systemd/system/centinela.service <<SERVICIO
[Unit]
Description=Centinela - deteccion y respuesta a ataques
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
ExecStart=$NODE $DIR/centinela.js
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
SERVICIO

systemctl daemon-reload
systemctl enable --now centinela
sleep 2
echo
echo "Centinela instalado. Comandos utiles:"
echo "  journalctl -u centinela -f          ver lo que esta pasando"
echo "  systemctl restart centinela          reiniciar tras cambiar la configuracion"
echo "  nano $DIR/centinela.config.json      configurar avisos y lista blanca"
grep -o '"token": *"[^"]*"' "$DIR/centinela.config.json" 2>/dev/null | head -1 | sed 's/^/  Token del panel -> /' || true
