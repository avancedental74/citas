/**
 * AVANCE DENTAL — Servidor WhatsApp Baileys v4
 * Motor de conversión con A/B tracking via GA4 UTM
 */

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers
} = require('@whiskeysockets/baileys');
const { Boom }   = require('@hapi/boom');
const P          = require('pino');
const express    = require('express');
const cors       = require('cors');
const cron       = require('node-cron');
const fs         = require('fs');
const path       = require('path');
let nodemailer;
try { nodemailer = require('nodemailer'); } catch { nodemailer = null; }
let archiver;
try { archiver = require('archiver'); } catch { archiver = null; }
let BetaAnalyticsDataClient;
try { BetaAnalyticsDataClient = require('@google-analytics/data').BetaAnalyticsDataClient; } catch { BetaAnalyticsDataClient = null; }

// ── CONFIG ────────────────────────────────────────────────────────────────────
const PORT      = 3001;
const DATA_FILE      = path.join(__dirname, 'data.json');
const COLA_FILE      = path.join(__dirname, 'cola.json');
const CONFIG_FILE    = path.join(__dirname, 'config.json');
const LEADS_FILE     = path.join(__dirname, 'leads.json');
const ESPERANDO_FILE = path.join(__dirname, 'esperando.json');
const CONV_FILE      = path.join(__dirname, 'conversaciones.json');
const BACKUP_DIR  = path.join(__dirname, 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

const CONFIG_DEFAULT = {
  val_activo:     true,
  val_maxPorDia:  30,
  // #7: hora por día L=1..V=5
  horariosVal: { 1:'10:30', 2:'11:00', 3:'10:30', 4:'11:00', 5:'10:00' },

  cita_activo:    true,
  cita_maxPorDia: 50,
  cita_horaEnvio: '09:00',

  delayMinSeg:    8,
  delayMaxSeg:    20,
  bloquearFinde:  true,

  numResenias:    127,   // se muestra en el mensaje ("ya somos X familias")
  flujoSiNo:      false,  // legacy — se mantiene por compatibilidad
  flujoSiNo_cita: false,  // true = flujo SÍ/NO en recordatorios de cita
  flujoSiNo_val:  false,  // true = flujo SÍ/NO en mensajes de valoración
  abTracking:     false,  // registra variante enviada + clics por UTM

  // Aviso al operador cuando paciente dice NO a cita
  // Método: 'email' (recomendado) | 'whatsapp' (requiere segundo número)
  avisoMetodo:    'email',
  avisoEmail:     '',         // email de la recepcionista
  avisoEmailUser: '',         // cuenta Gmail que envía (p.ej. clinica@gmail.com)
  avisoEmailPass: '',         // contraseña de aplicación Gmail (no la normal)
  avisoWhatsapp:  '',         // si método=whatsapp, número de 9 dígitos del operador
  msgConfirmado:  '',
  msgRechazado:   '',

  // Google Analytics 4
  ga4PropertyId:      '',
  ga4CredentialsPath: '',
};

// ── CONSTANTES ────────────────────────────────────────────────────────────────
const CLINICA         = 'Avance Dental';
const LANDING_BASE    = 'https://avancedental74.github.io/citas/opinion.html';
const GOOGLE_REVIEW   = 'https://g.page/r/CRkkiSExZLnnEAE/review';

// UTM base — GA4 los recoge automáticamente sin tocar nada en opinion.html
// utm_content = v0/v1/v2/v3 → identifica la variante del A/B en Analytics
function urlConUtm(variante, tipo = 'val') {
  return `${LANDING_BASE}?utm_source=whatsapp&utm_medium=directo&utm_campaign=${tipo}&utm_content=v${variante}`;
}

// ── UTILS BÁSICOS (deben declararse antes que el estado) ──────────────────────
function hoy() { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jid(tel) { return `${tel}@s.whatsapp.net`; }
function telLimpio(t) { return String(t).replace(/\D/g, '').replace(/^34/, '').slice(-9); }

// ── ESTADO ────────────────────────────────────────────────────────────────────
let sockGlobal    = null;
let estadoWA      = 'desconectado';
let qrActual      = null;
let config = { ...CONFIG_DEFAULT };
// Cargar config guardada en disco (sobreescribe defaults) — función declarada más abajo, se llama tras el arranque
(function() {
  if (!fs.existsSync(CONFIG_FILE)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    Object.assign(config, saved);
  } catch { /* archivo corrupto — usar defaults */ }
})();
let cronJobVal    = null;
let cronJobCita   = null;
let enviosHoyVal  = 0;
let enviosHoyCita = 0;
let fechaConteo   = hoy();

// Pendientes SÍ/NO: tel → { nombre, variante, ts }
const esperandoRespuesta = new Map();

// Persistir esperandoRespuesta en disco para sobrevivir reinicios
function guardarEsperando() {
  const obj = {};
  esperandoRespuesta.forEach((v, k) => { obj[k] = v; });
  fs.writeFileSync(ESPERANDO_FILE, JSON.stringify(obj, null, 2));
}
function cargarEsperando() {
  if (!fs.existsSync(ESPERANDO_FILE)) return;
  try {
    const obj = JSON.parse(fs.readFileSync(ESPERANDO_FILE, 'utf8'));
    const lim  = Date.now() - 48 * 3600000; // descartar > 48h
    Object.entries(obj).forEach(([tel, v]) => {
      if (v.ts > lim) esperandoRespuesta.set(tel, v);
    });
    if (esperandoRespuesta.size) console.log(`🔄 ${esperandoRespuesta.size} respuestas pendientes recuperadas del disco`);
  } catch { /* archivo corrupto — ignorar */ }
}
cargarEsperando();

// ── CONVERSACIONES (log de respuestas de pacientes) ───────────────────────────
function cargarConversaciones() {
  if (!fs.existsSync(CONV_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(CONV_FILE, 'utf8')); } catch { return []; }
}
function guardarConversaciones(lista) {
  // Mantener solo las últimas 500 para no crecer indefinidamente
  const recorte = lista.slice(-500);
  fs.writeFileSync(CONV_FILE, JSON.stringify(recorte, null, 2));
}

// Debounce: ventana de 5 segundos para agrupar mensajes rápidos del mismo paciente
const DEBOUNCE_MS = 5000;

function registrarMensaje({ tel, nombre, mod, textoOriginal, resultado, ts }) {
  const ahora = ts || Date.now();
  const lista  = cargarConversaciones();

  // Buscar si ya hay un registro reciente del mismo tel + mod + resultado
  // Si existe, concatenar el texto en lugar de crear un duplicado
  const limDebounce = ahora - DEBOUNCE_MS;
  let idxExistente = -1;
  for (let i = lista.length - 1; i >= 0; i--) {
    const r = lista[i];
    if (r.tel === tel && r.mod === mod && r.resultado === resultado && r.ts >= limDebounce) {
      idxExistente = i;
      break;
    }
  }

  if (idxExistente !== -1) {
    // Actualizar el registro existente: añadir el nuevo texto y actualizar timestamp
    const reg = lista[idxExistente];
    const textosYa = reg.textos || [reg.texto];
    if (!textosYa.includes(textoOriginal)) textosYa.push(textoOriginal);
    lista[idxExistente] = {
      ...reg,
      texto:  textosYa.join(' / '),   // muestra todos los mensajes agrupados
      textos: textosYa,
      ts:     ahora,
      fecha:  new Date(ahora).toISOString(),
      agrupados: textosYa.length,
    };
    console.log(`🔁 Mensaje agrupado con registro anterior (${tel}) — total: ${textosYa.length}`);
  } else {
    lista.push({
      tel,
      nombre:  nombre || '—',
      mod:     mod || 'desconocido',
      texto:   textoOriginal,
      textos:  [textoOriginal],
      resultado,
      ts:      ahora,
      fecha:   new Date(ahora).toISOString(),
      agrupados: 1,
    });
  }

  guardarConversaciones(lista);
}

// ── PERSISTENCIA ──────────────────────────────────────────────────────────────
function cargarDatos() {
  if (!fs.existsSync(DATA_FILE)) return { enviados:{}, listaNegra:[], abStats:{} };
  try { const d=JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); if(!d.abStats)d.abStats={}; return d; }
  catch { return { enviados:{}, listaNegra:[], abStats:{} }; }
}
function guardarDatos(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d,null,2)); }
function cargarCola() {
  if (!fs.existsSync(COLA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(COLA_FILE,'utf8')); } catch { return []; }
}
function guardarCola(c) { fs.writeFileSync(COLA_FILE, JSON.stringify(c,null,2)); }

