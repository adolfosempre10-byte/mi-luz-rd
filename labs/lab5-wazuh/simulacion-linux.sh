#!/usr/bin/env bash
# Lab 5 - auditd + simulaciones en un agente Ubuntu (SOLO en la VM del laboratorio)
# Uso:  sudo bash simulacion-linux.sh          -> reglas auditd + simulaciones
#       sudo bash simulacion-linux.sh limpiar  -> borra el usuario de prueba
set -u
CSV="$(dirname "$0")/lineadetiempo-linux.csv"
EQUIPO=$(hostname)

anotar() { # evento, accion, tecnica
  local hora; hora=$(date '+%F %T')
  echo "\"$hora\",\"$EQUIPO\",\"$1\",\"$2\",\"$3\"" >> "$CSV"
  echo "[$hora] $1 - $2 ($3)"
}

if [ "$(id -u)" -ne 0 ]; then echo "Ejecutalo con sudo"; exit 1; fi

if [ "${1:-}" = "limpiar" ]; then
  userdel -r hacker 2>/dev/null; echo "Usuario 'hacker' eliminado."; exit 0
fi

# 1. auditd y reglas
apt-get install -y auditd >/dev/null
systemctl enable --now auditd
auditctl -w /etc/passwd  -p wa -k cuentas
auditctl -w /etc/shadow  -p wa -k cuentas
auditctl -w /etc/sudoers -p wa -k sudoers
auditctl -w /etc/group   -p wa -k cuentas
echo "== Reglas cargadas (captura esto) =="; auditctl -l

# 2. Que Wazuh lea el log de auditd (si no estaba ya)
CONF=/var/ossec/etc/ossec.conf
if [ -f "$CONF" ] && ! grep -q "/var/log/audit/audit.log" "$CONF"; then
  sed -i 's#</ossec_config>#  <localfile>\n    <log_format>audit</log_format>\n    <location>/var/log/audit/audit.log</location>\n  </localfile>\n</ossec_config>#' "$CONF"
  systemctl restart wazuh-agent
  echo "Agregado audit.log a ossec.conf y reiniciado wazuh-agent"
fi
read -rp "Toma la captura y pulsa Enter para empezar las simulaciones..."

# 3. Fuerza bruta SSH (5 intentos fallidos)
if command -v sshpass >/dev/null || apt-get install -y sshpass openssh-server >/dev/null; then
  for i in 1 2 3 4 5; do
    sshpass -p "ClaveMala$i" ssh -o StrictHostKeyChecking=no -o PubkeyAuthentication=no \
      -o ConnectTimeout=3 "noexiste@127.0.0.1" true 2>/dev/null
  done
  anotar "sshd" "5 intentos SSH fallidos" "T1110 Fuerza bruta"
fi
sleep 3
useradd -m hacker && echo 'hacker:Pass123!' | chpasswd
anotar "auditd cuentas" "Usuario 'hacker' creado" "T1136.001 Crear cuenta local"
sleep 3
usermod -aG sudo hacker
anotar "auditd cuentas" "'hacker' agregado a sudo" "T1098 Manipulacion de cuentas"
sleep 3
echo "# prueba lab5" >> /etc/sudoers.d/lab5 && rm -f /etc/sudoers.d/lab5
cat /etc/sudoers >/dev/null; touch /etc/sudoers
anotar "auditd sudoers" "Se toco /etc/sudoers" "T1548.003 Abuso de sudo"

echo; echo "Linea de tiempo: $CSV"
echo "Evidencia local: sudo ausearch -k cuentas -i | tail -40"
echo "En Wazuh filtra por: rule.groups: audit  o  agent.name: $EQUIPO"
echo "Al terminar: sudo bash $0 limpiar"
