'use strict';
/* RADAR SINTÉTICO MR V1.9.0 · MOTOR SPIKE + SIEMPRE ENCENDIDA
   V1.9: motor spike aparte (zona → entrada → salida al spike), análisis histórico de spikes por mercado,
   encendido persistente con reconexión automática y revisión de lo que pasó durante una pausa.
   Cada mercado Boom/Crash tiene su propio estado y su propio motor de análisis.
   V1.8.1: las estrategias y el algoritmo votan juntos antes de cada alerta y entrada, guardia contra
   entradas en contra del spike, el RADAR sigue la operación demo abierta y el gráfico muestra
   disparador, entrada, objetivo, stop, riesgo si hay spike y la proyección de las analogías. */
const $=id=>document.getElementById(id);
const fmt=v=>Number.isFinite(v)?Number(v).toFixed(5):'—';
const fmt2=v=>Number.isFinite(v)?(v<0?'−':'+')+Math.abs(v).toFixed(2):'—';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const avg=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:0;
const sd=a=>{if(!a.length)return 0;const m=avg(a);return Math.sqrt(avg(a.map(v=>(v-m)**2)))};
const median=a=>{if(!a.length)return 0;const s=[...a].sort((x,y)=>x-y),h=s.length>>1;return s.length%2?s[h]:(s[h-1]+s[h])/2};
const ema=(a,n)=>{if(!a.length)return 0;const k=2/(n+1);let v=a[0];for(let i=1;i<a.length;i++)v=a[i]*k+v*(1-k);return v};
const nowSec=()=>Math.floor(Date.now()/1000);
const fmtP=v=>Number.isFinite(v)?Number(v).toFixed(Math.abs(v)>=1000?2:Math.abs(v)>=100?3:4):'—';
const arrowOf=d=>String(d).startsWith('ALZA')?'↑':String(d).startsWith('BAJA')?'↓':'–';
const sideOf=d=>String(d||'').split(' ')[0];

const DERIV_WS='wss://api.derivws.com/trading/v1/options/ws/public';
const MAX_TICKS=1500,HISTORY_ROWS=150,MARKERS_PER_MARKET=60;
const ENTRY_HIGHLIGHT_MS=20000,EXIT_HIGHLIGHT_MS=10000,STALE_MS=20000,BOOT_STAGGER_MS=350,VOICE_TTL_MS=20000;
/* Reglas nuevas de V1.8.1 (se pueden apagar aquí). */
const CFG={confluence:true,spikeGuard:true,historySpikes:true,followDemo:true,smartRebound:true,spikeEngine:true,histGuard:true,persist:true};
const SPK_ZONE=70,SPK_LIFT=1.15,SPK_WIN=.35,SPK_COOLDOWN=30,SPK_MIN_HIGH=40,HIST_CANDLES=2000,STORE_KEY='radarmr:v19',RETRY_MS=[1000,2000,4000,8000,15000,30000];
const SPIKE_BLOCK=75,SPIKE_EXIT=80,CONF_MIN_FAVOR=3,CONF_MIN_SCORE=40,ALGO_VETO=55,PROJ_MINUTES=6,PROJ_MIN_SIM=.40,PROJ_HOLD_MS=30000,RECENT_MARKER_TEXT=4,CONTRACT_SIZE=1;

const S={
  ws:null,candleWs:null,symbol:null,marketName:'',candles:[],timeframe:60,engineTimeframe:60,
  chart:null,candleSeries:null,markerApi:null,markers:[],markerSeq:0,priceLines:[],projSeries:[],
  markets:new Map(),reqMap:new Map(),bootTimers:[],scanTimer:null,
  manualDirection:null,demoPosition:null,voice:true,voiceQueue:[],voiceSpeaking:false,bootReadyAt:0,
  historyReq:0,req:100,historyStatus:'SIN CARGAR',installPrompt:null,levelDrag:null,
  power:'off',retry:0,retryTimer:null,spikeOn:true,bgMode:false,wakeLock:null,log:[],stats:null,pending:{},greeted:false,dirty:false,lastBeat:0,bgCtx:null,bgNode:null,hudCompact:false,restoreSymbol:null
};

const els={
  symbol:$('symbol'),graphSymbol:$('graphSymbol'),connect:$('connect'),conn:$('conn'),price:$('price'),ticks:$('ticks'),
  direction:$('direction'),confidence:$('confidence'),phase:$('phase'),reason:$('reason'),history:$('history')
};

function setText(id,v){const e=$(id);if(e)e.textContent=v}
function currentMarketLabel(){return els.symbol?.options?.[els.symbol.selectedIndex]?.text||S.marketName||S.symbol||'Boom / Crash'}

/* ---------- MERCADOS: UN ESTADO INDEPENDIENTE POR MERCADO ---------- */
function shortName(n){const s=String(n||'');return s.replace(/\s*index\s*$/i,'').trim()||s}
function newMarket(sym,name,index){
  const low=String(name).toLowerCase();
  return {sym,name,short:shortName(name),index,
    bias:low.includes('boom')?'ALZA ↑':low.includes('crash')?'BAJA ↓':'NEUTRAL',
    prices:[],times:[],tickCount:0,engineCandles:[],historyReady:false,engineHistoryReady:false,
    status:'CARGANDO',error:'',retries:{},lastTickAt:0,
    signal:null,timing:null,setup:null,activeSignal:null,cooldownUntil:0,lastLateKey:'',lastSetupEvalBucket:null,
    algorithm:null,algoTick:0,algoAt:0,m:null,sp:null,normalPrep:0,prep:0,prepDir:'NEUTRAL',
    lastSpikeTick:0,lastSpikeEventAt:0,lastSpikePrice:null,lastExitAt:0,spikeSizes:[],spikeSize:null,proj:null,
    spk:{trade:null,zone:null,cool:0,voiceAt:0},hist:null,histCandles:[],restoreFrom:null,gapTicks:null};
}
const VM=()=>S.symbol?S.markets.get(S.symbol)||null:null;
const isView=M=>!!M&&M.sym===S.symbol;
function refreshStatus(M){if(M.historyReady&&M.engineHistoryReady){M.status='LISTO';M.error=''}}
/* Boom sube con el spike y Crash baja: vender Boom o comprar Crash es operar en contra del spike. */
const counterSpike=(M,dir)=>!!M&&M.bias!=='NEUTRAL'&&(sideOf(dir)==='ALZA'||sideOf(dir)==='BAJA')&&sideOf(dir)!==sideOf(M.bias);

/* ---------- TAMAÑO DE SPIKE Y SPIKES DEL HISTÓRICO ---------- */
/* Boom/Crash N tiene en promedio 1 spike cada N ticks. El tamaño se estima promediando los k saltos
   más grandes a favor del spike, con k = cantidad de spikes esperada en los datos (antes: la mediana
   de los saltos detectados, que en el video del 24/09 dio 0.42 pts en Boom 150 cuando se veían de 2–3). */
function spikeEvery(M){const n=Number((String(M.name).match(/(\d+)/)||[])[1]);return n>=10&&n<=5000?n:null}
function estimateSpikeSize(M){
  const N=spikeEvery(M),want=M.bias.startsWith('ALZA')?1:M.bias.startsWith('BAJA')?-1:0;
  if(N&&want){
    const p=M.prices,kt=Math.round((p.length-1)/N),ticks=k=>{const j=[],all=[];for(let i=1;i<p.length;i++){const d=p[i]-p[i-1];all.push(Math.abs(d));if(d*want>0)j.push(d*want)}const floor=8*median(all);j.sort((a,b)=>b-a);const top=j.slice(0,k).filter(x=>x>floor);return top.length>=3?avg(top):null}; // un spike supera 8× el tick típico
    if(kt>=6){const v=ticks(kt);if(v)return v}
    const cs=M.histCandles?.length>M.engineCandles.length?M.histCandles:M.engineCandles,kc=Math.round(cs.length*S.engineTimeframe/N);
    if(cs.length>=30&&kc>=3&&kc<=cs.length/2){ // vela con spike: promedio entre (máximo−apertura) y el rango, para no sub/sobreestimar
      const v=cs.map(c=>want>0?((c.high-c.open)+(c.high-c.low))/2:((c.open-c.low)+(c.high-c.low))/2).filter(x=>x>0).sort((a,b)=>b-a).slice(0,kc);if(v.length>=3)return avg(v)}
    if(kt>=3){const v=ticks(kt);if(v)return v}
  }
  const live=M.spikeSizes.slice(-12);if(live.length>=3)return median(live);
  const cs=M.engineCandles,up=M.bias.startsWith('ALZA');let cand=[];
  if(cs.length>=30){const med=median(cs.map(c=>c.high-c.low));if(med>0)cand=cs.filter(c=>c.high-c.low>med*4).map(c=>up?c.high-c.open:c.open-c.low).filter(v=>v>med*3)}
  const all=live.concat(cand.slice(-24));return all.length?median(all):null;
}
function scanHistorySpikes(M){
  const p=M.prices;if(p.length<60||M.bias==='NEUTRAL')return;
  const ds=[];for(let i=1;i<p.length;i++)ds.push(p[i]-p[i-1]);
  const abs=ds.map(Math.abs).sort((a,b)=>a-b),cut=abs[Math.floor(abs.length*.98)];
  const sigma=sd(ds.filter(d=>Math.abs(d)<=cut))||1e-9,want=M.bias.startsWith('ALZA')?1:-1;
  let last=-1;const sizes=[];
  for(let i=0;i<ds.length;i++)if(ds[i]*want>sigma*5.2){sizes.push(Math.abs(ds[i]));last=i}
  if(sizes.length)M.spikeSizes=sizes.slice(-12);
  if(last>=0&&!M.lastSpikeTick){M.lastSpikeTick=last+2;M.lastSpikeEventAt=M.times[last+1]||0;M.lastSpikePrice=p[last+1]}
}

/* ---------- CONFLUENCIA: TODAS LAS ESTRATEGIAS + ALGORITMO ---------- */
function confluenceFor(M,dir){
  const a=M?.algorithm,side=sideOf(dir),list=a?.strategies||[];let favor=0,contra=0;
  if(side==='ALZA'||side==='BAJA')for(const x of list){if(x.dir==='NEUTRAL'||x.score<CONF_MIN_SCORE)continue;if(sideOf(x.dir)===side)favor++;else contra++}
  const algoDir=a?.dir||'NEUTRAL',algoContra=algoDir!=='NEUTRAL'&&sideOf(algoDir)!==side&&(a?.score||0)>=ALGO_VETO;
  return {favor,contra,total:list.length,algoScore:a?.score||0,algoDir,algoContra,ok:favor>=CONF_MIN_FAVOR&&favor>contra&&!algoContra};
}

/* ---------- PAUSAS: revisar lo que pasó mientras el RADAR estuvo desconectado ---------- */
const hhmm=t=>new Date(t*1000).toLocaleTimeString('es-SV',{hour:'2-digit',minute:'2-digit'});
function gapStart(M){const d=S.demoPosition?.symbol===M.sym?S.demoPosition.lastEpoch:null;return Math.min(M.restoreFrom??Infinity,M.historyReady&&M.times.length?M.times.at(-1):Infinity,Number.isFinite(d)?d:Infinity)}
function tryReconcile(M){const g=M.gapTicks;if(!g||!M.engineHistoryReady)return;M.gapTicks=null;replayGap(M,g.P,g.T,g.from)}
function replayGap(M,P,T,from){
  const notes=[];
  if(T.length&&T[0]>from+1){const cs=(M.histCandles.length?M.histCandles:M.engineCandles).filter(c=>c.time+60>from&&c.time<T[0]);for(const c of cs)checkGap(M,c.low,c.high,c.close,Math.max(c.time,from),true,notes,null)} // pausa más larga que los ticks disponibles: velas M1
  for(let i=1;i<T.length-1;i++)if(T[i]>from)checkGap(M,P[i],P[i],P[i],T[i],false,notes,P[i-1]);
  if(notes.length){const mins=Math.max(1,Math.round((T.at(-1)-from)/60)),msg=`${M.short}: durante la pausa de ${mins} min ${notes.join(', ')}.`;showToast(msg);logEvent('REVISIÓN DE PAUSA','—',P.at(-1),0,`${mins} MIN`,M.name);announce(M,msg,msg,88,'exit')}
}
function checkGap(M,lo,hi,close,t,isCandle,notes,prev){
  const d=S.demoPosition;
  if(d&&d.symbol===M.sym){const up=d.dir.startsWith('ALZA'),sl=up?lo<=d.stop:hi>=d.stop,tp=up?hi>=d.target:lo<=d.target;
    if(sl||tp){d.lastPrice=isCandle?(sl?d.stop:d.target):close;d.lastEpoch=t;closeDemo(sl?'STOP':'PROFIT',true);notes.push(`la demo tocó ${sl?'el STOP':'el OBJETIVO'} a las ${hhmm(t)}`)}
    else{d.lastPrice=close;d.lastEpoch=t}}
  const a=M.activeSignal;
  if(a&&!a.demo){const up=a.dir.startsWith('ALZA'),tp=up?hi>=a.target:lo<=a.target,sl=up?lo<=a.stop:hi>=a.stop;
    if(sl||tp){closeSignal(M,`${sl?'STOP':'OBJETIVO ALCANZADO'} (en pausa ${hhmm(t)})`,isCandle?(sl?a.stop:a.target):close,t,true);notes.push(`la señal ${sl?'tocó el STOP':'llegó al OBJETIVO'}`)}}
  const k=M.spk?.trade;
  if(k){const up=k.dir.startsWith('ALZA'),jump=isCandle?hi-lo:(close-(prev??close))*(up?1:-1);
    if(jump>=k.size*.45){closeSpikeTrade(M,'SPIKE',isCandle?(up?hi:lo):close,t,true);notes.push('llegó el spike de la operación spike')}
    else if(up?lo<=k.stop:hi>=k.stop){closeSpikeTrade(M,'STOP',isCandle?k.stop:close,t,true);notes.push('la operación spike tocó su stop')}
    else if(t-k.entryEpoch>=k.H){closeSpikeTrade(M,'SIN SPIKE',close,t,true);notes.push('la operación spike venció sin spike')}}
  const s=M.setup;if(s&&t>s.expiresAt){M.setup=null;if(!notes.includes('la pre-alerta venció'))notes.push('la pre-alerta venció')}
}
function showToast(msg,ms=15000){const e=$('toast');if(!e)return;e.textContent=msg;e.hidden=false;clearTimeout(S.toastTimer);S.toastTimer=setTimeout(()=>{e.hidden=true},ms)}

/* ---------- MEMORIA: todo se guarda en el teléfono y se recupera al abrir ---------- */
function markDirty(){S.dirty=true}
function saveNow(){
  if(!CFG.persist)return;S.dirty=false;
  try{
    const mk={...S.pending};for(const M of S.markets.values()){const a=M.activeSignal&&!M.activeSignal.demo?M.activeSignal:null,k=M.spk?.trade||null;if(a||k)mk[M.sym]={a,spk:k,lastEpoch:M.times.at(-1)||null};else delete mk[M.sym]}
    const per={},markers=[];for(let i=S.markers.length-1;i>=0;i--){const m=S.markers[i];per[m.symbol]=(per[m.symbol]||0)+1;if(per[m.symbol]<=30)markers.push(m)}markers.reverse();
    localStorage.setItem(STORE_KEY,JSON.stringify({v:1,at:Date.now(),power:S.power,symbol:S.symbol,tf:S.timeframe,voice:S.voice,lot:$('lotSize')?.value,mode:$('executionMode')?.value,spikeOn:S.spikeOn,bg:S.bgMode,hud:!!S.hudCompact,demo:S.demoPosition,markets:mk,markers,log:S.log.slice(0,HISTORY_ROWS),stats:S.stats}));
  }catch{}
}
function restoreState(){
  if(!CFG.persist)return;let st=null;try{st=JSON.parse(localStorage.getItem(STORE_KEY)||'null')}catch{}
  if(!st||st.v!==1)return;
  S.power=st.power==='on'?'on':'off';S.voice=st.voice!==false;setText('voice',`🔊 Voz: ${S.voice?'ON':'OFF'}`);
  if(st.tf){S.timeframe=st.tf;document.querySelectorAll('.tf').forEach(b=>b.classList.toggle('active',Number(b.dataset.sec)===st.tf))}
  if(st.lot&&$('lotSize'))$('lotSize').value=st.lot;if(st.mode&&$('executionMode'))$('executionMode').value=st.mode;
  S.spikeOn=st.spikeOn!==false;S.bgMode=!!st.bg;S.hudCompact=!!st.hud;S.demoPosition=st.demo||null;S.pending=st.markets||{};
  S.markers=Array.isArray(st.markers)?st.markers:[];S.markerSeq=S.markers.length+1000;S.log=Array.isArray(st.log)?st.log:[];S.stats=st.stats||null;S.restoreSymbol=st.symbol||null;
}

