'use strict';
/* RADAR SINTÉTICO MR V1.8.0 · ESCÁNER MULTIMERCADO
   Cada mercado Boom/Crash tiene su propio estado y su propio motor de análisis.
   El "mercado en vista" solo decide qué se dibuja en los paneles y en el gráfico. */
const $=id=>document.getElementById(id);
const fmt=v=>Number.isFinite(v)?Number(v).toFixed(5):'—';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const avg=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:0;
const sd=a=>{if(!a.length)return 0;const m=avg(a);return Math.sqrt(avg(a.map(v=>(v-m)**2)))};
const ema=(a,n)=>{if(!a.length)return 0;const k=2/(n+1);let v=a[0];for(let i=1;i<a.length;i++)v=a[i]*k+v*(1-k);return v};
const nowSec=()=>Math.floor(Date.now()/1000);

const DERIV_WS='wss://api.derivws.com/trading/v1/options/ws/public';
const MAX_TICKS=1500,HISTORY_ROWS=150,MARKERS_PER_MARKET=60;
const ENTRY_HIGHLIGHT_MS=20000,EXIT_HIGHLIGHT_MS=10000,STALE_MS=20000,BOOT_STAGGER_MS=350,VOICE_TTL_MS=20000;

const S={
  ws:null,candleWs:null,symbol:null,marketName:'',candles:[],timeframe:60,engineTimeframe:60,
  chart:null,candleSeries:null,markerApi:null,markers:[],markerSeq:0,priceLines:[],
  markets:new Map(),reqMap:new Map(),bootTimers:[],scanTimer:null,
  manualDirection:null,demoPosition:null,voice:true,voiceQueue:[],voiceSpeaking:false,bootReadyAt:0,
  historyReq:0,req:100,historyStatus:'SIN CARGAR',installPrompt:null,levelDrag:null
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
    lastSpikeTick:0,lastSpikeEventAt:0,lastSpikePrice:null,lastExitAt:0};
}
const VM=()=>S.symbol?S.markets.get(S.symbol)||null:null;
const isView=M=>!!M&&M.sym===S.symbol;
function refreshStatus(M){if(M.historyReady&&M.engineHistoryReady){M.status='LISTO';M.error=''}}

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
   Otros mercados: solo entradas y salidas, nombrando el mercado. Pre-alertas y rebotes se ven en el escáner. */
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
function connect(){
  const old=S.ws;S.ws=null;try{old?.close()}catch{}
  S.bootTimers.forEach(clearTimeout);S.bootTimers=[];S.reqMap.clear();S.markets.clear();
  S.bootReadyAt=S.voice?Date.now()+999999:Date.now();
  clearPriceLines();renderScanner();updateSignalUI();
  const ws=new WebSocket(DERIV_WS);S.ws=ws;
  els.conn.textContent='CONECTANDO…';els.conn.className='pill off';
  ws.onopen=()=>{
    if(S.ws!==ws)return;
    els.conn.textContent='● DERIV CONECTADO';els.conn.className='pill on';setText('graphConn','● DERIV EN VIVO');
    send({active_symbols:'brief',req_id:1});
    queueSpeech('Radar Sintético MR encendido y conectado a Deriv. Preparando el análisis de todos los mercados Boom y Crash.',100,true);
  };
  ws.onclose=()=>{if(S.ws!==ws)return;els.conn.textContent='● DERIV DESCONECTADO';els.conn.className='pill off';setText('graphConn','● DERIV DESCONECTADO')};
  ws.onerror=()=>{if(S.ws!==ws)return;els.conn.textContent='● ERROR DERIV';els.conn.className='pill off'};
  ws.onmessage=e=>{if(S.ws!==ws)return;let d;try{d=JSON.parse(e.data)}catch{return}handleMainMessage(d)};
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
    M.engineCandles=normalizeCandles(d.candles);M.engineHistoryReady=M.engineCandles.length>=24;M.retries.candles=0;refreshStatus(M);
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
  S.markets.clear();els.symbol.innerHTML='';els.graphSymbol.innerHTML='';
  found.forEach((x,i)=>{
    S.markets.set(x.sym,newMarket(x.sym,x.name,i));
    for(const sel of [els.symbol,els.graphSymbol]){const o=document.createElement('option');o.value=x.sym;o.textContent=x.name;sel.appendChild(o)}
  });
  if(!found.length){if(els.reason)els.reason.textContent='Deriv no devolvió mercados Boom / Crash.';renderScanner();return}
  const keep=S.markets.has(S.symbol)?S.symbol:found[0].sym;
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
  if(kind==='history')send({ticks_history:M.sym,count:500,end:'latest',style:'ticks',req_id:r});
  else if(kind==='candles')send({ticks_history:M.sym,count:1000,end:'latest',style:'candles',granularity:S.engineTimeframe,req_id:r});
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
  M.prices=P.slice(-MAX_TICKS);M.times=T.slice(-MAX_TICKS);M.tickCount=M.prices.length;
  M.historyReady=true;M.lastTickAt=Date.now();M.retries.history=0;refreshStatus(M);
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
function normalizeCandles(list){
  const map=new Map();for(const c of list||[]){const x={time:Number(c.epoch),open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close)};if(![x.time,x.open,x.high,x.low,x.close].every(Number.isFinite))continue;if(x.high<x.low||x.high<Math.max(x.open,x.close)||x.low>Math.min(x.open,x.close))continue;map.set(x.time,x)}
  return [...map.values()].sort((a,b)=>a.time-b.time).slice(-400);
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
  const tf=S.timeframe,baseTf=tf===172800?86400:tf,req=++S.req;S.historyReq=req;S.candles=[];S.historyStatus='CARGANDO OHLC';updateBadge();
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
  try{S.markerApi=LightweightCharts.createSeriesMarkers(S.candleSeries,[],{autoScale:true,zOrder:'top'})}catch{try{S.markerApi=LightweightCharts.createSeriesMarkers(S.candleSeries,[])}catch{S.markerApi=null}}
  S.chart.subscribeCrosshairMove(p=>{if(!p.time)return;const d=p.seriesData.get(S.candleSeries);if(d)updateOHLC(d)});
  return true;
}
function renderAll(fit=false){if(!ensureChart()||!S.candles.length)return;S.candleSeries.setData(S.candles);renderMarkers();drawActiveLevels();if(fit)showRecentCandles(60);updateOHLC(S.candles.at(-1))}
function showRecentCandles(count=60){if(!S.chart||!S.candles.length)return;const n=S.candles.length,visible=Math.min(count,n);S.chart.timeScale().setVisibleLogicalRange({from:n-visible-2,to:n+5})}
function updateOHLC(c){if(!c)return;setText('ohlcLine',`O ${fmt(c.open)}   H ${fmt(c.high)}   L ${fmt(c.low)}   C ${fmt(c.close)}`)}
function updateBadge(){const tf=document.querySelector('.tf.active')?.textContent||'1m';setText('chartBadge',`${tf} · ${S.candles.length} velas · ${S.historyStatus}`)}
function showChartError(t){const e=$('chartError');if(e){e.textContent=t;e.hidden=false}}
function hideChartError(){const e=$('chartError');if(e)e.hidden=true}
function clearPriceLines(){if(!S.candleSeries)return;for(const l of S.priceLines){try{S.candleSeries.removePriceLine(l)}catch{}}S.priceLines=[]}
function addPriceLine(price,title,color){if(!S.candleSeries||!Number.isFinite(price))return;try{S.priceLines.push(S.candleSeries.createPriceLine({price,color,lineWidth:1,lineStyle:2,axisLabelVisible:true,title}))}catch{}}
/* Niveles del mercado en vista: primero la operación demo de ese mercado; si no hay, la señal activa del RADAR. */
function drawActiveLevels(){
  clearPriceLines();const M=VM();
  const d=S.demoPosition?.symbol===S.symbol?S.demoPosition:M?.activeSignal;if(!d)return;
  if(Number.isFinite(d.target))addPriceLine(d.target,'OBJETIVO','#45a8ff');if(Number.isFinite(d.stop))addPriceLine(d.stop,'STOP','#ff7b48');
}
function addMarker(type,dir,price,time,text,persistent=true,symbolOverride=null){
  if(!Number.isFinite(price))return;const t=time||S.candles.at(-1)?.time||nowSec();const sym=symbolOverride||S.symbol;const id=`${type}-${sym}-${t}-${++S.markerSeq}`;
  const cleanText=''; // marcadores sin texto: gráfico limpio, igual que V1.7.4
  S.markers.push({id,type,dir,price,time:t,eventTime:t,text:cleanText,persistent,symbol:sym});
  const own=S.markers.filter(m=>m.symbol===sym);
  if(own.length>MARKERS_PER_MARKET){const drop=new Set(own.slice(0,own.length-MARKERS_PER_MARKET));S.markers=S.markers.filter(m=>!drop.has(m))}
  if(sym===S.symbol)renderMarkers();
}
function markerSpec(m){
  const up=String(m.dir).startsWith('ALZA');let color='#ff9a22',shape=up?'arrowUp':'arrowDown',position=up?'atPriceBottom':'atPriceTop';
  if(m.type==='entry'){color=up?'#18d486':'#ff5365';shape=up?'arrowUp':'arrowDown'}
  else if(m.type==='rebound'){color='#ffd34d';shape='circle';position='atPriceMiddle'}
  else if(m.type==='exit'){color='#58bfff';shape='square';position='atPriceMiddle'}
  else if(m.type==='cancel'){color='#7c8d99';shape='circle';position='atPriceMiddle'}
  const chartTime=Math.floor((m.eventTime||m.time)/S.timeframe)*S.timeframe;return {id:m.id,time:chartTime,position,price:m.price,color,shape,text:m.text,size:m.type==='entry'?2:1.4};
}
function renderMarkers(){
  if(!S.markerApi)return;const arr=S.markers.filter(m=>!m.symbol||m.symbol===S.symbol).map(markerSpec).sort((a,b)=>a.time-b.time);
  try{S.markerApi.setMarkers(arr)}catch{
    const fallback=arr.map(x=>({id:x.id,time:x.time,position:x.shape==='arrowUp'?'belowBar':x.shape==='arrowDown'?'aboveBar':'inBar',color:x.color,shape:x.shape,text:x.text,size:x.size}));
    try{S.markerApi.setMarkers(fallback)}catch{}
  }
}
function clearMarkersFor(sym){S.markers=S.markers.filter(m=>m.symbol!==sym);renderMarkers()}

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
  if(detect&&lastAbs>sigma*5.2&&M.tickCount-M.lastSpikeTick>5){M.lastSpikeTick=M.tickCount;M.lastSpikeEventAt=M.times.at(-1)||nowSec();M.lastSpikePrice=p.at(-1);logEvent('SPIKE DETECTADO',dir,p.at(-1),prep,'NO PERSEGUIR',M.name)}
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
  if(cs.length<n+forward+12)return {score:0,dir:'NEUTRAL',text:'Histórico insuficiente',matches:[]};
  const current=patternSignature(cs.slice(-n),n), matches=[];
  const maxEnd=cs.length-n-forward-22;
  for(let end=n;end<=maxEnd;end++){
    const win=cs.slice(end-n,end), sig=patternSignature(win,n);const sim=patternSimilarity(current,sig);
    if(sim<.68)continue;
    const start=cs[end-1].close, future=cs[end+forward-1].close, baseAtr=atr(cs.slice(Math.max(0,end-16),end),14)||Math.abs(start)*1e-5;
    const move=(future-start)/baseAtr; if(!Number.isFinite(move))continue;
    const dir=move>.18?'ALZA ↑':move<-.18?'BAJA ↓':'NEUTRAL';
    matches.push({sim,move,dir,time:cs[end-1].time,forward:Math.round(move*100)/100});
  }
  matches.sort((a,b)=>b.sim-a.sim);const top=matches.slice(0,8);if(!top.length)return {score:0,dir:'NEUTRAL',text:'Sin patrón histórico suficientemente parecido',matches:[]};
  let up=0,down=0,weight=0;for(const x of top){const w=x.sim*x.sim;weight+=w;if(x.dir.startsWith('ALZA'))up+=w;if(x.dir.startsWith('BAJA'))down+=w}
  const best=Math.max(up,down),dir=best&&best/Math.max(weight,1)>.55?(up>down?'ALZA ↑':'BAJA ↓'):'NEUTRAL';
  const score=Math.round(clamp((best/Math.max(weight,1))*100,0,100));
  const lead=top[0];const when=new Date(lead.time*1000).toLocaleTimeString('es-SV',{hour:'2-digit',minute:'2-digit'});
  return {score,dir,matches:top,text:`${top.length} analogías · mejor similitud ${Math.round(lead.sim*100)}% · resultado histórico ${lead.dir} · ${when}`};
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
  setText('strategyScores',(a.strategies||[]).slice(0,8).map(x=>`${x.name}: ${x.dir} · ${x.score}%`).join('\n')||'—');
}
function clearAlgorithmUI(){for(const id of ['algoScore','algoStrategy','algoDir','algoConfluence','strategyScores'])setText(id,'—');setText('historicalPattern','Buscando patrones similares en el historial disponible…')}

