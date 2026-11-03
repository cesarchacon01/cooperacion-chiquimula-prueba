/* =====================================================================
   inteligencia.js  ·  Capa de análisis territorial del visor de cooperación
   ---------------------------------------------------------------------
   Se carga DESPUÉS del script principal de index.html y usa sus datos
   (DATA, mostrarVista, renderMunicipio, parseFecha...). No modifica data.json.
   Para revertir: quitar la línea <script src="inteligencia.js"> de index.html.

   Reglas de integridad que aplica este módulo:
   - Nada se inventa: todo texto sale de contar/agrupar los registros.
   - Los rangos de inversión NO se convierten en montos; solo se cuentan o se
     suman por límites inferior/superior de rangos comparables.
   - Ausencia de registro != ausencia de cooperación.
   - Compartir contraparte o espacio != coordinación efectiva.
   ===================================================================== */
(function(){
'use strict';

/* ---------- Configuración ---------- */
// Los nombres de personas de contacto NO se muestran salvo que se active aquí
// (el formulario no incluye una casilla de autorización de publicación).
const MOSTRAR_CONTACTOS = false;
const MESES_CIERRE = 12;

/* ---------- Utilidades ---------- */
const $ = (s,r)=> (r||document).querySelector(s);
const $$ = (s,r)=> [...(r||document).querySelectorAll(s)];
const esc = v => String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = n => Number(n).toLocaleString('es-GT');
const cmp = (a,b)=> String(a).localeCompare(String(b),'es');
const sinAcento = s => String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();
const uniq = a => [...new Set(a.filter(x=>x!==null&&x!==undefined&&x!==''))];
const plural = (n,s,p)=> n===1?s:(p||s+'s');
const lista = arr => { arr=arr.filter(Boolean); if(arr.length<=1) return arr.join(''); return arr.slice(0,-1).join(', ')+' y '+arr[arr.length-1]; };
const cuenta = (arr,fn)=>{ const o={}; arr.forEach(x=>{ const k=fn(x); if(k!==''&&k!=null) o[k]=(o[k]||0)+1; }); return o; };
const top = (obj,n)=> Object.entries(obj).sort((a,b)=>b[1]-a[1]||cmp(a[0],b[0])).slice(0,n);

let P=[];            // programas
let IDX=0;
const ST = {};       // estado interno: municipio comparados, filtros del directorio, etc.

/* ---------- Normalización de contrapartes ----------
   El campo contraparte_gubernamental es texto libre. Se agrupa por palabras
   clave solo para poder consultar "quién reporta articulación con MAGA".
   El texto original siempre se conserva y se muestra en las fichas. */
const CONTRAPARTES = [
  ['MAGA',                /\bmaga\b|ministerio de agricultura/],
  ['SESAN',               /\bsesan\b|secretaria de seguridad alimentaria/],
  ['MSPAS / Salud pública',/\bmspas\b|ministerio de salud|centro de salud|area de salud|puesto de salud/],
  ['MINEDUC',             /\bmineduc\b|ministerio de educacion|direccion departamental de educacion|\bdideduc\b/],
  ['MARN',                /\bmarn\b|ministerio de ambiente/],
  ['SEGEPLAN',            /\bsegeplan\b/],
  ['CONRED / SE-CONRED',  /\bconred\b|\bseconred\b|\bse-conred\b/],
  ['Municipalidades',     /municipalidad|\balcaldia|\bmunicipal/],
  ['INAB',                /\binab\b|instituto nacional de bosques/],
  ['CONAP',               /\bconap\b/],
  ['MIDES',               /\bmides\b|ministerio de desarrollo social/],
  ['MINECO / Economía',   /\bmineco\b|ministerio de econom/],
  ['MINTRAB / INTECAP',   /\bmintrab\b|\bintecap\b|ministerio de trabajo/],
  ['Gobernación Departamental',/gobernacion/],
  ['Universidades / Academia',/cunori|\busac\b|universidad|academia|epesista/],
  ['Justicia (OJ, MP, PGN)',/justicia|ministerio publico|organismo judicial|\bpgn\b/],
  ['Plan Trifinio',       /trifinio/],
  ['Banca / financiera',  /banrural|\bbanco\b/],
  ['Cruz Roja',           /cruz roja/],
  ['Sector privado',      /sector privado/],
];
const SIN_CONTRAPARTE = /^(no|ninguna?|n\/?a|sin contraparte|-+|\.+)$/;
/* Cada texto se divide en fragmentos (comas, punto y coma, saltos de línea) y cada fragmento se
   clasifica por separado. Lo que no coincide con ninguna sigla conocida NO se descarta: queda en
   "sinClasificar" y se muestra tal cual. El texto original (raw) siempre se conserva. */
function fragmentosContraparte(raw){ return raw.split(/[,;\n]+/).map(s=>s.trim().replace(/^[\s.]+|[\s.]+$/g,'')).filter(Boolean); }
function contrapartesDetalle(p){
  const raw=(p.contraparte_gubernamental||'').trim();
  const t=sinAcento(raw).replace(/[.,;]+$/,'').trim();
  if(!t||SIN_CONTRAPARTE.test(t)) return {raw,canon:[],sinClasificar:[],ninguna:true};
  const canon=[],sin=[];
  fragmentosContraparte(raw).forEach(f=>{
    const ft=sinAcento(f); const hit=CONTRAPARTES.filter(([,re])=>re.test(ft)).map(([n])=>n);
    if(hit.length) hit.forEach(h=>canon.push(h)); else sin.push(f);
  });
  return {raw,canon:uniq(canon),sinClasificar:sin,ninguna:false};
}
function contrapartesDe(p){ const d=contrapartesDetalle(p); const o=[...d.canon]; if(d.sinClasificar.length) o.push('Sin clasificar'); return o; }

/* ---------- Inversión: solo rangos ---------- */
const RANGOS = { // límites del rango tal como lo define el formulario
  'menos_500k':{etq:'Menos de Q500,000', lo:0,       hi:500000, ord:1},
  '500k_2m':   {etq:'Q500,000 – Q2,000,000', lo:500000, hi:2000000, ord:2},
  '2m_10m':    {etq:'Q2,000,000 – Q10,000,000', lo:2000000, hi:10000000, ord:3},
  'mas_10m':   {etq:'Más de Q10,000,000', lo:10000000, hi:null, ord:4},
};
const fq = n => 'Q'+fmt(n);
/* Los rangos NO se suman: cada programa declara un intervalo (no un monto), puede abarcar varios
   municipios y el formulario no distingue presupuesto total de ejecutado. Solo se cuentan y se
   muestran por separado. */
function distRangos(progs){
  const filas=Object.entries(RANGOS).sort((a,b)=>a[1].ord-b[1].ord).map(([k,r])=>({k,etq:r.etq,ord:r.ord,n:progs.filter(p=>p.monto_rango_codigo===k).length}));
  const sin=progs.filter(p=>!RANGOS[p.monto_rango_codigo]).length;
  return {filas,sin,total:progs.length,con:progs.length-sin};
}
function textoDist(d){
  const partes=d.filas.filter(f=>f.n>0).map(f=>`${f.n} en ${f.etq}`); if(d.sin) partes.push(`${d.sin} sin dato`);
  return partes.join(' · ')||'Sin programas';
}
function rangoMasAlto(progs){
  const d=distRangos(progs).filas.filter(f=>f.n>0).sort((a,b)=>b.ord-a.ord)[0];
  return d?{etq:d.etq,n:d.n}:null;
}
function rangosHtml(progs){
  const d=distRangos(progs), mx=Math.max(1,...d.filas.map(f=>f.n),d.sin);
  return d.filas.map(f=>`<div class="int-bar"><span>${esc(f.etq)}</span><i style="--w:${(f.n/mx*100).toFixed(1)}%"></i><b>${f.n}</b></div>`).join('')+`<div class="int-bar"><span>Sin dato (prefiere no indicar)</span><i style="--w:${(d.sin/mx*100).toFixed(1)}%"></i><b>${d.sin}</b></div>`;
}
const NOTA_RANGOS='Los rangos se muestran por separado y no se suman: cada programa declara un intervalo, no un monto; puede abarcar varios municipios y el formulario no distingue presupuesto total de lo ejecutado. Un rango no equivale a recursos disponibles.';

/* ---------- Relaciones territoriales ---------- */
function munisComunitarios(p){ return uniq((p.comunidades||[]).map(c=>c.municipio)); }
function munisTodos(p){ return uniq([...munisComunitarios(p), ...(p.municipios_cobertura_institucional||[])]).sort(cmp); }
function lugaresDe(p){ // únicos por programa (un lugar repetido dentro de un programa cuenta una vez)
  const m=new Map();
  (p.comunidades||[]).forEach(c=>{ const k=c.codigo_lugar||(c.lugar_poblado+'|'+c.municipio); if(!m.has(k)) m.set(k,c); });
  return [...m.entries()].map(([k,c])=>({k,...c}));
}
function programasEnMunicipio(m){ return P.filter(p=>munisTodos(p).includes(m)); }
/* Población: se distinguen tres cosas y NO se calcula un total de personas.
   1) Registros: un programa que declara un grupo de población en una comunidad.
   2) Personas reportadas: suma de las cantidades tal como se declararon, por grupo. Puede repetir a
      las mismas personas (varios programas, varios grupos); por eso nunca se suman grupos entre sí.
   3) Posible superposición: comunidades donde 2 o más programas reportan cantidad para el mismo grupo. */
function valorCant(v){ return (typeof v==='number'&&Number.isFinite(v)&&v>=0)?v:null; }
function registrosPoblacion(progs, municipio){
  const g={};
  progs.forEach(p=>lugaresDe(p).forEach(c=>{
    if(municipio&&c.municipio!==municipio) return;
    const pm=c.pm_cantidades||{};
    const grupos=new Set([...(c.poblacion_meta||[]).filter(x=>x!=='Otro'),...Object.keys(pm)]);
    grupos.forEach(gr=>{
      const o=(g[gr]=g[gr]||{regs:0,con:0,suma:0,porLugar:{}}); o.regs++;
      const n=valorCant(pm[gr]); if(n!==null){ o.con++; o.suma+=n; (o.porLugar[c.k]=o.porLugar[c.k]||[]).push(n); }
    });
  }));
  Object.values(g).forEach(o=>{ o.sup=Object.values(o.porLugar).filter(a=>a.length>=2).length; });
  return g;
}
function resumenPoblacion(progs,municipio){
  const g=registrosPoblacion(progs,municipio); const v=Object.values(g);
  const regs=v.reduce((s,o)=>s+o.regs,0), con=v.reduce((s,o)=>s+o.con,0), sup=v.reduce((s,o)=>s+o.sup,0);
  return {g,regs,con,sin:regs-con,grupos:v.length,sup};
}
function tablaPoblacionHtml(progs,municipio){
  const r=resumenPoblacion(progs,municipio);
  if(!r.regs) return '<div class="int-empty">No hay grupos de población declarados.</div>';
  const filas=Object.entries(r.g).sort((a,b)=>b[1].regs-a[1].regs||cmp(a[0],b[0]));
  return `<div class="int-tbl-wrap"><table class="int-tbl"><thead><tr><th>Grupo declarado</th><th>Registros</th><th>Con cantidad</th><th>Personas reportadas*</th><th>Posible superposición**</th></tr></thead><tbody>${
    filas.map(([k,o])=>`<tr><td>${esc(k)}</td><td>${o.regs}</td><td>${o.con} de ${o.regs}</td><td>${o.con?fmt(o.suma):'sin dato'}</td><td>${o.sup?o.sup+' '+plural(o.sup,'comunidad','comunidades'):'no detectada'}</td></tr>`).join('')
  }</tbody></table></div>
  <p class="int-note">Registro: un programa que declara ese grupo en una comunidad. <b>*</b> Suma de las cantidades tal como se reportaron; puede incluir a las mismas personas en varios programas o varios grupos, por eso no se presenta un total de personas ni se suman los grupos entre sí. <b>**</b> Comunidades donde 2 o más programas reportan cantidad para el mismo grupo. "Sin dato" no es cero.</p>`;
}
function cantidadesTxt(c){
  const pm=c.pm_cantidades||{}; const e=Object.entries(pm).map(([k,v])=>`${k}: ${valorCant(v)!==null?fmt(v):'sin cantidad'}`);
  return e.length?e.join(' · '):((c.poblacion_meta||[]).filter(x=>x!=='Otro').join(', ')||'—');
}
function fechaFin(p){ return (typeof parseFecha==='function')?parseFecha(p.fecha_fin):null; }
function porCerrar(p){
  if(p.estado_programa==='Próximo a finalizar') return true;
  const f=fechaFin(p); if(!f) return false;
  const hoy=new Date(); const lim=new Date(hoy.getFullYear(),hoy.getMonth()+MESES_CIERRE,hoy.getDate());
  return f>=hoy && f<=lim;
}
function periodo(p){
  const i=p.fecha_inicio||'sin dato', f=p.fecha_fin||p.duracion_aproximada||'sin fecha definida';
  return `${i} → ${f}`;
}
function nombreProg(p){ return p.nombre_programa||'(sin nombre)'; }
function idProg(p){ return P.indexOf(p); }

/* ---------- Panel lateral (fichas) ---------- */
function asegurarDrawer(){
  if($('#int-drawer')) return;
  const d=document.createElement('aside'); d.id='int-drawer'; d.setAttribute('role','dialog'); d.setAttribute('aria-modal','true'); d.setAttribute('aria-label','Ficha de detalle');
  d.innerHTML=`<div class="int-dr-bar"><button type="button" class="int-back" id="int-back" aria-label="Volver">← Volver</button><span class="int-dr-sp"></span><button type="button" class="int-btn" id="int-print">Imprimir / PDF</button><button type="button" class="int-x" id="int-close" aria-label="Cerrar">×</button></div><div class="int-dr-body" id="int-dr-body"></div>`;
  const v=document.createElement('div'); v.id='int-veil'; v.onclick=cerrar;
  document.body.append(v,d);
  $('#int-close').onclick=cerrar;
  $('#int-print').onclick=()=>{ document.body.classList.add('int-printing'); window.print(); setTimeout(()=>document.body.classList.remove('int-printing'),500); };
  $('#int-back').onclick=()=>{ pila.pop(); const prev=pila.pop(); if(prev) abrir(prev.t,prev.h,prev.f); else cerrar(); };
  document.addEventListener('keydown',e=>{ if(e.key==='Escape') cerrar(); });
}
let pila=[];
function enExplorador(){ const v=$('#view-mapa'); return !!(v&&v.classList.contains('active')&&$('#panel-comunidad')); }
function abrir(titulo, html, fn, meta){
  pila.push({t:titulo,h:html,f:fn,m:meta||{}});
  if(enExplorador()){ sincronizarMapa(); return; }       // en Explorar, las fichas viven en el panel lateral
  asegurarDrawer();
  $('#int-dr-body').innerHTML=`<h2 class="int-h">${esc(titulo)}</h2>${html}`;
  $('#int-back').style.visibility = pila.length>1?'visible':'hidden';
  $('#int-drawer').classList.add('open'); $('#int-veil').classList.add('open');
  $('#int-dr-body').scrollTop=0;
  enlazar($('#int-dr-body'));
  if(fn) fn($('#int-dr-body'));
}
function cerrar(){ pila=[]; $('#int-drawer')?.classList.remove('open'); $('#int-veil')?.classList.remove('open'); }
/* Enlaces internos: data-go="org:Nombre" | "prog:3" | "lugar:codigo" | "muni:Camotán" | "contra:MAGA" */
function enlazar(root){
  $$('[data-go]',root).forEach(el=>{
    if(el.dataset.bound) return; el.dataset.bound='1';
    el.addEventListener('click',e=>{ e.preventDefault(); ir(el.dataset.go); });
    if(!/^(button|a)$/i.test(el.tagName)){ el.tabIndex=0; el.setAttribute('role','button'); el.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); ir(el.dataset.go);} }); }
  });
}
function ir(dest){
  const i=dest.indexOf(':'); const tipo=dest.slice(0,i), val=dest.slice(i+1);
  if(tipo==='org') fichaOrg(val);
  else if(tipo==='prog') fichaPrograma(+val);
  else if(tipo==='lugar') irLugar(val);
  else if(tipo==='muni') irMunicipioExplorar(val);
  else if(tipo==='dep') irMunicipioExplorar('');
  else if(tipo==='preg') pregunta(+val);
  else if(tipo==='ficha') irAMunicipio(val);
  else if(tipo==='cmp') abrirComparador(val);
  else if(tipo==='contra') { cerrar(); mostrarVista('articulacion'); setTimeout(()=>seleccionarContra(val),60); }
  else if(tipo==='lista') { const l=LISTAS[val]; if(l) abrir(l.titulo,l.html()); }
}
const chipOrg = o => `<button type="button" class="int-chip" data-go="org:${esc(o)}">${esc(o)}</button>`;
const chipProg = p => `<button type="button" class="int-chip alt" data-go="prog:${idProg(p)}">${esc(nombreProg(p))}</button>`;
const chipMuni = m => `<button type="button" class="int-chip muni" data-go="muni:${esc(m)}">${esc(m)}</button>`;
const tag = (t,c) => `<span class="int-tag ${c||''}">${esc(t)}</span>`;
const kpi = (v,l,sub) => `<div class="int-kpi"><b>${v}</b><span>${esc(l)}</span>${sub?`<em>${sub}</em>`:''}</div>`;
const LISTAS={};   // listas registradas para "Ver registros"
function registrarLista(id,titulo,fn){ LISTAS[id]={titulo,html:fn}; return id; }
function tablaProgs(progs){
  if(!progs.length) return '<div class="int-empty">No hay programas para mostrar.</div>';
  return `<div class="int-tbl-wrap"><table class="int-tbl"><thead><tr><th>Organización</th><th>Programa</th><th>Estado</th><th>Sectores</th><th>Municipios</th><th>Inversión reportada</th></tr></thead><tbody>${
    progs.map(p=>`<tr><td><span class="int-lnk" data-go="org:${esc(p.organizacion)}">${esc(p.organizacion)}</span></td><td><span class="int-lnk" data-go="prog:${idProg(p)}">${esc(nombreProg(p))}</span></td><td>${esc(p.estado_programa||'sin dato')}</td><td>${esc((p.sector||[]).join(', ')||'—')}</td><td>${esc(munisTodos(p).join(', ')||'—')}</td><td>${esc(p.monto_rango||'sin dato')}</td></tr>`).join('')
  }</tbody></table></div>`;
}

