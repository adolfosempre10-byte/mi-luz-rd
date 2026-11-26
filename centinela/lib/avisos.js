'use strict';
// Avisos al equipo de tecnologia: Telegram, correo, y webhooks (Slack, Microsoft Teams, Discord o JSON).
const { enviarCorreo } = require('./correo');
const { informeTexto } = require('./investigacion');
const { nivel, log } = require('./util');

const ICONO = { baja: '🔵', media: '🟡', alta: '🟠', critica: '🔴' };

function mensajeCorto(inc, tipo, urlPanel) {
  const inv = inc.investigacion || {};
  const l = [];
  const cabecera = { nuevo: 'ALERTA DE SEGURIDAD', escalado: 'ALERTA ESCALADA', prueba: 'PRUEBA DE AVISOS' }[tipo] || 'ALERTA';
  l.push(`${ICONO[inc.severidad] || ''} ${cabecera} [${inc.severidad.toUpperCase()}]`);
  l.push(inc.titulo);
  l.push(`Equipo: ${inc.host}`);
  if (inc.ip) {
    const extra = [inv.origen, inv.ubicacion?.pais, inv.reputacion ? `reputacion ${inv.reputacion.puntaje}/100` : null].filter(Boolean).join(', ');
    l.push(`Atacante: ${inc.ip}${extra ? ` (${extra})` : ''}`);
  }
  if (inc.usuarios?.length) l.push(`Usuarios: ${inc.usuarios.slice(0, 5).join(', ')}`);
  l.push(`Eventos: ${inc.eventos} entre ${hora(inc.primerEvento)} y ${hora(inc.ultimoEvento)}`);
  const acciones = (inc.acciones || []).map((a) => a.texto);
  l.push(`Accion: ${acciones.length ? acciones.join(' / ') : 'solo aviso'}`);
  if (inc.notas?.length) l.push(inc.notas[0]);
  l.push(`Que hacer: ${inc.recomendacion}`);
  if (inc.evidencia?.length) l.push(`Evidencia: ${inc.evidencia[inc.evidencia.length - 1].slice(0, 300)}`);
  if (urlPanel) l.push(`Panel: ${urlPanel}#${inc.id}`);
  return l.join('\n');
}

const hora = (iso) => new Date(iso).toLocaleString('es-DO', { hour12: false });

class Avisos {
  /**
   * @param {object} config seccion "avisos": { urlPanel, maximoPorHora, telegram, correo, webhooks }
   */
  constructor(config = {}) {
    this.config = config;
    this.enviadosHora = [];
    this.retenidos = 0;
  }

  get canales() {
    const c = [];
    const { telegram, correo, webhooks } = this.config;
    if (telegram?.token && telegram?.chats?.length) c.push({ nombre: 'telegram', min: telegram.severidadMinima, enviar: (a, t) => this.telegram(t) });
    if (correo?.host && correo?.para?.length) c.push({ nombre: 'correo', min: correo.severidadMinima, enviar: (a, t, inc) => enviarCorreo(correo, a, inc ? `${t}\n\n${'-'.repeat(60)}\n${informeTexto(inc)}` : t) });
    for (const w of webhooks || []) if (w.url) c.push({ nombre: `webhook ${w.formato || 'json'}`, min: w.severidadMinima, enviar: (a, t, inc) => this.webhook(w, t, inc) });
    return c;
  }

  /** Envia el aviso de un incidente por todos los canales cuya severidad minima se cumpla. */
  async incidente(inc, tipo = 'nuevo') {
    const ahora = Date.now();
    this.enviadosHora = this.enviadosHora.filter((t) => ahora - t < 3600e3);
    const maximo = this.config.maximoPorHora ?? 30;
    // Las alertas criticas siempre salen; las demas se frenan si hay una tormenta de avisos.
    if (this.enviadosHora.length >= maximo && inc.severidad !== 'critica') {
      this.retenidos++;
      if (this.retenidos === 1) log('aviso', `Mas de ${maximo} avisos en una hora: se retienen los no criticos (se ven en el panel).`);
      return [];
    }
    this.enviadosHora.push(ahora);
    if (this.retenidos && this.enviadosHora.length < maximo) this.retenidos = 0;
    const asunto = `[Centinela ${inc.severidad.toUpperCase()}] ${inc.titulo} - ${inc.host}${inc.ip ? ` - ${inc.ip}` : ''}`;
    const texto = mensajeCorto(inc, tipo, this.config.urlPanel);
    return this.aTodos(asunto, texto, inc, inc.severidad);
  }

  async aTodos(asunto, texto, inc = null, severidad = 'critica') {
    const resultados = [];
    for (const canal of this.canales) {
      if (nivel(severidad) < nivel(canal.min || this.config.severidadMinima || 'media')) continue;
      try {
        await canal.enviar(asunto, texto, inc);
        resultados.push({ canal: canal.nombre, ok: true });
      } catch (e) {
        log('error', `No se pudo avisar por ${canal.nombre}: ${e.message}`);
        resultados.push({ canal: canal.nombre, ok: false, error: e.message });
      }
    }
    return resultados;
  }

  async telegram(texto) {
    const { token, chats } = this.config.telegram;
    for (const chat of chats) {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: texto.slice(0, 4000), disable_web_page_preview: true }),
      });
      if (!r.ok) throw new Error(`Telegram respondio ${r.status}: ${(await r.text()).slice(0, 200)}`);
    }
  }

  async webhook(w, texto, inc) {
    const formato = w.formato || 'json';
    const cuerpo = {
      slack: { text: texto },
      teams: { text: texto.replace(/\n/g, '\n\n') },
      discord: { content: texto.slice(0, 1900) },
      json: { texto, incidente: inc },
    }[formato] || { texto, incidente: inc };
    const r = await fetch(w.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(w.cabeceras || {}) }, body: JSON.stringify(cuerpo) });
    if (!r.ok) throw new Error(`respondio ${r.status}`);
  }
}

module.exports = { Avisos, mensajeCorto };