/* ---------- CICLO DE SEÑAL (POR MERCADO) ---------- */
function baseSignal(partial={}){return {dir:'NEUTRAL',conf:0,phase:'⚪ ESPERANDO',reason:'Buscando estructura.',alert:null,trigger:null,entry:null,target:null,stop:null,spikeRisk:0,spikeText:'—',timing:'ESPERANDO',...partial}}
function setSignal(M,partial={}){if(!M){updateSignalUI();return}M.signal=baseSignal(partial);if(isView(M))updateSignalUI();scheduleScan()}
function createSetup(M,m,price,epoch){
  const up=m.dir.startsWith('ALZA');const trigger=up?Math.max(m.last.high,m.prev.high)+m.A*.06:Math.min(m.last.low,m.prev.low)-m.A*.06;const invalid=up?Math.min(m.last.low,m.prev.low)-m.A*.45:Math.max(m.last.high,m.prev.high)+m.A*.45;
  M.setup={id:'S'+Date.now()+M.sym,dir:m.dir,createdPrice:price,createdEpoch:epoch,createdCandle:m.last.time,trigger,invalid,atr:m.A,conf:m.conf,expiresAt:epoch+S.engineTimeframe*3,score:m.best};
  addMarker('alert',m.dir,price,m.last.time,`ALERTA ${up?'ALZA':'BAJA'} · vigilar ${fmt(trigger)}`,true,M.sym);
  setTiming(M,'PRE-ALERTA A TIEMPO','early');const sp=M.sp||spikeRisk(M);
  setSignal(M,{dir:m.dir,conf:m.conf,phase:'🟠 PRE-ALERTA',reason:`Estructura en preparación. Vigilar el disparador ${fmt(trigger)}. La entrada aún NO está confirmada.`,alert:price,trigger,spikeRisk:sp.risk,spikeText:sp.text,timing:'PRE-ALERTA'});
  logEvent('PRE-ALERTA',m.dir,price,m.conf,'A TIEMPO',M.name);
  announce(M,`Pre alerta. Posible ${up?'compra':'venta'}.`,`Pre alerta en ${M.short}. Posible ${up?'compra':'venta'}.`,30,'prealert');
}
function cancelSetup(M,reason,late=false,price=null){
  const s=M.setup;if(!s)return;const p=Number.isFinite(price)?price:M.prices.at(-1);const t=M.times.at(-1)||nowSec();const sp=M.sp||spikeRisk(M);
  if(late){addMarker('cancel',s.dir,p,t,`TARDE · MOVIMIENTO YA EJECUTADO`,true,M.sym);setTiming(M,'MOVIMIENTO YA EJECUTADO · ENTRADA BLOQUEADA','late');setSignal(M,{dir:s.dir,conf:s.conf,phase:'⛔ MOVIMIENTO YA EJECUTADO',reason:'El precio recorrió demasiado antes de confirmar el disparador. RADAR no persigue el movimiento.',alert:s.createdPrice,trigger:s.trigger,spikeRisk:sp.risk,spikeText:sp.text,timing:'TARDE BLOQUEADO'});logEvent('BLOQUEADA TARDE',s.dir,p,s.conf,'MOVIMIENTO EJECUTADO',M.name)}
  else{setTiming(M,'ALERTA CANCELADA','waiting');setSignal(M,{phase:'⚪ ALERTA CANCELADA',reason,spikeRisk:sp.risk,spikeText:sp.text,timing:'CANCELADA'});logEvent('CANCELADA',s.dir,p,s.conf,'INVALIDADA',M.name)}
  M.setup=null;M.cooldownUntil=t+Math.max(15,S.engineTimeframe*.5);
}
function confirmSetup(M,price,epoch,m){
  const s=M.setup;if(!s)return;const up=s.dir.startsWith('ALZA');const overshoot=up?price-s.trigger:s.trigger-price,travel=Math.abs(price-s.createdPrice);
  if(overshoot>s.atr*.42||travel>s.atr*.95){cancelSetup(M,'Movimiento demasiado extendido.',true,price);return}
  const target=price+(up?1:-1)*s.atr*1.65,stop=price-(up?1:-1)*s.atr*.78;
  M.activeSignal={id:s.id,dir:s.dir,entry:price,entryEpoch:epoch,entryCandle:epoch,entryAt:Date.now(),target,stop,atr:s.atr,conf:Math.max(s.conf,m?.conf||0),bestPrice:price,reboundWarned:false,symbol:M.sym,marketName:M.name};M.setup=null;
  const a=M.activeSignal;addMarker('entry',a.dir,price,epoch,`${up?'BUY / ALZA':'SELL / BAJA'} · ${fmt(price)}`,true,M.sym);if(isView(M))drawActiveLevels();setTiming(M,'ENTRADA CONFIRMADA A TIEMPO','ready');
  const sp=M.sp||spikeRisk(M);
  setSignal(M,{dir:a.dir,conf:a.conf,phase:'🟢 ENTRAR AHORA',reason:`Disparador confirmado sin persecución del precio. Objetivo ${fmt(target)} · Stop ${fmt(stop)}.`,entry:price,target,stop,spikeRisk:sp.risk,spikeText:sp.text,timing:'CONFIRMADA'});
  logEvent('ENTRADA',a.dir,price,a.conf,'A TIEMPO',M.name);
  announce(M,`Ejecutar ahora. ${up?'Compra':'Venta'} en ${fmt(price)}.`,`Entrada en ${M.short}. ${up?'Compra':'Venta'} ahora.`,70,'entry');
}
function closeSignal(M,reason,price,epoch){
  const a=M.activeSignal;if(!a)return;addMarker('exit',a.dir,price,epoch,`SALIDA · ${fmt(price)} · ${reason}`,true,a.symbol);
  M.activeSignal=null;M.cooldownUntil=epoch+S.engineTimeframe;M.lastExitAt=Date.now();if(isView(M))drawActiveLevels();setTiming(M,'CICLO FINALIZADO','waiting');
  const sp=M.sp||spikeRisk(M);
  setSignal(M,{dir:a.dir,conf:a.conf,phase:'🔵 SALIR AHORA',reason:`${reason}. El ciclo queda cerrado y RADAR vuelve a buscar una nueva oportunidad.`,entry:a.entry,target:a.target,stop:a.stop,spikeRisk:sp.risk,spikeText:sp.text,timing:'SALIDA'});
  logEvent('SALIDA '+reason,a.dir,price,a.conf,'CICLO CERRADO',a.marketName||M.name);
  announce(M,`Salir ahora. ${reason}`,`Salir ahora en ${M.short}. ${reason}`,90,'exit');
}
/* La señal activa de un mercado solo se evalúa con los ticks de ese mismo mercado. */
function monitorSignal(M,price,epoch,m){
  const a=M.activeSignal;if(!a)return;const up=a.dir.startsWith('ALZA');if(up)a.bestPrice=Math.max(a.bestPrice,price);else a.bestPrice=Math.min(a.bestPrice,price);
  if((up&&price>=a.target)||(!up&&price<=a.target)){closeSignal(M,'OBJETIVO ALCANZADO',price,epoch);return}
  if((up&&price<=a.stop)||(!up&&price>=a.stop)){closeSignal(M,'STOP',price,epoch);return}
  const favorable=(price-a.entry)*(up?1:-1),retr=(a.bestPrice-price)*(up?1:-1);const tickMom=M.prices.length>6?(price-M.prices.at(-6))/a.atr:0;
  const opposite=up?tickMom<-.18:tickMom>.18;const extreme=up?m?.R>68:m?.R<32;const sp=M.sp||spikeRisk(M);
  if(!a.reboundWarned&&favorable>a.atr*.35&&(opposite||extreme)){
    a.reboundWarned=true;const reboundDir=up?'BAJA ↓':'ALZA ↑';addMarker('rebound',reboundDir,price,epoch,`POSIBLE REBOTE ${up?'BAJA':'ALZA'} · ${fmt(price)}`,true,M.sym);
    setSignal(M,{dir:a.dir,conf:a.conf,phase:'🟡 POSIBLE REBOTE',reason:'La operación sigue activa, pero aparecen señales de agotamiento. Vigilar salida.',entry:a.entry,target:a.target,stop:a.stop,spikeRisk:sp.risk,spikeText:sp.text,timing:'VIGILAR REBOTE'});
    announce(M,`Posible rebote ${up?'a la baja':'al alza'}. Vigilar salida.`,`${M.short}: posible rebote ${up?'a la baja':'al alza'}. Vigilar salida.`,45,'info');
  }
  if(favorable>a.atr*.4&&retr>a.atr*.52&&opposite){closeSignal(M,'PÉRDIDA DE IMPULSO',price,epoch);return}
  if(!a.reboundWarned)setSignal(M,{dir:a.dir,conf:a.conf,phase:'🔵 MANTENER',reason:'La estructura de la entrada sigue vigente.',entry:a.entry,target:a.target,stop:a.stop,spikeRisk:sp.risk,spikeText:sp.text,timing:'SEGUIMIENTO'});
}
function runEngine(M,price,epoch){
  if(!M||!Number.isFinite(price))return;const view=isView(M);
  if(view){setText('price',fmt(price));setText('graphPrice',fmt(price));setText('ticks',M.prices.length)}
  const m=metrics(M),sp=spikeRisk(M,true);M.m=m;M.sp=sp;
  if(!m){M.normalPrep=0;M.prep=sp.prep||0;M.prepDir=sp.dir;if(view)renderEngineReadout(M);setSignal(M,{phase:'⚪ RECOPILANDO DATOS',reason:'Esperando suficientes velas para formar estructura.',spikeRisk:sp.risk,spikeText:sp.text});return}
  if(!M.algorithm||M.tickCount-M.algoTick>=5||Date.now()-M.algoAt>1200){M.algorithm=algorithmicEngine(M,m,sp);M.algoTick=M.tickCount;M.algoAt=Date.now();if(view)updateAlgorithmUI(M.algorithm)}
  const algo=M.algorithm;
  const normalPrep=clamp(Math.round(45+Math.max(m.buy,m.sell)*10),0,95);M.normalPrep=normalPrep;M.prep=Math.max(normalPrep,sp.prep||0);M.prepDir=(sp.prep||0)>normalPrep?sp.dir:m.dir;
  if(view)renderEngineReadout(M);
  if(M.activeSignal){monitorSignal(M,price,epoch,m);return}
  if(M.setup){
    const s=M.setup,up=s.dir.startsWith('ALZA');if(epoch>s.expiresAt){cancelSetup(M,'La alerta caducó sin confirmación.',false,price);return}
    if((up&&price<=s.invalid)||(!up&&price>=s.invalid)){cancelSetup(M,'El mercado invalidó la estructura antes de la entrada.',false,price);return}
    const directionalTravel=(price-s.createdPrice)*(up?1:-1);if(directionalTravel>s.atr*1.02){cancelSetup(M,'El mercado se movió sin darnos una confirmación limpia.',true,price);return}
    const distance=(s.trigger-price)*(up?1:-1);if(distance<=s.atr*.22&&distance>0){setTiming(M,'CERCA DEL DISPARADOR','early');setSignal(M,{dir:s.dir,conf:s.conf,phase:'🟡 POSIBLE ENTRADA',reason:`Precio acercándose al disparador ${fmt(s.trigger)}. Todavía NO entrar.`,alert:s.createdPrice,trigger:s.trigger,spikeRisk:sp.risk,spikeText:sp.text,timing:'CERCA DEL TRIGGER'})}
    const crossed=up?price>=s.trigger:price<=s.trigger;if(crossed){const tickMom=M.prices.length>5?(price-M.prices.at(-5))/s.atr:0;const aligned=up?tickMom>=-.03:tickMom<=.03;if(aligned)confirmSetup(M,price,epoch,m)}
    return;
  }
  if(epoch<M.cooldownUntil){setSignal(M,{dir:m.dir,conf:m.conf,phase:'⚪ REEVALUANDO',reason:'Ciclo anterior finalizado. Esperando una nueva estructura independiente.',spikeRisk:sp.risk,spikeText:sp.text});return}
  if(view){setText('direction',m.dir);setText('confidence',m.conf+'%')}
  const algoAligned=algo.dir!=='NEUTRAL'&&(algo.score>=62||algo.strategy==='Preparación de spike');
  const normalCandidate=m.dir!=='NEUTRAL'&&m.best>=2.35&&(!algoAligned||algo.dir.startsWith(m.dir.split(' ')[0]));
  const spikeCandidate=sp.dir!=='NEUTRAL'&&sp.prep>=68&&(!algoAligned||algo.dir.startsWith(sp.dir.split(' ')[0]));
  if(normalCandidate||spikeCandidate){
    if(spikeCandidate&&!normalCandidate){m.dir=sp.dir;m.conf=sp.prep;m.best=sp.prep/20;m.late=false}
    if(m.late){const key=`${m.dir}|${m.last.time}`;setTiming(M,'MOVIMIENTO YA EJECUTADO · SIN ENTRADA','late');setSignal(M,{dir:m.dir,conf:m.conf,phase:'⛔ MOVIMIENTO YA EJECUTADO',reason:'El impulso ya ocurrió antes de que se formara una entrada anticipada. RADAR espera el siguiente ciclo.',spikeRisk:sp.risk,spikeText:sp.text,timing:'TARDE BLOQUEADO'});if(key!==M.lastLateKey){M.lastLateKey=key;logEvent('MOVIMIENTO YA EJECUTADO',m.dir,price,m.conf,'SIN ENTRADA',M.name)}return}
    const bucket=m.last.time;if(M.lastSetupEvalBucket!==bucket){M.lastSetupEvalBucket=bucket;createSetup(M,m,price,epoch);if(M.signal)M.signal.reason+=` · Algoritmo ${algo.score}% · ${algo.strategy}`;if(view)updateSignalUI();return}
  }
  setTiming(M,'BUSCANDO PRE-ALERTA','waiting');setSignal(M,{dir:m.dir,conf:m.conf,phase:'⚪ ANALIZANDO',reason:'No hay una estructura anticipada suficientemente limpia. No operar.',spikeRisk:sp.risk,spikeText:sp.text,timing:'BUSCANDO'});
}

