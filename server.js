import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers
} from '@whiskeysockets/baileys';
import { Boom }   from '@hapi/boom';
import P          from 'pino';
import express    from 'express';
import cors       from 'cors';
import cron       from 'node-cron';
import fs         from 'fs';
import path       from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';
import archiver   from 'archiver';
import crypto     from 'crypto';          // ← tracking: uid hashing
import https      from 'https';           // ← tracking: Measurement Protocol
import googleAnalyticsData from '@google-analytics/data';
const { BetaAnalyticsDataClient } = googleAnalyticsData;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  // 4 franjas horarias diarias para valoraciones — cada una con su propio límite
  val_horas: [
    { hora: '10:00', max: 8 },
    { hora: '13:00', max: 8 },
    { hora: '16:00', max: 7 },
    { hora: '19:00', max: 7 },
  ],
  // legacy por compatibilidad
  horariosVal: { 1:'10:30', 2:'11:00', 3:'10:30', 4:'11:00', 5:'10:00' },

  cita_activo:    true,
  cita_maxPorDia: 50,
  cita_horaEnvio: '09:00',

  delayMinSeg:    8,
  delayMaxSeg:    20,
  bloquearFinde:  true,

  numResenias:    127,   // se muestra en el mensaje ("ya somos X familias")
  flujoSiNo:      false,  // legacy — se mantiene por compatibilidad
  flujoSiNo_cita: true,   // true = flujo SÍ/NO en recordatorios de cita
  flujoSiNo_val:  false,  // DESACTIVADO — valoraciones siempre envían link directo, agente IA gestiona respuestas libres
  // Mensajes del agente de respuestas (editables desde el panel) — [nombre] se sustituye automáticamente
  msgAgentePositivo: '',  // Respuesta a agradecimientos / feedback positivo
  msgAgenteQueja:    '',  // Respuesta a quejas / feedback negativo
  msgAgentePregunta: '',  // Respuesta a preguntas sobre citas, precios, etc.
  msgAgenteDefecto:  '',  // Respuesta por defecto / fuera de contexto
  abTracking:     false,  // registra variante enviada + clics por UTM

  // Mensajes de respuesta valoración SÍ/NO
  msgValSi: `¡Qué alegría, [nombre]! Nos alegra muchísimo 😍\n\nTe agradeceríamos que nos dieses 5 estrellas en Google — solo te tomará 1 minuto y nos ayuda un montón:\n👉 [CTA]\n\n¡Muchas gracias por tu confianza! 🙏`,
  msgValNo: `Lamentamos mucho que la experiencia no haya sido la mejor, [nombre] 🙏\n\nTomamos nota para revisar qué pudimos hacer mejor. Agradecemos enormemente tu sinceridad — es lo que nos ayuda a mejorar de verdad.\n\nUn saludo, el equipo de [clinica].`,

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
  ga4MeasurementId:   '',   // ← tracking: G-XXXXXXXX de tu stream web
  ga4ApiSecret:       '',   // ← tracking: Measurement Protocol API Secret

  // Plantillas de mensajes
  // IMPORTANTE: vacío por defecto → el sistema usa las 4 variantes A/B automáticamente.
  // Si rellenas este campo desde el panel, se usará como plantilla fija para TODOS (desactiva las variantes).
  msgValTemplate: '',
  msgCitaTemplate: `Hola [nombre] 👋

Te escribimos desde *[clinica]* para recordarte que tienes cita[tratamiento] el [fecha][hora].

[nervios]

[CTA]`,
};

// ── CONSTANTES ────────────────────────────────────────────────────────────────
const CLINICA         = 'Avance Dental';
const GOOGLE_REVIEW   = 'https://g.page/r/CRkkiSExZLnnEAE/review';
const YAENVIADO_FILE  = path.join(__dirname, 'yaenviados.json');

// Pool de 7 URLs de redirección — cada una es un repo GitHub Pages distinto
// que redirige a opinion.html pasando los UTM intactos.
// A ojos de WhatsApp son 7 paths distintos → reduce fingerprint de URL repetida.
const URL_POOL = [
  'https://avancedental74.github.io/citas/op/',
  'https://avancedental74.github.io/citas/val/',
  'https://avancedental74.github.io/citas/opinion/',
  'https://avancedental74.github.io/citas/resena/',
  'https://avancedental74.github.io/citas/review/',
  'https://avancedental74.github.io/citas/experiencia/',
  'https://avancedental74.github.io/citas/dental/',
];

// ── TRACKING: IDENTIFICADORES ÚNICOS ─────────────────────────────────────────
// uid: hash SHA-1 truncado del teléfono — estable por paciente, anónimo (LOPD)
// sid: ID de sesión de envío — único por mensaje enviado
// Salt fijo en proceso — cambia entre deploys pero no entre envíos del mismo día
const UID_SALT = process.env.UID_SALT || 'avance2024';
function generarUid(tel) {
  if (!tel) return 'anon';
  return crypto.createHash('sha1').update(UID_SALT + tel).digest('hex').slice(0, 10);
}
function generarSid() {
  // base36 de timestamp + 4 chars aleatorios → ~8-9 chars, URL-safe, sin ambigüedad
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Selecciona URL del pool:
// - Base: índice determinista por teléfono (mismo paciente → siempre la misma, distinto entre pacientes)
// - Jitter: 25% de probabilidad de elegir una URL aleatoria (rompe patrones en envíos masivos)
// - uid + sid añadidos para trazabilidad completa en GA4
function urlConUtm(variante, tipo = 'val', tel = '') {
  const baseIdx = tel
    ? tel.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % URL_POOL.length
    : Math.floor(Math.random() * URL_POOL.length);
  const idx = Math.random() < 0.25
    ? Math.floor(Math.random() * URL_POOL.length)
    : baseIdx;
  const base = URL_POOL[idx];
  const uid  = generarUid(tel);
  const sid  = generarSid();
  return base
    + '?utm_source=whatsapp'
    + '&utm_medium=directo'
    + '&utm_campaign=' + tipo
    + '&utm_content=v' + variante
    + '&uid=' + uid
    + '&sid=' + sid;
}

// ── UTILS BÁSICOS (deben declararse antes que el estado) ──────────────────────
function hoy() { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jid(tel) { return `${tel}@s.whatsapp.net`; }
function telLimpio(t) {
  const limpio = String(t).replace(/\D/g, '').replace(/^34/, '').slice(-9);
  // Validar que sea móvil español o fijo (empieza por 6, 7, 8 o 9) (M1)
  return /^[6789]\d{8}$/.test(limpio) ? limpio : '';
}

// ── MEASUREMENT PROTOCOL GA4 ──────────────────────────────────────────────────
// Envía eventos desde el backend a GA4 sin navegador.
// Documentación: https://developers.google.com/analytics/devguides/collection/protocol/ga4
// Requiere: ga4MeasurementId (G-XXXXXXXX) + ga4ApiSecret en config.
// Fire-and-forget: nunca bloquea el flujo de envío de mensajes.
function mpSendEvent({ eventName, params = {}, uid = null }) {
  if (!config.ga4MeasurementId || !config.ga4ApiSecret) return; // no configurado → silencioso
  const measurementId = config.ga4MeasurementId;
  const apiSecret     = config.ga4ApiSecret;

  // client_id requerido por GA4 — usamos uid si existe, o 'backend.server' como fallback
  // GA4 usará esto para agrupar eventos del mismo "cliente" en el servidor
  const clientId = uid ? `uid.${uid}` : 'backend.server';

  const payload = JSON.stringify({
    client_id: clientId,
    user_id:   uid || undefined,          // User-ID para cross-device si uid existe
    events: [{
      name:   eventName,
      params: {
        engagement_time_msec: 1,          // requerido por MP para que eventos cuenten en informes
        session_id: params.sid || '0',    // vincula con la sesión del frontend si se conoce
        ...params
      }
    }]
  });

  const options = {
    hostname: 'www.google-analytics.com',
    path:     `/mp/collect?measurement_id=${measurementId}&api_secret=${apiSecret}`,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
  };

  const req = https.request(options, res => {
    if (res.statusCode !== 204) {
      console.warn(`⚠️  MP GA4 [${eventName}] → HTTP ${res.statusCode}`);
    }
  });
  req.on('error', e => console.warn(`⚠️  MP GA4 error [${eventName}]:`, e.message));
  req.write(payload);
  req.end();
}

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
  // Intl.DateTimeFormat es más fiable que toLocaleString para obtener solo el día
  const dia = new Intl.DateTimeFormat('es-ES', { weekday: 'long', timeZone: TIMEZONE }).format(new Date()).toLowerCase();
  return dia === 'sábado' || dia === 'domingo';
}

// Devuelve true si la fecha dada (string ISO o Date) cayó en martes (zona configurada)
function eraMartes(fecha) {
  if (!fecha) return false;
  const d = new Date(fecha);
  if (isNaN(d)) return false;
  const dia = new Intl.DateTimeFormat('es-ES', { weekday: 'long', timeZone: TIMEZONE }).format(d).toLowerCase();
  return dia === 'martes';
}

function horaSegunDia() {
  // Intl.DateTimeFormat devuelve solo el nombre corto del día sin el resto de la fecha
  const s = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: TIMEZONE }).format(new Date());
  const m = { Mon:1, Tue:2, Wed:3, Thu:4, Fri:5 };
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
    guardarYaEnviado();
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
function seleccionarVariante() {
  const h = cargarDatos().abStats || {};
  let m = 0, c = Infinity;
  [0, 1, 2, 3].forEach(v => {
    const env = h['v' + v]?.enviados || 0;
    if (env < c) { c = env; m = v; }
  });
  // Jitter 20%: evita bloques de N mensajes consecutivos con la misma variante
  if (Math.random() < 0.20) return Math.floor(Math.random() * 4);
  return m;
}