/* ---------- RESULTADOS (se guardan en el teléfono) ---------- */
const newStats=()=>({since:Date.now(),radar:{n:0,w:0,R:0},spike:{n:0,w:0,R:0,base:0},demo:{n:0,w:0,usd:0}});
function addStat(kind,win,val,base=0){if(!CFG.persist)return;if(!S.stats)S.stats=newStats();const x=S.stats[kind];x.n++;if(win)x.w++;if(kind==='demo')x.usd+=val;else x.R+=val;if(kind==='spike')x.base+=base;renderStats();markDirty()}
function renderStats(){
  const b=$('statsBody');if(!b)return;const st=S.stats||newStats(),pct=(w,n)=>n?Math.round(w/n*100)+'%':'—',sg=v=>(v>=0?'+':'−')+Math.abs(v).toFixed(1);
  const since=new Date(st.since).toLocaleString('es-SV',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
  b.innerHTML=`<div><b>RADAR</b> ${st.radar.n} señales · ${pct(st.radar.w,st.radar.n)} ganadas · ${sg(st.radar.R)} R</div>`+
    `<div><b>⚡ SPIKE</b> ${st.spike.n} intentos · ${st.spike.w} spikes atrapados (${pct(st.spike.w,st.spike.n)}) · al azar se esperaban ${st.spike.base.toFixed(1)} · ${sg(st.spike.R)} R</div>`+
    `<div><b>DEMO</b> ${st.demo.n} operaciones · ${pct(st.demo.w,st.demo.n)} ganadas · ${st.demo.usd<0?'−':'+'}$${Math.abs(st.demo.usd).toFixed(2)}</div>`+
    `<small>Desde ${since}. R = resultado ÷ distancia al stop (1 R = lo que se arriesgaba).</small>`;
}

/* ---------- PANTALLA ENCENDIDA Y SEGUNDO PLANO ---------- */
async function requestWakeLock(){if(S.power!=='on'||document.hidden||!('wakeLock' in navigator)||S.wakeLock)return;try{S.wakeLock=await navigator.wakeLock.request('screen');S.wakeLock.addEventListener?.('release',()=>{S.wakeLock=null})}catch{S.wakeLock=null}}
function releaseWakeLock(){try{S.wakeLock?.release()}catch{}S.wakeLock=null}
/* Experimental: un tono inaudible (20 Hz, volumen mínimo) para que Chrome no congele la página en segundo plano. */
function startBg(){if(!S.bgMode||S.bgNode)return;try{const AC=window.AudioContext||window.webkitAudioContext;if(!AC)return;const ctx=S.bgCtx||(S.bgCtx=new AC()),o=ctx.createOscillator(),g=ctx.createGain();o.frequency.value=20;g.gain.value=.003;o.connect(g);g.connect(ctx.destination);o.start();S.bgNode={o,g};ctx.resume?.();if('mediaSession' in navigator&&window.MediaMetadata)navigator.mediaSession.metadata=new MediaMetadata({title:'RADAR SINTÉTICO MR',artist:'Vigilando Boom y Crash'})}catch{}}
function stopBg(){try{S.bgNode?.o.stop()}catch{}S.bgNode=null}

function setTiming(M,text,kind='waiting'){if(!M)return;M.timing={text,kind};if(isView(M))applyTiming(M)}
function applyTiming(M){const t=M?.timing||{text:'ESPERANDO ESTRUCTURA',kind:'waiting'};setText('timingState',t.text);const e=$('timingState');if(e)e.className='timing '+t.kind;setText('graphTiming',t.text)}

/* ---------- VOZ CON PRIORIDADES ---------- */
function queueSpeech(text,priority=10,immediate=false){
  if(!S.voice||!('speechSynthesis' in window)||!text)return;
  if(S.voiceQueue.some(x=>x.text===text))return;
  S.voiceQueue.push({text,priority,immediate,at:Date.now()});
  S.voiceQueue.sort((a,b)=>b.priority-a.priority);
  if(S.voiceQueue.length>6)S.voiceQueue=S.voiceQueue.slice(0,6);
  pumpVoice();
}
function pumpVoice(){
  if(S.voiceSpeaking||!S.voiceQueue.length||!S.voice)return;
  const now=Date.now();S.voiceQueue=S.voiceQueue.filter(x=>x.immediate||now-x.at<=VOICE_TTL_MS); // un aviso viejo ya no sirve
  if(!S.voiceQueue.length)return;
  const idx=S.voiceQueue.findIndex(x=>x.immediate||Date.now()>=S.bootReadyAt);
  if(idx<0){setTimeout(pumpVoice,350);return}
  const item=S.voiceQueue.splice(idx,1)[0];
  const u=new SpeechSynthesisUtterance(item.text);u.lang='es-SV';u.rate=.95;S.voiceSpeaking=true;
  u.onend=u.onerror=()=>{S.voiceSpeaking=false;if(item.immediate)S.bootReadyAt=Date.now()+1400;setTimeout(pumpVoice,180)};
  speechSynthesis.speak(u);
}
/* Mercado en vista: los mismos avisos de siempre.
   Otros mercados: solo entradas, salidas y avisos de la operación abierta, nombrando el mercado. */
function announce(M,viewText,bgText,priority,kind='info'){
  if(!M)return;
  if(isView(M)){queueSpeech(viewText,priority);return}
  if(kind==='entry'||kind==='exit')queueSpeech(bgText,priority+5);
}

/* ---------- PWA / PANTALLA ---------- */
window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();S.installPrompt=e;document.querySelectorAll('.install-btn').forEach(b=>b.hidden=false)});
window.addEventListener('appinstalled',()=>{S.installPrompt=null;document.documentElement.classList.add('standalone')});
if(window.matchMedia('(display-mode: standalone)').matches||window.matchMedia('(display-mode: fullscreen)').matches)document.documentElement.classList.add('standalone');
if('serviceWorker' in navigator)window.addEventListener('load',()=>navigator.serviceWorker.register('./service-worker.js').catch(()=>{}));
async function installApp(){
  if(S.installPrompt){S.installPrompt.prompt();await S.installPrompt.userChoice;S.installPrompt=null;return}
  queueSpeech('Para ocultar la barra del navegador, use el menú de Chrome y seleccione instalar aplicación o agregar a pantalla principal.',20);
  const h=$('installHint');if(h)h.textContent='Chrome ⋮ → Instalar aplicación / Agregar a pantalla principal. Luego abra RADAR desde su icono.';
}
$('installApp').onclick=installApp;$('graphInstall').onclick=installApp;
async function toggleFullscreen(){try{if(!document.fullscreenElement)await document.documentElement.requestFullscreen();else await document.exitFullscreen()}catch{const h=$('installHint');if(h)h.textContent='El navegador bloqueó pantalla completa. Instale RADAR como app para quitar la barra superior.'}}
$('fullscreenBtn').onclick=toggleFullscreen;

/* ---------- DERIV: UNA CONEXIÓN, TODOS LOS MERCADOS ---------- */
function send(o){if(S.ws?.readyState===1)S.ws.send(JSON.stringify(o))}
/* ENCENDIDO: el RADAR queda encendido hasta que usted lo apague. Si se corta internet o Deriv, se reconecta
   solo (1, 2, 4, 8, 15 y 30 s) y, al volver, revisa con los ticks lo que pasó mientras estuvo desconectado. */
function renderPower(){const on=S.power==='on';els.connect.textContent=on?'⏻ Apagar RADAR':'⏻ Encender RADAR';els.connect.classList.toggle('power-on',on)}
function setConnUI(state){
  const txt={on:'● DERIV CONECTADO',connecting:'CONECTANDO…',retry:`● RECONECTANDO (${S.retry})…`,offline:'● SIN INTERNET · reintentando',off:'● APAGADO'}[state]||state;
  els.conn.textContent=txt;els.conn.className='pill '+(state==='on'?'on':'off');setText('graphConn',state==='on'?'● DERIV EN VIVO':txt);S.connState=state;scheduleScan(true);
}
function powerOn(){S.power='on';renderPower();saveNow();openSocket(true);requestWakeLock();if(S.bgMode)startBg()}
function powerOff(){S.power='off';renderPower();clearTimeout(S.retryTimer);S.retryTimer=null;const w=S.ws;S.ws=null;try{w?.close()}catch{}releaseWakeLock();stopBg();setConnUI('off');saveNow();queueSpeech('Radar apagado.',50)}
function connect(){powerOn()}
function openSocket(fresh=false){
  clearTimeout(S.retryTimer);S.retryTimer=null;
  const old=S.ws;S.ws=null;try{old?.close()}catch{}
  S.bootTimers.forEach(clearTimeout);S.bootTimers=[];S.reqMap.clear();
  if(!CFG.persist){S.markets.clear();clearPriceLines()} // (hasta V1.8 cada conexión empezaba de cero)
  if(fresh&&!S.greeted)S.bootReadyAt=S.voice?Date.now()+999999:Date.now();
  renderScanner();updateSignalUI();
  const ws=new WebSocket(DERIV_WS);S.ws=ws;setConnUI('connecting');
  ws.onopen=()=>{
    if(S.ws!==ws)return;S.retry=0;setConnUI('on');
    if(S.markets.size)bootstrapAll(S.symbol);else send({active_symbols:'brief',req_id:1});
    if(!S.greeted){S.greeted=true;queueSpeech('Radar Sintético MR encendido y conectado a Deriv. Preparando el análisis de todos los mercados Boom y Crash.',100,true)}
    else queueSpeech('Conexión recuperada.',40);
  };
  ws.onclose=()=>{if(S.ws!==ws)return;S.ws=null;if(S.power==='on'){setConnUI(navigator.onLine===false?'offline':'retry');scheduleReconnect()}else setConnUI('off')};
  ws.onerror=()=>{};
  ws.onmessage=e=>{if(S.ws!==ws)return;let d;try{d=JSON.parse(e.data)}catch{return}handleMainMessage(d)};
}
function scheduleReconnect(){if(S.retryTimer||S.power!=='on')return;const d=RETRY_MS[Math.min(S.retry,RETRY_MS.length-1)];S.retry++;setConnUI(navigator.onLine===false?'offline':'retry');S.retryTimer=setTimeout(()=>{S.retryTimer=null;if(S.power==='on')openSocket()},d)}
function checkHealth(){
  if(S.power!=='on')return;
  if(!S.ws||S.ws.readyState>1){scheduleReconnect();return}
  if(S.ws.readyState===1&&[...S.markets.values()].some(M=>M.historyReady&&M.lastTickAt&&Date.now()-M.lastTickAt>STALE_MS))openSocket(); // conexión "viva" pero sin ticks
}
function handleMainMessage(d){
  const meta=d.req_id!=null?S.reqMap.get(d.req_id):null;
  if(d.error){
    if(meta){handleRequestError(meta,d.error);return}
    if(els.reason)els.reason.textContent=d.error.message||'Error Deriv';return;
  }
  if(d.msg_type==='active_symbols'){buildMarkets(d.active_symbols);return}
  if(d.msg_type==='history'&&d.history){
    const M=S.markets.get(meta?.sym||String(d.echo_req?.ticks_history||''));if(M)loadTickHistory(M,d.history);return;
  }
  if(d.msg_type==='candles'&&Array.isArray(d.candles)){
    if(meta?.kind!=='candles')return;const M=S.markets.get(meta.sym);if(!M)return;
    const all=normalizeCandles(d.candles,HIST_CANDLES);M.histCandles=CFG.spikeEngine?all:[];M.engineCandles=all.slice(-400);M.engineHistoryReady=M.engineCandles.length>=24;M.retries.candles=0;refreshStatus(M);M.spikeSize=estimateSpikeSize(M);
    if(CFG.spikeEngine)M.hist=spikeHistory(M);
    tryReconcile(M);
    if(M.prices.length&&M.historyReady)runEngine(M,M.prices.at(-1),M.times.at(-1)||nowSec());
    scheduleScan();return;
  }
  if(d.msg_type==='tick'){
    const q=Number(d.tick?.quote),ep=Number(d.tick?.epoch);if(!Number.isFinite(q)||!Number.isFinite(ep))return;
    const M=S.markets.get(String(d.tick?.symbol||meta?.sym||d.echo_req?.ticks||''));if(M)onTick(M,q,ep);
  }
}
function buildMarkets(list){
  const found=(list||[]).filter(x=>/boom|crash/i.test(x.underlying_symbol_name||x.display_name||''))
    .map(x=>{const sym=String(x.underlying_symbol||x.symbol||'');return {sym,name:x.underlying_symbol_name||x.display_name||sym}})
    .filter((x,i,a)=>x.sym&&a.findIndex(y=>y.sym===x.sym)===i)
    .sort((a,b)=>a.name.localeCompare(b.name,'es',{numeric:true}));
  const prev=S.markets;S.markets=new Map();els.symbol.innerHTML='';els.graphSymbol.innerHTML='';
  found.forEach((x,i)=>{
    const M=(CFG.persist&&prev.get(x.sym))||newMarket(x.sym,x.name,i);M.index=i;
    const p=CFG.persist&&S.pending[x.sym];if(p){if(p.a)M.activeSignal=p.a;if(p.spk)M.spk.trade=p.spk;M.restoreFrom=p.lastEpoch||null;delete S.pending[x.sym]}
    S.markets.set(x.sym,M);
    for(const sel of [els.symbol,els.graphSymbol]){const o=document.createElement('option');o.value=x.sym;o.textContent=x.name;sel.appendChild(o)}
  });
  if(!found.length){if(els.reason)els.reason.textContent='Deriv no devolvió mercados Boom / Crash.';renderScanner();return}
  const keep=S.markets.has(S.symbol)?S.symbol:S.markets.has(S.restoreSymbol)?S.restoreSymbol:found[0].sym;
  setViewMarket(keep);
  bootstrapAll(keep);
}
/* Las descargas se escalonan para no pedir el histórico de todos los mercados en el mismo instante. */
function bootstrapAll(first){
  const order=[...S.markets.keys()].sort((a,b)=>(a===first?-1:0)-(b===first?-1:0));
  order.forEach((sym,i)=>S.bootTimers.push(setTimeout(()=>bootstrapMarket(S.markets.get(sym)),i*BOOT_STAGGER_MS)));
}
function bootstrapMarket(M){
  if(!M||S.markets.get(M.sym)!==M)return;
  M.status='CARGANDO';requestFor(M,'history');requestFor(M,'candles');requestFor(M,'ticks');scheduleScan();
}
function requestFor(M,kind){
  if(!M||S.ws?.readyState!==1||S.markets.get(M.sym)!==M)return;
  const r=++S.req;S.reqMap.set(r,{sym:M.sym,kind});
  if(kind==='history'){const since=gapStart(M),count=Number.isFinite(since)?clamp(Math.round(nowSec()-since)+60,500,5000):500;send({ticks_history:M.sym,count,end:'latest',style:'ticks',req_id:r})}
  else if(kind==='candles')send({ticks_history:M.sym,count:CFG.spikeEngine?HIST_CANDLES:1000,end:'latest',style:'candles',granularity:S.engineTimeframe,req_id:r});
  else send({ticks:M.sym,subscribe:1,req_id:r});
}
function handleRequestError(meta,err){
  const M=S.markets.get(meta.sym);if(!M)return;
  if(err?.code==='AlreadySubscribed')return;
  const n=(M.retries[meta.kind]||0)+1;M.retries[meta.kind]=n;
  if(n<=3){M.status='REINTENTANDO';S.bootTimers.push(setTimeout(()=>requestFor(M,meta.kind),2500*n))}
  else{M.status='ERROR';M.error=err?.message||'Error Deriv'}
  if(isView(M)&&els.reason)els.reason.textContent=`${M.short}: ${err?.message||'Error Deriv'}`;
  scheduleScan();
}
function loadTickHistory(M,h){
  const pr=h.prices||[],tm=h.times||[],P=[],T=[];
  for(let i=0;i<pr.length;i++){const p=Number(pr[i]),t=Number(tm[i]);if(Number.isFinite(p)&&Number.isFinite(t)){P.push(p);T.push(t)}}
  const lastT=T.length?T.at(-1):-Infinity;
  for(let i=0;i<M.times.length;i++)if(M.times[i]>lastT){P.push(M.prices[i]);T.push(M.times[i])} // ticks en vivo llegados antes del histórico
  const had=CFG.persist&&M.historyReady&&M.times.length>0,prevLast=had?M.times.at(-1):null,prevCount=M.tickCount,gapFrom=CFG.persist?gapStart(M):Infinity;
  M.prices=P.slice(-MAX_TICKS);M.times=T.slice(-MAX_TICKS);
  if(had){const newer=T.filter(t=>t>prevLast).length,beyond=T.length&&T[0]>prevLast+1?Math.round(T[0]-prevLast-1):0;M.tickCount=prevCount+newer+beyond} // el contador sigue (⚡ no se reinicia)
  else M.tickCount=M.prices.length;
  M.historyReady=true;M.lastTickAt=Date.now();M.retries.history=0;refreshStatus(M);
  if(CFG.historySpikes)scanHistorySpikes(M); // ⚡ se conoce desde el inicio
  M.spikeSize=estimateSpikeSize(M);M.restoreFrom=null;
  if(Number.isFinite(gapFrom)&&T.length&&T.at(-1)>gapFrom+1){M.gapTicks={P,T,from:gapFrom};if(!M.engineHistoryReady){scheduleScan();return}tryReconcile(M)}
  const price=M.prices.at(-1),epoch=M.times.at(-1)||nowSec();
  if(S.demoPosition?.symbol===M.sym&&Number.isFinite(price))monitorDemoPosition(price,epoch);
  runEngine(M,price,epoch);scheduleScan();
}
function onTick(M,q,ep){
  const lastT=M.times.at(-1);
  if(Number.isFinite(lastT)&&(ep<lastT||(ep===lastT&&q===M.prices.at(-1))))return; // tick repetido o fuera de orden
  M.lastTickAt=Date.now();
  M.prices.push(q);M.times.push(ep);M.tickCount++;if(M.prices.length>MAX_TICKS){M.prices.shift();M.times.shift()}
  if(!M.historyReady)return; // se fusiona cuando llegue el histórico
  updateEngineCandle(M,q,ep);
  if(S.demoPosition?.symbol===M.sym)monitorDemoPosition(q,ep);
  runEngine(M,q,ep);
}
/* Cambiar de mercado solo cambia la vista: ningún mercado se reinicia. */
function setViewMarket(sym){
  const M=S.markets.get(sym);if(!M)return;
  S.symbol=sym;S.marketName=M.name;
  if(els.symbol.value!==sym)els.symbol.value=sym;if(els.graphSymbol.value!==sym)els.graphSymbol.value=sym;
  requestCandles();renderView(M);drawActiveLevels();renderDemo();renderMarkers();scheduleScan(true);
}