function cargarLeads() {
  if (!fs.existsSync(LEADS_FILE)) return { cita:[], val:[] };
  try { return JSON.parse(fs.readFileSync(LEADS_FILE,'utf8')); } catch { return { cita:[], val:[] }; }
}
function guardarLeads(l) { fs.writeFileSync(LEADS_FILE, JSON.stringify(l,null,2)); }

// ── CONFIG EN DISCO ───────────────────────────────────────────────────────────
function cargarConfigDisco() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8')); } catch { return {}; }
}
function guardarConfigDisco(obj) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(obj,null,2)); }

// ── UTILS ─────────────────────────────────────────────────────────────────────

function esFinde() {
  const d = new Date().toLocaleString('es-ES',{weekday:'long',timeZone:'Europe/Madrid'}).toLowerCase();
  return d==='sábado'||d==='domingo';
}

// Devuelve true si la fecha dada (string ISO o Date) cayó en martes (zona Madrid)
function eraMartes(fecha) {
  if (!fecha) return false;
  const d = new Date(fecha);
  if (isNaN(d)) return false;
  // Usamos el día de la semana en zona Madrid para evitar desfases UTC
  const diaMadrid = d.toLocaleString('es-ES', { weekday: 'long', timeZone: 'Europe/Madrid' }).toLowerCase();
  return diaMadrid === 'martes';
}

function horaSegunDia() {
  const s = new Date().toLocaleString('en-US',{weekday:'short',timeZone:'Europe/Madrid'});
  const m = {Mon:1,Tue:2,Wed:3,Thu:4,Fri:5};
  return (config.horariosVal?.[m[s]]) || '10:30';
}

function resetarContadoresSiNuevoDia() {
  if (fechaConteo !== hoy()) {
    enviosHoyVal  = 0;
    enviosHoyCita = 0;
    fechaConteo   = hoy();
    // Resetear flags de disparo diario para que el cron vuelva a disparar mañana
    yaEnviadoHoy.val  = null;
    yaEnviadoHoy.cita = null;
    console.log('🔄 Nuevo día — contadores y flags de cron reseteados');
  }
}

// ── MENSAJES ──────────────────────────────────────────────────────────────────
function fmtFecha(f) {
  if (!f) return '';
  const d=new Date(f); if(isNaN(d))return'';
  return d.toLocaleDateString('es-ES',{weekday:'long',day:'numeric',month:'long'});
}

// Referencia temporal relativa — la dimensión de personalización sin datos clínicos
function cuandoTemporal(fecha, hora) {
  const hoyD = new Date(); hoyD.setHours(0,0,0,0);
  const ayer  = new Date(hoyD); ayer.setDate(ayer.getDate()-1);
  const dias  = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];

  // Con hora → franja horaria: ultra específico
  let franja = null;
  if (hora) {
    const h = parseInt(hora.split(':')[0]);
    if      (h < 12) franja = 'esta mañana';
    else if (h < 15) franja = 'a mediodía';
    else             franja = 'esta tarde';
  }

  if (!fecha) return franja || 'recientemente';
  const f = new Date(fecha); f.setHours(0,0,0,0);
  const diff = Math.round((hoyD - f) / 86400000);

  if (diff === 0) return franja || 'hoy';
  if (diff === 1) return franja || 'ayer';
  return 'el ' + dias[f.getDay()]; // "el martes"
}

// ── ESTRUCTURA MENSAJE (elegida por el usuario) ───────────────────────────────
// Hola Nombre + saludo + fecha + cuerpo D1 + CTA 4 neutro
// Las 4 variantes A/B cambian el CUERPO (social proof, ángulo emocional)
// manteniendo la misma estructura y el mismo CTA para comparar con precisión

// ── CONSTRUIR MENSAJE VALORACIÓN ──────────────────────────────────────────────
// Estructura fija (elegida): Hola Nombre + fecha + cuerpo + CTA neutro
// Las 4 variantes A/B testean distintos cuerpos — misma estructura, distinto ángulo
// CTA fijo: "👇 ¿Nos cuentas? Responde *SÍ* o *NO* y en un momento te escribimos"
function construirMsgVal(p, variante) {
  const nombre  = p.nombre.split(' ')[0];
  const cuandoF = p.fecha ? `el *${fmtFecha(p.fecha)}*` : 'el otro día';
  const n       = config.numResenias || 127;

  // 4 cuerpos A/B — varían en ángulo emocional, nunca en estructura ni CTA
  const cuerpos = [
    // V0 — Importancia + comunidad (la elegida, base D1)
    `Gracias por visitarnos ${cuandoF} en *${CLINICA}*.

Tu opinión es muy importante para nosotros — nos ayuda a seguir mejorando y a que otras familias encuentren un dentista de confianza 🙏`,
    // V1 — Gratitud + mejora continua
    `Gracias por confiar en *${CLINICA}* ${cuandoF}.

Nos tomamos muy en serio cada visita — y tu opinión nos ayuda a ser mejores cada día 🙏`,
    // V2 — Cercanía + impacto real
    `Fue un placer tenerte con nosotros ${cuandoF} en *${CLINICA}*.

Tu valoración nos importa de verdad — es lo que nos ayuda a seguir dando el mejor servicio a cada paciente 🙏`,
    // V3 — Confianza + pertenencia
    `Gracias por elegirnos ${cuandoF} en *${CLINICA}*.

Somos *${n} familias* que confían en nosotros — y la opinión de cada una hace que sigamos mejorando 🙏`,
  ];

  // CTA de alta conversión — emojis en SÍ/NO, brevedad, beneficio inmediato
  const cta = `¿Nos dedicas 30 segundos?\n\n✅ *SÍ* — Te enviamos el enlace ahora mismo\n❌ *NO* — Sin problema, gracias igualmente 🙏`;

  const flujoVal = config.flujoSiNo_val ?? config.flujoSiNo; // compatibilidad con flag legacy
  if (flujoVal) {
    return [`Hola ${nombre} 🦷`, ``, cuerpos[variante % cuerpos.length], ``, cta].join('\n');
  } else {
    const url = urlConUtm(variante, 'val');
    return [`Hola ${nombre} 🦷`, ``, cuerpos[variante % cuerpos.length], ``, `👉 Cuéntanos aquí:`, url, ``, `¡Gracias, ${nombre}! 🌟`].join('\n');
  }
}

// Respuesta automática al SÍ — incluye UTM de la variante para tracking GA4
function construirMsgEnlace(nombre, variante) {
  const url = urlConUtm(variante, 'val');
  return [`¡Genial, ${nombre}! Nos alegra mucho 🌟`, ``, `Aquí tienes el enlace — tarda menos de un minuto:`, url, ``, `¡Gracias de corazón! 🙏`].join('\n');
}

function construirMsgRespuestaNo(nombre) {
  return [`Gracias por contestar, ${nombre} 🙏`, ``, `Si en algún momento quieres comentarnos algo, estamos aquí.`].join('\n');
}

// Respuestas para citas — usan config editable desde el HTML o mensajes default
function msgCitaConfirmado(nombre, fecha, hora) {
  if (config.msgConfirmado && config.msgConfirmado.trim()) {
    return config.msgConfirmado
      .replace('[nombre]', nombre)
      .replace('[fecha]', fecha ? fmtFecha(fecha) : '')
      .replace('[hora]', hora || '');
  }
  const horaTxt = hora ? ` a las ${hora}` : '';
  const fechaTxt = fecha ? fmtFecha(fecha) : '';
  return [`¡Perfecto, ${nombre}! ✅ Cita confirmada.`, `Te esperamos el ${fechaTxt}${horaTxt} en ${CLINICA}.`, `Si necesitas algo, escríbenos sin problema 😊`].join('\n');
}

