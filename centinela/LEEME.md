# Centinela

Sistema para **detectar ataques** contra servidores y PCs, **detenerlos** (bloquea la IP del atacante),
**identificar** al atacante, **investigar** qué pasó, **avisar al equipo de tecnología** y llevar las **alertas** en un panel
que se abre en la PC o en el celular.

Es un proyecto aparte de Mi Luz RD. Está hecho en Node.js, **sin dependencias**: se copia la carpeta y funciona.

| Paso | Qué hace Centinela |
|---|---|
| **Detectar** | Lee en vivo los registros de SSH, del servidor web (nginx, Apache, IIS), los eventos de seguridad de Windows, el registro del firewall, las conexiones abiertas y los archivos importantes. Compara todo contra 32 reglas de ataque. |
| **Detener** | Bloquea la IP en el firewall del sistema (iptables en Linux, Firewall de Windows, pf en macOS). La primera vez 1 hora, la segunda 24 horas, después 7 días. Con varios equipos, un atacante detectado en uno queda bloqueado en **todos**. |
| **Identificar** | IP, nombre DNS, si viene de internet o de un equipo de la propia red, país y proveedor, reputación en AbuseIPDB, usuarios que intentó usar y la técnica de ataque (MITRE ATT&CK). |
| **Mitigar** | Además del bloqueo: límite de peticiones para apps web, y un comando de emergencia (por ejemplo desconectar la red) cuando detecta ransomware. |
| **Investigar** | Cada incidente trae la evidencia (las líneas exactas del registro), el historial de la IP, qué otros equipos atacó y una lista de **qué hacer**. Se descarga como informe. También analiza registros viejos. |
| **Avisar** | Telegram, correo, Microsoft Teams, Slack o Discord, según la gravedad. |
| **Alertas** | Panel web con los incidentes, su estado (abierto, investigando, resuelto, falsa alarma), notas del equipo y las IPs bloqueadas. |

## Probarlo en 1 minuto (sin tocar nada del equipo)

```bash
cd centinela
node centinela.js --simulacro
```

Simula una fuerza bruta por SSH que termina en intrusión, un escáner web con inyección SQL, un intento de Log4Shell,
fuerza bruta a Escritorio Remoto y un ransomware. Muestra cómo responde y el aviso exacto que le llegaría a tecnología.
No toca el firewall. Con `--enviar` manda esos avisos de verdad a los canales configurados.

## Instalar

Requisito: **Node.js 20 o superior**.

### Servidor Linux

```bash
sudo bash instalar/instalar-linux.sh
```

Lo deja como servicio (`systemctl status centinela`), arranca con el servidor y se reinicia solo si se cae.
La primera vez crea `centinela.config.json` con un **token para el panel** (aparece en `journalctl -u centinela`).

### PC o servidor Windows

Clic derecho en `instalar\instalar-windows.ps1` → *Ejecutar con PowerShell* como administrador.
Activa la auditoría de inicios de sesión y el registro del firewall, y deja Centinela arrancando con Windows.
Para probarlo sin instalar: clic derecho en `Iniciar-Centinela.bat` → *Ejecutar como administrador*.

### Primer ajuste (importante)

Abre `centinela.config.json` y agrega a `listaBlanca` la IP fija de la oficina o de la VPN.
**Si no lo haces, alguien del equipo que se equivoque de clave varias veces puede quedar bloqueado** (el bloqueo vence solo en 1 hora,
o se quita desde el panel / con `node centinela.js --desbloquear IP`).
Todas las opciones están explicadas con valores de ejemplo en `centinela.config.ejemplo.json`.

## Varios equipos: un central y agentes

```
  PC contabilidad ─┐
  PC gerencia ─────┼──► Servidor CENTRAL ──► Telegram / correo / Teams
  Servidor web ────┘        (panel)
```

- Cada equipo con Centinela detecta y bloquea por su cuenta (sigue funcionando aunque se caiga la red).
- Todos mandan sus incidentes al **central**, que avisa a tecnología y muestra todo en un solo panel.
- Si un equipo ataca o es atacado por una IP, el central reparte el bloqueo y **esa IP queda bloqueada en todos los equipos**.
- Si un equipo deja de reportar por más de 5 minutos, el central lo alerta (los intrusos suelen apagar la vigilancia antes de actuar).
- Si el central no responde, cada agente avisa directo para que ninguna alerta se pierda.

En el central:

```json
"central": { "esCentral": true, "tokenAgentes": "UN-TOKEN-LARGO-Y-SECRETO" }
```

