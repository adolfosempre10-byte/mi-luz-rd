"""Actualiza oui.txt.gz (lista de fabricantes por MAC) antes de crear el .exe.
Junta la lista que ya hay con las de Wireshark y del IEEE; si no hay internet, deja la que hay."""
import csv, gzip, io, urllib.request

def bajar(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
    return urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "ignore")

lista = {}
with gzip.open("oui.txt.gz", "rt", encoding="utf-8") as f:
    for linea in f:
        pref, _, nombre = linea.rstrip("\n").partition("\t")
        lista[pref] = nombre
print("Lista incluida:", len(lista))

try:
    n = 0
    for linea in bajar("https://www.wireshark.org/download/automated/data/manuf").splitlines():
        p = linea.split("\t")
        if linea.startswith("#") or len(p) < 2 or "/" in p[0] or len(p[0]) != 8:
            continue
        lista[p[0].replace(":", "").upper()] = (p[2] if len(p) > 2 else p[1]).strip()
        n += 1
    print("Wireshark:", n)
except Exception as e:
    print("Wireshark no disponible:", e)

try:
    n = 0
    for fila in csv.DictReader(io.StringIO(bajar("https://standards-oui.ieee.org/oui/oui.csv"))):
        if fila.get("Assignment") and fila.get("Organization Name"):
            lista[fila["Assignment"].upper()] = fila["Organization Name"].strip()
            n += 1
    print("IEEE:", n)
except Exception as e:
    print("IEEE no disponible:", e)

with gzip.open("oui.txt.gz", "wt", encoding="utf-8") as f:
    f.write("\n".join(f"{k}\t{v}" for k, v in sorted(lista.items())))
print("Total:", len(lista), "| BC51FE =", lista.get("BC51FE", "(no esta)"))