function msgCitaRechazado(nombre) {
  if (config.msgRechazado && config.msgRechazado.trim()) {
    return config.msgRechazado
      .replace('[nombre]', nombre)
      .replace('[fecha]', '')
      .replace('[hora]', '');
  }
  return [`Entendido, ${nombre} 🙏`, `Nuestros operadores se pondrán en contacto contigo lo antes posible para agendar una nueva cita.`].join('\n');
}

// ── AVISO AL OPERADOR ─────────────────────────────────────────────────────────
async function avisarOperador(nombre, tel, fecha, hora, trat) {
  const fechaTxt = fecha ? fmtFecha(fecha) : 'sin fecha';
  const horaTxt  = hora  ? ` a las ${hora}` : '';
  const tratTxt  = trat  ? ` (${trat})` : '';
  const texto    = `⚠️ CITA CANCELADA\n\nPaciente: ${nombre}\nTeléfono: ${tel}\nCita: ${fechaTxt}${horaTxt}${tratTxt}\n\nPendiente de reagendar.`;

  if (config.avisoMetodo === 'whatsapp' && config.avisoWhatsapp) {
    // Aviso por WhatsApp a un segundo número (recepcionista)
    const telOp = String(config.avisoWhatsapp).replace(/\D/g,'').replace(/^34/,'').slice(-9);
    if (/^\d{9}$/.test(telOp)) {
      await enviarMensaje(telOp, texto).catch(e => console.error('❌ Aviso WA operador:', e.message));
      console.log(`📲 Aviso WA operador → ${telOp}`);
    }
  } else if (config.avisoMetodo === 'email' && config.avisoEmail && nodemailer) {
    // Aviso por email (gmail con contraseña de aplicación)
    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: config.avisoEmailUser, pass: config.avisoEmailPass }
      });
      await transporter.sendMail({
        from: config.avisoEmailUser,
        to: config.avisoEmail,
        subject: `⚠️ Cita cancelada — ${nombre} (${tel})`,
        text: `Paciente: ${nombre}\nTeléfono: ${tel}\nCita: ${fechaTxt}${horaTxt}${tratTxt}\n\nEl paciente ha respondido NO al recordatorio de cita. Pendiente de reagendar.`,
      });
      console.log(`📧 Aviso email operador → ${config.avisoEmail}`);
    } catch(e) {
      console.error('❌ Aviso email operador:', e.message);
    }
  } else {
    // Sin configuración — solo log en consola
    console.log(`⚠️ [AVISO OPERADOR] ${nombre} (${tel}) canceló su cita el ${fechaTxt}${horaTxt}${tratTxt}`);
  }
}

// Recordatorio de cita — gancho en primera línea para la push notification
const TRAT_DIFICIL = ['endodoncia','extraccion','extracción','implante','cirugia','cirugía','periodoncia','curetaje','injerto','ortodoncia','aparato','brackets'];
function esTratDificil(t) { if(!t)return false; const s=t.toLowerCase(); return TRAT_DIFICIL.some(k=>s.includes(k)); }

function construirMsgCita(p) {
  const nombre   = p.nombre.split(' ')[0];
  const hora     = p.hora ? ` a las *${p.hora}*` : '';
  const tratTxt  = p.trat ? ` para tu *${p.trat.toLowerCase()}*` : '';
  const fechaTxt = p.fecha ? `*${fmtFecha(p.fecha)}*` : 'próximamente';
  const difícil  = esTratDificil(p.trat);

  const lineas = [
    `Hola ${nombre} 👋`,
    ``,
    `Te escribimos desde *${CLINICA}* para recordarte que tienes cita${tratTxt} el ${fechaTxt}${hora}.`,
    ``,
  ];

  if (difícil) {
    lineas.push(`Sabemos que este tipo de tratamiento puede generar algo de nervios — estamos aquí para que te sientas cómodo/a en todo momento 🙌`);
    lineas.push(``);
  }

  lineas.push(
    `¿Puedes confirmarnos la asistencia?`,
    ``,
    `✅ Responde *SÍ* para confirmar`,
    `❌ Responde *NO* si necesitas cambiarla`
  );

  const flujoCita = config.flujoSiNo_cita ?? config.flujoSiNo; // compatibilidad legacy
  if (!flujoCita) {
    lineas.push(``, `Si prefieres llamarnos, con gusto te buscamos otro hueco 😊`);
  }

  return lineas.join('\n');
}

// ── A/B TRACKING ──────────────────────────────────────────────────────────────
// GA4 trackea los clics vía UTM automáticamente.
// Aquí registramos los envíos en data.json para el dashboard interno.
function registrarAbEnvio(variante) {
  if (!config.abTracking) return;
  const d = cargarDatos();
  const k = `v${variante}`;
  if (!d.abStats[k]) d.abStats[k] = { enviados:0, clics:0 };
  d.abStats[k].enviados++;
  guardarDatos(d);
}

// Selecciona la variante menos usada (distribución balanceada del A/B)
function seleccionarVariante() {
  const d = cargarDatos();
  const counts = [0,1,2,3].map(v => d.abStats[`v${v}`]?.enviados || 0);
  return counts.indexOf(Math.min(...counts)); // la menos enviada
}

// ── ENVÍO ─────────────────────────────────────────────────────────────────────
async function enviarMensaje(telefono, texto) {
  if (!sockGlobal||estadoWA!=='conectado') throw new Error('WhatsApp no conectado');
  const j = jid(telefono.startsWith('34')?telefono:'34'+telefono);
  const [info] = await sockGlobal.onWhatsApp(j).catch(()=>[null]);
  if (!info?.exists) throw new Error('Sin WhatsApp: '+telefono);
  await sockGlobal.sendPresenceUpdate('composing',j);
  await sleep(1200+Math.random()*2000);
  await sockGlobal.sendPresenceUpdate('paused',j);
  await sockGlobal.sendMessage(j,{text:texto});
  return true;
}

