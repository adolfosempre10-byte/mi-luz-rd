"""
Visor en vivo de las camaras de tu propio NVR/DVR o camara IP (RTSP).

Se usa desde app_camaras.py: seleccionas el equipo que transmite video,
pones su usuario y contrasena, y se ven las camaras en una cuadricula.
La contrasena solo se guarda en memoria mientras la ventana esta abierta.
"""

import base64
import hashlib
import os
import re
import socket
import threading
import time
import tkinter as tk
import urllib.parse
from tkinter import messagebox, ttk

try:
    import cv2  # opencv-python-headless
except ImportError:  # sin OpenCV se puede igual buscar la direccion y abrirla en VLC
    cv2 = None

# Para que OpenCV use TCP con RTSP (menos imagen rota en Wi-Fi) y no espere de mas.
os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp|stimeout;5000000")

# Direcciones RTSP de las marcas mas comunes. {c} = numero de camara (1, 2, 3...).
# El primer elemento de cada par es la imagen pequena (fluida), el segundo la grande.
RUTAS = [
    ("Hikvision / Swann NVR / EZVIZ / HiWatch / Annke", "/Streaming/Channels/{c}02", "/Streaming/Channels/{c}01"),
    ("Swann / Lorex DVR (Raysharp)", "/ch{c:02d}/1", "/ch{c:02d}/0"),
    ("Dahua / Amcrest / Lorex NVR / Imou", "/cam/realmonitor?channel={c}&subtype=1",
     "/cam/realmonitor?channel={c}&subtype=0"),
    ("Swann (otros modelos)", "/ch{c}/sub/av_stream", "/ch{c}/main/av_stream"),
    ("Reolink", "/h264Preview_{c:02d}_sub", "/h264Preview_{c:02d}_main"),
    ("Uniview", "/unicast/c{c}/s1/live", "/unicast/c{c}/s0/live"),
    ("TVT / Provision", "/chID={c}&streamType=sub", "/chID={c}&streamType=main"),
    ("XMEye / iCSee (camaras chinas)",
     "/user={u}&password={p}&channel={c}&stream=1.sdp", "/user={u}&password={p}&channel={c}&stream=0.sdp"),
    ("Generica", "/live/ch{c0}/1", "/live/ch{c0}/0"),
    ("Generica 2", "/stream{c}", "/stream{c}"),
    ("Generica 3", "/{c}", "/{c}"),
    ("Swann EliteX / canales desde 0", "/ch{c0:02d}/1", "/ch{c0:02d}/0"),
    ("Swann NVR (doble barra)", "//Streaming/Channels/{c}02", "//Streaming/Channels/{c}01"),
]


# ---------------------------------------------------------------------------
# RTSP minimo: DESCRIBE con autenticacion Basic o Digest
# ---------------------------------------------------------------------------

def _md5(t):
    return hashlib.md5(t.encode("utf-8")).hexdigest()


def _leer_respuesta(s):
    datos = b""
    while b"\r\n\r\n" not in datos and len(datos) < 65536:
        trozo = s.recv(4096)
        if not trozo:
            break
        datos += trozo
    cabecera, _, cuerpo = datos.partition(b"\r\n\r\n")
    texto = cabecera.decode("latin-1", "ignore")
    largo = re.search(r"Content-Length:\s*(\d+)", texto, re.I)
    if largo:  # leer el cuerpo para dejar la conexion limpia para la siguiente peticion
        falta = int(largo.group(1)) - len(cuerpo)
        while falta > 0:
            trozo = s.recv(min(falta, 4096))
            if not trozo:
                break
            falta -= len(trozo)
    m = re.match(r"RTSP/1\.\d\s+(\d+)", texto)
    return (int(m.group(1)) if m else 0), texto


def _pedir(s, uri, cseq, cabecera_auth=None):
    lineas = [f"DESCRIBE {uri} RTSP/1.0", f"CSeq: {cseq}", "Accept: application/sdp",
              "User-Agent: DetectorCamaras"]
    if cabecera_auth:
        lineas.append(f"Authorization: {cabecera_auth}")
    s.sendall(("\r\n".join(lineas) + "\r\n\r\n").encode())
    return _leer_respuesta(s)