function registrarAbEnvio(v) {
  if (!config.abTracking) return;
  const d = cargarDatos();
  if (!d.abStats) d.abStats = {};
  if (!d.abStats['v' + v]) d.abStats['v' + v] = { enviados: 0, clics: 0 };
  d.abStats['v' + v].enviados++;
  guardarDatos(d);
}

function construirMsgVal(p, variante) {
  const nombre = p.nombre.split(' ')[0];
  const cuando = cuandoTemporal(p.fecha, p.hora);
  const url = urlConUtm(variante, 'val', p.tel || '');

  // 4 variantes A/B con link directo — sin flujo SÍ/NO
  // AVISO: 4 versiones distintas, seleccionadas por número de teléfono
  // (estable por paciente, distinto entre pacientes — evita sufijo idéntico en envíos masivos)
  const AVISOS = [
    '_Este canal es solo para valoraciones. Para cualquier consulta, escríbenos en nuestro número habitual._',
    '_Recuerda que este número es exclusivamente para opiniones de pacientes. Para citas o dudas, usa nuestro canal habitual._',
    '_Si necesitas pedir cita o tienes alguna pregunta, contáctanos por nuestro número de siempre — este es nuestro canal de valoraciones._',
    '_Este es nuestro canal de valoraciones. Para gestiones o consultas, escríbenos al número habitual de la clínica._',
  ];
  const avisoIdx = (p.tel || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) % AVISOS.length;
  const AVISO = AVISOS[avisoIdx];

  const variantes = [
    // v0 — Gratitud cercana
    `Hola ${nombre}, fue un placer verte ${cuando} 😊 Si tienes un momento, nos encantaría saber cómo te fue — tu opinión nos ayuda a seguir mejorando:\n${url}\n\n${AVISO}`,
    // v1 — Impacto comunidad
    `Hola ${nombre} 👋 Gracias por tu visita ${cuando}. Tu experiencia puede ayudar a otras familias a encontrar un dentista de confianza — ¿nos cuentas cómo te fue?\n${url}\n\n${AVISO}`,
    // v2 — Rapidez + facilidad
    `¡Buenas ${nombre}! Te atendimos ${cuando} en *${CLINICA}*. Solo un momento para contarnos tu experiencia — tarda menos de un minuto 🙏\n${url}\n\n${AVISO}`,
    // v3 — Confianza mutua
    `Qué alegría haberte visto ${cuando}, ${nombre} 🌟 Para nosotros cada opinión cuenta de verdad. Si puedes, cuéntanos cómo fue tu visita:\n${url}\n\n${AVISO}`,
  ];

  // Permitir plantilla personalizada desde panel si existe (reemplaza las variantes)
  const template = config.msgValTemplate;
  if (template && template.trim() && !template.includes('[CTA]')) {
    // Plantilla sin [CTA] = template fijo para todas las variantes
    return template
      .replace(/\[nombre\]/g, nombre)
      .replace(/\[cuando\]/g, cuando)
      .replace(/\[clinica\]/g, CLINICA)
      .replace(/\[URL\]/g, url)
      .trim();
  }
  if (template && template.trim() && template.includes('[CTA]')) {
    return template
      .replace(/\[nombre\]/g, nombre)
      .replace(/\[cuando\]/g, cuando)
      .replace(/\[clinica\]/g, CLINICA)
      .replace(/\[CTA\]/g, url)
      .trim();
  }

  return variantes[variante % variantes.length];
}

// Respuesta automática al SÍ — incluye UTM de la variante para tracking GA4
function construirMsgEnlace(nombre, variante, tel = '') {
  const url = urlConUtm(variante, 'val', tel);
  const template = (config.msgValSi || `¡Qué alegría, [nombre]! Nos alegra muchísimo 😍\n\nTe agradeceríamos que nos dieses 5 estrellas en Google — solo te tomará 1 minuto y nos ayuda un montón:\n👉 [CTA]\n\n¡Muchas gracias por tu confianza! 🙏`);
  return template
    .replace(/\[nombre\]/g, nombre)
    .replace(/\[nombre1\]/g, nombre)
    .replace(/\[CTA\]/g, url)
    .replace(/\[clinica\]/g, CLINICA);
}

function construirMsgRespuestaNo(nombre) {
  const template = (config.msgValNo || `Lamentamos mucho que la experiencia no haya sido la mejor, [nombre] 🙏\n\nTomamos nota para revisar qué pudimos hacer mejor. Agradecemos enormemente tu sinceridad — es lo que nos ayuda a mejorar de verdad.\n\nUn saludo, el equipo de [clinica].`);
  return template
    .replace(/\[nombre\]/g, nombre)
    .replace(/\[nombre1\]/g, nombre)
    .replace(/\[clinica\]/g, CLINICA);
}