/* ---------- CANDLE FEED ---------- */
function normalizeCandles(list,keep=400){
  const map=new Map();for(const c of list||[]){const x={time:Number(c.epoch),open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close)};if(![x.time,x.open,x.high,x.low,x.close].every(Number.isFinite))continue;if(x.high<x.low||x.high<Math.max(x.open,x.close)||x.low>Math.min(x.open,x.close))continue;map.set(x.time,x)}
  return [...map.values()].sort((a,b)=>a.time-b.time).slice(-keep);
}
function updateEngineCandle(M,price,epoch){
  const tf=S.engineTimeframe,bucket=Math.floor(epoch/tf)*tf;let c=M.engineCandles.at(-1);
  if(!c||bucket<c.time)return;
  if(bucket>c.time){c={time:bucket,open:c.close,high:Math.max(c.close,price),low:Math.min(c.close,price),close:price};M.engineCandles.push(c);if(M.engineCandles.length>500)M.engineCandles.shift()}
  else{c.high=Math.max(c.high,price);c.low=Math.min(c.low,price);c.close=price}
}
function aggregateCandles(list,targetTf){
  const out=[];for(const c of list){const t=Math.floor(c.time/targetTf)*targetTf;let x=out.at(-1);if(!x||x.time!==t){out.push({time:t,open:c.open,high:c.high,low:c.low,close:c.close})}else{x.high=Math.max(x.high,c.high);x.low=Math.min(x.low,c.low);x.close=c.close}}return out.slice(-400)
}
function requestCandles(){
  try{S.candleWs?.close()}catch{}
  const symbol=S.symbol;if(!symbol)return;
  const tf=S.timeframe,baseTf=tf===172800?86400:tf,req=++S.req;S.historyReq=req;S.candles=[];S.historyStatus='CARGANDO OHLC';updateBadge();renderProjection();
  const ws=new WebSocket(DERIV_WS);S.candleWs=ws;
  ws.onopen=()=>ws.send(JSON.stringify({ticks_history:symbol,count:260,end:'latest',style:'candles',granularity:baseTf,req_id:req}));
  ws.onerror=()=>{if(S.candleWs===ws)showChartError('No se pudo abrir el canal OHLC de Deriv.')};
  ws.onmessage=e=>{if(S.candleWs!==ws)return;let d;try{d=JSON.parse(e.data)}catch{return}
    if(d.error){showChartError('OHLC Deriv: '+d.error.message);return}
    if(d.msg_type==='candles'&&Array.isArray(d.candles)&&d.req_id===req){
      S.candles=normalizeCandles(d.candles);if(tf===172800)S.candles=aggregateCandles(S.candles,172800);if(S.candles.length<20){showChartError('Histórico OHLC insuficiente.');return}
      hideChartError();S.historyStatus=`${S.candles.length} OHLC`;renderAll(true);ws.send(JSON.stringify({ticks:symbol,subscribe:1,req_id:++S.req}));
    }
    if(d.msg_type==='tick'&&S.candles.length){const q=Number(d.tick?.quote),ep=Number(d.tick?.epoch);if(Number.isFinite(q)&&Number.isFinite(ep))updateLiveCandle(q,ep)}
  };
}
function updateLiveCandle(price,epoch){
  const bucket=Math.floor(epoch/S.timeframe)*S.timeframe;let c=S.candles.at(-1);if(!c||bucket<c.time)return;
  if(bucket>c.time){c={time:bucket,open:c.close,high:Math.max(c.close,price),low:Math.min(c.close,price),close:price};S.candles.push(c);if(S.candles.length>400)S.candles.shift()}
  else{c.high=Math.max(c.high,price);c.low=Math.min(c.low,price);c.close=price}
  S.candleSeries?.update(c);updateOHLC(c);updateBadge();
}

/* ---------- CHART ---------- */
function ensureChart(){
  if(S.chart)return true;
  if(!window.LightweightCharts){showChartError('No cargó Lightweight Charts. Revise Internet.');return false}
  const host=$('lwChart');
  S.chart=LightweightCharts.createChart(host,{autoSize:true,layout:{background:{type:'solid',color:'#06101a'},textColor:'#9db4c7',attributionLogo:false},grid:{vertLines:{color:'#14293a'},horzLines:{color:'#14293a'}},rightPriceScale:{borderColor:'#294157',autoScale:true,scaleMargins:{top:.12,bottom:.12}},timeScale:{borderColor:'#294157',timeVisible:true,secondsVisible:false,rightOffset:6,barSpacing:11,minBarSpacing:3,maxBarSpacing:35},crosshair:{mode:0},handleScroll:{mouseWheel:true,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:false},handleScale:{axisPressedMouseMove:true,mouseWheel:true,pinch:true}});
  S.candleSeries=S.chart.addSeries(LightweightCharts.CandlestickSeries,{upColor:'#11b76c',downColor:'#f24c5e',borderUpColor:'#11b76c',borderDownColor:'#f24c5e',wickUpColor:'#4ee29c',wickDownColor:'#ff7988',priceLineVisible:true,lastValueVisible:true,priceFormat:{type:'price',precision:5,minMove:.00001}});
  // Proyección de 6 minutos: línea central + banda (camino promedio de las analogías históricas)
  try{const base={priceLineVisible:false,crosshairMarkerVisible:false,lastValueVisible:false,priceFormat:{type:'price',precision:5,minMove:.00001}};
    S.projSeries=[S.chart.addSeries(LightweightCharts.LineSeries,{...base,color:'#b58cff',lineWidth:2,lineStyle:2,lastValueVisible:true,title:'PROYECCIÓN'}),
      S.chart.addSeries(LightweightCharts.LineSeries,{...base,color:'#b58cff66',lineWidth:1,lineStyle:1}),
      S.chart.addSeries(LightweightCharts.LineSeries,{...base,color:'#b58cff66',lineWidth:1,lineStyle:1})]}catch{S.projSeries=[]}
  try{S.markerApi=LightweightCharts.createSeriesMarkers(S.candleSeries,[],{autoScale:true,zOrder:'top'})}catch{try{S.markerApi=LightweightCharts.createSeriesMarkers(S.candleSeries,[])}catch{S.markerApi=null}}
  S.chart.subscribeCrosshairMove(p=>{if(!p.time)return;const d=p.seriesData.get(S.candleSeries);if(d)updateOHLC(d)});
  return true;
}
function renderAll(fit=false){if(!ensureChart()||!S.candles.length)return;S.candleSeries.setData(S.candles);renderMarkers();drawActiveLevels();renderProjection();if(fit)showRecentCandles(60);updateOHLC(S.candles.at(-1));updateBadge()}
function showRecentCandles(count=60){if(!S.chart||!S.candles.length)return;const n=S.candles.length,visible=Math.min(count,n);S.chart.timeScale().setVisibleLogicalRange({from:n-visible-2,to:n+8})}
function updateOHLC(c){if(!c)return;setText('ohlcLine',`O ${fmt(c.open)}   H ${fmt(c.high)}   L ${fmt(c.low)}   C ${fmt(c.close)}`)}
function updateBadge(){const tf=document.querySelector('.tf.active')?.textContent||'1m';setText('chartBadge',`${tf} · ${S.historyStatus==='CARGANDO OHLC'?'cargando…':S.candles.length+' velas'} · motor M1`)}
function showChartError(t){const e=$('chartError');if(e){e.textContent=t;e.hidden=false}}
function hideChartError(){const e=$('chartError');if(e)e.hidden=true}
function clearPriceLines(){if(!S.candleSeries)return;for(const l of S.priceLines){try{S.candleSeries.removePriceLine(l)}catch{}}S.priceLines=[]}
function addPriceLine(price,title,color,style=2,width=1){if(!S.candleSeries||!Number.isFinite(price))return;try{S.priceLines.push(S.candleSeries.createPriceLine({price,color,lineWidth:width,lineStyle:style,axisLabelVisible:true,title}))}catch{}}
/* Niveles del mercado en vista:
   - operación (demo o señal del RADAR): ENTRADA, OBJETIVO, STOP y, si va en contra del spike, dónde quedaría tras un spike típico;
   - pre-alerta: DISPARADOR (donde se confirma la entrada) e INVALIDA (donde se cancela). */
function drawActiveLevels(){
  clearPriceLines();const M=VM();if(!M)return;
  const d=S.demoPosition?.symbol===S.symbol?S.demoPosition:null,a=d||M.activeSignal;
  if(a){const up=a.dir.startsWith('ALZA');
    addPriceLine(a.entry,d?'ENTRADA DEMO':'ENTRADA',up?'#18d486':'#ff5365',0);
    addPriceLine(a.target,'OBJETIVO','#45a8ff');addPriceLine(a.stop,'STOP','#ff7b48');
    if(counterSpike(M,a.dir)&&M.spikeSize)addPriceLine(a.entry+(up?-1:1)*M.spikeSize,'SI HAY SPIKE','#ff4d5f',1);
    return;
  }
  const k=M.spk?.trade;if(k){addPriceLine(k.entry,'⚡ ENTRADA SPIKE','#b36bff',0);addPriceLine(k.tp,'⚡ TP SUGERIDO','#d9a6ff');addPriceLine(k.stop,'⚡ STOP SPIKE','#ff7b48');return}
  const s=M.setup;if(s){addPriceLine(s.trigger,`DISPARADOR ${arrowOf(s.dir)}`,'#ff9a22');addPriceLine(s.invalid,'INVALIDA','#7c8d99',1)}
}
function addMarker(type,dir,price,time,text,persistent=true,symbolOverride=null){
  if(!Number.isFinite(price))return;const t=time||S.candles.at(-1)?.time||nowSec();const sym=symbolOverride||S.symbol;const id=`${type}-${sym}-${t}-${++S.markerSeq}`;
  S.markers.push({id,type,dir,price,time:t,eventTime:t,text:String(text||''),persistent,symbol:sym});
  const own=S.markers.filter(m=>m.symbol===sym);
  if(own.length>MARKERS_PER_MARKET){const drop=new Set(own.slice(0,own.length-MARKERS_PER_MARKET));S.markers=S.markers.filter(m=>!drop.has(m))}
  if(sym===S.symbol)renderMarkers();
}
function markerSpec(m,showText=false){
  const up=String(m.dir).startsWith('ALZA');let color='#ff9a22',shape=up?'arrowUp':'arrowDown',position=up?'atPriceBottom':'atPriceTop';
  if(m.type==='entry'){color=up?'#18d486':'#ff5365';shape=up?'arrowUp':'arrowDown'}
  else if(m.type==='rebound'){color='#ffd34d';shape='circle';position='atPriceMiddle'}
  else if(m.type==='exit'){color='#58bfff';shape='square';position='atPriceMiddle'}
  else if(m.type==='cancel'){color='#7c8d99';shape='circle';position='atPriceMiddle'}
  else if(m.type==='risk'){color='#ff4d5f';shape='circle';position='atPriceMiddle'}
  else if(m.type==='spike'){color='#b36bff';shape=up?'arrowUp':'arrowDown'}
  else if(m.type==='spikeexit'){color='#d9a6ff';shape='square';position='atPriceMiddle'}
  const chartTime=Math.floor((m.eventTime||m.time)/S.timeframe)*S.timeframe;return {id:m.id,time:chartTime,position,price:m.price,color,shape,text:showText?m.text:'',size:m.type==='entry'||m.type==='spike'?2:1.4};
}
/* Solo los últimos eventos llevan texto: el gráfico queda limpio y el ciclo actual se lee de un vistazo. */
function renderMarkers(){
  if(!S.markerApi)return;
  const own=S.markers.filter(m=>!m.symbol||m.symbol===S.symbol).sort((a,b)=>(a.eventTime||a.time)-(b.eventTime||b.time));
  const show=new Set(own.map((m,i)=>['entry','exit','risk','spike','spikeexit'].includes(m.type)?i:-1).filter(i=>i>=0).slice(-(RECENT_MARKER_TEXT-1)));if(own.length)show.add(own.length-1);
  const arr=own.map((m,i)=>markerSpec(m,show.has(i))).sort((a,b)=>a.time-b.time);
  try{S.markerApi.setMarkers(arr)}catch{
    const fallback=arr.map(x=>({id:x.id,time:x.time,position:x.shape==='arrowUp'?'belowBar':x.shape==='arrowDown'?'aboveBar':'inBar',color:x.color,shape:x.shape,text:x.text,size:x.size}));
    try{S.markerApi.setMarkers(fallback)}catch{}
  }
}
function clearMarkersFor(sym){S.markers=S.markers.filter(m=>m.symbol!==sym);renderMarkers()}
/* Suaviza la proyección entre cálculos y la mantiene hasta 30 s si un cálculo no encuentra patrones. */
function updateProj(M){
  const p=M.algorithm?.historical?.proj,now=Date.now(),o=M.proj;
  if(p){if(o&&now-o.at<PROJ_HOLD_MS){const k=.35,mix=(a,b)=>a.map((v,i)=>b[i]*(1-k)+v*k);M.proj={mean:mix(p.mean,o.mean),band:mix(p.band,o.band),atr:p.atr,count:p.count,sim:p.sim,at:now}}else M.proj={...p,at:now}}
  else if(o&&now-o.at>PROJ_HOLD_MS)M.proj=null;
}
/* Proyección: camino promedio (y banda) de lo que hizo el precio después de patrones parecidos. */
function renderProjection(){
  const ser=S.projSeries;if(!S.chart||!ser?.length)return;
  const clear=()=>ser.forEach(x=>{try{x.setData([])}catch{}});
  const M=VM(),pj=M?.proj,price=M?.prices.at(-1),last=S.candles.at(-1)?.time,tf=S.timeframe;
  if(!M||!pj||!Number.isFinite(price)||!last||tf>300){clear();return}
  const K=pj.mean.length,t0=M.times.at(-1)||last,val=(arr,k)=>{k=clamp(k,0,K);const i=Math.floor(k),f=k-i,v=n=>n<=0?0:arr[Math.min(n,K)-1];return v(i)+(v(i+1)-v(i))*f};
  const pts=[{time:last,k:0}];for(let t=last+tf;t-t0<=K*60+tf&&pts.length<14;t+=tf)pts.push({time:t,k:(t-t0)/60});
  const A=pj.atr,line=sg=>pts.map(q=>({time:q.time,value:price+(val(pj.mean,q.k)+sg*val(pj.band,q.k))*A}));
  try{ser[0].setData(line(0));ser[1].setData(line(1));ser[2].setData(line(-1))}catch{clear()}
}