// ── PROCESAR RESPUESTAS SÍ/NO ─────────────────────────────────────────────────
async function procesarRespuesta(remitente, texto) {
  const tel = remitente.replace('@s.whatsapp.net', '').replace(/^34/, '');

  // LOG — ver en consola cada mensaje entrante y si el tel está esperando respuesta
  console.log(`📩 Entrante de ${tel}: "${texto.trim()}" | en mapa: ${esperandoRespuesta.has(tel)}`);

  if (!esperandoRespuesta.has(tel)) {
    // Solo registrar si el número está en nuestro historial de enviados
    // (evita registrar mensajes de conversaciones personales ajenas a la clínica)
    const datos = cargarDatos();
    if (datos.enviados[tel]) {
      registrarMensaje({ tel, nombre: datos.enviados[tel].nombre || null, mod: 'sin_contexto', textoOriginal: texto.trim(), resultado: 'sin_contexto' });
    }
    return;
  }

  // Normalizar: minúsculas + sin tildes + sin puntuación
  const t = texto.trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[¿?¡!.,;:]/g, '')
    .trim();

  const { nombre, variante, mod, fecha, hora, trat } = esperandoRespuesta.get(tel);
  const nombre1 = nombre.split(' ')[0];

  console.log(`🔍 mod=${mod} texto_norm="${t}"`);

  // Palabras SÍ — variaciones reales de pacientes españoles
  const palabrasSi = [
    'si','sí','yes','s','1','ok','vale','venga','dale','bueno','claro',
    'por supuesto','adelante','confirmo','confirmar','confirmado',
    'de acuerdo','perfecto','genial','estupendo','fenomenal',
    'alli estare','alli estaré','allí estare','allí estaré',
    'ahi estare','ahí estaré','voy','ire','iré','alla voy','allá voy',
  ];
  // Palabras NO
  const palabrasNo = [
    'no','nope','n','0','cancelar','cancelo','cancele',
    'no puedo','no voy','no ire','no iré',
    'no asistire','no asistiré','imposible',
    'no me va','no me viene bien','no llegare','no llegaré',
  ];

  const match = (lista) => lista.some(w => t === w || t.startsWith(w + ' ') || t.startsWith(w + ','));

  // Detección contextual para frases largas: "sí muchas gracias", "no puedo ir"
  // Solo activa si el mensaje tiene más de 2 palabras (evita colisión con match exacto)
  function contieneIntencion(textoNorm) {
    const palabras = textoNorm.trim().split(/\s+/).length;
    if (palabras <= 2) return { si: false, no: false };

    const clavesSi = ['si','sí','yes','claro','dale','vale','confirmo','perfecto','genial','voy','ire','iré','alli','allí','ahi','ahí'];
    const clavesNo = ['no','nope','cancelar','imposible'];

    const tieneSi = clavesSi.some(w => {
      const re = new RegExp('(?:^|\\s|,|\\.)' + w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '(?:\\s|,|\\.|$|!|\\?)', 'i');
      return re.test(textoNorm);
    });
    const tieneNo = clavesNo.some(w => {
      const re = new RegExp('(?:^|\\s|,|\\.)' + w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '(?:\\s|,|\\.|$|!|\\?)', 'i');
      return re.test(textoNorm);
    });
    // Ambiguo (tiene ambas) → no decidir
    return { si: tieneSi && !tieneNo, no: tieneNo && !tieneSi };
  }

  const intencion = contieneIntencion(t);
  const esSi = match(palabrasSi) || intencion.si;
  const esNo = match(palabrasNo) || intencion.no;

  console.log(`🔍 esSi=${esSi} esNo=${esNo}`);

  if (mod === 'cita') {
    if (esSi) {
      await enviarMensaje(tel, msgCitaConfirmado(nombre, fecha, hora)).catch(console.error);
      esperandoRespuesta.delete(tel); guardarEsperando();
      const datos = cargarDatos();
      if (datos.enviados[tel]) { datos.enviados[tel].confirmado = true; guardarDatos(datos); }
      registrarMensaje({ tel, nombre, mod: 'cita', textoOriginal: texto.trim(), resultado: 'si' });
      console.log(`✅ CITA CONFIRMADA — ${nombre} (${tel})`);
    } else if (esNo) {
      await enviarMensaje(tel, msgCitaRechazado(nombre)).catch(console.error);
      esperandoRespuesta.delete(tel); guardarEsperando();
      const datos = cargarDatos();
      if (datos.enviados[tel]) { datos.enviados[tel].cancelado = true; guardarDatos(datos); }
      registrarMensaje({ tel, nombre, mod: 'cita', textoOriginal: texto.trim(), resultado: 'no' });
      console.log(`❌ CITA CANCELADA — ${nombre} (${tel})`);
      await avisarOperador(nombre, tel, fecha, hora, trat);
    } else {
      // Respuesta no reconocida — pedir aclaración una vez
      registrarMensaje({ tel, nombre, mod: 'cita', textoOriginal: texto.trim(), resultado: 'no_reconocido' });
      console.log(`❓ No reconocida de ${nombre} (${tel}): "${t}"`);
      await enviarMensaje(tel, `Perdona ${nombre1}, no te he entendido bien 😅\n\nResponde simplemente *SÍ* para confirmar tu cita o *NO* si necesitas cambiarla.`).catch(console.error);
    }
  } else {
    // Valoración
    if (esSi) {
      await enviarMensaje(tel, construirMsgEnlace(nombre, variante)).catch(console.error);
      esperandoRespuesta.delete(tel); guardarEsperando();
      registrarMensaje({ tel, nombre, mod: 'val', textoOriginal: texto.trim(), resultado: 'si' });
      console.log(`✅ SÍ de ${nombre} (${tel}) — enlace V${variante} enviado`);
    } else if (esNo) {
      await enviarMensaje(tel, construirMsgRespuestaNo(nombre)).catch(console.error);
      esperandoRespuesta.delete(tel); guardarEsperando();
      registrarMensaje({ tel, nombre, mod: 'val', textoOriginal: texto.trim(), resultado: 'no' });
      console.log(`🚫 NO de ${nombre} (${tel})`);
    } else {
      // Respuesta no reconocida — pedir aclaración una vez
      registrarMensaje({ tel, nombre, mod: 'val', textoOriginal: texto.trim(), resultado: 'no_reconocido' });
      console.log(`❓ No reconocida de ${nombre} (${tel}): "${t}"`);
      await enviarMensaje(tel, `Perdona ${nombre1} 😅\n\nResponde *SÍ* si quieres dejarnos tu opinión o *NO* si prefieres no hacerlo. ¡Sin problema en cualquier caso! 🙏`).catch(console.error);
    }
  }
}

// ── PROCESAR COLA ─────────────────────────────────────────────────────────────
let colaActiva = false;

async function procesarCola(modFiltro = null, forzarTodos = false) {
  if (colaActiva) return;
  if (config.bloquearFinde && esFinde()) {
    console.log(`🚫 Fin de semana — envíos bloqueados`); return;
  }

  colaActiva = true;
  try {
  resetarContadoresSiNuevoDia();

  const cola  = cargarCola();
  const datos = cargarDatos();
  const lb    = new Set((datos.listaNegra||[]).map(e=>e.tel||e));

  let pendientes = cola.filter(p => {
    if (p.enviado) return false;
    if (lb.has(p.tel)) return false;
    if (datos.enviados[p.tel]?.[p.mod]) return false;
    // Para citas: solo enviar si la cita es hoy o mañana
    if (p.mod === 'cita' && p.fecha) {
      const hoyD   = new Date(); hoyD.setHours(0,0,0,0);
      const manana = new Date(hoyD); manana.setDate(manana.getDate()+1);
      const fCita  = new Date(p.fecha); fCita.setHours(0,0,0,0);
      if (fCita > manana) return false; // cita aún lejana — esperar
      if (fCita < hoyD)  return false; // cita ya pasada — descartar
    }
    return true;
  });
  if (modFiltro) pendientes = pendientes.filter(p=>p.mod===modFiltro);
  if (!pendientes.length) { console.log(`✅ Cola vacía o sin citas para hoy/mañana`); return; }

  let cV=0, cC=0;
  const aEnviar = pendientes.filter(p=>{
    // Citas: si forzarTodos=true se envían TODAS las pendientes sin límite diario
    if (p.mod==='cita') {
      if (forzarTodos) { cC++; return true; }
      if (cC < (config.cita_maxPorDia - enviosHoyCita)) { cC++; return true; }
      return false;
    }
    // Valoraciones: siempre respetan el límite diario configurado
    if (p.mod==='val' && cV < (config.val_maxPorDia - enviosHoyVal)) { cV++; return true; }
    return false;
  });
  if (!aEnviar.length) {
    console.log(`⛔ Sin pendientes o límite diario alcanzado (val:${enviosHoyVal}/${config.val_maxPorDia} cita:${enviosHoyCita}/${config.cita_maxPorDia})`);
    return;
  }

  console.log(`📤 Enviando ${aEnviar.length} mensajes...`);

  for (let i=0; i<aEnviar.length; i++) {
    const p = aEnviar[i];
    let msgTexto, varianteIdx = 0;

    if (p.mod==='val') {
      varianteIdx = seleccionarVariante();
      msgTexto    = construirMsgVal(p, varianteIdx);
    } else {
      msgTexto = construirMsgCita(p);
    }

    try {
      await enviarMensaje(p.tel, msgTexto);

      // Guardar en historial
      if (!datos.enviados[p.tel]) datos.enviados[p.tel]={};
      datos.enviados[p.tel][p.mod] = hoy();
      datos.enviados[p.tel].nombre = p.nombre;
      datos.enviados[p.tel].trat   = p.trat||'';
      if (p.mod==='val') datos.enviados[p.tel].variante = varianteIdx;
      guardarDatos(datos);

      // A/B tracking envío
      if (p.mod==='val') registrarAbEnvio(varianteIdx);

      // SÍ/NO: guardar para respuesta automática
      const flujoActivoCita = config.flujoSiNo_cita ?? config.flujoSiNo;
      const flujoActivoVal  = config.flujoSiNo_val  ?? config.flujoSiNo;
      if (p.mod === 'val'  && flujoActivoVal) {
        esperandoRespuesta.set(p.tel, { mod:'val', nombre:p.nombre, variante:varianteIdx, ts:Date.now() });
        guardarEsperando();
      } else if (p.mod === 'cita' && flujoActivoCita) {
        esperandoRespuesta.set(p.tel, { mod:'cita', nombre:p.nombre, fecha:p.fecha||null, hora:p.hora||'', trat:p.trat||'', ts:Date.now() });
        guardarEsperando();
      }

      p.enviado=true; p.fechaEnvio=new Date().toISOString(); p.variante=varianteIdx;
      guardarCola(cola);

      if (p.mod==='val')  enviosHoyVal++;
      if (p.mod==='cita') enviosHoyCita++;
      console.log(`✅ [${i+1}/${aEnviar.length}] ${p.mod.toUpperCase()} V${varianteIdx} → ${p.nombre}`);

      if (i<aEnviar.length-1) {
        const d=(config.delayMinSeg+Math.random()*(config.delayMaxSeg-config.delayMinSeg))*1000;
        await sleep(d);
      }
    } catch(err) {
      console.error(`❌ ${p.nombre}:`,err.message);
      p.error=err.message; guardarCola(cola);
    }
  }

  // Limpiar esperandoRespuesta > 48h y persistir
  const lim = Date.now() - 48 * 3600000;
  let limpiados = 0;
  for (const [tel, d] of esperandoRespuesta.entries()) {
    if (d.ts < lim) { esperandoRespuesta.delete(tel); limpiados++; }
  }
  if (limpiados) guardarEsperando();

  console.log(`🏁 val:${enviosHoyVal}/${config.val_maxPorDia} | cita:${enviosHoyCita}/${config.cita_maxPorDia}`);
  } catch(err) {
    console.error('💥 Error inesperado en procesarCola:', err.message);
  } finally {
    colaActiva = false;
  }
}