// ── AGENTE LOCAL — VALORACIONES ──────────────────────────────────────────────
// Detección de intención 100% local — sin APIs externas, coste cero
// Intenciones detectadas: positivo | queja | pregunta | defecto (fuera de contexto)
function agenteValoracion({ nombre, texto }) {
  const t = texto.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[¡!¿?.,;:]/g, ' ').trim();

  // ── Palabras clave por intención ────────────────────────────────────────────
  const clavesPositivo = [
    'gracias','muchas gracias','muy bien','excelente','genial','perfecto','increible',
    'fenomenal','encantado','encantada','satisfecho','satisfecha','contento','contenta',
    'feliz','espectacular','maravilloso','maravillosa','10','diez','cinco estrellas',
    'muy amable','muy amables','recomiendo','recomendare','lo recomiendo','de lujo',
    'buenisimo','buenisima','super bien','muy profesional','muy profesionales','trato excelente',
    'volveremos','volvere','sin dolor','sin molestias','todo perfecto','todo bien','estupendo',
  ];
  const clavesQueja = [
    'mal','malo','mala','fatal','pesimo','pesima','horrible','espantoso','espantosa',
    'molestia','molestias','dolor','me dolio','me duele','me hicieron daño','me hiciste daño',
    'no me gusto','no me gustó','no me atendieron','mala atencion','mala experiencia',
    'queja','reclamacion','reclamación','problema','problemas','deficiente','inaceptable',
    'no volvere','decepcionado','decepcionada','muy caro','carísimo','no funciono','no ha funcionado',
    'espere mucho','esperar mucho','mucha espera','tarde mucho','impuntual','no me informaron',
  ];
  const clavesPregunta = [
    'cita','citas','pedir cita','solicitar cita','cancelar','cancelar cita','cambiar cita',
    'precio','precios','presupuesto','cuanto cuesta','cuánto cuesta','cuanto vale','cuánto vale',
    'horario','horarios','cuando abren','cuando cierran','a que hora','telefono','teléfono',
    'numero','número','contacto','como os llamo','puedo llamar','puedo ir','donde estais',
    'dirección','direccion','ubicacion','ubicación','donde sois','implante','implantes',
    'ortodoncia','blanqueamiento','limpieza','empaste','extraccion','extracción','urgencia',
    'cubre el seguro','seguro dental','mutua','tiene aparcamiento','parking',
  ];

  // Busca coincidencia en el texto normalizado
  function detecta(lista) {
    return lista.some(w => {
      const wn = w.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return t === wn || t.includes(' ' + wn + ' ') || t.startsWith(wn + ' ') || t.endsWith(' ' + wn) || t === wn || t.includes(wn);
    });
  }

  const esPositivo  = detecta(clavesPositivo);
  const esQueja     = detecta(clavesQueja);
  const esPregunta  = detecta(clavesPregunta);

  // Plantillas de respuesta por intención (varias para rotar y sonar más natural)
  // Defaults si no hay mensaje personalizado en config
  const defaultsPositivo = [
    `¡Qué alegría saberlo, ${nombre}! 😊 Nos motiva mucho recibir mensajes como el tuyo — es lo que nos hace seguir mejorando cada día. ¡Hasta la próxima!`,
    `¡Muchas gracias por tus palabras, ${nombre}! 🙏 Es un placer tenerte como paciente. Si aún no has podido dejarnos tu reseña en Google, ¡te lo agradecemos mucho!`,
    `¡Qué bien, ${nombre}! 🌟 Tu opinión nos llena de energía. Si quieres compartir tu experiencia en Google, estaremos muy agradecidos. ¡Hasta pronto!`,
  ];
  const defaultsQueja = [
    `Lamentamos mucho que tu experiencia no haya sido la que mereces, ${nombre} 🙏 Tomamos nota de tu comentario — nos ayuda a mejorar. Nuestro equipo lo revisará con cuidado.`,
    `Sentimos sinceramente lo ocurrido, ${nombre}. Tu bienestar es lo primero para nosotros. El equipo tomará nota para que no vuelva a repetirse. Gracias por contárnoslo.`,
    `Gracias por tu sinceridad, ${nombre} 🙏 Lo sentimos mucho. Nuestro equipo revisará lo que pasó y tomará las medidas necesarias. Tu opinión nos hace mejorar.`,
  ];
  const defaultsPregunta = [
    `¡Hola ${nombre}! Para cualquier consulta sobre citas, precios o tratamientos, escríbenos en nuestro número habitual y te atendemos encantados 😊 Este canal es exclusivo para valoraciones.`,
    `Hola ${nombre}, para gestionar tu cita o resolver cualquier duda, contáctanos por nuestro número habitual — te atenderemos sin problema 📞 Este canal es solo para valoraciones.`,
  ];
  const defaultsDefecto = [
    `¡Gracias por escribirnos, ${nombre}! 😊 Este canal es exclusivo para valoraciones. Para cualquier consulta o cita, escríbenos en nuestro número habitual y te atendemos enseguida.`,
    `Hola ${nombre}, gracias por tu mensaje 🙏 Para consultas o citas, usa nuestro número habitual — este canal está reservado para valoraciones de pacientes.`,
  ];

  // Helper: usa mensaje personalizado de config si existe, sino rota entre defaults
  function resolver(cfgMsg, defaults) {
    if (cfgMsg && cfgMsg.trim()) return cfgMsg.trim().replace(/\[nombre\]/g, nombre);
    const idx = texto.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % defaults.length;
    return defaults[idx];
  }

  // Prioridad: queja > positivo > pregunta > defecto
  if (esQueja)         return resolver(config.msgAgenteQueja,    defaultsQueja);
  if (esPositivo)      return resolver(config.msgAgentePositivo, defaultsPositivo);
  if (esPregunta)      return resolver(config.msgAgentePregunta, defaultsPregunta);
  return                      resolver(config.msgAgenteDefecto,  defaultsDefecto);
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
  const nombre = p.nombre.split(' ')[0];
  const hora = p.hora ? ` a las *${p.hora}*` : '';
  const tratTxt = p.trat ? ` para tu *${p.trat.toLowerCase()}*` : '';
  const fechaTxt = p.fecha ? `*${fmtFecha(p.fecha)}*` : 'próximamente';
  const difícil = esTratDificil(p.trat);

  let template = config.msgCitaTemplate || `Hola [nombre] 👋

Te escribimos desde *[clinica]* para recordarte que tienes cita[tratamiento] el [fecha][hora].

[nervios]

[CTA]`;

  let nervios = '';
  if (difícil) {
    nervios = 'Sabemos que este tipo de tratamiento puede generar algo de nervios — estamos aquí para que te sientas cómodo/a en todo momento 🙌';
  }

  let cta = '';
  const flujoCita = config.flujoSiNo_cita ?? config.flujoSiNo;
  if (flujoCita) {
    cta = '¿Puedes confirmarnos la asistencia?\n\n✅ Responde *SÍ* para confirmar\n❌ Responde *NO* si necesitas cambiarla';
  } else {
    cta = 'Si necesitas cambiarla o tienes alguna duda, llámanos y con gusto te buscamos otro hueco 😊';
  }

  return template
    .replace(/\[nombre\]/g, nombre || '')
    .replace(/\[clinica\]/g, CLINICA || '')
    .replace(/\[tratamiento\]/g, tratTxt)
    .replace(/\[fecha\]/g, fechaTxt)
    .replace(/\[hora\]/g, hora)
    .replace(/\[nervios\]/g, nervios)
    .replace(/\[CTA\]/g, cta)
    .trim();
}


