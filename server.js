/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║  AVANCE DENTAL — Servidor WhatsApp con Baileys           ║
 * ║  Envíos programados, cola con delay, API REST            ║
 * ╚══════════════════════════════════════════════════════════╝
 */

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState
} = require('@whiskeysockets/baileys');
const { Boom }   = require('@hapi/boom');
const P          = require('pino');
const express    = require('express');
const cors       = require('cors');
const cron       = require('node-cron');
const fs         = require('fs');
const path       = require('path');

// ── CONFIGURACIÓN ─────────────────────────────────────────────────────────────
const PORT = 3001;
const DATA_FILE = path.join(__dirname, 'data.json');
const COLA_FILE = path.join(__dirname, 'cola.json');

const CONFIG_DEFAULT = {
  // ── Pedir valoración ──
  val_horaEnvio:  '10:00',  // hora de envío automático diario
  val_maxPorDia:  30,       // máximo mensajes de valoración por día
  val_activo:     true,     // activar/desactivar cron valoración

  // ── Recordar cita ──
  cita_horaEnvio: '09:00',  // hora de envío automático diario
  cita_maxPorDia: 50,       // máximo mensajes de recordatorio por día
  cita_activo:    true,     // activar/desactivar cron recordatorios

  // ── Compartidos ──
  delayMinSeg:    8,        // segundos mínimos entre mensaje y mensaje
  delayMaxSeg:    20,       // segundos máximos entre mensaje y mensaje
  bloquearFinde:  true,     // NO enviar sábado ni domingo
};

// ── ESTADO ────────────────────────────────────────────────────────────────────
let sockGlobal    = null;
let estadoWA      = 'desconectado';
let qrActual      = null;
let config        = { ...CONFIG_DEFAULT };
let cronJobVal    = null;
let cronJobCita   = null;
let enviosHoyVal  = 0;
let enviosHoyCita = 0;
let fechaConteo   = hoy();

// ── PERSISTENCIA ──────────────────────────────────────────────────────────────
function cargarDatos() {
  if (!fs.existsSync(DATA_FILE)) return { enviados: {}, listaNegra: [] };
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return { enviados: {}, listaNegra: [] }; }
}
function guardarDatos(datos) { fs.writeFileSync(DATA_FILE, JSON.stringify(datos, null, 2)); }
function cargarCola() {
  if (!fs.existsSync(COLA_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(COLA_FILE, 'utf8')); }
  catch { return []; }
}
function guardarCola(cola) { fs.writeFileSync(COLA_FILE, JSON.stringify(cola, null, 2)); }