// ── SINCRONIZAR LEADS → COLA ──────────────────────────────────────────────────
// Antes de procesar la cola, vuelca los leads persistidos que toca enviar hoy
function sincronizarLeadsACola() {
  const leads = cargarLeads();
  const cola  = cargarCola();
  const datos = cargarDatos();
  const lb    = new Set((datos.listaNegra||[]).map(e=>e.tel||e));
  let añadidos = 0;

  ['cita','val'].forEach(mod => {
    (leads[mod]||[]).forEach(p => {
      const tel = telLimpio(p.tel); if (!tel) return;
      if (lb.has(tel)) return;
      if (datos.enviados[tel]?.[mod]) return;
      if (cola.some(c=>c.tel===tel&&c.mod===mod&&!c.enviado)) return;
      // Valoraciones: no enviar si la visita fue un martes
      if (mod === 'val' && eraMartes(p.fecha)) {
        console.log(`📅 Omitido (visita en martes): ${p.nombre} (${tel})`);
        return;
      }
      // Para citas: solo encolar si la cita es hoy o mañana
      if (mod === 'cita' && p.fecha) {
        const hoyD   = new Date(); hoyD.setHours(0,0,0,0);
        const manana = new Date(hoyD); manana.setDate(manana.getDate()+1);
        const fCita  = new Date(p.fecha); fCita.setHours(0,0,0,0);
        if (fCita > manana) return;
        if (fCita < hoyD)  return;
      }
      cola.push({ nombre:p.nombre, tel, fecha:p.fecha||null, hora:p.hora||'', trat:p.trat||'', mod, enviado:false, añadido:new Date().toISOString() });
      añadidos++;
    });
  });

  if (añadidos) {
    guardarCola(cola);
    console.log(`📋 ${añadidos} leads añadidos a la cola automáticamente`);
  }
}

// ── CRON ──────────────────────────────────────────────────────────────────────
// Registra qué módulos ya se dispararon hoy para no enviar dos veces
const yaEnviadoHoy = { val: null, cita: null }; // valor = fecha 'YYYY-MM-DD' del último disparo

// Convierte "HH:MM" en minutos totales desde medianoche
function horaAMinutos(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return h * 60 + m;
}

// Devuelve hora actual en Madrid como minutos totales
function ahoraEnMinutos() {
  const s = new Date().toLocaleTimeString('es-ES', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Madrid'
  });
  return horaAMinutos(s);
}

// Ventana de tolerancia: dispara si estamos dentro de los 30 min posteriores a la hora programada
// Cubre arranques tardíos, reinicios, desfases del SO y colas grandes con delay entre mensajes
const VENTANA_MIN = 30;

function programarCrons() {
  if (cronJobVal)  { cronJobVal.destroy();  cronJobVal  = null; }
  if (cronJobCita) { cronJobCita.destroy(); cronJobCita = null; }
  const opts = { timezone: 'Europe/Madrid' };

  // Cron unificado — revisa cada minuto L-V entre 7:00 y 14:00
  // Es más fiable que crons de hora exacta: si el servidor arranca tarde, recupera
  cronJobVal = cron.schedule('* 7-14 * * 1-5', async () => {
    const fechaHoy   = hoy();
    const ahoraMin   = ahoraEnMinutos();

    // ── VALORACIONES ──────────────────────────────────────────────────────
    if (config.val_activo && yaEnviadoHoy.val !== fechaHoy) {
      const horaObjetivo = horaAMinutos(horaSegunDia());
      const diff         = ahoraMin - horaObjetivo;
      if (diff >= 0 && diff < VENTANA_MIN) {
        console.log(`\n🕐 CRON VALORACIÓN — hora programada: ${horaSegunDia()}, ahora +${diff}min`);
        yaEnviadoHoy.val = fechaHoy;
        sincronizarLeadsACola();
        if (estadoWA === 'conectado') await procesarCola('val', false).catch(console.error);
        else console.log('⚠️  WhatsApp no conectado — cola de valoraciones pendiente, usa "Enviar ahora"');
      }
    }

    // ── RECORDATORIOS CITA ────────────────────────────────────────────────
    if (config.cita_activo && yaEnviadoHoy.cita !== fechaHoy) {
      const horaObjetivo = horaAMinutos(config.cita_horaEnvio);
      const diff         = ahoraMin - horaObjetivo;
      if (diff >= 0 && diff < VENTANA_MIN) {
        console.log(`\n🕐 CRON CITA — hora programada: ${config.cita_horaEnvio}, ahora +${diff}min`);
        yaEnviadoHoy.cita = fechaHoy;
        sincronizarLeadsACola();
        // forzarTodos=true: envía TODAS las citas pendientes del día sin límite
        if (estadoWA === 'conectado') await procesarCola('cita', true).catch(console.error);
        else console.log('⚠️  WhatsApp no conectado — cola de citas pendiente, usa "Enviar ahora"');
      }
    }
  }, opts);

  console.log(`⏰ Cron activo (cada minuto, L-V 7-14h)`);
  console.log(`⏰ Valoraciones: ${horaSegunDia()} (+${VENTANA_MIN}min ventana)`);
  console.log(`⏰ Recordatorios: ${config.cita_horaEnvio} (+${VENTANA_MIN}min ventana)`);
}