def _auth(texto_401, usuario, clave, uri):
    """Arma la cabecera Authorization a partir de la respuesta 401."""
    retos = re.findall(r"WWW-Authenticate:\s*(.+)", texto_401, re.I)
    digest = next((r for r in retos if r.lower().startswith("digest")), None)
    if digest:
        campos = dict(re.findall(r'(\w+)="?([^",]*)"?', digest))
        realm, nonce = campos.get("realm", ""), campos.get("nonce", "")
        ha1 = _md5(f"{usuario}:{realm}:{clave}")
        ha2 = _md5(f"DESCRIBE:{uri}")
        qop = campos.get("qop")
        if qop:
            nc, cnonce = "00000001", _md5(str(time.time()))[:16]
            resp = _md5(f"{ha1}:{nonce}:{nc}:{cnonce}:auth:{ha2}")
            extra = f', qop=auth, nc={nc}, cnonce="{cnonce}"'
        else:
            resp = _md5(f"{ha1}:{nonce}:{ha2}")
            extra = ""
        op = f', opaque="{campos["opaque"]}"' if "opaque" in campos else ""
        return (f'Digest username="{usuario}", realm="{realm}", nonce="{nonce}", '
                f'uri="{uri}", response="{resp}"{op}{extra}')
    token = base64.b64encode(f"{usuario}:{clave}".encode()).decode()
    return f"Basic {token}"


def _ruta(plantilla, canal, usuario, clave):
    return plantilla.format(c=canal, c0=canal - 1, u=urllib.parse.quote(usuario), p=urllib.parse.quote(clave))


def probar_ruta(ip, puerto, ruta, usuario, clave):
    """'ok', 'clave' (usuario o contrasena mal), 'no' (esa ruta no existe) o 'error'.
    Pide acceso y manda la contrasena por la MISMA conexion: muchos grabadores
    solo aceptan la contrasena en la conexion donde dieron el 'nonce'."""
    uri = f"rtsp://{ip}:{puerto}{ruta}"
    try:
        with socket.create_connection((ip, puerto), timeout=5) as s:
            s.settimeout(5)
            cod, texto = _pedir(s, uri, 1)
            if cod == 200:
                return "ok"
            if cod != 401:
                return "no"
            auth = _auth(texto, usuario, clave, uri)
            try:
                cod2, _ = _pedir(s, uri, 2, auth)
            except OSError:
                cod2 = 0
            if cod2 == 0:  # el equipo cerro la conexion tras el 401: intentar en una nueva
                with socket.create_connection((ip, puerto), timeout=5) as s2:
                    s2.settimeout(5)
                    cod2, _ = _pedir(s2, uri, 1, auth)
        if cod2 == 200:
            return "ok"
        if cod2 == 401:
            return "clave"
        return "no"
    except OSError:
        return "error"


def probar_con_ffmpeg(url, espera_ms=8000):
    """Segunda opinion: deja que FFmpeg (dentro de OpenCV) abra el video con su propia
    autenticacion. Sirve si el equipo no acepta la forma de autenticar de probar_ruta."""
    if cv2 is None:
        return False
    try:
        cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG,
                               [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, espera_ms, cv2.CAP_PROP_READ_TIMEOUT_MSEC, espera_ms])
        ok = cap.isOpened() and cap.read()[0]
        cap.release()
        return bool(ok)
    except Exception:
        return False


def orden_marcas(puertos=()):
    """Orden de prueba segun los puertos abiertos del equipo (pista de la marca)."""
    orden = list(range(len(RUTAS)))
    pistas = []
    if 9000 in puertos:          # Swann / Lorex fabricados por Raysharp
        pistas += [1, 11, 0]
    if 8000 in puertos:          # Hikvision y sus marcas
        pistas += [0, 12]
    if 37777 in puertos:         # Dahua y sus marcas
        pistas += [2]
    if 34567 in puertos:         # XMEye
        pistas += [7]
    vistos = []
    for i in pistas + orden:
        if i not in vistos:
            vistos.append(i)
    return vistos