/* ---------- INDICADORES ---------- */
function atr(candles,n=14){const a=candles.slice(-n-1);if(a.length<3)return 0;const tr=[];for(let i=1;i<a.length;i++){const c=a[i],p=a[i-1];tr.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)))}return avg(tr)}
function rsi(values,n=14){if(values.length<n+1)return 50;let g=0,l=0;for(let i=values.length-n;i<values.length;i++){const d=values[i]-values[i-1];if(d>0)g+=d;else l-=d}if(l===0)return 100;const rs=(g/n)/(l/n||1e-9);return 100-100/(1+rs)}
function metrics(M){
  const cs=M.engineCandles.slice(-60);if(cs.length<24)return null;const closes=cs.map(c=>c.close),ranges=cs.map(c=>c.high-c.low),A=atr(cs,14)||sd(closes.slice(-20))||Math.abs(closes.at(-1))*.00001;
  const fast=ema(closes.slice(-24),9),slow=ema(closes.slice(-35),21),fastPrev=ema(closes.slice(-26,-2),9),slope=(fast-fastPrev)/A;
  const R=rsi(closes,14),last=cs.at(-1),prev=cs.at(-2),prev3=cs.at(-4);const mom3=(last.close-prev3.close)/A,body=(last.close-last.open)/A,lastRange=(last.high-last.low)/A;
  const recentRange=avg(ranges.slice(-4)),olderRange=avg(ranges.slice(-12,-4))||A,compression=recentRange/olderRange;
  let buy=0,sell=0;
  if(fast>slow)buy+=1.1;else sell+=1.1;
  if(slope>.045)buy+=.9;if(slope<-.045)sell+=.9;
  if(mom3>.12)buy+=.8;if(mom3<-.12)sell+=.8;
  if(R>=43&&R<=64)buy+=.45;if(R>=36&&R<=57)sell+=.45;
  if(compression<.92){buy+=.35;sell+=.35}
  if(R<38&&body>0)buy+=.85;if(R>62&&body<0)sell+=.85;
  const dir=buy>sell+.45?'ALZA ↑':sell>buy+.45?'BAJA ↓':'NEUTRAL';const best=Math.max(buy,sell);const conf=clamp(Math.round(45+best*10),48,92);
  const late=Math.abs(mom3)>1.05||lastRange>1.30||Math.abs(body)>1.0;
  return {cs,closes,A,fast,slow,slope,R,mom3,body,lastRange,compression,buy,sell,dir,best,conf,late,last,prev};
}
/* detect=true solo una vez por tick (runEngine). El contador tickCount de cada mercado solo crece,
   así el detector de spikes no se traba cuando el historial llega al tope de 1500 ticks. */
function spikeRisk(M,detect=false){
  const p=M.prices.slice(-240);if(p.length<35)return {risk:0,text:'SIN DATOS',prep:0,dir:'NEUTRAL',ticksSince:null};
  const ds=p.slice(1).map((v,i)=>v-p[i]),base=ds.slice(0,-8),sigma=sd(base)||sd(ds)||1e-9;
  const recent=ds.slice(-12),recentSigma=sd(recent),compression=recentSigma/(sd(ds.slice(-100))||sigma);
  const dir=M.bias;
  const R=rsi(p.slice(-80),14),trend=(p.at(-1)-p.at(-25))/(sigma*5||1),expectedUp=dir.startsWith('ALZA');
  const extreme=expectedUp?clamp((42-R)*2.2,0,30):clamp((R-58)*2.2,0,30);
  const drift=expectedUp?clamp((-trend)*5,0,22):clamp(trend*5,0,22);
  const squeeze=compression<.82?clamp((.82-compression)*45,0,18):0;
  const accel=Math.abs(avg(recent.slice(-3)))/(sigma||1);
  let prep=clamp(Math.round(18+extreme+drift+squeeze+clamp(accel*6,0,16)),8,94);
  const lastAbs=Math.abs(ds.at(-1)||0);
  if(detect&&lastAbs>sigma*5.2&&M.tickCount-M.lastSpikeTick>5){
    M.lastSpikeTick=M.tickCount;M.lastSpikeEventAt=M.times.at(-1)||nowSec();M.lastSpikePrice=p.at(-1);logEvent('SPIKE DETECTADO',dir,p.at(-1),prep,'NO PERSEGUIR',M.name);
    const jump=ds.at(-1)||0;if(dir!=='NEUTRAL'&&Math.sign(jump)===(expectedUp?1:-1)){M.spikeSizes.push(Math.abs(jump));if(M.spikeSizes.length>24)M.spikeSizes.shift();M.spikeSize=estimateSpikeSize(M)}
  }
  const ticksSince=M.lastSpikeTick?Math.max(0,M.tickCount-M.lastSpikeTick):null;
  return {risk:prep,text:`${dir} · preparación ${prep}%`,prep,dir,ticksSince,R,compression};
}

/* ---------- MOTOR ALGORÍTMICO + HISTÓRICO + ESTRATEGIAS ---------- */
function normPath(candles){
  if(!candles?.length)return [];
  const base=candles[0].close||1;
  return candles.map(c=>(c.close-base)/(Math.abs(base)||1));
}
function patternSignature(candles,n=12){
  const cs=candles.slice(-n);if(cs.length<n)return null;
  const base=cs[0].close||1, scale=avg(cs.map(c=>Math.max(c.high-c.low,Math.abs(c.close-c.open))))||Math.abs(base)*1e-6;
  return cs.map(c=>({p:(c.close-base)/scale,r:(c.high-c.low)/scale,b:(c.close-c.open)/scale}));
}
function patternSimilarity(a,b){
  if(!a||!b||a.length!==b.length)return 0;
  let e=0;
  for(let i=0;i<a.length;i++)e+=Math.abs(a[i].p-b[i].p)*.62+Math.abs(a[i].r-b[i].r)*.23+Math.abs(a[i].b-b[i].b)*.15;
  return clamp(1-e/a.length,0,1);
}
function historicalAnalog(M){
  const cs=M.engineCandles.slice();const n=12,forward=6;
  if(cs.length<n+forward+12)return {score:0,dir:'NEUTRAL',text:'Histórico insuficiente',matches:[],proj:null};
  const current=patternSignature(cs.slice(-n),n), matches=[], near=[];
  const maxEnd=cs.length-n-forward-22;
  for(let end=n;end<=maxEnd;end++){
    const win=cs.slice(end-n,end), sig=patternSignature(win,n);const sim=patternSimilarity(current,sig);
    // Proyección: los 8 patrones más cercanos (solo para mostrar; no vota)
    if(sim>=PROJ_MIN_SIM&&(near.length<8||sim>near[near.length-1].sim)){
      const st=cs[end-1].close,ba=atr(cs.slice(Math.max(0,end-16),end),14)||Math.abs(st)*1e-5,path=[];for(let k=0;k<forward;k++)path.push((cs[end+k].close-st)/ba);
      if(path.every(Number.isFinite)){near.push({sim,path});near.sort((a,b)=>b.sim-a.sim);if(near.length>8)near.pop()}
    }
    if(sim<.68)continue;
    const start=cs[end-1].close, future=cs[end+forward-1].close, baseAtr=atr(cs.slice(Math.max(0,end-16),end),14)||Math.abs(start)*1e-5;
    const move=(future-start)/baseAtr; if(!Number.isFinite(move))continue;
    const dir=move>.18?'ALZA ↑':move<-.18?'BAJA ↓':'NEUTRAL';
    matches.push({sim,move,dir,time:cs[end-1].time,forward:Math.round(move*100)/100});
  }
  // Camino promedio de los patrones cercanos (en ATR), ponderado por parecido, con su dispersión.
  let proj=null;
  if(near.length>=3){const mean=[],band=[];
    for(let k=0;k<forward;k++){let s=0,w=0;for(const x of near){const ww=x.sim*x.sim;s+=ww*x.path[k];w+=ww}const mu=s/w;let v=0;for(const x of near){const ww=x.sim*x.sim;v+=ww*(x.path[k]-mu)**2}mean.push(mu);band.push(Math.sqrt(v/w))}
    proj={mean,band,atr:atr(cs.slice(-16),14)||Math.abs(cs.at(-1).close)*1e-5,count:near.length,sim:avg(near.map(x=>x.sim))}}
  matches.sort((a,b)=>b.sim-a.sim);const top=matches.slice(0,8);if(!top.length)return {score:0,dir:'NEUTRAL',text:'Sin patrón histórico suficientemente parecido',matches:[],proj};
  let up=0,down=0,weight=0;for(const x of top){const w=x.sim*x.sim;weight+=w;if(x.dir.startsWith('ALZA'))up+=w;if(x.dir.startsWith('BAJA'))down+=w}
  const best=Math.max(up,down),dir=best&&best/Math.max(weight,1)>.55?(up>down?'ALZA ↑':'BAJA ↓'):'NEUTRAL';
  const score=Math.round(clamp((best/Math.max(weight,1))*100,0,100));
  const lead=top[0];const when=new Date(lead.time*1000).toLocaleTimeString('es-SV',{hour:'2-digit',minute:'2-digit'});
  return {score,dir,matches:top,proj,text:`${top.length} analogías · mejor similitud ${Math.round(lead.sim*100)}% · resultado histórico ${lead.dir} · ${when}`};
}
function tfContext(M){
  const out=[];
  for(const tf of [300,900,1800,3600]){
    const cs=aggregateCandles(M.engineCandles,tf).slice(-24);if(cs.length<8)continue;
    const closes=cs.map(c=>c.close),f=ema(closes.slice(-18),6),sl=ema(closes.slice(-24),12),s=(f-sl)/(atr(cs,10)||Math.abs(closes.at(-1))*1e-6);
    out.push({tf,dir:s>.08?'ALZA ↑':s<-.08?'BAJA ↓':'NEUTRAL',strength:clamp(Math.abs(s)*20,0,100)});
  }
  return out;
}
function evaluateStrategies(M,m,sp,hist){
  const last=m?.last;if(!m||!last)return [];
  const out=[];const add=(name,dir,score,why)=>out.push({name,dir,score:Math.round(clamp(score,0,100)),why});
  const trend=m.fast>m.slow?'ALZA ↑':m.fast<m.slow?'BAJA ↓':'NEUTRAL';
  add('Continuación de tendencia',trend,42+Math.abs(m.slope)*18+(trend===m.dir?15:0),'EMA + pendiente');
  const breakout=m.last.close>m.prev.high?'ALZA ↑':m.last.close<m.prev.low?'BAJA ↓':'NEUTRAL';
  add('Ruptura de estructura',breakout,38+Math.abs(m.mom3)*18+(Math.abs(m.mom3)>.25?12:0),'ruptura + momentum');
  const pull=m.R<42&&m.body>0?'ALZA ↑':m.R>58&&m.body<0?'BAJA ↓':'NEUTRAL';
  add('Pullback / recuperación',pull,35+(m.compression<.95?12:0)+Math.abs(m.slope)*10,'agotamiento + recuperación');
  const mr=m.R<30?'ALZA ↑':m.R>70?'BAJA ↓':'NEUTRAL';
  add('Reversión RSI',mr,32+(Math.abs(m.R-50)>18?18:0),'extremo RSI');
  const comp=m.compression<.82?(m.slope>0?'ALZA ↑':m.slope<0?'BAJA ↓':'NEUTRAL'):'NEUTRAL';
  add('Compresión + expansión',comp,40+(m.compression<.82?25:0)+Math.abs(m.slope)*12,'compresión antes de expansión');
  const mom=m.mom3>.18?'ALZA ↑':m.mom3<-.18?'BAJA ↓':'NEUTRAL';
  add('Momentum',mom,38+Math.min(35,Math.abs(m.mom3)*30),'aceleración de corto plazo');
  const range=m.R<40&&m.body>0?'ALZA ↑':m.R>60&&m.body<0?'BAJA ↓':'NEUTRAL';
  add('Rechazo de rango',range,34+(m.lastRange<1?10:0),'rechazo + cierre');
  add('Preparación de spike',sp.dir,sp.prep||0,'motor spike');
  add('Analogía histórica',hist.dir,hist.score||0,hist.text||'');
  const mt=tfContext(M);
  if(mt.length){const up=mt.filter(x=>x.dir.startsWith('ALZA')).reduce((a,x)=>a+x.strength,0),down=mt.filter(x=>x.dir.startsWith('BAJA')).reduce((a,x)=>a+x.strength,0);add('Confluencia multitemporal',up>down&&up>20?'ALZA ↑':down>up&&down>20?'BAJA ↓':'NEUTRAL',clamp(35+Math.abs(up-down)*.45,0,90),mt.map(x=>`${x.tf/60}m:${x.dir}`).join(' · '));}
  return out.sort((a,b)=>b.score-a.score);
}
function algorithmicEngine(M,m,sp){
  const hist=historicalAnalog(M);const strategies=evaluateStrategies(M,m,sp,hist);const top=strategies[0]||{name:'Sin estrategia',dir:'NEUTRAL',score:0};
  const sameDir=(x,y)=>x!=='NEUTRAL'&&y!=='NEUTRAL'&&x.startsWith(y.split(' ')[0]);
  const normalDir=m?.dir||'NEUTRAL', spikeDir=sp?.dir||'NEUTRAL';
  let votes=top.score*.35+hist.score*.20+(sp?.prep||0)*.20+(m?.conf||0)*.15;
  if(sameDir(top.dir,normalDir))votes+=7;if(sameDir(top.dir,spikeDir))votes+=7;
  const dirVotes={};for(const x of strategies.slice(0,6)){if(x.dir!=='NEUTRAL')dirVotes[x.dir]=(dirVotes[x.dir]||0)+x.score}
  let dir='NEUTRAL';if((dirVotes['ALZA ↑']||0)>(dirVotes['BAJA ↓']||0)*1.12)dir='ALZA ↑';else if((dirVotes['BAJA ↓']||0)>(dirVotes['ALZA ↑']||0)*1.12)dir='BAJA ↓';
  const score=Math.round(clamp(votes,0,96));const confluence=dir==='NEUTRAL'?'MIXTA':`${dir} · ${score}%`;
  return {score,dir,strategy:top.name,confluence,historical:hist,strategies};
}
function updateAlgorithmUI(a){
  if(!a)return;setText('algoScore',`${a.score}%`);setText('algoStrategy',a.strategy||'—');setText('algoDir',a.dir||'NEUTRAL');setText('algoConfluence',a.confluence||'—');
  setText('historicalPattern',a.historical?.text||'Sin patrón histórico');
  setText('strategyScores',(a.strategies||[]).slice(0,10).map(x=>`${x.name}: ${x.dir} · ${x.score}%`).join('\n')||'—');
}
function clearAlgorithmUI(){for(const id of ['algoScore','algoStrategy','algoDir','algoConfluence','strategyScores'])setText(id,'—');setText('historicalPattern','Buscando patrones similares en el historial disponible…')}

