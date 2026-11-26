#!/usr/bin/env python3
"""
Detector de camaras ocultas en la red Wi-Fi.

Revisa todos los equipos conectados a tu misma red y te dice cuales
parecen camaras (IP, Wi-Fi, "camaras espia"), y por que.

No necesita instalar nada: solo Python 3.8 o mas nuevo.
Uso:
    python detector_camaras.py                 (revisa tu red automaticamente)
    python detector_camaras.py --red 192.168.1.0/24
    python detector_camaras.py --sin-navegador (no abre el informe)

Usalo solo en redes donde tienes permiso: tu casa, tu negocio, o el
alojamiento donde te estas quedando para revisar que no te graben.
"""

import argparse
import concurrent.futures as cf
import datetime as dt
import html
import ipaddress
import os
import re
import socket
import subprocess
import sys
import time
import urllib.request
import webbrowser

# ---------------------------------------------------------------------------
# Datos de referencia
# ---------------------------------------------------------------------------

# Puertos que usan las camaras. (puerto: (descripcion, puntos))
PUERTOS_CAMARA = {
    554: ("RTSP (video en vivo)", 3),
    8554: ("RTSP alterno (video en vivo)", 3),
    10554: ("RTSP alterno (video en vivo)", 3),
    1935: ("RTMP (transmision de video)", 2),
    9000: ("Video de grabadores (Swann, Lorex y otros NVR/DVR)", 2),
    34567: ("Protocolo de camaras chinas baratas (XMEye / XiongMai)", 4),
    37777: ("Protocolo de camaras Dahua / Amcrest", 4),
    8000: ("Protocolo de camaras Hikvision / EZVIZ", 2),
    8899: ("ONVIF en camaras baratas", 3),
    6668: ("Tuya / Smart Life (enchufes, camaras, bombillos)", 1),
    9527: ("Consola de camaras baratas", 2),
    23: ("Telnet (muy comun en camaras baratas)", 1),
}
PUERTOS_WEB = [80, 81, 88, 443, 8080, 8081, 8888, 5000]
# Puertos que solo se usan para saber si el equipo esta vivo.
PUERTOS_VIDA = [22, 53, 135, 139, 445, 62078, 7000, 5353]

TODOS_PUERTOS = sorted(set(PUERTOS_CAMARA) | set(PUERTOS_WEB))

# Palabras que delatan una camara en la pagina web del equipo o en UPnP.
PALABRAS_CAMARA = [
    "hikvision", "dahua", "ezviz", "imou", "amcrest", "reolink", "foscam",
    "axis", "vivotek", "uniview", "hanwha", "wisenet", "mobotix", "tapo c",
    "wyze", "yi home", "xiaomi camera", "ipcam", "ip camera", "ipcamera",
    "netcam", "webcam", "network camera", "netwave", "camera", "camara",
    "cámara", "dvr", "nvr", "onvif", "rtsp", "xmeye", "v380", "icsee",
    "yoosee", "lookcam", "camhi", "cloudedge", "ubox", "hiseeu", "jooan",
    "sricam", "wanscam", "escam", "vstarcam", "eye4", "web service",
    "uc-httpd", "dnvrs-webs", "app-webs", "hipcam", "goahead-webs",
    "boa/0.94", "thttpd", "mini_httpd", "lighttpd/1.4.3", "videoserver",
    "live view", "surveillance", "vigilancia", "nvms", "cctv", "ipc",
]
# Estas son debiles por si solas (las usan tambien routers e impresoras).
PALABRAS_DEBILES = {"goahead-webs", "boa/0.94", "thttpd", "mini_httpd",
                    "lighttpd/1.4.3", "web service", "ipc"}

