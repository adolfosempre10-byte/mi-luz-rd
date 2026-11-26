#!/usr/bin/env python3
"""
Detector de camaras ocultas - aplicacion con ventana.
Doble clic para abrir (o: python app_camaras.py).
"""

import ipaddress
import os
import queue
import threading
import tkinter as tk
import webbrowser
from tkinter import messagebox, ttk

import detector_camaras as det

COLOR = {"ALTA": "#c62828", "MEDIA": "#ef6c00", "BAJA": "#827717", "NINGUNA": "#2e7d32"}
FONDO = {"ALTA": "#ffebee", "MEDIA": "#fff3e0", "BAJA": "#f9fbe7", "NINGUNA": "#ffffff"}
ICONO = {"ALTA": "🔴", "MEDIA": "🟠", "BAJA": "🟡", "NINGUNA": "🟢"}

CONSEJOS = (
    "• Solo se ven los equipos conectados a ESTA red. Una cámara con chip 4G, en otra red Wi-Fi "
    "o que solo graba en una memoria no aparece.\n"
    "• Revisión física: apaga la luz y alumbra con la linterna del celular mirando por un tubo de papel; "
    "los lentes brillan como un puntito. La cámara del celular también ve las luces infrarrojas (puntos morados).\n"
    "• Mira detectores de humo, cargadores USB, relojes, enchufes, adornos y todo lo que apunte a la cama, "
    "el baño o la ducha.\n"
    "• En la lista de Wi-Fi del celular, nombres como IPC-xxxx, HDWIFICAM, CAM-xxxx o V380 suelen ser cámaras.\n"
    "• Si encuentras una cámara donde no debe estar: no la toques, toma fotos y avisa a la plataforma y a la Policía."
)


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Detector de cámaras ocultas")
        self.geometry("900x620")
        self.minsize(680, 480)
        self.configure(bg="#f4f5f7")
        self.cola = queue.Queue()
        self.equipos = []
        self.ultimo_informe = None
        self.resultado = None
        self._estilos()
        self._armar()
        red, ip = det.red_automatica()
        self.var_red.set(str(red) if red else "")
        self.lbl_info.config(text=f"Esta computadora: {ip}" if red else
                             "No estás conectado a ninguna red. Conéctate al Wi-Fi.")
        self.after(100, self._leer_cola)

    # ------------------------------------------------------------------ UI
    def _estilos(self):
        st = ttk.Style(self)
        try:
            st.theme_use("clam")
        except tk.TclError:
            pass
        st.configure("Grande.TButton", font=("Segoe UI", 13, "bold"), padding=(18, 10),
                     background="#1565c0", foreground="white")
        st.map("Grande.TButton", background=[("active", "#0d47a1"), ("disabled", "#90a4ae")])
        st.configure("Treeview", rowheight=28, font=("Segoe UI", 10))
        st.configure("Treeview.Heading", font=("Segoe UI", 10, "bold"))
        st.configure("TProgressbar", thickness=14, background="#1565c0")

    def _armar(self):
        top = tk.Frame(self, bg="#f4f5f7")
        top.pack(fill="x", padx=16, pady=(14, 6))
        tk.Label(top, text="Detector de cámaras ocultas", font=("Segoe UI", 18, "bold"),
                 bg="#f4f5f7").pack(anchor="w")
        self.lbl_info = tk.Label(top, text="", bg="#f4f5f7", fg="#555", font=("Segoe UI", 10))
        self.lbl_info.pack(anchor="w")

        fila = tk.Frame(self, bg="#f4f5f7")
        fila.pack(fill="x", padx=16, pady=6)
        self.btn = ttk.Button(fila, text="🔍  Buscar cámaras", style="Grande.TButton", command=self.empezar)
        self.btn.pack(side="left")
        tk.Label(fila, text="   Red:", bg="#f4f5f7", font=("Segoe UI", 10)).pack(side="left")
        self.var_red = tk.StringVar()
        ttk.Entry(fila, textvariable=self.var_red, width=18).pack(side="left", padx=4)
        self.btn_inf = ttk.Button(fila, text="Abrir informe", command=self.abrir_informe, state="disabled")
        self.btn_inf.pack(side="right")
        ttk.Button(fila, text="Consejos", command=self.consejos).pack(side="right", padx=6)

        self.barra = ttk.Progressbar(self, mode="determinate")
        self.barra.pack(fill="x", padx=16, pady=(6, 0))
        self.lbl_estado = tk.Label(self, text="Pulsa «Buscar cámaras» para revisar la red Wi-Fi.",
                                   bg="#f4f5f7", fg="#333", font=("Segoe UI", 10))
        self.lbl_estado.pack(anchor="w", padx=16, pady=(2, 4))
        self.lbl_resumen = tk.Label(self, text="", font=("Segoe UI", 12, "bold"), bg="#f4f5f7",
                                    anchor="w", padx=10, pady=6)
        self.lbl_resumen.pack(fill="x", padx=16)

        cuerpo = ttk.PanedWindow(self, orient="vertical")
        cuerpo.pack(fill="both", expand=True, padx=16, pady=(6, 14))

        marco_lista = tk.Frame(cuerpo)
        cols = ("nivel", "ip", "fabricante", "puertos")
        self.tabla = ttk.Treeview(marco_lista, columns=cols, show="headings", selectmode="browse")
        for c, t, w in (("nivel", "Resultado", 190), ("ip", "IP", 120),
                        ("fabricante", "Fabricante / equipo", 330), ("puertos", "Puertos abiertos", 200)):
            self.tabla.heading(c, text=t)
            self.tabla.column(c, width=w, anchor="w")
        for n in COLOR:
            self.tabla.tag_configure(n, background=FONDO[n], foreground=COLOR[n] if n != "NINGUNA" else "#222")
        sb = ttk.Scrollbar(marco_lista, orient="vertical", command=self.tabla.yview)
        self.tabla.configure(yscrollcommand=sb.set)
        self.tabla.pack(side="left", fill="both", expand=True)
        sb.pack(side="right", fill="y")
        self.tabla.bind("<<TreeviewSelect>>", self.mostrar_detalle)
        self.tabla.bind("<Double-1>", self.abrir_web)
        cuerpo.add(marco_lista, weight=3)

        marco_det = tk.Frame(cuerpo, bg="white")
        self.detalle = tk.Text(marco_det, height=8, wrap="word", font=("Segoe UI", 10), relief="flat",
                               padx=10, pady=8)
        self.detalle.pack(fill="both", expand=True)
        self.detalle.tag_configure("titulo", font=("Segoe UI", 11, "bold"))
        self.detalle.insert("1.0", "Selecciona un equipo para ver por qué parece (o no) una cámara.\n"
                                   "Doble clic abre su página web, si tiene.")
        self.detalle.config(state="disabled")
        cuerpo.add(marco_det, weight=1)

    # ------------------------------------------------------------ Escaneo
    def empezar(self):
        texto = self.var_red.get().strip()
        red = None
        if texto:
            try:
                red = ipaddress.ip_network(texto, strict=False)
            except ValueError:
                messagebox.showerror("Red no válida", "Escribe la red así: 192.168.1.0/24\n"
                                                      "o déjala vacía para detectarla sola.")
                return
        self.btn.config(state="disabled")
        self.btn_inf.config(state="disabled")
        self.tabla.delete(*self.tabla.get_children())
        self.lbl_resumen.config(text="", bg="#f4f5f7")
        self.barra.config(value=0)
        threading.Thread(target=self._trabajo, args=(red,), daemon=True).start()

    def _trabajo(self, red):
        try:
            r = det.escanear(red,
                             aviso=lambda t: self.cola.put(("aviso", t)),
                             progreso=lambda n, tot, t: self.cola.put(("progreso", n, tot, t)))
            equipos, red, mi_ip, _, dur = r
            ruta = det.guardar_informe(equipos, red, mi_ip, dur)
            self.cola.put(("fin", equipos, ruta, dur))
        except Exception as e:  # mostrar cualquier problema en la ventana
            self.cola.put(("error", str(e)))

    def _leer_cola(self):
        try:
            while True:
                m = self.cola.get_nowait()
                if m[0] == "aviso":
                    self.lbl_estado.config(text=m[1])
                elif m[0] == "progreso":
                    _, n, tot, t = m
                    self.barra.config(maximum=max(tot, 1), value=n)
                    self.lbl_estado.config(text=f"{t}... {n} de {tot}")
                elif m[0] == "fin":
                    self._mostrar(m[1], m[2], m[3])
                elif m[0] == "error":
                    self.btn.config(state="normal")
                    self.lbl_estado.config(text="")
                    messagebox.showerror("No se pudo revisar la red", m[1])
        except queue.Empty:
            pass
        self.after(100, self._leer_cola)

    def _mostrar(self, equipos, ruta, dur):
        self.equipos = equipos
        self.ultimo_informe = ruta
        for i, e in enumerate(equipos):
            self.tabla.insert("", "end", iid=str(i), tags=(e["nivel"],), values=(
                f"{ICONO[e['nivel']]}  {det.TEXTO_NIVEL[e['nivel']]}", e["ip"],
                e["fabricante"] or e["nombre"] or "Desconocido",
                ", ".join(map(str, e["puertos"])) or "—"))
        alta = sum(e["nivel"] == "ALTA" for e in equipos)
        media = sum(e["nivel"] == "MEDIA" for e in equipos)
        if alta:
            txt, bg = f"⚠  {alta} equipo(s) casi seguro son cámaras.", FONDO["ALTA"]
        elif media:
            txt, bg = f"⚠  {media} equipo(s) podrían ser cámaras. Revísalos.", FONDO["MEDIA"]
        else:
            txt, bg = "✔  No se encontraron cámaras en esta red.", "#e8f5e9"
        self.lbl_resumen.config(text=txt, bg=bg)
        self.lbl_estado.config(text=f"Listo: {len(equipos)} equipos revisados en {dur:.0f} segundos.")
        self.barra.config(value=self.barra["maximum"])
        self.btn.config(state="normal")
        self.btn_inf.config(state="normal")
        if equipos:
            self.tabla.selection_set("0")

    # ------------------------------------------------------------ Acciones
    def mostrar_detalle(self, _=None):
        sel = self.tabla.selection()
        if not sel:
            return
        e = self.equipos[int(sel[0])]
        d = self.detalle
        d.config(state="normal")
        d.delete("1.0", "end")
        d.insert("end", f"{e['ip']}  —  {det.TEXTO_NIVEL[e['nivel']]}\n", "titulo")
        d.insert("end", f"MAC: {e['mac'] or 'desconocida'}    Nombre: {e['nombre'] or '—'}\n")
        if e.get("fabricante"):
            d.insert("end", f"Fabricante: {e['fabricante']}\n")
        if e.get("web"):
            d.insert("end", f"Página web: {e['web']}\n")
        d.insert("end", "\nPistas:\n", "titulo")
        for t, _ in e["pistas"] or [("Ninguna pista de cámara.", 0)]:
            d.insert("end", f"  • {t}\n")
        d.config(state="disabled")

    def abrir_web(self, _=None):
        sel = self.tabla.selection()
        if not sel:
            return
        e = self.equipos[int(sel[0])]
        web = [p for p in e["puertos"] if p in det.PUERTOS_WEB]
        if web:
            p = web[0]
            webbrowser.open(f"{'https' if p == 443 else 'http'}://{e['ip']}:{p}/")

    def abrir_informe(self):
        if self.ultimo_informe:
            webbrowser.open("file://" + os.path.abspath(self.ultimo_informe))

    def consejos(self):
        messagebox.showinfo("Cómo buscar cámaras escondidas", CONSEJOS)


if __name__ == "__main__":
    App().mainloop()