/* ---------- Ayuda contextual ---------- */
function ayuda({sig,calc,si,no}){
  return `<details class="int-help"><summary>¿Cómo leer esta vista?</summary><div class="int-help-grid">
   <div><h5>¿Qué significa?</h5><p>${sig}</p></div>
   <div><h5>¿Cómo se calculó?</h5><p>${calc}</p></div>
   <div class="ok"><h5>Podemos concluir</h5><p>${si}</p></div>
   <div class="no"><h5>No podemos concluir</h5><p>${no}</p></div></div></details>`;
}
const AYUDAS = {
  panorama:{sig:'Resume cuánta cooperación se ha registrado hasta hoy en Chiquimula y dónde se concentra.',calc:'Se cuentan organizaciones, programas, municipios y lugares poblados distintos en los registros enviados por las organizaciones mediante el formulario.',si:'Qué se ha reportado, en qué municipios y sectores, y cuáles programas están por finalizar.',no:'Que sea toda la cooperación existente. Solo aparece lo que las organizaciones han registrado; un municipio con pocos registros puede tener más cooperación aún no reportada.'},
  mapa:{sig:'Ubica en el territorio los lugares poblados donde se registró atención.',calc:'Cada punto es un lugar poblado del catálogo oficial con coordenadas. Se colorea según los programas registrados allí.',si:'Dónde hay atención comunitaria registrada y cuántos programas la reportan.',no:'Que los lugares sin color no reciban cooperación: significa "sin atención registrada". Los lugares adicionales reportados por las organizaciones no tienen coordenadas y quedan pendientes de validación.'},
  municipio:{sig:'Ficha de un municipio: quién trabaja allí, en qué temas y en qué comunidades.',calc:'Se reúnen los programas con lugares poblados registrados en el municipio o con fortalecimiento institucional declarado para él.',si:'Qué organizaciones y sectores tienen presencia registrada y qué comunidades fueron mencionadas.',no:'Que la cooperación llegue a todas las comunidades del municipio ni que el presupuesto total de un programa corresponda a este municipio.'},
  instituciones:{sig:'Directorio de las organizaciones que han registrado programas, con su perfil.',calc:'Se agrupan los programas por organización y se resumen sectores, territorios, rangos de inversión y articulaciones declarados.',si:'Quién es cada actor, qué hace y dónde reporta presencia.',no:'La calidad o los resultados de su trabajo; ni que esté activo en todos los lugares listados.'},
  inversion:{sig:'Rangos de inversión que las organizaciones declaran por programa.',calc:'El formulario pregunta un rango, no un monto. Se cuentan programas por rango y, al sumar, se usan los límites inferior y superior del rango.',si:'Cuántos programas están en cada rango y entre qué valores se mueve la suma de lo reportado.',no:'El monto exacto, lo ejecutado ni lo invertido en cada municipio. Los programas que "prefieren no indicar" no tienen dato, no tienen valor cero.'},
  brechas:{sig:'Muestra oportunidades para conversar o coordinar y qué información falta completar.',calc:'Reglas simples sobre los registros: coincidencias de sector y territorio, programas por cerrar, vacíos de datos.',si:'Dónde puede ser útil abrir una conversación entre actores.',no:'Que exista duplicidad, una brecha o un problema. Son puntos de partida para verificar con los actores.'},
  articulacion:{sig:'Con qué instituciones dicen articular las organizaciones y en qué espacios participan.',calc:'La contraparte es un texto libre; se agrupa por siglas conocidas (p. ej. MAGA). Los espacios provienen de una lista del formulario.',si:'Qué actores declaran vínculo con una institución o espacio, mediante qué programa y en qué territorio.',no:'Que dos organizaciones con la misma contraparte trabajen juntas, o que participar en un espacio signifique coordinación efectiva.'},
  'poblacion-accion':{sig:'A quiénes se dirigen las intervenciones y con qué tipo de acciones.',calc:'Se cuentan los grupos de población y acciones marcados en cada lugar poblado. Las cantidades son de referencia y no se suman entre programas.',si:'Qué poblaciones aparecen más en los registros y qué acciones las acompañan.',no:'Cuántas personas distintas se atienden: un grupo puede estar en varios programas y las categorías se traslapan.'},
};
function insertarAyuda(id){
  const sec=$('#view-'+id); const a=AYUDAS[id]; if(!sec||!a||$('.int-help',sec)) return;
  const ref=sec.querySelector('.section-sub')||sec.querySelector('.section-title')||sec.firstElementChild;
  const wrap=document.createElement('div'); wrap.innerHTML=ayuda(a);
  if(ref&&ref.parentNode===sec) ref.after(wrap.firstChild); else sec.prepend(wrap.firstChild);
}

/* =====================================================================
   FICHAS
   ===================================================================== */
function fichaOrg(nombre){
  const progs=P.filter(p=>p.organizacion===nombre); if(!progs.length) return;
  const p0=progs[0];
  const sectores=top(cuenta(progs.flatMap(p=>p.sector||[]),x=>x),20);
  const munis=uniq(progs.flatMap(munisTodos)).sort(cmp);
  const lugares=new Map(); progs.forEach(p=>lugaresDe(p).forEach(c=>{ if(!lugares.has(c.k)) lugares.set(c.k,c); }));
  const pob=resumenPoblacion(progs);
  const contra=uniq(progs.flatMap(contrapartesDe));
  const espacios=uniq(progs.flatMap(p=>(p.espacios_coordinacion||[]).filter(e=>e!=='No participa')));
  const estr=top(cuenta(progs.flatMap(p=>Object.keys(p.beneficiarios_institucionales||{})),x=>x),12);
  const vig=cuenta(progs,p=>p.estado_programa||'sin dato');
  const html=`
   <div class="int-sub">${tag(p0.tipo_actor||'Tipo no indicado')}${p0.pais_origen?tag(p0.pais_origen):''}${p0.trabajo_comunitario==='Sí'?tag('Trabaja directamente en comunidades','ok'):''}</div>
   <div class="int-kpis">${kpi(progs.length,plural(progs.length,'programa','programas'))}${kpi(munis.length,plural(munis.length,'municipio','municipios'))}${kpi(lugares.size,plural(lugares.size,'lugar poblado','lugares poblados'))}${kpi(pob.regs?`${pob.con} de ${pob.regs}`:'Sin dato','registros de población con cantidad','no es un total de personas')}</div>
   <h4 class="int-h4">Programas y proyectos</h4>
   ${progs.map(p=>`<div class="int-prog" data-go="prog:${idProg(p)}"><b>${esc(nombreProg(p))}</b><div>${tag(p.estado_programa||'sin estado',p.estado_programa==='Próximo a finalizar'?'warn':'ok')}${tag(p.monto_rango||'Inversión sin dato')}</div><small>${esc(periodo(p))} · ${esc((p.sector||[]).join(', ')||'sin sector')}</small></div>`).join('')}
   <h4 class="int-h4">Rangos de inversión declarados</h4>
   ${rangosHtml(progs)}
   <p class="int-note">${NOTA_RANGOS}</p>
   <h4 class="int-h4">Población declarada</h4>${tablaPoblacionHtml(progs)}
   <h4 class="int-h4">Sectores</h4><div>${sectores.map(([s,n])=>tag(`${s} (${n})`)).join('')||'<span class="int-empty">Sin dato</span>'}</div>
   <h4 class="int-h4">Municipios con presencia registrada</h4><div>${munis.map(chipMuni).join('')||'<span class="int-empty">Sin dato</span>'}</div>
   <h4 class="int-h4">Lugares poblados registrados (${lugares.size})</h4>
   <div>${[...lugares.values()].sort((a,b)=>cmp(a.municipio+a.lugar_poblado,b.municipio+b.lugar_poblado)).map(c=>`<button type="button" class="int-chip lugar" data-go="lugar:${esc(c.k)}">${esc(c.lugar_poblado)} <small>${esc(c.municipio)}</small></button>`).join('')||'<span class="int-empty">No registró lugares poblados.</span>'}</div>
   <h4 class="int-h4">Contrapartes y aliados que reporta</h4>
   <div>${contra.map(c=>`<button type="button" class="int-chip alt" data-go="contra:${esc(c)}">${esc(c)}</button>`).join('')||'<span class="int-empty">No reporta contraparte.</span>'}</div>
   <h4 class="int-h4">Espacios de coordinación</h4><div>${espacios.map(e=>tag(e)).join('')||'<span class="int-empty">No reporta participación.</span>'}</div>
   ${estr.length?`<h4 class="int-h4">Estructuras o instituciones que fortalece</h4><div>${estr.map(([e])=>tag(e)).join('')}</div>`:''}
   <h4 class="int-h4">Vigencia</h4><div>${Object.entries(vig).map(([k,n])=>tag(`${k}: ${n}`)).join('')}</div>
   ${MOSTRAR_CONTACTOS&&p0.contacto?`<h4 class="int-h4">Contacto institucional</h4><p>${esc(p0.contacto)}</p>`:`<p class="int-note">Los datos de contacto personales no se publican en el visor. Para coordinar, solicítelos a SEGEPLAN o CRS Chiquimula.</p>`}`;
  abrir(nombre,html,null,{org:nombre});
}

function fichaPrograma(i){
  const p=P[i]; if(!p) return;
  const lug=lugaresDe(p); const contra=contrapartesDe(p);
  const html=`
   <div class="int-sub"><span class="int-lnk" data-go="org:${esc(p.organizacion)}">${esc(p.organizacion)}</span> ${tag(p.tipo_atencion||'')}${tag(p.estado_programa||'sin estado',p.estado_programa==='Próximo a finalizar'?'warn':'ok')}</div>
   <div class="int-kpis">${kpi(esc(p.monto_rango||'Sin dato'),'Inversión reportada (rango)')}${kpi(lug.length,plural(lug.length,'lugar poblado','lugares poblados'))}${kpi(munisTodos(p).length,'municipios')}</div>
   <h4 class="int-h4">Datos del programa</h4>
   <dl class="int-dl"><dt>Período</dt><dd>${esc(periodo(p))}</dd><dt>Sectores</dt><dd>${esc((p.sector||[]).join(', ')||'—')}</dd><dt>Modalidad</dt><dd>${esc((p.modalidad||[]).join(', ')||'—')}</dd><dt>Fuente de financiamiento</dt><dd>${esc((p.fuente_financiamiento||[]).join(', ')||'—')}</dd><dt>Disposición a coordinar</dt><dd>${esc(p.disposicion_coordinar||'—')}</dd></dl>
   <h4 class="int-h4">Articulación reportada</h4>
   <dl class="int-dl"><dt>Contraparte (texto original)</dt><dd>${esc(p.contraparte_gubernamental||'No reporta')}</dd><dt>Agrupada como</dt><dd>${contra.map(c=>`<button type="button" class="int-chip alt" data-go="contra:${esc(c)}">${esc(c)}</button>`).join('')||'—'}</dd><dt>Espacios</dt><dd>${esc((p.espacios_coordinacion||[]).join(', ')||'—')}</dd></dl>
   ${Object.keys(p.beneficiarios_institucionales||{}).length?`<h4 class="int-h4">Instituciones que fortalece</h4><dl class="int-dl">${Object.entries(p.beneficiarios_institucionales).map(([k,v])=>`<dt>${esc(k)}</dt><dd>${v==null?'cantidad sin dato':fmt(v)}</dd>`).join('')}</dl><div>${(p.municipios_cobertura_institucional||[]).map(chipMuni).join('')}</div>`:''}
   <h4 class="int-h4">Lugares poblados (${lug.length})</h4>
   <div class="int-tbl-wrap"><table class="int-tbl"><thead><tr><th>Lugar</th><th>Municipio</th><th>Cantidades reportadas por grupo</th></tr></thead><tbody>${lug.map(c=>`<tr><td><span class="int-lnk" data-go="lugar:${esc(c.k)}">${esc(c.lugar_poblado)}</span>${c.fuera_catalogo?' '+tag('Pendiente de validación','warn'):''}</td><td>${esc(c.municipio)}</td><td>${esc(cantidadesTxt(c))}</td></tr>`).join('')||'<tr><td colspan="3">No registró lugares poblados.</td></tr>'}</tbody></table></div>
   <p class="int-note">Cantidades tal como las declaró la organización para ese lugar; "sin cantidad" no significa cero.</p>`;
  abrir(nombreProg(p),html,null,{prog:i});
}

function lugarHtml(k){
  const regs=[]; P.forEach(p=>lugaresDe(p).forEach(c=>{ if(c.k===k) regs.push({p,c}); }));
  if(!regs.length){
    const l=nombreLugares().find(x=>x.cod===k)||{lugar:k,muni:''};
    const viv=CATALOGO&&CATALOGO.lugares_poblados&&CATALOGO.lugares_poblados[k]&&CATALOGO.lugares_poblados[k].viviendas;
    return {titulo:l.lugar,html:`<div class="int-sub">${l.muni?chipMuni(l.muni):''}${viv?tag(fmt(viv)+' viviendas (catálogo)'):''}</div><div class="int-kpis">${kpi('Sin registro','atención registrada')}</div><p class="int-note">Ninguna organización ha registrado atención en este lugar poblado. Esto no confirma que no exista cooperación: puede no haber sido reportada. Si conoce alguna intervención aquí, invite a la organización a registrarla en el formulario.</p>`};
  }
  const c0=regs[0].c; const orgs=uniq(regs.map(r=>r.p.organizacion));
  const sect=top(cuenta(regs.flatMap(r=>r.p.sector||[]),x=>x),10);
  const acc=top(cuenta(regs.flatMap(r=>r.c.accion_comunidad||[]).filter(x=>x!=='Otro'),x=>x),10);
  const html=`
   <div class="int-sub">${chipMuni(c0.municipio)}${c0.clasificacion?tag(c0.clasificacion):''}${c0.fuera_catalogo?tag('Pendiente de validación','warn'):tag('Catálogo territorial','ok')}${(c0.lat===null||c0.lat===undefined||c0.lat==='')?tag('Sin coordenadas: no aparece como punto en el mapa','warn'):''}${c0.viviendas_catalogo?tag(fmt(c0.viviendas_catalogo)+' viviendas (catálogo)'):''}</div>
   <div class="int-kpis">${kpi(orgs.length,plural(orgs.length,'organización','organizaciones'))}${kpi(regs.length,plural(regs.length,'programa','programas'))}${kpi(sect.length,plural(sect.length,'sector','sectores'))}</div>
   <p class="int-note">Esto muestra lo que las organizaciones registraron para este lugar. No incluye cooperación no reportada.</p>
   <h4 class="int-h4">Quién registró atención aquí</h4>
   ${regs.map(({p,c})=>`<div class="int-prog" data-go="prog:${idProg(p)}"><b>${esc(p.organizacion)}</b><div>${esc(nombreProg(p))}</div><small>${esc((p.sector||[]).join(', ')||'sin sector')} · ${esc(p.estado_programa||'sin estado')}</small><small>Población declarada: ${esc(cantidadesTxt(c))}</small></div>`).join('')}
   <h4 class="int-h4">Sectores</h4><div>${sect.map(([s,n])=>tag(`${s} (${n})`)).join('')}</div>
   ${acc.length?`<h4 class="int-h4">Acciones o capacidades locales</h4><div>${acc.map(([s,n])=>tag(`${s} (${n})`)).join('')}</div>`:''}
   ${orgs.length>1?`<p class="int-oport"> ${orgs.length} organizaciones registran atención en este lugar. Puede ser útil conversar para complementar acciones.</p>`:''}`;
  return {titulo:c0.lugar_poblado,html};
}

function fichaLugar(k){ irLugar(k); }
function lugarMuni(k){ const l=nombreLugares().find(x=>x.cod===k); return l?l.muni:''; }
function irLugar(k){
  cerrar();
  const go=()=>navegar(lugarMuni(k),k);
  if(enExplorador()) go(); else { mostrarVista('mapa'); setTimeout(go,120); }
}
function irMunicipioExplorar(m){
  cerrar();
  const go=()=>navegar(m,'');
  if(enExplorador()) go(); else { mostrarVista('mapa'); setTimeout(go,120); }
}
function irAMunicipio(m){
  cerrar();
  const sel=$('#f-municipio-panel'); if(sel){ sel.value=m; }
  mostrarVista('municipio');
  try{ renderMunicipio(); }catch(e){}
  window.scrollTo({top:0,behavior:'smooth'});
}

/* =====================================================================
   MUNICIPIO: resumen en lenguaje sencillo + comparación
   ===================================================================== */
function datosMunicipio(m){
  const progs=programasEnMunicipio(m);
  const orgs=uniq(progs.map(p=>p.organizacion)).sort(cmp);
  const sect=top(cuenta(progs.flatMap(p=>p.sector||[]),x=>x),20);
  const lug=new Map(); progs.forEach(p=>lugaresDe(p).forEach(c=>{ if(c.municipio===m&&!lug.has(c.k)) lug.set(c.k,{...c,orgs:new Set(),progs:new Set()}); }));
  progs.forEach(p=>lugaresDe(p).forEach(c=>{ if(c.municipio===m){ lug.get(c.k).orgs.add(p.organizacion); lug.get(c.k).progs.add(idProg(p)); } }));
  const lugCat=[...lug.values()].filter(x=>!x.fuera_catalogo), lugAd=[...lug.values()].filter(x=>x.fuera_catalogo);
  const total=(DATA.resumen_municipio?.[m]?.comunidades_total_catalogo)||0;
  const contra=top(cuenta(progs.flatMap(contrapartesDe),x=>x),20);
  const pob=resumenPoblacion(progs,m);
  const rg=distRangos(progs);
  const cierre=progs.filter(porCerrar);
  return {m,progs,orgs,sect,lug:[...lug.values()],lugCat,lugAd,total,contra,rg,pob,cierre};
}
function resumenTexto(d){
  if(!d.progs.length) return `En ${d.m} todavía no hay programas registrados en el formulario. Esto no significa que no exista cooperación: puede que aún no haya sido reportada.`;
  let t=`En <b>${esc(d.m)}</b> se registran <b>${d.orgs.length} ${plural(d.orgs.length,'organización','organizaciones')}</b> y <b>${d.progs.length} ${plural(d.progs.length,'programa','programas')}</b>.`;
  if(d.sect.length) t+=` Los sectores más frecuentes son ${lista(d.sect.slice(0,3).map(([s,n])=>`${esc(s)} (${n})`))}.`;
  t+= d.lugCat.length||d.lugAd.length
    ? ` Hay intervenciones registradas en <b>${d.lugCat.length}</b> de ${d.total||'los'} lugares poblados del catálogo${d.lugAd.length?` y ${d.lugAd.length} lugar${d.lugAd.length===1?'':'es'} adicional${d.lugAd.length===1?'':'es'} pendiente${d.lugAd.length===1?'':'s'} de validación`:''}.`
    : ' No se registraron lugares poblados específicos; la presencia reportada es institucional o municipal.';
  if(d.contra.length) t+=` Las contrapartes más reportadas son ${lista(d.contra.slice(0,3).map(([s,n])=>`${esc(s)} (${n})`))}.`;
  if(d.cierre.length) t+=` ${d.cierre.length} ${plural(d.cierre.length,'programa finaliza','programas finalizan')} pronto.`;
  return t;
}
function renderMuniExtra(){
  const sec=$('#view-municipio'); if(!sec||!DATA) return;
  const m=$('#f-municipio-panel')?.value; if(!m) return;
  const d=datosMunicipio(m);
  let box=$('#int-muni'); if(!box){ box=document.createElement('div'); box.id='int-muni'; const st=$('#stats-municipio'); st.parentNode.insertBefore(box,st); }
  const lugaresHtml = d.lug.length
    ? d.lug.sort((a,b)=>b.orgs.size-a.orgs.size||cmp(a.lugar_poblado,b.lugar_poblado)).map(c=>`<button type="button" class="int-chip lugar${c.fuera_catalogo?' pend':''}" data-go="lugar:${esc(c.k)}">${esc(c.lugar_poblado)}${c.orgs.size>1?` <small>${c.orgs.size} org.</small>`:''}${c.fuera_catalogo?' <small>por validar</small>':''}</button>`).join('')
    : '<span class="int-empty">Sin lugares poblados registrados.</span>';
  box.innerHTML=`<div class="int-card int-resumen">
     <div class="int-eyebrow">Resumen de ${esc(m)}</div>
     <p class="int-big">${resumenTexto(d)}</p>
     <div class="int-kpis">${kpi(d.orgs.length,plural(d.orgs.length,'organización','organizaciones'))}${kpi(d.progs.length,plural(d.progs.length,'programa','programas'))}${kpi(d.pob.regs?`${d.pob.con} de ${d.pob.regs}`:'Sin dato','registros de población con cantidad','no es un total de personas')}${kpi(`${d.rg.con} de ${d.rg.total}`,'programas con rango de inversión declarado',rangoMasAlto(d.progs)?`el más alto: ${esc(rangoMasAlto(d.progs).etq)}`:'')}</div>
     <h4 class="int-h4">Organizaciones</h4><div>${d.orgs.map(chipOrg).join('')||'<span class="int-empty">Ninguna registrada.</span>'}</div>
     <h4 class="int-h4">Lugares poblados con atención registrada <small>(clic para ver quién y qué)</small></h4><div>${lugaresHtml}</div>
     <p class="int-note">Los lugares que no aparecen aquí están "sin atención registrada", no necesariamente sin cooperación. Los rangos de inversión se cuentan por programa y no se suman: el presupuesto de un programa no se reparte ni se atribuye al municipio, y un mismo programa puede aparecer en varios municipios.</p>
     <details class="int-det"><summary>Población declarada por grupo</summary>${tablaPoblacionHtml(d.progs,m)}</details>
     <details class="int-det"><summary>Rangos de inversión declarados</summary>${rangosHtml(d.progs)}<p class="int-note">${NOTA_RANGOS}</p></details>
     <div class="int-actions"><button type="button" class="int-btn" id="int-cmp-open">Comparar con otros municipios</button></div>
   </div>`;
  enlazar(box);
  $('#int-cmp-open').onclick=()=>abrirComparador(m);
}
function abrirComparador(base){
  const munis=DATA.municipios||[]; if(!ST.cmp||!ST.cmp.length) ST.cmp=[base];
  if(!ST.cmp.includes(base)) ST.cmp[0]=base;
  const pinta=()=>{
    const ds=ST.cmp.map(datosMunicipio);
    const fila=(etq,fn)=>`<tr><th>${etq}</th>${ds.map(d=>`<td>${fn(d)}</td>`).join('')}</tr>`;
    return `<p class="int-note">Seleccione hasta 3 municipios. Las cifras son de lo registrado en el formulario y dependen de cuánto reportaron las organizaciones en cada lugar.</p>
     <div class="int-cmp-sel">${munis.map(m=>`<label class="int-chk"><input type="checkbox" value="${esc(m)}" ${ST.cmp.includes(m)?'checked':''}> ${esc(m)}</label>`).join('')}</div>
     <div class="int-tbl-wrap"><table class="int-tbl int-cmp"><thead><tr><th></th>${ds.map(d=>`<th>${esc(d.m)}</th>`).join('')}</tr></thead><tbody>
      ${fila('Organizaciones',d=>d.orgs.length)}
      ${fila('Programas',d=>d.progs.length)}
      ${fila('Lugares con atención registrada',d=>`${d.lugCat.length}${d.total?` de ${d.total}`:''}${d.total?` <small>(${(d.lugCat.length/d.total*100).toFixed(1)}%)</small>`:''}`)}
      ${fila('Sectores principales',d=>esc(d.sect.slice(0,3).map(([s,n])=>`${s} (${n})`).join(', ')||'—'))}
      ${fila('Contrapartes frecuentes',d=>esc(d.contra.slice(0,3).map(([s,n])=>`${s} (${n})`).join(', ')||'—'))}
      ${fila('Registros de población con cantidad',d=>d.pob.regs?`${d.pob.con} de ${d.pob.regs}`:'sin dato')}
      ${fila('Programas por rango de inversión',d=>esc(textoDist(d.rg)))}
      ${fila('Programas por finalizar',d=>d.cierre.length)}
     </tbody></table></div>`;
  };
  const dibuja=()=>{ abrir('Comparar municipios',pinta()); $$('.int-cmp-sel input').forEach(cb=>cb.onchange=()=>{
      const v=cb.value; if(cb.checked){ if(ST.cmp.length>=3){ cb.checked=false; return; } ST.cmp.push(v); } else { ST.cmp=ST.cmp.filter(x=>x!==v); if(!ST.cmp.length) ST.cmp=[base]; }
      pila.pop(); dibuja(); }); };
  dibuja();
}