# Fabricantes de camaras por prefijo MAC (OUI). Lista corta y conservadora.
OUI_CAMARA = {
    # Hikvision / EZVIZ
    "28:57:BE": "Hikvision", "44:19:B6": "Hikvision", "4C:BD:8F": "Hikvision",
    "BC:AD:28": "Hikvision", "C0:56:E3": "Hikvision", "54:C4:15": "Hikvision",
    "A4:14:37": "Hikvision", "18:68:CB": "Hikvision", "C4:2F:90": "Hikvision",
    "64:DB:8B": "Hikvision", "8C:E7:48": "Hikvision",
    # Dahua / Imou / Amcrest
    "3C:EF:8C": "Dahua", "90:02:A9": "Dahua", "4C:11:BF": "Dahua",
    "E0:50:8B": "Dahua", "14:A7:8B": "Dahua", "38:AF:29": "Dahua",
    "9C:14:63": "Dahua", "BC:32:5F": "Dahua", "A0:BD:1D": "Dahua",
    "9C:8E:CD": "Amcrest",
    # Otras marcas de camaras
    "00:40:8C": "Axis", "AC:CC:8E": "Axis", "B8:A4:4F": "Axis",
    "00:02:D1": "Vivotek", "00:03:C5": "Mobotix",
    "00:09:18": "Hanwha (Samsung Techwin)", "00:16:6C": "Hanwha (Samsung Techwin)",
    "EC:71:DB": "Reolink",
    "BC:51:FE": "Swann",
    "2C:AA:8E": "Wyze", "D0:3F:27": "Wyze",
}
# Chips Wi-Fi baratos que se usan mucho en camaras espia, enchufes, etc.
OUI_IOT = {
    "24:0A:C4": "Espressif", "30:AE:A4": "Espressif", "84:CC:A8": "Espressif",
    "A4:CF:12": "Espressif", "BC:DD:C2": "Espressif", "CC:50:E3": "Espressif",
    "24:62:AB": "Espressif", "3C:71:BF": "Espressif", "7C:9E:BD": "Espressif",
    "EC:FA:BC": "Espressif", "48:3F:DA": "Espressif", "C8:2B:96": "Espressif",
    "D8:F1:5B": "Espressif", "E8:DB:84": "Espressif", "10:52:1C": "Espressif",
}

# ---------------------------------------------------------------------------
# Utilidades de red
# ---------------------------------------------------------------------------

TIEMPO = 0.6  # segundos de espera por conexion
# En Windows, que los comandos (arp, ping, ipconfig) no abran ventanas negras.
SIN_VENTANA = {"creationflags": 0x08000000} if os.name == "nt" else {}


def ejecutar(cmd, tiempo=8):
    return subprocess.run(cmd, capture_output=True, text=True, errors="ignore",
                          timeout=tiempo, stdin=subprocess.DEVNULL, **SIN_VENTANA).stdout


# ---------------------------------------------------------------------------
# Lista de fabricantes (OUI)
# ---------------------------------------------------------------------------

# Palabras en el nombre del fabricante que indican camaras / grabadores.
MARCAS_CAMARA = [
    "hikvision", "dahua", "ezviz", "uniview", "tiandy", "hanwha", "samsung techwin",
    "axis communications", "vivotek", "mobotix", "reolink", "wyze", "amcrest", "foscam",
    "swann", "lorex", "annke", "imou", "milesight", "honeywell security", "bosch security",
    "avtech", "geovision", "provision-isr", "hiwatch", "jovision", "tvt digital",
    "shenzhen tvt", "xiongmai", "hangzhou xiongmai", "sricam", "vstarcam", "wanscam",
    "escam", "dericam", "zmodo", "arlo", "netgear arlo", "eufy", "yi technology",
    "shanghai imilab", "imilab", "blink", "ring llc", "canary connect", "nest labs",
    "dropcam", "hipcam", "shenzhen bilian", "aobo", "anke", "uniarch", "idis", "cp plus",
]
# Chips o marcas de aparatos "inteligentes" baratos (camaras espia, enchufes, focos).
MARCAS_IOT = [
    "espressif", "tuya", "beken", "realtek semiconductor", "ingenic", "anyka",
    "fn-link", "hui zhou gaoshengda", "shenzhen century xinyang", "azurewave",
    "ampak", "mediatek", "allwinner", "fullhan", "goke", "sigmastar", "novatek",
    "shenzhen ogemray", "leedarson", "hon hai", "lcfc", "xiaomi", "tp-link",
]

_OUI = None


def _ruta_recurso(nombre):
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, nombre)


_OUI_CANDADO = __import__("threading").Lock()


def fabricante_mac(mac):
    """Nombre del fabricante segun los primeros 3 bytes de la MAC ('' si no se sabe)."""
    global _OUI
    if _OUI is None:
        with _OUI_CANDADO:  # varios hilos a la vez: cargar la lista una sola vez y completa
            if _OUI is None:
                lista = {}
                try:
                    import gzip
                    with gzip.open(_ruta_recurso("oui.txt.gz"), "rt", encoding="utf-8") as f:
                        for linea in f:
                            pref, _, nombre = linea.rstrip("\n").partition("\t")
                            lista[pref] = nombre
                except OSError:
                    pass
                _OUI = lista
    return _OUI.get(mac.replace(":", "")[:6].upper(), "")