/* ---------- MOTOR SPIKE (aparte de las entradas normales) ----------
   Zona: preparación de spike ≥ 70%. Entrada: además, el historial de ESE mercado (2000 velas M1) muestra que con
   preparación alta llegaron más spikes que lo normal (≥ ×1.15). Salida: apenas llega el spike, al vencer la ventana
   (35% del promedio de ticks entre spikes) o en el stop. */
function rsiSeries(cl,n=14){const out=new Array(cl.length).fill(50);if(cl.length<=n)return out;let g=0,l=0;for(let i=1;i<=n;i++){const d=cl[i]-cl[i-1];if(d>0)g+=d;else l-=d}g/=n;l/=n;out[n]=l===0?100:100-100/(1+g/l);for(let i=n+1;i<cl.length;i++){const d=cl[i]-cl[i-1];g=(g*(n-1)+(d>0?d:0))/n;l=(l*(n-1)+(d<0?-d:0))/n;out[i]=l===0?100:100-100/(1+g/l)}return out}
function proxySeries(cs,up,S0){
  const cl=cs.map(c=>c.close),R=rsiSeries(cl),rg=cs.map(c=>c.high-c.low),out=new Array(cs.length).fill(null);
  for(let i=14;i<cs.length;i++){const ext=up?clamp((45-R[i])*1.6,0,35):clamp((R[i]-55)*1.6,0,35),dr=clamp((up?cl[i-10]-cl[i]:cl[i]-cl[i-10])/S0*25,0,35),a4=avg(rg.slice(i-3,i+1)),a12=avg(rg.slice(i-11,i+1))||1e-9,q=a4/a12;out[i]=ext+dr+(q<.85?clamp((.85-q)*60,0,15):0)}
  return out;
}
function spikeHistory(M){
  const cs=M.histCandles.length?M.histCandles:M.engineCandles,N=spikeEvery(M),S0=M.spikeSize;if(cs.length<150||!N||!S0||M.bias==='NEUTRAL')return null;
  const up=M.bias.startsWith('ALZA'),thr=S0*.45,isS=cs.map((c,i)=>{const b=i?(up?Math.max(c.open,cs[i-1].close):Math.min(c.open,cs[i-1].close)):c.open;return up?c.high-b>=thr:b-c.low>=thr});
  const px=proxySeries(cs,up,S0),rows=[];let since=99;
  for(let i=0;i<cs.length-1;i++){since=isS[i]?0:since+1;if(i<20||px[i]==null)continue;rows.push({p:px[i],s:since,y:isS[i+1]?1:0})}
  if(rows.length<100)return null;
  const p0=avg(rows.map(r=>r.y)),srt=rows.map(r=>r.p).sort((a,b)=>a-b),t70=srt[Math.floor(srt.length*.7)],hi=rows.filter(r=>r.p>=t70),m=20;
  const pHigh=(hi.reduce((x,r)=>x+r.y,0)+p0*m)/(hi.length+m),lateCut=N/60,late=rows.filter(r=>r.s>=lateCut),early=rows.filter(r=>r.s<lateCut);
  return {n:rows.length,hours:rows.length/60,p0,t70,pHigh,nHigh:hi.length,lift:p0?pHigh/p0:1,pLate:late.length>=20?avg(late.map(r=>r.y)):null,pEarly:early.length>=20?avg(early.map(r=>r.y)):null};
}
function currentProxy(M){const cs=M.engineCandles;if(cs.length<30||!M.spikeSize)return null;return proxySeries(cs.slice(-40),M.bias.startsWith('ALZA'),M.spikeSize).at(-1)}
function histHot(M){const h=M.hist;if(!h||h.nHigh<SPK_MIN_HIGH||h.lift<SPK_LIFT)return false;const c=currentProxy(M);return c!=null&&c>=h.t70}
function tickStats(M){const p=M.prices.slice(-300),ds=[];for(let i=1;i<p.length;i++)ds.push(p[i]-p[i-1]);if(ds.length<30)return null;const cut=8*median(ds.map(Math.abs)),core=ds.filter(d=>Math.abs(d)<=cut);return {drift:avg(core),sigma:sd(core)}}
function spikeEngine(M,price,epoch,sp){
  const K=M.spk;if(K.trade){monitorSpikeTrade(M,price,epoch);return}
  const N=spikeEvery(M);if(!S.spikeOn||M.bias==='NEUTRAL'||!M.spikeSize||!N||M.tickCount<K.cool){if(K.zone){K.zone=null;scheduleScan()}return}
  if(!(sp.prep>=SPK_ZONE&&(sp.ticksSince==null||sp.ticksSince>=5))){if(K.zone){K.zone=null;scheduleScan()}return}
  if(!K.zone){K.zone={at:Date.now(),epoch,prep:sp.prep};scheduleScan();if(isView(M)&&Date.now()-K.voiceAt>180000){K.voiceAt=Date.now();queueSpeech('Zona de spike.',25)}}
  if(!(M.activeSignal||M.setup||S.demoPosition?.symbol===M.sym)&&histHot(M))openSpikeTrade(M,price,epoch,N);
}
function openSpikeTrade(M,price,epoch,N){
  const up=M.bias.startsWith('ALZA'),S0=M.spikeSize,H=Math.max(15,Math.round(SPK_WIN*N)),ts=tickStats(M),dv=ts?-ts.drift*(up?1:-1):0;
  const v=dv>0?dv:S0/N,risk=v*H*1.4+(ts?ts.sigma*2:0);
  const k={id:'K'+Date.now()+M.sym,dir:up?'ALZA ↑':'BAJA ↓',entry:price,entryEpoch:epoch,entryAt:Date.now(),H,stop:price-(up?1:-1)*risk,tp:price+(up?1:-1)*S0*.6,size:S0,base:1-Math.exp(-H/N),lift:M.hist?.lift||1,symbol:M.sym,marketName:M.name};
  M.spk.trade=k;M.spk.zone=null;
  addMarker('spike',k.dir,price,epoch,`⚡ SPIKE ${up?'↑':'↓'}`,true,M.sym);logEvent('ENTRADA SPIKE',k.dir,price,Math.round(k.base*100),`HIST ×${k.lift.toFixed(2)}`,M.name);
  announce(M,`Entrada de spike. ${up?'Compra':'Venta'}.`,`Entrada de spike en ${M.short}. ${up?'Compra':'Venta'}.`,72,'entry');
  if(isView(M))drawActiveLevels();scheduleScan();markDirty();
}
function monitorSpikeTrade(M,price,epoch){
  const k=M.spk.trade,up=k.dir.startsWith('ALZA'),n=M.prices.length,jump=(price-(n>1?M.prices[n-2]:price))*(up?1:-1);
  if(jump>=k.size*.45){closeSpikeTrade(M,'SPIKE',price,epoch);return}
  if(up?price<=k.stop:price>=k.stop){closeSpikeTrade(M,'STOP',price,epoch);return}
  if(epoch-k.entryEpoch>=k.H)closeSpikeTrade(M,'SIN SPIKE',price,epoch);
}
function closeSpikeTrade(M,reason,price,epoch,quiet=false){
  const k=M.spk.trade;if(!k)return;const up=k.dir.startsWith('ALZA'),res=(price-k.entry)*(up?1:-1),risk=Math.abs(k.entry-k.stop)||1e-9;
  M.spk.trade=null;M.spk.cool=M.tickCount+SPK_COOLDOWN;
  addMarker('spikeexit',k.dir,price,epoch,reason==='SPIKE'?`⚡ ${fmt2(res)}`:`${reason} ${fmt2(res)}`,true,M.sym);
  logEvent(`SALIDA SPIKE · ${reason}`,k.dir,price,0,res>=0?'GANADA':'PERDIDA',M.name);addStat('spike',reason==='SPIKE',res/risk,k.base);
  if(!quiet)announce(M,reason==='SPIKE'?'¡Spike! Cerrar ahora.':reason==='STOP'?'Stop de la operación spike. Salir.':'No llegó el spike. Salir.',reason==='SPIKE'?`¡Spike en ${M.short}! Cerrar ahora.`:`Salir de la operación spike en ${M.short}.`,95,'exit');
  if(isView(M))drawActiveLevels();scheduleScan();markDirty();
}

/* ---------- CICLO DE SEÑAL (POR MERCADO) ---------- */
function baseSignal(partial={}){return {dir:'NEUTRAL',conf:0,phase:'⚪ ESPERANDO',reason:'Buscando estructura.',alert:null,trigger:null,entry:null,target:null,stop:null,spikeRisk:0,spikeText:'—',timing:'ESPERANDO',...partial}}
function setSignal(M,partial={}){if(!M){updateSignalUI();return}M.signal=baseSignal(partial);if(isView(M))updateSignalUI();scheduleScan();markDirty()}
function setupSignal(M,s,sp,near=false){
  const c=confluenceFor(M,s.dir),tail=` · Confluencia ${c.favor}/${c.total} · Algoritmo ${c.algoScore}% ${arrowOf(c.algoDir)}`;
  if(near)setSignal(M,{dir:s.dir,conf:s.conf,phase:'🟡 POSIBLE ENTRADA',reason:`Precio acercándose al disparador ${fmt(s.trigger)}. Todavía NO entrar.${tail}`,alert:s.createdPrice,trigger:s.trigger,spikeRisk:sp.risk,spikeText:sp.text,timing:'CERCA DEL TRIGGER'});
  else setSignal(M,{dir:s.dir,conf:s.conf,phase:'🟠 PRE-ALERTA',reason:`Estructura en preparación. Vigilar el disparador ${fmt(s.trigger)}. La entrada aún NO está confirmada.${tail}`,alert:s.createdPrice,trigger:s.trigger,spikeRisk:sp.risk,spikeText:sp.text,timing:'PRE-ALERTA'});
}
function createSetup(M,m,price,epoch){
  const up=m.dir.startsWith('ALZA');const trigger=up?Math.max(m.last.high,m.prev.high)+m.A*.06:Math.min(m.last.low,m.prev.low)-m.A*.06;const invalid=up?Math.min(m.last.low,m.prev.low)-m.A*.45:Math.max(m.last.high,m.prev.high)+m.A*.45;
  M.setup={id:'S'+Date.now()+M.sym,dir:m.dir,createdPrice:price,createdEpoch:epoch,createdCandle:m.last.time,trigger,invalid,atr:m.A,conf:m.conf,expiresAt:epoch+S.engineTimeframe*3,score:m.best};
  addMarker('alert',m.dir,price,m.last.time,`ALERTA ${up?'↑':'↓'}`,true,M.sym);
  setTiming(M,'PRE-ALERTA A TIEMPO','early');const sp=M.sp||spikeRisk(M);
  setupSignal(M,M.setup,sp,false);if(isView(M))drawActiveLevels();
  logEvent('PRE-ALERTA',m.dir,price,m.conf,'A TIEMPO',M.name);
  announce(M,`Pre alerta. Posible ${up?'compra':'venta'}.`,`Pre alerta en ${M.short}. Posible ${up?'compra':'venta'}.`,30,'prealert');
}
function cancelSetup(M,reason,late=false,price=null,label='CANCELADA',timing='INVALIDADA'){
  const s=M.setup;if(!s)return;const p=Number.isFinite(price)?price:M.prices.at(-1);const t=M.times.at(-1)||nowSec();const sp=M.sp||spikeRisk(M);
  if(late){addMarker('cancel',s.dir,p,t,'TARDE',true,M.sym);setTiming(M,'MOVIMIENTO YA EJECUTADO · ENTRADA BLOQUEADA','late');setSignal(M,{dir:s.dir,conf:s.conf,phase:'⛔ MOVIMIENTO YA EJECUTADO',reason:'El precio recorrió demasiado antes de confirmar el disparador. RADAR no persigue el movimiento.',alert:s.createdPrice,trigger:s.trigger,spikeRisk:sp.risk,spikeText:sp.text,timing:'TARDE BLOQUEADO'});logEvent('BLOQUEADA TARDE',s.dir,p,s.conf,'MOVIMIENTO EJECUTADO',M.name)}
  else{setTiming(M,'ALERTA CANCELADA','waiting');setSignal(M,{phase:'⚪ ALERTA CANCELADA',reason,spikeRisk:sp.risk,spikeText:sp.text,timing:'CANCELADA'});logEvent(label,s.dir,p,s.conf,timing,M.name)}
  M.setup=null;M.cooldownUntil=t+Math.max(15,S.engineTimeframe*.5);if(isView(M))drawActiveLevels();
}
function confirmSetup(M,price,epoch,m){
  const s=M.setup;if(!s)return;const up=s.dir.startsWith('ALZA');const overshoot=up?price-s.trigger:s.trigger-price,travel=Math.abs(price-s.createdPrice);
  if(overshoot>s.atr*.42||travel>s.atr*.95){cancelSetup(M,'Movimiento demasiado extendido.',true,price);return}
  const sp=M.sp||spikeRisk(M);
  if(CFG.spikeGuard&&counterSpike(M,s.dir)&&(sp.prep>=SPIKE_BLOCK||(CFG.histGuard&&sp.prep>=SPK_ZONE&&histHot(M)))){cancelSetup(M,`Riesgo de spike alto (${sp.prep}%): entrada en contra del spike bloqueada.`,false,price,'BLOQUEADA POR SPIKE',`SPIKE ${sp.prep}%`);return}
  if(CFG.confluence&&!confluenceFor(M,s.dir).ok){cancelSetup(M,'Las estrategias dejaron de confirmar la entrada.',false,price,'CANCELADA SIN CONFLUENCIA','SIN CONFLUENCIA');return}
  const target=price+(up?1:-1)*s.atr*1.65,stop=price-(up?1:-1)*s.atr*.78;
  M.activeSignal={id:s.id,dir:s.dir,entry:price,entryEpoch:epoch,entryCandle:epoch,entryAt:Date.now(),target,stop,atr:s.atr,conf:Math.max(s.conf,m?.conf||0),bestPrice:price,reboundWarned:false,spikeWarned:false,impulseWarned:false,symbol:M.sym,marketName:M.name};M.setup=null;
  const a=M.activeSignal;addMarker('entry',a.dir,price,epoch,`ENTRADA ${up?'↑':'↓'}`,true,M.sym);if(isView(M))drawActiveLevels();setTiming(M,'ENTRADA CONFIRMADA A TIEMPO','ready');
  setSignal(M,{dir:a.dir,conf:a.conf,phase:'🟢 ENTRAR AHORA',reason:`Disparador confirmado sin persecución del precio. Objetivo ${fmt(target)} · Stop ${fmt(stop)}.`,entry:price,target,stop,spikeRisk:sp.risk,spikeText:sp.text,timing:'CONFIRMADA'});
  logEvent('ENTRADA',a.dir,price,a.conf,'A TIEMPO',M.name);
  announce(M,`Ejecutar ahora. ${up?'Compra':'Venta'}.`,`Entrada en ${M.short}. ${up?'Compra':'Venta'} ahora.`,70,'entry');
}
function closeSignal(M,reason,price,epoch,quiet=false){
  const a=M.activeSignal;if(!a)return;const res=(price-a.entry)*(a.dir.startsWith('ALZA')?1:-1);addMarker('exit',a.dir,price,epoch,`SALIDA ${fmt2(res)}`,true,a.symbol);
  M.activeSignal=null;M.cooldownUntil=epoch+S.engineTimeframe;M.lastExitAt=Date.now();if(isView(M))drawActiveLevels();setTiming(M,'CICLO FINALIZADO','waiting');
  const sp=M.sp||spikeRisk(M);
  setSignal(M,{dir:a.dir,conf:a.conf,phase:'🔵 SALIR AHORA',reason:`${reason}. El ciclo queda cerrado y RADAR vuelve a buscar una nueva oportunidad.`,entry:a.entry,target:a.target,stop:a.stop,spikeRisk:sp.risk,spikeText:sp.text,timing:'SALIDA'});
  logEvent('SALIDA '+reason,a.dir,price,a.conf,'CICLO CERRADO',a.marketName||M.name);
  addStat('radar',res>0,res/(Math.abs(a.entry-a.stop)||1e-9));
  if(!quiet)announce(M,`Salir ahora. ${reason}`,`Salir ahora en ${M.short}. ${reason}`,90,'exit');
}
/* La señal activa de un mercado solo se evalúa con los ticks de ese mismo mercado.
   Si es la operación demo del usuario (a.demo), el RADAR no la cierra: avisa rebote,
   pérdida de impulso y riesgo de spike; el objetivo y el stop los maneja la demo. */