// ── ANTI-BANEO: UTILIDADES DE COMPORTAMIENTO HUMANO ──────────────────────────

// OPT-5 — Delay gaussiano (Box-Muller): distribución en campana centrada en la media
// Los humanos reales tienen tiempos agrupados alrededor de un valor, no uniformes
function delayGaussiano(minMs, maxMs) {
  const media  = (minMs + maxMs) / 2;
  const sigma  = (maxMs - minMs) / 6; // 99.7% de valores dentro del rango
  let u, v, s;
  do {
    u = Math.random() * 2 - 1;
    v = Math.random() * 2 - 1;
    s = u * u + v * v;
  } while (s >= 1 || s === 0);
  const gauss = u * Math.sqrt(-2 * Math.log(s) / s);
  return Math.round(Math.max(minMs, Math.min(maxMs, media + gauss * sigma)));
}

// OPT-3 — Tiempo de escritura proporcional a la longitud del mensaje
// ~40 chars/seg (velocidad humana media en móvil) + jitter aleatorio
function tiempoComposing(texto) {
  const chars       = String(texto).length;
  const msBase      = Math.round((chars / 40) * 1000); // 40 chars/seg
  const msMinimo    = 1500;
  const msMaximo    = 6000;
  const jitter      = (Math.random() - 0.5) * 800; // ±400ms de variación
  return Math.max(msMinimo, Math.min(msMaximo, msBase + jitter));
}

// OPT-4 — Caché de verificación onWhatsApp (TTL: 24h)
// Evita consultar el servidor de WA por el mismo número repetidamente
const _waCache = new Map(); // tel → { exists: bool, ts: timestamp }
const WA_CACHE_TTL = 24 * 3600 * 1000; // 24 horas

async function verificarNumero(sock, jidCompleto) {
  const tel = jidCompleto.replace('@s.whatsapp.net', '');
  const cached = _waCache.get(tel);
  if (cached && (Date.now() - cached.ts) < WA_CACHE_TTL) {
    return cached.exists;
  }
  const [info] = await sock.onWhatsApp(jidCompleto).catch(() => [null]);
  const existe = !!info?.exists;
  _waCache.set(tel, { exists: existe, ts: Date.now() });
  return existe;
}

// ── ENVÍO ─────────────────────────────────────────────────────────────────────
async function enviarMensaje(telefono, texto) {
  if (!sockGlobal || estadoWA !== 'conectado') throw new Error('WhatsApp no conectado');
  const j = jid(telefono.startsWith('34') ? telefono : '34' + telefono);

  // OPT-4: verificación con caché — no consulta WA si ya lo verificamos hoy
  const existe = await verificarNumero(sockGlobal, j);
  if (!existe) throw new Error('Sin WhatsApp: ' + telefono);

  // OPT-6: micro-pausa antes de composing — simula "abrir el chat" en el móvil
  // Entre 300ms y 1200ms, distribución gaussiana
  await sleep(delayGaussiano(300, 1200));

  // OPT-3: tiempo de composing proporcional a la longitud del mensaje
  const msComposing = tiempoComposing(texto);
  await sockGlobal.sendPresenceUpdate('composing', j);
  await sleep(msComposing);
  await sockGlobal.sendPresenceUpdate('paused', j);

  // Breve pausa tras "paused" antes de enviar — como el humano que revisa el texto
  await sleep(delayGaussiano(200, 600));

  await sockGlobal.sendMessage(j, { text: texto });
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
  } else if (mod === 'val') {
    // ── AGENTE IA — gestiona cualquier respuesta libre del paciente ──────────
    console.log(`🤖 AGENTE VAL — ${nombre} (${tel}): "${texto.trim()}"`);
    try {
      const respuestaAgente = agenteValoracion({ nombre: nombre1, texto: texto.trim(), clinica: CLINICA });
      await enviarMensaje(tel, respuestaAgente).catch(console.error);
      registrarMensaje({ tel, nombre, mod: 'val', textoOriginal: texto.trim(), resultado: 'agente' });
      if (/mal|problema|queja|molest|dolor|error|defect|no me gusto|no me gustó/i.test(texto)) {
        await avisarOperador(nombre, tel, null, null, null, `Posible queja: "${texto.trim()}"`).catch(console.error);
      }
    } catch(e) {
      console.error(`❌ Agente val error para ${nombre}:`, e.message);
      await enviarMensaje(tel, `¡Gracias por escribirnos, ${nombre1}! 🙏\n\n_Este canal es exclusivo para valoraciones. Para cualquier consulta, escríbenos en nuestro número habitual._`).catch(console.error);
    }
    esperandoRespuesta.delete(tel); guardarEsperando();
  } else {
    // Otros módulos (si los hubiera)
    console.log(`ℹ️ Mensaje de ${nombre} (${tel}) en módulo ${mod} — fuera de flujo auto-respuesta`);
  }
}

// ── PROCESAR COLA ─────────────────────────────────────────────────────────────
let colaActiva = false; // declarado AQUÍ — antes de ambas funciones que lo usan