En cada agente:

```json
"central": { "url": "https://central.tuempresa.com:8095", "tokenAgentes": "EL-MISMO-TOKEN" }
```

Si los agentes llegan al central por internet, usa HTTPS (`panel.certificado` y `panel.claveCertificado`, o detrás de nginx con
`panel.detrasDeProxy: true`). Si el certificado es propio, en los agentes define `NODE_EXTRA_CA_CERTS=ruta/al/ca.pem`.

## Configurar los avisos a tecnología

Cada canal tiene `severidadMinima` (`baja`, `media`, `alta`, `critica`): por ejemplo Telegram para todo desde *media*
y correo al jefe de tecnología solo para *alta* y *crítica*. Si hay una tormenta de alertas (más de 30 en una hora), se retienen
las no críticas para no saturar; las críticas siempre salen. Para probar los canales: `node centinela.js --probar-avisos`
o el botón *Probar avisos* del panel.

- **Telegram (recomendado, llega al celular al instante):** habla con `@BotFather`, crea un bot y copia el token.
  Crea un grupo "Tecnología", agrega al bot, escribe algo en el grupo y abre
  `https://api.telegram.org/botTOKEN/getUpdates` para ver el `chat.id` del grupo (empieza con `-`).
- **Correo:** cualquier servidor SMTP. Con Gmail usa una *contraseña de aplicación* (cuenta de Google → Seguridad → Contraseñas de aplicaciones),
  `smtp.gmail.com`, puerto 465. El correo incluye el informe completo con la evidencia.
- **Microsoft Teams:** en el canal, *Flujos de trabajo* → "Publicar en un canal cuando se recibe una solicitud de webhook", copia la URL y usa `"formato": "teams"`.
- **Slack / Discord:** URL del webhook entrante con `"formato": "slack"` o `"discord"`.
- **Otro sistema (tickets, SIEM):** `"formato": "json"` manda el incidente completo.

## Qué detecta

| Ataque | Dónde lo ve | Gravedad | Respuesta |
|---|---|---|---|
| Fuerza bruta SSH, prueba de usuarios | auth.log / journalctl | Alta | Bloquea |
| **Entrada exitosa desde una IP que venía atacando** (SSH, RDP) | auth.log / eventos de Windows | **Crítica** | Bloquea |
| Fuerza bruta a Escritorio Remoto y carpetas compartidas | eventos 4625 de Windows | Alta | Bloquea |
| Inyección SQL, ejecución remota de comandos, Log4Shell | access.log / IIS | Alta / Crítica | Bloquea |
| Lectura de archivos del sistema (path traversal), XSS | access.log / IIS | Alta / Media | Bloquea |
| Escáneres (sqlmap, nikto, nmap, nuclei...), búsqueda de `.env`, `.git`, `wp-login`, phpMyAdmin | access.log / IIS | Media | Bloquea |
| Fuerza bruta a un login web | access.log / IIS | Alta | Bloquea |
| Inundación de peticiones o de conexiones (DoS) | access.log / conexiones abiertas | Alta | Bloquea |
| Escaneo de puertos | registro del firewall (Windows o UFW) | Media | Bloquea |
| **Ransomware**: archivo señuelo tocado, extensiones de cifrado, notas de rescate | carpetas vigiladas | **Crítica** | Comando de emergencia |
| Cambios masivos de archivos | carpetas vigiladas | Alta | Aviso |
| Cambio en archivos críticos (`/etc/passwd`, `sudoers`, llaves SSH, `hosts`...) | integridad (SHA-256) | Alta | Aviso |
| Usuario nuevo, alguien agregado a administradores, servicio nuevo | eventos de Windows / Linux | Media / Alta | Aviso |
| Registro de seguridad borrado, antivirus apagado | eventos de Windows | **Crítica** | Aviso |
| Malware detectado por Windows Defender | eventos de Defender | Alta | Aviso |
| Intentos de entrar al panel de Centinela | el propio panel | Alta | Bloquea |
| Un equipo dejó de reportar | central | Alta | Aviso |

Si la misma IP dispara **3 reglas distintas en 24 horas**, Centinela sube la gravedad (ataque por varios frentes).
Las reglas están en `lib/reglas.js`; se pueden apagar (`reglasDesactivadas`) o cambiar sus umbrales (`ajustesReglas`).

## Celulares