function monitorSignal(M,price,epoch,m){
  const a=M.activeSignal;if(!a)return;const up=a.dir.startsWith('ALZA'),follow=!!a.demo,lv=follow&&S.demoPosition?.symbol===M.sym?S.demoPosition:a;
  if(up)a.bestPrice=Math.max(a.bestPrice,price);else a.bestPrice=Math.min(a.bestPrice,price);
  if(!follow){
    if((up&&price>=a.target)||(!up&&price<=a.target)){closeSignal(M,'OBJETIVO ALCANZADO',price,epoch);return}
    if((up&&price<=a.stop)||(!up&&price>=a.stop)){closeSignal(M,'STOP',price,epoch);return}
  }
  const favorable=(price-a.entry)*(up?1:-1),retr=(a.bestPrice-price)*(up?1:-1);const tickMom=M.prices.length>6?(price-M.prices.at(-6))/a.atr:0;
  const opposite=up?tickMom<-.18:tickMom>.18;const extreme=up?m?.R>68:m?.R<32;const sp=M.sp||spikeRisk(M);
  const base={dir:a.dir,conf:a.conf,entry:a.entry,target:lv.target,stop:lv.stop,spikeRisk:sp.risk,spikeText:sp.text};
  // Con margen: una vez avisado, el riesgo se mantiene hasta que la preparación baje de 72% (evita parpadeo).
  if(CFG.spikeGuard&&counterSpike(M,a.dir)&&(sp.prep>=SPIKE_EXIT||(follow&&a.spikeWarned&&CFG.smartRebound&&sp.prep>=SPIKE_EXIT-8)||(CFG.histGuard&&sp.prep>=SPIKE_BLOCK&&histHot(M)))){
    if(!follow){closeSignal(M,'RIESGO DE SPIKE',price,epoch);return}
    if(!a.spikeWarned){a.spikeWarned=true;addMarker('risk',a.dir,price,epoch,'⚠ SPIKE',true,M.sym);logEvent('AVISO RIESGO SPIKE',a.dir,price,sp.prep,'CONSIDERE SALIR',M.name);announce(M,'Riesgo de spike alto. Considere salir.',`Riesgo de spike alto en ${M.short}. Considere salir.`,85,'exit')}
    setSignal(M,{...base,phase:'⚠ RIESGO DE SPIKE',reason:`Preparación de spike ${sp.prep}% en contra de su operación. Considere salir.`,timing:'RIESGO SPIKE'});return;
  }
  // A favor de la deriva (vender Boom / comprar Crash) el RSI extremo es lo normal: solo cuenta el impulso en contra.
  const drift=CFG.smartRebound&&counterSpike(M,a.dir);
  if(!a.reboundWarned&&!a.reboundCleared&&favorable>a.atr*.35&&(opposite||(!drift&&extreme))){
    a.reboundWarned=true;a.reboundPrice=price;const reboundDir=up?'BAJA ↓':'ALZA ↑';addMarker('rebound',reboundDir,price,epoch,'REBOTE',true,M.sym);
    setSignal(M,{...base,phase:'🟡 POSIBLE REBOTE',reason:'La operación sigue activa, pero aparecen señales de agotamiento. Vigilar salida.',timing:'VIGILAR REBOTE'});
    announce(M,`Posible rebote ${up?'a la baja':'al alza'}. Vigilar salida.`,`${M.short}: posible rebote ${up?'a la baja':'al alza'}. Vigilar salida.`,45,follow?'exit':'info');
  }
  // Si después del aviso el precio sigue a favor, el rebote no se confirmó: se retira el aviso.
  if(CFG.smartRebound&&a.reboundWarned&&(price-a.reboundPrice)*(up?1:-1)>a.atr*.25){a.reboundWarned=false;a.reboundCleared=true}
  if(favorable>a.atr*.4&&retr>a.atr*.52&&opposite){
    if(!follow){closeSignal(M,'PÉRDIDA DE IMPULSO',price,epoch);return}
    if(!a.impulseWarned){a.impulseWarned=true;announce(M,'Pérdida de impulso. Considere salir.',`${M.short}: pérdida de impulso. Considere salir.`,80,'exit')}
    setSignal(M,{...base,phase:'🔵 CONSIDERE SALIR',reason:'La operación perdió el impulso a favor. Considere cerrarla.',timing:'CONSIDERE SALIR'});return;
  }
  if(!a.reboundWarned){
    const age=Date.now()-(a.entryAt||0);
    if(!follow&&age<ENTRY_HIGHLIGHT_MS){const mv=favorable/a.atr;setSignal(M,{...base,phase:'🟢 ENTRADA',reason:`Entrada confirmada hace ${Math.max(0,Math.round(age/1000))} s en ${fmt(a.entry)}. El precio va ${fmt2(mv)} ATR: ${mv>.4?'ya se alejó, no perseguir':'todavía cerca de la entrada'}.`,timing:'ENTRADA RECIENTE'})}
    else setSignal(M,{...base,phase:follow?'💼 EN OPERACIÓN':'🔵 MANTENER',reason:a.reboundCleared?'El rebote no se confirmó: el precio siguió a favor.':follow?'RADAR sigue su operación: avisa rebote, pérdida de impulso y riesgo de spike.':'La estructura de la entrada sigue vigente.',timing:'SEGUIMIENTO'});
  }
}
/* La operación demo pasa a ser el ciclo del mercado: no hay pre-alertas ni entradas nuevas en ese
   mercado mientras esté abierta, y el RADAR la acompaña con sus avisos. */
function attachDemoFollow(M,radar=null){
  const d=S.demoPosition;if(!d||d.symbol!==M.sym)return;
  M.setup=null;
  M.activeSignal={id:'F'+d.id,dir:d.dir,entry:d.entry,entryEpoch:d.openEpoch||nowSec(),entryCandle:d.openEpoch||nowSec(),entryAt:d.opened,target:d.target,stop:d.stop,atr:d.atr||M.m?.A||Math.abs(d.entry)*1e-5,conf:radar?.conf??d.conf??0,bestPrice:d.entry,reboundWarned:false,spikeWarned:false,impulseWarned:false,symbol:M.sym,marketName:M.name,demo:true};
  if(isView(M))drawActiveLevels();scheduleScan();
}
function runEngine(M,price,epoch){
  if(!M||!Number.isFinite(price))return;const view=isView(M);
  if(view){setText('price',fmt(price));setText('graphPrice',fmt(price));setText('ticks',M.prices.length)}
  const m=metrics(M),sp=spikeRisk(M,true);M.m=m;M.sp=sp;
  if(Date.now()-(M.sizeAt||0)>60000){M.sizeAt=Date.now();M.spikeSize=estimateSpikeSize(M)}
  if(view)scheduleViewRefresh(); // el panel y la fila de estado se actualizan aunque la fase no cambie
  if(!m){M.normalPrep=0;M.prep=sp.prep||0;M.prepDir=sp.dir;if(view)renderEngineReadout(M);setSignal(M,{phase:'⚪ RECOPILANDO DATOS',reason:'Esperando suficientes velas para formar estructura.',spikeRisk:sp.risk,spikeText:sp.text});return}
  let fresh=false;
  if(!M.algorithm||M.tickCount-M.algoTick>=5||Date.now()-M.algoAt>1200){M.algorithm=algorithmicEngine(M,m,sp);M.algoTick=M.tickCount;M.algoAt=Date.now();updateProj(M);fresh=true;if(view)updateAlgorithmUI(M.algorithm)}
  const algo=M.algorithm;
  const normalPrep=clamp(Math.round(45+Math.max(m.buy,m.sell)*10),0,95);M.normalPrep=normalPrep;M.prep=Math.max(normalPrep,sp.prep||0);M.prepDir=(sp.prep||0)>normalPrep?sp.dir:m.dir;
  if(view){renderEngineReadout(M);if(fresh)renderProjection()}
  if(CFG.followDemo&&S.demoPosition?.symbol===M.sym&&!M.activeSignal?.demo)attachDemoFollow(M);
  if(CFG.spikeEngine)spikeEngine(M,price,epoch,sp);
  if(M.activeSignal){monitorSignal(M,price,epoch,m);return}
  if(M.setup){
    const s=M.setup,up=s.dir.startsWith('ALZA');if(epoch>s.expiresAt){cancelSetup(M,'La alerta caducó sin confirmación.',false,price);return}
    if((up&&price<=s.invalid)||(!up&&price>=s.invalid)){cancelSetup(M,'El mercado invalidó la estructura antes de la entrada.',false,price);return}
    const directionalTravel=(price-s.createdPrice)*(up?1:-1);if(directionalTravel>s.atr*1.02){cancelSetup(M,'El mercado se movió sin darnos una confirmación limpia.',true,price);return}
    const distance=(s.trigger-price)*(up?1:-1),near=distance<=s.atr*.22&&distance>0;
    if(near){setTiming(M,'CERCA DEL DISPARADOR','early');setupSignal(M,s,sp,true)}
    else if(M.signal?.phase!=='🟠 PRE-ALERTA'){setTiming(M,'PRE-ALERTA A TIEMPO','early');setupSignal(M,s,sp,false)}
    const crossed=up?price>=s.trigger:price<=s.trigger;if(crossed){const tickMom=M.prices.length>5?(price-M.prices.at(-5))/s.atr:0;const aligned=up?tickMom>=-.03:tickMom<=.03;if(aligned)confirmSetup(M,price,epoch,m)}
    return;
  }
  if(CFG.spikeEngine&&M.spk.trade){setTiming(M,'MOTOR SPIKE EN OPERACIÓN','ready');setSignal(M,{dir:M.spk.trade.dir,conf:0,phase:'⚡ OPERACIÓN SPIKE',reason:'El motor spike tiene una operación abierta en este mercado; las entradas normales esperan.',spikeRisk:sp.risk,spikeText:sp.text,timing:'SPIKE'});return}
  if(epoch<M.cooldownUntil){setSignal(M,{dir:m.dir,conf:m.conf,phase:'⚪ REEVALUANDO',reason:'Ciclo anterior finalizado. Esperando una nueva estructura independiente.',spikeRisk:sp.risk,spikeText:sp.text});return}
  if(view){setText('direction',m.dir);setText('confidence',m.conf+'%')}
  const algoAligned=algo.dir!=='NEUTRAL'&&(algo.score>=62||algo.strategy==='Preparación de spike');
  const normalCandidate=m.dir!=='NEUTRAL'&&m.best>=2.35&&(!algoAligned||algo.dir.startsWith(m.dir.split(' ')[0]));
  const spikeCandidate=!(CFG.spikeEngine&&S.spikeOn)&&sp.dir!=='NEUTRAL'&&sp.prep>=68&&(!algoAligned||algo.dir.startsWith(sp.dir.split(' ')[0]));
  if(normalCandidate||spikeCandidate){
    let useSpike=spikeCandidate&&!normalCandidate;
    // Guardia: si el motor normal quiere ir en contra del spike con la preparación alta, manda el motor de spike.
    const hot=CFG.histGuard&&normalCandidate&&counterSpike(M,m.dir)&&sp.prep>=SPK_ZONE&&sp.prep<SPIKE_BLOCK&&histHot(M);
    if(CFG.spikeGuard&&normalCandidate&&counterSpike(M,m.dir)&&(sp.prep>=SPIKE_BLOCK||hot)){
      if(spikeCandidate)useSpike=true;
      else{setTiming(M,'ENTRADA EN CONTRA DEL SPIKE BLOQUEADA','waiting');setSignal(M,{dir:m.dir,conf:m.conf,phase:'🛡 BLOQUEADA POR SPIKE',reason:`${m.dir.startsWith('ALZA')?'Compra':'Venta'} en contra del spike bloqueada: ${hot?`preparación ${sp.prep}% y el historial de ${M.short} muestra ×${M.hist.lift.toFixed(2)} spikes en este estado`:`preparación de spike ${sp.prep}% (límite ${SPIKE_BLOCK}%)`}.`,spikeRisk:sp.risk,spikeText:sp.text,timing:'BLOQUEADA'});return}
    }
    if(useSpike){m.dir=sp.dir;m.conf=sp.prep;m.best=sp.prep/20;m.late=false}
    if(m.late){const key=`${m.dir}|${m.last.time}`;setTiming(M,'MOVIMIENTO YA EJECUTADO · SIN ENTRADA','late');setSignal(M,{dir:m.dir,conf:m.conf,phase:'⛔ MOVIMIENTO YA EJECUTADO',reason:'El impulso ya ocurrió antes de que se formara una entrada anticipada. RADAR espera el siguiente ciclo.',spikeRisk:sp.risk,spikeText:sp.text,timing:'TARDE BLOQUEADO'});if(key!==M.lastLateKey){M.lastLateKey=key;logEvent('MOVIMIENTO YA EJECUTADO',m.dir,price,m.conf,'SIN ENTRADA',M.name)}return}
    // Confluencia: las estrategias y el algoritmo tienen que respaldar la idea antes de la pre-alerta.
    if(CFG.confluence){const c=confluenceFor(M,m.dir);if(!c.ok){setTiming(M,'BUSCANDO CONFLUENCIA','waiting');setSignal(M,{dir:m.dir,conf:m.conf,phase:'⚪ ANALIZANDO',reason:`Hay una idea de ${m.dir.startsWith('ALZA')?'compra':'venta'}, pero faltan confirmaciones: ${c.favor} estrategias a favor y ${c.contra} en contra${c.algoContra?` y el algoritmo en contra (${c.algoScore}%)`:''}. Se necesitan al menos ${CONF_MIN_FAVOR} a favor y más que en contra.`,spikeRisk:sp.risk,spikeText:sp.text,timing:'SIN CONFLUENCIA'});return}}
    const bucket=m.last.time;if(M.lastSetupEvalBucket!==bucket){M.lastSetupEvalBucket=bucket;createSetup(M,m,price,epoch);if(view)updateSignalUI();return}
  }
  setTiming(M,'BUSCANDO PRE-ALERTA','waiting');setSignal(M,{dir:m.dir,conf:m.conf,phase:'⚪ ANALIZANDO',reason:'No hay una estructura anticipada suficientemente limpia. No operar.',spikeRisk:sp.risk,spikeText:sp.text,timing:'BUSCANDO'});
}

