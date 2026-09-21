'use strict';
const $=id=>document.getElementById(id);
const fmt=v=>Number.isFinite(v)?Number(v).toFixed(5):'—';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const avg=a=>a.length?a.reduce((s,v)=>s+v,0)/a.length:0;
const sd=a=>{if(!a.length)return 0;const m=avg(a);return Math.sqrt(avg(a.map(v=>(v-m)**2)))};
const ema=(a,n)=>{if(!a.length)return 0;const k=2/(n+1);let v=a[0];for(let i=1;i<a.length;i++)v=a[i]*k+v*(1-k);return v};
const nowSec=()=>Math.floor(Date.now()/1000);

const S={
  ws:null,candleWs:null,symbol:null,marketName:'',prices:[],times:[],candles:[],timeframe:60,
  chart:null,candleSeries:null,markerApi:null,markers:[],priceLines:[],
  signal:null,setup:null,activeSignal:null,cooldownUntil:0,lastLateKey:'',
  manualDirection:null,demoPosition:null,voice:true,voiceQueue:[],voiceSpeaking:false,bootReadyAt:0,
  historyReq:0,req:100,historyStatus:'SIN CARGAR',installPrompt:null,lastUiKey:'',
  lastSetupEvalBucket:null,lastReboundMarker:'',lastSpikeEventAt:0,lastSpikeTickIndex:0,lastSpikePrice:null,levelDrag:null
};

const els={
  symbol:$('symbol'),graphSymbol:$('graphSymbol'),connect:$('connect'),conn:$('conn'),price:$('price'),ticks:$('ticks'),
  direction:$('direction'),confidence:$('confidence'),phase:$('phase'),reason:$('reason'),history:$('history')
};

function setText(id,v){const e=$(id);if(e)e.textContent=v}
function currentMarketLabel(){return els.symbol?.options?.[els.symbol.selectedIndex]?.text||S.marketName||S.symbol||'Boom / Crash'}
function setTiming(text,kind='waiting'){setText('timingState',text);const e=$('timingState');if(e)e.className='timing '+kind;setText('graphTiming',text)}

