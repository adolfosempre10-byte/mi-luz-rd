# Mi Luz RD

App para el celular que mide tu consumo de luz con fotos del contador y lo compara con la factura de la distribuidora.
Es un proyecto aparte: no tiene nada que ver con el sistema de gestión de S&M Solutions.

## Qué hace

- **Foto del contador**: tomas la foto, la app lee el número (sin internet) y tú lo corriges si se equivocó.
  La primera vez, pasa el dedo sobre los números del contador para encerrarlos; la app recuerda esa zona para las fotos siguientes.
- **Período de factura**: pones el día de corte y la app cuenta los kWh desde ese día hasta el próximo corte:
  lo gastado hasta hoy, el promedio por día y cuánto vas a gastar al cierre.
- **Estimado del mes**: con dos fotos o más te dice "gastas X kWh por día; si sigues así, el mes completo serán Y kWh y pagarás unos RD$ Z",
  y si tu consumo es parejo (estimado confiable) o cambia mucho. Abajo hay una tabla día a día con lo que subió el contador y la suma acumulada del mes.
- **Costo en pesos** con la tarifa residencial **BTS-1**:

  | Concepto | Edesur | Edenorte | Edeeste |
  |---|---|---|---|
  | Cargo fijo, 0–100 kWh | 42.10 | 40.33 | 41.34 |
  | Cargo fijo, más de 100 kWh | 128.59 | 126.81 | 127.83 |
  | 0–200 kWh (RD$/kWh) | 6.05 | 5.97 | 6.17 |
  | 201–300 kWh | 8.59 | 8.51 | 8.71 |
  | 301–700 kWh | 12.89 | 13.83 | 13.04 |
  | 701 kWh o más: **todos** los kWh a | 13.09 | 14.04 | 13.26 |

  Fuente: Resolución **SIE-121-2026-TF** de la Superintendencia de Electricidad (tarifas de octubre a diciembre de 2026, página 8).
  La SIE la revisa cada 3 meses. Si cambia, se corrige en **Ajustes**.
- **Comparar con la factura**: anotas los kWh y el monto de la factura, y la app te dice si te cobraron más de lo que mediste,
  si el monto no cuadra con la tarifa, o si la lectura de la factura parece estimada.
- Todo se guarda **en el teléfono**. En Ajustes puedes guardar una copia (archivo) para no perder las fotos si cambias de teléfono.

## Probarla en la computadora

Doble clic en `Abrir-Mi-Luz.bat`. Se abre en el navegador. Deja la ventana negra abierta mientras la usas.

## Abrirla en el celular

**Para probar rápido (mismo WiFi):** abre `Abrir-Mi-Luz.bat` en la computadora y, en el celular conectado al mismo WiFi,
escribe en Chrome la dirección que aparece en la ventana negra (algo como `http://192.168.1.20:8090`).
Si Windows pregunta si deja pasar a "Node.js", dile que sí (red privada).
Así funciona solo mientras la computadora esté prendida con la ventana abierta.

**Para usarla todos los días (recomendado):** hay que subir esta carpeta a una página gratis con `https`
(por ejemplo GitHub Pages o Netlify). Después se abre esa dirección en el celular una sola vez, se instala en la pantalla de inicio
y ya funciona sin internet y sin la computadora. Lo que se sube es solo la app; tus fotos y lecturas nunca salen del teléfono.

## Archivos

- `index.html`, `styles.css`, `app.js`: la app.
- `sw.js`, `manifest.json`, `icons/`: para instalarla y que funcione sin internet.
- `vendor/`: el lector de números (Tesseract.js, licencia Apache 2.0).
- `servidor.js`, `Abrir-Mi-Luz.bat`: para abrirla desde la computadora.
