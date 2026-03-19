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

// ── CONFIG ────────────────────────────────────────────────────────────────────
const PORT      = 3001;
const DATA_FILE = path.join(__dirname, 'data.json');
const COLA_FILE = path.join(__dirname, 'cola.json');

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
  flujoSiNo:      true,  // true = pide SÍ/NO y manda enlace automático
  abTracking:     true,  // registra variante enviada + clics por UTM
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

// Pendientes SÍ/NO: tel → { nombre, variante, ts }
const esperandoRespuesta = new Map();

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

// ── UTILS ─────────────────────────────────────────────────────────────────────
function hoy() { return new Date().toISOString().split('T')[0]; }
function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }
function jid(tel) { return `${tel}@s.whatsapp.net`; }
function telLimpio(t) { return String(t).replace(/\D/g,'').replace(/^34/,'').slice(-9); }

function esFinde() {
  const d = new Date().toLocaleString('es-ES',{weekday:'long',timeZone:'Europe/Madrid'}).toLowerCase();
  return d==='sábado'||d==='domingo';
}

function horaSegunDia() {
  const s = new Date().toLocaleString('en-US',{weekday:'short',timeZone:'Europe/Madrid'});
  const m = {Mon:1,Tue:2,Wed:3,Thu:4,Fri:5};
  return (config.horariosVal?.[m[s]]) || '10:30';
}