// ── UTILS ─────────────────────────────────────────────────────────────────────
function hoy() { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jid(tel) { return `${tel}@s.whatsapp.net`; }
function telLimpio(t) { return String(t).replace(/\D/g, '').replace(/^34/, '').slice(-9); }

function esFinde() {
  const dia = new Date().toLocaleString('es-ES', { weekday: 'long', timeZone: 'Europe/Madrid' }).toLowerCase();
  return dia === 'sábado' || dia === 'domingo';
}

function resetarContadoresSiNuevoDia() {
  if (fechaConteo !== hoy()) {
    enviosHoyVal  = 0;
    enviosHoyCita = 0;
    fechaConteo   = hoy();
  }
}

// ── MENSAJES ──────────────────────────────────────────────────────────────────
const CLINICA     = 'Avance Dental';
const LANDING_URL        = 'https://avancedental74.github.io/citas/opinion.html';
const GOOGLE_REVIEW_URL  = 'https://g.page/r/CRkkiSExZLnnEAE/review'; // URL corta Google
const TRAT_DIFICIL = ['endodoncia','extraccion','extracción','implante','cirugia',
  'cirugía','periodoncia','curetaje','injerto','ortodoncia','aparato','brackets'];

function esDificil(trat) {
  if (!trat) return false;
  const t = trat.toLowerCase();
  return TRAT_DIFICIL.some(k => t.includes(k));
}

function fmtFecha(fecha) {
  if (!fecha) return '';
  const f = new Date(fecha);
  if (isNaN(f)) return '';
  return f.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
}

function ventanaTemporal(fecha) {
  if (!fecha) return null;
  const hoyD = new Date(); hoyD.setHours(0,0,0,0);
  const ayer  = new Date(hoyD); ayer.setDate(ayer.getDate()-1);
  const f     = new Date(fecha); f.setHours(0,0,0,0);
  if (f.getTime() === hoyD.getTime()) return 'de hoy';
  if (f.getTime() === ayer.getTime()) return 'de ayer';
  return `del ${f.toLocaleDateString('es-ES',{day:'numeric',month:'long'})}`;
}

function construirMsgVal(p) {
  const nombre  = p.nombre.split(' ')[0];
  const fechaTxt = p.fecha ? fmtFecha(p.fecha) : null;
  const ventana  = ventanaTemporal(p.fecha);
  const dificil  = esDificil(p.trat);
  const trat     = p.trat ? ` de *${p.trat.toLowerCase()}*` : '';
  const cuando   = fechaTxt ? `el *${fechaTxt}*` : (ventana ? ventana : 'recientemente');

  // ── TRATAMIENTO DIFÍCIL — más empático, reseña como cierre natural ──────────
  if (dificil) {
    const variantes = [
      [
        `Hola ${nombre} 🙏`,
        ``,
        `Sabemos que${trat ? ` una${trat}` : ' tu última visita'} no es de las más sencillas. Esperamos que te hayas recuperado bien y que el resultado esté siendo el que esperabas.`,
        ``,
        `Si quedaste contento/a con la atención, una reseña tuya vale muchísimo para otras familias que buscan un dentista de confianza 💙`,
        ``,
        `👉 Déjanos tu opinión aquí:`,
        GOOGLE_REVIEW_URL,
        ``,
        `¡Muchas gracias, ${nombre}! 🌟`,
      ],
      [
        `Hola ${nombre} 💙`,
        ``,
        `¿Cómo estás tras${trat ? ` la${trat}` : ' tu visita'}? Esperamos que la recuperación esté yendo bien 🙏`,
        ``,
        `Si tu experiencia en *${CLINICA}* fue buena, ¿nos regalas un momento? Tu reseña orienta a muchas familias que buscan un dentista de confianza.`,
        ``,
        `👉 Pulsa aquí para dejar tu opinión:`,
        GOOGLE_REVIEW_URL,
        ``,
        `¡Gracias de corazón, ${nombre}! ⭐`,
      ],
    ];
    return variantes[parseInt(p.tel.slice(-1)) % variantes.length].join('\n');
  }

  // ── MENSAJES NORMALES — 4 variantes rotativas ────────────────────────────────
  // Principios de CTR aplicados en cada variante:
  // ✅ Nombre al inicio Y al cierre (personalización doble +15% CTR)
  // ✅ CTA en línea propia con 👉 (el ojo lo encuentra solo)
  // ✅ URL corta de Google directa (no dominio desconocido)
  // ✅ Pregunta condicional antes del CTA (activa el "sí" interno)
  // ✅ "otras familias" en vez de "otras personas" (más emocional)
  // ✅ CTA específico: "2 clics" / "30 segundos" (más creíble que "1 minuto")

  const variantes = [
    // V0 — Directa + cálida + condicional
    [
      `Hola ${nombre} 😊`,
      ``,
      `Te atendimos ${cuando} en *${CLINICA}*${trat}. Esperamos que todo haya ido de maravilla.`,
      ``,
      `Si quedaste contento/a con la atención, ¿nos regalas un momento? Tu opinión ayuda a otras familias a encontrar un dentista de confianza 🙏`,
      ``,
      `👉 Déjanos tu reseña aquí:`,
      GOOGLE_REVIEW_URL,
      ``,
      `¡Gracias de corazón, ${nombre}! 🌟`,
    ],
    // V1 — Pregunta abierta + "2 clics" (concreto y creíble)
    [
      `Hola ${nombre} 👋`,
      ``,
      `¿Cómo estás tras tu visita ${cuando} en *${CLINICA}*${trat}?`,
      ``,
      `Si todo fue bien, una reseña tuya es el mejor regalo que puedes hacernos — y ayuda a otras familias a elegir bien 🦷`,
      ``,
      `👉 Aquí, son solo 2 clics:`,
      GOOGLE_REVIEW_URL,
      ``,
      `¡Muchas gracias, ${nombre}! 😊`,
    ],
    // V2 — Social proof + CTA con tiempo concreto
    [
      `Hola ${nombre} 😄`,
      ``,
      `Fue un placer atenderte ${cuando} en *${CLINICA}*${trat}. Esperamos que estés encantado/a con el resultado.`,
      ``,
      `Muchos pacientes nos encuentran gracias a las reseñas de personas como tú. ¿Nos ayudas con la tuya? 🌟`,
      ``,
      `👉 Tu opinión en Google (30 segundos):`,
      GOOGLE_REVIEW_URL,
      ``,
      `¡Te lo agradecemos un montón, ${nombre}! 🙌`,
    ],
    // V3 — Conversacional + reciprocidad + CTA directo
    [
      `Hola ${nombre} 👋`,
      ``,
      `Desde *${CLINICA}* queríamos saber cómo estás después de tu visita ${cuando}${trat}.`,
      ``,
      `Si tu experiencia fue buena, ¿nos dejas una reseña en Google? Con eso nos ayudas muchísimo y orientas a otras familias que buscan un buen dentista 🙏`,
      ``,
      `👉 Pulsa aquí para dejar tu opinión:`,
      GOOGLE_REVIEW_URL,
      ``,
      `¡Gracias de verdad, ${nombre}! ⭐`,
    ],
  ];

  const idx = parseInt(p.tel.slice(-1)) % variantes.length;
  return variantes[idx].join('\n');
}

function construirMsgCita(p) {
  const nombre   = p.nombre.split(' ')[0];
  const hora     = p.hora ? ` a las *${p.hora}*` : '';
  const trat     = p.trat ? ` de ${p.trat.toLowerCase()}` : '';
  const fechaTxt = p.fecha ? `*${fmtFecha(p.fecha)}*` : 'próximamente';
  return [`Hola ${nombre} 👋`, ``, `Te escribimos desde *${CLINICA}* para recordarte tu cita${trat} el ${fechaTxt}${hora}.`, ``, `Si necesitas cambiarla o cancelarla, avísanos con tiempo — así podemos ofrecerle el hueco a otro paciente 🙏`, ``, `¿Nos confirmas que todo sigue bien? ✅`].join('\n');
}

// ── ENVÍO INDIVIDUAL ──────────────────────────────────────────────────────────
async function enviarMensaje(telefono, texto) {
  if (!sockGlobal || estadoWA !== 'conectado') throw new Error('WhatsApp no conectado');
  const j = jid(telefono.startsWith('34') ? telefono : '34' + telefono);
  const [info] = await sockGlobal.onWhatsApp(j).catch(() => [null]);
  if (!info?.exists) throw new Error('Número sin WhatsApp: ' + telefono);
  await sockGlobal.sendPresenceUpdate('composing', j);
  await sleep(1000 + Math.random() * 2000);
  await sockGlobal.sendPresenceUpdate('paused', j);
  await sockGlobal.sendMessage(j, { text: texto });
  return true;
}

// ── PROCESAR COLA ─────────────────────────────────────────────────────────────
let colaActiva = false;

async function procesarCola(modFiltro = null) {
  if (colaActiva) { console.log('⚠️  Cola ya en proceso, saltando'); return; }

  // Bloquear finde si está activado
  if (config.bloquearFinde && esFinde()) {
    const dia = new Date().toLocaleString('es-ES', { weekday: 'long', timeZone: 'Europe/Madrid' });
    console.log(`🚫 Hoy es ${dia} — envíos bloqueados en fin de semana`);
    return;
  }

  colaActiva = true;
  resetarContadoresSiNuevoDia();

  const cola  = cargarCola();
  const datos = cargarDatos();
  const lb    = new Set((datos.listaNegra || []).map(e => e.tel || e));

  let pendientes = cola.filter(p => !p.enviado && !lb.has(p.tel) && !datos.enviados[p.tel]?.[p.mod]);
  if (modFiltro) pendientes = pendientes.filter(p => p.mod === modFiltro);

  if (!pendientes.length) {
    console.log(`✅ Cola${modFiltro?' ('+modFiltro+')':''} vacía, nada que enviar`);
    colaActiva = false; return;
  }

  // Calcular cuántos podemos enviar según límites por módulo
  const disponiblesVal  = config.val_maxPorDia  - enviosHoyVal;
  const disponiblesCita = config.cita_maxPorDia - enviosHoyCita;

  const pendientesConLimite = pendientes.filter(p => {
    if (p.mod === 'val')  return disponiblesVal  > 0;
    if (p.mod === 'cita') return disponiblesCita > 0;
    return true;
  });

  if (!pendientesConLimite.length) {
    console.log(`⛔ Límite diario alcanzado (val:${enviosHoyVal}/${config.val_maxPorDia}, cita:${enviosHoyCita}/${config.cita_maxPorDia})`);
    colaActiva = false; return;
  }

  // Respeta límite por módulo
  let countVal = 0, countCita = 0;
  const aEnviar = pendientesConLimite.filter(p => {
    if (p.mod === 'val'  && countVal  < disponiblesVal)  { countVal++;  return true; }
    if (p.mod === 'cita' && countCita < disponiblesCita) { countCita++; return true; }
    return false;
  });

  console.log(`📤 Procesando ${aEnviar.length} mensajes (${countVal} valoraciones, ${countCita} recordatorios)...`);

  for (let i = 0; i < aEnviar.length; i++) {
    const p   = aEnviar[i];
    const msg = p.mod === 'val' ? construirMsgVal(p) : construirMsgCita(p);

    try {
      await enviarMensaje(p.tel, msg);
      if (!datos.enviados[p.tel]) datos.enviados[p.tel] = {};
      datos.enviados[p.tel][p.mod] = hoy();
      datos.enviados[p.tel].nombre = p.nombre;
      datos.enviados[p.tel].trat   = p.trat || '';
      guardarDatos(datos);
      p.enviado    = true;
      p.fechaEnvio = new Date().toISOString();
      guardarCola(cola);
      if (p.mod === 'val')  enviosHoyVal++;
      if (p.mod === 'cita') enviosHoyCita++;
      console.log(`✅ [${i+1}/${aEnviar.length}] ${p.mod.toUpperCase()} → ${p.nombre} (${p.tel})`);
      if (i < aEnviar.length - 1) {
        const delay = (config.delayMinSeg + Math.random() * (config.delayMaxSeg - config.delayMinSeg)) * 1000;
        console.log(`⏳ Esperando ${(delay/1000).toFixed(1)}s...`);
        await sleep(delay);
      }
    } catch (err) {
      console.error(`❌ Error → ${p.nombre} (${p.tel}):`, err.message);
      p.error = err.message;
      guardarCola(cola);
    }
  }

  colaActiva = false;
  console.log(`🏁 Listo. Enviados hoy — val:${enviosHoyVal}/${config.val_maxPorDia} | cita:${enviosHoyCita}/${config.cita_maxPorDia}`);
}

// ── CRON ──────────────────────────────────────────────────────────────────────
function programarCrons() {
  // Destruir anteriores
  if (cronJobVal)  { cronJobVal.destroy();  cronJobVal  = null; }
  if (cronJobCita) { cronJobCita.destroy(); cronJobCita = null; }

  const opts = { timezone: 'Europe/Madrid' };

  // Cron valoraciones (L-V)
  if (config.val_activo) {
    const [hV, mV] = config.val_horaEnvio.split(':').map(Number);
    // node-cron: 1-5 = lunes a viernes
    cronJobVal = cron.schedule(`${mV} ${hV} * * 1-5`, async () => {
      console.log(`\n🕐 CRON VALORACIÓN — ${new Date().toLocaleTimeString('es-ES')}`);
      if (estadoWA === 'conectado') await procesarCola('val');
      else console.log('⚠️  WhatsApp desconectado, cron saltado');
    }, opts);
    console.log(`⏰ Cron VALORACIÓN: L-V a las ${config.val_horaEnvio}`);
  }

  // Cron recordatorios (L-V)
  if (config.cita_activo) {
    const [hC, mC] = config.cita_horaEnvio.split(':').map(Number);
    cronJobCita = cron.schedule(`${mC} ${hC} * * 1-5`, async () => {
      console.log(`\n🕐 CRON RECORDATORIO — ${new Date().toLocaleTimeString('es-ES')}`);
      if (estadoWA === 'conectado') await procesarCola('cita');
      else console.log('⚠️  WhatsApp desconectado, cron saltado');
    }, opts);
    console.log(`⏰ Cron RECORDATORIO: L-V a las ${config.cita_horaEnvio}`);
  }

  if (!config.val_activo && !config.cita_activo) console.log('⏸  Envíos automáticos desactivados');
}

// ── BAILEYS ───────────────────────────────────────────────────────────────────
async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_avancedental');
  const sock = makeWASocket({
    auth: state, printQRInTerminal: true,
    logger: P({ level: 'silent' }),
    browser: ['Chrome (Linux)', 'Chrome', '122.0.6261.94'],
    generateHighQualityLinkPreview: false,
    defaultQueryTimeoutMs: 30000,
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) { qrActual = qr; estadoWA = 'qr'; console.log('📱 QR disponible en la app'); }
    if (connection === 'open') {
      estadoWA = 'conectado'; qrActual = null; sockGlobal = sock;
      console.log('✅ WhatsApp conectado');
    }
    if (connection === 'close') {
      estadoWA = 'desconectado'; sockGlobal = null;
      const reconectar = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut : true;
      if (reconectar) { console.log('🔄 Reconectando en 5s...'); setTimeout(conectar, 5000); }
      else console.log('🚪 Sesión cerrada. Borra ./auth_avancedental y reinicia.');
    }
  });
  sock.ev.on('creds.update', saveCreds);
  return sock;
}