// Al arrancar el servidor: si ya pasó la hora de envío de hoy y hay cola pendiente → enviar
// Cubre el caso más común: "reinicié el servidor después de la hora programada"
async function verificarEnviosPendientesAlArrancar() {
  await sleep(8000); // esperar a que Baileys conecte
  if (esFinde() && config.bloquearFinde) return;

  const fechaHoy = hoy();
  const ahoraMin = ahoraEnMinutos();
  const cola     = cargarCola();
  const datos    = cargarDatos();
  const lb       = new Set((datos.listaNegra || []).map(e => e.tel || e));

  const hayValPendiente  = cola.some(p => p.mod === 'val'  && !p.enviado && !lb.has(p.tel) && !datos.enviados[p.tel]?.val);
  const hayCitaPendiente = cola.some(p => p.mod === 'cita' && !p.enviado && !lb.has(p.tel) && !datos.enviados[p.tel]?.cita);

  if (config.val_activo && hayValPendiente && yaEnviadoHoy.val !== fechaHoy) {
    const horaObjetivo = horaAMinutos(horaSegunDia());
    if (ahoraMin >= horaObjetivo) {
      console.log(`\n🔄 Arranque tardío — lanzando valoraciones pendientes (hora programada: ${horaSegunDia()})`);
      yaEnviadoHoy.val = fechaHoy;
      sincronizarLeadsACola();
      if (estadoWA === 'conectado') procesarCola('val', false).catch(console.error);
    }
  }

  if (config.cita_activo && hayCitaPendiente && yaEnviadoHoy.cita !== fechaHoy) {
    const horaObjetivo = horaAMinutos(config.cita_horaEnvio);
    if (ahoraMin >= horaObjetivo) {
      console.log(`\n🔄 Arranque tardío — lanzando recordatorios pendientes (hora programada: ${config.cita_horaEnvio})`);
      yaEnviadoHoy.cita = fechaHoy;
      sincronizarLeadsACola();
      // forzarTodos=true: envía TODAS las citas pendientes sin límite
      if (estadoWA === 'conectado') procesarCola('cita', true).catch(console.error);
    }
  }
}

// ── BAILEYS ───────────────────────────────────────────────────────────────────
async function conectar() {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_avancedental'));
  const sock = makeWASocket({
    auth:state,
    logger:P({level:'silent'}),
    browser: Browsers.macOS('Desktop'),
    version,
    generateHighQualityLinkPreview:false,
    defaultQueryTimeoutMs:60000,
  });

  sock.ev.on('connection.update', async ({connection,lastDisconnect,qr})=>{
    if (qr) {
      qrActual = qr;
      estadoWA = 'qr';
      console.log('📱 QR generado — escanea desde la web en localhost:3001');
    }
    if (connection==='open') { estadoWA='conectado'; qrActual=null; sockGlobal=sock; console.log('✅ WhatsApp conectado'); }
    if (connection==='close') {
      estadoWA='desconectado'; sockGlobal=null;
      const r=(lastDisconnect?.error instanceof Boom)?lastDisconnect.error.output?.statusCode!==DisconnectReason.loggedOut:true;
      if(r){console.log('🔄 Reconectando...');setTimeout(conectar,5000);}
      else console.log('🚪 Sesión cerrada. Borra auth_avancedental y reinicia.');
    }
  });

  // Escuchar respuestas SÍ/NO
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    const msg = messages[0];
    if (!msg || msg.key.fromMe || !msg.message) return;
    const rem = msg.key.remoteJid;
    if (!rem || !rem.endsWith('@s.whatsapp.net')) return;

    // Extraer texto de todos los tipos posibles de mensaje
    const m = msg.message;
    const txt =
      m.conversation ||                                          // texto simple
      m.extendedTextMessage?.text ||                            // texto con preview/link
      m.buttonsResponseMessage?.selectedDisplayText ||          // respuesta a botones
      m.listResponseMessage?.singleSelectReply?.selectedRowId || // respuesta a lista
      m.templateButtonReplyMessage?.selectedDisplayText ||      // template button
      m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson || // interactive
      '';

    const txtLimpio = String(txt).trim();
    if (txtLimpio) {
      console.log(`📨 [Baileys] rem=${rem} tipo=${Object.keys(m)[0]} txt="${txtLimpio}"`);
      procesarRespuesta(rem, txtLimpio);
    }
  });

  sock.ev.on('creds.update',saveCreds);
}

// ── API REST ──────────────────────────────────────────────────────────────────
const app = express();
app.use(cors()); app.use(express.json({limit:'2mb'})); app.use(express.static(__dirname));

app.get('/api/status', (req,res)=>{
  const dia=new Date().toLocaleString('es-ES',{weekday:'long',timeZone:'Europe/Madrid'}).toLowerCase();
  res.json({
    estado:estadoWA, qr:estadoWA==='qr'?qrActual:null,
    enviosHoyVal, enviosHoyCita, config,
    esFinDeSemana:dia==='sábado'||dia==='domingo', diaActual:dia,
    esperandoRespuesta:esperandoRespuesta.size,
  });
});

app.get('/api/config',(req,res)=>res.json(config));
app.post('/api/config',(req,res)=>{
  ['val_activo','val_maxPorDia','horariosVal','cita_activo','cita_maxPorDia','cita_horaEnvio',
   'delayMinSeg','delayMaxSeg','bloquearFinde','numResenias','flujoSiNo','flujoSiNo_cita','flujoSiNo_val','abTracking',
   'avisoMetodo','avisoEmail','avisoEmailUser','avisoEmailPass','avisoWhatsapp',
   'msgConfirmado','msgRechazado','ga4PropertyId','ga4CredentialsPath'
  ].forEach(k=>{if(req.body[k]!==undefined)config[k]=req.body[k];});
  ['val_maxPorDia','cita_maxPorDia','delayMinSeg','delayMaxSeg','numResenias'].forEach(k=>config[k]=parseInt(config[k]));
  ['val_activo','cita_activo','bloquearFinde','flujoSiNo','flujoSiNo_cita','flujoSiNo_val','abTracking'].forEach(k=>config[k]=Boolean(config[k]));
  programarCrons();
  // Persistir en disco para sobrevivir reinicios
  guardarConfigDisco(config);
  res.json({ok:true,config});
});

// A/B stats — muestra envíos internos. Clics reales → GA4
app.get('/api/ab-stats',(req,res)=>{
  const d=cargarDatos();
  const labels = ['Importancia+comunidad','Gratitud+mejora','Cercanía+impacto','Confianza+pertenencia'];
  const stats=Object.entries(d.abStats||{}).map(([k,v])=>({
    variante:k, gancho: labels[parseInt(k.replace('v',''))] || k,
    enviados:v.enviados||0, clics:v.clics||0,
    ctr:v.enviados?((v.clics/v.enviados)*100).toFixed(1)+'%':'—',
  }));
  res.json({stats, esperandoRespuesta:esperandoRespuesta.size, urlsUtm:[0,1,2,3].map(v=>urlConUtm(v))});
});

app.get('/api/cola',(req,res)=>{
  const cola=cargarCola(); const d=cargarDatos();
  const lb=new Set((d.listaNegra||[]).map(e=>e.tel||e));
  const pend=cola.filter(p=>!p.enviado&&!lb.has(p.tel)&&!d.enviados[p.tel]?.[p.mod]);
  res.json({total:cola.length,pendientes:pend.length,pendientesVal:pend.filter(p=>p.mod==='val').length,pendientesCita:pend.filter(p=>p.mod==='cita').length});
});

app.post('/api/cola/anadir',(req,res)=>{
  const pacientes=req.body.pacientes;
  if(!Array.isArray(pacientes)||!pacientes.length) return res.status(400).json({error:'Array requerido'});
  const cola=cargarCola(); const d=cargarDatos(); let nuevos=0; let omitidosMartes=0;
  pacientes.forEach(p=>{
    const tel=telLimpio(p.tel); if(!tel||!/^\d{9}$/.test(tel))return;
    const mod=p.mod||'val';
    // Valoraciones: no encolar si la visita fue un martes
    if(mod==='val' && eraMartes(p.fecha)){ omitidosMartes++; return; }
    if(cola.some(c=>c.tel===tel&&c.mod===mod&&!c.enviado))return;
    if(d.enviados[tel]?.[mod])return;
    cola.push({nombre:p.nombre,tel,fecha:p.fecha||null,hora:p.hora||'',trat:p.trat||'',mod,enviado:false,añadido:new Date().toISOString()});
    nuevos++;
  });
  guardarCola(cola);
  res.json({ok:true,añadidos:nuevos,omitidosMartes});
});

