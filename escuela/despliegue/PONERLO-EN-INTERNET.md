# Poner el Registro Escolar en internet

Así las familias ven el boletín desde su casa y los docentes ponen notas desde cualquier lugar.

## Las dos formas

| | Servidor en la nube (recomendado) | Computadora del centro + túnel |
|---|---|---|
| Costo | Unos US$5–6 al mes | Gratis (más un dominio, unos US$10–15 al año) |
| Si se va la luz o el internet en el centro | Sigue funcionando | Nadie puede entrar hasta que vuelva |
| Dónde quedan las notas | En el servidor alquilado | En la computadora del centro |
| Dirección | Gratis sin comprar dominio (`…sslip.io`) | Necesita un dominio propio |
| Dificultad | Copiar y pegar un comando | Más pasos y la computadora siempre encendida |

En República Dominicana los apagones son comunes, por eso se recomienda **el servidor en la nube**.

## Servidor en la nube, paso a paso

### 1. Alquilar el servidor (10 minutos)

Cualquier proveedor sirve. Por ejemplo **DigitalOcean** (droplet de US$6) o **Hetzner** (CX22, unos €4).

- Sistema: **Ubuntu 24.04**.
- Tamaño: el más pequeño (1 GB de memoria alcanza para un centro de cientos de estudiantes).
- Región: la más cercana (Nueva York o Miami).
- Activa las **copias de seguridad automáticas** del proveedor (cuesta poco más y guarda todo el servidor cada día o semana).
- Pon una clave fuerte para el usuario `root` o, mejor, una llave SSH.

Al terminar, el proveedor te muestra la **IP** del servidor (por ejemplo `203.0.113.25`).

### 2. Entrar al servidor

Los dos proveedores tienen un botón **Console** en su página que abre una ventana negra en el navegador.
También puedes entrar desde la computadora: `ssh root@203.0.113.25`.

### 3. Instalar (5 minutos)

Copia y pega este comando y dale Enter:

```
curl -fsSL https://raw.githubusercontent.com/adolfosempre10-byte/mi-luz-rd/main/escuela/despliegue/instalar.sh | bash
```

Al terminar muestra algo así:

```
 Listo. Abre:  https://203-0-113-25.sslip.io
 Código de instalación:  482913
```

Si ya tienes un dominio, primero apúntalo a la IP del servidor (un registro **A** en la página donde lo compraste)
y usa este comando en vez del anterior:

```
curl -fsSL https://raw.githubusercontent.com/adolfosempre10-byte/mi-luz-rd/main/escuela/despliegue/instalar.sh | DOMINIO=notas.micolegio.edu.do bash
```

### 4. Configurar

Abre la dirección que te dio, escribe el **código de instalación** y crea la cuenta de la dirección.
El código evita que otra persona configure el sistema antes que tú. Si lo perdiste, en el servidor escribe:
`journalctl -u registro-escolar | grep INSTALACIÓN`

No uses «Probar con datos de ejemplo» en el servidor real: deja creadas cuentas con claves conocidas.

### 5. Dar acceso a las familias

En **Usuarios → Nuevo usuario**, rol **Familia**, se eligen sus hijos y se le entrega a la familia:
la dirección, su usuario y su clave. La primera vez que entren se les pide cambiar la clave.
También se crea desde **Estudiantes** con el botón 👪 de cada estudiante.

## Actualizar el sistema

Cuando haya una versión nueva en GitHub, entra al servidor y vuelve a ejecutar el mismo comando de instalación.
Las notas no se tocan: están en `/var/lib/registro-escolar`.

## Copias de seguridad

- El sistema guarda una copia por día en el servidor (las últimas 30).
- Las copias automáticas del proveedor guardan el servidor entero.
- Además, cada semana o al cerrar cada período: **Centro educativo → Descargar copia de todo**, y guarda ese archivo
  fuera del servidor (memoria USB, Google Drive). Ese archivo tiene todas las notas y datos de los estudiantes:
  guárdalo en un lugar privado.

## Si algo falla

- Ver si está funcionando: `systemctl status registro-escolar`
- Ver los mensajes: `journalctl -u registro-escolar -n 50`
- Reiniciar: `systemctl restart registro-escolar`
- Si la página no abre con `https://` justo después de instalar, espera un minuto: es el certificado que se está creando.

## Computadora del centro + túnel (la otra forma)

Necesitas un dominio propio puesto en **Cloudflare** (gratis) y la computadora del centro encendida siempre.

1. En la computadora del centro, abre el sistema con este comando (en vez del `.bat`):
   `set PROXY=1&& set HOST=127.0.0.1&& node servidor.js` (Windows) o `PROXY=1 HOST=127.0.0.1 node servidor.js` (Linux/Mac).
2. Instala **cloudflared** y crea un túnel (Cloudflare → Zero Trust → Networks → Tunnels → Create a tunnel)
   que envíe tu dominio, por ejemplo `notas.micolegio.edu.do`, a `http://localhost:8091`.
3. Abre `https://notas.micolegio.edu.do`.

Con `HOST=127.0.0.1` los docentes ya no entran por el WiFi con la IP local; entran todos por el dominio.
