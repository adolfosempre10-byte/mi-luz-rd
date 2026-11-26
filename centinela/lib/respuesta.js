'use strict';
// Respuesta automatica: bloquea IPs en el firewall del sistema (iptables, firewall de Windows o pf de macOS),
// las desbloquea al vencer el tiempo y ejecuta el comando de emergencia ante ransomware.
const { execFile } = require('child_process');
const net = require('net');
const { normalizarIp, log } = require('./util');

function ejecutar(cmd, args, extraEnv) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 20000, windowsHide: true, env: { ...process.env, ...extraEnv } }, (err, stdout, stderr) => {
      resolve({ ok: !err, salida: String(stdout || '') + String(stderr || ''), error: err ? err.message : null });
    });
  });
}

/** Comandos de firewall por sistema operativo. La IP siempre llega validada (net.isIP) y sin shell. */
const FIREWALLS = {
  linux: {
    async bloquear(ip, cadenas) {
      const bin = net.isIPv6(ip) ? 'ip6tables' : 'iptables';
      for (const cadena of cadenas) {
        const regla = [cadena, '-s', ip, '-m', 'comment', '--comment', 'centinela', '-j', 'DROP'];
        const existe = await ejecutar(bin, ['-C', ...regla]);
        if (existe.ok) continue;
        const r = await ejecutar(bin, ['-I', cadena, '1', ...regla.slice(1)]);
        if (!r.ok) return r;
      }
      return { ok: true };
    },
    async desbloquear(ip, cadenas) {
      const bin = net.isIPv6(ip) ? 'ip6tables' : 'iptables';
      let ultimo = { ok: true };
      for (const cadena of cadenas) {
        // Puede haber quedado repetida; se borra hasta que no exista.
        for (let i = 0; i < 5; i++) {
          const r = await ejecutar(bin, ['-D', cadena, '-s', ip, '-m', 'comment', '--comment', 'centinela', '-j', 'DROP']);
          if (!r.ok) break;
          ultimo = r;
        }
      }
      return ultimo;
    },
  },
  win32: {
    async bloquear(ip) {
      const nombre = `Centinela-${ip}`;
      await ejecutar('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=${nombre}`]);
      const a = await ejecutar('netsh', ['advfirewall', 'firewall', 'add', 'rule', `name=${nombre}`, 'dir=in', 'action=block', `remoteip=${ip}`, 'enable=yes']);
      if (!a.ok) return a;
      return ejecutar('netsh', ['advfirewall', 'firewall', 'add', 'rule', `name=${nombre}`, 'dir=out', 'action=block', `remoteip=${ip}`, 'enable=yes']);
    },
    desbloquear(ip) { return ejecutar('netsh', ['advfirewall', 'firewall', 'delete', 'rule', `name=Centinela-${ip}`]); },
  },
  darwin: {
    async bloquear(ip) {
      const r = await ejecutar('pfctl', ['-t', 'centinela', '-T', 'add', ip]);
      await ejecutar('pfctl', ['-k', ip]); // corta las conexiones que ya tenia abiertas
      return r;
    },
    desbloquear(ip) { return ejecutar('pfctl', ['-t', 'centinela', '-T', 'delete', ip]); },
  },
};

class Respuesta {
  /**
   * @param {object} o
   * @param {object} o.config     seccion "respuesta" de la configuracion
   * @param {import('./almacen').Almacen} o.almacen
   * @param {{contiene(ip):boolean}} o.listaBlanca
   */
  constructor({ config = {}, almacen, listaBlanca, plataforma = process.platform }) {
    this.config = {
      bloquearAutomatico: true, simulacro: false, duraciones: [3600, 86400, 604800], cadenas: ['INPUT'], ...config,
    };
    this.almacen = almacen;
    this.listaBlanca = listaBlanca;
    this.firewall = FIREWALLS[plataforma];
    if (!this.firewall && !this.config.simulacro) {
      log('aviso', `Sistema "${plataforma}" sin firewall soportado: se avisara pero no se bloqueara.`);
    }
  }

  get modo() { return this.config.simulacro ? 'simulacro' : this.firewall ? 'activo' : 'solo-avisos'; }

  /** Bloquea una IP. Devuelve el bloqueo, o {omitido: motivo} si no se bloqueo. */
  bloquear(ipCruda, opciones = {}) {
    // Una IP a la vez: dos reglas que saltan juntas no deben bloquearla dos veces.
    const ip = normalizarIp(ipCruda) || String(ipCruda);
    this.enCurso = this.enCurso || new Map();
    const previa = this.enCurso.get(ip) || Promise.resolve();
    const tarea = previa.then(() => this.bloquearAhora(ipCruda, opciones));
    this.enCurso.set(ip, tarea.catch(() => {}));
    tarea.finally(() => { if (this.enCurso.get(ip) === tarea) this.enCurso.delete(ip); }).catch(() => {});
    return tarea;
  }

  async bloquearAhora(ipCruda, { motivo = '', incidente = null, segundos, hasta, origen = 'automatico', quien = 'centinela' } = {}) {
    const ip = normalizarIp(ipCruda);
    if (!ip) return { omitido: 'IP no valida' };
    if (this.listaBlanca.contiene(ip)) return { omitido: 'IP en lista blanca' };

    const activo = this.almacen.bloqueoActivo(ip);
    if (activo) {
      if (incidente && !activo.incidentes.includes(incidente)) activo.incidentes.push(incidente);
      if (hasta && activo.hasta && Date.parse(hasta) > Date.parse(activo.hasta)) activo.hasta = hasta;
      this.almacen.guardar();
      return activo;
    }

    const veces = this.almacen.bloqueos.filter((b) => b.ip === ip).length;
    const d = this.config.duraciones;
    const dur = segundos ?? d[Math.min(veces, d.length - 1)];
    const fin = hasta || (dur > 0 ? new Date(Date.now() + dur * 1000).toISOString() : null);

    const r = await this.aplicar('bloquear', ip);
    const bloqueo = {
      ip, desde: new Date().toISOString(), hasta: fin, motivo, origen, quien, vez: veces + 1,
      incidentes: incidente ? [incidente] : [], activo: true, aplicado: r.ok, error: r.ok ? undefined : r.error,
    };
    this.almacen.bloqueos.push(bloqueo);
    if (this.almacen.bloqueos.length > 5000) this.almacen.bloqueos.splice(0, this.almacen.bloqueos.findIndex((b) => !b.activo) + 1 || 1);
    this.almacen.guardar();
    const plazo = fin ? `hasta ${fin.replace('T', ' ').slice(0, 16)} UTC` : 'de forma permanente';
    this.almacen.auditoria(`BLOQUEO ${ip} ${plazo} por ${quien}: ${motivo}${r.ok ? '' : ` (FALLO: ${r.error})`}`);
    log('accion', `${this.modo === 'simulacro' ? '[simulacro] ' : ''}IP ${ip} bloqueada ${plazo}. ${r.ok ? '' : `No se pudo aplicar en el firewall: ${r.error}`}`);
    return bloqueo;
  }

  async desbloquear(ipCruda, quien = 'centinela') {
    const ip = normalizarIp(ipCruda);
    if (!ip) return false;
    let hubo = false;
    for (const b of this.almacen.bloqueos) {
      if (b.ip === ip && b.activo) { b.activo = false; b.levantado = new Date().toISOString(); b.levantadoPor = quien; hubo = true; }
    }
    const r = await this.aplicar('desbloquear', ip);
    this.almacen.guardar();
    this.almacen.auditoria(`DESBLOQUEO ${ip} por ${quien}${r.ok ? '' : ` (aviso: ${r.error})`}`);
    log('accion', `IP ${ip} desbloqueada por ${quien}.`);
    return hubo;
  }

  async aplicar(accion, ip) {
    if (this.config.simulacro) { log('accion', `[simulacro] firewall ${accion} ${ip}`); return { ok: true }; }
    if (!this.firewall) return { ok: false, error: 'sistema sin firewall soportado' };
    try { return await this.firewall[accion](ip, this.config.cadenas); } catch (e) { return { ok: false, error: e.message }; }
  }

  /** Levanta los bloqueos vencidos. Se llama cada minuto. */
  async revisarVencidos() {
    const ahora = Date.now();
    for (const b of this.almacen.bloqueos) {
      if (b.activo && b.hasta && Date.parse(b.hasta) <= ahora) await this.desbloquear(b.ip, 'vencimiento');
    }
  }

  /** Al arrancar, vuelve a poner en el firewall los bloqueos vigentes (por si el equipo se reinicio). */
  async reaplicar() {
    const vigentes = this.almacen.bloqueos.filter((b) => b.activo && (!b.hasta || Date.parse(b.hasta) > Date.now()));
    for (const b of vigentes) await this.aplicar('bloquear', b.ip);
    if (vigentes.length) log('info', `Se reaplicaron ${vigentes.length} bloqueo(s) vigentes.`);
  }

  /** Comando de emergencia (por ejemplo desconectar la red) ante ransomware. Lo define el administrador. */
  async emergencia(inc) {
    const cmd = this.config.comandoEmergencia;
    if (!Array.isArray(cmd) || !cmd.length) return null;
    if (this.config.simulacro) { log('accion', `[simulacro] comando de emergencia: ${cmd.join(' ')}`); return { ok: true }; }
    const r = await ejecutar(cmd[0], cmd.slice(1), {
      CENTINELA_INCIDENTE: inc.id, CENTINELA_REGLA: inc.regla, CENTINELA_IP: inc.ip || '', CENTINELA_EQUIPO: inc.host,
    });
    this.almacen.auditoria(`EMERGENCIA ${cmd.join(' ')} por ${inc.id}: ${r.ok ? 'ok' : r.error}`);
    return r;
  }
}

module.exports = { Respuesta, ejecutar };