/* =====================================================================
   ORGANIZACIONES: directorio territorial (tabla / tarjetas), filtros,
   orden, paginación de 10, CSV completo y ficha con mapa (Fase 2 · Etapa 1)
   Solo presenta lo reportado; no suma rangos ni infiere alianzas.
   ===================================================================== */
const DIR_POR_PAG=10;
const DIR_ORDENES=[['nombre','Nombre (A–Z)'],['tipo','Tipo de organización'],['programas','Número de programas'],['municipios','Municipios con presencia'],['sectores','Sectores'],['contrapartes','Instituciones declaradas']];
function dirEstado(){ return ST.dir=ST.dir||{q:'',tipo:'',muni:'',sector:'',orden:'nombre',asc:true,pag:1,vista:null}; }
function dirInfo(){
  if(ST._dirInfo&&ST._dirInfoP===P) return ST._dirInfo;
  const orgs=uniq(P.map(p=>p.organizacion)).sort(cmp);
  ST._dirInfoP=P;
  return ST._dirInfo=orgs.map(o=>{
    const ps=P.filter(p=>p.organizacion===o);
    return {o,ps,tipo:ps[0].tipo_actor||'',
      munis:uniq(ps.flatMap(munisTodos)).sort(cmp), sect:uniq(ps.flatMap(p=>p.sector||[])).sort(cmp),
      contra:uniq(ps.flatMap(contrapartesDe)).sort(cmp),
      contraTxt:uniq(ps.map(p=>(p.contraparte_gubernamental||'').trim())),
      rg:distRangos(ps),
      texto:sinAcento([o,ps[0].tipo_actor,ps.map(p=>nombreProg(p)+' '+(p.contraparte_gubernamental||'')).join(' ')].join(' '))};
  });
}
function dirFiltrar(){
  const E=dirEstado(), q=sinAcento(E.q).trim();
  const f=dirInfo().filter(i=>(!E.tipo||i.tipo===E.tipo)&&(!E.muni||i.munis.includes(E.muni))&&(!E.sector||i.sect.includes(E.sector))&&(!q||i.texto.includes(q)||sinAcento(i.munis.join(' ')+' '+i.sect.join(' ')+' '+i.contra.join(' ')).includes(q)));
  const val={nombre:i=>i.o,tipo:i=>i.tipo,programas:i=>i.ps.length,municipios:i=>i.munis.length,sectores:i=>i.sect.length,contrapartes:i=>i.contra.length}[E.orden]||(i=>i.o);
  f.sort((a,b)=>{ const x=val(a), y=val(b); const r=(typeof x==='number'&&typeof y==='number')?(x-y):cmp(x,y); return (E.asc?r:-r)||cmp(a.o,b.o); });
  return f;
}
const limitarChips=(arr,n,clase,vacio)=>{ if(!arr.length) return `<span class="int-empty">${vacio||'Sin dato'}</span>`; const v=arr.slice(0,n).map(x=>`<span class="int-tag ${clase||''}">${esc(x)}</span>`).join(''); return v+(arr.length>n?`<span class="int-masn" title="${esc(arr.slice(n).join(', '))}">+${arr.length-n} más</span>`:''); };
function rangosLineas(i){
  const l=i.rg.filas.filter(f=>f.n>0).map(f=>`<div class="int-rg"><span>${esc(f.etq)}</span><b>${f.n} ${plural(f.n,'programa','programas')}</b></div>`);
  if(i.rg.sin) l.push(`<div class="int-rg"><span>Sin dato</span><b>${i.rg.sin} ${plural(i.rg.sin,'programa','programas')}</b></div>`);
  return l.join('')||'<span class="int-empty">Sin dato</span>';
}
function dirFilaCsv(i){
  return [i.o,i.tipo,i.ps.length,i.munis.join('; '),i.sect.join('; '),i.contra.join('; '),i.contraTxt.filter(Boolean).join('; '),
    i.ps.map(p=>`${nombreProg(p)}: ${p.monto_rango||'Sin dato'}`).join('; '),
    Object.entries(cuenta(i.ps,p=>p.estado_programa||'sin estado')).map(([k,n])=>`${k}: ${n}`).join('; ')];
}
function renderDirectorio(){
  const sec=$('#view-instituciones'); if(!sec) return;
  const E=dirEstado(); const todos=dirInfo();
  if(E.vista===null) E.vista=(window.innerWidth<760)?'tarjetas':'tabla';
  let box=$('#int-dir'); if(!box){ box=document.createElement('div'); box.id='int-dir'; const ref=$('.int-help',sec)||sec.querySelector('.section-sub')||sec.firstElementChild; ref.after(box); }
  if(!box.dataset.init){
    box.dataset.init='1';
    const tipos=uniq(P.map(p=>p.tipo_actor)).sort(cmp), munis=uniq(P.flatMap(munisTodos)).sort(cmp), sects=uniq(P.flatMap(p=>p.sector||[])).sort(cmp);
    const op=(arr,t)=>`<option value="">${t}</option>`+arr.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join('');
    box.innerHTML=`<div class="int-card int-dircard"><div class="int-eyebrow">Directorio de organizaciones</div>
     <div class="int-search"><input id="int-q" type="search" placeholder="Buscar organización, programa o contraparte" aria-label="Buscar organizaciones">
      <select id="int-f-muni" aria-label="Filtrar por municipio">${op(munis,'Municipio: todos')}</select>
      <select id="int-f-sector" aria-label="Filtrar por sector">${op(sects,'Sector: todos')}</select>
      <select id="int-tipo" aria-label="Filtrar por tipo de organización">${op(tipos,'Tipo: todos')}</select>
      <button type="button" class="int-btn ghost" id="int-limpiar">Limpiar filtros</button></div>
     <div class="int-dirbar">
      <div class="int-vista" role="group" aria-label="Forma de visualización"><button type="button" id="int-v-tabla">Tabla</button><button type="button" id="int-v-tarjetas">Tarjetas</button></div>
      <label class="int-orden">Ordenar por <select id="int-orden" aria-label="Ordenar por">${DIR_ORDENES.map(([k,t])=>`<option value="${k}">${t}</option>`).join('')}</select></label>
      <button type="button" class="int-btn ghost" id="int-asc" aria-label="Invertir el orden"></button>
      <button type="button" class="int-btn" id="int-csv">Descargar CSV</button></div>
     <div id="int-dir-n" class="int-note" aria-live="polite"></div>
     <div id="int-dir-cuerpo"></div><div id="int-dir-pag"></div>
     <p class="int-note">Se muestra lo que las organizaciones reportaron: ${etq('rep')} Que una organización no aparezca en un municipio no significa que no trabaje allí. Las instituciones listadas son <b>contrapartes declaradas</b> (texto libre), no alianzas ni coordinación verificadas. Los rangos de inversión se cuentan por programa y no se suman. El CSV incluye todas las organizaciones que cumplen los filtros, no solo las de la página visible.</p></div>`;
    const re=()=>{ E.pag=1; renderDirectorio(); };
    $('#int-q').oninput=e=>{ E.q=e.target.value; re(); };
    $('#int-f-muni').onchange=e=>{ E.muni=e.target.value; re(); };
    $('#int-f-sector').onchange=e=>{ E.sector=e.target.value; re(); };
    $('#int-tipo').onchange=e=>{ E.tipo=e.target.value; re(); };
    $('#int-limpiar').onclick=()=>{ Object.assign(E,{q:'',tipo:'',muni:'',sector:'',pag:1}); ['int-q','int-f-muni','int-f-sector','int-tipo'].forEach(id=>$('#'+id).value=''); renderDirectorio(); };
    $('#int-v-tabla').onclick=()=>{ E.vista='tabla'; renderDirectorio(); };
    $('#int-v-tarjetas').onclick=()=>{ E.vista='tarjetas'; renderDirectorio(); };
    $('#int-orden').onchange=e=>{ E.orden=e.target.value; E.asc=(E.orden==='nombre'||E.orden==='tipo'); re(); };
    $('#int-asc').onclick=()=>{ E.asc=!E.asc; re(); };
    $('#int-csv').onclick=()=>{ const f=dirFiltrar(); csv('directorio_actores.csv',[['Organización','Tipo de actor','Programas','Municipios con presencia registrada','Sectores','Instituciones declaradas como contraparte (agrupadas)','Contraparte (texto original)','Rango de inversión declarado por programa','Estado de los programas'],...f.map(dirFilaCsv)]); };
    box.addEventListener('click',e=>{
      const b=e.target.closest('[data-org]'); if(b){ abrirFichaOrganizacion(b.dataset.org); return; }
      const s=e.target.closest('[data-sort]'); if(s){ const k=s.dataset.sort; if(E.orden===k) E.asc=!E.asc; else { E.orden=k; E.asc=(k==='nombre'||k==='tipo'); } E.pag=1; renderDirectorio(); return; }
      const g=e.target.closest('[data-pag]'); if(g){ const v=g.dataset.pag; E.pag=v==='prev'?E.pag-1:v==='next'?E.pag+1:+v; renderDirectorio(); const t=$('#int-dir-n'); if(t&&t.scrollIntoView) t.scrollIntoView({block:'nearest'}); }
    });
  }
  // sincronizar controles con el estado
  $('#int-q').value=E.q; $('#int-f-muni').value=E.muni; $('#int-f-sector').value=E.sector; $('#int-tipo').value=E.tipo; $('#int-orden').value=E.orden;
  $('#int-asc').textContent=E.asc?'↑ Ascendente':'↓ Descendente';
  $('#int-v-tabla').setAttribute('aria-pressed',String(E.vista==='tabla')); $('#int-v-tarjetas').setAttribute('aria-pressed',String(E.vista==='tarjetas'));
  const f=dirFiltrar(); ST.dirFilas=f;
  const pags=Math.max(1,Math.ceil(f.length/DIR_POR_PAG)); E.pag=Math.min(Math.max(1,E.pag),pags);
  const ini=(E.pag-1)*DIR_POR_PAG, pagina=f.slice(ini,ini+DIR_POR_PAG);
  $('#int-dir-n').textContent=f.length?`${f.length} de ${todos.length} organizaciones · mostrando ${ini+1}–${ini+pagina.length}`:`0 de ${todos.length} organizaciones`;
  const ordenFlecha=k=>E.orden===k?(E.asc?' ▲':' ▼'):'';
  const th=(k,t,sub)=>`<th scope="col" aria-sort="${E.orden===k?(E.asc?'ascending':'descending'):'none'}"><button type="button" class="int-th" data-sort="${k}">${t}${ordenFlecha(k)}</button>${sub?`<small>${sub}</small>`:''}</th>`;
  let cuerpo;
  if(!f.length){
    cuerpo=`<div class="int-vacio"><b>Ninguna organización coincide con los filtros.</b><p>Pruebe con otro municipio o sector, o quite los filtros. Recuerde que aquí solo aparece lo que las organizaciones reportaron.</p></div>`;
  }else if(E.vista==='tabla'){
    cuerpo=`<div class="int-tbl-wrap"><table class="int-tbl int-dirtbl"><thead><tr>${th('nombre','Organización')}${th('tipo','Tipo')}${th('programas','Programas')}${th('municipios','Municipios con presencia registrada')}${th('sectores','Sectores')}${th('contrapartes','Instituciones con las que declara coordinar','declarado por la organización')}<th scope="col">Rango de inversión por programa<small>no se suman</small></th></tr></thead><tbody>${pagina.map(i=>`<tr>
      <td><button type="button" class="int-orglink" data-org="${esc(i.o)}">${esc(i.o)}</button></td>
      <td>${tag(i.tipo||'Tipo no indicado')}</td><td class="num">${i.ps.length}</td>
      <td>${limitarChips(i.munis,3,'muni','Sin municipio registrado')}</td><td>${limitarChips(i.sect,2)}</td><td>${limitarChips(i.contra,3,'alt','No declara contraparte')}</td><td>${rangosLineas(i)}</td></tr>`).join('')}</tbody></table></div>`;
  }else{
    cuerpo=`<div class="int-ogrid">${pagina.map(i=>`<article class="int-ocard"><div class="int-ocard-h"><h5>${esc(i.o)}</h5>${tag(i.tipo||'Tipo no indicado')}</div>
      <div class="int-ocard-k"><div><b>${i.ps.length}</b><span>${plural(i.ps.length,'programa','programas')}</span></div><div><b>${i.munis.length}</b><span>${plural(i.munis.length,'municipio','municipios')}</span></div><div><b>${i.sect.length}</b><span>${plural(i.sect.length,'sector','sectores')}</span></div></div>
      <h6>Municipios con presencia registrada</h6><div>${limitarChips(i.munis,4,'muni','Sin municipio registrado')}</div>
      <h6>Sectores</h6><div>${limitarChips(i.sect,3)}</div>
      <h6>Instituciones con las que declara coordinar</h6><div>${limitarChips(i.contra,3,'alt','No declara contraparte')}</div>
      <h6>Rango de inversión por programa</h6><div>${rangosLineas(i)}</div>
      <button type="button" class="int-btn" data-org="${esc(i.o)}">Ver ficha de la organización</button></article>`).join('')}</div>`;
  }
  $('#int-dir-cuerpo').innerHTML=cuerpo;
  $('#int-dir-pag').innerHTML=pags>1?`<div class="int-pager" role="navigation" aria-label="Paginación del directorio"><button type="button" data-pag="prev" ${E.pag<=1?'disabled':''}>‹ Anterior</button>${Array.from({length:pags},(_,k)=>`<button type="button" data-pag="${k+1}" ${k+1===E.pag?'aria-current="page" class="on"':''}>${k+1}</button>`).join('')}<button type="button" data-pag="next" ${E.pag>=pags?'disabled':''}>Siguiente ›</button><span>Página ${E.pag} de ${pags}</span></div>`:'';
}
/* Ficha de organización: primero lo esencial; después mapa, perfil y detalle (bloque original del visor) */
function resumenFichaOrg(nombre){
  const box=$('#int-ficha-resumen'); if(!box) return;
  const ps=P.filter(p=>p.organizacion===nombre); if(!ps.length){ box.innerHTML=''; return; }
  const munis=uniq(ps.flatMap(munisTodos)).sort(cmp); const lug=new Set(); ps.forEach(p=>lugaresDe(p).forEach(c=>lug.add(c.k)));
  const sect=uniq(ps.flatMap(p=>p.sector||[])).sort(cmp), contra=uniq(ps.flatMap(contrapartesDe)).sort(cmp);
  box.innerHTML=`<div class="int-card int-ficha-top"><h3>${esc(nombre)}</h3><div>${tag(ps[0].tipo_actor||'Tipo no indicado')}${ps[0].pais_origen?tag(ps[0].pais_origen):''}</div>
   <p class="int-lead">Reporta <b>${ps.length}</b> ${plural(ps.length,'programa','programas')}, con presencia registrada en <b>${munis.length}</b> ${plural(munis.length,'municipio','municipios')} y atención registrada en <b>${lug.size}</b> ${plural(lug.size,'lugar poblado','lugares poblados')}. Esto es lo que la organización reportó: no mide cobertura total.</p>
   <div class="int-ficha-cols">
    <section><h4 class="int-h4">Programas, estado y rango de inversión</h4>${ps.map(p=>`<div class="int-prog"><b>${esc(nombreProg(p))}</b><div>${tag(p.estado_programa||'sin estado',p.estado_programa==='Próximo a finalizar'?'warn':'ok')}${tag(p.monto_rango||'Inversión sin dato')}</div></div>`).join('')}<p class="int-note">Cada rango es un intervalo declarado por programa; no se suman.</p></section>
    <section><h4 class="int-h4">Con quién declara coordinar</h4><div>${contra.length?contra.map(c=>`<span class="int-tag alt">${esc(c)}</span>`).join(''):'<span class="int-empty">No declara contraparte.</span>'}</div><p class="int-note">${etq('rep')} Contraparte declarada en texto libre; no equivale a una alianza ni a una coordinación verificada.</p>
     <h4 class="int-h4">Sectores de trabajo</h4><div>${sect.map(s=>tag(s)).join('')||'<span class="int-empty">Sin dato</span>'}</div></section></div>
   <button type="button" class="int-btn ghost" id="int-ficha-mas">Más detalle: población declarada, espacios, lugares</button></div>`;
  $('#int-ficha-mas').onclick=()=>fichaOrg(nombre);
}
function abrirFichaOrganizacion(nombre){
  const f=$('#int-ficha-org'), d=$('#int-dir'); if(!f||!d) return;
  const sel=$('#f-organizacion-panel'); if(sel){ sel.value=nombre; if(!sel.dataset.intRes){ sel.dataset.intRes='1'; sel.addEventListener('change',()=>resumenFichaOrg(sel.value)); } }
  d.hidden=true; f.hidden=false; resumenFichaOrg(nombre);
  try{ renderOrganizacion(); }catch(e){ console.error(e); }
  setTimeout(()=>{ try{ if(orgMap) orgMap.invalidateSize(); renderOrganizacion(); }catch(e){} },120);
  const v=$('#int-volver'); if(v&&!v.dataset.bound){ v.dataset.bound='1'; v.onclick=irDirectorio; }
  window.scrollTo({top:0,behavior:'auto'});
}
function irDirectorio(){ const f=$('#int-ficha-org'), d=$('#int-dir'); if(f) f.hidden=true; if(d) d.hidden=false; }
function csv(nombre,filas){
  const t=filas.map(r=>r.map(x=>`"${String(x==null?'':x).replace(/"/g,'""')}"`).join(',')).join('\r\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob(['﻿'+t],{type:'text/csv;charset=utf-8'})); a.download=nombre; document.body.appendChild(a); a.click(); setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},400);
}

/* =====================================================================
   ARTICULACIÓN: contrapartes / espacios / estructuras
   ===================================================================== */
function renderArtExtra(){
  const sec=$('#view-articulacion'); if(!sec) return;
  let box=$('#int-art'); if(!box){ box=document.createElement('div'); box.id='int-art'; const ref=$('.int-help',sec)||sec.querySelector('.section-sub')||sec.firstElementChild; ref.after(box); }
  const modo=ST.artModo||'contra';
  const fuentes={
    contra:{etq:'1 · Contrapartes declaradas', desc:'Instituciones que cada organización escribió como contraparte (texto libre). Se agrupan por siglas solo para facilitar la lectura; lo que no se reconoce queda como "Sin clasificar" y el texto original siempre se muestra.', items:()=>top(cuenta(P.flatMap(p=>contrapartesDe(p).map(c=>p.organizacion+'||'+c)),x=>x.split('||')[1]),40), match:(p,k)=>contrapartesDe(p).includes(k)},
    espacio:{etq:'2 · Espacios compartidos', desc:'Mesas, comisiones y comités en los que las organizaciones dicen participar. Coincidir en un espacio es una oportunidad de encuentro, no una coordinación comprobada.', items:()=>top(cuenta(P.flatMap(p=>uniq((p.espacios_coordinacion||[]).filter(e=>e!=='No participa')).map(e=>p.organizacion+'||'+e)),x=>x.split('||')[1]),40), match:(p,k)=>(p.espacios_coordinacion||[]).includes(k)},
    estr:{etq:'Estructuras fortalecidas (apoyo institucional)', desc:'Instituciones o estructuras que reciben fortalecimiento según el formulario.', items:()=>top(cuenta(P.flatMap(p=>Object.keys(p.beneficiarios_institucionales||{}).map(e=>p.organizacion+'||'+e)),x=>x.split('||')[1]),40), match:(p,k)=>Object.keys(p.beneficiarios_institucionales||{}).includes(k)},
  };
  const f=fuentes[modo];
  // chips muestran organizaciones DISTINTAS, no programas
  const dist={}; P.forEach(p=>{ const ks= modo==='contra'?contrapartesDe(p): modo==='espacio'?uniq((p.espacios_coordinacion||[]).filter(e=>e!=='No participa')):Object.keys(p.beneficiarios_institucionales||{}); ks.forEach(k=>{ (dist[k]=dist[k]||new Set()).add(p.organizacion); }); });
  const items=Object.entries(dist).map(([k,s])=>[k,s.size]).sort((a,b)=>b[1]-a[1]||cmp(a[0],b[0]));
  const nDecl=P.filter(p=>!contrapartesDetalle(p).ninguna).length, nEsp=P.filter(p=>(p.espacios_coordinacion||[]).some(e=>e!=='No participa')).length;
  const nSinCl=P.filter(p=>contrapartesDetalle(p).sinClasificar.length).length;
  box.innerHTML=`<div class="int-card"><div class="int-eyebrow">¿Con quién se articulan?</div>
    <div class="int-capas"><div><b>${nDecl}</b> de ${P.length} programas<br><span>declaran una contraparte</span><em>Capa 1 · Declarado</em></div><div><b>${nEsp}</b> de ${P.length} programas<br><span>participan en algún espacio</span><em>Capa 2 · Espacio compartido</em></div><div><b>0</b> de ${P.length} programas<br><span>con vínculo documentado</span><em>Capa 3 · Sin evidencia en el formulario actual</em></div></div>
    <p class="int-note">El formulario actual solo recoge lo que la organización declara. Un vínculo "documentado" requeriría un convenio, acta o actividad conjunta (fecha y referencia) que hoy no se pregunta. ${nSinCl?`<b>${nSinCl}</b> programas escribieron contrapartes que no se pudieron clasificar; se muestran con su texto original.`:''}</p>
    <div class="int-tabs" role="tablist">${Object.entries(fuentes).map(([k,v])=>`<button type="button" role="tab" class="${k===modo?'on':''}" data-m="${k}">${v.etq}</button>`).join('')}</div>
    <p class="int-note">${f.desc}</p>
    <div class="int-chiprow">${items.map(([k,n])=>`<button type="button" class="int-chip big ${ST.artSel===k?'on':''}" data-k="${esc(k)}">${esc(k)} <small>${n} org.</small></button>`).join('')||'<span class="int-empty">Sin datos.</span>'}</div>
    <div id="int-art-det"></div>
    <p class="int-note warn">Compartir una contraparte o un espacio no significa que dos organizaciones trabajen juntas, ni que participar en un espacio implique coordinación efectiva. Son puntos de partida para conversar.</p></div>`;
  $$('.int-tabs button',box).forEach(b=>b.onclick=()=>{ ST.artModo=b.dataset.m; ST.artSel=''; renderArtExtra(); });
  $$('.int-chip.big',box).forEach(b=>b.onclick=()=>{ ST.artSel=b.dataset.k; renderArtExtra(); });
  if(ST.artSel && dist[ST.artSel]){
    const ps=P.filter(p=>f.match(p,ST.artSel));
    const orgs=uniq(ps.map(p=>p.organizacion)).sort(cmp), munis=uniq(ps.flatMap(munisTodos)).sort(cmp);
    $('#int-art-det',box).innerHTML=`<div class="int-detail"><h4 class="int-h4" style="margin-top:0">${esc(ST.artSel)}</h4>
      <div class="int-kpis">${kpi(orgs.length,plural(orgs.length,'organización','organizaciones'))}${kpi(ps.length,plural(ps.length,'programa','programas'))}${kpi(munis.length,plural(munis.length,'municipio','municipios'))}</div>
      <h5 class="int-h5">Organizaciones</h5><div>${orgs.map(chipOrg).join('')}</div>
      <h5 class="int-h5">Territorios donde esos programas tienen presencia registrada</h5><div>${munis.map(chipMuni).join('')||'—'}</div>
      <h5 class="int-h5">Programas</h5>${tablaProgs(ps)}
      ${modo==='contra'?`<h5 class="int-h5">Texto original que escribió cada organización</h5><ul class="int-ul">${ps.map(p=>`<li><b>${esc(p.organizacion)}</b>: “${esc(p.contraparte_gubernamental)}”</li>`).join('')}</ul>`:''}
    </div>`;
    enlazar($('#int-art-det',box));
  } else $('#int-art-det',box).innerHTML=`<div class="int-empty">Seleccione una institución o espacio para ver qué organizaciones lo reportan, mediante qué programas y en qué territorios.</div>`;
  enlazar(box);
}
function seleccionarContra(k){ ST.artModo='contra'; ST.artSel=k; renderArtExtra(); $('#int-art')?.scrollIntoView({behavior:'smooth'}); }

/* =====================================================================
   OPORTUNIDADES de articulación (vista "brechas")
   ===================================================================== */
function oportunidades(munisSel){
  const out=[];
  const munis=munisSel||DATA.municipios||[];
  const PS=munisSel?P.filter(p=>munisSel.some(m=>munisTodos(p).includes(m))):P;
  // 1. Municipio + sector con >=2 organizaciones
  const ms=[]; munis.forEach(m=>{ const ps=programasEnMunicipio(m); const por={}; ps.forEach(p=>(p.sector||[]).forEach(s=>{ (por[s]=por[s]||{orgs:new Set(),ps:[]}); por[s].orgs.add(p.organizacion); por[s].ps.push(p); }));
    Object.entries(por).forEach(([s,v])=>{ if(v.orgs.size>=2) ms.push({m,s,orgs:[...v.orgs],ps:v.ps}); }); });
  ms.sort((a,b)=>b.orgs.length-a.orgs.length||cmp(a.m+a.s,b.m+b.s));
  out.push({id:'o1',icono:'',n:ms.length,titulo:'Mismo sector, varias organizaciones en un municipio',
    porque:'Cuando varias organizaciones trabajan el mismo tema en un municipio, conversar puede ayudar a complementar acciones. No indica duplicidad: pueden atender comunidades o poblaciones distintas.',
    items:ms.map(x=>({txt:`<b>${esc(x.s)}</b> en <span class="int-lnk" data-go="muni:${esc(x.m)}">${esc(x.m)}</span>: ${x.orgs.length} organizaciones`,sub:`<small class="int-orgs">${x.orgs.map(esc).join(' · ')}</small>`}))});
  // 2. Lugares con >=2 programas
  const lg=new Map(); P.forEach(p=>lugaresDe(p).forEach(c=>{ if(munisSel&&!munisSel.includes(c.municipio)) return; if(!lg.has(c.k)) lg.set(c.k,{c,ps:[],orgs:new Set()}); lg.get(c.k).ps.push(p); lg.get(c.k).orgs.add(p.organizacion); }));
  const l2=[...lg.values()].filter(x=>x.ps.length>=2).sort((a,b)=>b.ps.length-a.ps.length||cmp(a.c.lugar_poblado,b.c.lugar_poblado));
  out.push({id:'o2',icono:'',n:l2.length,titulo:'Lugares poblados con varias intervenciones registradas',
    porque:'Si varios programas llegan al mismo lugar, vale la pena que los actores se conozcan y sepan qué hace cada quien. Puede ser complementariedad.',
    items:l2.map(x=>({txt:`<span class="int-lnk" data-go="lugar:${esc(x.c.k)}">${esc(x.c.lugar_poblado)}</span>, ${esc(x.c.municipio)}: ${x.ps.length} programas de ${x.orgs.size} ${plural(x.orgs.size,'organización','organizaciones')}`,sub:`<small class="int-orgs">${uniq(x.ps.map(p=>p.organizacion)).map(esc).join(' · ')}</small>`}))});
  // 3. Sectores con menor presencia
  const sectores=Object.keys(DATA.matriz_sector_municipio||{});
  if(munisSel){
    const m=munisSel[0]; const ausentes=sectores.filter(s=>!programasEnMunicipio(m).some(p=>(p.sector||[]).includes(s))).sort(cmp);
    out.push({id:'o3',icono:'',n:ausentes.length,titulo:`Sectores sin registros en ${m}`,
      porque:'Son temas que aparecen en otros municipios pero no tienen programas registrados aquí. Puede que no se trabajen o que aún no se hayan reportado; conviene verificarlo antes de concluir.',
      items:ausentes.map(s=>({txt:esc(s),sub:''}))});
  } else {
  const sm=sectores.map(s=>{ const mm=munis.filter(m=>programasEnMunicipio(m).some(p=>(p.sector||[]).includes(s))); return {s,mm,n:P.filter(p=>(p.sector||[]).includes(s)).length}; }).sort((a,b)=>a.mm.length-b.mm.length||a.n-b.n);
  out.push({id:'o3',icono:'',n:Math.min(5,sm.length),titulo:'Sectores con menor presencia registrada',
    porque:'Son los temas con menos municipios con registros. Puede deberse a que hay poca cooperación o a que todavía no se ha reportado; conviene verificarlo antes de concluir.',
    items:sm.slice(0,5).map(x=>({txt:`<b>${esc(x.s)}</b>: registrado en ${x.mm.length} de ${munis.length} municipios (${x.n} ${plural(x.n,'programa','programas')})`,sub:x.mm.map(chipMuni).join('')||'<span class="int-empty">Sin municipios con registro.</span>'}))});
  }
  // 4. Contrapartes en común
  const cc={}; PS.forEach(p=>contrapartesDe(p).forEach(c=>{ (cc[c]=cc[c]||new Set()).add(p.organizacion); }));
  const c2=Object.entries(cc).filter(([,s])=>s.size>=2).sort((a,b)=>b[1].size-a[1].size);
  out.push({id:'o4',icono:'',n:c2.length,titulo:'Organizaciones que reportan una misma contraparte',
    porque:'Una institución aliada de varias organizaciones puede ser un punto natural para convocar. Compartir contraparte no significa que ya trabajen juntas.',
    items:c2.map(([c,s])=>({txt:`<span class="int-lnk" data-go="contra:${esc(c)}">${esc(c)}</span>: ${s.size} organizaciones`,sub:`<small class="int-orgs">${[...s].sort(cmp).map(esc).join(' · ')}</small>`}))});
  // 5. Programas que finalizan pronto
  const pc=PS.filter(porCerrar).sort((a,b)=>(fechaFin(a)||new Date(9e12))-(fechaFin(b)||new Date(9e12)));
  out.push({id:'o5',icono:'',n:pc.length,titulo:`Programas que finalizan en los próximos ${MESES_CIERRE} meses`,
    porque:'Cuando un programa termina, conviene prever quién da continuidad a lo avanzado en esos territorios.',
    items:pc.map(p=>({txt:`<span class="int-lnk" data-go="prog:${idProg(p)}">${esc(nombreProg(p))}</span> · ${esc(p.organizacion)}`,sub:`${tag('Fin: '+(p.fecha_fin||'por definir'),'warn')}${munisTodos(p).map(chipMuni).join('')}`}))});
  // 6. Información por completar
  const falt=[];
  const sinCant=PS.filter(p=>(p.comunidades||[]).some(c=>c.datos_cuantitativos_poblacion==='No'));
  if(sinCant.length) falt.push({txt:`<b>${sinCant.length}</b> ${plural(sinCant.length,'programa no reportó','programas no reportaron')} cantidades de población en alguno de sus lugares`,sub:sinCant.map(chipProg).join('')});
  const sinInv=PS.filter(p=>!RANGOS[p.monto_rango_codigo]);
  if(sinInv.length) falt.push({txt:`<b>${sinInv.length}</b> ${plural(sinInv.length,'programa prefiere','programas prefieren')} no indicar su rango de inversión`,sub:sinInv.map(chipProg).join('')});
  const pend=PS.flatMap(p=>lugaresDe(p).filter(c=>c.fuera_catalogo).map(c=>({p,c})));
  if(pend.length) falt.push({txt:`<b>${pend.length}</b> lugar${pend.length===1?'':'es'} adicional${pend.length===1?'':'es'} pendiente${pend.length===1?'':'s'} de validación`,sub:pend.map(x=>tag(x.c.lugar_poblado+' ('+x.c.municipio+')','warn')).join('')});
  const sinGeo=uniq(PS.flatMap(p=>lugaresDe(p).filter(c=>!c.fuera_catalogo&&(c.lat==null||c.lat==='')).map(c=>c.lugar_poblado+' ('+c.municipio+')')));
  if(sinGeo.length) falt.push({txt:`<b>${sinGeo.length}</b> ${plural(sinGeo.length,'lugar con atención registrada no tiene','lugares con atención registrada no tienen')} coordenadas en el catálogo (no se dibujan en el mapa)`,sub:sinGeo.map(s=>tag(s)).join('')});
  const dup=PS.filter(p=>(p.comunidades||[]).length!==lugaresDe(p).length);
  if(dup.length) falt.push({txt:`<b>${dup.length}</b> ${plural(dup.length,'programa repite','programas repiten')} el mismo lugar poblado más de una vez (el visor lo cuenta una sola vez)`,sub:dup.map(chipProg).join('')});
  const neg=[]; PS.forEach(p=>lugaresDe(p).forEach(c=>Object.entries(c.ac_cantidades||{}).forEach(([k,v])=>{ if(typeof v==='number'&&v<0) neg.push(`${p.organizacion}: ${k} (${v}) en ${c.lugar_poblado}`); })));
  if(neg.length) falt.push({txt:`<b>${neg.length}</b> cantidad${neg.length===1?'':'es'} negativa${neg.length===1?'':'s'} reportada${neg.length===1?'':'s'} (se excluye de los cálculos)`,sub:neg.map(s=>tag(s,'warn')).join('')});
  const vacios=munis.filter(m=>!programasEnMunicipio(m).length);
  if(vacios.length) falt.push({txt:`<b>${vacios.length}</b> ${plural(vacios.length,'municipio sin registros','municipios sin registros')}`,sub:vacios.map(chipMuni).join('')});
  out.push({id:'o6',icono:'',n:falt.length,titulo:'Información por completar o verificar',
    porque:'Completar estos datos mejora la calidad del mapeo y evita conclusiones apresuradas.',items:falt});
  return out;
}
function renderOportunidades(){
  const sec=$('#view-brechas'); if(!sec) return;
  const tt=$('.section-title',sec); if(tt&&!tt.dataset.rt){ tt.dataset.rt='1'; tt.textContent='Oportunidades de articulación y cobertura'; }
  let box=$('#int-oport'); if(!box){ box=document.createElement('div'); box.id='int-oport'; const ref=$('.int-help',sec)||sec.querySelector('.section-sub')||sec.firstElementChild; ref.after(box); }
  const ops=oportunidades();
  ops.forEach(o=>registrarLista(o.id,o.titulo,()=>`<p class="int-note">${esc(o.porque)}</p><ul class="int-ul">${o.items.map(i=>`<li><div>${i.txt}</div><div class="int-sub2">${i.sub||''}</div></li>`).join('')}</ul>`));
  box.innerHTML=`<div class="int-card"><div class="int-eyebrow">Oportunidades de análisis y coordinación</div>
   <p class="int-note">Situaciones detectadas automáticamente en los registros. No son duplicidades, brechas ni problemas confirmados: son motivos para conversar y verificar.</p>
   <div class="int-oport-grid">${ops.map(o=>`<section class="int-op ${o.n?'':'vacia'}"><div class="int-op-h"><span aria-hidden="true">${o.icono}</span><h4>${esc(o.titulo)}</h4><b>${o.n}</b></div><p class="int-why">${esc(o.porque)}</p>
     ${o.n?`<details><summary>Ver registros (${o.items.length})</summary><ul class="int-ul">${o.items.slice(0,6).map(i=>`<li><div>${i.txt}</div><div class="int-sub2">${i.sub||''}</div></li>`).join('')}</ul>${o.items.length>6?`<button type="button" class="int-link" data-go="lista:${o.id}">Ver los ${o.items.length} registros →</button>`:''}</details>`:'<div class="int-empty">No se detectaron casos con los registros actuales.</div>'}</section>`).join('')}</div></div>`;
  enlazar(box);
}

/* =====================================================================
   POBLACIÓN Y SECTORES: bloque adicional
   ===================================================================== */
function renderPobExtra(){
  const sec=$('#view-poblacion-accion'); if(!sec) return;
  let box=$('#int-pob'); if(!box){ box=document.createElement('div'); box.id='int-pob'; const ref=$('.int-help',sec)||sec.querySelector('.section-sub')||sec.firstElementChild; ref.after(box); }
  // Por grupo: lugares donde se reporta, y referencia = máximo por lugar entre programas (no se suma entre programas)
  const g={}; P.forEach(p=>lugaresDe(p).forEach(c=>(c.poblacion_meta||[]).filter(x=>x!=='Otro').forEach(grupo=>{
    const o=(g[grupo]=g[grupo]||{lugares:new Set(),progs:new Set(),max:{}});
    o.lugares.add(c.k); o.progs.add(idProg(p));
    const n=(c.pm_cantidades||{})[grupo]; if(typeof n==='number'&&n>=0) o.max[c.k]=Math.max(o.max[c.k]||0,n);
  })));
  const filas=Object.entries(g).map(([k,v])=>({k,lug:v.lugares.size,pr:v.progs.size,ref:Object.values(v.max).reduce((a,b)=>a+b,0),conDato:Object.keys(v.max).length})).sort((a,b)=>b.pr-a.pr||b.lug-a.lug);
  const mx=Math.max(1,...filas.map(f=>f.pr));
  const mod=top(cuenta(P.flatMap(p=>p.modalidad||[]),x=>x),10), mxm=Math.max(1,...mod.map(x=>x[1]));
  const bar=(l,v,m,extra)=>`<div class="int-bar"><span>${esc(l)}</span><i style="--w:${(v/m*100).toFixed(1)}%"></i><b>${v}</b>${extra||''}</div>`;
  box.innerHTML=`<div class="int-card"><div class="int-eyebrow">¿A quiénes se dirigen las intervenciones?</div>
   <div class="int-two"><div><h4 class="int-h4" style="margin-top:0">Población objetivo declarada</h4><p class="int-note">Número de programas que declaran cada grupo. La cantidad de referencia usa el valor máximo por lugar y no se suma entre grupos ni programas.</p>
     ${filas.map(f=>bar(f.k,f.pr,mx,`<small>${f.lug} ${plural(f.lug,'lugar','lugares')} · ${f.conDato?'ref. '+fmt(f.ref):'sin cantidad'}</small>`)).join('')||'<div class="int-empty">Sin datos.</div>'}</div>
   <div><h4 class="int-h4" style="margin-top:0">Modalidades de atención</h4><p class="int-note">Un programa puede usar varias modalidades.</p>${mod.map(([k,n])=>bar(k,n,mxm)).join('')}</div></div>
   <p class="int-note warn">Los grupos se traslapan (una mujer agricultora puede estar en dos categorías) y varios programas pueden atender a las mismas personas. Por eso no se presenta un total de personas atendidas.</p></div>`;
}

/* =====================================================================
   PANORAMA: hallazgos con registros de respaldo
   ===================================================================== */
function renderHallazgos(){
  const box=$('#pan-insights'); if(!box||!DATA) return;
  const munis=DATA.municipios||[];
  const H=[];
  const porM=munis.map(m=>({m,ps:programasEnMunicipio(m)})).sort((a,b)=>b.ps.length-a.ps.length);
  if(porM[0]&&porM[0].ps.length){
    const t=porM[0]; const s=top(cuenta(t.ps.flatMap(p=>p.sector||[]),x=>x),3);
    H.push({ic:'',txt:`<b>${esc(t.m)}</b> concentra el mayor número de programas registrados (<b>${t.ps.length}</b>), principalmente en ${lista(s.map(x=>esc(x[0])))}.`,ps:t.ps,ttl:'Programas en '+t.m,tag:'Territorio'});
  }
  const sc=top(cuenta(P.flatMap(p=>p.sector||[]),x=>x),1)[0];
  if(sc){ const ps=P.filter(p=>(p.sector||[]).includes(sc[0])); const mm=uniq(ps.flatMap(munisTodos)); H.push({ic:'',txt:`<b>${esc(sc[0])}</b> es el sector más frecuente: <b>${sc[1]}</b> de ${P.length} programas, con presencia registrada en ${mm.length} ${plural(mm.length,'municipio','municipios')}.`,ps,ttl:'Programas del sector '+sc[0],tag:'Sector'}); }
  const orgsM=munis.map(m=>({m,n:uniq(programasEnMunicipio(m).map(p=>p.organizacion)).length})).sort((a,b)=>b.n-a.n)[0];
  const lug=new Map(); P.forEach(p=>lugaresDe(p).forEach(c=>{ if(!lug.has(c.k)) lug.set(c.k,{c,o:new Set(),ps:[]}); lug.get(c.k).o.add(p.organizacion); lug.get(c.k).ps.push(p); }));
  const multi=[...lug.values()].filter(x=>x.o.size>=2);
  if(multi.length){ const ps=uniq(multi.flatMap(x=>x.ps)); H.push({ic:'',txt:`En <b>${multi.length}</b> ${plural(multi.length,'lugar poblado','lugares poblados')} dos o más organizaciones registran atención. Es una oportunidad para conocerse y complementar.`,ps,ttl:'Programas en lugares con varias organizaciones',tag:'Oportunidad',cls:'ok'}); }
  const pc=P.filter(porCerrar);
  if(pc.length) H.push({ic:'',txt:`<b>${pc.length}</b> ${plural(pc.length,'programa finaliza','programas finalizan')} pronto. Conviene prever la continuidad en esos territorios.`,ps:pc,ttl:'Programas por finalizar',tag:'Vigencia',cls:'warn'});
  const ct=top(cuenta(P.flatMap(contrapartesDe),x=>x),1)[0];
  if(ct){ const ps=P.filter(p=>contrapartesDe(p).includes(ct[0])); H.push({ic:'',txt:`<b>${esc(ct[0])}</b> es la contraparte más reportada (<b>${ct[1]}</b> programas).`,ps,ttl:'Programas con contraparte '+ct[0],tag:'Articulación'}); }
  const sinInv=P.filter(p=>!RANGOS[p.monto_rango_codigo]);
  if(sinInv.length) H.push({ic:'',txt:`<b>${sinInv.length}</b> de ${P.length} programas prefieren no indicar su rango de inversión; por eso la inversión reportada es una referencia parcial.`,ps:sinInv,ttl:'Programas sin rango de inversión',tag:'Calidad del dato',cls:'gold'});
  H.forEach((h,i)=>{ registrarLista('h'+i,h.ttl,()=>tablaProgs(h.ps)); });
  box.innerHTML=H.map((h,i)=>`<div class="insight int-hall ${h.cls||''}"><div class="i-tag">${h.ic} ${esc(h.tag||'Lectura')}</div><div class="i-text" style="font-size:15px;margin-top:6px">${h.txt}</div><button type="button" class="int-link" data-go="lista:h${i}">Ver registros (${h.ps.length}) →</button></div>`).join('');
  enlazar(box);
}


/* =====================================================================
   INICIO: consultas rápidas orientadas a decisiones + los 11 municipios
   ===================================================================== */
const PREGUNTAS = {
  panorama:'¿Qué está pasando en el territorio y a quién debo consultar?',
  mapa:'¿En qué comunidades hay intervenciones registradas y dónde no?',
  municipio:'¿Quién trabaja en mi municipio y en qué comunidades?',
  instituciones:'¿Quién trabaja en el territorio y qué hace cada organización?',
  articulacion:'¿Qué instituciones mencionan como contrapartes y en qué espacios?',
  inversion:'¿Qué recursos financieros reporta la cooperación?',
  'poblacion-accion':'¿A quiénes se dirigen las intervenciones y en qué temas?',
  brechas:'¿Dónde existen oportunidades de complementariedad para conversar y coordinar?'
};
function insertarPreguntas(){
  Object.entries(PREGUNTAS).forEach(([id,t])=>{
    const sec=$('#view-'+id); if(!sec||$('.int-pregunta',sec)) return;
    const d=document.createElement('p'); d.className='int-pregunta'; d.innerHTML='<b>Esta vista responde:</b> '+esc(t);
    const ref=sec.querySelector('.section-sub')||sec.querySelector('.section-title');
    if(ref&&ref.parentNode===sec) ref.after(d); else if(id==='panorama') sec.prepend(d);
  });
}
function nombresMunicipios(){ return (DATA.municipios||[]).slice().sort(cmp); }
function opciones(arr,vacio){ return (vacio?`<option value="">${esc(vacio)}</option>`:'')+arr.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join(''); }
function resultadoProgramas(titulo,progs,nota){
  const orgs=uniq(progs.map(p=>p.organizacion)).sort(cmp), munis=uniq(progs.flatMap(munisTodos)).sort(cmp);
  if(!progs.length){ abrir(titulo,`<div class="int-empty">No hay programas registrados que coincidan con esta consulta.</div><p class="int-note">Esto no significa que no exista cooperación: solo que nadie la ha reportado todavía con esas características.</p>`); return; }
  abrir(titulo,`<div class="int-kpis">${kpi(orgs.length,plural(orgs.length,'organización','organizaciones'))}${kpi(progs.length,plural(progs.length,'programa','programas'))}${kpi(munis.length,plural(munis.length,'municipio','municipios'))}</div>
   <h4 class="int-h4">Organizaciones</h4><div>${orgs.map(chipOrg).join('')}</div>
   <h4 class="int-h4">Municipios con presencia registrada</h4><div>${munis.map(chipMuni).join('')}</div>
   <h4 class="int-h4">Programas</h4>${tablaProgs(progs)}${nota?`<p class="int-note">${nota}</p>`:''}`);
}
function sectoresLista(){ return uniq(P.flatMap(p=>p.sector||[])).sort(cmp); }
function poblacionesLista(){ return uniq(P.flatMap(p=>lugaresDe(p).flatMap(c=>c.poblacion_meta||[]))).filter(x=>x!=='Otro').sort(cmp); }
function nombreLugares(){
  const out=new Map(); const mc=(CATALOGO&&CATALOGO.choices&&CATALOGO.choices.municipios)||{};
  if(CATALOGO&&CATALOGO.lugares_poblados) Object.entries(CATALOGO.lugares_poblados).forEach(([cod,m])=>out.set(cod,{cod,lugar:m.lugar_poblado,muni:mc[m.municipio_codigo]||m.municipio_codigo}));
  P.forEach(p=>lugaresDe(p).forEach(c=>{ if(!out.has(c.k)) out.set(c.k,{cod:c.k,lugar:c.lugar_poblado,muni:c.municipio}); }));
  return [...out.values()];
}
function renderConsultas(){
  const sec=$('#view-panorama'); if(!sec||!DATA) return;
  let box=$('#int-consultas'); if(box) return;
  box=document.createElement('div'); box.id='int-consultas'; box.className='pan-sec';
  const M=nombresMunicipios();
  const lugares=nombreLugares();
  box.innerHTML=`<h3>Consultas rápidas</h3><p class="sub">Elija una pregunta, complete los datos y consulte. Cada respuesta muestra los registros que la sustentan.</p>
  <div class="int-consultas">
   <div class="int-cons"><p>¿Qué organizaciones trabajan en <select id="q1m" aria-label="Municipio">${opciones(M)}</select>?</p><button type="button" class="int-btn" id="q1b">Ver el municipio</button></div>
   <div class="int-cons"><p>¿Quién trabaja el sector <select id="q2s" aria-label="Sector">${opciones(sectoresLista())}</select> en <select id="q2m" aria-label="Municipio">${opciones(M,'todo el departamento')}</select>?</p><button type="button" class="int-btn" id="q2b">Consultar</button></div>
   <div class="int-cons"><p>¿Quién atiende a <select id="q3p" aria-label="Población">${opciones(poblacionesLista())}</select> en <select id="q3m" aria-label="Municipio">${opciones(M,'todo el departamento')}</select>?</p><button type="button" class="int-btn" id="q3b">Consultar</button></div>
   <div class="int-cons"><p>¿Qué se ha registrado en la comunidad <input id="q4l" list="q4dl" placeholder="escriba el nombre" aria-label="Lugar poblado" autocomplete="off"><datalist id="q4dl">${lugares.map(l=>`<option value="${esc(l.lugar)} (${esc(l.muni)})">`).join('')}</datalist>?</p><button type="button" class="int-btn" id="q4b">Consultar</button></div>
   <div class="int-cons"><p>¿Con quién articula <select id="q5c" aria-label="Institución">${opciones(uniq(P.flatMap(contrapartesDe)).sort(cmp))}</select>?</p><button type="button" class="int-btn" id="q5b">Ver articulación</button></div>
   <div class="int-cons"><p>¿Qué programas terminan en los próximos ${MESES_CIERRE} meses?</p><button type="button" class="int-btn" id="q6b">Ver programas</button></div>
  </div>`;
  const ref=$('.pan-hero',sec); ref.after(box);
  const v=id=>$('#'+id).value;
  $('#q1b').onclick=()=>irAMunicipio(v('q1m'));
  $('#q2b').onclick=()=>{ const s=v('q2s'),m=v('q2m'); resultadoProgramas(`Sector ${s}${m?' en '+m:' en todo el departamento'}`,P.filter(p=>(p.sector||[]).includes(s)&&(!m||munisTodos(p).includes(m))),m?`Incluye programas con lugares poblados registrados en ${esc(m)} o con fortalecimiento institucional declarado para ese municipio.`:''); };
  $('#q3b').onclick=()=>{ const g=v('q3p'),m=v('q3m'); resultadoProgramas(`Población: ${g}${m?' en '+m:' en todo el departamento'}`,P.filter(p=>lugaresDe(p).some(c=>(c.poblacion_meta||[]).includes(g)&&(!m||c.municipio===m))),'La población corresponde a la que cada organización declaró para cada lugar poblado. No indica cuántas personas se atienden.'); };
  $('#q4b').onclick=()=>{
    const t=sinAcento(v('q4l')).trim(); if(!t) return;
    const hit=lugares.find(l=>sinAcento(`${l.lugar} (${l.muni})`)===t)||lugares.find(l=>sinAcento(l.lugar)===t);
    if(!hit){ abrir('Comunidad no encontrada',`<div class="int-empty">No encontré "${esc(v('q4l'))}" en el catálogo. Elija un nombre de la lista que aparece al escribir.</div>`); return; }
    const hay=P.some(p=>lugaresDe(p).some(c=>c.k===hit.cod));
    if(hay) fichaLugar(hit.cod);
    else abrir(hit.lugar,`<div class="int-sub">${chipMuni(hit.muni)}</div><div class="int-kpis">${kpi('Sin registro','atención registrada')}</div><p class="int-note">Ninguna organización ha registrado atención en este lugar poblado. Esto no confirma que no exista cooperación: puede no haber sido reportada. Para completar el mapeo, invite a las organizaciones presentes a registrarlo en el formulario.</p>`);
  };
  $('#q5b').onclick=()=>{ seleccionarContra(v('q5c')); mostrarVista('articulacion'); setTimeout(()=>seleccionarContra(v('q5c')),80); };
  $('#q6b').onclick=()=>resultadoProgramas(`Programas que terminan en los próximos ${MESES_CIERRE} meses`,P.filter(porCerrar).sort((a,b)=>(fechaFin(a)||new Date(9e12))-(fechaFin(b)||new Date(9e12))),'Incluye programas marcados como "Próximo a finalizar" y los que declaran fecha de fin dentro del plazo.');
}
function renderTablaMunicipios(){
  const sec=$('#view-panorama'); if(!sec||!DATA) return;
  let box=$('#int-tmun');
  if(!box){ box=document.createElement('div'); box.id='int-tmun'; box.className='pan-sec'; const ref=$('#int-consultas')||$('.pan-hero',sec); ref.after(box); }
  const ds=nombresMunicipios().map(datosMunicipio).sort((a,b)=>b.progs.length-a.progs.length||cmp(a.m,b.m));
  const maxP=Math.max(0.0001,...ds.map(d=>d.total?d.lugCat.length/d.total:0));
  box.innerHTML=`<h3>Los ${ds.length} municipios de un vistazo</h3><p class="sub">Haga clic en un municipio para ver su ficha. "Sin registros" significa que ninguna organización ha reportado programas allí, no que no haya cooperación.</p>
   <div class="int-tbl-wrap"><table class="int-tabla-m"><thead><tr><th>Municipio</th><th class="num">Organizaciones</th><th class="num">Programas</th><th>Lugares con atención registrada</th><th>Sectores más frecuentes</th><th class="num">Por finalizar</th></tr></thead><tbody>${ds.map(d=>`<tr data-go="muni:${esc(d.m)}" tabindex="0"><td><b>${esc(d.m)}</b></td><td class="num">${d.orgs.length||'<span class="int-empty">sin registros</span>'}</td><td class="num">${d.progs.length||''}</td><td><span class="int-mini"><i style="width:${d.total&&maxP?(d.lugCat.length/d.total)/maxP*100:0}%"></i></span>${d.lugCat.length} de ${d.total||'?'}</td><td>${esc(d.sect.slice(0,2).map(x=>x[0]).join(', ')||'')}</td><td class="num">${d.cierre.length||''}</td></tr>`).join('')}</tbody></table></div>
   <p class="int-note">La barra compara el porcentaje de lugares con atención registrada entre municipios (la más larga es la mayor proporción); el número exacto aparece a la derecha. <button type="button" class="int-link" id="int-tmun-csv">Descargar CSV</button></p>`;
  enlazar(box);
  $$('tbody tr',box).forEach(tr=>tr.addEventListener('keydown',e=>{ if(e.key==='Enter') ir(tr.dataset.go); }));
  $('#int-tmun-csv').onclick=()=>csv('municipios_resumen.csv',[['Municipio','Organizaciones','Programas','Lugares con atención registrada','Lugares en catálogo','Sectores más frecuentes','Programas por finalizar'],...ds.map(d=>[d.m,d.orgs.length,d.progs.length,d.lugCat.length,d.total,d.sect.slice(0,3).map(x=>x[0]).join('; '),d.cierre.length])]);
}


/* =====================================================================
   PANORAMA v3: primero el departamento ("Chiquimula en conjunto"), después los municipios.
   Solo reorganiza y presenta; no cambia datos ni cálculos. Los rangos de inversión no se suman
   y no se muestra población en esta vista.
   ===================================================================== */
const ESTADOS={
  rep:{t:'Reportado por organización',d:'Lo escribió o marcó la organización en Kobo; el visor no lo ha contrastado con otra fuente.'},
  cal:{t:'Calculado por el visor',d:'Conteo o clasificación hecha por el visor a partir de lo reportado.'},
  ver:{t:'Verificado',d:'Contrastado con otra fuente o validado por SEGEPLAN/CRS. Hoy ningún dato se presenta con este estado.'}
};
function etq(k){ return `<span class="int-est ${k}" title="${esc(ESTADOS[k].d)}">${k==='ver'?'✓ ':''}${esc(ESTADOS[k].t)}</span>`; }
function barraSimple(nombre,n,mx,extra){ return `<div class="pv3-bar"><span>${esc(nombre)}</span><i style="--w:${(mx?n/mx*100:0).toFixed(1)}%"></i><b>${n}</b>${extra||''}</div>`; }

function renderPanoramaV3(){
  const sec=$('#view-panorama'); if(!sec||!DATA||!$('#pan-hero')) return;
  const M=nombresMunicipios();
  const datos=M.map(datosMunicipio);
  // --- Nivel 1: departamento
  const orgTipo=new Map(); P.forEach(p=>{ if(!orgTipo.has(p.organizacion)) orgTipo.set(p.organizacion,p.tipo_actor||'Sin dato'); });
  const porTipo=top(cuenta([...orgTipo.values()],x=>x),20);
  const porEstado=top(cuenta(P.map(p=>p.estado_programa||'Sin dato'),x=>x),6);
  const dr=distRangos(P); const mxR=Math.max(1,...dr.filas.map(f=>f.n),dr.sin);
  const munisConPres=datos.filter(d=>d.progs.length>0).length;
  const lugPres=new Set(); P.forEach(p=>(p.comunidades||[]).forEach(c=>{ if(c.codigo_lugar&&c.lat!==null&&c.lat!==undefined&&c.lat!=='') lugPres.add(c.codigo_lugar); }));
  const georef=(DATA.control&&DATA.control.lugares_con_coordenadas)||0;
  const conjunto=`
   <h3 class="pv3-h">Chiquimula en conjunto</h3>
   <div class="pv3-cards">
    <div class="pv3-card"><h4>Actores de la cooperación ${etq('cal')}</h4><b class="pv3-big">${orgTipo.size}</b><span class="pv3-sub">${plural(orgTipo.size,'organización','organizaciones')} con programas reportados</span>
      ${porTipo.map(([k,n])=>`<div class="pv3-li"><span>${esc(k)}</span><b>${n}</b></div>`).join('')}</div>
    <div class="pv3-card"><h4>Programas y proyectos ${etq('cal')}</h4><b class="pv3-big">${P.length}</b><span class="pv3-sub">${plural(P.length,'programa o proyecto','programas y proyectos')} reportados</span>
      ${porEstado.map(([k,n])=>`<div class="pv3-li"><span>${esc(k)}</span><b>${n}</b></div>`).join('')}</div>
    <div class="pv3-card"><h4>Inversión reportada ${etq('cal')}</h4><span class="pv3-sub">Programas según el rango que declaró cada organización</span>
      ${dr.filas.map(f=>barraSimple(f.etq,f.n,mxR)).join('')}${barraSimple('Prefiere no indicar',dr.sin,mxR)}
      <p class="pv3-aviso">Cuenta programas por rango. <b>Los rangos no se suman</b>: no equivalen a un presupuesto total.</p></div>
    <div class="pv3-card"><h4>Cobertura territorial ${etq('cal')}</h4><b class="pv3-big">${munisConPres}<small> de ${M.length}</small></b><span class="pv3-sub">municipios con presencia registrada</span>
      <div class="pv3-li"><span>Lugares poblados con atención comunitaria registrada</span><b>${fmt(lugPres.size)} de ${fmt(georef)}</b></div>
      <p class="pv3-aviso">La ausencia de registro no confirma ausencia de cooperación.</p></div>
   </div>`;
  const accesos=`
   <div class="pv3-accesos">
    <button type="button" class="pv3-destacado" data-nav="brechas"><b>◆ Oportunidades de articulación</b><span>¿Dónde varias organizaciones coinciden en un mismo lugar o sector? Son motivos para conversar y complementar, no alianzas ni duplicidades confirmadas.</span><i>Ver oportunidades de articulación →</i></button>
    <div class="pv3-accesos-grid">
     <button type="button" data-nav="mapa"><b>Mapa territorial</b><small>¿En qué comunidades hay intervenciones registradas?</small></button>
     <button type="button" data-nav="instituciones"><b>Organizaciones</b><small>¿Quién trabaja en el territorio y qué hace?</small></button>
     <button type="button" data-nav="articulacion"><b>Coordinación</b><small>¿Qué instituciones se mencionan como contrapartes?</small></button>
     <button type="button" data-nav="inversion"><b>Inversión</b><small>¿Qué rangos de inversión se reportan?</small></button>
    </div>
   </div>`;
  // --- Nivel 2: municipios (dos indicadores separados, sin mezclarlos)
  const menosProg=datos.slice().sort((a,b)=>a.progs.length-b.progs.length||cmp(a.m,b.m)).slice(0,5);
  const menosLug=datos.slice().sort((a,b)=>a.lugCat.length-b.lugCat.length||cmp(a.m,b.m)).slice(0,5);
  const fila=(m,txt)=>`<button type="button" class="pv3-row" data-muni="${esc(m)}"><span>${esc(m)}</span><b>${txt}</b></button>`;
  const cierre=P.filter(porCerrar).sort((a,b)=>(fechaFin(a)||new Date(9e12))-(fechaFin(b)||new Date(9e12)));
  const secs=top(cuenta(P.flatMap(p=>p.sector||[]),x=>x),5); const mxS=Math.max(1,...secs.map(x=>x[1]));
  const nivel2=`
   <div class="pv3-grid2">
    <div class="pv3-card"><h4>Municipios con menos programas registrados ${etq('cal')}</h4>
      <p class="pv3-sub">Cuenta los programas con presencia comunitaria o institucional en el municipio.</p>
      ${menosProg.map(d=>fila(d.m,d.progs.length===0?'sin programas registrados':`${d.progs.length} ${plural(d.progs.length,'programa','programas')}`)).join('')}
      <p class="pv3-aviso">Menos programas registrados no significa menos cooperación: puede haber programas aún no reportados.</p></div>
    <div class="pv3-card"><h4>Municipios con menos lugares con atención comunitaria registrada ${etq('cal')}</h4>
      <p class="pv3-sub">Cuenta lugares poblados del catálogo con atención comunitaria registrada. La presencia institucional o municipal no se cuenta aquí.</p>
      ${menosLug.map(d=>fila(d.m,`${d.lugCat.length} de ${fmt(d.total)} ${plural(d.total,'lugar','lugares')}`)).join('')}
      <p class="pv3-aviso">Un lugar sin registro no es un lugar sin cooperación: solo indica que nadie ha reportado atención allí.</p></div>
   </div>
   <div class="pv3-grid2">
    <div class="pv3-card"><h4>¿Qué proyectos están por finalizar? ${etq('rep')}</h4>
      <p class="pv3-sub">Fechas y estados tal como los declaró cada organización.</p>
      ${cierre.slice(0,5).map(p=>`<div class="pv3-prog"><b>${esc(p.nombre_programa||'(sin nombre)')}</b><span>${esc(p.organizacion)}${p.fecha_fin?' · fin '+esc(p.fecha_fin):''}</span><small>${esc(munisTodos(p).join(', ')||'sin municipio indicado')}</small></div>`).join('')||'<div class="int-empty">Ningún programa reporta cierre próximo.</div>'}
      ${cierre.length?`<button type="button" class="int-link" id="pv3-cierre">Ver los ${cierre.length} ${plural(cierre.length,'programa','programas')} →</button>`:''}</div>
    <div class="pv3-card"><h4>¿Qué sectores concentran más intervenciones? ${etq('cal')}</h4>
      ${secs.map(([k,n])=>barraSimple(k,n,mxS)).join('')}
      <button type="button" class="int-link" data-nav="brechas">Ver matriz sector × municipio →</button></div>
   </div>`;
  const leyenda=`
   <div class="pv3-leyenda">
    <h4>Cómo leer los colores y las etiquetas</h4>
    <div class="pv3-leg">
     <div><span class="map-symbol community"></span><b>Cooperación comunitaria registrada</b><small>círculo sólido azul profundo</small></div>
     <div><span class="map-symbol institutional"></span><b>Presencia institucional o municipal</b><small>círculo con anillo azul medio</small></div>
     <div><span class="map-symbol territorial"></span><b>Lugar poblado de referencia</b><small>punto pequeño hueco</small></div>
     <div><span class="int-est pend">Pendiente</span><b>Información pendiente de completar</b><small>etiqueta naranja con texto</small></div>
     <div><span class="int-est opo">◆ Oportunidad</span><b>Oportunidad potencial de articulación</b><small>etiqueta naranja suave con símbolo</small></div>
    </div>
    <div class="pv3-leg">
     <div>${etq('rep')}<small>${esc(ESTADOS.rep.d)}</small></div>
     <div>${etq('cal')}<small>${esc(ESTADOS.cal.d)}</small></div>
     <div>${etq('ver')}<small>${esc(ESTADOS.ver.d)}</small></div>
    </div>
    <p class="int-note">El naranja solo indica "revisar, completar u oportunidad". No es una clasificación oficial de prioridad ni de riesgo.</p>
   </div>`;
  // --- montaje (una sola vez) y refresco de los bloques dinámicos
  let v3=$('#pv3',sec);
  if(!v3){
    v3=document.createElement('div'); v3.id='pv3';
    v3.innerHTML='<div id="pv3-conjunto"></div><div id="pv3-accesos"></div><h3 class="pv3-h">Qué pasa en los municipios</h3><div id="pv3-tmun"></div><div id="pv3-nivel2"></div>';
    $('#pan-hero').after(v3);
    const det=document.createElement('details'); det.id='pv3-detalle'; det.className='int-fold';
    det.innerHTML='<summary>Más detalle del Panorama: consultas rápidas, lecturas automáticas, gráficas y guía de colores</summary><div class="int-fold-body"></div>';
    v3.after(det);
    const cuerpo=det.querySelector('.int-fold-body');
    const mover=el=>{ if(el) cuerpo.appendChild(el); };
    mover($('#int-consultas',sec));
    const ins=$('#pan-insights'); mover(ins&&ins.closest('.pan-sec'));
    const cob=$('#pan-cobertura'); mover(cob&&cob.closest('.pan-grid'));
    const exp=$('#pan-explore'); mover(exp&&exp.closest('.pan-sec'));
    const ley=document.createElement('div'); ley.id='pv3-ley'; cuerpo.appendChild(ley);
    const tm=$('#int-tmun',sec); if(tm) $('#pv3-tmun',v3).appendChild(tm);
    v3.addEventListener('click',e=>{
      const nav=e.target.closest('[data-nav]'); if(nav){ mostrarVista(nav.dataset.nav); window.scrollTo({top:0,behavior:'smooth'}); return; }
      const mu=e.target.closest('[data-muni]'); if(mu){ irAMunicipio(mu.dataset.muni); return; }
      if(e.target.id==='pv3-cierre') resultadoProgramas(`Programas que terminan en los próximos ${MESES_CIERRE} meses`,P.filter(porCerrar).sort((a,b)=>(fechaFin(a)||new Date(9e12))-(fechaFin(b)||new Date(9e12))),'Incluye programas marcados como "Próximo a finalizar" y los que declaran fecha de cierre dentro del plazo.');
    });
  }
  $('#pv3-conjunto',v3).innerHTML=conjunto; $('#pv3-accesos',v3).innerHTML=accesos; $('#pv3-nivel2',v3).innerHTML=nivel2; $('#pv3-ley').innerHTML=leyenda;
}


/* =====================================================================
   EXPLORADOR: mapa + panel de navegación Chiquimula > municipio > comunidad > organización > proyecto
   El mapa original (Leaflet, límites CONRED, filtros) se conserva; este bloque
   reemplaza únicamente el contenido del panel lateral y lo mantiene sincronizado.
   ===================================================================== */
const NAV={muni:'',lugar:''};
function leerControles(){ const tm=$('#t-municipio'),tl=$('#t-lugar'); NAV.muni=tm?tm.value:''; NAV.lugar=tl?tl.value:''; }
function filtroMapaDesdePila(){
  const t=pila[pila.length-1]; ST.mapOrg=(t&&t.m&&t.m.org)||''; ST.mapProg=(t&&t.m&&t.m.prog!=null)?t.m.prog:null;
}
function navegar(muni,lugar,keep){
  NAV.muni=muni||''; NAV.lugar=lugar||''; if(keep==null) pila=[]; else pila.length=keep;
  sincronizarMapa();
}
function sincronizarMapa(){
  filtroMapaDesdePila();
  const tm=$('#t-municipio'),tl=$('#t-lugar');
  if(!tm||!tl||typeof renderMapaYStats!=='function'||typeof basePlaces==='undefined'||!basePlaces.length){ pintarPanel(); return; }
  if(tm.value!==NAV.muni && [...tm.options].some(o=>o.value===NAV.muni)){
    tm.value=NAV.muni; filtros.municipio=NAV.muni; const fm=$('#f-municipio'); if(fm) fm.value=NAV.muni;
    tl.innerHTML='<option value="">Lugar poblado: todos</option>';
    basePlaces.filter(p=>!NAV.muni||p.municipio===NAV.muni).sort((a,b)=>a.lugar.localeCompare(b.lugar,'es')).forEach(p=>tl.add(new Option(`${p.lugar} · ${p.clasificacion||'Lugar poblado'}`,p.codigo)));
    tl.disabled=!NAV.muni;
  }
  tl.value=[...tl.options].some(o=>o.value===NAV.lugar)?NAV.lugar:'';
  ST.keep=true; try{ renderMapaYStats(); }catch(e){ console.error(e); } finally{ ST.keep=false; }
  pintarPanel();
}
function alcance(){ const m=NAV.muni; return {m,progs:m?programasEnMunicipio(m):P,et:m?m:'todo Chiquimula'}; }

/* --- Buscador único --- */
function buscadorHtml(){
  return `<div class="int-sb"><input id="int-sq" type="search" placeholder="Buscar municipio, comunidad, organización o proyecto" aria-label="Buscar en el visor" autocomplete="off"><div id="int-sres" class="int-sres"></div></div>`;
}
function buscar(q){
  q=sinAcento(q).trim(); if(q.length<2) return '';
  const fila=(go,n,t)=>`<button type="button" class="int-res" data-go="${go}"><b>${esc(n)}</b><small>${esc(t)}</small></button>`;
  const regs=new Set(P.flatMap(p=>lugaresDe(p).map(c=>c.k)));
  const out=[];
  nombresMunicipios().filter(m=>sinAcento(m).includes(q)).slice(0,3).forEach(m=>out.push(fila('muni:'+m,m,'Municipio')));
  nombreLugares().filter(l=>sinAcento(l.lugar).includes(q)).sort((a,b)=>(regs.has(b.cod)-regs.has(a.cod))||cmp(a.lugar,b.lugar)).slice(0,7).forEach(l=>out.push(fila('lugar:'+l.cod,l.lugar,`Comunidad · ${l.muni}${regs.has(l.cod)?' · con atención registrada':''}`)));
  uniq(P.map(p=>p.organizacion)).filter(o=>sinAcento(o).includes(q)).sort(cmp).slice(0,4).forEach(o=>out.push(fila('org:'+o,o,'Organización')));
  P.filter(p=>sinAcento(nombreProg(p)).includes(q)).slice(0,4).forEach(p=>out.push(fila('prog:'+idProg(p),nombreProg(p),'Proyecto · '+p.organizacion)));
  return out.join('')||'<div class="int-empty">Sin resultados. Pruebe con otra palabra.</div>';
}

/* --- Preguntas --- */
function preguntasHtml(){
  const a=alcance(); const en=a.m?`en ${a.m}`:'en Chiquimula';
  const orgs=uniq(a.progs.map(p=>p.organizacion)).length;
  const ops=oportunidades(a.m?[a.m]:null); const nOp=ops.filter(o=>o.id!=='o6'||true).reduce((s,o)=>s+(o.id==='o6'?0:o.n),0);
  const co=top(cuenta(a.progs.flatMap(contrapartesDe),x=>x),99).length;
  const items=[
    [1,`¿Qué organizaciones trabajan ${en}?`,`${orgs}`],
    [2,'¿Qué proyectos ejecutan, en qué sectores y en qué comunidades?',`${a.progs.length}`],
    [3,'¿Cuáles son los rangos de inversión reportados?',`${a.progs.filter(p=>RANGOS[p.monto_rango_codigo]).length} con rango`],
    [4,'¿Con qué instituciones coordinan?',`${co}`],
    [5,'¿Dónde coinciden varias intervenciones?',`${ops[0].n+ops[1].n}`],
    [6,'¿Qué oportunidades de coordinación y complementariedad existen?',`${nOp}`],
  ];
  return `<div class="int-pq-list">${items.map(([n,t,c])=>`<button type="button" class="int-pq" data-go="preg:${n}"><span>${esc(t)}</span><b>${esc(c)}</b></button>`).join('')}</div>`;
}
function pregunta(n){
  const a=alcance(); const et=a.et, pg=a.progs;
  if(n===1){
    const orgs=uniq(pg.map(p=>p.organizacion)).sort(cmp);
    abrir(`Organizaciones en ${et}`,`<p class="int-note">Organizaciones con programas que tienen lugares poblados registrados${a.m?' en el municipio o fortalecimiento institucional declarado para él':''}.</p>`+
      (orgs.length?orgs.map(o=>{ const ps=pg.filter(p=>p.organizacion===o); const sec=uniq(ps.flatMap(p=>p.sector||[])); const lg=new Set(ps.flatMap(p=>lugaresDe(p).filter(c=>!a.m||c.municipio===a.m).map(c=>c.k)));
        return `<div class="int-prog" data-go="org:${esc(o)}"><b>${esc(o)}</b><div>${tag(ps[0].tipo_actor||'Tipo no indicado')}${tag(ps.length+' '+plural(ps.length,'programa','programas'))}${tag(lg.size+' '+plural(lg.size,'comunidad','comunidades'))}</div><small>${esc(sec.slice(0,4).join(' · ')||'Sin sectores')}</small></div>`; }).join(''):'<div class="int-empty">Ninguna organización registrada.</div>'));
  } else if(n===2){
    const sec=top(cuenta(pg.flatMap(p=>p.sector||[]),x=>x),20), mx=Math.max(1,...sec.map(x=>x[1]));
    const lg=new Set(pg.flatMap(p=>lugaresDe(p).filter(c=>!a.m||c.municipio===a.m).map(c=>c.k)));
    abrir(`Proyectos en ${et}`,`<div class="int-kpis">${kpi(pg.length,plural(pg.length,'proyecto','proyectos'))}${kpi(sec.length,plural(sec.length,'sector','sectores'))}${kpi(lg.size,plural(lg.size,'comunidad con atención','comunidades con atención'))}</div>
     <h4 class="int-h4">Sectores</h4>${sec.map(([s,c])=>`<div class="int-bar"><span>${esc(s)}</span><i style="--w:${(c/mx*100).toFixed(1)}%"></i><b>${c}</b></div>`).join('')||'<div class="int-empty">Sin sectores.</div>'}
     <h4 class="int-h4">Proyectos</h4><div>${pg.map(p=>`<div class="int-prog" data-go="prog:${idProg(p)}"><b>${esc(nombreProg(p))}</b><div>${esc(p.organizacion)}</div><small>${esc((p.sector||[]).join(', ')||'sin sector')} · ${esc(p.estado_programa||'sin estado')} · ${lugaresDe(p).filter(c=>!a.m||c.municipio===a.m).length} comunidades</small></div>`).join('')||'<div class="int-empty">Sin proyectos.</div>'}</div>`);
  } else if(n===3){
    const dr=distRangos(pg), alto=rangoMasAlto(pg);
    abrir(`Rangos de inversión en ${et}`,`<div class="int-kpis">${kpi(`${dr.con} de ${dr.total}`,'programas con rango declarado')}${kpi(alto?esc(alto.etq):'—','rango más alto declarado',alto?`${alto.n} ${plural(alto.n,'programa','programas')}`:'')}</div>
     <h4 class="int-h4">Programas por rango declarado</h4>${rangosHtml(pg)}
     <h4 class="int-h4">Programas</h4>${pg.slice().sort((x,y)=>((RANGOS[y.monto_rango_codigo]||{ord:0}).ord)-((RANGOS[x.monto_rango_codigo]||{ord:0}).ord)).map(p=>`<div class="int-prog" data-go="prog:${idProg(p)}"><b>${esc(nombreProg(p))}</b><div>${esc(p.organizacion)} ${tag(p.monto_rango||'Sin dato')}</div></div>`).join('')}
     <p class="int-note warn"><b>Por qué no hay un total.</b> ${NOTA_RANGOS}${a.m?` En ${esc(a.m)} se listan los programas con presencia allí; el presupuesto de cada uno no se reparte ni se atribuye al municipio.`:''}</p>`);
  } else if(n===4){
    const co=cuenta(pg.flatMap(p=>contrapartesDe(p).map(c=>c)),x=>x);
    const dist={}; pg.forEach(p=>contrapartesDe(p).forEach(c=>{ (dist[c]=dist[c]||new Set()).add(p.organizacion); }));
    const esp={}; pg.forEach(p=>uniq((p.espacios_coordinacion||[]).filter(e=>e!=='No participa')).forEach(e=>{ (esp[e]=esp[e]||new Set()).add(p.organizacion); }));
    const ord=o=>Object.entries(o).sort((x,y)=>y[1].size-x[1].size||cmp(x[0],y[0]));
    abrir(`Coordinación en ${et}`,`<h4 class="int-h4" style="margin-top:0">Contrapartes y aliados reportados</h4><div>${ord(dist).map(([k,s])=>`<button type="button" class="int-chip alt" data-go="contra:${esc(k)}">${esc(k)} <small>${s.size} org.</small></button>`).join('')||'<span class="int-empty">Sin contrapartes reportadas.</span>'}</div>
     <h4 class="int-h4">Espacios de coordinación en los que participan</h4><div>${ord(esp).map(([k,s])=>`<span class="int-chip">${esc(k)} <small>${s.size} org.</small></span>`).join('')||'<span class="int-empty">Sin participación reportada.</span>'}</div>
     <p class="int-note warn">Compartir una contraparte o un espacio no significa que dos organizaciones trabajen juntas, ni que participar implique coordinación efectiva.</p>
     <div class="int-actions"><button type="button" class="int-btn" id="int-ir-art">Abrir la vista Coordinación</button></div>`,r=>{ $('#int-ir-art',r).onclick=()=>mostrarVista('articulacion'); });
  } else if(n===5||n===6){
    const ops=oportunidades(a.m?[a.m]:null); const ver=n===5?ops.filter(o=>o.id==='o1'||o.id==='o2'):ops;
    ver.forEach(o=>registrarLista('q'+n+o.id,o.titulo,()=>`<p class="int-note">${esc(o.porque)}</p><ul class="int-ul">${o.items.map(i=>`<li><div>${i.txt}</div><div class="int-sub2">${i.sub||''}</div></li>`).join('')}</ul>`));
    abrir(n===5?`Coincidencias en ${et}`:`Oportunidades en ${et}`,`<p class="int-note">Situaciones detectadas automáticamente en los registros. No son duplicidades, brechas ni problemas confirmados: son motivos para conversar y verificar.</p>`+ver.map(o=>`<section class="int-op ${o.n?'':'vacia'}" style="margin:10px 0"><div class="int-op-h"><h4>${esc(o.titulo)}</h4><b>${o.n}</b></div><p class="int-why">${esc(o.porque)}</p>${o.n?`<ul class="int-ul">${o.items.slice(0,4).map(i=>`<li><div>${i.txt}</div><div class="int-sub2">${i.sub||''}</div></li>`).join('')}</ul>${o.items.length>4?`<button type="button" class="int-link" data-go="lista:q${n}${o.id}">Ver los ${o.items.length} registros →</button>`:''}`:'<div class="int-empty">No se detectaron casos con los registros actuales.</div>'}</section>`).join(''));
  }
}

/* --- Niveles del panel --- */
function rolesHtml(){
  const ms=nombresMunicipios().slice().sort(cmp);
  return `<div class="int-roles"><h4 class="int-h4" style="margin-top:0">Empiece aquí</h4>
   <div class="int-rol"><b>Soy de un municipio</b><span>Elija el suyo y vea quién trabaja allí, dónde y qué oportunidades hay.</span><select id="int-rol-m" aria-label="Mi municipio"><option value="">Elegir municipio…</option>${ms.map(m=>`<option>${esc(m)}</option>`).join('')}</select></div>
   <div class="int-rol"><b>Trabajo en planificación o territorio</b><span>Vea dónde coinciden varias intervenciones y qué oportunidades de coordinación existen.</span><div><button type="button" class="int-btn" data-go="preg:5">Dónde coinciden</button> <button type="button" class="int-btn ghost" data-go="preg:6">Oportunidades</button></div></div>
   <div class="int-rol"><b>Represento a una organización</b><span>Escriba su nombre en el buscador de arriba y abra su ficha.</span><button type="button" class="int-btn ghost" id="int-rol-o">Buscar mi organización</button></div></div>`;
}

/* --- Tercer nivel del panel territorial: convergencia / análisis --- */
function bloqueConvergencia(munisSel){
  const ops=oportunidades(munisSel); const o1=ops.find(o=>o.id==='o1'), o2=ops.find(o=>o.id==='o2');
  const total=(o1?o1.n:0)+(o2?o2.n:0);
  if(!total) return `<h4 class="int-h4">Convergencia territorial (análisis)</h4><p class="int-note">No se detectan coincidencias de sector u organización en más de un lugar/organización para esta selección.</p>`;
  const li=(arr,n)=>arr.slice(0,n).map(x=>`<li><div>${x.txt}</div>${x.sub?`<div class="int-sub2">${x.sub}</div>`:''}</li>`).join('');
  return `<h4 class="int-h4">Convergencia territorial (análisis)</h4>
   <div class="int-kpis">${kpi(o1?o1.n:0,'municipio × sector con 2+ organizaciones')}${kpi(o2?o2.n:0,'comunidades con 2+ programas')}</div>
   ${o1&&o1.n?`<h5 class="int-h5">Mismo sector, varias organizaciones</h5><ul class="int-ul">${li(o1.items,5)}</ul>${o1.n>5?`<button type="button" class="int-link" data-go="preg:5">Ver las ${o1.n}</button>`:''}`:''}
   ${o2&&o2.n?`<h5 class="int-h5">Comunidades con varias intervenciones</h5><ul class="int-ul">${li(o2.items,5)}</ul>${o2.n>5?`<button type="button" class="int-link" data-go="preg:5">Ver las ${o2.n}</button>`:''}`:''}
   <p class="int-note warn">Esto identifica coincidencias en los registros, no coordinación comprobada, duplicidad ni atención a las mismas familias. Es un punto de partida para conversar y verificar.</p>`;
}

function notaFiltrosActivos(){
  try{
    const etq={organizacion:'Organización',sector:'Sector',programa:'Programa',atencion:'Tipo de atención',actor:'Tipo de actor',estado:'Estado'};
    const activos=Object.entries(filtros).filter(([k,v])=>v&&etq[k]).map(([k,v])=>`${etq[k]}: ${v}`);
    if(!activos.length) return '';
    return `<p class="int-note warn">Filtros del mapa activos (arriba): <b>${activos.map(esc).join(' · ')}</b>. Ya se aplican al mapa y a las cifras generales. Este panel sigue mostrando el perfil completo del municipio/departamento para no perder contexto; use «Dónde coinciden» u «Oportunidades» para ver solo lo filtrado.</p>`;
  }catch(e){ return ''; }
}
function nivelDep(){
  const ds=nombresMunicipios().map(datosMunicipio).sort((a,b)=>b.progs.length-a.progs.length||cmp(a.m,b.m));
  const mx=Math.max(1,...ds.map(d=>d.progs.length));
  const orgs=uniq(P.map(p=>p.organizacion)).length, mc=ds.filter(d=>d.progs.length).length;
  return notaFiltrosActivos()+`<p class="int-big">${orgs} ${plural(orgs,'organización reporta','organizaciones reportan')} ${P.length} ${plural(P.length,'programa','programas')} con presencia registrada en ${mc} de ${ds.length} municipios. Elija un municipio en el mapa o en la lista, o haga una pregunta.</p>
   ${rolesHtml()}
   <h4 class="int-h4">Preguntas</h4>${preguntasHtml()}
   <h4 class="int-h4">Municipios</h4>${ds.map(d=>`<button type="button" class="int-mrow" data-go="muni:${esc(d.m)}"><span>${esc(d.m)}</span><i style="--w:${(d.progs.length/mx*100).toFixed(1)}%"></i><small>${d.orgs.length?`${d.orgs.length} org. · ${d.progs.length} prog.`:'sin registros'}</small></button>`).join('')}
   <p class="int-note">Un municipio "sin registros" no es un municipio sin cooperación: solo indica que nadie la ha reportado todavía.</p>
   ${bloqueConvergencia(null)}`;
}
function nivelMuni(m){
  const d=datosMunicipio(m);
  const lug=d.lug.slice().sort((a,b)=>b.orgs.size-a.orgs.size||cmp(a.lugar_poblado,b.lugar_poblado));
  const cat=nombreLugares().filter(l=>l.muni===m);
  return notaFiltrosActivos()+`<p class="int-big">${resumenTexto(d)}</p>
   <div class="int-kpis">${kpi(d.orgs.length,plural(d.orgs.length,'organización','organizaciones'))}${kpi(d.progs.length,plural(d.progs.length,'programa','programas'))}${kpi(`${d.lugCat.length}${d.total?' de '+d.total:''}`,'comunidades con atención registrada')}</div>
   <h4 class="int-h4">Preguntas sobre ${esc(m)}</h4>${preguntasHtml()}
   <h4 class="int-h4">Organizaciones</h4><div>${d.orgs.map(chipOrg).join('')||'<span class="int-empty">Ninguna registrada.</span>'}</div>
   <h4 class="int-h4">Comunidades con atención registrada</h4><div>${lug.map(c=>`<button type="button" class="int-chip lugar${c.fuera_catalogo?' pend':''}" data-go="lugar:${esc(c.k)}">${esc(c.lugar_poblado)}${c.orgs.size>1?` <small>${c.orgs.size} org.</small>`:''}${c.fuera_catalogo?' <small>por validar</small>':''}</button>`).join('')||'<span class="int-empty">Sin comunidades registradas.</span>'}</div>
   ${bloqueConvergencia([m])}
   <h4 class="int-h4">Buscar otra comunidad de ${esc(m)}</h4><div class="int-search"><input id="int-cb" list="int-cb-dl" placeholder="escriba el nombre" aria-label="Comunidad"><datalist id="int-cb-dl">${cat.map(l=>`<option value="${esc(l.lugar)}">`).join('')}</datalist><button type="button" class="int-btn" id="int-cb-go">Ver</button></div>
   <p class="int-note">Las comunidades que no aparecen arriba están "sin atención registrada", no necesariamente sin cooperación.</p>
   <div class="int-actions"><button type="button" class="int-btn ghost" data-go="ficha:${esc(m)}">Ficha municipal completa</button> <button type="button" class="int-btn ghost" data-go="cmp:${esc(m)}">Comparar municipios</button></div>`;
}
function migas(){
  const m=[]; m.push({t:'Chiquimula',f:()=>navegar('','')});
  if(NAV.muni) m.push({t:NAV.muni,f:()=>navegar(NAV.muni,'')});
  if(NAV.lugar){ const l=nombreLugares().find(x=>x.cod===NAV.lugar); m.push({t:l?l.lugar:'Comunidad',f:()=>navegar(NAV.muni,NAV.lugar)}); }
  pila.forEach((e,i)=>m.push({t:e.t,f:()=>navegar(NAV.muni,NAV.lugar,i+1)}));
  const cut=s=>s.length>34?s.slice(0,32)+'…':s;
  return `<nav class="int-crumbs" aria-label="Ruta de navegación">${m.map((x,i)=>i===m.length-1?`<span aria-current="page" title="${esc(x.t)}">${esc(cut(x.t))}</span>`:`<button type="button" data-i="${i}" title="${esc(x.t)}">${esc(cut(x.t))}</button>`).join('<i>›</i>')}<span class="int-sp"></span><button type="button" class="int-print" id="int-pp" title="Imprimir esta ficha">Imprimir</button></nav>`;
}
function pintarPanel(){
  const panel=$('#panel-comunidad'); if(!panel||!DATA) return;
  const top=pila[pila.length-1]; let titulo,cuerpo,fn=null;
  if(top){ titulo=top.t; cuerpo=top.h; fn=top.f; }
  else if(NAV.lugar){ const l=lugarHtml(NAV.lugar); titulo=l.titulo; cuerpo=l.html; }
  else if(NAV.muni){ titulo=NAV.muni; cuerpo=nivelMuni(NAV.muni); }
  else { titulo='Chiquimula'; cuerpo=nivelDep(); }
  panel.classList.add('int-panel');
  const mm=[]; mm.push(()=>navegar('',''));
  if(NAV.muni) mm.push(()=>navegar(NAV.muni,''));
  if(NAV.lugar) mm.push(()=>navegar(NAV.muni,NAV.lugar));
  pila.forEach((e,i)=>mm.push(()=>navegar(NAV.muni,NAV.lugar,i+1)));
  panel.innerHTML=buscadorHtml()+migas()+`<h2 class="int-h">${esc(titulo)}</h2><div id="int-panel-body">${cuerpo}</div>`;
  enlazar(panel);
  $$('.int-crumbs button[data-i]',panel).forEach(b=>b.onclick=mm[+b.dataset.i]);
  $('#int-pp',panel).onclick=()=>{ asegurarDrawer(); $('#int-dr-body').innerHTML=`<h2 class="int-h">${esc(titulo)}</h2>`+$('#int-panel-body').innerHTML; document.body.classList.add('int-printing'); window.print(); setTimeout(()=>document.body.classList.remove('int-printing'),500); };
  const q=$('#int-sq',panel), r=$('#int-sres',panel);
  q.oninput=()=>{ r.innerHTML=buscar(q.value); enlazar(r); };
  const rm=$('#int-rol-m',panel); if(rm) rm.onchange=()=>{ if(rm.value) irMunicipioExplorar(rm.value); };
  const ro=$('#int-rol-o',panel); if(ro) ro.onclick=()=>{ q.focus(); };
  const cbg=$('#int-cb-go',panel); if(cbg) cbg.onclick=()=>{ const t=sinAcento($('#int-cb',panel).value).trim(); const l=nombreLugares().find(x=>x.muni===NAV.muni&&sinAcento(x.lugar)===t); if(l) irLugar(l.cod); };
  if(fn) fn(panel);
}
function instalarExplorador(){
  if(window.__intExpl) return; window.__intExpl=true;
  const origCoincide=window.coincide;
  window.coincide=function(p){ return origCoincide(p)&&(!ST.mapOrg||p.organizacion===ST.mapOrg)&&(ST.mapProg==null||P.indexOf(p)===ST.mapProg); };
  const desdeMapa=()=>{ if(!ST.keep){ leerControles(); pila=[]; ST.mapOrg=''; ST.mapProg=null; } pintarPanel(); };
  window.renderResumenTerritorial=function(){ desdeMapa(); };
  const origCom=window.mostrarPanelComunidad, origTer=window.mostrarPanelTerritorial;
  window.mostrarPanelComunidad=function(p){ try{ sincronizarConsultaConPunto(p); }catch(e){} desdeMapa(); };
  window.mostrarPanelTerritorial=function(p){ try{ sincronizarConsultaConPunto(p); }catch(e){} desdeMapa(); };
  const lim=window.limpiarFiltros;
}

/* =====================================================================
   METODOLOGÍA Y ÚLTIMA ACTUALIZACIÓN
   ===================================================================== */
function diagnosticoMapa(){
  const ls=P.flatMap(p=>lugaresDe(p)); const sin=uniq(ls.filter(c=>!(c.lat!==null&&c.lat!==undefined&&c.lat!==''&&c.lon!==null&&c.lon!==undefined&&c.lon!=='')).map(c=>c.k)).length;
  const tot=uniq(ls.map(c=>c.k)).length; const me=window.MAPA_ESTADO||{limites:'sin intentar'};
  let marc=''; try{ marc=(typeof coopLayer!=='undefined'&&coopLayer&&coopLayer.getLayers)?coopLayer.getLayers().length:'sin dato (capa no disponible en este entorno)'; }catch(e){ marc='sin dato'; }
  return `<ul class="int-ul"><li>Librería de mapas (Leaflet): ${typeof L!=='undefined'?'cargada':'<b>no cargada</b>'}.</li><li>Límites municipales: ${esc(me.limites)}${me.n?` (${me.n} municipios)`:''}${me.error?` — ${esc(me.error)}`:''}.</li><li>Puntos de cooperación visibles ahora en el mapa: ${typeof marc==='number'?marc:'sin dato'}.</li><li>Comunidades con atención registrada: ${tot}; <b>${sin}</b> sin coordenadas (no aparecen como punto, pero sí en las fichas y listas).</li></ul>`;
}

/* =====================================================================
   FUENTES CARTOGRÁFICAS (documentación visible, solo lectura)
   Solo se afirma lo que está comprobado en el código o en los archivos del visor;
   lo demás aparece como PENDIENTE. No se agregan atribuciones no verificadas.
   ===================================================================== */
const CARTO_CAPAS=[
 {n:'Claro',prov:'Esri',srv:'server.arcgisonline.com · Canvas/World_Light_Gray_Base (nombres al acercar: …/World_Light_Gray_Reference)',atr:'Teselas © Esri — Esri, HERE, Garmin, © OpenStreetMap'},
 {n:'Relieve',prov:'Esri',srv:'server.arcgisonline.com · World_Topo_Map',atr:'Teselas © Esri — Fuentes: Esri, Maxar, USGS, comunidad de usuarios SIG'},
 {n:'Satélite',prov:'Esri',srv:'server.arcgisonline.com · World_Imagery (nombres al acercar: Reference/World_Boundaries_and_Places, sin atribución propia en el visor)',atr:'Teselas © Esri — Fuentes: Esri, Maxar, USGS, comunidad de usuarios SIG'},
 {n:'OpenStreetMap',prov:'OpenStreetMap (servidor estándar de teselas)',srv:'tile.openstreetmap.org',atr:'© OpenStreetMap (con enlace a openstreetmap.org/copyright)'}
];
function fuentesCartograficas(){
  const me=window.MAPA_ESTADO||{}; const mb=window.MAPA_BASE||{nombre:'Claro',tileErrores:{}};
  const capa=CARTO_CAPAS.find(c=>c.n===mb.nombre)||CARTO_CAPAS[0];
  const err=(mb.tileErrores&&mb.tileErrores[mb.nombre])||0;
  let lim;
  if(me.origen==='servicio_en_linea'){
    lim=`<p><span class="int-est rep">En línea</span> Los límites se obtuvieron <b>de un servicio en línea de CONRED</b> (${esc((me.url||'').replace(/\?.*$/,'').replace(/^https?:\/\//,''))}) al abrir esta página; son ${me.n} municipios. El visor <b>no guarda fecha ni versión</b> de esos datos y no ha comprobado sus condiciones de uso: aparece como fuente porque respondió ahora, no porque esté verificada.</p>`;
  }else if(me.origen==='archivo_local'){
    lim=`<p><span class="int-est cal">Archivo local</span> <b>En este momento no se usa el servicio de CONRED</b> (no respondió). Los ${me.n} municipios provienen de un <b>archivo local de respaldo</b> (${esc(me.archivo||'limites_chiquimula.geojson')}), tomado de un archivo público de MINFIN-BI (repositorio <i>minfin-bi/Mapas-TopoJSON-Guatemala</i>, versión del 31-ago-2022). <b>No es una capa oficial certificada.</b> Su licencia no está declarada y su reutilización está <b>pendiente de confirmar con MINFIN</b>: que el archivo sea público no es una autorización.</p>`;
  }else if(me.origen==='no_disponible'){
    lim=`<p><span class="int-est pend">No disponibles</span> No se pudieron cargar límites municipales (ni del servicio en línea ni del archivo local). Los puntos y las fichas siguen funcionando; el mapa no muestra polígonos.</p>`;
  }else{
    lim=`<p><span class="int-est pend">Sin comprobar</span> Todavía no se ha intentado cargar los límites municipales.</p>`;
  }
  const bloque=(t,filas)=>`<div class="int-fuente"><b>${esc(t)}</b><dl>${filas.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>`;
  const capas=CARTO_CAPAS.map(c=>bloque('Mapa base: '+c.n,[['Proveedor',c.prov],['Servicio',c.srv],['Atribución mostrada hoy',c.atr]])).join('');
  return `
   <h4 class="int-h4">Mapa base seleccionado</h4>
   <p><b>${esc(capa.n)}</b> — proveedor: ${esc(capa.prov)}. Atribución que muestra el visor: «${esc(capa.atr)}». ${err?`<span class="int-est pend">Durante esta sesión ${err} teselas no cargaron</span> (puede ser conexión o falla del servicio).`:'No se han detectado teselas sin cargar en esta sesión (esto no sustituye una revisión visual).'}</p>
   <h4 class="int-h4">Límites municipales</h4>${lim}
   <h4 class="int-h4">Todas las capas y sus fuentes</h4>
   ${capas}
   ${bloque('Límites municipales',[['Proveedor','CONRED (servicio en línea) o MINFIN-BI (archivo local de respaldo)'],['Servicio o archivo','sig.conred.gob.gt · Hosted/Limites_municipales, o limites_chiquimula.geojson'],['Atribución','La nota bajo el mapa indica cuál se está usando']])}
   ${bloque('Lugares poblados y puntos',[['Origen','Catálogo del formulario (SEGEPLAN/CRS) y coordenadas del visor'],['Archivos','catalogo_xlsform.json · coordenadas_lugares.json']])}
   <p class="int-note">Los mapas base y los límites son <b>referencia visual</b>; no son una delimitación oficial ni sustituyen la cartografía de SEGEPLAN, IGN o CONRED.</p>
   <h4 class="int-h4">Qué está comprobado y qué sigue pendiente</h4>
   <ul class="int-ul">
    <li><b>Comprobado en las pruebas:</b> que el panel refleja la fuente realmente cargada (servicio en línea, archivo local o ninguno) y el mapa base elegido; que los puntos, municipios y fichas se mantienen.</li>
    <li><b>Pendiente — licencia de MINFIN-BI:</b> el archivo local de respaldo no declara licencia; hay que confirmar permiso de uso y redistribución.</li>
    <li><b>Pendiente — Esri:</b> los términos de Esri exigen atribuir a Esri y a sus proveedores de datos y vinculan el uso de sus mapas base a una cuenta o suscripción de ArcGIS. El visor consulta los servicios sin clave; <b>su cumplimiento y el texto exacto de atribución están por confirmar</b>.</li>
    <li><b>Pendiente — OpenStreetMap:</b> la política de uso del servidor estándar de teselas no se ha revisado para este visor.</li>
    <li><b>Pendiente — CONRED:</b> sin fecha ni versión documentada de los límites, ni condiciones de uso comprobadas.</li>
    <li><b>Pendiente — coordenadas:</b> 26 de 816 lugares caen fuera de su municipio según el archivo local de límites (listado en puntos_fuera_de_limite.csv); falta verificación en campo o con SEGEPLAN.</li>
    <li><b>Necesita validación manual:</b> ver el mapa en un navegador real con Internet (capas Claro, Relieve, Satélite y OpenStreetMap, y el servicio de CONRED).</li></ul>`;
}
function abrirFuentesCartograficas(){ abrir('Fuentes cartográficas',fuentesCartograficas()); }
function metodologia(){
  const g=(DATA.generado&&typeof fechaCorta==='function')?fechaCorta(DATA.generado):'sin dato';
  const c=DATA.control||{};
  abrir('Metodología y fuentes',`
   <div class="int-kpis">${kpi(esc(g),'Última sincronización')}${kpi(c.registros_kobo??'—','Registros recibidos')}${kpi(c.programas_procesados??P.length,'Programas procesados')}</div>
   <h4 class="int-h4">Fuente</h4><p>Información reportada por las propias organizaciones mediante el formulario "Mapeo de Actores de Cooperación" (KoboToolbox). Se sincroniza automáticamente varias veces al día. El catálogo de lugares poblados (${fmt(c.lugares_catalogo||0)}) es la base territorial oficial; ${fmt(c.lugares_con_coordenadas||0)} tienen coordenadas.</p>
   <h4 class="int-h4">Estados de la información: qué significa cada etiqueta</h4>
   <ul class="int-ul">
    <li>${etq('rep')} Lo que cada organización escribió o marcó en el formulario (KoboToolbox). El visor no lo ha contrastado con otra fuente.</li>
    <li>${etq('cal')} Conteos y clasificaciones que hace el visor a partir de lo reportado (por ejemplo, cuántos programas hay por rango). Las lecturas automáticas son frases con reglas fijas, sin inteligencia artificial externa.</li>
    <li>${etq('ver')} Dato contrastado con otra fuente o validado por SEGEPLAN o CRS. <b>Hoy ningún dato se presenta como verificado</b>: una declaración en Kobo no es una verificación.</li></ul>
   <h4 class="int-h4">Reglas de interpretación</h4>
   <ul class="int-ul">
    <li><b>Inversión:</b> el formulario recoge rangos, no montos. Los rangos se cuentan por programa y <b>no se suman</b>: un rango no es un monto, un programa puede abarcar varios municipios y el formulario no distingue presupuesto total de lo ejecutado. No equivale a presupuesto municipal ni a recursos disponibles.</li>
    <li><b>Población:</b> se distinguen <i>registros</i> (programa × comunidad × grupo declarado) y <i>personas reportadas</i> (cantidades tal como se declararon, por grupo). No se presenta un total de personas: los programas pueden atender a las mismas personas y los grupos se solapan. Se señala la posible superposición cuando dos o más programas reportan cantidad para el mismo grupo en una comunidad.</li>
    <li><b>Datos faltantes:</b> "sin dato" no es cero. Un lugar sin atención registrada no es un lugar sin cooperación.</li>
    <li><b>Lugares adicionales:</b> los que las organizaciones escriben fuera del catálogo se muestran como "pendientes de validación" y no tienen coordenadas.</li>
    <li><b>Contrapartes:</b> el campo es texto libre. Se agrupa por siglas conocidas (MAGA, SESAN, MINEDUC...) para poder consultarlo; el texto original se conserva en cada ficha. Puede haber entidades no reconocidas, que quedan como "Otra (texto libre)".</li>
    <li><b>Articulación en tres capas:</b> (1) contrapartes declaradas, (2) espacios compartidos, (3) vínculos documentados, que hoy no se recogen en el formulario. Lo no reconocido se muestra como "Sin clasificar" con su texto original. Compartir contraparte o espacio no prueba coordinación efectiva.</li>
    <li><b>Contactos:</b> no se publican nombres de personas.</li></ul>
   <h4 class="int-h4">Estado del mapa</h4>${diagnosticoMapa()}
   <h4 class="int-h4">Fuentes cartográficas</h4>${fuentesCartograficas()}
   ${(c.advertencias_integridad||[]).length?`<h4 class="int-h4">Avisos de integridad al procesar los datos</h4><ul class="int-ul">${c.advertencias_integridad.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}`);
}
function plegarMapa(){
  const sec=$('#view-mapa'); if(!sec||sec.dataset.fold) return; sec.dataset.fold='1';
  const st=$('#stats',sec), fl=$('.filters',sec); if(!st||!fl) return;
  const det=document.createElement('details'); det.className='int-fold int-fold-mapa'; det.innerHTML='<summary>Filtros del mapa y cifras (opcional)</summary><div class="int-fold-body"></div>';
  const cuerpo=det.querySelector('.int-fold-body'); cuerpo.append(fl,st); sec.prepend(det);
}
function barraNav(){
  const nav=$('#nav'); if(!nav||$('#int-meta')) return;
  // Navegación principal corta; lo demás queda en "Más análisis".
  const mas=['brechas','municipio','poblacion-accion'];
  const btn=id=>nav.querySelector(`button[data-view="${id}"]`);
  mas.forEach(id=>{ const b=btn(id); if(b) b.style.display='none'; });
  const m=document.createElement('div'); m.className='int-mas';
  m.innerHTML='<button type="button" id="int-mas-b" aria-haspopup="true" aria-expanded="false">Más análisis ▾</button><div class="int-mas-menu" id="int-mas-menu" hidden>'+
    mas.map(id=>{ const b=btn(id); return b?`<button type="button" data-v="${id}">${esc(b.textContent)}</button>`:''; }).join('')+'</div>';
  nav.appendChild(m);
  const menu=$('#int-mas-menu',m), mb=$('#int-mas-b',m);
  mb.onclick=e=>{ e.stopPropagation(); menu.hidden=!menu.hidden; mb.setAttribute('aria-expanded',String(!menu.hidden)); };
  $$('button',menu).forEach(b=>b.onclick=()=>{ menu.hidden=true; mostrarVista(b.dataset.v); });
  document.addEventListener('click',()=>{ menu.hidden=true; });
  const g=DATA.generado&&typeof fechaCorta==='function'?'actualizado '+fechaCorta(DATA.generado).split(' · ')[0]:'';
  const b=document.createElement('button'); b.type='button'; b.id='int-meta'; b.className='int-nav-extra'; b.innerHTML=` Metodología${g?` <small>· ${g}</small>`:''}`; b.onclick=metodologia;
  nav.appendChild(b);
  // Acceso a las fuentes cartográficas desde la nota bajo el mapa.
  const nota=document.querySelector('.boundary-note');
  if(nota&&!$('#int-fuentes-btn')){ const f=document.createElement('button'); f.type='button'; f.id='int-fuentes-btn'; f.className='int-linkbtn'; f.textContent='Fuentes cartográficas'; f.onclick=abrirFuentesCartograficas; nota.append(' · ',f); }
}


/* Plegar el contenido original de una vista bajo un <details> para reducir saturación.
   No se elimina nada: filtros, matrices y tablas siguen funcionando dentro del panel. */
function plegar(viewId, anchorId, titulo, abierto){
  const sec=$('#view-'+viewId), anc=$('#'+anchorId); if(!sec||!anc||sec.dataset.plegado) return;
  sec.dataset.plegado='1';
  const det=document.createElement('details'); det.className='int-fold'; if(abierto) det.open=true;
  det.innerHTML='<summary>'+esc(titulo)+'</summary><div class="int-fold-body"></div>';
  const cuerpo=det.querySelector('.int-fold-body');
  let n=anc.nextElementSibling; while(n){ const sig=n.nextElementSibling; cuerpo.appendChild(n); n=sig; }
  anc.after(det);
  det.addEventListener('toggle',()=>{ if(det.open) setTimeout(()=>{ try{ window.dispatchEvent(new Event('resize')); }catch(e){} },50); });
}

/* =====================================================================
   ESTILOS
   ===================================================================== */
function estilos(){
  if($('#int-css')) return;
  const s=document.createElement('style'); s.id='int-css'; s.textContent=`
  .int-card{background:#fff;border:1px solid #D5DEE6;border-radius:14px;padding:20px;margin:16px 0;box-shadow:0 1px 2px rgba(0,32,64,.06),0 4px 14px rgba(0,32,64,.05)}
  .int-eyebrow{font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#22678A;margin-bottom:8px}
  .int-big{font-size:17px;line-height:1.55;margin:4px 0 16px;color:#183652}
  .int-note{font-size:13px;color:#5B6675;margin:8px 0;line-height:1.5}.int-note.warn{background:#FFF8E6;border-left:3px solid #E0A100;padding:8px 12px;border-radius:6px;color:#5A4600}
  .int-h,.int-h4,.int-h5{color:#183652}.int-h{font-size:22px;margin:0 0 6px;padding-right:40px}.int-h4{font-size:14px;margin:18px 0 8px}.int-h4 small{font-weight:400;color:#6B7280}.int-h5{font-size:13px;margin:14px 0 6px}
  .int-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:12px 0}
  .int-kpi{background:#F4F7FA;border-radius:10px;padding:12px 14px;display:flex;flex-direction:column;gap:2px}.int-kpi b{font-size:22px;color:#183652;line-height:1.2;word-break:break-word}.int-kpi span{font-size:12px;color:#4B5563}.int-kpi em{font-size:11px;color:#6B7280;font-style:normal}
  .int-chip{display:inline-flex;gap:5px;align-items:baseline;border:1px solid #CBD5E1;background:#fff;color:#183652;border-radius:12px;padding:5px 11px;margin:3px 4px 3px 0;font:inherit;font-size:13px;cursor:pointer;text-align:left}
  .int-chip:hover,.int-chip:focus-visible{border-color:#22678A;background:#EEF6FC;outline:none}.int-chip small{color:#6B7280;font-size:11px}
  .int-chip.alt{background:#F1F5F9}.int-chip.muni{background:#EAF4EC;border-color:#BBD9C2}.int-chip.lugar{background:#EEF6FC;border-color:#BCD9EE}.int-chip.pend{background:#FFF8E6;border-color:#EBCB7A}
  .int-chip.big{padding:8px 14px;font-size:14px}.int-chip.on{background:#22678A;color:#fff;border-color:#22678A}.int-chip.on small{color:#DCEBF6}
  .int-tag{display:inline-block;background:#EEF2F7;color:#334155;border-radius:6px;padding:3px 9px;margin:2px 4px 2px 0;font-size:12px}.int-tag.ok{background:#E6F4EA;color:#17602B}.int-tag.warn{background:#FFF1D6;color:#7A4B00}
  .int-lnk{color:#22678A;cursor:pointer;text-decoration:underline;text-underline-offset:2px}.int-link{background:none;border:0;color:#22678A;font:inherit;font-size:13px;cursor:pointer;padding:4px 0;font-weight:600}
  .int-btn{border:1px solid #22678A;background:#22678A;color:#fff;border-radius:8px;padding:8px 14px;font:inherit;font-size:13px;cursor:pointer}.int-btn.ghost{background:#fff;color:#22678A}.int-btn:hover{filter:brightness(1.08)}
  .int-actions{margin-top:14px}
  .int-empty{color:#6B7280;font-size:13px;padding:8px 0}
  .int-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px;margin-top:10px}
  .int-orgcard{border:1px solid #D5DEE6;border-radius:12px;padding:14px;cursor:pointer;background:#fff;transition:.15s}.int-orgcard:hover,.int-orgcard:focus-visible{border-color:#22678A;box-shadow:0 4px 14px rgba(25,113,168,.15);outline:none}.int-orgcard h5{margin:0 0 6px;font-size:14px;line-height:1.3;color:#183652}.int-orgcard p{margin:8px 0 4px;font-size:13px}.int-orgcard small{color:#5B6675}
  .int-search{display:flex;flex-wrap:wrap;gap:8px}.int-search input{flex:1 1 280px;min-width:0;border:1px solid #CBD5E1;border-radius:8px;padding:9px 12px;font:inherit;font-size:14px}.int-search select{border:1px solid #CBD5E1;border-radius:8px;padding:9px;font:inherit;font-size:14px}
  .int-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}.int-tabs button{border:1px solid #CBD5E1;background:#fff;border-radius:8px;padding:8px 14px;font:inherit;font-size:13px;cursor:pointer}.int-tabs button.on{background:#183652;color:#fff;border-color:#183652}
  .int-detail{background:#F8FAFC;border-radius:12px;padding:16px;margin-top:14px}
  .int-tbl-wrap{overflow-x:auto}.int-tbl{width:100%;border-collapse:collapse;font-size:13px}.int-tbl th,.int-tbl td{padding:8px 10px;border-bottom:1px solid #D5DEE6;text-align:left;vertical-align:top}.int-tbl thead th{background:#F1F5F9;font-size:12px;color:#334155}.int-cmp tbody th{background:#F8FAFC;width:30%;font-weight:600}
  .int-cmp-sel{display:flex;flex-wrap:wrap;gap:6px 14px;margin:10px 0}.int-chk{font-size:13px;display:flex;gap:6px;align-items:center}
  .int-help{margin:10px 0;background:#F4F9FD;border:1px solid #D4E6F4;border-radius:10px;padding:8px 14px}.int-help summary{cursor:pointer;font-weight:600;font-size:13px;color:#22678A}.int-help-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px 18px;margin-top:10px}.int-help h5{margin:0 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#334155}.int-help p{margin:0;font-size:13px;line-height:1.5;color:#334155}.int-help .ok h5{color:#17602B}.int-help .no h5{color:#9A3412}
  .int-oport-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:14px}.int-op{border:1px solid #D5DEE6;border-radius:12px;padding:14px;background:#fff}.int-op.vacia{opacity:.75}.int-op-h{display:flex;gap:10px;align-items:flex-start}.int-op-h h4{flex:1;margin:0;font-size:15px;line-height:1.3}.int-op-h b{background:#183652;color:#fff;border-radius:999px;min-width:28px;text-align:center;padding:2px 8px;font-size:13px}.int-why{font-size:13px;color:#4B5563;line-height:1.5;margin:8px 0}.int-op summary{cursor:pointer;color:#22678A;font-weight:600;font-size:13px}
  .int-fold{margin:16px 0;border:1px solid #D5DEE6;border-radius:12px;background:#fff}.int-fold>summary{cursor:pointer;padding:14px 18px;font-weight:700;color:#183652;font-size:15px}.int-fold-body{padding:0 14px 14px}
  .int-ul{padding-left:18px;margin:8px 0;font-size:13px;line-height:1.5}.int-ul li{margin:8px 0}.int-sub2{margin-top:4px}
  .int-two{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:24px}
  .int-bar{display:grid;grid-template-columns:minmax(120px,1.2fr) 2fr 28px;gap:8px;align-items:center;font-size:13px;margin:6px 0}.int-bar i{display:block;height:10px;border-radius:6px;background:linear-gradient(90deg,#22678A var(--w),#E8EEF5 var(--w))}.int-bar b{text-align:right}.int-bar small{grid-column:2/4;color:#6B7280;margin-top:-4px}
  .int-hall{display:flex;flex-direction:column;gap:6px}.int-hall .int-link{margin-top:auto}.int-hall .int-link{align-self:flex-start}
  .int-nav-extra{margin-left:auto;background:transparent!important;color:#fff!important;border:1px solid rgba(255,255,255,.45)!important;border-radius:999px!important;font-size:13px;white-space:nowrap;padding:6px 14px!important}.int-nav-extra small{color:#CFE0EE}.int-nav-extra:hover{background:rgba(255,255,255,.14)!important}
  #int-veil{position:fixed;inset:0;background:rgba(14,27,45,.45);opacity:0;pointer-events:none;transition:.2s;z-index:9998}#int-veil.open{opacity:1;pointer-events:auto}
  #int-drawer{position:fixed;top:0;right:0;height:100%;width:min(640px,100%);background:#fff;box-shadow:-8px 0 30px rgba(0,0,0,.2);transform:translateX(105%);transition:transform .25s;z-index:9999;display:flex;flex-direction:column}#int-drawer.open{transform:none}
  .int-dr-bar{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #D5DEE6}.int-dr-sp{flex:1}.int-back,.int-x{background:none;border:0;font:inherit;cursor:pointer;color:#22678A;font-size:14px}.int-x{font-size:26px;color:#334155;line-height:1}.int-dr-body{padding:18px 20px 40px;overflow-y:auto;flex:1}
  .int-prog{border:1px solid #D5DEE6;border-radius:10px;padding:10px 12px;margin:8px 0;cursor:pointer}.int-prog:hover{border-color:#22678A;background:#F8FBFE}.int-prog small{display:block;color:#5B6675;margin-top:3px}
  .int-dl{display:grid;grid-template-columns:minmax(120px,1fr) 2fr;gap:6px 14px;font-size:13px}.int-dl dt{color:#5B6675}.int-dl dd{margin:0}
  .int-oport{background:#EEF6FC;border-radius:8px;padding:10px 12px;font-size:13px}
  .int-sub{margin-bottom:6px}.int-orgs{color:#5B6675;line-height:1.5}
  @media(max-width:640px){.int-big{font-size:15px}.int-card{padding:14px}.int-kpi b{font-size:19px}.int-dl{grid-template-columns:1fr}.int-bar{grid-template-columns:1fr 1.4fr 26px}.int-nav-extra{margin-left:0}}
  @media print{body.int-printing > *:not(#int-drawer):not(#int-veil){display:none!important}body.int-printing #int-drawer{position:static;width:auto;box-shadow:none;transform:none}body.int-printing .int-dr-bar{display:none}body.int-printing #int-veil{display:none}}
  `;
  document.head.prepend(s);   // va antes de tema.css para que el tema pueda sobrescribir
}

/* =====================================================================
   INICIO Y ENGANCHES
   ===================================================================== */
function renderVista(id){
  try{
    if(id==='mapa') pintarPanel();
    if(id==='panorama'){ renderConsultas(); renderTablaMunicipios(); renderHallazgos(); renderPanoramaV3(); }
    if(id==='municipio') renderMuniExtra();
    if(id==='instituciones'){ irDirectorio(); renderDirectorio(); }
    if(id==='articulacion'){ renderArtExtra(); plegar('articulacion','int-art','Detalle técnico: filtros, matrices y tabla original de articulación',false); }
    if(id==='brechas'){ renderOportunidades(); plegar('brechas','int-oport','Cobertura territorial por lugar poblado y matriz sector × municipio',true); }
    if(id==='poblacion-accion') renderPobExtra();
  }catch(e){ console.error('inteligencia.js:',id,e); }
}
window.INT={RANGOS,resumenPoblacion,distRangos,registrosPoblacion};
window.initInteligencia=function(){
  if(typeof DATA==='undefined'||!DATA) return;
  P=DATA.programas||[];
  estilos(); asegurarDrawer(); instalarExplorador(); barraNav(); plegarMapa();
  Object.keys(AYUDAS).forEach(insertarAyuda); insertarPreguntas();
  // Enganche: después de que el visor muestra una vista, completar con este módulo.
  if(!window.__intHook){
    window.__intHook=true;
    const orig=window.mostrarVista;
    window.mostrarVista=function(id){ const r=orig.apply(this,arguments); setTimeout(()=>renderVista((typeof VISTA_ALIAS!=='undefined'&&VISTA_ALIAS[id])||id),0); return r; };
    const origM=window.renderMunicipio;
    window.renderMunicipio=function(){ const r=origM.apply(this,arguments); try{ renderMuniExtra(); }catch(e){ console.error(e);} return r; };
    // El selector del municipio llama a renderMunicipio por referencia interna; se reasigna para incluir el resumen.
    const sel=$('#f-municipio-panel'); if(sel) sel.onchange=()=>window.renderMunicipio();
  }
  renderVista('panorama'); renderVista('mapa');
};
})();