/* ---------- UI DEL MERCADO EN VISTA ---------- */
function updateSignalUI(){
  const M=VM();
  const s=M?.signal||{dir:'ESPERANDO',conf:0,phase:M?'⏳ CARGANDO':'⚪ ESPERANDO',reason:M?'Descargando el histórico del mercado…':(S.ws?'Esperando datos.':'Conecte Deriv para iniciar.'),spikeRisk:0};
  setText('radarDir',s.dir);setText('direction',s.dir);setText('confidence',(s.conf||0)+'%');setText('phase',s.phase);if(els.reason)els.reason.textContent=s.reason||'';
  setText('alertLevel',fmt(s.alert));setText('triggerLevel',fmt(s.trigger));setText('entryLevel',fmt(s.entry));setText('exitLevel',fmt(s.target));setText('stopLevel',fmt(s.stop));setText('spikeRisk',(s.spikeRisk||0)+'%');
  setText('graphDir',s.dir);setText('graphPhase',s.phase);setText('graphConf',(s.conf||0)+'%');setText('graphAlert',fmt(s.alert));setText('graphTrigger',fmt(s.trigger));setText('graphEntry',fmt(s.entry));setText('graphSpike',(s.spikeRisk||0)+'%');setText('graphTarget',fmt(s.target));setText('graphStop',fmt(s.stop));setText('graphSpikeSignal',s.spikeText||'—');setText('graphReason',s.reason||'');setText('graphExecMode',($('executionMode')?.value||'manual').toUpperCase());
  const o=$('signalOverlay');if(o){let cl='wait';if((s.phase||'').includes('PRE-ALERTA')||(s.phase||'').includes('POSIBLE'))cl='prealert';if((s.phase||'').includes('ENTRAR')||(s.phase||'').includes('MANTENER'))cl='entry';if((s.phase||'').includes('SALIR'))cl='exit';if((s.phase||'').includes('EJECUTADO'))cl='late';o.className='signal-overlay '+cl;o.textContent=s.phase+(Number.isFinite(s.trigger)?` · ${fmt(s.trigger)}`:'')}
}
function renderEngineReadout(M){
  const m=M?.m,sp=M?.sp;
  setText('spikeEngine',sp?`${sp.dir} · ${sp.prep||0}%`:'—');setText('ticksSinceSpike',sp?.ticksSince==null?'APRENDIENDO':sp.ticksSince);
  if(!m){setText('indicators','EMA: —\nRSI: —\nATR: —\nCompresión: —');setText('normalEngine','—');setText('prepState','—');return}
  setText('indicators',`EMA 9/21: ${fmt(m.fast)} / ${fmt(m.slow)}\nRSI (14): ${m.R.toFixed(1)}\nATR: ${fmt(m.A)}\nMomentum 3 velas: ${m.mom3.toFixed(2)} ATR\nCompresión: ${(m.compression*100).toFixed(0)}%`);
  const top=Math.max(M.normalPrep,sp?.prep||0);
  setText('normalEngine',`${m.dir} · ${M.normalPrep}%`);setText('prepState',`${top}% · ${top>=68?'PRE-ALERTA':top>=52?'OBSERVACIÓN':'BUSCANDO'}`);
}
function renderView(M){
  if(!M){updateSignalUI();return}
  const price=M.prices.at(-1);setText('price',fmt(price));setText('graphPrice',fmt(price));setText('ticks',M.prices.length);
  setText('graphMarketName',M.name);setText('cycleLabel',`CICLO ACTUAL · ${M.short.toUpperCase()}`);setText('liveTitle',`Mercado en vivo · ${M.short}`);
  renderEngineReadout(M);if(M.algorithm)updateAlgorithmUI(M.algorithm);else clearAlgorithmUI();
  applyTiming(M);updateSignalUI();
}
function logEvent(event,dir,price,conf,timing,marketOverride=null){const tr=document.createElement('tr');tr.innerHTML=`<td>${new Date().toLocaleTimeString()}</td><td>${marketOverride||currentMarketLabel()}</td><td>${dir}</td><td>${event}</td><td>${fmt(price)}</td><td>${conf||0}%</td><td>${timing}</td>`;els.history.prepend(tr);while(els.history.children.length>HISTORY_ROWS)els.history.lastChild.remove()}
function showView(name){document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.dataset.view===name));$(name+'View').classList.add('active');if(name==='graph')setTimeout(()=>{ensureChart();renderAll(false);showRecentCandles(60)},60)}