app.delete('/api/cola/limpiar',(req,res)=>{
  const mod=req.query.mod;
  guardarCola(mod?cargarCola().filter(p=>p.enviado||p.mod!==mod):[]);
  res.json({ok:true});
});

// ── LEADS PERSISTENTES ────────────────────────────────────────────────────────
app.get('/api/leads', (req, res) => {
  res.json(cargarLeads());
});

app.post('/api/leads/guardar', (req, res) => {
  const { pacientes, mod } = req.body;
  if (!Array.isArray(pacientes) || !['cita','val'].includes(mod)) {
    return res.status(400).json({ error: 'Datos inválidos' });
  }
  const leads = cargarLeads();
  const datos = cargarDatos();
  let nuevos = 0;
  pacientes.forEach(p => {
    const tel = telLimpio(p.tel); if (!tel || !/^\d{9}$/.test(tel)) return;
    if (leads[mod].some(e => e.tel === tel)) return; // ya existe
    leads[mod].push({ nombre: p.nombre, tel, fecha: p.fecha||null, hora: p.hora||'', trat: p.trat||'', estado: p.estado||'', añadido: new Date().toISOString() });
    nuevos++;
  });
  guardarLeads(leads);
  res.json({ ok: true, añadidos: nuevos, total: leads[mod].length });
});

app.delete('/api/leads/:mod/:tel', (req, res) => {
  const { mod, tel } = req.params;
  if (!['cita','val'].includes(mod)) return res.status(400).json({ error: 'Módulo inválido' });
  const leads = cargarLeads();
  const antes = leads[mod].length;
  leads[mod] = leads[mod].filter(p => p.tel !== tel);
  guardarLeads(leads);
  res.json({ ok: true, eliminados: antes - leads[mod].length });
});

app.delete('/api/leads/:mod', (req, res) => {
  const { mod } = req.params;
  if (!['cita','val'].includes(mod)) return res.status(400).json({ error: 'Módulo inválido' });
  const leads = cargarLeads();
  leads[mod] = [];
  guardarLeads(leads);
  res.json({ ok: true });
});

app.post('/api/cola/enviar-ahora',async(req,res)=>{
  if(estadoWA!=='conectado')return res.status(503).json({error:'WhatsApp no conectado'});
  if(config.bloquearFinde&&esFinde())return res.status(403).json({error:'Fin de semana bloqueado'});
  const mod=req.body?.mod||null;
  sincronizarLeadsACola();
  res.json({ok:true,mensaje:`Procesando cola${mod?' ('+mod+')':''}...`});
  // forzarTodos=true para citas: enviar todas sin límite diario
  procesarCola(mod, mod==='cita').catch(console.error);
});

app.post('/api/enviar',async(req,res)=>{
  const{telefono,mensaje}=req.body;
  if(!telefono||!mensaje)return res.status(400).json({error:'Faltan datos'});
  try{await enviarMensaje(telLimpio(telefono),mensaje);res.json({ok:true});}
  catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/historial',(req,res)=>{
  const d=cargarDatos();
  const l=Object.entries(d.enviados||{}).map(([tel,v])=>({tel,...v}));
  l.sort((a,b)=>(b.val||b.cita||'').localeCompare(a.val||a.cita||''));
  res.json(l);
});

app.delete('/api/historial/:tel',(req,res)=>{
  const{tel}=req.params;const{mod}=req.query;
  const d=cargarDatos();if(!d.enviados[tel])return res.status(404).json({error:'No encontrado'});
  if(mod){delete d.enviados[tel][mod];if(!Object.keys(d.enviados[tel]).filter(k=>!['nombre','trat','variante'].includes(k)).length)delete d.enviados[tel];}
  else delete d.enviados[tel];
  guardarDatos(d);res.json({ok:true});
});

app.post('/api/historial/:tel/resetear',(req,res)=>{
  const{tel}=req.params;const{mod}=req.body;
  const d=cargarDatos();
  if(d.enviados[tel]){if(mod)delete d.enviados[tel][mod];else delete d.enviados[tel];}
  guardarDatos(d);res.json({ok:true});
});

app.get('/api/listanegra',(req,res)=>res.json(cargarDatos().listaNegra||[]));
app.post('/api/listanegra',(req,res)=>{
  const{tel,nombre}=req.body;const t=telLimpio(tel);
  if(!t||!/^\d{9}$/.test(t))return res.status(400).json({error:'Inválido'});
  const d=cargarDatos();if(!d.listaNegra)d.listaNegra=[];
  if(!d.listaNegra.some(e=>(e.tel||e)===t))d.listaNegra.push({tel:t,nombre:nombre||'',bloqueado:hoy()});
  guardarDatos(d);res.json({ok:true});
});
app.delete('/api/listanegra/:tel',(req,res)=>{
  const d=cargarDatos();
  d.listaNegra=(d.listaNegra||[]).filter(e=>(e.tel||e)!==req.params.tel);
  guardarDatos(d);res.json({ok:true});
});

app.get('/api/qr',(req,res)=>res.json({qr:estadoWA==='qr'?qrActual:null,estado:estadoWA}));


// ── CONVERSACIONES ────────────────────────────────────────────────────────────

app.get('/api/conversaciones', (req, res) => {
  const lista = cargarConversaciones();
  // Devolver ordenadas de más reciente a más antigua
  res.json(lista.slice().reverse());
});

app.delete('/api/conversaciones', (req, res) => {
  guardarConversaciones([]);
  res.json({ ok: true });
});

app.delete('/api/conversaciones/:idx', (req, res) => {
  const lista = cargarConversaciones();
  const idx = parseInt(req.params.idx);
  if (isNaN(idx) || idx < 0 || idx >= lista.length) return res.status(404).json({ error: 'No encontrado' });
  lista.splice(idx, 1);
  guardarConversaciones(lista);
  res.json({ ok: true });
});

// ── BACKUP ────────────────────────────────────────────────────────────────────

function nombreBackup(tipo = 'manual') {
  const ts = new Date().toISOString().replace(/:/g,'-').replace('T','_').split('.')[0];
  return `backup_${tipo}_${ts}`;
}

function datosParaBackup() {
  const datos  = fs.existsSync(DATA_FILE)   ? fs.readFileSync(DATA_FILE,  'utf8') : '{}';
  const cola   = fs.existsSync(COLA_FILE)   ? fs.readFileSync(COLA_FILE,  'utf8') : '[]';
  const cfg    = fs.existsSync(CONFIG_FILE) ? fs.readFileSync(CONFIG_FILE,'utf8') : '{}';
  const leads  = fs.existsSync(LEADS_FILE)  ? fs.readFileSync(LEADS_FILE, 'utf8') : '{"cita":[],"val":[]}';
  return { datos, cola, config: cfg, leads };
}

async function crearZipBackup(nombre) {
  if (!archiver) throw new Error('Instala: npm install archiver');
  const zipPath = path.join(BACKUP_DIR, nombre + '.zip');
  return new Promise((resolve, reject) => {
    const output  = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', () => resolve(zipPath));
    archive.on('error', reject);
    archive.pipe(output);
    if (fs.existsSync(DATA_FILE))   archive.file(DATA_FILE,   { name: 'data.json'   });
    if (fs.existsSync(COLA_FILE))   archive.file(COLA_FILE,   { name: 'cola.json'   });
    if (fs.existsSync(CONFIG_FILE)) archive.file(CONFIG_FILE, { name: 'config.json' });
    if (fs.existsSync(LEADS_FILE))  archive.file(LEADS_FILE,  { name: 'leads.json'  });
    const authDir = path.join(__dirname, 'auth_avancedental');
    if (fs.existsSync(authDir)) archive.directory(authDir, 'auth_avancedental');
    archive.finalize();
  });
}

