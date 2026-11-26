# Laboratorio 5: Centralización de eventos y detección con Wazuh

**Estudiante:** ______________________ **Matrícula:** __________ **Fecha:** __________

## 1. Objetivo
Centralizar los eventos de seguridad de un equipo en un SIEM (Wazuh), simular técnicas de ataque comunes
y demostrar que se detectan y se conservan aunque el atacante borre el registro local.

## 2. Entorno
| VM | Sistema | RAM / CPU | IP | Rol |
|---|---|---|---|---|
| VM1 | Ubuntu 24.04 | 4 GB / 2 | ___.___.___.___ | Servidor Wazuh (manager, indexer, dashboard) |
| VM2 | Windows Server ____ | __ GB / __ | ___.___.___.___ | Agente |

Se usaron 2 VMs por limitaciones de hardware, según lo autorizado por el profesor.
*(Captura 01: IPs y ping entre las VMs)*

## 3. Instalación del servidor Wazuh
Comando: `curl -sO https://packages.wazuh.com/4.x/wazuh-install.sh && sudo bash ./wazuh-install.sh -a`
*(Captura 02: fin de la instalación, con la contraseña tapada)*
*(Captura 03: dashboard con la sesión iniciada)*

**Problemas encontrados y solución:** ______________________________________________
*(Captura 04, si aplica)*

## 4. Despliegue del agente
Pasos: Agents → Deploy new agent → comando en PowerShell como administrador → `NET START WazuhSvc`.
*(Captura 05: agente en estado Active)*

## 5. Configuración de la auditoría
Subcategorías activadas con `auditpol`: Logon, User Account Management, Security Group Management, Other Object Access Events.
*(Captura 06)*

## 6. Simulaciones y detecciones
| # | Simulación | Comando | Event ID | Detectado en Wazuh | Captura |
|---|---|---|---|---|---|
| 1 | Fuerza bruta | 5 × `net use` con una clave incorrecta | 4625 | Sí / No | 07 |
| 2 | Creación de cuenta | `net user hacker ... /add` | 4720 | | 08 |
| 3 | Escalada de privilegios | `net localgroup Administradores hacker /add` | 4732 | | 09 |
| 4 | Persistencia | `schtasks /create /tn Updater ...` | 4698 | | 10 |
| 5 | Borrado de huellas | `wevtutil cl Security` | 1102 | | 11 |

Filtro usado: `data.win.system.eventID: (4625 or 4720 or 4732 or 4698 or 1102)`
*(Captura 12: Visor de eventos local vacío después del borrado y Wazuh con todos los eventos)*

## 7. Línea de tiempo
| Hora | Sistema | Evento (ID) | Evidencia | Técnica MITRE ATT&CK |
|---|---|---|---|---|
| | | 4625 ×5 | Captura 07 | T1110 Brute Force |
| | | 4720 | Captura 08 | T1136.001 Create Account: Local |
| | | 4732 | Captura 09 | T1098 Account Manipulation |
| | | 4698 | Captura 10 | T1053.005 Scheduled Task |
| | | 1102 | Captura 11 | T1070.001 Clear Windows Event Logs |

## 8. Conclusión
Wazuh detectó las cinco técnicas simuladas. Lo más importante fue el evento 1102: el atacante borró el registro
de Seguridad del servidor, pero la evidencia de todo lo anterior siguió disponible en el SIEM, porque el agente
envió los eventos al servidor en el momento en que ocurrieron. Esto demuestra el valor de centralizar los logs:
el registro local no es confiable una vez comprometido el equipo.

Mejoras posibles: instalar Sysmon para tener más detalle de los procesos, crear reglas personalizadas o alertas
por correo para el 1102 y el 4732, y activar FIM sobre carpetas críticas.
