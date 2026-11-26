# Detector de cámaras ocultas

Programa para la computadora que revisa todos los equipos conectados a tu red Wi-Fi y te dice cuáles parecen cámaras
(cámaras IP, cámaras Wi-Fi baratas, "cámaras espía" escondidas en cargadores, relojes, detectores de humo, etc.).
Es un proyecto aparte de Mi Luz RD.

Úsalo solo en redes donde tienes permiso: tu casa, tu negocio, o el alojamiento donde te estás quedando.

## Cómo usarlo

1. Instala Python 3 desde https://www.python.org/downloads/ (marca **Add Python to PATH**). No hace falta nada más.
2. Conecta la computadora al mismo Wi-Fi que quieres revisar.
3. Doble clic en **Buscar-Camaras.bat**. Si Windows pregunta por el firewall, dale **Permitir**
   (hace falta para que las cámaras puedan contestar).
4. En 1 o 2 minutos se abre un informe en el navegador con cada equipo marcado como
   **Muy probable cámara**, **Posible cámara**, **Poco probable** o **No parece cámara**, y el porqué.

En Linux o Mac: `python3 detector_camaras.py`. Para otra red: `python3 detector_camaras.py --red 192.168.0.0/24`.

## Qué revisa

| Prueba | Qué significa |
|---|---|
| ONVIF (WS-Discovery) | Pregunta por la red "¿quién es cámara?"; las cámaras compatibles con ONVIF contestan solas. |
| RTSP (puertos 554, 8554, 10554) | Si el equipo contesta como servidor de video en vivo, casi seguro es una cámara. |
| Puertos típicos | 34567 (cámaras chinas XMEye), 37777 (Dahua), 8000 (Hikvision), 8899, 1935, 23, 6668 (Tuya). |
| Página web del equipo | Busca palabras como Hikvision, IP Camera, DVR, NVR, V380, iCSee, ONVIF en el título y el servidor. |
| UPnP (SSDP) | Lee cómo se anuncia el equipo en la red (fabricante y modelo). |
| Dirección MAC | Reconoce tarjetas de red de fabricantes de cámaras (Hikvision, Dahua, Axis, Reolink, Wyze…) y chips Wi-Fi baratos. |
| Nombre del equipo | Nombres con "cam", "ipc", "dvr", etc. |

## Límites

- Solo ve equipos en **la misma red**. Una cámara en otra red Wi-Fi, con chip de datos 4G, o que solo graba en una
  memoria, no aparece. Por eso el informe trae también consejos de revisión física (linterna y lente, luces infrarrojas,
  redes Wi-Fi raras como `IPC-xxxx` o `HDWIFICAM`).
- "Posible cámara" no es prueba: impresoras, TV y bombillos inteligentes a veces dan pistas parecidas.