/* ---------- ESCÁNER MULTIMERCADO ---------- */
function scanTier(M){
  if(M.status==='ERROR')return {tier:-1,label:'⚠ SIN DATOS',cls:'err'};
  if(!M.historyReady||!M.engineHistoryReady)return {tier:0,label:M.status==='REINTENTANDO'?'↻ REINTENTANDO':'⏳ CARGANDO',cls:'load'};
  if(M.lastTickAt&&Date.now()-M.lastTickAt>STALE_MS)return {tier:0,label:'⚠ SIN TICKS',cls:'err'};
  const a=M.activeSignal,ph=M.signal?.phase||'';
  if(a&&Date.now()-(a.entryAt||0)<ENTRY_HIGHLIGHT_MS)return {tier:5,label:'🟢 ENTRADA',cls:'entry'};
  if(M.setup)return ph.includes('POSIBLE ENTRADA')?{tier:4,label:'🟡 CERCA',cls:'near'}:{tier:3,label:'🟠 PRE-ALERTA',cls:'prealert'};
  if(a)return {tier:2,label:a.reboundWarned?'🟡 REBOTE':'🔵 EN CURSO',cls:'active'};
  if(M.lastExitAt&&Date.now()-M.lastExitAt<EXIT_HIGHLIGHT_MS)return {tier:2,label:'🔵 SALIDA',cls:'exit'};
  if(ph.includes('EJECUTADO'))return {tier:1,label:'⛔ TARDE',cls:'late'};
  return {tier:1,label:'⚪ ANALIZANDO',cls:'wait'};
}
const arrowOf=d=>String(d).startsWith('ALZA')?'↑':String(d).startsWith('BAJA')?'↓':'–';
function scanFigures(M){
  const a=M.activeSignal,s=M.setup,dir=a?.dir||s?.dir||M.prepDir||'NEUTRAL';
  const pct=Math.round(a?a.conf:s?s.conf:(M.prep||0)),ts=M.sp?.ticksSince;
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
  const list=$('scanList'),strip=$('graphScan'),ms=[...S.markets.values()];
  setText('scanCount',ms.length?`${ms.length} MERCADOS EN VIGILANCIA`:(S.ws?'BUSCANDO MERCADOS…':'SIN CONEXIÓN'));
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
  const A=metrics(M)?.A||sd(M.prices.slice(-40))||Math.abs(price)*.00001,a=M.activeSignal,match=!!a&&a.dir===dir;const up=dir.startsWith('ALZA');
  const lot=Math.max(.01,Number($('lotSize')?.value)||.20),epoch=M.times.at(-1)||nowSec();
  S.demoPosition={id:'D'+Date.now().toString().slice(-6),dir,entry:price,opened:Date.now(),lot,target:match?a.target:price+(up?1:-1)*A*1.6,stop:match?a.stop:price-(up?1:-1)*A*.8,bestPrice:price,source:match?'RADAR':'MANUAL',symbol:M.sym,marketName:M.name,lastPrice:price,lastEpoch:epoch};
  addMarker('entry',dir,price,epoch,`${S.demoPosition.source} ${up?'BUY':'SELL'} · ${fmt(price)}`,true,M.sym);
  if(match)M.activeSignal=null;
  setSignal(M,{dir,conf:match?M.signal?.conf||0:0,phase:'🟢 OPERACIÓN ACTIVA',reason:`Operación ${up?'BUY / ALZA':'SELL / BAJA'} abierta en ${M.name}. Cambiar de mercado no la cierra.`,entry:price,target:S.demoPosition.target,stop:S.demoPosition.stop,spikeRisk:M.signal?.spikeRisk||0,spikeText:M.signal?.spikeText||'—',timing:'OPERACIÓN ACTIVA'});
  drawActiveLevels();renderDemo();queueSpeech(`Entrada demo registrada. ${up?'Compra':'Venta'} en ${fmt(price)}.`,60);
}
function closeDemo(reason='SALIDA MANUAL'){
  if(!S.demoPosition)return;const d=S.demoPosition,price=Number.isFinite(d.lastPrice)?d.lastPrice:d.entry,epoch=d.lastEpoch||nowSec();const pnl=(price-d.entry)*(d.dir.startsWith('ALZA')?1:-1);
  addMarker('exit',d.dir,price,epoch,`SALIDA DEMO · ${fmt(price)} · ${reason}`,true,d.symbol);logEvent('DEMO '+reason,d.dir,price,0,pnl>=0?'GANADA':'PERDIDA',d.marketName||d.symbol);
  const where=d.symbol!==S.symbol?` en ${S.markets.get(d.symbol)?.short||d.marketName||'otro mercado'}`:'';
  S.demoPosition=null;drawActiveLevels();renderDemo();scheduleScan();queueSpeech(`Salida demo${where} registrada. ${pnl>=0?'Resultado favorable':'Resultado desfavorable'}.`,60);
}
function monitorDemoPosition(price,epoch){const d=S.demoPosition;if(!d)return;d.lastPrice=price;d.lastEpoch=epoch;const up=d.dir.startsWith('ALZA');if((up&&price>=d.target)||(!up&&price<=d.target)){closeDemo('PROFIT');return}if((up&&price<=d.stop)||(!up&&price>=d.stop)){closeDemo('STOP');return}renderDemo()}
function renderDemo(){
  const d=S.demoPosition;if(!d){setText('positionState','SIN POSICIÓN');setText('positionCard','Sin operación activa.');return}
  const same=d.symbol===S.symbol,cur=d.lastPrice,pnl=Number.isFinite(cur)?(cur-d.entry)*(d.dir.startsWith('ALZA')?1:-1):0;
  setText('positionState',`${d.dir.startsWith('ALZA')?'BUY':'SELL'} · ${d.marketName||d.symbol} · ${same?'P/L ':'ACTIVA · P/L '}${pnl>=0?'+':''}${fmt(pnl)}`);
  const tpI=$('tpInput'),slI=$('slInput');if(tpI&&document.activeElement!==tpI)tpI.value=d.target.toFixed(5);if(slI&&document.activeElement!==slI)slI.value=d.stop.toFixed(5);
  $('positionCard').innerHTML=`<b>${d.source} · ${d.dir} · ${d.marketName||d.symbol} · Lote ${d.lot||0.20}</b><br>Entrada: ${fmt(d.entry)}<br>Actual: ${fmt(cur)}${same?'':' · mercado en segundo plano'}<br>Objetivo: ${fmt(d.target)}<br>Stop: ${fmt(d.stop)}<br>P/L: ${pnl>=0?'+':''}${fmt(pnl)}`
}

