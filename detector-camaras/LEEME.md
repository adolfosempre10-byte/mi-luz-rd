# Detector de cámaras ocultas

Programa para la computadora que revisa todos los equipos conectados a tu red Wi-Fi y te dice cuáles parecen cámaras
(cámaras IP, cámaras Wi-Fi baratas, "cámaras espía" escondidas en cargadores, relojes, detectores de humo, etc.).
Es un proyecto aparte de Mi Luz RD.

Úsalo solo en redes donde tienes permiso: tu casa, tu negocio, o el alojamiento donde te estás quedando.

## Cómo usarlo

**Opción fácil, sin instalar nada:** descarga `DetectorCamaras.exe`
(GitHub → pestaña **Actions** → "Detector de camaras (.exe para Windows)" → la última ejecución → **DetectorCamaras-Windows**).
Descomprime el zip y abre el `.exe`. Si Windows muestra "Windows protegió su PC", toca **Más información → Ejecutar de todas formas**
(sale porque el programa no está firmado).

**Con Python:** instala Python 3 desde https://www.python.org/downloads/ (marca **Add Python to PATH**)
y haz doble clic en **Buscar-Camaras.bat**.

Luego:
1. Conecta la computadora al Wi-Fi que quieres revisar.
2. Pulsa **Buscar cámaras**. Si Windows pregunta por el firewall, dale **Permitir** (sin eso, algunas cámaras no pueden contestar).
3. En 1 o 2 minutos sale la lista de equipos en colores: 🔴 muy probable cámara, 🟠 posible, 🟡 poco probable, 🟢 no parece cámara.
   Toca un equipo para ver por qué; doble clic abre su página web. **Abrir informe** guarda todo en una página para imprimir o compartir.

Versión de consola (Windows, Linux, Mac): `python3 detector_camaras.py`, o para otra red `python3 detector_camaras.py --red 192.168.0.0/24`.

## Ver tus propias cámaras en vivo

Si en la lista sale tu NVR/DVR o una cámara tuya (los que transmiten video RTSP), selecciónalo y pulsa **📹 Ver cámaras**.
Pon el usuario y la contraseña del NVR (los mismos de su pantalla o de su app; el usuario casi siempre es `admin`)
y cuántas cámaras tiene. La app prueba sola los formatos de Hikvision, Swann, Lorex, Dahua, Reolink, Uniview y otros,
y muestra las cámaras en cuadrícula. Doble clic en una la abre en grande; clic derecho copia su dirección para VLC.

- La contraseña solo se usa mientras la ventana está abierta; no se guarda.
- Si la contraseña está mal, la app se detiene al primer intento para que el NVR no se bloquee.
- Solo para equipos tuyos o que tengas permiso de ver.

## Qué revisa

| Prueba | Qué significa |
|---|---|
| ONVIF (WS-Discovery) | Pregunta por la red "¿quién es cámara?"; las cámaras compatibles con ONVIF contestan solas. |
| RTSP (puertos 554, 8554, 10554) | Si el equipo contesta como servidor de video en vivo, casi seguro es una cámara. |
| Puertos típicos | 34567 (cámaras chinas XMEye), 37777 (Dahua), 8000 (Hikvision), 8899, 1935, 23, 6668 (Tuya). |
| Página web del equipo | Busca palabras como Hikvision, IP Camera, DVR, NVR, V380, iCSee, ONVIF en el título y el servidor. |
| UPnP (SSDP) | Lee cómo se anuncia el equipo en la red (fabricante y modelo). |
| Dirección MAC | Dice la marca de cada equipo con la lista oficial de fabricantes (`oui.txt.gz`, unos 30 000) y avisa si es de cámaras (Hikvision, Dahua, Swann, Reolink…) o un chip Wi-Fi barato. |
| Nombre del equipo | Nombres con "cam", "ipc", "dvr", etc. |

## Límites

- **Cámaras conectadas a un grabador (NVR/DVR):** las cámaras van por cable al grabador, que les da una red propia por dentro.
  Desde el Wi-Fi solo se ve el grabador (sale en rojo porque transmite video), no cada cámara.

- Solo ve equipos en **la misma red**. Una cámara en otra red Wi-Fi, con chip de datos 4G, o que solo graba en una
  memoria, no aparece. Por eso el informe trae también consejos de revisión física (linterna y lente, luces infrarrojas,
  redes Wi-Fi raras como `IPC-xxxx` o `HDWIFICAM`).
- "Posible cámara" no es prueba: impresoras, TV y bombillos inteligentes a veces dan pistas parecidas.