def ip_local():
    """IP de esta computadora en la red local (no envia nada a internet)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def puerta_de_enlace():
    """Intenta averiguar la IP del router."""
    try:
        if os.name == "nt":
            out = ejecutar(["ipconfig"], 5)
            for m in re.finditer(r"(?:Puerta de enlace|Default Gateway)[^:]*:\s*([\d.]+)", out):
                return m.group(1)
        else:
            with open("/proc/net/route") as f:
                for line in f.readlines()[1:]:
                    p = line.split()
                    if p[1] == "00000000":
                        return socket.inet_ntoa(bytes.fromhex(p[2])[::-1])
    except Exception:
        pass
    return None


def probar_puerto(ip, puerto, tiempo=TIEMPO):
    """'abierto', 'cerrado' (el equipo existe pero no usa ese puerto) o None."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(tiempo)
    try:
        r = s.connect_ex((ip, puerto))
        if r == 0:
            return "abierto"
        # 111 = Linux, 10061 = Windows, 61 = macOS -> "conexion rechazada"
        if r in (111, 10061, 61):
            return "cerrado"
        return None
    except OSError:
        return None
    finally:
        s.close()


def tabla_arp():
    """IP -> MAC de los equipos que la computadora ha visto en la red."""
    resultado = {}
    patron = re.compile(r"(\d{1,3}(?:\.\d{1,3}){3}).*?(([0-9a-fA-F]{1,2}[:-]){5}[0-9a-fA-F]{1,2})")
    textos = []
    try:
        with open("/proc/net/arp") as f:
            textos.append(f.read())
    except OSError:
        pass
    for cmd in (["arp", "-a"], ["ip", "neigh"], ["arp", "-an"]):
        try:
            textos.append(ejecutar(cmd))
        except Exception:
            continue
    for texto in textos:
        for linea in texto.splitlines():
            m = patron.search(linea)
            if not m:
                continue
            mac = normalizar_mac(m.group(2))
            if mac in ("00:00:00:00:00:00", "FF:FF:FF:FF:FF:FF") or mac.startswith("01:00:5E"):
                continue
            resultado[m.group(1)] = mac
    return resultado


def normalizar_mac(mac):
    partes = re.split(r"[:-]", mac)
    return ":".join(p.zfill(2).upper() for p in partes)


def mac_aleatoria(mac):
    """Los celulares modernos inventan una MAC 'privada' (2do digito 2, 6, A o E)."""
    try:
        return int(mac[1], 16) & 2 == 2
    except (ValueError, IndexError):
        return False


def nombre_equipo(ip):
    try:
        return socket.gethostbyaddr(ip)[0]
    except (OSError, UnicodeError):
        return ""


# ---------------------------------------------------------------------------
# Pruebas especificas de camaras
# ---------------------------------------------------------------------------

def probar_rtsp(ip, puerto):
    """Envia un OPTIONS de RTSP. Si contesta 'RTSP/1.0' es un servidor de video."""
    try:
        with socket.create_connection((ip, puerto), timeout=1.5) as s:
            s.settimeout(1.5)
            s.sendall(f"OPTIONS rtsp://{ip}:{puerto}/ RTSP/1.0\r\nCSeq: 1\r\n"
                      f"User-Agent: detector\r\n\r\n".encode())
            data = s.recv(1024).decode("latin-1", "ignore")
            if data.startswith("RTSP/"):
                srv = re.search(r"Server:\s*(.+)", data, re.I)
                return srv.group(1).strip() if srv else "si"
    except OSError:
        pass
    return None


