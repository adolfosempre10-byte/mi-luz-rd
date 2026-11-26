"""Descarga la lista de fabricantes (OUI) de Wireshark y la guarda en oui.txt.gz.
La usa el detector para decir de que marca es cada equipo. Se ejecuta al crear el .exe."""
import gzip, sys, urllib.request

URL = "https://www.wireshark.org/download/automated/data/manuf"
req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
try:
    texto = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "ignore")
except Exception as e:
    print("No se pudo actualizar la lista de fabricantes, se usa la que ya hay:", e)
    sys.exit(0)
filas = []
for linea in texto.splitlines():
    if linea.startswith("#") or not linea.strip():
        continue
    p = linea.split("\t")
    if len(p) < 2 or "/" in p[0] or len(p[0]) != 8:
        continue
    filas.append(f"{p[0].replace(':', '').upper()}\t{(p[2] if len(p) > 2 else p[1]).strip()}")
if len(filas) > 20000:
    with gzip.open("oui.txt.gz", "wt", encoding="utf-8") as f:
        f.write("\n".join(filas))
    print(f"Lista de fabricantes actualizada: {len(filas)} prefijos")