/* ---------- VOZ CON PRIORIDADES ---------- */
function queueSpeech(text,priority=10,immediate=false){
  if(!S.voice||!('speechSynthesis' in window)||!text)return;
  if(S.voiceQueue.some(x=>x.text===text))return;
  S.voiceQueue.push({text,priority,immediate});
  S.voiceQueue.sort((a,b)=>b.priority-a.priority);
  if(S.voiceQueue.length>6)S.voiceQueue=S.voiceQueue.slice(0,6);
  pumpVoice();
}
function pumpVoice(){
  if(S.voiceSpeaking||!S.voiceQueue.length||!S.voice)return;
  const idx=S.voiceQueue.findIndex(x=>x.immediate||Date.now()>=S.bootReadyAt);
  if(idx<0){setTimeout(pumpVoice,350);return}
  const item=S.voiceQueue.splice(idx,1)[0];
  const u=new SpeechSynthesisUtterance(item.text);u.lang='es-SV';u.rate=.95;S.voiceSpeaking=true;
  u.onend=u.onerror=()=>{S.voiceSpeaking=false;if(item.immediate)S.bootReadyAt=Date.now()+1400;setTimeout(pumpVoice,180)};
  speechSynthesis.speak(u);
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

/* ---------- DERIV ---------- */
function send(o){if(S.ws?.readyState===1)S.ws.send(JSON.stringify(o))}
function connect(){
  try{S.ws?.close()}catch{}
  S.bootReadyAt=Date.now()+999999;S.setup=null;S.activeSignal=null;S.signal=null;clearChartEvents(false);
  S.ws=new WebSocket('wss://api.derivws.com/trading/v1/options/ws/public');
  els.conn.textContent='CONECTANDO…';els.conn.className='pill off';
  S.ws.onopen=()=>{
    els.conn.textContent='● DERIV CONECTADO';els.conn.className='pill on';setText('graphConn','● DERIV EN VIVO');
    send({active_symbols:'brief',req_id:1});
    queueSpeech('Radar Sintético MR encendido y conectado a Deriv. Preparando el análisis del mercado.',100,true);
  };
  S.ws.onclose=()=>{els.conn.textContent='● DERIV DESCONECTADO';els.conn.className='pill off';setText('graphConn','● DERIV DESCONECTADO')};
  S.ws.onerror=()=>{els.conn.textContent='● ERROR DERIV';els.conn.className='pill off'};
  S.ws.onmessage=e=>{let d;try{d=JSON.parse(e.data)}catch{return}handleMainMessage(d)};
}
function handleMainMessage(d){
  if(d.error){els.reason.textContent=d.error.message||'Error Deriv';return}
  if(d.msg_type==='active_symbols'){
    const list=(d.active_symbols||[]).filter(x=>/boom|crash/i.test(x.underlying_symbol_name||x.display_name||''));
    els.symbol.innerHTML='';
    for(const x of list){const o=document.createElement('option');o.value=x.underlying_symbol||x.symbol;o.textContent=x.underlying_symbol_name||x.display_name||o.value;els.symbol.appendChild(o)}
    els.graphSymbol.innerHTML=els.symbol.innerHTML;
    if(list.length){S.symbol=els.symbol.value;S.marketName=els.symbol.options[els.symbol.selectedIndex].text;els.graphSymbol.value=S.symbol;subscribeMarket()}
  }
  if(d.msg_type==='history'&&d.history){
    S.prices=(d.history.prices||[]).map(Number).filter(Number.isFinite);S.times=(d.history.times||[]).map(Number);
    runEngine(S.prices.at(-1),S.times.at(-1)||nowSec());
  }
  if(d.msg_type==='tick'){
    const q=Number(d.tick?.quote),ep=Number(d.tick?.epoch);if(!Number.isFinite(q)||!Number.isFinite(ep))return;
    S.prices.push(q);S.times.push(ep);if(S.prices.length>1500){S.prices.shift();S.times.shift()}
    runEngine(q,ep);
  }
}
function subscribeMarket(){
  if(!S.symbol)return;
  send({forget_all:'ticks'});S.prices=[];S.times=[];S.setup=null;S.activeSignal=null;S.signal=null;S.cooldownUntil=0;S.lastLateKey='';
  clearChartEvents(true);updateSignalUI();
  send({ticks_history:S.symbol,count:500,end:'latest',style:'ticks',req_id:++S.req});
  send({ticks:S.symbol,subscribe:1,req_id:++S.req});
  requestCandles();
  S.marketName=currentMarketLabel();setText('graphMarketName',S.marketName);els.reason.textContent='Recopilando datos y buscando estructura anticipada…';
}

/* ---------- CANDLE FEED ---------- */
function normalizeCandles(list){
  const map=new Map();for(const c of list||[]){const x={time:Number(c.epoch),open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close)};if(![x.time,x.open,x.high,x.low,x.close].every(Number.isFinite))continue;if(x.high<x.low||x.high<Math.max(x.open,x.close)||x.low>Math.min(x.open,x.close))continue;map.set(x.time,x)}
  return [...map.values()].sort((a,b)=>a.time-b.time).slice(-400);
}
function requestCandles(){
  try{S.candleWs?.close()}catch{}
  const symbol=S.symbol,tf=S.timeframe,req=++S.req;S.historyReq=req;S.candles=[];S.historyStatus='CARGANDO OHLC';updateBadge();
  const ws=new WebSocket('wss://api.derivws.com/trading/v1/options/ws/public');S.candleWs=ws;
  ws.onopen=()=>ws.send(JSON.stringify({ticks_history:symbol,count:260,end:'latest',style:'candles',granularity:tf,req_id:req}));
  ws.onerror=()=>showChartError('No se pudo abrir el canal OHLC de Deriv.');
  ws.onmessage=e=>{let d;try{d=JSON.parse(e.data)}catch{return}
    if(d.error){showChartError('OHLC Deriv: '+d.error.message);return}
    if(d.msg_type==='candles'&&Array.isArray(d.candles)&&d.req_id===req){
      S.candles=normalizeCandles(d.candles);if(S.candles.length<20){showChartError('Histórico OHLC insuficiente.');return}
      hideChartError();S.historyStatus=`${S.candles.length} OHLC`;renderAll(true);ws.send(JSON.stringify({ticks:symbol,subscribe:1,req_id:++S.req}));runEngine(S.prices.at(-1),S.times.at(-1)||nowSec());
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
  S.chart=LightweightCharts.createChart(host,{autoSize:true,layout:{background:{type:'solid',color:'#06101a'},textColor:'#9db4c7'},grid:{vertLines:{color:'#14293a'},horzLines:{color:'#14293a'}},rightPriceScale:{borderColor:'#294157',autoScale:true,scaleMargins:{top:.12,bottom:.12}},timeScale:{borderColor:'#294157',timeVisible:true,secondsVisible:false,rightOffset:6,barSpacing:11,minBarSpacing:3,maxBarSpacing:35},crosshair:{mode:0},handleScroll:{mouseWheel:true,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:false},handleScale:{axisPressedMouseMove:true,mouseWheel:true,pinch:true}});
  S.candleSeries=S.chart.addSeries(LightweightCharts.CandlestickSeries,{upColor:'#11b76c',downColor:'#f24c5e',borderUpColor:'#11b76c',borderDownColor:'#f24c5e',wickUpColor:'#4ee29c',wickDownColor:'#ff7988',priceLineVisible:true,lastValueVisible:true,priceFormat:{type:'price',precision:5,minMove:.00001}});
  try{S.markerApi=LightweightCharts.createSeriesMarkers(S.candleSeries,[],{autoScale:true,zOrder:'top'})}catch{try{S.markerApi=LightweightCharts.createSeriesMarkers(S.candleSeries,[])}catch{S.markerApi=null}}
  S.chart.subscribeCrosshairMove(p=>{if(!p.time)return;const d=p.seriesData.get(S.candleSeries);if(d)updateOHLC(d)});
  return true;
}
function renderAll(fit=false){if(!ensureChart()||!S.candles.length)return;S.candleSeries.setData(S.candles);renderMarkers();if(fit)showRecentCandles(60);updateOHLC(S.candles.at(-1))}
function showRecentCandles(count=60){if(!S.chart||!S.candles.length)return;const n=S.candles.length,visible=Math.min(count,n);S.chart.timeScale().setVisibleLogicalRange({from:n-visible-2,to:n+5})}
function updateOHLC(c){if(!c)return;setText('ohlcLine',`O ${fmt(c.open)}   H ${fmt(c.high)}   L ${fmt(c.low)}   C ${fmt(c.close)}`)}
function updateBadge(){const tf=document.querySelector('.tf.active')?.textContent||'1m';setText('chartBadge',`${tf} · ${S.candles.length} velas · ${S.historyStatus}`)}
function showChartError(t){const e=$('chartError');if(e){e.textContent=t;e.hidden=false}}
function hideChartError(){const e=$('chartError');if(e)e.hidden=true}
function clearPriceLines(){if(!S.candleSeries)return;for(const l of S.priceLines){try{S.candleSeries.removePriceLine(l)}catch{}}S.priceLines=[]}
function addPriceLine(price,title,color){if(!S.candleSeries||!Number.isFinite(price))return;try{S.priceLines.push(S.candleSeries.createPriceLine({price,color,lineWidth:1,lineStyle:2,axisLabelVisible:true,title}))}catch{}}
function drawActiveLevels(){clearPriceLines();const d=S.demoPosition||S.activeSignal;if(!d)return;if(Number.isFinite(d.target))addPriceLine(d.target,'OBJETIVO','#45a8ff');if(Number.isFinite(d.stop))addPriceLine(d.stop,'STOP','#ff7b48')}
function addMarker(type,dir,price,time,text,persistent=true){
  if(!Number.isFinite(price))return;const t=time||S.candles.at(-1)?.time||nowSec();const id=`${type}-${t}-${Date.now()}`;
  const cleanText=type==='alert'?'':type==='entry'?'':type==='rebound'?'':type==='exit'?'':'';S.markers.push({id,type,dir,price,time:t,text:cleanText,persistent});if(S.markers.length>60)S.markers.splice(0,S.markers.length-60);renderMarkers();
}
function markerSpec(m){
  const up=String(m.dir).startsWith('ALZA');let color='#ff9a22',shape=up?'arrowUp':'arrowDown',position=up?'atPriceBottom':'atPriceTop';
  if(m.type==='entry'){color=up?'#18d486':'#ff5365';shape=up?'arrowUp':'arrowDown'}
  else if(m.type==='rebound'){color='#ffd34d';shape='circle';position='atPriceMiddle'}
  else if(m.type==='exit'){color='#58bfff';shape='square';position='atPriceMiddle'}
  else if(m.type==='cancel'){color='#7c8d99';shape='circle';position='atPriceMiddle'}
  return {id:m.id,time:m.time,position,price:m.price,color,shape,text:m.text,size:m.type==='entry'?2:1.4};
}
function renderMarkers(){
  if(!S.markerApi)return;const arr=S.markers.map(markerSpec).sort((a,b)=>a.time-b.time);
  try{S.markerApi.setMarkers(arr)}catch{
    const fallback=arr.map(x=>({id:x.id,time:x.time,position:x.shape==='arrowUp'?'belowBar':x.shape==='arrowDown'?'aboveBar':'inBar',color:x.color,shape:x.shape,text:x.text,size:x.size}));
    try{S.markerApi.setMarkers(fallback)}catch{}
  }
}
function clearChartEvents(all=true){S.markers=all?[]:S.markers.filter(m=>['entry','exit'].includes(m.type));renderMarkers();clearPriceLines()}

/* ---------- INDICADORES ---------- */
function atr(candles,n=14){const a=candles.slice(-n-1);if(a.length<3)return 0;const tr=[];for(let i=1;i<a.length;i++){const c=a[i],p=a[i-1];tr.push(Math.max(c.high-c.low,Math.abs(c.high-p.close),Math.abs(c.low-p.close)))}return avg(tr)}
function rsi(values,n=14){if(values.length<n+1)return 50;let g=0,l=0;for(let i=values.length-n;i<values.length;i++){const d=values[i]-values[i-1];if(d>0)g+=d;else l-=d}if(l===0)return 100;const rs=(g/n)/(l/n||1e-9);return 100-100/(1+rs)}
function metrics(){
  const cs=S.candles.slice(-40);if(cs.length<24)return null;const closes=cs.map(c=>c.close),ranges=cs.map(c=>c.high-c.low),A=atr(cs,14)||sd(closes.slice(-20))||Math.abs(closes.at(-1))*.00001;
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
function spikeRisk(){
  const p=S.prices.slice(-240);if(p.length<35)return {risk:0,text:'SIN DATOS',prep:0,dir:'NEUTRAL',ticksSince:null};
  const ds=p.slice(1).map((v,i)=>v-p[i]),base=ds.slice(0,-8),sigma=sd(base)||sd(ds)||1e-9;
  const recent=ds.slice(-12),recentSigma=sd(recent),compression=recentSigma/(sd(ds.slice(-100))||sigma);
  const market=currentMarketLabel().toLowerCase(),dir=market.includes('boom')?'ALZA ↑':market.includes('crash')?'BAJA ↓':'NEUTRAL';
  const R=rsi(p.slice(-80),14),trend=(p.at(-1)-p.at(-25))/(sigma*5||1),expectedUp=dir.startsWith('ALZA');
  const extreme=expectedUp?clamp((42-R)*2.2,0,30):clamp((R-58)*2.2,0,30);
  const drift=expectedUp?clamp((-trend)*5,0,22):clamp(trend*5,0,22);
  const squeeze=compression<.82?clamp((.82-compression)*45,0,18):0;
  const accel=Math.abs(avg(recent.slice(-3)))/(sigma||1);
  let prep=clamp(Math.round(18+extreme+drift+squeeze+clamp(accel*6,0,16)),8,94);
  const lastAbs=Math.abs(ds.at(-1)||0);
  if(lastAbs>sigma*5.2 && S.prices.length-S.lastSpikeTickIndex>5){S.lastSpikeTickIndex=S.prices.length;S.lastSpikeEventAt=S.times.at(-1)||nowSec();S.lastSpikePrice=p.at(-1);logEvent('SPIKE DETECTADO',dir,p.at(-1),prep,'NO PERSEGUIR')}
  const ticksSince=S.lastSpikeTickIndex?Math.max(0,S.prices.length-S.lastSpikeTickIndex):null;
  return {risk:prep,text:`${dir} · preparación ${prep}%`,prep,dir,ticksSince,R,compression};
}

/* ---------- MOTOR DE ANTICIPACIÓN / ESTADO ---------- */
function setSignal(partial={}){S.signal={dir:'NEUTRAL',conf:0,phase:'⚪ ESPERANDO',reason:'Buscando estructura.',alert:null,trigger:null,entry:null,target:null,stop:null,spikeRisk:0,spikeText:'—',timing:'ESPERANDO',...partial};updateSignalUI()}
function createSetup(m,price,epoch){
  const up=m.dir.startsWith('ALZA');const trigger=up?Math.max(m.last.high,m.prev.high)+m.A*.06:Math.min(m.last.low,m.prev.low)-m.A*.06;const invalid=up?Math.min(m.last.low,m.prev.low)-m.A*.45:Math.max(m.last.high,m.prev.high)+m.A*.45;
  S.setup={id:'S'+Date.now(),dir:m.dir,createdPrice:price,createdEpoch:epoch,createdCandle:m.last.time,trigger,invalid,atr:m.A,conf:m.conf,expiresAt:epoch+S.timeframe*3,score:m.best};
  addMarker('alert',m.dir,price,m.last.time,`ALERTA ${up?'ALZA':'BAJA'} · vigilar ${fmt(trigger)}`);
  setTiming('PRE-ALERTA A TIEMPO','early');
  setSignal({dir:m.dir,conf:m.conf,phase:'🟠 PRE-ALERTA',reason:`Estructura en preparación. Vigilar el disparador ${fmt(trigger)}. La entrada aún NO está confirmada.`,alert:price,trigger,spikeRisk:spikeRisk().risk,spikeText:spikeRisk().text,timing:'PRE-ALERTA'});
  logEvent('PRE-ALERTA',m.dir,price,m.conf,'A TIEMPO');queueSpeech(`Pre alerta. Posible ${up?'compra':'venta'}.`,30);
}
function cancelSetup(reason,late=false,price=null){
  const s=S.setup;if(!s)return;const p=Number.isFinite(price)?price:S.prices.at(-1);if(late){addMarker('cancel',s.dir,p,S.candles.at(-1)?.time,`TARDE · MOVIMIENTO YA EJECUTADO`);setTiming('MOVIMIENTO YA EJECUTADO · ENTRADA BLOQUEADA','late');setSignal({dir:s.dir,conf:s.conf,phase:'⛔ MOVIMIENTO YA EJECUTADO',reason:'El precio recorrió demasiado antes de confirmar el disparador. RADAR no persigue el movimiento.',alert:s.createdPrice,trigger:s.trigger,spikeRisk:spikeRisk().risk,spikeText:spikeRisk().text,timing:'TARDE BLOQUEADO'});logEvent('BLOQUEADA TARDE',s.dir,p,s.conf,'MOVIMIENTO EJECUTADO')}
  else{setTiming('ALERTA CANCELADA','waiting');setSignal({phase:'⚪ ALERTA CANCELADA',reason,spikeRisk:spikeRisk().risk,spikeText:spikeRisk().text,timing:'CANCELADA'});logEvent('CANCELADA',s.dir,p,s.conf,'INVALIDADA')}
  S.setup=null;S.cooldownUntil=(S.times.at(-1)||nowSec())+Math.max(15,S.timeframe*.5);
}
function confirmSetup(price,epoch,m){
  const s=S.setup;if(!s)return;const up=s.dir.startsWith('ALZA');const overshoot=up?price-s.trigger:s.trigger-price,travel=Math.abs(price-s.createdPrice);
  if(overshoot>s.atr*.42||travel>s.atr*.95){cancelSetup('Movimiento demasiado extendido.',true,price);return}
  const target=price+(up?1:-1)*s.atr*1.65,stop=price-(up?1:-1)*s.atr*.78;
  S.activeSignal={id:s.id,dir:s.dir,entry:price,entryEpoch:epoch,entryCandle:S.candles.at(-1)?.time||epoch,target,stop,atr:s.atr,conf:Math.max(s.conf,m?.conf||0),bestPrice:price,reboundWarned:false};S.setup=null;
  addMarker('entry',S.activeSignal.dir,price,S.activeSignal.entryCandle,`${up?'BUY / ALZA':'SELL / BAJA'} · ${fmt(price)}`);drawActiveLevels();setTiming('ENTRADA CONFIRMADA A TIEMPO','ready');
  setSignal({dir:S.activeSignal.dir,conf:S.activeSignal.conf,phase:'🟢 ENTRAR AHORA',reason:`Disparador confirmado sin persecución del precio. Objetivo ${fmt(target)} · Stop ${fmt(stop)}.`,entry:price,target,stop,spikeRisk:spikeRisk().risk,spikeText:spikeRisk().text,timing:'CONFIRMADA'});
  logEvent('ENTRADA',S.activeSignal.dir,price,S.activeSignal.conf,'A TIEMPO');queueSpeech(`Ejecutar ahora. ${up?'Compra':'Venta'} en ${fmt(price)}.`,70);
}
function closeSignal(reason,price,epoch){
  const a=S.activeSignal;if(!a)return;addMarker('exit',a.dir,price,S.candles.at(-1)?.time||epoch,`SALIDA · ${fmt(price)} · ${reason}`);clearPriceLines();setTiming('CICLO FINALIZADO','waiting');
  setSignal({dir:a.dir,conf:a.conf,phase:'🔵 SALIR AHORA',reason:`${reason}. El ciclo queda cerrado y RADAR vuelve a buscar una nueva oportunidad.`,entry:a.entry,target:a.target,stop:a.stop,spikeRisk:spikeRisk().risk,spikeText:spikeRisk().text,timing:'SALIDA'});
  logEvent('SALIDA '+reason,a.dir,price,a.conf,'CICLO CERRADO');queueSpeech(`Salir ahora. ${reason}`,90);S.activeSignal=null;S.cooldownUntil=epoch+S.timeframe;
}
function monitorSignal(price,epoch,m){
  const a=S.activeSignal;if(!a)return;const up=a.dir.startsWith('ALZA');if(up)a.bestPrice=Math.max(a.bestPrice,price);else a.bestPrice=Math.min(a.bestPrice,price);
  if((up&&price>=a.target)||(!up&&price<=a.target)){closeSignal('OBJETIVO ALCANZADO',price,epoch);return}
  if((up&&price<=a.stop)||(!up&&price>=a.stop)){closeSignal('STOP',price,epoch);return}
  const favorable=(price-a.entry)*(up?1:-1),retr=(a.bestPrice-price)*(up?1:-1);const tickMom=S.prices.length>6?(price-S.prices.at(-6))/a.atr:0;
  const opposite=up?tickMom<-.18:tickMom>.18;const extreme=up?m?.R>68:m?.R<32;
  if(!a.reboundWarned&&favorable>a.atr*.35&&(opposite||extreme)){
    a.reboundWarned=true;const reboundDir=up?'BAJA ↓':'ALZA ↑';addMarker('rebound',reboundDir,price,S.candles.at(-1)?.time,`POSIBLE REBOTE ${up?'BAJA':'ALZA'} · ${fmt(price)}`);setSignal({dir:a.dir,conf:a.conf,phase:'🟡 POSIBLE REBOTE',reason:'La operación sigue activa, pero aparecen señales de agotamiento. Vigilar salida.',entry:a.entry,target:a.target,stop:a.stop,spikeRisk:spikeRisk().risk,spikeText:spikeRisk().text,timing:'VIGILAR REBOTE'});queueSpeech(`Posible rebote ${up?'a la baja':'al alza'}. Vigilar salida.`,45)
  }
  if(favorable>a.atr*.4&&retr>a.atr*.52&&opposite){closeSignal('PÉRDIDA DE IMPULSO',price,epoch);return}
  if(!a.reboundWarned)setSignal({dir:a.dir,conf:a.conf,phase:'🔵 MANTENER',reason:'La estructura de la entrada sigue vigente.',entry:a.entry,target:a.target,stop:a.stop,spikeRisk:spikeRisk().risk,spikeText:spikeRisk().text,timing:'SEGUIMIENTO'});
}
function runEngine(price,epoch){
  if(!Number.isFinite(price))return;setText('price',fmt(price));setText('graphPrice',fmt(price));setText('ticks',S.prices.length);
  const m=metrics(),sp=spikeRisk();if(!m){setSignal({phase:'⚪ RECOPILANDO DATOS',reason:'Esperando suficientes velas para formar estructura.',spikeRisk:sp.risk,spikeText:sp.text});return}
  setText('indicators',`EMA 9/21: ${fmt(m.fast)} / ${fmt(m.slow)}\nRSI (14): ${m.R.toFixed(1)}\nATR: ${fmt(m.A)}\nMomentum 3 velas: ${m.mom3.toFixed(2)} ATR\nCompresión: ${(m.compression*100).toFixed(0)}%`);
  const normalPrep=clamp(Math.round(45+Math.max(m.buy,m.sell)*10),0,95);setText('normalEngine',`${m.dir} · ${normalPrep}%`);setText('spikeEngine',`${sp.dir} · ${sp.prep||0}%`);setText('ticksSinceSpike',sp.ticksSince==null?'APRENDIENDO':sp.ticksSince);setText('prepState',`${Math.max(normalPrep,sp.prep||0)}% · ${Math.max(normalPrep,sp.prep||0)>=68?'PRE-ALERTA':Math.max(normalPrep,sp.prep||0)>=52?'OBSERVACIÓN':'BUSCANDO'}`);
  if(S.demoPosition)monitorDemoPosition(price,epoch);
  if(S.activeSignal){monitorSignal(price,epoch,m);return}
  if(S.setup){
    const s=S.setup,up=s.dir.startsWith('ALZA');if(epoch>s.expiresAt){cancelSetup('La alerta caducó sin confirmación.',false,price);return}
    if((up&&price<=s.invalid)||(!up&&price>=s.invalid)){cancelSetup('El mercado invalidó la estructura antes de la entrada.',false,price);return}
    const directionalTravel=(price-s.createdPrice)*(up?1:-1);if(directionalTravel>s.atr*1.02){cancelSetup('El mercado se movió sin darnos una confirmación limpia.',true,price);return}
    const distance=(s.trigger-price)*(up?1:-1);if(distance<=s.atr*.22&&distance>0){setTiming('CERCA DEL DISPARADOR','early');setSignal({dir:s.dir,conf:s.conf,phase:'🟡 POSIBLE ENTRADA',reason:`Precio acercándose al disparador ${fmt(s.trigger)}. Todavía NO entrar.`,alert:s.createdPrice,trigger:s.trigger,spikeRisk:sp.risk,spikeText:sp.text,timing:'CERCA DEL TRIGGER'})}
    const crossed=up?price>=s.trigger:price<=s.trigger;if(crossed){const tickMom=S.prices.length>5?(price-S.prices.at(-5))/s.atr:0;const aligned=up?tickMom>=-.03:tickMom<=.03;if(aligned)confirmSetup(price,epoch,m)}
    return;
  }
  if(epoch<S.cooldownUntil){setSignal({dir:m.dir,conf:m.conf,phase:'⚪ REEVALUANDO',reason:'Ciclo anterior finalizado. Esperando una nueva estructura independiente.',spikeRisk:sp.risk,spikeText:sp.text});return}
  setText('direction',m.dir);setText('confidence',m.conf+'%');
  const spikeCandidate=sp.dir!=='NEUTRAL'&&sp.prep>=68;const normalCandidate=m.dir!=='NEUTRAL'&&m.best>=2.35;
  if(normalCandidate||spikeCandidate){
    if(spikeCandidate&&!normalCandidate){m.dir=sp.dir;m.conf=sp.prep;m.best=sp.prep/20;m.late=false}
    if(m.late){const key=`${m.dir}|${m.last.time}`;setTiming('MOVIMIENTO YA EJECUTADO · SIN ENTRADA','late');setSignal({dir:m.dir,conf:m.conf,phase:'⛔ MOVIMIENTO YA EJECUTADO',reason:'El impulso ya ocurrió antes de que se formara una entrada anticipada. RADAR espera el siguiente ciclo.',spikeRisk:sp.risk,spikeText:sp.text,timing:'TARDE BLOQUEADO'});if(key!==S.lastLateKey){S.lastLateKey=key;logEvent('MOVIMIENTO YA EJECUTADO',m.dir,price,m.conf,'SIN ENTRADA')}return}
    const bucket=m.last.time;if(S.lastSetupEvalBucket!==bucket){S.lastSetupEvalBucket=bucket;createSetup(m,price,epoch);return}
  }
  setTiming('BUSCANDO PRE-ALERTA','waiting');setSignal({dir:m.dir,conf:m.conf,phase:'⚪ ANALIZANDO',reason:'No hay una estructura anticipada suficientemente limpia. No operar.',spikeRisk:sp.risk,spikeText:sp.text,timing:'BUSCANDO'});
}

/* ---------- UI ---------- */
function updateSignalUI(){
  const s=S.signal||{dir:'ESPERANDO',conf:0,phase:'ESPERANDO',reason:'Esperando datos.',spikeRisk:0};
  setText('radarDir',s.dir);setText('direction',s.dir);setText('confidence',(s.conf||0)+'%');setText('phase',s.phase);if(els.reason)els.reason.textContent=s.reason||'';
  setText('alertLevel',fmt(s.alert));setText('triggerLevel',fmt(s.trigger));setText('entryLevel',fmt(s.entry));setText('exitLevel',fmt(s.target));setText('stopLevel',fmt(s.stop));setText('spikeRisk',(s.spikeRisk||0)+'%');
  setText('graphDir',s.dir);setText('graphPhase',s.phase);setText('graphConf',(s.conf||0)+'%');setText('graphAlert',fmt(s.alert));setText('graphTrigger',fmt(s.trigger));setText('graphEntry',fmt(s.entry));setText('graphSpike',(s.spikeRisk||0)+'%');setText('graphTarget',fmt(s.target));setText('graphStop',fmt(s.stop));setText('graphSpikeSignal',s.spikeText||'—');setText('graphReason',s.reason||'');setText('graphExecMode',($('executionMode')?.value||'manual').toUpperCase());
  const o=$('signalOverlay');if(o){let cl='wait';if((s.phase||'').includes('PRE-ALERTA')||(s.phase||'').includes('POSIBLE'))cl='prealert';if((s.phase||'').includes('ENTRAR')||(s.phase||'').includes('MANTENER'))cl='entry';if((s.phase||'').includes('SALIR'))cl='exit';if((s.phase||'').includes('EJECUTADO'))cl='late';o.className='signal-overlay '+cl;o.textContent=s.phase+(Number.isFinite(s.trigger)?` · ${fmt(s.trigger)}`:'')}
}
function logEvent(event,dir,price,conf,timing){const tr=document.createElement('tr');tr.innerHTML=`<td>${new Date().toLocaleTimeString()}</td><td>${currentMarketLabel()}</td><td>${dir}</td><td>${event}</td><td>${fmt(price)}</td><td>${conf||0}%</td><td>${timing}</td>`;els.history.prepend(tr);while(els.history.children.length>60)els.history.lastChild.remove()}
function showView(name){document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.dataset.view===name));$(name+'View').classList.add('active');if(name==='graph')setTimeout(()=>{ensureChart();renderAll(false);showRecentCandles(60)},60)}

/* ---------- DEMO MANUAL ---------- */
function chooseDirection(dir){S.manualDirection=dir;$('manualUp').classList.toggle('selected',dir==='ALZA ↑');$('manualDown').classList.toggle('selected',dir==='BAJA ↓');openDemo(dir)}
function openDemo(forcedDir=null){
  if(S.demoPosition){queueSpeech('Ya existe una operación demo activa.',15);return}const price=S.prices.at(-1);if(!Number.isFinite(price))return;let dir=forcedDir||S.manualDirection;if(!dir&&S.activeSignal)dir=S.activeSignal.dir;if(!dir){queueSpeech('Seleccione BUY alza o SELL baja.',15);return}
  const A=metrics()?.A||sd(S.prices.slice(-40))||Math.abs(price)*.00001,match=S.activeSignal&&S.activeSignal.dir===dir;const up=dir.startsWith('ALZA');
  const lot=Math.max(.01,Number($('lotSize')?.value)||.20);S.demoPosition={id:'D'+Date.now().toString().slice(-6),dir,entry:price,opened:Date.now(),lot,target:match?S.activeSignal.target:price+(up?1:-1)*A*1.6,stop:match?S.activeSignal.stop:price-(up?1:-1)*A*.8,bestPrice:price,source:match?'RADAR':'MANUAL'};
  addMarker('entry',dir,price,S.candles.at(-1)?.time,`${S.demoPosition.source} ${up?'BUY':'SELL'} · ${fmt(price)}`);drawActiveLevels();renderDemo();queueSpeech('Entrada demo registrada.',50)
}
function closeDemo(reason='SALIDA MANUAL'){
  if(!S.demoPosition)return;const d=S.demoPosition,price=S.prices.at(-1);const pnl=(price-d.entry)*(d.dir.startsWith('ALZA')?1:-1);addMarker('exit',d.dir,price,S.candles.at(-1)?.time,`SALIDA DEMO · ${fmt(price)} · ${reason}`);logEvent('DEMO '+reason,d.dir,price,0,pnl>=0?'GANADA':'PERDIDA');S.demoPosition=null;clearPriceLines();renderDemo();queueSpeech(`Salida demo registrada. ${pnl>=0?'Resultado favorable':'Resultado desfavorable'}.`,60)
}
function monitorDemoPosition(price){const d=S.demoPosition;if(!d)return;const up=d.dir.startsWith('ALZA');if((up&&price>=d.target)||(!up&&price<=d.target)){closeDemo('PROFIT');return}if((up&&price<=d.stop)||(!up&&price>=d.stop)){closeDemo('STOP');return}renderDemo()}
function renderDemo(){
  const d=S.demoPosition;if(!d){setText('positionState','SIN POSICIÓN');setText('positionCard','Sin operación activa.');return}const cur=S.prices.at(-1),pnl=(cur-d.entry)*(d.dir.startsWith('ALZA')?1:-1);setText('positionState',`${d.dir.startsWith('ALZA')?'BUY':'SELL'} · ${fmt(d.entry)} · P/L ${pnl>=0?'+':''}${fmt(pnl)}`);if($('tpInput'))$('tpInput').value=d.target.toFixed(5);if($('slInput'))$('slInput').value=d.stop.toFixed(5);$('positionCard').innerHTML=`<b>${d.source} · ${d.dir} · Lote ${d.lot||0.20}</b><br>Entrada: ${fmt(d.entry)}<br>Actual: ${fmt(cur)}<br>Objetivo: ${fmt(d.target)}<br>Stop: ${fmt(d.stop)}<br>P/L: ${pnl>=0?'+':''}${fmt(pnl)}`
}

/* ---------- EVENTOS ---------- */
els.connect.onclick=connect;
els.symbol.onchange=()=>{S.symbol=els.symbol.value;els.graphSymbol.value=S.symbol;S.marketName=currentMarketLabel();subscribeMarket()};
els.graphSymbol.onchange=()=>{els.symbol.value=els.graphSymbol.value;S.symbol=els.graphSymbol.value;S.marketName=currentMarketLabel();subscribeMarket()};
$('voice').onclick=()=>{S.voice=!S.voice;$('voice').textContent=`🔊 Voz: ${S.voice?'ON':'OFF'}`};
$('clear').onclick=()=>{S.setup=null;S.activeSignal=null;S.signal=null;S.cooldownUntil=0;clearChartEvents(true);setSignal()};
$('openGraph').onclick=()=>showView('graph');$('backRadar').onclick=()=>showView('radar');
document.querySelectorAll('.nav').forEach(b=>b.onclick=()=>showView(b.dataset.view));
document.querySelectorAll('.tf').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tf').forEach(x=>x.classList.remove('active'));b.classList.add('active');S.timeframe=Number(b.dataset.sec);S.setup=null;S.activeSignal=null;S.cooldownUntil=0;clearChartEvents(true);requestCandles()});
$('zoomIn').onclick=()=>S.chart?.timeScale().applyOptions({barSpacing:Math.min(34,(S.chart.timeScale().options()?.barSpacing||11)*1.28)});
$('zoomOut').onclick=()=>S.chart?.timeScale().applyOptions({barSpacing:Math.max(3,(S.chart.timeScale().options()?.barSpacing||11)/1.28)});
$('resetChart').onclick=()=>{S.chart?.timeScale().applyOptions({barSpacing:11,rightOffset:6});showRecentCandles(60)};
$('clearMarks').onclick=()=>clearChartEvents(true);
$('manualUp').onclick=()=>chooseDirection('ALZA ↑');$('manualDown').onclick=()=>chooseDirection('BAJA ↓');$('manualExit').onclick=()=>closeDemo('SALIDA MANUAL');
$('applyLevels').onclick=()=>{const d=S.demoPosition;if(!d)return;const tp=Number($('tpInput').value),sl=Number($('slInput').value),up=d.dir.startsWith('ALZA');if(!Number.isFinite(tp)||!Number.isFinite(sl))return;if((up&&(tp<=d.entry||sl>=d.entry))||(!up&&(tp>=d.entry||sl<=d.entry))){queueSpeech('Revise los niveles. TP y stop están en posiciones incorrectas.',50);return}d.target=tp;d.stop=sl;drawActiveLevels();renderDemo();queueSpeech('Niveles actualizados.',20)};
function drawer(open){$('controlDrawer').classList.toggle('open',open);$('drawerBackdrop').classList.toggle('open',open)}
$('toggleDrawer').onclick=()=>drawer(true);$('closeDrawer').onclick=()=>drawer(false);$('drawerBackdrop').onclick=()=>drawer(false);
function setupLevelDrag(){const host=$('lwChart');if(!host||host.dataset.levelDrag)return;host.dataset.levelDrag='1';
  const near=(y,price)=>{const c=S.candleSeries?.priceToCoordinate?.(price);return Number.isFinite(c)&&Math.abs(c-y)<22};
  host.addEventListener('pointerdown',e=>{const d=S.demoPosition;if(!d||!S.candleSeries)return;const r=host.getBoundingClientRect(),y=e.clientY-r.top;if(near(y,d.target))S.levelDrag='target';else if(near(y,d.stop))S.levelDrag='stop';else return;host.classList.add('dragging-level');host.setPointerCapture?.(e.pointerId);e.preventDefault()},{capture:true});
  host.addEventListener('pointermove',e=>{if(!S.levelDrag||!S.demoPosition)return;const r=host.getBoundingClientRect(),price=S.candleSeries.coordinateToPrice?.(e.clientY-r.top);if(!Number.isFinite(price))return;const d=S.demoPosition,up=d.dir.startsWith('ALZA');if(S.levelDrag==='target'&&((up&&price>d.entry)||(!up&&price<d.entry)))d.target=price;if(S.levelDrag==='stop'&&((up&&price<d.entry)||(!up&&price>d.entry)))d.stop=price;drawActiveLevels();renderDemo();e.preventDefault()},{capture:true});
  const done=()=>{if(S.levelDrag){S.levelDrag=null;host.classList.remove('dragging-level')}};host.addEventListener('pointerup',done,{capture:true});host.addEventListener('pointercancel',done,{capture:true});}
setupLevelDrag();
window.addEventListener('resize',()=>setTimeout(()=>{showRecentCandles(60);renderMarkers()},80));

setSignal();