function listarBackups() {
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.zip') || f.endsWith('.json'))
    .map(f => {
      const fp   = path.join(BACKUP_DIR, f);
      const stat = fs.statSync(fp);
      return { nombre: f, tamaño: stat.size, fecha: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.fecha.localeCompare(a.fecha));
}

function restaurarDesdeJSON(jsonStr) {
  const obj = JSON.parse(jsonStr);
  if (obj.datos || obj.cola || obj.config) {
    if (obj.datos)  fs.writeFileSync(DATA_FILE,   JSON.stringify(JSON.parse(obj.datos),  null, 2));
    if (obj.cola)   fs.writeFileSync(COLA_FILE,   JSON.stringify(JSON.parse(obj.cola),   null, 2));
    if (obj.config) fs.writeFileSync(CONFIG_FILE, JSON.stringify(JSON.parse(obj.config), null, 2));
    if (obj.leads)  fs.writeFileSync(LEADS_FILE,  JSON.stringify(JSON.parse(obj.leads),  null, 2));
  } else if (obj.enviados || obj.listaNegra) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2));
  } else {
    throw new Error('Formato no reconocido');
  }
  // Recargar config en memoria
  const cfg = cargarConfigDisco();
  Object.assign(config, CONFIG_DEFAULT, cfg);
  const d = cargarDatos();
  return { enviados: Object.keys(d.enviados||{}).length, listaNegra: (d.listaNegra||[]).length };
}

function backupAutomatico() {
  try {
    const nombre   = nombreBackup('auto');
    const filePath = path.join(BACKUP_DIR, nombre + '.json');
    fs.writeFileSync(filePath, JSON.stringify(datosParaBackup(), null, 2));
    // Limpiar backups automáticos > 30 días
    const limite = Date.now() - 30 * 24 * 3600 * 1000;
    fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('backup_auto_') && f.endsWith('.json'))
      .map(f => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
      .filter(({ t }) => t < limite)
      .forEach(({ f }) => fs.unlinkSync(path.join(BACKUP_DIR, f)));
    console.log(`💾 Backup automático: ${nombre}.json`);
  } catch(e) { console.error('❌ Backup automático:', e.message); }
}

// Endpoints backup
app.get('/api/backup/list', (req, res) => res.json({ backups: listarBackups() }));

app.post('/api/backup/crear', async (req, res) => {
  try {
    const nombre = nombreBackup('manual');
    if (archiver) {
      const zipPath = await crearZipBackup(nombre);
      res.json({ ok:true, nombre:nombre+'.zip', tipo:'zip', tamaño:fs.statSync(zipPath).size });
    } else {
      const filePath = path.join(BACKUP_DIR, nombre + '.json');
      fs.writeFileSync(filePath, JSON.stringify(datosParaBackup(), null, 2));
      res.json({ ok:true, nombre:nombre+'.json', tipo:'json', tamaño:fs.statSync(filePath).size });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/backup/descargar/:nombre', (req, res) => {
  const nombre   = req.params.nombre.replace(/\.\./g, '');
  const filePath = path.join(BACKUP_DIR, nombre);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'No encontrado' });
  res.download(filePath, nombre);
});

app.post('/api/backup/restaurar', (req, res) => {
  try {
    // Backup de seguridad antes de restaurar
    const safe = nombreBackup('pre-restore');
    fs.writeFileSync(path.join(BACKUP_DIR, safe+'.json'), JSON.stringify(datosParaBackup(), null, 2));
    const jsonStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const result  = restaurarDesdeJSON(jsonStr);
    res.json({ ok:true, ...result, safeBackup: safe+'.json' });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/backup/export-json', (req, res) => {
  const ts = new Date().toISOString().split('T')[0];
  res.setHeader('Content-Disposition', `attachment; filename="avancedental_backup_${ts}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(datosParaBackup(), null, 2));
});

// Cron backup cada hora
cron.schedule('0 * * * *', backupAutomatico, { timezone: 'Europe/Madrid' });
setTimeout(backupAutomatico, 5000); // Uno al arrancar

// ── GOOGLE ANALYTICS 4 ────────────────────────────────────────────────────────

app.get('/api/analytics', async (req, res) => {
  if (!config.ga4PropertyId || !config.ga4CredentialsPath) return res.json({ noConfigurado: true });
  if (!BetaAnalyticsDataClient) return res.json({ noConfigurado: true, error: 'Instala: npm install @google-analytics/data' });
  try {
    const credPath = path.isAbsolute(config.ga4CredentialsPath)
      ? config.ga4CredentialsPath
      : path.join(__dirname, config.ga4CredentialsPath);
    const client = new BetaAnalyticsDataClient({ keyFilename: credPath });
    const propertyId = String(config.ga4PropertyId).replace('properties/','');

    const [respTotal] = await client.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate:'30daysAgo', endDate:'today' }],
      dimensions: [{ name:'date' }],
      metrics:    [{ name:'eventCount' }],
      dimensionFilter: { filter: { fieldName:'eventName', stringFilter:{ value:'google_click', matchType:'PARTIAL_REGEXP' } } }
    });
    const [respVar] = await client.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate:'90daysAgo', endDate:'today' }],
      dimensions: [{ name:'customEvent:utm_content' }],
      metrics:    [{ name:'sessions' }],
    });

    const porDia = (respTotal.rows||[]).map(r=>({
      fecha: r.dimensionValues[0].value.replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3'),
      clics: parseInt(r.metricValues[0].value||0)
    })).sort((a,b)=>a.fecha.localeCompare(b.fecha));

    const totalClics = porDia.reduce((s,r)=>s+r.clics,0);
    const hoyStr = new Date().toISOString().split('T')[0].replace(/-/g,'');
    const clicsHoy = (respTotal.rows||[]).find(r=>r.dimensionValues[0].value===hoyStr);

    const clicsPorVariante = {};
    (respVar.rows||[]).forEach(r=>{
      const k = r.dimensionValues[0].value;
      if (/^v\d$/.test(k)) clicsPorVariante[k] = parseInt(r.metricValues[0].value||0);
    });

    const datos = cargarDatos();
    const totalVal = Object.values(datos.enviados||{}).filter(e=>e.val).length;
    const tasaConversion = totalVal > 0 ? Math.round(totalClics/totalVal*100)+'%' : '—';

    res.json({ ok:true, totalClics, clicsHoy: clicsHoy?parseInt(clicsHoy.metricValues[0].value):0, tasaConversion, porDia, clicsPorVariante });
  } catch(e) {
    console.error('❌ GA4:', e.message);
    res.json({ error: e.message });
  }
});

app.post('/api/analytics/config', (req, res) => {
  const { propertyId, credentialsPath } = req.body;
  if (!propertyId || !credentialsPath) return res.status(400).json({ error: 'Faltan datos' });
  const credPath = path.isAbsolute(credentialsPath) ? credentialsPath : path.join(__dirname, credentialsPath);
  if (!fs.existsSync(credPath)) return res.status(400).json({ error: `Archivo no encontrado: ${credPath}` });
  config.ga4PropertyId      = String(propertyId).replace('properties/','').trim();
  config.ga4CredentialsPath = credentialsPath.trim();
  guardarConfigDisco(config);
  console.log(`📡 GA4 configurado — Property: ${config.ga4PropertyId}`);
  res.json({ ok: true });
});

// ── ARRANQUE ──────────────────────────────────────────────────────────────────
app.listen(PORT,()=>{
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  Avance Dental — WhatsApp v4         ║`);
  console.log(`║  http://localhost:${PORT}               ║`);
  console.log(`║  Backups automáticos: cada hora      ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
  programarCrons();
  conectar().catch(console.error);
  verificarEnviosPendientesAlArrancar().catch(console.error);
});

process.on('uncaughtException', e=>console.error('💥',e));
process.on('unhandledRejection',e=>console.error('💥',e));