// ── EXPRESS API ───────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(__dirname));

app.get('/api/status', (req, res) => {
  const diaActual = new Date().toLocaleString('es-ES', { weekday: 'long', timeZone: 'Europe/Madrid' }).toLowerCase();
  const esFin = diaActual === 'sábado' || diaActual === 'domingo';
  res.json({
    estado: estadoWA, qr: estadoWA === 'qr' ? qrActual : null,
    enviosHoyVal, enviosHoyCita, config,
    esFinDeSemana: esFin, diaActual,
  });
});

app.get('/api/config', (req, res) => res.json(config));
app.post('/api/config', (req, res) => {
  const campos = ['val_horaEnvio','val_maxPorDia','val_activo','cita_horaEnvio','cita_maxPorDia','cita_activo','delayMinSeg','delayMaxSeg','bloquearFinde'];
  campos.forEach(k => { if (req.body[k] !== undefined) config[k] = req.body[k]; });
  // Asegurar tipos numéricos/booleanos
  ['val_maxPorDia','cita_maxPorDia','delayMinSeg','delayMaxSeg'].forEach(k => config[k] = parseInt(config[k]));
  ['val_activo','cita_activo','bloquearFinde'].forEach(k => config[k] = Boolean(config[k]));
  programarCrons();
  res.json({ ok: true, config });
});