// procesarColaFranja: igual que procesarCola('val') pero con límite propio de la franja
// Se llama desde el cron cuando llega la hora de cada franja horaria
async function procesarColaFranja(mod, maxFranja) {
  if (colaActiva) return;
  if (config.bloquearFinde && esFinde()) { console.log(`🚫 Fin de semana — envíos bloqueados`); return; }
  colaActiva = true;
  try {
    resetarContadoresSiNuevoDia();
    const cola  = cargarCola();
    const datos = cargarDatos();
    const lb    = new Set((datos.listaNegra || []).map(e => e.tel || e));

    let pendientes = cola.filter(p => {
      if (p.enviado || p.mod !== mod) return false;
      if (lb.has(p.tel)) return false;
      if (datos.enviados[p.tel]?.[p.mod]) return false; // ya enviado alguna vez (valoraciones: nunca repetir)
      return true;
    });

    if (!pendientes.length) { console.log(`📋 [${mod}/${maxFranja}] Sin pendientes para esta franja`); return; }

    // Tomar solo los que caben en esta franja
    const aEnviar = pendientes.slice(0, maxFranja);
    console.log(`📤 [Franja] Enviando ${aEnviar.length}/${maxFranja} valoraciones...`);

    for (let i = 0; i < aEnviar.length; i++) {
      const p = aEnviar[i];
      const varianteIdx = seleccionarVariante();
      const msgTexto = construirMsgVal(p, varianteIdx);
      try {
        await enviarMensaje(p.tel, msgTexto);
        if (!datos.enviados[p.tel]) datos.enviados[p.tel] = {};
        datos.enviados[p.tel][p.mod] = hoy();
        datos.enviados[p.tel].nombre  = p.nombre;
        datos.enviados[p.tel].trat    = p.trat || '';
        datos.enviados[p.tel].variante = varianteIdx;
        registrarAbEnvio(varianteIdx);

        // ── TRACKING: persistir uid y sid del envío ──────────────────────────
        // NOTA: el sid ya fue generado dentro de urlConUtm() al construir msgTexto.
        // Extraemos el uid (determinista) y creamos un sid de referencia para el MP.
        // El sid del frontend vendrá del URL que el paciente recibió — aquí guardamos
        // el uid para poder buscarlo en GA4 cuando el paciente haga clic.
        const uid = generarUid(p.tel);
        const sid = generarSid(); // sid de este evento de backend (distinto al del link)
        datos.enviados[p.tel].uid = uid;

        // ── MEASUREMENT PROTOCOL: evento message_sent ────────────────────────
        mpSendEvent({
          eventName: 'message_sent',
          uid,
          params: {
            sid,
            variant:      'v' + varianteIdx,
            message_type: 'val',
            clinica:      CLINICA,
          }
        });

        // Flujo SÍ/NO valoración
        if (config.flujoSiNo_val) {
          esperandoRespuesta.set(p.tel, { mod: 'val', nombre: p.nombre, variante: varianteIdx, fecha: p.fecha || null, hora: p.hora || '', trat: p.trat || '', ts: Date.now() });
          guardarEsperando();
        }

        p.enviado = true; p.fechaEnvio = new Date().toISOString(); p.variante = varianteIdx;
        // NO guardarCola aquí — se guarda una sola vez al final del bucle
        enviosHoyVal++;
        console.log(`✅ [${i + 1}/${aEnviar.length}] VAL V${varianteIdx} → ${p.nombre}`);

        if (i < aEnviar.length - 1) {
          // OPT-5: delay gaussiano entre mensajes — más natural que uniforme
          await sleep(delayGaussiano(config.delayMinSeg * 1000, config.delayMaxSeg * 1000));
        }
      } catch (err) {
        console.error(`❌ ${p.nombre}:`, err.message);
        p.error = err.message; guardarCola(cola);
      }
    }
    guardarDatos(datos);
    guardarCola(cola); // una sola escritura al final — no dentro del bucle
    console.log(`🏁 Franja completada — val hoy: ${enviosHoyVal}`);
  } catch (err) {
    console.error('💥 Error en procesarColaFranja:', err.message);
  } finally {
    colaActiva = false;
  }
}
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

    const hoyStr = hoy();
    const yaEnviado = datos.enviados[p.tel]?.[p.mod];

    // Reglas inteligentes de frecuencia:
    if (p.mod === 'cita') {
      // Citas: No repetir el mismo día (idempotencia)
      if (yaEnviado === hoyStr) return false;

      // Solo enviar si la cita es hoy o mañana (según fecha del lead)
      if (p.fecha) {
        const hoyD   = new Date(); hoyD.setHours(0,0,0,0);
        const manana = new Date(hoyD); manana.setDate(manana.getDate()+1);
        const fCita  = new Date(p.fecha); fCita.setHours(0,0,0,0);
        if (fCita > manana) return false; // cita aún lejana
        if (fCita < hoyD)   return false; // cita ya pasada
      }
    } else {
      // Valoraciones: REGLA ESTRICTA — Si ya se le pidió opinión una vez, no volver a enviar NUNCA
      if (yaEnviado) return false;
    }
    return true;
  });
  if (modFiltro) pendientes = pendientes.filter(p=>p.mod===modFiltro);
  if (!pendientes.length) {
    if (modFiltro) console.log(`📋 [${modFiltro}] No hay leads procesables para enviar ahora`);
    return;
  }

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
      // A/B tracking envío
      if (p.mod==='val') registrarAbEnvio(varianteIdx);

      // ── TRACKING: persistir uid y sid del envío ────────────────────────────
      if (p.mod === 'val') {
        const uid = generarUid(p.tel);
        const sid = generarSid(); // sid de referencia backend; el del link lo generó urlConUtm()
        datos.enviados[p.tel].uid = uid;

        // ── MEASUREMENT PROTOCOL: evento message_sent ──────────────────────
        mpSendEvent({
          eventName: 'message_sent',
          uid,
          params: {
            sid,
            variant:      'v' + varianteIdx,
            message_type: p.mod,
            clinica:      CLINICA,
          }
        });
      }

      // SÍ/NO: guardar para respuesta automática — CITAS y VALORACIONES (si flujo activo)
      const flujoActivoCita = config.flujoSiNo_cita ?? config.flujoSiNo;
      const flujoActivoVal  = config.flujoSiNo_val;
      if (p.mod === 'cita' && flujoActivoCita) {
        esperandoRespuesta.set(p.tel, { mod:'cita', nombre:p.nombre, fecha:p.fecha||null, hora:p.hora||'', trat:p.trat||'', ts:Date.now() });
        guardarEsperando();
      } else if (p.mod === 'val' && flujoActivoVal) {
        esperandoRespuesta.set(p.tel, { mod:'val', nombre:p.nombre, variante:varianteIdx, fecha:p.fecha||null, hora:p.hora||'', trat:p.trat||'', ts:Date.now() });
        guardarEsperando();
      }

      p.enviado=true; p.fechaEnvio=new Date().toISOString(); p.variante=varianteIdx;
      // NO guardarCola aquí — se guarda una sola vez al final del bucle

      if (p.mod==='val')  enviosHoyVal++;
      if (p.mod==='cita') enviosHoyCita++;
      console.log(`✅ [${i+1}/${aEnviar.length}] ${p.mod.toUpperCase()} V${varianteIdx} → ${p.nombre}`);

      if (i < aEnviar.length - 1) {
        // OPT-5: delay gaussiano entre mensajes — más natural que uniforme
        await sleep(delayGaussiano(config.delayMinSeg * 1000, config.delayMaxSeg * 1000));
      }
    } catch(err) {
      console.error(`❌ ${p.nombre}:`,err.message);
      p.error=err.message; guardarCola(cola);
    }
  }

  // Una sola escritura al final para evitar race conditions y desgaste de disco
  guardarDatos(datos);
  guardarCola(cola);

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

      const hoyStr = hoy();
      const yaEnviado = datos.enviados[tel]?.[mod];

      // Sincronización inteligente:
      if (mod === 'cita') {
        // Citas: Volcar si es hoy/mañana y no se envió hoy
        if (yaEnviado === hoyStr) return;
        if (p.fecha) {
          const hoyD   = new Date(); hoyD.setHours(0,0,0,0);
          const manana = new Date(hoyD); manana.setDate(manana.getDate()+1);
          const fCita  = new Date(p.fecha); fCita.setHours(0,0,0,0);
          if (fCita > manana) return;
          if (fCita < hoyD)  return;
        }
      } else {
        // Valoraciones: REGLA ESTRICTA — No volver a pedir si ya se envió NUNCA (está en el historial)
        if (yaEnviado) return;

        // No enviar si la visita fue un martes
        if (eraMartes(p.fecha)) {
          console.log(`📅 Omitido (visita en martes): ${p.nombre} (${tel})`);
          return;
        }
      }

      // Evitar duplicados en cola pendiente
      if (cola.some(c=>c.tel===tel&&c.mod===mod&&!c.enviado)) return;

      cola.push({ nombre:p.nombre, tel, fecha:p.fecha||null, hora:p.hora||'', trat:p.trat||'', mod, enviado:false, añadido:new Date().toISOString() });
      añadidos++;
    });
  });

  if (añadidos) {
    guardarCola(cola);
    console.log(`📋 ${añadidos} leads añadidos a la cola automáticamente`);
  }
}