/* ---------- UI DEL MERCADO EN VISTA ---------- */
function displayDir(M,s){const d=S.demoPosition?.symbol===M?.sym?S.demoPosition:null;return d?.dir||M?.activeSignal?.dir||M?.setup?.dir||(s&&s.dir!=='NEUTRAL'&&s.dir!=='ESPERANDO'?s.dir:(M?.prepDir||'NEUTRAL'))}
function updateSignalUI(){
  const M=VM();
  const s=M?.signal||{dir:'ESPERANDO',conf:0,phase:M?'⏳ CARGANDO':'⚪ ESPERANDO',reason:M?'Descargando el histórico del mercado…':(S.ws?'Esperando datos.':'Conecte Deriv para iniciar.'),spikeRisk:0};
  setText('radarDir',s.dir);setText('direction',s.dir);setText('confidence',(s.conf||0)+'%');setText('phase',s.phase);if(els.reason)els.reason.textContent=s.reason||'';
  setText('alertLevel',fmt(s.alert));setText('triggerLevel',fmt(s.trigger));setText('entryLevel',fmt(s.entry));setText('exitLevel',fmt(s.target));setText('stopLevel',fmt(s.stop));setText('spikeRisk',(M?.sp?.prep??s.spikeRisk??0)+'%');
  const c=M?.algorithm?confluenceFor(M,displayDir(M,s)):null,cText=c&&c.total?`${c.favor}/${c.total} ${arrowOf(displayDir(M,s))}${c.contra?` · ${c.contra} en contra`:''}`:'—';
  const ts=M?.sp?.ticksSince,prepNow=M?.sp?.prep??s.spikeRisk??0,spk=`${prepNow}%${ts==null?'':` · ⚡${ts}`}`;
  setText('confluenceLevel',cText);
  setText('graphDir',s.dir);setText('graphPhase',s.phase);setText('graphConf',(s.conf||0)+'%');setText('graphConfluence',cText);setText('graphTrigger',fmt(s.trigger));setText('graphEntry',fmt(s.entry));setText('graphSpike',spk);setText('graphTarget',fmt(s.target));setText('graphStop',fmt(s.stop));setText('graphSpikeSignal',s.spikeText||'—');setText('graphReason',s.reason||'');setText('graphExecMode',($('executionMode')?.value||'manual').toUpperCase());
  renderHud();
}
/* Panel sobre el gráfico, en 2 líneas: (1) estado + plan  (2) proyección + votos. Se refresca cada 0,3 s. */
function scheduleViewRefresh(){if(S.viewTimer)return;S.viewTimer=setTimeout(()=>{S.viewTimer=null;updateSignalUI()},300)}
const shortReason=r=>{const t=String(r||'').split(/\.\s|·/)[0].trim();return t.length>90?t.slice(0,88)+'…':t};
function renderHud(){
  const hud=$('chartHud');if(!hud)return;const M=VM();
  const put=(cls,a,b,c,d)=>{const k='chart-hud '+cls+(S.hudCompact?' compact':'');if(hud.className!==k)hud.className=k;setText('hudState',a);setText('hudPlan',b);setText('hudPred',c);setText('hudVotes',d)};
  if(!M){put('wait','⚪ ESPERANDO',S.ws?'esperando datos de Deriv…':'conecte Deriv para iniciar','','');return}
  if(!M.historyReady||!M.engineHistoryReady){put('wait',`⏳ ${M.short} · CARGANDO`,'descargando el histórico…','','');return}
  const s=M.signal||baseSignal(),ph=s.phase||'',d=S.demoPosition?.symbol===M.sym?S.demoPosition:null,a=M.activeSignal,st=M.setup,sp=M.sp,price=M.prices.at(-1);
  const dir=displayDir(M,s),c=confluenceFor(M,dir),pj=M.proj;
  let cls='wait',l1=ph,l2=shortReason(s.reason);
  if(d){const up=d.dir.startsWith('ALZA'),pnl=(d.lastPrice-d.entry)*(up?1:-1),money=pnl*(d.lot||.2)*CONTRACT_SIZE;cls=ph.includes('RIESGO')?'risk':'active';l1=`${ph} · ${up?'BUY ↑':'SELL ↓'}`;l2=`P/L ${fmt2(pnl)} pts ≈ ${money<0?'−':''}$${Math.abs(money).toFixed(2)} · E ${fmtP(d.entry)} → Obj ${fmtP(d.target)} · Stop ${fmtP(d.stop)}`}
  else if(a){const up=a.dir.startsWith('ALZA'),pnl=Number.isFinite(price)?(price-a.entry)*(up?1:-1):0;cls=ph.includes('ENTRA')?'entry':'active';l1=`${ph} ${arrowOf(a.dir)}`;l2=`P/L ${fmt2(pnl)} pts · E ${fmtP(a.entry)} → Obj ${fmtP(a.target)} · Stop ${fmtP(a.stop)}`}
  else if(M.spk?.trade){const k=M.spk.trade,up=k.dir.startsWith('ALZA'),pnl=Number.isFinite(price)?(price-k.entry)*(up?1:-1):0,left=Math.max(0,k.H-((M.times.at(-1)||k.entryEpoch)-k.entryEpoch));cls='spike';l1=`⚡ SPIKE ACTIVO · ${up?'COMPRA ↑':'VENTA ↓'}`;l2=`P/L ${fmt2(pnl)} pts · quedan ${left} ticks · stop ${fmtP(k.stop)} · TP ${fmtP(k.tp)}`}
  else if(st){const up=st.dir.startsWith('ALZA'),dist=Number.isFinite(price)?(st.trigger-price)*(up?1:-1)/st.atr:NaN;cls=ph.includes('POSIBLE ENTRADA')?'near':'prealert';l1=`${ph} ${arrowOf(st.dir)}`;l2=`disparador ${fmtP(st.trigger)}${Number.isFinite(dist)?` · falta ${Math.max(0,dist).toFixed(2)} ATR`:''} · no entrar antes`}
  else if(M.spk?.zone){cls='spkzone';l1=`⚡ ZONA DE SPIKE ${arrowOf(M.bias)}`;l2=histHot(M)?'el historial de este mercado confirma: el motor spike puede entrar':`sin ventaja histórica (×${(M.hist?.lift||1).toFixed(2)}): solo aviso`}
  else if(ph.includes('BLOQUEADA')){cls='blocked';l1=`${ph} ${arrowOf(s.dir)}`;l2=`${sideOf(s.dir)==='ALZA'?'compra':'venta'} en contra del spike · preparación ${sp?.prep??0}% (límite ${SPIKE_BLOCK}%)`}
  else if(ph.includes('EJECUTADO'))cls='late';else if(ph.includes('SALIR'))cls='active';
  let l3='Proy.: sin patrones parecidos';
  if(pj){const mv=pj.mean[pj.mean.length-1],sim=Math.round(pj.sim*100);l3=`Proy. ${PROJ_MINUTES} min ${Math.abs(mv)<.18?'lateral':`${mv>0?'↑':'↓'} ${fmt2(mv*pj.atr)} pts`} (${pj.count} · ${sim}%${sim<50?' débil':''})`}
  const pos=d||a;if(pos&&counterSpike(M,pos.dir)&&M.spikeSize)l3+=` · si hay spike ≈ −${M.spikeSize.toFixed(2)} pts`;
  const l4=`${c.favor}/${c.total} ${arrowOf(dir)}${c.contra?` (${c.contra} contra)`:''} · Algo ${c.algoScore}% ${arrowOf(c.algoDir)} · Spike ${sp?.prep??0}%${sp?.ticksSince==null?'':` ⚡${sp.ticksSince}`}${M.hist?` · hist ×${M.hist.lift.toFixed(2)}`:''}`;
  put(cls,l1,l2,l3,l4);
}
function renderEngineReadout(M){
  const m=M?.m,sp=M?.sp;
  const N=M?spikeEvery(M):null,h=M?.hist;
  setText('spikeAnalysis',!M||!N?'—':`1 spike cada ${N} ticks en promedio · tamaño ≈ ${M.spikeSize?M.spikeSize.toFixed(2):'—'} pts · ventana ${Math.max(15,Math.round(SPK_WIN*N))} ticks · al azar se atrapa ≈ ${Math.round((1-Math.exp(-SPK_WIN))*100)}%`+(h?`\nHistorial (${h.hours.toFixed(0)} h): con preparación alta hubo spike al minuto siguiente ${(h.pHigh*100).toFixed(1)}% vs ${(h.p0*100).toFixed(1)}% normal (×${h.lift.toFixed(2)}) → ${h.lift>=SPK_LIFT?'el motor spike puede entrar':'solo aviso de zona'}.`+(h.pLate!=null&&h.pEarly!=null?`\nDespués de pasar el promedio de ticks: ${(h.pLate*100).toFixed(1)}% vs ${(h.pEarly*100).toFixed(1)}% antes.`:''):'\nHistorial: cargando velas…'));
  setText('spikeEngine',sp?`${sp.dir} · ${sp.prep||0}%`:'—');setText('ticksSinceSpike',sp?.ticksSince==null?'APRENDIENDO':sp.ticksSince);
  if(!m){setText('indicators','EMA: —\nRSI: —\nATR: —\nCompresión: —');setText('normalEngine','—');setText('prepState','—');return}
  setText('indicators',`EMA 9/21: ${fmt(m.fast)} / ${fmt(m.slow)}\nRSI (14): ${m.R.toFixed(1)}\nATR: ${fmt(m.A)}\nMomentum 3 velas: ${m.mom3.toFixed(2)} ATR\nCompresión: ${(m.compression*100).toFixed(0)}%${M.spikeSize?`\nSpike típico: ${M.spikeSize.toFixed(2)} pts`:''}`);
  const top=Math.max(M.normalPrep,sp?.prep||0);
  setText('normalEngine',`${m.dir} · ${M.normalPrep}%`);setText('prepState',`${top}% · ${top>=68?'PRE-ALERTA':top>=52?'OBSERVACIÓN':'BUSCANDO'}`);
}
function renderView(M){
  if(!M){updateSignalUI();return}
  const price=M.prices.at(-1);setText('price',fmt(price));setText('graphPrice',fmt(price));setText('ticks',M.prices.length);
  setText('graphMarketName',M.name);setText('cycleLabel',`CICLO ACTUAL · ${M.short.toUpperCase()}`);setText('liveTitle',`Mercado en vivo · ${M.short}`);
  renderEngineReadout(M);if(M.algorithm)updateAlgorithmUI(M.algorithm);else clearAlgorithmUI();
  applyTiming(M);updateSignalUI();renderProjection();
}
function logRow(r){const tr=document.createElement('tr');tr.innerHTML=`<td>${new Date(r.t).toLocaleTimeString()}</td><td>${r.mk}</td><td>${r.dir}</td><td>${r.ev}</td><td>${fmt(r.price)}</td><td>${r.conf||0}%</td><td>${r.timing}</td>`;return tr}
function logEvent(event,dir,price,conf,timing,marketOverride=null){const r={t:Date.now(),mk:marketOverride||currentMarketLabel(),dir,ev:event,price,conf,timing};S.log.unshift(r);if(S.log.length>HISTORY_ROWS)S.log.length=HISTORY_ROWS;els.history.prepend(logRow(r));while(els.history.children.length>HISTORY_ROWS)els.history.lastChild.remove();markDirty()}
function renderLog(){els.history.innerHTML='';for(const r of S.log)els.history.appendChild(logRow(r))}
function showView(name){document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.dataset.view===name));$(name+'View').classList.add('active');if(name==='graph')setTimeout(()=>{ensureChart();renderAll(false);showRecentCandles(60)},60)}

/* ---------- ESCÁNER MULTIMERCADO ---------- */
function scanTier(M){
  if(M.status==='ERROR')return {tier:-1,label:'⚠ SIN DATOS',cls:'err'};
  if(!M.historyReady||!M.engineHistoryReady)return {tier:0,label:M.status==='REINTENTANDO'?'↻ REINTENTANDO':'⏳ CARGANDO',cls:'load'};
  if(M.lastTickAt&&Date.now()-M.lastTickAt>STALE_MS)return {tier:0,label:'⚠ SIN TICKS',cls:'err'};
  if(M.spk?.trade)return {tier:5,label:'⚡ SPIKE ACTIVO',cls:'spike'};
  const a=M.activeSignal,ph=M.signal?.phase||'';
  if(a?.demo)return ph.includes('RIESGO')?{tier:4,label:'⚠ RIESGO SPIKE',cls:'risk'}:{tier:2,label:'💼 EN OPERACIÓN',cls:'active'};
  if(a&&Date.now()-(a.entryAt||0)<ENTRY_HIGHLIGHT_MS)return {tier:5,label:'🟢 ENTRADA',cls:'entry'};
  if(M.setup)return ph.includes('POSIBLE ENTRADA')?{tier:4,label:'🟡 CERCA',cls:'near'}:{tier:3,label:'🟠 PRE-ALERTA',cls:'prealert'};
  if(a)return {tier:2,label:a.reboundWarned?'🟡 REBOTE':'🔵 EN CURSO',cls:'active'};
  if(M.lastExitAt&&Date.now()-M.lastExitAt<EXIT_HIGHLIGHT_MS)return {tier:2,label:'🔵 SALIDA',cls:'exit'};
  if(M.spk?.zone)return {tier:3,label:'⚡ ZONA SPIKE',cls:'spkzone'};
  if(ph.includes('BLOQUEADA'))return {tier:1,label:'🛡 BLOQUEADA',cls:'blocked'};
  if(ph.includes('EJECUTADO'))return {tier:1,label:'⛔ TARDE',cls:'late'};
  return {tier:1,label:'⚪ ANALIZANDO',cls:'wait'};
}
function scanFigures(M){
  const k=M.spk?.trade;if(k||(M.spk?.zone&&!M.setup&&!M.activeSignal)){const ts=M.sp?.ticksSince;return {dir:k?k.dir:M.bias,pct:Math.round(M.sp?.prep||0),spike:ts==null?'⚡—':`⚡${ts}`}}
  const a=M.activeSignal,s=M.setup,blk=!a&&!s&&(M.signal?.phase||'').includes('BLOQUEADA');
  const dir=a?.dir||s?.dir||(blk?M.signal.dir:M.prepDir)||'NEUTRAL';
  const pct=Math.round(a?a.conf:s?s.conf:blk?(M.sp?.prep||0):(M.prep||0)),ts=M.sp?.ticksSince;
  return {dir,pct,spike:ts==null?'⚡—':`⚡${ts}`};
}
function scheduleScan(now=false){
  if(now){clearTimeout(S.scanTimer);S.scanTimer=null;renderScanner();return}
  if(S.scanTimer)return;S.scanTimer=setTimeout(()=>{S.scanTimer=null;renderScanner()},600);
}
const setNodeText=(el,v)=>{if(el&&el.textContent!==v)el.textContent=v};
function syncChildren(container,nodes){
  for(const el of [...container.children])if(!nodes.includes(el))el.remove();
  const cur=[...container.children];
  if(cur.length!==nodes.length||cur.some((el,i)=>el!==nodes[i]))nodes.forEach(el=>container.appendChild(el));
}
function makeTile(sym){
  const b=document.createElement('button');b.type='button';b.className='scan-tile';b.dataset.sym=sym;
  for(const c of ['st-name','st-pct','st-state','st-spike']){const s=document.createElement('span');s.className=c;b.appendChild(s)}
  return b;
}
function renderScanner(){
  const list=$('scanList'),strip=$('graphScan'),ms=[...S.markets.values()],live=S.ws?.readyState===1;
  const cnt=$('scanCount');if(cnt){cnt.textContent=ms.length?(live?`● ${ms.length} MERCADOS EN VIGILANCIA`:`● SIN CONEXIÓN · ${ms.length} MERCADOS`):(S.ws&&live?'BUSCANDO MERCADOS…':S.ws?'CONECTANDO…':'SIN CONEXIÓN');cnt.classList.toggle('off',!live)}
  const rows=ms.map(M=>({M,t:scanTier(M),f:scanFigures(M)})).sort((a,b)=>b.t.tier-a.t.tier||(b.t.tier>=3?b.f.pct-a.f.pct:0)||a.M.index-b.M.index);
  if(list){
    if(!rows.length){
      if(!list.querySelector?.('.scan-empty')){list.textContent='';const p=document.createElement('p');p.className='scan-empty';p.textContent=S.ws?'Buscando los mercados Boom y Crash en Deriv…':'Conecte Deriv para vigilar todos los Boom y Crash a la vez.';list.appendChild(p)}
    }else{
      S.tiles=S.tiles||new Map();const nodes=[];
      for(const {M,t,f} of rows){
        let b=S.tiles.get(M.sym);if(!b){b=makeTile(M.sym);S.tiles.set(M.sym,b)}
        const cls=`scan-tile ${t.cls}${isView(M)?' viewing':''}${S.demoPosition?.symbol===M.sym?' has-demo':''}`;if(b.className!==cls)b.className=cls;
        const [n,p,st,sk]=b.children;
        setNodeText(n,M.short);
        setNodeText(p,`${arrowOf(f.dir)} ${f.pct}%`);const pc='st-pct'+(t.tier>=2?(f.dir.startsWith('ALZA')?' up':f.dir.startsWith('BAJA')?' down':''):'');if(p.className!==pc)p.className=pc;
        setNodeText(st,t.label);setNodeText(sk,f.spike);
        nodes.push(b);
      }
      for(const sym of [...S.tiles.keys()])if(!S.markets.has(sym))S.tiles.delete(sym);
      syncChildren(list,nodes);
    }
  }
  if(strip){
    S.chips=S.chips||new Map();const nodes=[];
    for(const {M,t,f} of rows){
      if(t.tier<3||isView(M))continue;
      let c=S.chips.get(M.sym);if(!c){c=document.createElement('button');c.type='button';c.dataset.sym=M.sym;S.chips.set(M.sym,c)}
      const cls=`scan-chip ${t.cls}`;if(c.className!==cls)c.className=cls;setNodeText(c,`${t.label.split(' ')[0]} ${M.short} ${arrowOf(f.dir)}`);nodes.push(c);
    }
    for(const sym of [...S.chips.keys()])if(!S.markets.has(sym))S.chips.delete(sym);
    syncChildren(strip,nodes);strip.hidden=!nodes.length;
  }
}