def mirar_web(ip, puerto):
    """Abre la pagina web del equipo y devuelve (servidor, titulo, texto)."""
    esquema = "https" if puerto in (443,) else "http"
    url = f"{esquema}://{ip}:{puerto}/"
    try:
        import ssl
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE  # las camaras usan certificados propios
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),  # nunca usar proxy en la red local
            urllib.request.HTTPSHandler(context=ctx))
        try:
            r = opener.open(req, timeout=2.5)
            cabeceras, cuerpo = r.headers, r.read(20000)
        except urllib.error.HTTPError as e:  # 401 de login tambien sirve
            cabeceras, cuerpo = e.headers, e.read(20000) if e.fp else b""
        texto = cuerpo.decode("utf-8", "ignore")
        titulo = re.search(r"<title[^>]*>(.*?)</title>", texto, re.I | re.S)
        servidor = (cabeceras.get("Server") or "").strip()
        realm = cabeceras.get("WWW-Authenticate") or ""
        return servidor, (titulo.group(1).strip()[:80] if titulo else ""), (texto + " " + realm)
    except Exception:
        return None


def buscar_onvif(espera=3.0):
    """WS-Discovery: las camaras ONVIF contestan a este mensaje en multicast."""
    import uuid
    msg = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" '
        'xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" '
        'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" '
        'xmlns:dn="http://www.onvif.org/ver10/network/wsdl">'
        '<e:Header><w:MessageID>uuid:%s</w:MessageID>'
        '<w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>'
        '<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>'
        '</e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types>'
        '</d:Probe></e:Body></e:Envelope>' % uuid.uuid4()
    ).encode()
    encontrados = {}
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    try:
        s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
        s.settimeout(0.5)
        for _ in range(2):
            s.sendto(msg, ("239.255.255.250", 3702))
        fin = time.time() + espera
        while time.time() < fin:
            try:
                data, (ip, _) = s.recvfrom(65535)
            except socket.timeout:
                continue
            texto = data.decode("utf-8", "ignore")
            scopes = re.findall(r"onvif://www\.onvif\.org/(?:name|hardware)/([^\s<]+)", texto)
            info = " / ".join(urllib.request.unquote(x) for x in scopes) or "camara ONVIF"
            encontrados[ip] = info
    except OSError:
        pass
    finally:
        s.close()
    return encontrados


def buscar_upnp(espera=3.0):
    """SSDP: muchos equipos se anuncian solos. Devuelve ip -> texto del anuncio."""
    msg = ("M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\n"
           "MAN: \"ssdp:discover\"\r\nMX: 2\r\nST: ssdp:all\r\n\r\n").encode()
    anuncios = {}
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    try:
        s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
        s.settimeout(0.5)
        for _ in range(2):
            s.sendto(msg, ("239.255.255.250", 1900))
        fin = time.time() + espera
        while time.time() < fin:
            try:
                data, (ip, _) = s.recvfrom(65535)
            except socket.timeout:
                continue
            texto = data.decode("utf-8", "ignore")
            d = anuncios.setdefault(ip, {"texto": "", "ubicaciones": set()})
            d["texto"] += " " + texto
            loc = re.search(r"LOCATION:\s*(\S+)", texto, re.I)
            if loc:
                d["ubicaciones"].add(loc.group(1))
    except OSError:
        pass
    finally:
        s.close()
    # Leer la descripcion del equipo (fabricante y modelo)
    for ip, d in anuncios.items():
        for loc in list(d["ubicaciones"])[:2]:
            try:
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                xml = opener.open(loc, timeout=2).read(20000).decode("utf-8", "ignore")
                campos = re.findall(r"<(friendlyName|manufacturer|modelName|modelDescription)>(.*?)</\1>", xml)
                d["texto"] += " " + " ".join(v for _, v in campos)
                d.setdefault("descripcion", " / ".join(v for _, v in campos[:4]))
            except Exception:
                pass
    return {ip: (d["texto"], d.get("descripcion", "")) for ip, d in anuncios.items()}


# ---------------------------------------------------------------------------
# Escaneo
# ---------------------------------------------------------------------------