// ── CONFIGURACIÓN DE ZONA HORARIA ─────────────────────────────────────────────
const TIMEZONE = process.env.TZ || 'Europe/Madrid';

// ── CRON ──────────────────────────────────────────────────────────────────────
// Registra qué módulos ya se dispararon hoy para no enviar dos veces
const yaEnviadoHoy = { val: null, cita: null }; // valor = fecha 'YYYY-MM-DD' del último disparo

// Persistir yaEnviadoHoy en disco para sobrevivir reinicios
function guardarYaEnviado() {
  try {
    fs.writeFileSync(YAENVIADO_FILE, JSON.stringify(yaEnviadoHoy, null, 2));
  } catch (e) { /* ignorar errores de escritura */ }
}
function cargarYaEnviado() {
  try {
    if (fs.existsSync(YAENVIADO_FILE)) {
      const datos = JSON.parse(fs.readFileSync(YAENVIADO_FILE, 'utf8'));
      // Solo restaurar si es del día de hoy
      const hoyStr = hoy();
      if (datos.val === hoyStr || datos.cita === hoyStr) {
        Object.assign(yaEnviadoHoy, datos);
      }
    }
  } catch (e) { /* ignorar */ }
}
cargarYaEnviado();

// Convierte "HH:MM" en minutos totales desde medianoche
function horaAMinutos(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return h * 60 + m;
}

// Devuelve hora actual en la zona configurada como minutos totales
function ahoraEnMinutos() {
  const s = new Date().toLocaleTimeString('es-ES', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TIMEZONE
  });
  return horaAMinutos(s);
}

// Ventana de tolerancia: dispara si estamos dentro de los 30 min posteriores a la hora programada
// Cubre arranques tardíos, reinicios, desfases del SO y colas grandes con delay entre mensajes
const VENTANA_MIN = 30;

// Devuelve las franjas configuradas para valoraciones — array de {hora, max}
function horasVal() {
  if (Array.isArray(config.val_horas) && config.val_horas.length) {
    // Normalizar: acepta tanto objetos {hora, max} como strings legacy '10:00'
    return config.val_horas.map(f =>
      typeof f === 'string' ? { hora: f, max: 8 } : f
    );
  }
  // Fallback legado: horariosVal por día de semana con max global
  return [{ hora: horaSegunDia(), max: config.val_maxPorDia || 30 }];
}

// Suma de todos los máximos de franja — usado como límite diario total informativo
function maxDiarioVal() {
  return horasVal().reduce((s, f) => s + (parseInt(f.max) || 0), 0);
}

function programarCrons() {
  if (cronJobVal)  { cronJobVal.destroy();  cronJobVal  = null; }
  if (cronJobCita) { cronJobCita.destroy(); cronJobCita = null; }
  const opts = { timezone: TIMEZONE };

  // Cron unificado — revisa cada minuto L-V entre 6:00 y 21:00
  // Valoraciones: hasta 4 franjas independientes con su propio límite de envíos
  cronJobVal = cron.schedule('* 6-21 * * 1-5', async () => {
    if (config.bloquearFinde && esFinde()) return;
    resetarContadoresSiNuevoDia();
    const fechaHoy = hoy();
    const ahoraMin = ahoraEnMinutos();

    // ── VALORACIONES — franjas con límite propio ──────────────────────────
    if (config.val_activo) {
      const franjas = horasVal();
      if (!yaEnviadoHoy._valFranjas) yaEnviadoHoy._valFranjas = {};

      for (const franja of franjas) {
        const clave = `${fechaHoy}-${franja.hora}`;
        if (yaEnviadoHoy._valFranjas[clave]) continue; // ya disparada hoy

        const horaObjetivo = horaAMinutos(franja.hora);
        if (ahoraMin >= horaObjetivo) {
          const maxFranja = parseInt(franja.max) || 8;
          console.log(`\n🕐 CRON VALORACIÓN [${franja.hora}] — max franja: ${maxFranja}`);
          yaEnviadoHoy._valFranjas[clave] = true;
          yaEnviadoHoy.val = fechaHoy; // compatibilidad legacy
          guardarYaEnviado();
          sincronizarLeadsACola();
          if (estadoWA === 'conectado') {
            await procesarColaFranja('val', maxFranja).catch(console.error);
          } else {
            console.log('⚠️  WhatsApp no conectado — valoraciones en cola, reintentará en el próximo minuto si conecta');
            yaEnviadoHoy._valFranjas[clave] = false;
            guardarYaEnviado();
          }
          break; // una franja por tick
        }
      }
    }

    // ── RECORDATORIOS CITA ────────────────────────────────────────────────
    if (config.cita_activo && yaEnviadoHoy.cita !== fechaHoy) {
      const horaObjetivo = horaAMinutos(config.cita_horaEnvio);
      if (ahoraMin >= horaObjetivo) {
        console.log(`\n🕐 CRON CITA — hora programada: ${config.cita_horaEnvio}, hora actual: ${ahoraMin}min`);
        yaEnviadoHoy.cita = fechaHoy;
        guardarYaEnviado();
        sincronizarLeadsACola();
        if (estadoWA === 'conectado') {
          await procesarCola('cita', true).catch(console.error);
        } else {
          console.log('⚠️  WhatsApp no conectado — recordatorios en cola, reintentará en el próximo minuto si conecta');
          yaEnviadoHoy.cita = null;
          guardarYaEnviado();
        }
      }
    }
  }, opts);

  const franjas = horasVal();
  const totalMax = maxDiarioVal();
  console.log(`⏰ Cron activo (cada minuto, L-V 6-21h)`);
  console.log(`⏰ Zona horaria: ${TIMEZONE}`);
  console.log(`⏰ Valoraciones: ${franjas.map(f => `${f.hora}(max:${f.max})`).join(', ')} → total/día: ${totalMax}`);
  console.log(`⏰ Recordatorios: ${config.cita_horaEnvio}`);
}