Hay que ser claro con esto: **Android y iPhone no permiten** que una app lea los registros del sistema ni controle el firewall
(salvo con root o jailbreak, que los vuelve menos seguros). Por eso ningún producto serio vigila un celular como a un servidor.
Lo que sí hace Centinela con los celulares:

1. **El celular es la consola de seguridad.** Las alertas llegan por Telegram, y el panel se abre en el celular
   (en el navegador → *Agregar a pantalla de inicio* queda como app). Desde ahí se ve el incidente, la evidencia, se marca
   como investigando o resuelto y se bloquea o desbloquea una IP.
2. **Si un celular de la empresa está infectado y ataca** los servidores o PCs desde el WiFi, Centinela lo detecta,
   lo marca como "Red interna (un equipo de la propia red)" y lo bloquea.

Para **proteger** los celulares de la empresa lo correcto es complementar con:
- Un **MDM** (administración de dispositivos): *Google Endpoint Management* (viene con Google Workspace) o *Microsoft Intune*.
  Obligan bloqueo de pantalla y actualizaciones, detectan equipos con root y permiten **borrar el celular a distancia** si se pierde.
- **Google Play Protect** activado y no instalar apps fuera de la tienda.
- Un **DNS con filtro** en el WiFi de la oficina (NextDNS, AdGuard DNS o Pi-hole) que bloquee dominios de malware y phishing.

## Investigar registros viejos

```bash
node centinela.js --analizar /var/log/auth.log
node centinela.js --analizar /var/log/nginx/access.log.1 --informe informe.txt
node centinela.js --analizar C:\Windows\System32\LogFiles\Firewall\pfirewall.log
```

Usa la hora real de cada línea, lista los atacantes de más a menos actividad y, con `--informe`, guarda la evidencia completa
de cada incidente. No bloquea ni avisa.

## Proteger una aplicación hecha en Node.js

`lib/escudo.js` se pone delante de cualquier servidor Node (por ejemplo `servidor.js` de Mi Luz RD): rechaza las IPs que Centinela
bloqueó (aunque no haya permisos de firewall), limita las peticiones por IP y escribe un registro que Centinela analiza con las reglas web.

```js
const escudo = require('./centinela/lib/escudo')();
http.createServer(escudo((req, res) => { /* tu servidor */ })).listen(8090);
```

## Ransomware

```json
"archivos": { "carpetas": ["D:\\Compartida", "C:\\Users\\Contabilidad\\Documents"], "senuelos": true },
"respuesta": { "comandoEmergencia": ["netsh", "interface", "set", "interface", "Ethernet", "disable"] }
```

Centinela deja en cada carpeta un archivo señuelo (`000_no_borrar_centinela.docx`). Ninguna persona tiene motivo para modificarlo;
un ransomware que cifra la carpeta sí lo hace, y como empieza por orden alfabético, suele tocarlo de los primeros.
Al detectarlo se ejecuta el **comando de emergencia** (en Linux, por ejemplo, `["ip", "link", "set", "eth0", "down"]`)
para cortar la red antes de que cifre las carpetas compartidas de los demás equipos. Pruébalo antes: corta la red de verdad.

## Seguridad del propio Centinela

- `centinela.config.json` tiene tokens y claves: **no lo subas al repositorio** (ya está en `.gitignore`).
- Cada persona de tecnología puede tener su token (`panel.usuarios`); el registro `datos/auditoria.log` guarda quién bloqueó,
  desbloqueó o cerró cada incidente.
- No publiques el panel en internet. Si hace falta verlo fuera de la oficina, usa una VPN o ponlo detrás de nginx con HTTPS.
- Las IPs se validan antes de llegar al firewall y los comandos se ejecutan sin shell (no se puede inyectar nada a través de un registro).

## Límites (lo que no hace)

- **DDoS grandes** (miles de IPs a la vez): el bloqueo por IP no alcanza; hace falta Cloudflare u otro servicio anti-DDoS.
- No es un antivirus: en Windows se apoya en Windows Defender y alerta cuando detecta algo o cuando lo apagan.
- No revisa tráfico cifrado ni paquetes de red uno por uno (para eso existen Suricata o Zeek).
- Para una empresa grande o con requisitos de auditoría, conviene complementar con herramientas maduras como
  **Wazuh** (SIEM y agentes), **CrowdSec** (bloqueo con listas de IPs compartidas por la comunidad) o **Fail2ban**.
- Nada reemplaza lo básico: copias de seguridad fuera de la red, doble factor (2FA), contraseñas fuertes y equipos actualizados.

## Pruebas

```bash
npm test
```