function resetarContadoresSiNuevoDia() {
  if (fechaConteo!==hoy()) { enviosHoyVal=0; enviosHoyCita=0; fechaConteo=hoy(); }
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

  // CTA fijo — neutro, sin presuponer experiencia negativa, instrucción clarísima
  const cta = `👇 ¿Nos cuentas? Responde *SÍ* o *NO* y en un momento te escribimos`;

  if (config.flujoSiNo) {
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
  return [`Gracias por contestar, ${nombre} 🙏`, ``, `Si en algún momento quieres comentarnos algo, estamos aquí. ¡Hasta pronto!`].join('\n');
}

// Recordatorio de cita — gancho en primera línea para la push notification
function construirMsgCita(p) {
  const nombre   = p.nombre.split(' ')[0];
  const hora     = p.hora ? ` a las *${p.hora}*` : '';
  const fechaTxt = p.fecha ? `*${fmtFecha(p.fecha)}*` : 'próximamente';
  return [
    `Tu cita es ${fechaTxt}${hora} — ¿lo confirmas, ${nombre}? ✅`,
    ``,
    `Te lo recordamos desde *${CLINICA}* 😊`,
    ``,
    `Si necesitas cambiarla o cancelarla, avísanos con tiempo — así podemos ofrecerle el hueco a otro paciente 🙏`,
    ``,
    `Responde *SÍ* para confirmar o escríbenos si necesitas cambiarla.`,
  ].join('\n');
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
function procesarRespuesta(remitente, texto) {
  const tel = remitente.replace('@s.whatsapp.net','').replace(/^34/,'');
  if (!esperandoRespuesta.has(tel)) return;

  const t = texto.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  const { nombre, variante } = esperandoRespuesta.get(tel);

  const esSi = ['si','yes','s','1','ok','dale','bueno','claro','por supuesto','adelante'].some(w=>t===w||t.startsWith(w+' '));
  const esNo = ['no','nope','n','0'].some(w=>t===w||t.startsWith(w+' '));

  if (esSi) {
    enviarMensaje(tel, construirMsgEnlace(nombre, variante)).catch(console.error);
    esperandoRespuesta.delete(tel);
    console.log(`✅ SÍ de ${nombre} (${tel}) — enlace V${variante} enviado`);
  } else if (esNo) {
    enviarMensaje(tel, construirMsgRespuestaNo(nombre)).catch(console.error);
    esperandoRespuesta.delete(tel);
    console.log(`🚫 NO de ${nombre} (${tel})`);
  }
}

// ── PROCESAR COLA ─────────────────────────────────────────────────────────────
let colaActiva = false;

async function procesarCola(modFiltro = null) {
  if (colaActiva) return;
  if (config.bloquearFinde && esFinde()) {
    console.log(`🚫 Fin de semana — envíos bloqueados`); return;
  }

  colaActiva = true;
  resetarContadoresSiNuevoDia();

  const cola  = cargarCola();
  const datos = cargarDatos();
  const lb    = new Set((datos.listaNegra||[]).map(e=>e.tel||e));

  let pendientes = cola.filter(p=>!p.enviado&&!lb.has(p.tel)&&!datos.enviados[p.tel]?.[p.mod]);
  if (modFiltro) pendientes = pendientes.filter(p=>p.mod===modFiltro);
  if (!pendientes.length) { console.log(`✅ Cola vacía`); colaActiva=false; return; }

  let cV=0, cC=0;
  const aEnviar = pendientes.filter(p=>{
    if (p.mod==='val'  && cV<(config.val_maxPorDia -enviosHoyVal )) { cV++;  return true; }
    if (p.mod==='cita' && cC<(config.cita_maxPorDia-enviosHoyCita)) { cC++;  return true; }
    return false;
  });
  if (!aEnviar.length) { console.log(`⛔ Límite diario alcanzado`); colaActiva=false; return; }

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

      // SÍ/NO: guardar para respuesta automática (con variante para el UTM)
      if (p.mod==='val' && config.flujoSiNo) {
        esperandoRespuesta.set(p.tel, { nombre:p.nombre, variante:varianteIdx, ts:Date.now() });
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

  // Limpiar esperandoRespuesta > 48h
  const lim = Date.now()-48*3600000;
  for (const [tel,d] of esperandoRespuesta.entries()) if(d.ts<lim) esperandoRespuesta.delete(tel);

  colaActiva=false;
  console.log(`🏁 val:${enviosHoyVal}/${config.val_maxPorDia} | cita:${enviosHoyCita}/${config.cita_maxPorDia}`);
}

// ── CRON ──────────────────────────────────────────────────────────────────────
function programarCrons() {
  if (cronJobVal)  { cronJobVal.destroy();  cronJobVal=null; }
  if (cronJobCita) { cronJobCita.destroy(); cronJobCita=null; }
  const opts = { timezone:'Europe/Madrid' };

  if (config.val_activo) {
    // Cada 5 min en horario de oficina — comprueba si es la hora exacta del día
    cronJobVal = cron.schedule('*/5 8-13 * * 1-5', async () => {
      const ahora  = new Date().toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit',hour12:false,timeZone:'Europe/Madrid'});
      if (ahora !== horaSegunDia()) return;
      console.log(`\n🕐 CRON VALORACIÓN (${ahora})`);
      if (estadoWA==='conectado') await procesarCola('val');
    }, opts);
    console.log(`⏰ Valoraciones: L/X:10:30 M/J:11:00 V:10:00`);
  }

  if (config.cita_activo) {
    const [h,m] = config.cita_horaEnvio.split(':').map(Number);
    cronJobCita = cron.schedule(`${m} ${h} * * 1-5`, async () => {
      console.log(`\n🕐 CRON CITA (${config.cita_horaEnvio})`);
      if (estadoWA==='conectado') await procesarCola('cita');
    }, opts);
    console.log(`⏰ Recordatorios: L-V a las ${config.cita_horaEnvio}`);
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

  // Escuchar SÍ/NO
  sock.ev.on('messages.upsert', async ({messages,type})=>{
    if(type!=='notify')return;
    const msg=messages[0];
    if(msg.key.fromMe||!msg.message)return;
    const rem=msg.key.remoteJid;
    if(!rem.endsWith('@s.whatsapp.net'))return;
    const txt=msg.message?.conversation||msg.message?.extendedTextMessage?.text||'';
    if(txt.trim()) procesarRespuesta(rem,txt);
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
   'delayMinSeg','delayMaxSeg','bloquearFinde','numResenias','flujoSiNo','abTracking'
  ].forEach(k=>{if(req.body[k]!==undefined)config[k]=req.body[k];});
  ['val_maxPorDia','cita_maxPorDia','delayMinSeg','delayMaxSeg','numResenias'].forEach(k=>config[k]=parseInt(config[k]));
  ['val_activo','cita_activo','bloquearFinde','flujoSiNo','abTracking'].forEach(k=>config[k]=Boolean(config[k]));
  programarCrons();
  res.json({ok:true,config});
});

// A/B stats — muestra envíos internos. Clics reales → GA4
app.get('/api/ab-stats',(req,res)=>{
  const d=cargarDatos();
  const stats=Object.entries(d.abStats||{}).map(([k,v])=>({
    variante:k, gancho:ganchos('Paciente','esta mañana')[parseInt(k.replace('v',''))],
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

app.post('/api/cola/añadir',(req,res)=>{
  const pacientes=req.body.pacientes;
  if(!Array.isArray(pacientes)||!pacientes.length) return res.status(400).json({error:'Array requerido'});
  const cola=cargarCola(); const d=cargarDatos(); let nuevos=0;
  pacientes.forEach(p=>{
    const tel=telLimpio(p.tel); if(!tel||!/^\d{9}$/.test(tel))return;
    const mod=p.mod||'val';
    if(cola.some(c=>c.tel===tel&&c.mod===mod&&!c.enviado))return;
    if(d.enviados[tel]?.[mod])return;
    cola.push({nombre:p.nombre,tel,fecha:p.fecha||null,hora:p.hora||'',trat:p.trat||'',mod,enviado:false,añadido:new Date().toISOString()});
    nuevos++;
  });
  guardarCola(cola);
  res.json({ok:true,añadidos:nuevos});
});

app.delete('/api/cola/limpiar',(req,res)=>{
  const mod=req.query.mod;
  guardarCola(mod?cargarCola().filter(p=>p.enviado||p.mod!==mod):[]);
  res.json({ok:true});
});

app.post('/api/cola/enviar-ahora',async(req,res)=>{
  if(estadoWA!=='conectado')return res.status(503).json({error:'WhatsApp no conectado'});
  if(config.bloquearFinde&&esFinde())return res.status(403).json({error:'Fin de semana bloqueado'});
  const mod=req.body?.mod||null;
  res.json({ok:true,mensaje:`Procesando cola${mod?' ('+mod+')':''}...`});
  procesarCola(mod).catch(console.error);
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

// ── ARRANQUE ──────────────────────────────────────────────────────────────────
app.listen(PORT,()=>{
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  Avance Dental — WhatsApp v4         ║`);
  console.log(`║  http://localhost:${PORT}               ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
  programarCrons();
  conectar().catch(console.error);
});

process.on('uncaughtException', e=>console.error('💥',e));
process.on('unhandledRejection',e=>console.error('💥',e));