MSG_CLAVE = ("El NVR no aceptó el usuario o la contraseña.\n\n"
                              "• Usa la contraseña del NVR: la que pusiste al configurarlo en la pantalla del "
                              "televisor (la que pide al entrar al menú con el mouse). La contraseña de la app "
                              "del celular (tu cuenta Swann / correo) es otra y no sirve aquí.\n"
                              "• El usuario casi siempre es «admin».\n"
                              "• En el menú del NVR, revisa Red → RTSP (o Servicios de red) que esté activado.\n\n"
                              "Si estás seguro de la contraseña, prueba eligiendo a mano otro «Formato» en la ventana de acceso.\n\n"
              "Espera unos 5 minutos antes de volver a intentarlo: tras varios intentos fallidos "
                              "muchos NVR se bloquean un rato.")

MAX_FALLOS_CLAVE = 3  # mas intentos fallidos pueden bloquear el NVR unos minutos


def buscar_marca(ip, puerto, usuario, clave, aviso=lambda t: None, puertos=(), solo=None):
    """Prueba las direcciones de cada marca con la camara 1.
    Devuelve (indice_en_RUTAS, None) o (None, mensaje de error).
    solo = indice de un formato elegido a mano (prueba solo ese).
    Como algunos equipos dicen 'contrasena incorrecta' cuando la direccion es de otra
    marca, prueba hasta MAX_FALLOS_CLAVE formatos y luego pide una segunda opinion a FFmpeg."""
    fallos = []
    lista = [solo] if solo is not None else orden_marcas(puertos)
    for i in lista:
        marca, sub, _ = RUTAS[i]
        aviso(f"Probando formato {marca}...")
        r = probar_ruta(ip, puerto, _ruta(sub, 1, usuario, clave), usuario, clave)
        if r == "ok":
            return i, None
        if r == "clave":
            fallos.append(i)
            if len(fallos) >= MAX_FALLOS_CLAVE:
                break
        if r == "error":
            return None, f"No se pudo conectar con {ip}:{puerto}. Revisa que el NVR esté encendido y en la misma red."
    if fallos and cv2 is not None:
        i = fallos[0]
        aviso(f"Segunda prueba con FFmpeg ({RUTAS[i][0]})...")
        if probar_con_ffmpeg(url_rtsp(ip, puerto, _ruta(RUTAS[i][1], 1, usuario, clave), usuario, clave)):
            return i, None
    if fallos:
        return None, MSG_CLAVE
    return None, ("El equipo contestó, pero ninguna dirección de video conocida funcionó.\n"
                  "Prueba eligiendo otro «Formato» en la ventana de acceso, o busca en el manual "
                  "del NVR la «dirección RTSP».")


def url_rtsp(ip, puerto, ruta, usuario, clave):
    u = urllib.parse.quote(usuario, safe="")
    p = urllib.parse.quote(clave, safe="")
    return f"rtsp://{u}:{p}@{ip}:{puerto}{ruta}"


# ---------------------------------------------------------------------------
# Ventanas
# ---------------------------------------------------------------------------

class DialogoAcceso(tk.Toplevel):
    """Pide usuario, contrasena y cuantas camaras tiene el equipo."""

    def __init__(self, padre, ip):
        super().__init__(padre)
        self.title(f"Ver cámaras de {ip}")
        self.resizable(False, False)
        self.transient(padre)
        self.resultado = None
        marco = ttk.Frame(self, padding=16)
        marco.pack(fill="both")
        ttk.Label(marco, text="Entra con el usuario y la contraseña de tu NVR\n"
                              "(los mismos de la pantalla del NVR o de su app).",
                  justify="left").grid(row=0, column=0, columnspan=2, sticky="w", pady=(0, 10))
        self.usuario = tk.StringVar(value="admin")
        self.clave = tk.StringVar()
        self.canales = tk.IntVar(value=4)
        self.puerto = tk.IntVar(value=554)
        self.formato = tk.StringVar(value="Automático (recomendado)")
        nombres = ["Automático (recomendado)"] + [r[0] for r in RUTAS]
        filas = (("Usuario:", ttk.Entry(marco, textvariable=self.usuario, width=24)),
                 ("Contraseña:", ttk.Entry(marco, textvariable=self.clave, width=24, show="•")),
                 ("Cámaras:", ttk.Spinbox(marco, from_=1, to=16, textvariable=self.canales, width=6)),
                 ("Puerto RTSP:", ttk.Entry(marco, textvariable=self.puerto, width=8)),
                 ("Formato:", ttk.Combobox(marco, textvariable=self.formato, values=nombres,
                                           state="readonly", width=34)))
        for i, (txt, w) in enumerate(filas, 1):
            ttk.Label(marco, text=txt).grid(row=i, column=0, sticky="w", pady=3)
            w.grid(row=i, column=1, sticky="w", pady=3)
        filas[1][1].focus_set()
        botones = ttk.Frame(marco)
        botones.grid(row=7, column=0, columnspan=2, sticky="e", pady=(12, 0))
        ttk.Button(botones, text="Cancelar", command=self.destroy).pack(side="right")
        ttk.Button(botones, text="Ver cámaras", command=self._ok).pack(side="right", padx=6)
        self.bind("<Return>", lambda e: self._ok())
        self.bind("<Escape>", lambda e: self.destroy())
        self.grab_set()

    def _ok(self):
        try:
            nombres = [r[0] for r in RUTAS]
            solo = nombres.index(self.formato.get()) if self.formato.get() in nombres else None
            self.resultado = (self.usuario.get().strip(), self.clave.get(),
                              max(1, min(16, int(self.canales.get()))), int(self.puerto.get()), solo)
        except (ValueError, tk.TclError):
            messagebox.showerror("Dato no válido", "Revisa el número de cámaras y el puerto.", parent=self)
            return
        self.destroy()