app.get('/api/cola', (req, res) => {
  const cola  = cargarCola();
  const datos = cargarDatos();
  const lb    = new Set((datos.listaNegra || []).map(e => e.tel || e));
  const pendientes = cola.filter(p => !p.enviado && !lb.has(p.tel) && !datos.enviados[p.tel]?.[p.mod]);
  res.json({
    total: cola.length,
    pendientes: pendientes.length,
    pendientesVal:  pendientes.filter(p=>p.mod==='val').length,
    pendientesCita: pendientes.filter(p=>p.mod==='cita').length,
    cola
  });
});

app.post('/api/cola/añadir', (req, res) => {
  const pacientes = req.body.pacientes;
  if (!Array.isArray(pacientes) || !pacientes.length)
    return res.status(400).json({ error: 'Se esperaba array de pacientes' });
  const cola  = cargarCola();
  const datos = cargarDatos();
  let nuevos  = 0;
  pacientes.forEach(p => {
    const tel = telLimpio(p.tel);
    if (!tel || !/^\d{9}$/.test(tel)) return;
    const mod = p.mod || 'val';
    if (cola.some(c => c.tel === tel && c.mod === mod && !c.enviado)) return;
    if (datos.enviados[tel]?.[mod]) return;
    cola.push({ nombre: p.nombre, tel, fecha: p.fecha||null, hora: p.hora||'', trat: p.trat||'', mod, enviado: false, añadido: new Date().toISOString() });
    nuevos++;
  });
  guardarCola(cola);
  res.json({ ok: true, añadidos: nuevos, total: cola.length });
});

