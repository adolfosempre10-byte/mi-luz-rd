'use strict';
// Reglas de deteccion. Cada regla dice: que buscar, cuantas veces en cuanto tiempo es un ataque,
// que tan grave es, si se bloquea la IP, la tecnica MITRE ATT&CK y que debe hacer el equipo de tecnologia.
//
// fuente: de donde salen las lineas
//   ssh              /var/log/auth.log, /var/log/secure (Linux)
//   web              access.log de nginx/apache, o el del escudo de Centinela (formato combinado)
//   iis              registros W3C de IIS (Windows)
//   windows          eventos de Windows (Security, System, Defender) que lee el detector de Windows
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
    umbral: { cantidad: 1, segundos: 60 }, bloquear: false,
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
    umbral: { cantidad: 1, segundos: 60 }, bloquear: false,
    detectar: porTexto(/EventID=4720 .*?TargetUserName=(?<usuario>\S*)/),
    recomendacion: 'Confirmar quien creo la cuenta. Si nadie la pidio, deshabilitarla.',
  },
  {
    id: 'win-admin-agregado', fuente: 'windows', titulo: 'Se agrego alguien a un grupo de administradores', severidad: 'alta', mitre: 'T1098',
    umbral: { cantidad: 1, segundos: 60 }, bloquear: false,
    detectar: porTexto(/EventID=4732 .*?TargetUserName=(?<usuario>\S*)/),
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
    umbral: { cantidad: 1, segundos: 60 }, bloquear: false,
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
    umbral: { cantidad: 1, segundos: 60 }, bloquear: false,
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

module.exports = { REGLAS, MITRE, cargarReglas, fuentesDe, RX };