class Lector(threading.Thread):
    """Lee una camara con OpenCV en segundo plano y guarda el ultimo cuadro."""

    def __init__(self, url, ancho=480):
        super().__init__(daemon=True)
        self.url, self.ancho = url, ancho
        self.cuadro = None      # bytes PPM listos para tkinter
        self.estado = "Conectando..."
        self.activo = True

    def run(self):
        while self.activo:
            cap = cv2.VideoCapture(self.url, cv2.CAP_FFMPEG)
            if not cap.isOpened():
                self.estado = "Sin señal (reintentando...)"
                time.sleep(3)
                continue
            self.estado = ""
            fallos = 0
            while self.activo:
                ok, img = cap.read()
                if not ok:
                    fallos += 1
                    if fallos > 20:
                        break
                    continue
                fallos = 0
                h, w = img.shape[:2]
                if w != self.ancho:
                    img = cv2.resize(img, (self.ancho, int(h * self.ancho / w)), interpolation=cv2.INTER_AREA)
                img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
                hh, ww = img.shape[:2]
                self.cuadro = f"P6 {ww} {hh} 255 ".encode() + img.tobytes()
            cap.release()
            if self.activo:
                self.estado = "Se cortó la señal (reconectando...)"
                time.sleep(2)


class VentanaVisor(tk.Toplevel):
    def __init__(self, padre, ip, puerto, usuario, clave, canales, indice_marca):
        super().__init__(padre)
        self.title(f"Cámaras en vivo — {ip}  ({RUTAS[indice_marca][0]})")
        self.configure(bg="#111")
        self.geometry("1000x640")
        self.ip, self.puerto, self.usuario, self.clave = ip, puerto, usuario, clave
        self.marca = indice_marca
        self.canales = canales
        self.lectores, self.etiquetas, self.imagenes = [], [], []
        self.grande = None  # camara abierta en grande (doble clic)
        self.cuadricula = tk.Frame(self, bg="#111")
        self.cuadricula.pack(fill="both", expand=True)
        barra = tk.Frame(self, bg="#222")
        barra.pack(fill="x")
        tk.Label(barra, text="Doble clic en una cámara para verla en grande. Clic derecho: copiar su dirección RTSP.",
                 bg="#222", fg="#ccc").pack(side="left", padx=8, pady=4)
        self._armar_cuadricula()
        self.protocol("WM_DELETE_WINDOW", self.cerrar)
        self.after(80, self._refrescar)

    def _url(self, canal, grande=False):
        _, sub, main = RUTAS[self.marca]
        ruta = _ruta(main if grande else sub, canal, self.usuario, self.clave)
        return url_rtsp(self.ip, self.puerto, ruta, self.usuario, self.clave)

    def _parar(self):
        for lec in self.lectores:
            lec.activo = False
        self.lectores = []
        for w in self.cuadricula.winfo_children():
            w.destroy()
        self.etiquetas, self.imagenes = [], []

    def _armar_cuadricula(self):
        self._parar()
        lista = [self.grande] if self.grande else list(range(1, self.canales + 1))
        cols = 1 if len(lista) == 1 else (2 if len(lista) <= 4 else (3 if len(lista) <= 9 else 4))
        filas = (len(lista) + cols - 1) // cols
        for i in range(cols):
            self.cuadricula.columnconfigure(i, weight=1, uniform="c")
        for i in range(filas):
            self.cuadricula.rowconfigure(i, weight=1, uniform="f")
        ancho = 960 if self.grande else max(240, 960 // cols)
        for i, canal in enumerate(lista):
            lbl = tk.Label(self.cuadricula, bg="#000", fg="#bbb", text=f"Cámara {canal}\nConectando...",
                           font=("Segoe UI", 11), compound="center")
            lbl.grid(row=i // cols, column=i % cols, sticky="nsew", padx=2, pady=2)
            lbl.bind("<Double-1>", lambda e, c=canal: self._alternar(c))
            lbl.bind("<Button-3>", lambda e, c=canal: self._copiar(c))
            lec = Lector(self._url(canal, grande=bool(self.grande)), ancho)
            lec.canal = canal
            lec.start()
            self.lectores.append(lec)
            self.etiquetas.append(lbl)
            self.imagenes.append(None)

    def _alternar(self, canal):
        self.grande = None if self.grande else canal
        self._armar_cuadricula()

    def _copiar(self, canal):
        self.clipboard_clear()
        self.clipboard_append(self._url(canal, grande=True))
        messagebox.showinfo("Dirección copiada",
                            f"Se copió la dirección RTSP de la cámara {canal} (calidad alta).\n"
                            "Puedes pegarla en VLC: Medio → Abrir ubicación de red.\n\n"
                            "Ojo: incluye tu contraseña; no la compartas.", parent=self)

    def _refrescar(self):
        for i, lec in enumerate(self.lectores):
            lbl = self.etiquetas[i]
            if lec.cuadro is not None:
                try:
                    foto = tk.PhotoImage(data=lec.cuadro, format="ppm")
                    lbl.configure(image=foto, text="")
                    self.imagenes[i] = foto
                except tk.TclError:
                    pass
            elif lec.estado:
                lbl.configure(text=f"Cámara {lec.canal}\n{lec.estado}")
        self.after(80, self._refrescar)

    def cerrar(self):
        self._parar()
        self.destroy()


def abrir_visor(padre, ip, puerto_sugerido=554, puertos=()):
    """Flujo completo: pedir acceso, encontrar el formato y abrir la cuadricula."""
    d = DialogoAcceso(padre, ip)
    if puerto_sugerido:
        d.puerto.set(puerto_sugerido)
    padre.wait_window(d)
    if not d.resultado:
        return
    usuario, clave, canales, puerto, solo = d.resultado

    espera = tk.Toplevel(padre)
    espera.title("Conectando...")
    espera.transient(padre)
    espera.resizable(False, False)
    txt = tk.StringVar(value="Conectando con el NVR...")
    ttk.Label(espera, textvariable=txt, padding=20, width=48).pack()
    barra = ttk.Progressbar(espera, mode="indeterminate", length=320)
    barra.pack(padx=20, pady=(0, 20))
    barra.start(12)
    resultado = {}

    def trabajo():
        resultado["r"] = buscar_marca(ip, puerto, usuario, clave,
                                      aviso=lambda t: padre.after(0, txt.set, t), puertos=puertos, solo=solo)

    hilo = threading.Thread(target=trabajo, daemon=True)
    hilo.start()

    def esperar():
        if hilo.is_alive():
            padre.after(150, esperar)
            return
        espera.destroy()
        indice, error = resultado["r"]
        if error:
            messagebox.showerror("No se pudo ver el video", error, parent=padre)
            return
        if cv2 is None:
            _, _, main = RUTAS[indice]
            url = url_rtsp(ip, puerto, _ruta(main, 1, usuario, clave), usuario, clave)
            padre.clipboard_clear()
            padre.clipboard_append(url)
            messagebox.showinfo("Falta OpenCV",
                                "Se encontró el video, pero para verlo aquí hace falta OpenCV "
                                "(pip install opencv-python-headless).\n\nLa dirección de la cámara 1 "
                                "se copió: pégala en VLC → Medio → Abrir ubicación de red.", parent=padre)
            return
        VentanaVisor(padre, ip, puerto, usuario, clave, canales, indice)

    esperar()