/* ---------- EVENTOS ---------- */
els.connect.onclick=connect;
els.symbol.onchange=()=>setViewMarket(els.symbol.value);
els.graphSymbol.onchange=()=>setViewMarket(els.graphSymbol.value);
$('voice').onclick=()=>{
  S.voice=!S.voice;$('voice').textContent=`🔊 Voz: ${S.voice?'ON':'OFF'}`;
  if(S.voice){if(S.bootReadyAt>Date.now()+5000)S.bootReadyAt=Date.now()}
  else{S.voiceQueue=[];try{speechSynthesis.cancel()}catch{}S.voiceSpeaking=false}
};
$('clear').onclick=()=>{const M=VM();if(!M)return;M.setup=null;M.activeSignal=null;M.cooldownUntil=0;M.lastLateKey='';M.lastExitAt=0;clearMarkersFor(M.sym);setTiming(M,'ESPERANDO ESTRUCTURA','waiting');setSignal(M);drawActiveLevels()};
$('openGraph').onclick=()=>showView('graph');$('backRadar').onclick=()=>showView('radar');
document.querySelectorAll('.nav').forEach(b=>b.onclick=()=>showView(b.dataset.view));
document.querySelectorAll('.tf').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tf').forEach(x=>x.classList.remove('active'));b.classList.add('active');S.timeframe=Number(b.dataset.sec);requestCandles();drawActiveLevels();renderDemo();setText('analysisTfNote','Motor: M1 + ticks · Vista: '+b.textContent)});
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
$('scanList')?.addEventListener('click',onScanTap);$('graphScan')?.addEventListener('click',onScanTap);
window.addEventListener('resize',()=>setTimeout(()=>{showRecentCandles(60);renderMarkers()},80));
setInterval(()=>{if(S.markets.size)scheduleScan()},2000);

updateSignalUI();renderScanner();