// Al arrancar el servidor: si ya pasó la hora de envío de hoy y hay cola pendiente → enviar
// Cubre el caso más común: "reinicié el servidor después de la hora programada"
async function verificarEnviosPendientesAlArrancar() {
  // Esperar activamente hasta que Baileys conecte (máx 120s) en lugar de un sleep fijo
  const MAX_ESPERA_MS = 120000;
  const INTERVALO_MS  = 2000;
  let esperado = 0;
  while (estadoWA !== 'conectado' && esperado < MAX_ESPERA_MS) {
    await sleep(INTERVALO_MS);
    esperado += INTERVALO_MS;
  }
  if (estadoWA !== 'conectado') {
    console.log('⚠️ [Arranque] WhatsApp no conectó en 120s — envíos pendientes diferidos al cron');
    return;
  }

  if (esFinde() && config.bloquearFinde) return;

  const fechaHoy = hoy();
  const ahoraMin = ahoraEnMinutos();

  // Sincronizar leads antes de comprobar cola
  sincronizarLeadsACola();

  const cola  = cargarCola();
  const datos = cargarDatos();
  const lb    = new Set((datos.listaNegra || []).map(e => e.tel || e));

  const hayValPendiente  = cola.some(p => p.mod === 'val'  && !p.enviado && !lb.has(p.tel) && !datos.enviados[p.tel]?.val);
  const hayCitaPendiente = cola.some(p => p.mod === 'cita' && !p.enviado && !lb.has(p.tel) && !datos.enviados[p.tel]?.cita);

  if (config.val_activo && hayValPendiente) {
    if (!yaEnviadoHoy._valFranjas) yaEnviadoHoy._valFranjas = {};
    const franjas = horasVal();
    for (const franja of franjas) {
      const clave = `${fechaHoy}-${franja.hora}`;
      if (yaEnviadoHoy._valFranjas[clave]) continue; // ya se ejecutó esta franja hoy
      const horaObjetivo = horaAMinutos(franja.hora);
      if (ahoraMin >= horaObjetivo) {
        console.log(`\n🔄 Arranque tardío — lanzando valoraciones franja ${franja.hora} (max: ${franja.max})`);
        yaEnviadoHoy._valFranjas[clave] = true;
        yaEnviadoHoy.val = fechaHoy;
        guardarYaEnviado();
        procesarColaFranja('val', parseInt(franja.max) || 8).catch(console.error);
        await sleep(2000); // pequeña pausa entre franjas si hay varias pendientes
      }
    }
  }

  if (config.cita_activo && hayCitaPendiente && yaEnviadoHoy.cita !== fechaHoy) {
    const horaObjetivo = horaAMinutos(config.cita_horaEnvio);
    if (ahoraMin >= horaObjetivo) {
      console.log(`\n🔄 Arranque tardío — lanzando recordatorios pendientes (hora programada: ${config.cita_horaEnvio})`);
      yaEnviadoHoy.cita = fechaHoy;
      guardarYaEnviado();
      procesarCola('cita', true).catch(console.error);
    }
  }
}

// ── BAILEYS ───────────────────────────────────────────────────────────────────
// Evitar llamadas concurrentes a conectar() — solo una instancia activa a la vez
let conectando = false;

async function limpiarSesion() {
  const authDir = path.join(__dirname, 'auth_avancedental');
  try { fs.rmSync(authDir, { recursive: true, force: true }); } catch (e) {}
  console.log('🗑  Sesión borrada — se generará nuevo QR');
}

async function conectar() {
  if (conectando) { console.log('⏳ Conexión ya en curso, ignorando llamada duplicada'); return; }
  conectando = true;

  // Limpiar estado global antes de crear nuevo socket
  sockGlobal = null;
  estadoWA = 'conectando';
  qrActual  = null;

  let sock;
  try {
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_avancedental'));
    sock = makeWASocket({
      auth: state,
      logger: P({ level: 'silent' }),
      browser: Browsers.ubuntu('Chrome'),  // macOS('Desktop') es detectado y bloqueado por WhatsApp en 2025-2026
      version,
      generateHighQualityLinkPreview: false,
      defaultQueryTimeoutMs: 60000,
      syncFullHistory: false,              // evita timeout en el handshake inicial
    });

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        qrActual  = qr;
        estadoWA  = 'qr';
        conectando = false; // ya tenemos QR, liberar para poder reconectar si hace falta
        console.log('📱 QR generado — escanea desde la web en localhost:3001');
      }
      if (connection === 'open') {
        estadoWA   = 'conectado';
        qrActual   = null;
        sockGlobal = sock;
        conectando = false;
        console.log('✅ WhatsApp conectado');
      }
      if (connection === 'close') {
        estadoWA   = 'desconectado';
        sockGlobal = null;
        conectando = false;

        const statusCode = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode : 0;

        // Códigos que requieren nuevo QR: baneado (403), sesión cerrada (401), conflicto (405), loggedOut
        const necesitaNuevoQR = [DisconnectReason.loggedOut, 401, 403, 405].includes(statusCode);

        if (necesitaNuevoQR) {
          console.log(`🚫 Sesión inválida (código ${statusCode}) — borrando sesión y generando nuevo QR`);
          await limpiarSesion();
          estadoWA = 'esperando_qr'; // estado intermedio visible en el panel
          setTimeout(conectar, 2000);
        } else {
          console.log(`🔄 Reconectando en 5s... (código: ${statusCode})`);
          setTimeout(conectar, 5000);
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);
  } catch (err) {
    conectando = false;
    estadoWA   = 'desconectado';
    console.error('❌ Error al iniciar Baileys:', err.message);
    setTimeout(conectar, 8000);
    return;
  }

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
      procesarRespuesta(rem, txtLimpio).catch(e => console.error('❌ procesarRespuesta:', e.message));
    }
  });

  sock.ev.on('creds.update',saveCreds);
}

// ── API REST ──────────────────────────────────────────────────────────────────
// ── SEGURIDAD — API TOKEN (C2) ───────────────────────────────────────────────
// En entorno local, protege contra accesos no autorizados en la misma red Wi-Fi
const API_TOKEN = process.env.API_TOKEN || 'avance-dental-2026';

const app = express();
app.use(cors()); 
app.use(express.json({limit:'2mb'}));

// Middleware de autenticación global para la API
app.use((req, res, next) => {
  // Permitir acceso a archivos estáticos (el propio panel de control)
  if (!req.path.startsWith('/api/') || req.path === '/api/status' || req.path === '/api/qr') {
    return next();
  }
  
  if (req.headers['x-api-token'] !== API_TOKEN) {
    console.warn(`🛡️  Bloqueado acceso no autorizado de ${req.ip} a ${req.path}`);
    return res.status(401).json({ error: 'No autorizado — Falta API Token' });
  }
  next();
});

app.get('/api/status', (req,res)=>{
  const dia = new Intl.DateTimeFormat('es-ES', { weekday: 'long', timeZone: TIMEZONE }).format(new Date()).toLowerCase();
  res.json({
    estado: estadoWA, qr: estadoWA === 'qr' ? qrActual : null,
    enviosHoyVal, enviosHoyCita, config,
    esFinDeSemana: dia === 'sábado' || dia === 'domingo', diaActual: dia,
    esperandoRespuesta: esperandoRespuesta.size,
    rutaServidor: __dirname
  });
});