/* ---------- DEMO MANUAL ---------- */
function chooseDirection(dir){S.manualDirection=dir;$('manualUp').classList.toggle('selected',dir==='ALZA ↑');$('manualDown').classList.toggle('selected',dir==='BAJA ↓');openDemo(dir)}
function openDemo(forcedDir=null){
  if(S.demoPosition){queueSpeech(`Ya existe una operación activa en ${S.demoPosition.marketName||'otro mercado'}.`,15);return}
  const M=VM();if(!M)return;
  const price=M.prices.at(-1);if(!Number.isFinite(price))return;let dir=forcedDir||S.manualDirection;if(!dir&&M.activeSignal)dir=M.activeSignal.dir;if(!dir){queueSpeech('Seleccione BUY alza o SELL baja.',15);return}
  const A=metrics(M)?.A||sd(M.prices.slice(-40))||Math.abs(price)*.00001,a=M.activeSignal&&!M.activeSignal.demo?M.activeSignal:null,match=!!a&&a.dir===dir;const up=dir.startsWith('ALZA');
  const lot=Math.max(.01,Number($('lotSize')?.value)||.20),epoch=M.times.at(-1)||nowSec();
  S.demoPosition={id:'D'+Date.now().toString().slice(-6),dir,entry:price,opened:Date.now(),openEpoch:epoch,lot,atr:A,conf:match?a.conf:(M.signal?.conf||0),target:match?a.target:price+(up?1:-1)*A*1.6,stop:match?a.stop:price-(up?1:-1)*A*.8,bestPrice:price,source:match?'RADAR':'MANUAL',symbol:M.sym,marketName:M.name,lastPrice:price,lastEpoch:epoch};
  addMarker('entry',dir,price,epoch,`DEMO ${up?'BUY':'SELL'}`,true,M.sym);
  if(CFG.followDemo){
    attachDemoFollow(M,match?a:null);setTiming(M,'OPERACIÓN DEMO ABIERTA','ready');
    setSignal(M,{dir,conf:S.demoPosition.conf,phase:'💼 EN OPERACIÓN',reason:`Operación ${up?'BUY / ALZA':'SELL / BAJA'} abierta en ${M.name}. RADAR la sigue y avisa rebote, pérdida de impulso o riesgo de spike.`,entry:price,target:S.demoPosition.target,stop:S.demoPosition.stop,spikeRisk:M.sp?.risk||0,spikeText:M.sp?.text||'—',timing:'OPERACIÓN ACTIVA'});
  }else{
    if(match)M.activeSignal=null;
    setSignal(M,{dir,conf:match?M.signal?.conf||0:0,phase:'🟢 OPERACIÓN ACTIVA',reason:`Operación ${up?'BUY / ALZA':'SELL / BAJA'} abierta en ${M.name}. Cambiar de mercado no la cierra.`,entry:price,target:S.demoPosition.target,stop:S.demoPosition.stop,spikeRisk:M.signal?.spikeRisk||0,spikeText:M.signal?.spikeText||'—',timing:'OPERACIÓN ACTIVA'});
  }
  drawActiveLevels();renderDemo();scheduleScan();queueSpeech(`Entrada demo registrada. ${up?'Compra':'Venta'}.`,60);
}
function closeDemo(reason='SALIDA MANUAL',quiet=false){
  if(!S.demoPosition)return;const d=S.demoPosition,price=Number.isFinite(d.lastPrice)?d.lastPrice:d.entry,epoch=d.lastEpoch||nowSec();const pnl=(price-d.entry)*(d.dir.startsWith('ALZA')?1:-1);
  addMarker('exit',d.dir,price,epoch,`DEMO ${fmt2(pnl)}`,true,d.symbol);logEvent('DEMO '+reason,d.dir,price,0,pnl>=0?'GANADA':'PERDIDA',d.marketName||d.symbol);
  const M=S.markets.get(d.symbol),where=d.symbol!==S.symbol?` en ${M?.short||d.marketName||'otro mercado'}`:'';
  S.demoPosition=null;
  if(M&&M.activeSignal?.demo){
    M.activeSignal=null;M.cooldownUntil=epoch+S.engineTimeframe;M.lastExitAt=Date.now();setTiming(M,'OPERACIÓN CERRADA','waiting');
    setSignal(M,{dir:d.dir,phase:'⚪ OPERACIÓN CERRADA',reason:`Demo cerrada (${reason.toLowerCase()}): ${fmt2(pnl)} puntos. RADAR vuelve a buscar oportunidades.`,entry:d.entry,target:d.target,stop:d.stop,spikeRisk:M.sp?.risk||0,spikeText:M.sp?.text||'—',timing:'CERRADA'});
  }
  addStat('demo',pnl>0,pnl*(d.lot||.2)*CONTRACT_SIZE);
  drawActiveLevels();renderDemo();scheduleScan();markDirty();if(!quiet)queueSpeech(`Salida demo${where} registrada. ${pnl>=0?'Resultado favorable':'Resultado desfavorable'}.`,60);
}
function monitorDemoPosition(price,epoch){const d=S.demoPosition;if(!d)return;d.lastPrice=price;d.lastEpoch=epoch;const up=d.dir.startsWith('ALZA');if((up&&price>=d.target)||(!up&&price<=d.target)){closeDemo('PROFIT');return}if((up&&price<=d.stop)||(!up&&price>=d.stop)){closeDemo('STOP');return}renderDemo();markDirty()}
function renderDemo(){
  const d=S.demoPosition;if(!d){setText('positionState','SIN POSICIÓN');setText('positionCard','Sin operación activa.');return}
  const same=d.symbol===S.symbol,cur=d.lastPrice,pnl=Number.isFinite(cur)?(cur-d.entry)*(d.dir.startsWith('ALZA')?1:-1):0,lot=d.lot||.2,money=pnl*lot*CONTRACT_SIZE,usd=`${money<0?'−':''}$${Math.abs(money).toFixed(2)}`;
  setText('positionState',`${d.dir.startsWith('ALZA')?'BUY':'SELL'} · ${d.marketName||d.symbol} · ${same?'':'ACTIVA · '}P/L ${fmt2(pnl)} pts ≈ ${usd}`);
  const tpI=$('tpInput'),slI=$('slInput');if(tpI&&document.activeElement!==tpI)tpI.value=d.target.toFixed(5);if(slI&&document.activeElement!==slI)slI.value=d.stop.toFixed(5);
  $('positionCard').innerHTML=`<b>${d.source} · ${d.dir} · ${d.marketName||d.symbol} · Lote ${lot}</b><br>Entrada: ${fmt(d.entry)}<br>Actual: ${fmt(cur)}${same?'':' · mercado en segundo plano'}<br>Objetivo: ${fmt(d.target)}<br>Stop: ${fmt(d.stop)}<br>P/L: ${fmt2(pnl)} puntos ≈ ${usd} con lote ${lot}`;
}

/* ---------- EVENTOS ---------- */
els.connect.onclick=()=>S.power==='on'?powerOff():powerOn();
els.symbol.onchange=()=>setViewMarket(els.symbol.value);
els.graphSymbol.onchange=()=>setViewMarket(els.graphSymbol.value);
$('voice').onclick=()=>{
  S.voice=!S.voice;$('voice').textContent=`🔊 Voz: ${S.voice?'ON':'OFF'}`;markDirty();
  if(S.voice){if(S.bootReadyAt>Date.now()+5000)S.bootReadyAt=Date.now()}
  else{S.voiceQueue=[];try{speechSynthesis.cancel()}catch{}S.voiceSpeaking=false}
};
$('clear').onclick=()=>{const M=VM();if(!M)return;M.setup=null;M.spk.zone=null;if(!M.activeSignal?.demo)M.activeSignal=null;M.cooldownUntil=0;M.lastLateKey='';M.lastExitAt=0;clearMarkersFor(M.sym);setTiming(M,'ESPERANDO ESTRUCTURA','waiting');setSignal(M);drawActiveLevels()};
$('openGraph').onclick=()=>showView('graph');$('backRadar').onclick=()=>showView('radar');
document.querySelectorAll('.nav').forEach(b=>b.onclick=()=>showView(b.dataset.view));
document.querySelectorAll('.tf').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tf').forEach(x=>x.classList.remove('active'));b.classList.add('active');S.timeframe=Number(b.dataset.sec);requestCandles();drawActiveLevels();renderDemo()});
$('zoomIn').onclick=()=>S.chart?.timeScale().applyOptions({barSpacing:Math.min(34,(S.chart.timeScale().options()?.barSpacing||11)*1.28)});
$('zoomOut').onclick=()=>S.chart?.timeScale().applyOptions({barSpacing:Math.max(3,(S.chart.timeScale().options()?.barSpacing||11)/1.28)});
$('resetChart').onclick=()=>{S.chart?.timeScale().applyOptions({barSpacing:11,rightOffset:6});showRecentCandles(60)};
$('clearMarks').onclick=()=>{if(S.symbol)clearMarkersFor(S.symbol);drawActiveLevels()};
$('manualUp').onclick=()=>chooseDirection('ALZA ↑');$('manualDown').onclick=()=>chooseDirection('BAJA ↓');$('manualExit').onclick=()=>closeDemo('SALIDA MANUAL');
$('applyLevels').onclick=()=>{const d=S.demoPosition;if(!d)return;const tp=Number($('tpInput').value),sl=Number($('slInput').value),up=d.dir.startsWith('ALZA');if(!Number.isFinite(tp)||!Number.isFinite(sl))return;if((up&&(tp<=d.entry||sl>=d.entry))||(!up&&(tp>=d.entry||sl<=d.entry))){queueSpeech('Revise los niveles. TP y stop están en posiciones incorrectas.',50);return}d.target=tp;d.stop=sl;drawActiveLevels();renderDemo();queueSpeech('Niveles actualizados.',20)};
function drawer(open){$('controlDrawer').classList.toggle('open',open);$('drawerBackdrop').classList.toggle('open',open)}
$('toggleDrawer').onclick=()=>drawer(true);$('closeDrawer').onclick=()=>drawer(false);$('drawerBackdrop').onclick=()=>drawer(false);
function setupLevelDrag(){const host=$('lwChart');if(!host||host.dataset.levelDrag)return;host.dataset.levelDrag='1';
  const near=(y,price)=>{const c=S.candleSeries?.priceToCoordinate?.(price);return Number.isFinite(c)&&Math.abs(c-y)<22};
  host.addEventListener('pointerdown',e=>{const d=S.demoPosition;if(!d||d.symbol!==S.symbol||!S.candleSeries)return;const r=host.getBoundingClientRect(),y=e.clientY-r.top;if(near(y,d.target))S.levelDrag='target';else if(near(y,d.stop))S.levelDrag='stop';else return;host.classList.add('dragging-level');host.setPointerCapture?.(e.pointerId);e.preventDefault()},{capture:true});
  host.addEventListener('pointermove',e=>{if(!S.levelDrag||!S.demoPosition)return;const r=host.getBoundingClientRect(),price=S.candleSeries.coordinateToPrice?.(e.clientY-r.top);if(!Number.isFinite(price))return;const d=S.demoPosition,up=d.dir.startsWith('ALZA');if(S.levelDrag==='target'&&((up&&price>d.entry)||(!up&&price<d.entry)))d.target=price;if(S.levelDrag==='stop'&&((up&&price<d.entry)||(!up&&price>d.entry)))d.stop=price;drawActiveLevels();renderDemo();e.preventDefault()},{capture:true});
  const done=()=>{if(S.levelDrag){S.levelDrag=null;host.classList.remove('dragging-level')}};host.addEventListener('pointerup',done,{capture:true});host.addEventListener('pointercancel',done,{capture:true});}
setupLevelDrag();
const onScanTap=e=>{const b=e.target?.closest?.('[data-sym]');if(b&&b.dataset.sym)setViewMarket(b.dataset.sym)};
$('chartHud')?.addEventListener('click',()=>{S.hudCompact=!S.hudCompact;renderHud()}); // tocar el panel lo reduce a una línea
$('scanList')?.addEventListener('click',onScanTap);$('graphScan')?.addEventListener('click',onScanTap);
window.addEventListener('resize',()=>setTimeout(()=>{showRecentCandles(60);renderMarkers()},80));
setInterval(()=>{if(S.markets.size)scheduleScan()},2000);

$('spikeToggle')?.addEventListener('click',()=>{S.spikeOn=!S.spikeOn;renderToggles();if(!S.spikeOn)for(const M of S.markets.values())M.spk.zone=null;markDirty();scheduleScan(true)});
$('bgToggle')?.addEventListener('click',()=>{S.bgMode=!S.bgMode;renderToggles();if(S.bgMode&&S.power==='on')startBg();else stopBg();markDirty()});
$('statsReset')?.addEventListener('click',()=>{S.stats=newStats();renderStats();markDirty()});
function renderToggles(){setText('spikeToggle',`⚡ Motor spike: ${S.spikeOn?'ON':'OFF'}`);setText('bgToggle',`🌙 Segundo plano: ${S.bgMode?'ON':'OFF'}`)}
window.addEventListener('online',()=>{if(S.power==='on'&&(!S.ws||S.ws.readyState!==1))openSocket()});
window.addEventListener('offline',()=>{if(S.power==='on')setConnUI('offline')});
window.addEventListener('pagehide',saveNow);
document.addEventListener('visibilitychange',()=>{if(document.hidden){saveNow();return}requestWakeLock();checkHealth();S.bgCtx?.resume?.()});
document.addEventListener('pointerdown',()=>{if(S.bgMode&&S.power==='on'&&!S.bgNode)startBg();S.bgCtx?.resume?.()});
setInterval(()=>{if(S.dirty)saveNow()},3000);
setInterval(()=>{const now=Date.now();if(S.lastBeat&&now-S.lastBeat>20000)checkHealth();S.lastBeat=now},5000); // el teléfono pausó la página
setInterval(checkHealth,10000);
restoreState();renderPower();renderToggles();renderLog();renderStats();
updateSignalUI();renderScanner();
if(CFG.persist&&S.power==='on')openSocket(true); // estaba encendido: sigue encendido al abrir