def despertar_arp(ips):
    """Manda un paquete UDP vacio a cada IP. No espera respuesta: solo obliga a la
    computadora a preguntar 'quien tiene esta IP?' (ARP), y asi los equipos que no
    contestan a nada igual quedan anotados en la tabla ARP."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        for ip in ips:
            for puerto in (9, 137):
                try:
                    s.sendto(b"\x00", (ip, puerto))
                except OSError:
                    pass
    finally:
        s.close()


def hacer_ping(ip):
    if os.name == "nt":
        cmd = ["ping", "-n", "1", "-w", "700", ip]
    else:
        cmd = ["ping", "-c", "1", "-W", "1", ip]
    try:
        out = ejecutar(cmd, 4)
    except Exception:
        return False
    return "TTL=" in out.upper()


def descubrir_equipos(red, mi_ip, progreso=None):
    """Busca todos los equipos encendidos de la red con 3 metodos:
    ARP, ping y conexiones a puertos comunes (de celulares, PCs y camaras)."""
    vivos = set()
    ips = [str(h) for h in red.hosts() if str(h) != mi_ip]
    total = len(ips)
    despertar_arp(ips)

    def tocar(ip):
        if hacer_ping(ip):
            return ip
        for p in (80, 554, 443, 8000, 34567, 37777, 6668, 8080, 445, 62078):
            if probar_puerto(ip, p, 0.4):
                return ip
        return None

    hechos = 0
    with cf.ThreadPoolExecutor(max_workers=64) as ex:
        for r in ex.map(tocar, ips):
            hechos += 1
            if r:
                vivos.add(r)
            if progreso and (hechos % 4 == 0 or hechos == total):
                progreso(hechos, total, "Buscando equipos")
    # Segunda vuelta de ARP para los que tardan en despertar (Wi-Fi en ahorro de energia).
    despertar_arp(ips)
    time.sleep(2)
    arp = tabla_arp()
    for ip in arp:
        try:
            if ipaddress.ip_address(ip) in red:
                vivos.add(ip)
        except ValueError:
            pass
    vivos.discard(mi_ip)
    return sorted(vivos, key=lambda x: ipaddress.ip_address(x)), arp


def barra(n, total, texto):
    ancho = 30
    lleno = int(ancho * n / max(total, 1))
    sys.stdout.write(f"\r  {texto}: [{'#' * lleno}{'.' * (ancho - lleno)}] {n}/{total}")
    sys.stdout.flush()


def analizar(ip, mac, onvif, upnp, router):
    eq = {"ip": ip, "mac": mac or "", "nombre": "", "fabricante": "",
          "puertos": [], "pistas": [], "puntos": 0, "es_router": ip == router}

    def pista(texto, puntos):
        eq["pistas"].append((texto, puntos))
        eq["puntos"] += puntos

    if mac:
        pref = mac[:8]
        marca = fabricante_mac(mac)
        marca_l = marca.lower()
        if marca and any(m in marca_l for m in MARCAS_CAMARA):
            eq["fabricante"] = marca
            pista(f"La tarjeta de red es de {marca}, fabricante de camaras", 4)
        elif pref in OUI_CAMARA:
            eq["fabricante"] = OUI_CAMARA[pref]
            pista(f"La tarjeta de red es de {OUI_CAMARA[pref]}, fabricante de camaras", 4)
        elif pref in OUI_IOT:
            eq["fabricante"] = OUI_IOT[pref]
            pista(f"Chip Wi-Fi {OUI_IOT[pref]} (lo usan camaras espia, enchufes y bombillos inteligentes)", 1)
        elif marca and any(m in marca_l for m in MARCAS_IOT):
            eq["fabricante"] = marca
            pista(f"Chip/marca {marca} (se usa en camaras Wi-Fi, enchufes y focos inteligentes)", 1)
        elif marca:
            eq["fabricante"] = marca
        elif mac_aleatoria(mac):
            eq["fabricante"] = "MAC privada (casi siempre un celular o laptop)"

    eq["nombre"] = nombre_equipo(ip)
    nombre_l = eq["nombre"].lower()
    for palabra in ("cam", "ipc", "dvr", "nvr", "hik", "dahua", "ezviz", "imou", "tapo", "wyze", "reolink"):
        if palabra in nombre_l:
            pista(f"El nombre del equipo ('{eq['nombre']}') parece de camara", 3)
            break

    if ip in onvif:
        pista(f"Contesto como camara ONVIF: {onvif[ip]}", 6)

    if ip in upnp:
        texto, desc = upnp[ip]
        palabras = encontrar_palabras(texto)
        if palabras:
            pista(f"Se anuncia en la red como: {desc or ', '.join(palabras)}", 3)
        elif desc and not eq["fabricante"]:
            eq["fabricante"] = desc[:60]

    abiertos = [p for p in TODOS_PUERTOS if probar_puerto(ip, p) == "abierto"]
    eq["puertos"] = abiertos

    for p in abiertos:
        if p in PUERTOS_CAMARA:
            desc, pts = PUERTOS_CAMARA[p]
            if p in (554, 8554, 10554):
                srv = probar_rtsp(ip, p)
                if srv:
                    pista(f"Transmite video RTSP en el puerto {p}" + (f" ({srv})" if srv != "si" else ""), 6)
                else:
                    pista(f"Puerto {p} abierto: {desc}", 2)
            else:
                pista(f"Puerto {p} abierto: {desc}", pts)

    vistos_web = set()
    for p in abiertos:
        if p not in PUERTOS_WEB:
            continue
        r = mirar_web(ip, p)
        if not r:
            continue
        servidor, titulo, texto = r
        eq.setdefault("web", f"{titulo or '(sin titulo)'} — {servidor or 'servidor desconocido'}")
        palabras = [w for w in encontrar_palabras(f"{servidor} {titulo} {texto}") if w not in vistos_web]
        vistos_web.update(palabras)
        fuertes = [w for w in palabras if w not in PALABRAS_DEBILES]
        if fuertes:
            pista(f"Su pagina web (puerto {p}) menciona: {', '.join(fuertes[:5])}", 4)
        elif palabras:
            pista(f"Usa un servidor web tipico de camaras baratas ({', '.join(palabras[:3])})", 1)

    if eq["puntos"] >= 3:
        todo = " ".join(t for t, _ in eq["pistas"]).lower() + " " + (eq.get("web") or "").lower()
        grabador = any(w in todo for w in ("nvr", "dvr", "swann", "lorex", "recorder", "grabador"))
        eq["tipo"] = "Grabador (NVR/DVR)" if grabador else "Camara o grabador"
        pista("Si es un grabador (NVR/DVR), las camaras conectadas a el por cable no aparecen "
              "aparte en la red: solo se ve el grabador", 0)

    if eq["es_router"]:
        eq["puntos"] = min(eq["puntos"], 2)
        eq["fabricante"] = (eq["fabricante"] + " — " if eq["fabricante"] else "") + "Router / modem"

    if eq["puntos"] >= 6:
        eq["nivel"] = "ALTA"
    elif eq["puntos"] >= 3:
        eq["nivel"] = "MEDIA"
    elif eq["puntos"] >= 1:
        eq["nivel"] = "BAJA"
    else:
        eq["nivel"] = "NINGUNA"
    return eq


def encontrar_palabras(texto):
    t = texto.lower()
    return [w for w in PALABRAS_CAMARA if re.search(r"(?<![a-z])" + re.escape(w) + r"(?![a-z])", t)]


# ---------------------------------------------------------------------------
# Informe
# ---------------------------------------------------------------------------

COLORES = {"ALTA": "#c62828", "MEDIA": "#ef6c00", "BAJA": "#9e9d24", "NINGUNA": "#2e7d32"}
TEXTO_NIVEL = {"ALTA": "Muy probable camara", "MEDIA": "Posible camara",
               "BAJA": "Poco probable", "NINGUNA": "No parece camara"}


def informe_html(equipos, red, mi_ip, duracion):
    filas = []
    for e in equipos:
        pistas = "".join(f"<li>{html.escape(t)}</li>" for t, _ in e["pistas"]) or "<li>Ninguna</li>"
        web = f"<div class='web'>Pagina web: {html.escape(e['web'])}</div>" if e.get("web") else ""
        enlaces = " ".join(
            f"<a href='{'https' if p == 443 else 'http'}://{e['ip']}:{p}/' target='_blank'>:{p}</a>"
            for p in e["puertos"] if p in PUERTOS_WEB)
        filas.append(f"""
        <article class="eq" style="border-left-color:{COLORES[e['nivel']]}">
          <header>
            <span class="nivel" style="background:{COLORES[e['nivel']]}">{TEXTO_NIVEL[e['nivel']]}</span>
            <strong>{html.escape(e['ip'])}</strong>
            <span class="sub">{html.escape(e['nombre'] or '')}</span>
          </header>
          <div class="sub">MAC: {html.escape(e['mac'] or 'desconocida')}
            {(' · ' + html.escape(e['fabricante'])) if e['fabricante'] else ''}</div>
          <div class="sub">Puertos abiertos: {', '.join(map(str, e['puertos'])) or 'ninguno'} {enlaces}</div>
          {web}
          <ul>{pistas}</ul>
        </article>""")
    n_alta = sum(e["nivel"] == "ALTA" for e in equipos)
    n_media = sum(e["nivel"] == "MEDIA" for e in equipos)
    if n_alta:
        resumen = f"<p class='alerta'>Se encontraron <b>{n_alta}</b> equipo(s) que casi seguro son camaras.</p>"
    elif n_media:
        resumen = f"<p class='aviso'>Se encontraron <b>{n_media}</b> equipo(s) que podrian ser camaras. Reviselos.</p>"
    else:
        resumen = "<p class='ok'>No se encontraron camaras en esta red.</p>"

    return f"""<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Detector de camaras</title>
