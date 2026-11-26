# Lab 5: Wazuh, detección de actividad maliciosa

Lo que hay en esta carpeta, en el orden en que se usa:

| Archivo | Para qué |
|---|---|
| `simulacion-windows.ps1` | En el agente Windows: activa la auditoría y simula fuerza bruta (4625), creación de usuario (4720), escalada a Administradores (4732), tarea programada (4698) y borrado del log (1102). Guarda la hora de cada paso en `lineadetiempo.csv`. |
| `simulacion-linux.sh` | Lo mismo en un agente Ubuntu: instala auditd, carga las reglas, conecta `audit.log` a Wazuh y simula los ataques. |
| `plantilla-informe.md` | El informe con todas las secciones. Se rellena y se exporta a PDF. |

## Lista de control para entregar

- [ ] Captura de la IP de las 2 VMs y del ping entre ellas
- [ ] Instalación de Wazuh terminada (tapar la contraseña)
- [ ] Dashboard abierto con la sesión iniciada
- [ ] Problemas resueltos durante la instalación, si hubo (por ejemplo, el puerto 443 ocupado)
- [ ] Agente en estado **Active**
- [ ] Auditoría activada (`auditpol`) o reglas de auditd (`auditctl -l`)
- [ ] Una captura por evento en Wazuh, con el Event ID, la hora y el agente visibles
- [ ] Captura del 1102 en Wazuh **y** del Visor de eventos local vacío (prueba de que el SIEM conservó todo)
- [ ] Tabla de la línea de tiempo (sale de `lineadetiempo.csv`)
- [ ] Conclusión
- [ ] Limpieza hecha (`-Limpiar`)
- [ ] `Tarea02_Apellido_Nombre.pdf` + `.zip` con el PDF, las capturas y los scripts
