'use strict';
// Reglas de deteccion. Cada regla dice: que buscar, cuantas veces en cuanto tiempo es un ataque,
// que tan grave es, si se bloquea la IP, la tecnica MITRE ATT&CK y que debe hacer el equipo de tecnologia.
//
// fuente: de donde salen las lineas
//   ssh              /var/log/auth.log, /var/log/secure (Linux)
//   web              access.log de nginx/apache, o el del escudo de Centinela (formato combinado)
//   iis              registros W3C de IIS (Windows)
//   windows          eventos de Windows (Security, System, Defender) que lee el detector de Windows
//   sysmon           eventos de Sysmon (llegan por el detector de Windows; el motor los separa)
//   firewall-windows pfirewall.log con paquetes DROP
//   firewall-linux   kern.log / syslog con paquetes bloqueados por UFW o por la regla LOG "CENTINELA-SCAN"
//   red, archivos, panel, central: los generan los detectores internos

/** Ayuda: regla basada en expresiones regulares con grupos con nombre (ip, usuario, puerto...). */
function porTexto(...patrones) {
  return (linea) => {
    for (const p of patrones) {
      const m = p.exec(linea);
      if (m) {
        const g = m.groups || {};
        return { ip: g.ip, usuario: g.usuario, clave: g.puerto || g.usuario || g.archivo, detalle: g.detalle };
      }
    }
    return null;
  };
}

/** Ayuda: regla web; recibe la peticion ya separada en partes. */
function porPeticion(prueba, clave) {
  return (p) => (prueba(p) ? { ip: p.ip, clave: clave ? clave(p) : undefined, detalle: `${p.metodo} ${p.ruta} -> ${p.estado}` } : null);
}

/** Ayuda: regla de Sysmon sobre la creacion de un proceso (evento 1). */
function porProceso(prueba, clave) {
  return (e) => (e.evento === 1 && prueba(e)
    ? { usuario: e.usuario, pid: e.pid, imagen: e.imagen, clave: clave ? clave(e) : e.cmd, detalle: `${e.padreImg || '?'} -> ${e.comando}`.slice(0, 1000) }
    : null);
}

