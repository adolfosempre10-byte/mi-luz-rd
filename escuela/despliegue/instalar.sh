#!/usr/bin/env bash
# Instala el Registro Escolar en un servidor Ubuntu (22.04 o 24.04) con HTTPS automático.
# Uso, como root en el servidor:
#   curl -fsSL https://raw.githubusercontent.com/adolfosempre10-byte/mi-luz-rd/main/escuela/despliegue/instalar.sh | bash
# Con dominio propio:  ... | DOMINIO=notas.micolegio.edu.do bash
set -euo pipefail

REPO="${REPO:-https://github.com/adolfosempre10-byte/mi-luz-rd.git}"
RAMA="${RAMA:-main}"
APP=/opt/registro-escolar
DATOS=/var/lib/registro-escolar
PUERTO=8091

if [ "$(id -u)" != 0 ]; then echo "Ejecuta este instalador como root (o con sudo)."; exit 1; fi

# Sin dominio propio se usa una dirección gratis de sslip.io a partir de la IP del servidor.
if [ -z "${DOMINIO:-}" ]; then
  IP="$(hostname -I | tr ' ' '\n' | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | grep -vE '^(10|127|192\.168|172\.(1[6-9]|2[0-9]|3[01]))\.' | head -n1 || true)"
  if [ -z "$IP" ]; then echo "No encontré la IP pública. Vuelve a ejecutar con DOMINIO=tu.dominio"; exit 1; fi
  DOMINIO="${IP//./-}.sslip.io"
fi
echo "==> Dirección del sistema: https://$DOMINIO"

echo "==> Instalando programas"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https ufw >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

echo "==> Descargando el Registro Escolar"
id registro >/dev/null 2>&1 || useradd --system --home "$DATOS" --shell /usr/sbin/nologin registro
if [ -d "$APP/.git" ]; then git -C "$APP" fetch -q origin "$RAMA" && git -C "$APP" checkout -q -B "$RAMA" FETCH_HEAD
else git clone -q --depth 1 --branch "$RAMA" "$REPO" "$APP"; fi
mkdir -p "$DATOS" && chown -R registro:registro "$DATOS" && chmod 700 "$DATOS"

echo "==> Servicio (arranca solo al encender el servidor)"
cat > /etc/systemd/system/registro-escolar.service <<EOF
[Unit]
Description=Registro Escolar
After=network.target

[Service]
User=registro
WorkingDirectory=$APP/escuela
ExecStart=/usr/bin/env node servidor.js
Environment=PORT=$PUERTO HOST=127.0.0.1 PROXY=1 DATOS_DIR=$DATOS
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$DATOS
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable -q registro-escolar
systemctl restart registro-escolar

echo "==> HTTPS con Caddy"
cat > /etc/caddy/Caddyfile <<EOF
$DOMINIO {
	encode gzip
	header Strict-Transport-Security "max-age=31536000"
	reverse_proxy 127.0.0.1:$PUERTO
}
EOF
systemctl reload caddy || systemctl restart caddy

echo "==> Cortafuegos: solo SSH y web"
ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

sleep 3
CODIGO="$(journalctl -u registro-escolar -n 50 --no-pager | grep -o 'INSTALACIÓN: [0-9]*' | tail -n1 | cut -d' ' -f2 || true)"
echo
echo "======================================================"
echo " Listo. Abre:  https://$DOMINIO"
[ -n "$CODIGO" ] && echo " Código de instalación:  $CODIGO"
echo " (la primera vez el certificado HTTPS puede tardar 1 minuto)"
echo " Para actualizar más adelante: vuelve a ejecutar este mismo comando."
echo "======================================================"