<style>
 body{{font-family:system-ui,Segoe UI,Arial,sans-serif;margin:0;background:#f4f5f7;color:#222}}
 main{{max-width:860px;margin:auto;padding:16px}}
 h1{{margin:.2em 0}} .sub{{color:#555;font-size:.9em;margin:2px 0}}
 .eq{{background:#fff;border-left:6px solid;border-radius:8px;padding:12px 14px;margin:12px 0;box-shadow:0 1px 3px #0002}}
 .eq header{{display:flex;gap:10px;align-items:center;flex-wrap:wrap}}
 .nivel{{color:#fff;border-radius:12px;padding:2px 10px;font-size:.8em}}
 .eq ul{{margin:8px 0 0 18px;padding:0}} .web{{font-size:.9em;margin-top:4px}}
 .alerta{{background:#ffebee;padding:12px;border-radius:8px}}
 .aviso{{background:#fff3e0;padding:12px;border-radius:8px}}
 .ok{{background:#e8f5e9;padding:12px;border-radius:8px}}
 .tips{{background:#fff;border-radius:8px;padding:12px 16px;margin-top:20px}}
 a{{margin-left:4px}}
</style></head><body><main>
<h1>Detector de camaras ocultas</h1>
<div class="sub">Red revisada: {red} · Esta computadora: {mi_ip} ·
 {dt.datetime.now():%d/%m/%Y %I:%M %p} · {len(equipos)} equipos · {duracion:.0f} s</div>
{resumen}
{''.join(filas)}
<section class="tips">
<h2>Importante</h2>
<ul>
 <li>Este programa solo ve equipos conectados a <b>esta misma red</b>. Una camara puede estar en otra red Wi-Fi
   (por ejemplo, otra red del mismo router o una red de invitados), usar datos moviles (chip 4G) o grabar en una
   memoria sin conexion. Que no aparezca nada no garantiza que no haya camaras.</li>
 <li>"Posible camara" no es prueba: impresoras, televisores, routers y bombillos inteligentes a veces tienen
   pistas parecidas. Abra los enlaces de puertos para ver la pagina del equipo.</li>
 <li><b>Revision fisica:</b> apague la luz y alumbre con la linterna del celular mirando a traves de un tubo
   (o de un papel enrollado): los lentes de camara brillan como un puntito. La camara del celular tambien
   ve las lucecitas infrarrojas de vision nocturna (puntos morados). Mire detectores de humo, cargadores USB,
   relojes, enchufes, tomacorrientes, adornos, espejos y cualquier cosa que apunte a la cama, el baño o la ducha.</li>
 <li>Abra la lista de redes Wi-Fi del celular: nombres raros como <i>IPC-xxxx</i>, <i>HDWIFICAM</i>,
   <i>CAM-xxxx</i>, <i>V380</i> o <i>MV</i> + numeros suelen ser camaras en modo de configuracion.</li>
 <li>Si encuentra una camara donde no debe haberla (por ejemplo, en un alquiler), no la desconecte:
   tome fotos, salga del lugar, y avise a la plataforma de alquiler y a la Policia.</li>
</ul>
</section>
</main></body></html>"""


# ---------------------------------------------------------------------------
# Programa principal
# ---------------------------------------------------------------------------

def red_automatica():
    """(red, mi_ip) de la red Wi-Fi/cable a la que esta conectada la computadora."""
    mi_ip = ip_local()
    if mi_ip.startswith("127."):
        return None, mi_ip
    return ipaddress.ip_network(f"{mi_ip}/24", strict=False), mi_ip


def escanear(red=None, aviso=print, progreso=None):
    """Revisa la red y devuelve (equipos, red, mi_ip, router, segundos).
    aviso(texto) recibe mensajes; progreso(n, total, texto) el avance."""
    mi_ip = ip_local()
    if red is None:
        red, mi_ip = red_automatica()
        if red is None:
            raise RuntimeError("No estas conectado a ninguna red. Conectate al Wi-Fi y vuelve a intentarlo.")
    red = ipaddress.ip_network(str(red), strict=False)
    if red.num_addresses > 4096:
        raise RuntimeError("La red es demasiado grande (mas de 4096 direcciones). Elige una red mas chica.")

    router = puerta_de_enlace()
    aviso(f"Esta computadora: {mi_ip}   Red: {red}   Router: {router or '?'}")
    inicio = time.time()

    with cf.ThreadPoolExecutor(max_workers=2) as ex:
        f_onvif = ex.submit(buscar_onvif)
        f_upnp = ex.submit(buscar_upnp)
        vivos, arp = descubrir_equipos(red, mi_ip, progreso)
        aviso("Preguntando a la red quien es camara (ONVIF / UPnP)...")
        onvif, upnp = f_onvif.result(), f_upnp.result()

    for ip in list(onvif) + list(upnp):
        try:
            if ip != mi_ip and ipaddress.ip_address(ip) in red and ip not in vivos:
                vivos.append(ip)
        except ValueError:
            pass

    fabricante_mac("00:00:00")  # cargar la lista de fabricantes antes de usar varios hilos
    aviso(f"{len(vivos)} equipos encontrados. Revisando cada uno...")
    equipos = []
    with cf.ThreadPoolExecutor(max_workers=24) as ex:
        futuros = [ex.submit(analizar, ip, arp.get(ip), onvif, upnp, router) for ip in vivos]
        for i, f in enumerate(cf.as_completed(futuros), 1):
            equipos.append(f.result())
            if progreso:
                progreso(i, len(futuros), "Revisando equipos")

    orden = {"ALTA": 0, "MEDIA": 1, "BAJA": 2, "NINGUNA": 3}
    equipos.sort(key=lambda e: (orden[e["nivel"]], -e["puntos"], ipaddress.ip_address(e["ip"])))
    return equipos, red, mi_ip, router, time.time() - inicio


def guardar_informe(equipos, red, mi_ip, duracion, salida=None):
    carpeta = os.path.dirname(os.path.abspath(sys.executable if getattr(sys, "frozen", False) else __file__))
    salida = salida or os.path.join(carpeta, f"informe-camaras-{dt.datetime.now():%Y%m%d-%H%M}.html")
    try:
        with open(salida, "w", encoding="utf-8") as f:
            f.write(informe_html(equipos, red, mi_ip, duracion))
    except OSError:  # carpeta sin permiso de escritura: usar la carpeta personal
        salida = os.path.join(os.path.expanduser("~"), os.path.basename(salida))
        with open(salida, "w", encoding="utf-8") as f:
            f.write(informe_html(equipos, red, mi_ip, duracion))
    return salida


def main():
    ap = argparse.ArgumentParser(description="Busca camaras ocultas en tu red Wi-Fi.")
    ap.add_argument("--red", help="Red a revisar, por ejemplo 192.168.1.0/24 (si no, se detecta sola)")
    ap.add_argument("--sin-navegador", action="store_true", help="No abrir el informe al terminar")
    ap.add_argument("--salida", help="Donde guardar el informe HTML")
    args = ap.parse_args()

    print("\n  DETECTOR DE CAMARAS OCULTAS\n  ===========================")
    try:
        equipos, red, mi_ip, _, duracion = escanear(
            args.red, aviso=lambda t: print("\n  " + t), progreso=barra)
    except RuntimeError as e:
        print("  " + str(e))
        return 1
    print("\n")
    for e in equipos:
        marca = {"ALTA": "[!!!]", "MEDIA": "[ ! ]", "BAJA": "[ ? ]", "NINGUNA": "[ ok]"}[e["nivel"]]
        print(f"  {marca} {e['ip']:<15} {TEXTO_NIVEL[e['nivel']]:<20} {e['fabricante'][:40]}")
        if e["nivel"] in ("ALTA", "MEDIA"):
            for t, _ in e["pistas"]:
                print(f"          - {t}")
    if not equipos:
        print("  No se encontro ningun otro equipo en la red.")

    salida = guardar_informe(equipos, red, mi_ip, duracion, args.salida)
    print(f"\n  Informe guardado en: {salida}")
    if not args.sin_navegador:
        webbrowser.open("file://" + os.path.abspath(salida))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n  Cancelado.")
        sys.exit(130)