app.delete('/api/cola/limpiar', (req, res) => {
  const mod = req.query.mod;
  if (mod) {
    const cola = cargarCola().filter(p => p.enviado || p.mod !== mod);
    guardarCola(cola);
  } else { guardarCola([]); }
  res.json({ ok: true });
});

app.post('/api/cola/enviar-ahora', async (req, res) => {
  if (estadoWA !== 'conectado') return res.status(503).json({ error: 'WhatsApp no conectado' });
  if (config.bloquearFinde && esFinde()) return res.status(403).json({ error: 'Hoy es fin de semana — envíos bloqueados. Desactiva la opción si quieres enviar igualmente.' });
  const mod = req.body?.mod || null;
  res.json({ ok: true, mensaje: `Procesando cola${mod?' ('+mod+')':''} en segundo plano...` });
  procesarCola(mod).catch(console.error);
});

app.post('/api/enviar', async (req, res) => {
  const { telefono, mensaje } = req.body;
  if (!telefono || !mensaje) return res.status(400).json({ error: 'Faltan datos' });
  const tel = telLimpio(telefono);
  try { await enviarMensaje(tel, mensaje); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/historial', (req, res) => {
  const datos = cargarDatos();
  const lista = Object.entries(datos.enviados || {}).map(([tel, d]) => ({ tel, ...d }));
  lista.sort((a, b) => (b.val || b.cita || '').localeCompare(a.val || a.cita || ''));
  res.json(lista);
});

app.delete('/api/historial/:tel', (req, res) => {
  const { tel } = req.params;
  const { mod } = req.query;
  const datos = cargarDatos();
  if (!datos.enviados[tel]) return res.status(404).json({ error: 'No encontrado' });
  if (mod) {
    delete datos.enviados[tel][mod];
    const keys = Object.keys(datos.enviados[tel]).filter(k => !['nombre','trat','modFull'].includes(k));
    if (!keys.length) delete datos.enviados[tel];
  } else { delete datos.enviados[tel]; }
  guardarDatos(datos);
  res.json({ ok: true });
});

app.post('/api/historial/:tel/resetear', (req, res) => {
  const { tel } = req.params;
  const { mod } = req.body;
  const datos = cargarDatos();
  if (datos.enviados[tel]) {
    if (mod) delete datos.enviados[tel][mod];
    else     delete datos.enviados[tel];
  }
  guardarDatos(datos);
  res.json({ ok: true });
});

app.get('/api/listanegra', (req, res) => {
  res.json(cargarDatos().listaNegra || []);
});

app.post('/api/listanegra', (req, res) => {
  const { tel, nombre } = req.body;
  const t = telLimpio(tel);
  if (!t || !/^\d{9}$/.test(t)) return res.status(400).json({ error: 'Teléfono inválido' });
  const datos = cargarDatos();
  if (!datos.listaNegra) datos.listaNegra = [];
  if (!datos.listaNegra.some(e => (e.tel || e) === t))
    datos.listaNegra.push({ tel: t, nombre: nombre || '', bloqueado: hoy() });
  guardarDatos(datos);
  res.json({ ok: true });
});

app.delete('/api/listanegra/:tel', (req, res) => {
  const datos = cargarDatos();
  datos.listaNegra = (datos.listaNegra || []).filter(e => (e.tel || e) !== req.params.tel);
  guardarDatos(datos);
  res.json({ ok: true });
});

app.get('/api/qr', (req, res) => {
  res.json({ qr: estadoWA === 'qr' ? qrActual : null, estado: estadoWA });
});

// ── ARRANQUE ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  Avance Dental — Servidor WhatsApp   ║`);
  console.log(`║  http://localhost:${PORT}               ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
  programarCrons();
  conectar().catch(console.error);
});

process.on('uncaughtException',  err => console.error('💥 Error no capturado:', err));
process.on('unhandledRejection', err => console.error('💥 Promise rechazada:',  err));