// Borrar sesión manualmente y forzar nuevo QR (útil tras baneo o cambio de número)
app.post('/api/reset-sesion', async (req, res) => {
  try {
    if (sockGlobal) {
      try { await sockGlobal.logout(); } catch (e) { /* ignorar si ya está desconectado */ }
      sockGlobal = null;
    }
    estadoWA  = 'desconectado';
    qrActual  = null;
    conectando = false;
    await limpiarSesion();
    // Pequeña pausa para garantizar que el filesystem libera los archivos antes de reconectar
    await sleep(1000);
    setTimeout(conectar, 500);
    res.json({ ok: true, mensaje: 'Sesión borrada — nuevo QR en unos segundos' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/config',(req,res)=>res.json(config));
app.post('/api/config',(req,res)=>{
  ['val_activo','val_maxPorDia','val_horas','horariosVal','cita_activo','cita_maxPorDia','cita_horaEnvio',
   'delayMinSeg','delayMaxSeg','bloquearFinde','numResenias','flujoSiNo','flujoSiNo_cita','flujoSiNo_val','abTracking',
   'avisoMetodo','avisoEmail','avisoEmailUser','avisoEmailPass','avisoWhatsapp',
   'msgConfirmado','msgRechazado','msgValTemplate','msgCitaTemplate','msgValSi','msgValNo','msgAgentePositivo','msgAgenteQueja','msgAgentePregunta','msgAgenteDefecto','ga4PropertyId','ga4CredentialsPath'
  ].forEach(k=>{if(req.body[k]!==undefined)config[k]=req.body[k];});
  // Normalizar max de cada franja como entero
  if (Array.isArray(config.val_horas)) {
    config.val_horas = config.val_horas.map(f =>
      typeof f === 'string' ? { hora: f, max: 8 } : { hora: f.hora, max: parseInt(f.max) || 8 }
    );
    // val_maxPorDia = suma de los max individuales (informativo)
    config.val_maxPorDia = config.val_horas.reduce((s, f) => s + f.max, 0);
  } else {
    ['val_maxPorDia'].forEach(k=>config[k]=parseInt(config[k]));
  }
  ['cita_maxPorDia','delayMinSeg','delayMaxSeg','numResenias'].forEach(k=>config[k]=parseInt(config[k]));
  ['val_activo','cita_activo','bloquearFinde','flujoSiNo','flujoSiNo_cita','flujoSiNo_val','abTracking'].forEach(k=>config[k]=Boolean(config[k]));
  programarCrons();
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

// Endpoint de prueba: envía el mensaje Y activa el flujo SÍ/NO real para ese número
app.post('/api/prueba',async(req,res)=>{
  const { telefono, mensaje, mod, nombre, variante, fecha, hora, trat } = req.body;
  if (!telefono || !mensaje || !mod) return res.status(400).json({ error: 'Faltan datos' });
  const tel = telLimpio(telefono);
  try {
    await enviarMensaje(tel, mensaje);
    const flujoActivoCita = config.flujoSiNo_cita ?? config.flujoSiNo;
    const flujoActivoVal  = config.flujoSiNo_val;
    if (mod === 'cita' && flujoActivoCita) {
      esperandoRespuesta.set(tel, { mod: 'cita', nombre: nombre || 'Prueba', fecha: fecha || null, hora: hora || '', trat: trat || '', ts: Date.now() });
      guardarEsperando();
      console.log(`🧪 PRUEBA cita — flujo SÍ/NO activo para ${tel}`);
    } else if (mod === 'val' && flujoActivoVal) {
      esperandoRespuesta.set(tel, { mod: 'val', nombre: nombre || 'Prueba', variante: variante || 0, fecha: fecha || null, hora: hora || '', trat: trat || '', ts: Date.now() });
      guardarEsperando();
      console.log(`🧪 PRUEBA val — flujo SÍ/NO activo para ${tel}`);
    } else {
      console.log(`🧪 PRUEBA ${mod} — flujo directo (sin interactividad SÍ/NO)`);
    }
    res.json({ ok: true, flujoActivado: (mod === 'cita' && flujoActivoCita) || (mod === 'val' && flujoActivoVal) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
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
  const datos     = fs.existsSync(DATA_FILE)      ? fs.readFileSync(DATA_FILE,      'utf8') : '{}';
  const cola      = fs.existsSync(COLA_FILE)      ? fs.readFileSync(COLA_FILE,      'utf8') : '[]';
  const cfg       = fs.existsSync(CONFIG_FILE)    ? fs.readFileSync(CONFIG_FILE,    'utf8') : '{}';
  const leads     = fs.existsSync(LEADS_FILE)     ? fs.readFileSync(LEADS_FILE,     'utf8') : '{"cita":[],"val":[]}';
  const yaEnviado = fs.existsSync(YAENVIADO_FILE) ? fs.readFileSync(YAENVIADO_FILE, 'utf8') : '{}';
  return { datos, cola, config: cfg, leads, yaEnviado };
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
    if (obj.datos)      fs.writeFileSync(DATA_FILE,      JSON.stringify(JSON.parse(obj.datos),      null, 2));
    if (obj.cola)       fs.writeFileSync(COLA_FILE,      JSON.stringify(JSON.parse(obj.cola),       null, 2));
    if (obj.config)     fs.writeFileSync(CONFIG_FILE,    JSON.stringify(JSON.parse(obj.config),     null, 2));
    if (obj.leads)      fs.writeFileSync(LEADS_FILE,     JSON.stringify(JSON.parse(obj.leads),      null, 2));
    if (obj.yaEnviado)  fs.writeFileSync(YAENVIADO_FILE, JSON.stringify(JSON.parse(obj.yaEnviado),  null, 2));
  } else if (obj.enviados || obj.listaNegra) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2));
  } else {
    throw new Error('Formato no reconocido');
  }
  // Recargar config y yaEnviadoHoy en memoria
  const cfg = cargarConfigDisco();
  Object.assign(config, CONFIG_DEFAULT, cfg);
  cargarYaEnviado(); // restaurar estado de envíos del día si el backup lo incluye
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
  const nombre   = path.basename(req.params.nombre); // SECURITY: solo el nombre, sin ruta
  const filePath = path.join(BACKUP_DIR, nombre);
  // Doble verificación de seguridad (Defense in Depth)
  if (!filePath.startsWith(BACKUP_DIR)) return res.status(403).json({ error: 'Acceso denegado' });
  if (!fs.existsSync(filePath))         return res.status(404).json({ error: 'No encontrado' });
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

// Cron backup cada hora — usa la misma constante TIMEZONE que el resto del servidor
cron.schedule('0 * * * *', backupAutomatico, { timezone: TIMEZONE });
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
  const { propertyId, credentialsPath, measurementId, apiSecret } = req.body;
  if (!propertyId || !credentialsPath) return res.status(400).json({ error: 'Faltan datos' });
  const credPath = path.isAbsolute(credentialsPath) ? credentialsPath : path.join(__dirname, credentialsPath);
  if (!fs.existsSync(credPath)) return res.status(400).json({ error: `Archivo no encontrado: ${credPath}` });
  config.ga4PropertyId      = String(propertyId).replace('properties/','').trim();
  config.ga4CredentialsPath = credentialsPath.trim();
  // Measurement Protocol (opcional — habilita eventos desde backend)
  if (measurementId) config.ga4MeasurementId = measurementId.trim();
  if (apiSecret)     config.ga4ApiSecret     = apiSecret.trim();
  guardarConfigDisco(config);
  const mpActivo = !!(config.ga4MeasurementId && config.ga4ApiSecret);
  console.log(`📡 GA4 configurado — Property: ${config.ga4PropertyId} | MP: ${mpActivo ? '✅' : '⚠️ sin Measurement Protocol'}`);
  res.json({ ok: true, measurementProtocol: mpActivo });
});

// ── ARRANQUE ──────────────────────────────────────────────────────────────────
// Servir estáticos DESPUÉS de todas las rutas API para que no intercepten
app.use(express.static(__dirname));

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