const OFFICE = /^(winword|excel|powerpnt|outlook|onenote|msaccess|mspub|visio)\.exe$/;
const CONSOLAS = /^(cmd|powershell|pwsh|wscript|cscript|mshta|rundll32|regsvr32|certutil|bitsadmin|schtasks|wmic|msiexec|curl)\.exe$/;
const RECONOCIMIENTO = /^(whoami|systeminfo|ipconfig|nltest|net|net1|quser|qwinsta|arp|tasklist|nbtstat|route|dsquery|klist|cmdkey|getmac|hostname)\.exe$/;
const ACCESOS_LSASS = new Set(['0x1010', '0x1410', '0x1438', '0x143a', '0x1fffff', '0x1f3fff', '0x1f1fff', '0x1f0fff', '0x40']);
const LECTORES_LSASS = /^(msmpeng|csrss|wininit|svchost|wmiprvse|vmtoolsd|mrt|securityhealthservice|lsm|services|mssense|sensecncproxy)\.exe$/;
const RXS = {
  borrarCopias: /(vssadmin(\.exe)?"?\s+(delete\s+shadows|resize\s+shadowstorage)|shadowcopy\s+delete|wbadmin(\.exe)?"?\s+delete\s+(catalog|systemstatebackup|backup)|bcdedit(\.exe)?.*(recoveryenabled\s+no|bootstatuspolicy\s+ignoreallfailures)|win32_shadowcopy.*(delete|remove-ciminstance|remove-wmiobject))/,
  credenciales: /(mimikatz|sekurlsa|lsadump|procdump(64)?(\.exe)?.*lsass|comsvcs(\.dll)?.*(minidump|#24)|lsass.*\.dmp|ntdsutil.*ifm|\\ntds\.dit|reg(\.exe)?"?\s+save\s+hklm\\(sam|security|system)\b)/,
  apagarDefensas: /(set-mppreference.*-disable(realtimemonitoring|behaviormonitoring|ioavprotection|scriptscanning|blockatfirstseen)\s+(\$?true|1)|add-mppreference.*-exclusion(path|process|extension)|netsh(\.exe)?"?\s+(advfirewall\s+set\s+\w+\s+state\s+off|firewall\s+set\s+opmode\s+(mode=)?disable)|sc(\.exe)?"?\s+(stop|config|delete)\s+(windefend|sense|wdnissvc|wscsvc|sysmon64|sysmon|mpssvc)\b|(stop|set)-service.*(windefend|sysmon|mpssvc)|fltmc(\.exe)?"?\s+unload|sysmon(64)?(\.exe)?"?\s+-u\b|disableantispyware)/,
  borrarRegistros: /(wevtutil(\.exe)?"?\s+(cl|clear-log)\b|clear-eventlog|remove-eventlog|fsutil(\.exe)?"?\s+usn\s+deletejournal)/,
  usuarios: /(\bnet1?(\.exe)?"?\s+user\s+.+\s\/add\b|new-localuser\b|\bnet1?(\.exe)?"?\s+(localgroup|group)\s+"?(administrators|administradores|domain admins|admins\. del dominio|remote desktop users|usuarios de escritorio remoto)"?\s+.*\/add\b|add-localgroupmember.*(administrators|administradores|remote desktop|escritorio remoto))/,
  tareas: /(schtasks(\.exe)?"?\s+\/create\b|register-scheduledtask|new-scheduledtask|\bsc(\.exe)?"?\s+create\s|new-service\s)/,
  powershell: /(\s-e(nc|ncodedcommand|c)?\s+[a-z0-9+\/=]{20,}|frombase64string|downloadstring|downloadfile|invoke-webrequest|\biwr\s|invoke-restmethod|\birm\s|invoke-expression|\biex\b|net\.webclient|start-bitstransfer|\s-w(indowstyle)?\s+h(idden)?\b|amsiutils|amsiinitfailed|reflection\.assembly\]::load|invoke-mimikatz|invoke-shellcode)/,
  lolbins: /(certutil(\.exe)?"?.*\s[-\/](urlcache|verifyctl|decode)\b|bitsadmin(\.exe)?"?.*\/transfer|mshta(\.exe)?"?\s+"?(https?:|javascript:|vbscript:)|regsvr32(\.exe)?"?.*\/i:\s*https?|rundll32(\.exe)?"?.*(javascript:|url\.dll,|shell32\.dll,shellexec_rundll)|msiexec(\.exe)?"?.*\/q.*https?:|wmic(\.exe)?"?.*(process\s+call\s+create|\/format:\s*"?https?)|curl(\.exe)?"?\s.*https?:.*\s-o\s.*\\(temp|appdata|users\\public|programdata)\\)/,
};

/** Valor de un campo "Nombre=valor" en una linea de evento de Windows (el valor puede tener espacios). */
function campo(linea, nombre) {
  const m = new RegExp(`(?:^| )${nombre}=(.*?)(?= [A-Za-z]+=|$)`).exec(linea);
  return m ? m[1].trim() : '';
}

/** Grupos locales con privilegios, por SID (no cambian con el idioma de Windows). */
const GRUPOS_PELIGROSOS = {
  'S-1-5-32-544': 'Administradores', 'S-1-5-32-555': 'Usuarios de escritorio remoto', 'S-1-5-32-551': 'Operadores de copia de seguridad',
  'S-1-5-32-549': 'Operadores de servidores', 'S-1-5-32-548': 'Operadores de cuentas', 'S-1-5-32-578': 'Administradores de Hyper-V',
  'S-1-5-32-562': 'Usuarios COM distribuidos', 'S-1-5-32-580': 'Usuarios de administracion remota',
};

const RX = {
  escaneo: /(\/\.env\b|\/\.git\/|wp-login\.php|xmlrpc\.php|\/wp-admin|\/wp-content\/plugins|phpmyadmin|\/pma\/|\/admin\.php|\/cgi-bin\/|phpunit|\/boaform|\/hnap1|\/actuator|\/\.aws|\/\.ssh|\/config\.(php|json|ya?ml)|\/server-status|\.(bak|sql|old|swp)$|\/backup|\/shell\.php|\/solr\/|\/manager\/html|\/owa\/|\/autodiscover|\/vendor\/|\/telescope|\/_profiler|\/druid\/|\/console\/)/,
  sqli: /(union(\s|\/\*.*?\*\/)+(all\s+)?select|'\s*(or|and)\s+'?\w+'?\s*=\s*'?\w|\bor\s+1\s*=\s*1|sleep\s*\(\s*\d|benchmark\s*\(|information_schema|waitfor\s+delay|;\s*drop\s+table|\bpg_sleep\b|extractvalue\s*\(|updatexml\s*\()/,
  xss: /(<script|javascript:|onerror\s*=|onload\s*=|<svg[^>]*\son\w+\s*=|document\.cookie|<iframe|alert\s*\(|prompt\s*\()/,
  recorrido: /(\.\.\/|\.\.\\|\/etc\/passwd|\/etc\/shadow|win\.ini|boot\.ini|\/proc\/self|c:\\windows)/,
  ejecucion: /(\$\{jndi:|\$\{\$\{|;\s*(wget|curl|bash|sh|nc|chmod|rm)\s|\|\s*(sh|bash)\b|\$\((wget|curl|id|whoami|cat|uname)|cmd\.exe|powershell(\.exe)?\s+-|\/bin\/(ba)?sh\b|<\?php|base64_decode\s*\(|eval\s*\()/,
  herramientas: /(sqlmap|nikto|nmap|masscan|zgrab|nuclei|wpscan|dirbuster|gobuster|ffuf|feroxbuster|acunetix|nessus|openvas|w3af|hydra|havij|netsparker|whatweb|jaeles|xray\/)/,
  login: /(login|signin|sign-in|auth|wp-login|session|token|ingresar|entrar)/,
};

const REGLAS = [
  // ---------------- SSH / Linux ----------------
  {
    id: 'ssh-fuerza-bruta', fuente: 'ssh', titulo: 'Fuerza bruta contra SSH', severidad: 'alta', mitre: 'T1110',
    umbral: { cantidad: 6, segundos: 300 }, bloquear: true,
    detectar: porTexto(/Failed (?:password|publickey|keyboard-interactive\/pam) for (?:invalid user )?(?<usuario>\S*) from (?<ip>\S+)/),
    recomendacion: 'Desactivar la clave por contraseña en SSH (PasswordAuthentication no) y usar solo llaves. Cambiar el puerto o limitar SSH a la VPN. Revisar que ningun usuario tenga clave debil.',
  },
  {
    id: 'ssh-usuarios-inexistentes', fuente: 'ssh', titulo: 'Prueba de nombres de usuario en SSH', severidad: 'media', mitre: 'T1110.003',
    umbral: { cantidad: 4, segundos: 600 }, distinto: true, bloquear: true,
    detectar: porTexto(/Invalid user (?<usuario>\S*) from (?<ip>\S+)/),
    recomendacion: 'El atacante esta probando nombres de usuario. Confirmar que no exista ninguno de esos usuarios con clave debil.',
  },
  {
    id: 'ssh-acceso-tras-ataque', fuente: 'ssh', titulo: 'Entrada exitosa por SSH desde una IP atacante', severidad: 'critica', mitre: 'T1078',
    umbral: { cantidad: 1, segundos: 60 }, soloSiPrevio: true, bloquear: true,
    detectar: porTexto(/Accepted (?:password|publickey|keyboard-interactive\/pam) for (?<usuario>\S+) from (?<ip>\S+)/),
    recomendacion: 'POSIBLE INTRUSION. Cambiar de inmediato la clave del usuario, cerrar sus sesiones (pkill -u usuario), revisar ~/.ssh/authorized_keys, crontab, procesos y usuarios nuevos. Considerar aislar el servidor.',
  },
  {
    id: 'linux-usuario-creado', fuente: 'ssh', titulo: 'Se creo un usuario nuevo en Linux', severidad: 'media', mitre: 'T1136.001',
    separarPorClave: true, umbral: { cantidad: 1, segundos: 60 }, bloquear: false,
    detectar: porTexto(/useradd\[\d+\]: new user: name=(?<usuario>[^,\s]+)/),
    recomendacion: 'Confirmar con el equipo quien creo el usuario. Si nadie lo hizo, es señal de persistencia de un intruso.',
  },
  {
    id: 'linux-sudo-fallido', fuente: 'ssh', titulo: 'Intentos fallidos de sudo (subir a administrador)', severidad: 'media', mitre: 'T1548.003',
    umbral: { cantidad: 3, segundos: 300 }, bloquear: false,
    detectar: porTexto(/sudo:\s+(?<usuario>\S+) : (?:\d+ )?incorrect password attempts?/, /sudo:.*authentication failure;.*user=(?<usuario>\S+)/),
    recomendacion: 'Alguien con sesion en el servidor intenta volverse administrador. Verificar quien es ese usuario y desde donde entro.',
  },

  // ---------------- Web (nginx, apache, IIS, escudo) ----------------
  {
    id: 'web-ejecucion-remota', fuente: 'web', titulo: 'Intento de ejecucion de comandos (RCE / Log4Shell)', severidad: 'critica', mitre: 'T1190',
    umbral: { cantidad: 1, segundos: 60 }, bloquear: true,
    detectar: porPeticion((p) => RX.ejecucion.test(p.texto)),
    recomendacion: 'Revisar si la peticion tuvo respuesta 200. Actualizar el servidor web, frameworks y librerias (Log4j, PHP). Buscar archivos nuevos en la carpeta web (webshells).',
  },
  {
    id: 'web-inyeccion-sql', fuente: 'web', titulo: 'Intento de inyeccion SQL', severidad: 'alta', mitre: 'T1190',
    umbral: { cantidad: 2, segundos: 300 }, bloquear: true,
    detectar: porPeticion((p) => RX.sqli.test(p.texto)),
    recomendacion: 'Verificar que la aplicacion use consultas parametrizadas. Revisar los registros de la base de datos en el mismo horario por consultas raras o lecturas masivas.',
  },
  {
    id: 'web-recorrido-rutas', fuente: 'web', titulo: 'Intento de leer archivos del sistema (path traversal)', severidad: 'alta', mitre: 'T1083',
    umbral: { cantidad: 2, segundos: 300 }, bloquear: true,
    detectar: porPeticion((p) => RX.recorrido.test(p.texto)),
    recomendacion: 'Comprobar si alguna de esas peticiones respondio 200 (fuga de archivos). Corregir el manejo de rutas en la aplicacion.',
  },
  {
    id: 'web-xss', fuente: 'web', titulo: 'Intento de inyectar codigo en la pagina (XSS)', severidad: 'media', mitre: 'T1189',
    umbral: { cantidad: 2, segundos: 300 }, bloquear: true,
    detectar: porPeticion((p) => RX.xss.test(p.texto)),
    recomendacion: 'Confirmar que la aplicacion escapa lo que muestra y que tiene cabecera Content-Security-Policy.',
  },
  {
    id: 'web-herramienta-ataque', fuente: 'web', titulo: 'Herramienta de ataque o escaner detectada', severidad: 'media', mitre: 'T1595.002',
    umbral: { cantidad: 1, segundos: 60 }, bloquear: true,
    detectar: porPeticion((p) => RX.herramientas.test(p.agente)),
    recomendacion: 'Un escaner automatico esta buscando fallas. Es el paso previo a un ataque: revisar actualizaciones pendientes.',
  },
  {
    id: 'web-escaneo-vulnerabilidades', fuente: 'web', titulo: 'Busqueda de paginas vulnerables (escaneo)', severidad: 'media', mitre: 'T1595.003',
    umbral: { cantidad: 4, segundos: 120 }, distinto: true, bloquear: true,
    detectar: porPeticion((p) => RX.escaneo.test(p.rutaMin), (p) => p.rutaMin),
    recomendacion: 'Asegurar que no haya archivos .env, .git, copias de seguridad o paneles de administracion expuestos a internet.',
  },
  {
    id: 'web-escaneo-404', fuente: 'web', titulo: 'Muchas paginas inexistentes (busqueda de directorios)', severidad: 'media', mitre: 'T1595.003',
    umbral: { cantidad: 40, segundos: 120 }, distinto: true, bloquear: true,
    detectar: porPeticion((p) => p.estado === 404, (p) => p.rutaMin),
    recomendacion: 'Escaneo de directorios. Revisar que no haya carpetas sensibles publicadas.',
  },
  {
    id: 'web-fuerza-bruta-login', fuente: 'web', titulo: 'Fuerza bruta contra el inicio de sesion web', severidad: 'alta', mitre: 'T1110',
    umbral: { cantidad: 15, segundos: 300 }, bloquear: true,
    detectar: porPeticion((p) => p.estado === 401 || ((p.estado === 403 || p.metodo === 'POST') && RX.login.test(p.rutaMin) && p.estado >= 400)),
    recomendacion: 'Activar bloqueo de cuenta tras varios intentos, captcha y doble factor (2FA) en el inicio de sesion.',
  },
  {
    id: 'web-inundacion', fuente: 'web', titulo: 'Inundacion de peticiones (posible DoS)', severidad: 'alta', mitre: 'T1499',
    umbral: { cantidad: 200, segundos: 10 }, bloquear: true,
    detectar: porPeticion(() => true),
    recomendacion: 'Si el ataque viene de muchas IPs a la vez (DDoS) el bloqueo por IP no alcanza: poner el sitio detras de Cloudflare u otro servicio anti-DDoS y avisar al proveedor de internet.',
  },

  // ---------------- Windows (eventos) ----------------
  {
    id: 'win-fuerza-bruta', fuente: 'windows', titulo: 'Fuerza bruta contra Windows (RDP / carpetas compartidas)', severidad: 'alta', mitre: 'T1110',
    umbral: { cantidad: 8, segundos: 300 }, bloquear: true,
    detectar: porTexto(/EventID=4625 .*?IpAddress=(?<ip>[0-9a-fA-F.:]+) .*?TargetUserName=(?<usuario>\S*)/),
    recomendacion: 'No exponer Escritorio Remoto (3389) a internet: usar VPN. Activar bloqueo de cuenta y NLA. Revisar claves de los usuarios atacados.',
  },
  {
    id: 'win-acceso-tras-ataque', fuente: 'windows', titulo: 'Entrada exitosa a Windows desde una IP atacante', severidad: 'critica', mitre: 'T1078',
    umbral: { cantidad: 1, segundos: 60 }, soloSiPrevio: true, bloquear: true,
    detectar: porTexto(/EventID=4624 .*?IpAddress=(?<ip>[0-9a-fA-F.:]+) .*?TargetUserName=(?<usuario>\S*) LogonType=(?:3|10)\b/),
    recomendacion: 'POSIBLE INTRUSION. Desconectar el equipo de la red, cambiar la clave del usuario, revisar programas, tareas programadas y servicios nuevos.',
  },
  {
    id: 'win-registro-borrado', fuente: 'windows', titulo: 'Se borro el registro de seguridad de Windows', severidad: 'critica', mitre: 'T1070.001',
    umbral: { cantidad: 1, segundos: 60 }, bloquear: false,
    detectar: porTexto(/EventID=1102\b.*?SubjectUserName=(?<usuario>\S*)/, /EventID=1102\b/),
    recomendacion: 'Borrar el registro es tipico de un intruso que oculta huellas. Investigar quien lo hizo y revisar el equipo completo.',
  },
  {
    id: 'win-usuario-creado', fuente: 'windows', titulo: 'Se creo un usuario nuevo en Windows', severidad: 'media', mitre: 'T1136.001',
    separarPorClave: true, umbral: { cantidad: 1, segundos: 60 }, bloquear: false,
    detectar: (l) => {
      if (!/EventID=4720\b/.test(l)) return null;
      const usuario = campo(l, 'TargetUserName');
      const quien = campo(l, 'SubjectUserName');
      return { usuario, clave: usuario, detalle: `Usuario "${usuario}" creado${quien && quien !== '-' ? ` por ${quien}` : ''}` };
    },
    recomendacion: 'Confirmar quien creo la cuenta. Si nadie la pidio, deshabilitarla.',
  },
  {
    id: 'win-admin-agregado', fuente: 'windows', titulo: 'Se agrego alguien a un grupo con privilegios (administradores, escritorio remoto...)', severidad: 'alta', mitre: 'T1098',
    separarPorClave: true, umbral: { cantidad: 1, segundos: 60 }, bloquear: false,
    detectar: (l) => {
      if (!/EventID=4732\b/.test(l)) return null;
      const grupo = campo(l, 'TargetUserName');
      const sid = campo(l, 'TargetSid');
      // Se reconoce el grupo por su SID (igual en Windows en español o en inglés); sin SID, por el nombre.
      const peligroso = sid ? GRUPOS_PELIGROSOS[sid] : (/administra|escritorio remoto|remote desktop|backup|copia de seguridad/i.test(grupo) ? grupo : null);
      if (!peligroso) return null; // por ejemplo: el usuario nuevo entra al grupo "Usuarios" (normal)
      const miembro = campo(l, 'Member') || campo(l, 'MemberSid') || '?';
      const quien = campo(l, 'SubjectUserName');
      return { usuario: miembro, clave: `${miembro}>${grupo}`, detalle: `${miembro} agregado al grupo "${grupo || peligroso}"${quien && quien !== '-' ? ` por ${quien}` : ''}` };
    },
    recomendacion: 'Verificar que el cambio de permisos este autorizado.',
  },
  {
    id: 'win-cuenta-bloqueada', fuente: 'windows', titulo: 'Cuenta de Windows bloqueada por intentos fallidos', severidad: 'media', mitre: 'T1110',
    umbral: { cantidad: 1, segundos: 60 }, bloquear: false,
    detectar: porTexto(/EventID=4740 .*?TargetUserName=(?<usuario>\S*)/),
    recomendacion: 'Averiguar desde que equipo vienen los intentos (evento 4625) antes de desbloquear la cuenta.',
  },
  {
    id: 'win-servicio-nuevo', fuente: 'windows', titulo: 'Se instalo un servicio nuevo en Windows', severidad: 'media', mitre: 'T1543.003',
    separarPorClave: true, umbral: { cantidad: 1, segundos: 60 }, bloquear: false,
    detectar: porTexto(/EventID=7045 .*?ServiceName=(?<usuario>.*?) ImagePath=(?<detalle>.*)$/),
    recomendacion: 'Revisar la ruta del programa del servicio. Servicios desde carpetas temporales o con PowerShell codificado son sospechosos.',
  },
  {
    id: 'win-malware', fuente: 'windows', titulo: 'Windows Defender detecto malware', severidad: 'alta', mitre: 'T1204',
    umbral: { cantidad: 1, segundos: 60 }, bloquear: false,
    detectar: porTexto(/EventID=111[67] .*?Threat=(?<usuario>.*?) Path=(?<detalle>.*)$/),
    recomendacion: 'Hacer un escaneo completo del equipo, ver de donde vino el archivo (correo, USB, descarga) y revisar otros equipos.',
  },
  {
    id: 'win-defender-apagado', fuente: 'windows', titulo: 'Se apago la proteccion de Windows Defender', severidad: 'critica', mitre: 'T1562.001',
    umbral: { cantidad: 1, segundos: 60 }, bloquear: false,
    detectar: porTexto(/EventID=(?:5001|5010|5012)\b/),
    recomendacion: 'Los atacantes apagan el antivirus antes de actuar. Reactivarlo y revisar el equipo de inmediato.',
  },

  // ---------------- Sysmon (procesos, credenciales, persistencia) ----------------
  // Requiere Sysmon instalado en el equipo Windows. "terminar: true" = Centinela corta el proceso (taskkill).
  {
    id: 'sysmon-office-lanza-consola', fuente: 'sysmon', titulo: 'Office abrio una consola o script (documento malicioso)', severidad: 'critica', mitre: 'T1204.002',
    umbral: { cantidad: 1, segundos: 60 }, bloquear: false, terminar: true,
    detectar: porProceso((e) => OFFICE.test(e.padreImg) && CONSOLAS.test(e.img)),
    recomendacion: 'Un documento de Word/Excel/Outlook ejecuto comandos: casi siempre es un adjunto malicioso (macro). Desconectar el equipo, ubicar el documento y el correo de donde vino, y avisar a los demas usuarios que no lo abran.',
  },
  {
    id: 'sysmon-borrar-copias', fuente: 'sysmon', titulo: 'RANSOMWARE: se estan borrando las copias de seguridad de Windows', severidad: 'critica', mitre: 'T1490',
    umbral: { cantidad: 1, segundos: 60 }, bloquear: false, terminar: true, emergencia: true,
    detectar: porProceso((e) => RXS.borrarCopias.test(e.cmd)),
    recomendacion: 'Borrar las instantaneas (vssadmin/wbadmin) es el paso previo a cifrar los archivos. DESCONECTAR EL EQUIPO DE LA RED YA, sin apagarlo, y revisar los demas equipos.',
  },
  {
    id: 'sysmon-robo-credenciales', fuente: 'sysmon', titulo: 'Intento de robar claves de la memoria (lsass / SAM)', severidad: 'critica', mitre: 'T1003.001',
    umbral: { cantidad: 1, segundos: 60 }, bloquear: false, terminar: true,
    detectar: (e) => {
      if (e.evento === 10 && /lsass\.exe$/i.test(e.destino) && ACCESOS_LSASS.has(e.acceso) && !LECTORES_LSASS.test(e.img)) {
        return { usuario: e.usuario, pid: e.pid, imagen: e.imagen, clave: e.imagen, detalle: `${e.imagen} abrio lsass.exe con acceso ${e.acceso}` };
      }
      return porProceso((x) => RXS.credenciales.test(x.cmd))(e);
    },
    recomendacion: 'Alguien intenta sacar las claves guardadas en memoria (Mimikatz, procdump, comsvcs). Aislar el equipo y cambiar las claves de TODAS las cuentas que hayan iniciado sesion en el, empezando por administradores.',
  },
  {
    id: 'sysmon-apagar-defensas', fuente: 'sysmon', titulo: 'Intento de apagar el antivirus, el firewall o Sysmon', severidad: 'critica', mitre: 'T1562.001',
    umbral: { cantidad: 1, segundos: 60 }, bloquear: false, terminar: true,
    detectar: porProceso((e) => RXS.apagarDefensas.test(e.cmd)),
    recomendacion: 'Los atacantes apagan las defensas antes de actuar. Verificar que Defender, el firewall y Sysmon sigan activos y revisar quien ejecuto el comando.',
  },
  {
    id: 'sysmon-borrar-registros', fuente: 'sysmon', titulo: 'Comando para borrar los registros de eventos', severidad: 'critica', mitre: 'T1070.001',
    umbral: { cantidad: 1, segundos: 60 }, bloquear: false,
    detectar: porProceso((e) => RXS.borrarRegistros.test(e.cmd)),
    recomendacion: 'Borrar los registros es ocultar huellas. Revisar el equipo completo; la evidencia que Centinela ya guardo sigue en el panel.',
  },
  {
    id: 'sysmon-usuario-por-comando', fuente: 'sysmon', titulo: 'Usuario creado o hecho administrador por linea de comandos', severidad: 'alta', mitre: 'T1136.001',
    umbral: { cantidad: 1, segundos: 60 }, bloquear: false,
    detectar: porProceso((e) => RXS.usuarios.test(e.cmd), (e) => e.cmd.replace(/^"?[^"]*?net1?(\.exe)?"?\s+/, 'net ')),
    recomendacion: 'Confirmar quien creo la cuenta y para que. Si nadie la pidio, deshabilitarla y buscar como entro el intruso (es tipico crear un usuario "soporte" o "admin" para volver despues).',
  },
  {
    id: 'sysmon-tarea-programada', fuente: 'sysmon', titulo: 'Tarea programada o servicio creado por comando', severidad: 'media', mitre: 'T1053.005',
    separarPorClave: true, umbral: { cantidad: 1, segundos: 60 }, bloquear: false,
    detectar: porProceso((e) => RXS.tareas.test(e.cmd)),
    recomendacion: 'Revisar que ejecuta la tarea o servicio y cada cuanto. Si apunta a AppData, Temp, Public o a PowerShell oculto/codificado, es persistencia de un intruso.',
  },
  {
    id: 'sysmon-powershell-sospechoso', fuente: 'sysmon', titulo: 'PowerShell sospechoso (codificado, oculto o descargando)', severidad: 'alta', mitre: 'T1059.001',
    umbral: { cantidad: 1, segundos: 60 }, bloquear: false,
    detectar: porProceso((e) => /^(powershell|powershell_ise|pwsh)\.exe$/.test(e.img) && RXS.powershell.test(e.cmd)),
    recomendacion: 'Decodificar el comando (si viene en Base64) y ver que descarga o ejecuta. Revisar que proceso lo lanzo (ParentImage).',
  },
  {
    id: 'sysmon-binario-del-sistema', fuente: 'sysmon', titulo: 'Programa de Windows usado para descargar o ejecutar codigo', severidad: 'alta', mitre: 'T1218',
    umbral: { cantidad: 1, segundos: 60 }, bloquear: false,
    detectar: porProceso((e) => RXS.lolbins.test(e.cmd)),
    recomendacion: 'certutil, mshta, regsvr32, bitsadmin o rundll32 usados asi son tecnica tipica para colar malware. Ver que URL o archivo usaron y bloquear ese dominio.',
  },
  {
    id: 'sysmon-reconocimiento', fuente: 'sysmon', titulo: 'Reconocimiento: muchos comandos para conocer el equipo y la red', severidad: 'media', mitre: 'T1082',
    umbral: { cantidad: 5, segundos: 300 }, distinto: true, bloquear: false,
    detectar: porProceso((e) => RECONOCIMIENTO.test(e.img) && !/\/add\b/.test(e.cmd), (e) => `${e.img} ${e.cmd.split(' ')[1] || ''}`),
    recomendacion: 'Alguien ejecuto seguidos whoami, ipconfig, net user, systeminfo... Es lo primero que hace un intruso al entrar. Confirmar si fue alguien de soporte.',
  },
  {
    id: 'sysmon-arranque-automatico', fuente: 'sysmon', titulo: 'Programa agregado al arranque de Windows', severidad: 'media', mitre: 'T1547.001',
    separarPorClave: true, umbral: { cantidad: 1, segundos: 60 }, bloquear: false,
    detectar: (e) => ((e.evento === 13 || e.evento === 11) && e.destino
      ? { usuario: e.usuario, pid: e.pid, imagen: e.imagen, clave: e.destino, detalle: `${e.imagen} -> ${e.destino} ${e.detalles}`.trim() }
      : null),
    recomendacion: 'Revisar el programa que se agrego al arranque (Run, Winlogon o carpeta Inicio). Si no es software conocido, quitarlo y analizar el archivo.',
  },

  // ---------------- Escaneo de puertos (firewall) ----------------
  {
    id: 'red-escaneo-puertos', fuente: 'firewall-windows', titulo: 'Escaneo de puertos', severidad: 'media', mitre: 'T1046',
    umbral: { cantidad: 12, segundos: 120 }, distinto: true, bloquear: true,
    detectar: porTexto(/^\S+ \S+ DROP (?:TCP|UDP) (?<ip>\S+) \S+ \d+ (?<puerto>\d+)/),
    recomendacion: 'Alguien esta mapeando que servicios tiene el equipo. Cerrar en el firewall todo puerto que no se use.',
  },
  {
    id: 'red-escaneo-puertos-linux', fuente: 'firewall-linux', titulo: 'Escaneo de puertos', severidad: 'media', mitre: 'T1046',
    umbral: { cantidad: 12, segundos: 120 }, distinto: true, bloquear: true,
    detectar: porTexto(/(?:CENTINELA-SCAN|\[UFW BLOCK\]).*? SRC=(?<ip>\S+) .*?DPT=(?<puerto>\d+)/),
    recomendacion: 'Alguien esta mapeando que servicios tiene el servidor. Cerrar en el firewall todo puerto que no se use.',
  },

  // ---------------- Generadas por detectores internos ----------------
  {
    id: 'red-inundacion-conexiones', fuente: 'red', titulo: 'Demasiadas conexiones desde una IP (posible DoS)', severidad: 'alta', mitre: 'T1498',
    umbral: { cantidad: 1, segundos: 60 }, bloquear: true,
    recomendacion: 'Si son muchas IPs a la vez es un DDoS: contactar al proveedor de internet o usar un servicio anti-DDoS.',
  },
  {
    id: 'archivo-critico-modificado', fuente: 'archivos', titulo: 'Cambio en un archivo critico', severidad: 'alta', mitre: 'T1565.001',
    separarPorClave: true, umbral: { cantidad: 1, segundos: 60 }, bloquear: false,
    recomendacion: 'Confirmar si alguien del equipo hizo el cambio. Si no, comparar con la copia de seguridad y buscar como entro el intruso.',
  },
  {
    id: 'ransomware-senuelo', fuente: 'archivos', titulo: 'RANSOMWARE: se toco un archivo señuelo', severidad: 'critica', mitre: 'T1486',
    umbral: { cantidad: 1, segundos: 60 }, bloquear: false, emergencia: true,
    recomendacion: 'DESCONECTAR EL EQUIPO DE LA RED YA (cable y WiFi) sin apagarlo. Avisar a todos que no abran archivos compartidos. Verificar que las copias de seguridad esten fuera de la red.',
  },
  {
    id: 'ransomware-extension', fuente: 'archivos', titulo: 'RANSOMWARE: archivos con extension de cifrado o nota de rescate', severidad: 'critica', mitre: 'T1486',
    umbral: { cantidad: 3, segundos: 120 }, distinto: true, bloquear: false, emergencia: true,
    recomendacion: 'DESCONECTAR EL EQUIPO DE LA RED YA. No pagar el rescate. Identificar el proceso que cifra y conservar la nota de rescate para la investigacion.',
  },
  {
    id: 'ransomware-cambios-masivos', fuente: 'archivos', titulo: 'Cambios masivos de archivos (posible cifrado)', severidad: 'alta', mitre: 'T1486',
    umbral: { cantidad: 300, segundos: 60 }, distinto: true, bloquear: false,
    recomendacion: 'Revisar que programa esta modificando tantos archivos. Si no es una copia de seguridad o sincronizacion conocida, desconectar el equipo.',
  },
  {
    id: 'panel-fuerza-bruta', fuente: 'panel', titulo: 'Intentos de entrar al panel de Centinela', severidad: 'alta', mitre: 'T1110',
    umbral: { cantidad: 5, segundos: 300 }, bloquear: true,
    recomendacion: 'Alguien intenta entrar al panel de seguridad. Cambiar el token del panel si hay dudas y no exponer el panel a internet.',
  },
  {
    id: 'agente-sin-reportar', fuente: 'central', titulo: 'Un equipo dejo de reportar a Centinela', severidad: 'alta', mitre: 'T1562.001',
    umbral: { cantidad: 1, segundos: 60 }, bloquear: false,
    recomendacion: 'El equipo se apago, perdio internet o alguien detuvo Centinela. Si nadie lo apago, revisarlo: los intrusos detienen la vigilancia antes de actuar.',
  },
];

// Las reglas web tambien sirven para los registros de IIS.
const MITRE = {
  T1046: 'Descubrimiento de servicios de red', T1078: 'Uso de cuentas validas', T1083: 'Descubrimiento de archivos',
  T1098: 'Manipulacion de cuentas', T1110: 'Fuerza bruta', 'T1110.003': 'Rociado de contraseñas',
  'T1136.001': 'Creacion de cuenta local', T1189: 'Compromiso por navegacion', T1190: 'Explotacion de aplicacion publica',
  T1204: 'Ejecucion por el usuario', T1486: 'Datos cifrados para impacto (ransomware)', T1498: 'Denegacion de servicio de red',
  T1499: 'Denegacion de servicio en el equipo', 'T1543.003': 'Servicio de Windows', 'T1548.003': 'Abuso de sudo',
  'T1562.001': 'Desactivar defensas', 'T1565.001': 'Manipulacion de datos guardados', 'T1595.002': 'Escaneo de vulnerabilidades',
  'T1595.003': 'Escaneo con listas de palabras', 'T1070.001': 'Borrar registros de Windows',
  'T1204.002': 'Archivo malicioso abierto por el usuario', T1490: 'Inhibir la recuperacion del sistema', 'T1003.001': 'Robo de credenciales de LSASS',
  'T1053.005': 'Tarea programada', 'T1059.001': 'PowerShell', T1218: 'Binarios de Windows usados para atacar',
  T1082: 'Reconocimiento del sistema', 'T1547.001': 'Arranque automatico (Run / carpeta Inicio)',
};

function cargarReglas(desactivadas = [], ajustes = {}) {
  const mapa = new Map();
  for (const r of REGLAS) {
    if (desactivadas.includes(r.id)) continue;
    const a = ajustes[r.id] || {};
    mapa.set(r.id, { ...r, ...a, umbral: { ...r.umbral, ...(a.umbral || {}) } });
  }
  return mapa;
}

const fuentesDe = (fuente) => (fuente === 'iis' ? 'web' : fuente);

module.exports = { REGLAS, MITRE, cargarReglas, fuentesDe, RX, RXS };
