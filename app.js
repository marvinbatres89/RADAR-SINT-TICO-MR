const $=id=>document.getElementById(id);
const S={ws:null,symbol:null,prices:[],times:[],candles:[],voice:true,signal:null,lastLogged:'',timeframe:60,req:100,historyReq:null,historyStatus:'SIN CARGAR',historyTf:null,historySymbol:null,chart:null,candleSeries:null,resizeObs:null,lastRawCandleResponse:null,candleFeed:null};
const els={symbol:$('symbol'),connect:$('connect'),conn:$('conn'),price:$('price'),ticks:$('ticks'),direction:$('direction'),confidence:$('confidence'),phase:$('phase'),reason:$('reason'),alert:$('alertLevel'),entry:$('entryLevel'),exit:$('exitLevel'),spike:$('spikeRisk'),ind:$('indicators'),history:$('history')};
function setText(id,v){const e=$(id);if(e)e.textContent=v}
function syncUI(){const s=S.signal||{};setText('radarDir',s.dir||'ESPERANDO');setText('graphDir',s.dir||'ESPERANDO');setText('graphConf',(s.conf||0)+'%');setText('graphPhase',s.phase||'ESPERANDO');setText('graphReason',els.reason.textContent);setText('graphTarget',s.exit?.toFixed(5)||'—');setText('graphSpike',(s.spikeRisk||0)+'%');setText('graphPrice',els.price.textContent);setText('infoPrice',els.price.textContent);setText('infoTicks',els.ticks.textContent);setText('infoDir',s.dir||'NEUTRAL');setText('infoAlert',s.alert?.toFixed(5)||'—');setText('infoEntry',s.entry?.toFixed(5)||'—');setText('infoExit',s.exit?.toFixed(5)||'—');setText('graphConn',S.ws?.readyState===1?'● DERIV EN VIVO':'● DERIV')}
function speak(t){if(!S.voice||!('speechSynthesis'in window))return;speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(t);u.lang='es-SV';u.rate=.95;speechSynthesis.speak(u)}
function send(o){if(S.ws?.readyState===1)S.ws.send(JSON.stringify(o))}
function connect(){if(S.ws)S.ws.close();S.ws=new WebSocket('wss://api.derivws.com/trading/v1/options/ws/public');els.conn.textContent='CONECTANDO…';S.ws.onopen=()=>{els.conn.textContent='DERIV CONECTADO';els.conn.className='pill on';send({active_symbols:'brief',req_id:1});speak('Radar Sintético MR conectado a Deriv')};S.ws.onclose=e=>{els.conn.textContent='DERIV DESCONECTADO';els.conn.className='pill off';els.reason.textContent=`Conexión cerrada${e.code?` (código ${e.code})`:''}. Pulse Conectar Deriv para reintentar.`};S.ws.onerror=()=>{els.conn.textContent='ERROR DERIV';els.conn.className='pill off';els.reason.textContent='No se pudo abrir el canal público de Deriv.'};S.ws.onmessage=e=>{let d;try{d=JSON.parse(e.data)}catch{return}handle(d)}}
function handle(d){
 if(d.error){if(d.req_id===S.historyReq){showChartError('Deriv rechazó el histórico OHLC: '+d.error.message);S.historyStatus='ERROR OHLC (HISTÓRICO)'}else els.reason.textContent=d.error.message;updateBadge();return}
 if(d.msg_type==='active_symbols'){const list=(d.active_symbols||[]).filter(x=>/boom|crash/i.test(x.underlying_symbol_name||x.display_name||''));els.symbol.innerHTML='';list.forEach(x=>{const o=document.createElement('option');o.value=x.underlying_symbol||x.symbol;o.textContent=x.underlying_symbol_name||x.display_name||o.value;els.symbol.appendChild(o)});$('graphSymbol').innerHTML=els.symbol.innerHTML;if(list.length){S.symbol=els.symbol.value;$('graphSymbol').value=S.symbol;subscribe()}}
 if(d.msg_type==='history'&&d.history){S.prices=(d.history.prices||[]).map(Number);S.times=(d.history.times||[]).map(Number);analyze()}
 if(d.msg_type==='tick'){const q=Number(d.tick.quote),ep=Number(d.tick.epoch);if(!Number.isFinite(q)||!Number.isFinite(ep))return;S.prices.push(q);S.times.push(ep);if(S.prices.length>600){S.prices.shift();S.times.shift()}analyze()}
}
function normalizeCandles(list){const map=new Map();for(const c of list||[]){const x={time:Number(c.epoch),open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close)};if(![x.time,x.open,x.high,x.low,x.close].every(Number.isFinite))continue;if(x.high<Math.max(x.open,x.close)||x.low>Math.min(x.open,x.close)||x.high<x.low)continue;map.set(x.time,x)}return [...map.values()].sort((a,b)=>a.time-b.time).slice(-300)}

class DerivCandleFeed{
 constructor(){this.ws=null;this.req=50000;this.generation=0;this.symbol=null;this.tf=60;this.ready=false}
 close(){this.generation++;this.ready=false;if(this.ws){try{this.ws.close()}catch{}}this.ws=null}
 load(symbol,tf){
  this.close();this.symbol=symbol;this.tf=Number(tf);const gen=this.generation;S.candles=[];S.historyStatus='CANDLE FEED · CONECTANDO';updateBadge();
  const box=$('ohlcDiagnostic');if(box)box.innerHTML=`<div class="diag-title">V1.5.6 · DERIV CANDLE FEED</div><div class="diag-line">Canal gráfico independiente · ${esc(symbol)} · ${this.tf}s</div>`;
  const ws=new WebSocket('wss://api.derivws.com/trading/v1/options/ws/public');this.ws=ws;
  ws.onopen=()=>{if(gen!==this.generation)return;this.ready=true;const id=++this.req;S.historyReq=id;S.historyTf=this.tf;S.historySymbol=this.symbol;S.historyStatus='CANDLE FEED · SOLICITANDO 200 OHLC';updateBadge();ws.send(JSON.stringify({ticks_history:this.symbol,count:200,end:'latest',style:'candles',granularity:this.tf,req_id:id}))};
  ws.onerror=()=>{if(gen!==this.generation)return;S.historyStatus='CANDLE FEED · ERROR DE CANAL';showChartError('No se pudo abrir el canal independiente de velas Deriv.')};
  ws.onclose=()=>{if(gen!==this.generation)return;this.ready=false};
  ws.onmessage=e=>{if(gen!==this.generation)return;let d;try{d=JSON.parse(e.data)}catch{return}
   if(d.error){S.historyStatus='CANDLE FEED · ERROR OHLC';showChartError('Deriv CandleFeed: '+d.error.message);return}
   if(d.msg_type==='candles'&&Array.isArray(d.candles)&&d.req_id===S.historyReq){S.lastRawCandleResponse=d;acceptCandles(d.candles,d);if(S.candles.length){ws.send(JSON.stringify({ticks:this.symbol,subscribe:1,req_id:++this.req}))}}
   if(d.msg_type==='tick'&&S.candles.length){const q=Number(d.tick?.quote),ep=Number(d.tick?.epoch);if(Number.isFinite(q)&&Number.isFinite(ep))this.update(q,ep)}
  };
 }
 update(price,epoch){const bucket=Math.floor(epoch/this.tf)*this.tf;let c=S.candles[S.candles.length-1];if(!c||bucket<c.time)return;if(bucket>c.time){c={time:bucket,open:c.close,high:Math.max(c.close,price),low:Math.min(c.close,price),close:price};S.candles.push(c);if(S.candles.length>300)S.candles.shift()}else{c.high=Math.max(c.high,price);c.low=Math.min(c.low,price);c.close=price}S.candleSeries?.update(c);updateOHLC(c);updateBadge()}
}
function analyzeCandleDiagnostics(raw,cs,tf){
 const rawN=Array.isArray(raw)?raw.length:0,n=cs.length;
 const diffs=[];let nonPositive=0,duplicates=0,exact=0,off=0,minDiff=null,maxDiff=null;
 for(let i=1;i<n;i++){const d=cs[i].time-cs[i-1].time;diffs.push(d);if(d<=0)nonPositive++;if(d===0)duplicates++;if(d===tf)exact++;else off++;if(d>0){minDiff=minDiff===null?d:Math.min(minDiff,d);maxDiff=maxDiff===null?d:Math.max(maxDiff,d)}}
 const freq={};for(const d of diffs)freq[d]=(freq[d]||0)+1;
 const common=Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([d,c])=>`${d}s × ${c}`).join(' · ')||'—';
 const first=cs[0]||null,last=cs[n-1]||null;
 let reason='OK';
 if(n<10)reason=`RECHAZO: solo ${n} velas OHLC válidas`;
 else if(duplicates)reason=`RECHAZO: ${duplicates} timestamps duplicados`;
 else if(nonPositive)reason=`RECHAZO: ${nonPositive} intervalos no crecientes`;
 else if(off>Math.max(2,Math.floor(n*.05)))reason=`RECHAZO ACTUAL: ${off}/${Math.max(0,n-1)} intervalos no son exactamente ${tf}s`;
 return {rawN,n,tf,diffs,nonPositive,duplicates,exact,off,minDiff,maxDiff,common,first,last,reason};
}
function esc(v){return String(v??'—').replace(/[&<>\"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[m]))}
function renderOhlcDiagnostic(raw,cs,diag,envelope){
 const box=$('ohlcDiagnostic');if(!box)return;
 const original=Array.isArray(raw)?raw:[];
 const rows=original.slice(0,5).concat(original.slice(-5)).map((c,i)=>`<tr><td>${i<5?'INI':'FIN'}</td><td>${esc(c?.epoch)}</td><td>${esc(c?.open)}</td><td>${esc(c?.high)}</td><td>${esc(c?.low)}</td><td>${esc(c?.close)}</td></tr>`).join('');
 const keys=envelope?Object.keys(envelope).join(', '):'—';
 const sample=envelope?JSON.stringify({msg_type:envelope.msg_type,req_id:envelope.req_id,echo_req:envelope.echo_req,candles:original.slice(0,2)},null,2):'Sin envolvente';
 box.innerHTML=`<div class="diag-title">V1.5.6 · DERIV CANDLE FEED</div>
 <div class="diag-grid"><div>RECIBIDAS RAW<b>${original.length}</b></div><div>VÁLIDAS PARSER<b>${cs.length}</b></div><div>TF SOLICITADO<b>${diag.tf}s</b></div><div>MSG_TYPE<b>${esc(envelope?.msg_type)}</b></div></div>
 <div class="diag-line"><b>CLAVES RESPUESTA:</b> ${esc(keys)}</div>
 <div class="diag-line"><b>INTERVALOS PARSER:</b> ${esc(diag.common)}</div>
 <div class="diag-reason ${diag.reason==='OK'?'diag-ok':'diag-bad'}"><b>VALIDACIÓN:</b> ${esc(diag.reason)}</div>
 <table class="diag-table"><thead><tr><th>Zona</th><th>epoch RAW</th><th>open RAW</th><th>high RAW</th><th>low RAW</th><th>close RAW</th></tr></thead><tbody>${rows}</tbody></table>
 <details open><summary><b>JSON CRUDO (2 primeras velas)</b></summary><pre style="white-space:pre-wrap;word-break:break-word;margin:6px 0 0">${esc(sample)}</pre></details>`;
}
function validateDirectCandles(cs,tf,diag){if(cs.length<10)return {ok:false,msg:`Solo ${cs.length} velas OHLC válidas`};if(diag.duplicates)return {ok:false,msg:`${diag.duplicates} timestamps duplicados`};if(diag.nonPositive)return {ok:false,msg:`${diag.nonPositive} intervalos no crecientes`};if(diag.off>Math.max(2,Math.floor(cs.length*.05)))return {ok:false,msg:`${diag.off} de ${cs.length-1} intervalos difieren de ${tf}s (mín ${diag.minDiff??'—'}s, máx ${diag.maxDiff??'—'}s)`};return {ok:true,msg:'OHLC DIRECTO VALIDADO'}}
function acceptCandles(list,envelope){const cs=normalizeCandles(list);const tf=S.historyTf||S.timeframe;const diag=analyzeCandleDiagnostics(list,cs,tf);renderOhlcDiagnostic(list,cs,diag,envelope);console.log('OHLC DIAG',diag);console.table(cs.slice(0,5));console.table(cs.slice(-5));const v=validateDirectCandles(cs,tf,diag);if(!v.ok){S.candles=[];S.historyStatus='HISTÓRICO INVÁLIDO · VER DIAGNÓSTICO';showChartError(`${v.msg}. Revise el panel DERIV CANDLE FEED.`);updateBadge();return}hideChartError();S.candles=cs;S.historyStatus=`${cs.length} OHLC DIRECTO · VALIDADO`;renderAll(true);updateBadge()}
function requestCandles(){if(!S.symbol)return;if(!S.candleFeed)S.candleFeed=new DerivCandleFeed();hideChartError();S.candleFeed.load(S.symbol,S.timeframe)}
function subscribe(){if(!S.symbol)return;send({forget_all:'ticks'});S.prices=[];S.times=[];S.signal=null;send({ticks_history:S.symbol,count:300,end:'latest',style:'ticks',req_id:2});requestCandles();send({ticks:S.symbol,subscribe:1,req_id:3});els.reason.textContent='Recopilando datos del mercado…'}
function updateLiveCandle(price,epoch){if(!S.candles.length)return;const bucket=Math.floor(epoch/S.timeframe)*S.timeframe;let c=S.candles[S.candles.length-1];if(bucket<c.time)return;if(bucket>c.time){c={time:bucket,open:c.close,high:Math.max(c.close,price),low:Math.min(c.close,price),close:price};S.candles.push(c);if(S.candles.length>300)S.candles.shift()}else{c.high=Math.max(c.high,price);c.low=Math.min(c.low,price);c.close=price}S.candleSeries?.update(c);updateEmaLive();updateOHLC(c);updateBadge()}
function ensureChart(){if(S.chart)return true;if(!window.LightweightCharts){showChartError('No cargó el motor financiero Lightweight Charts. Revise la conexión a Internet.');return false}const host=$('lwChart');const dark=!document.body.classList.contains('light');S.chart=LightweightCharts.createChart(host,{autoSize:true,layout:{background:{type:'solid',color:dark?'#07111d':'#f7fbff'},textColor:dark?'#9fb4c8':'#52677b'},grid:{vertLines:{color:dark?'#173049':'#dce8f1'},horzLines:{color:dark?'#173049':'#dce8f1'}},rightPriceScale:{borderColor:dark?'#294157':'#cadbe7',autoScale:true,scaleMargins:{top:.08,bottom:.08}},timeScale:{borderColor:dark?'#294157':'#cadbe7',timeVisible:true,secondsVisible:false,rightOffset:5,barSpacing:10,minBarSpacing:4,fixLeftEdge:false,fixRightEdge:false},crosshair:{mode:0},handleScroll:{mouseWheel:true,pressedMouseMove:true,horzTouchDrag:true,vertTouchDrag:false},handleScale:{axisPressedMouseMove:true,mouseWheel:true,pinch:true}});S.candleSeries=S.chart.addSeries(LightweightCharts.CandlestickSeries,{upColor:'#08a85d',downColor:'#f43d4d',borderUpColor:'#08a85d',borderDownColor:'#f43d4d',wickUpColor:'#08a85d',wickDownColor:'#f43d4d',priceLineVisible:true,lastValueVisible:true});S.chart.subscribeCrosshairMove(p=>{if(!p.time)return;const d=p.seriesData.get(S.candleSeries);if(d)updateOHLC(d)});return true}
function showRecentCandles(count=70){if(!S.chart||!S.candles.length)return;const n=S.candles.length;const visible=Math.min(count,n);S.chart.timeScale().setVisibleLogicalRange({from:n-visible-2,to:n+4})}
function renderAll(fit=false){if(!ensureChart()||!S.candles.length)return;S.candleSeries.setData(S.candles);if(fit)showRecentCandles(70);updateOHLC(S.candles[S.candles.length-1])}
function updateEmaLive(){}
function updateOHLC(c){const e=document.querySelector('.ohlc');if(!e||!c)return;e.innerHTML=`O ${Number(c.open).toFixed(5)} &nbsp; H ${Number(c.high).toFixed(5)} &nbsp; L ${Number(c.low).toFixed(5)} &nbsp; C ${Number(c.close).toFixed(5)} <span>· OHLC Deriv</span>`}
function updateBadge(){const tf=document.querySelector('.tf.active')?.textContent||'1m';setText('chartBadge',`${tf} · ${S.candles.length} velas · ${S.historyStatus}`)}
function showChartError(t){const e=$('chartError');if(e){e.textContent=t;e.hidden=false}updateBadge()}
function hideChartError(){const e=$('chartError');if(e)e.hidden=true}
function applyChartTheme(){if(!S.chart)return;const dark=!document.body.classList.contains('light');S.chart.applyOptions({layout:{background:{type:'solid',color:dark?'#07111d':'#f7fbff'},textColor:dark?'#9fb4c8':'#52677b'},grid:{vertLines:{color:dark?'#173049':'#dce8f1'},horzLines:{color:dark?'#173049':'#dce8f1'}}})}
const avg=a=>a.reduce((s,v)=>s+v,0)/(a.length||1),sd=a=>{const m=avg(a);return Math.sqrt(avg(a.map(v=>(v-m)**2)))};function ema(a,n){if(!a.length)return 0;let k=2/(n+1),v=a[0];for(const x of a.slice(1))v=x*k+v*(1-k);return v}
function analyze(){const p=S.prices,n=p.length;els.ticks.textContent=n;if(n<40){syncUI();return}const cur=p[n-1],r=p.slice(-40),fast=ema(r.slice(-15),8),slow=ema(r,21),mom=cur-p[n-11],vol=sd(r.slice(-25)),unit=vol||Math.abs(cur)*.00001||1,score=(fast-slow)/unit*.22+mom/unit*.12,conf=Math.min(92,Math.round(50+Math.abs(score)*18)),dir=score>.35?'ALZA ↑':score<-.35?'BAJA ↓':'NEUTRAL';const deltas=r.slice(1).map((v,i)=>v-r[i]),largest=Math.max(...deltas.map(Math.abs)),spikeRisk=Math.min(95,Math.round(20+Math.max(0,largest/unit-1)*10+Math.min(35,Math.abs(score)*8)));let phase='ESPERAR',reason='Sin confirmación suficiente.',alert=null,entry=null,exit=null;if(dir!=='NEUTRAL'&&conf>=62){phase='🟡 ALERTA';alert=cur;reason='Dirección emergente detectada. Vigilando confirmación.'}if(dir!=='NEUTRAL'&&conf>=72){phase='🟢 ENTRADA';entry=cur;alert=S.signal?.alert??cur;exit=cur+(dir.startsWith('ALZA')?1:-1)*unit*2.2;reason='Momentum y estructura confirman la dirección.'}S.signal={dir,conf,phase,alert,entry,exit,spikeRisk};els.price.textContent=cur.toFixed(5);els.direction.textContent=dir;els.confidence.textContent=conf+'%';els.phase.textContent=phase;els.reason.textContent=reason;els.alert.textContent=alert?.toFixed(5)||'—';els.entry.textContent=entry?.toFixed(5)||'—';els.exit.textContent=exit?.toFixed(5)||'—';els.spike.textContent=spikeRisk+'%';els.ind.innerHTML=`Momentum: ${mom.toFixed(5)}<br>Volatilidad: ${vol.toFixed(5)}<br>EMA rápida/lenta: ${fast.toFixed(5)} / ${slow.toFixed(5)}`;syncUI();const key=phase+dir;if((phase.includes('ALERTA')||phase.includes('ENTRADA'))&&key!==S.lastLogged){S.lastLogged=key;logSignal();speak(`${phase.includes('ENTRADA')?'Entrada confirmada':'Alerta'} ${dir.startsWith('ALZA')?'al alza':'a la baja'}`)}}
function logSignal(){const s=S.signal,tr=document.createElement('tr');tr.innerHTML=`<td>${new Date().toLocaleTimeString()}</td><td>${els.symbol.options[els.symbol.selectedIndex]?.text||S.symbol}</td><td>${s.dir}</td><td>${s.phase}</td><td>${s.conf}%</td><td>${s.alert?.toFixed(5)||'—'}</td><td>${s.entry?.toFixed(5)||'—'}</td><td>${s.exit?.toFixed(5)||'—'}</td>`;els.history.prepend(tr);while(els.history.children.length>30)els.history.lastChild.remove()}
function showView(name){document.body.classList.toggle('graph-mode',name==='graph');document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.dataset.view===name));$(name+'View').classList.add('active');if(name==='graph')setTimeout(()=>{ensureChart();renderAll(false);showRecentCandles(70)},80)}
els.connect.onclick=connect;els.symbol.onchange=()=>{S.symbol=els.symbol.value;$('graphSymbol').value=S.symbol;S.lastLogged='';subscribe()};$('graphSymbol').onchange=()=>{els.symbol.value=$('graphSymbol').value;S.symbol=els.symbol.value;subscribe()};$('voice').onclick=()=>{S.voice=!S.voice;$('voice').textContent=`🔊 Voz: ${S.voice?'ON':'OFF'}`};$('clear').onclick=()=>{S.signal=null;S.lastLogged='';syncUI()};document.querySelectorAll('.tf').forEach(b=>b.onclick=()=>{document.querySelectorAll('.tf').forEach(x=>x.classList.remove('active'));b.classList.add('active');S.timeframe=Number(b.dataset.sec);requestCandles()});document.querySelectorAll('.nav').forEach(b=>{if(b.dataset.view)b.onclick=()=>showView(b.dataset.view)});$('openGraph').onclick=()=>showView('graph');$('backRadar').onclick=()=>showView('radar');$('theme').onclick=()=>{document.body.classList.toggle('light');$('theme').textContent=document.body.classList.contains('light')?'🌙 Oscuro':'☀️ Claro';applyChartTheme()};$('graphTheme').onclick=()=>$('theme').click();$('togglePanel').onclick=()=>document.querySelector('.terminal-body')?.classList.toggle('panel-open');$('closePanel').onclick=()=>document.querySelector('.terminal-body')?.classList.remove('panel-open');$('panelBackdrop').onclick=()=>document.querySelector('.terminal-body')?.classList.remove('panel-open');$('zoomIn').onclick=()=>{if(!S.chart)return;const ts=S.chart.timeScale(),r=ts.getVisibleLogicalRange();if(r)ts.setVisibleLogicalRange({from:r.from+5,to:r.to-5})};$('zoomOut').onclick=()=>{if(!S.chart)return;const ts=S.chart.timeScale(),r=ts.getVisibleLogicalRange();if(r)ts.setVisibleLogicalRange({from:r.from-8,to:r.to+8})};$('resetChart').onclick=()=>showRecentCandles(70);window.addEventListener('resize',()=>setTimeout(()=>showRecentCandles(70),80));

/* ==========================================================
   V1.6.1 · PRE-ALERTA + DIRECCIÓN + SPIKE + MANUAL LIBRE
   Las entradas manuales DEMO no dependen de una señal RADAR.
   ========================================================== */
S.demoPosition=null; S.signalLines=[]; S.signalState='WAIT'; S.lastSignalVoice=''; S.manualDirection=null; S.manualComparisons=[];
function fmtPrice(v){return Number.isFinite(v)?Number(v).toFixed(5):'—'}
function atrFromCandles(n=14){const a=S.candles.slice(-n);if(a.length<3)return 0;return avg(a.map(c=>Math.max(c.high-c.low,Math.abs(c.high-c.close),Math.abs(c.low-c.close))))}
function clearSignalLines(){if(!S.candleSeries)return;for(const l of S.signalLines){try{S.candleSeries.removePriceLine(l)}catch{}}S.signalLines=[]}
function addSignalLine(price,title,color,style=2){if(!S.candleSeries||!Number.isFinite(price))return;try{S.signalLines.push(S.candleSeries.createPriceLine({price,color,lineWidth:2,lineStyle:style,axisLabelVisible:true,title}))}catch{}}
function drawSignalLevels(s){clearSignalLines();if(!s)return;addSignalLine(s.preAlert,'PRE-ALERTA','#c88719',2);addSignalLine(s.alert,'POSIBLE','#d9a900',2);addSignalLine(s.entry,'ENTRADA','#0bad63',0);addSignalLine(s.exit,'OBJETIVO','#e24a59',2);addSignalLine(s.stop,'STOP','#f08a35',2)}
function signalUiV161(s){
 setText('stopLevel',fmtPrice(s.stop));setText('holdTime',s.hold||'—');setText('graphAlert',fmtPrice(s.alert||s.preAlert));setText('graphEntry',fmtPrice(s.entry));setText('graphStop',fmtPrice(s.stop));setText('graphHold',s.hold||'—');setText('graphExecMode',($('executionMode')?.value||'manual').toUpperCase());setText('graphSpikeSignal',s.spikeSignal||'ESPERANDO');
 const o=$('signalOverlay');if(o){const cl=s.phase.includes('SPIKE')?'spike':s.phase.includes('PRE-ALERTA')?'prealert':s.phase.includes('ENTRAR')?'entry':s.phase.includes('POSIBLE')?'alert':s.phase.includes('NO OPERAR')?'wait':'';o.className='signal-overlay '+cl;o.textContent=s.phase+(Number.isFinite(s.alert||s.preAlert)?` · ${fmtPrice(s.alert||s.preAlert)}`:'')}
 drawSignalLevels(s);
}
function analyze(){
 const p=S.prices,n=p.length;els.ticks.textContent=n;if(n<60){syncUI();return}
 const cur=p[n-1],r=p.slice(-100),fast=ema(r.slice(-24),9),slow=ema(r.slice(-55),21),mom=cur-p[n-13],shortMom=cur-p[n-5],vol=sd(r.slice(-35));
 const atr=atrFromCandles(14)||vol||Math.abs(cur)*.00001||1, unit=Math.max(vol,atr*.35,Math.abs(cur)*.000001);
 const trend=(fast-slow)/unit,momentum=mom/unit,accel=(shortMom-(p[n-5]-p[n-9]))/unit;
 const recent=S.candles.slice(-24),support=recent.length?Math.min(...recent.map(c=>c.low)):cur-atr,resistance=recent.length?Math.max(...recent.map(c=>c.high)):cur+atr;
 const ranges=recent.slice(-12).map(c=>c.high-c.low),recentRange=ranges.length?avg(ranges.slice(-4)):atr,olderRange=ranges.length>=8?avg(ranges.slice(0,-4)):atr;
 const compression=olderRange>0?recentRange/olderRange:1;
 const deltas=r.slice(1).map((v,i)=>v-r[i]),largest=Math.max(...deltas.map(Math.abs));
 const baseSpike=Math.min(96,Math.round(18+Math.max(0,largest/unit-1.4)*11+Math.min(24,Math.abs(accel)*7)+(compression<.72?14:0)));
 const normalScore=trend*.58+momentum*.30+accel*.12;let dir=normalScore>.28?'ALZA ↑':normalScore<-.28?'BAJA ↓':'NEUTRAL';let conf=Math.max(46,Math.min(93,Math.round(52+Math.abs(normalScore)*15)));
 // Spike direction looks for exhaustion/reversal as well as acceleration. This is an early warning, not certainty.
 const downTrend=trend<-.35,upTrend=trend>.35,upTurn=shortMom>0&&accel>.18,downTurn=shortMom<0&&accel<-.18;
 let spikeDir='NEUTRAL',spikeScore=baseSpike;
 if(downTrend&&(upTurn||compression<.72)){spikeDir='ALZA ↑';spikeScore=Math.min(96,baseSpike+10)}
 else if(upTrend&&(downTurn||compression<.72)){spikeDir='BAJA ↓';spikeScore=Math.min(96,baseSpike+10)}
 else if(accel>.55){spikeDir='ALZA ↑'} else if(accel<-.55){spikeDir='BAJA ↓'}
 const spikeSignal=spikeDir==='NEUTRAL'?`SIN PRE-ALERTA · ${spikeScore}%`:`${spikeScore>=72?'⚡ POSIBLE':'⚡ PRE-ALERTA'} ${spikeDir} · ${spikeScore}%`;
 let phase='⚠️ NO OPERAR',reason='Esperando una estructura con mayor confirmación.',preAlert=null,alert=null,entry=null,target=null,stop=null,hold='—';
 if(dir!=='NEUTRAL'){
   const up=dir.startsWith('ALZA'),projected=up?Math.max(support,cur-atr*.55):Math.min(resistance,cur+atr*.55);preAlert=projected;target=projected+(up?1:-1)*atr*1.8;stop=projected-(up?1:-1)*atr*.9;hold=`${Math.max(1,Math.min(4,Math.round(2.8-Math.abs(normalScore)*.3)))}–${Math.max(2,Math.min(6,Math.round(4.8-Math.abs(normalScore)*.22)))} velas`;
   if(conf>=56){phase='🟠 PRE-ALERTA';reason=`Movimiento ${up?'alcista':'bajista'} en preparación. Vigilar ${fmtPrice(projected)} antes de confirmar.`}
   if(conf>=64){phase='🟡 POSIBLE ENTRADA';alert=projected;reason=`Dirección normal ${up?'ALZA':'BAJA'}: vigilar ${fmtPrice(projected)}. Aún requiere confirmación.`}
   const near=Math.abs(cur-projected)<=atr*.72,aligned=(up&&fast>slow&&mom>0)||(!up&&fast<slow&&mom<0);
   if(conf>=73&&near&&aligned){phase='🟢 ENTRAR AHORA';entry=cur;target=cur+(up?1:-1)*atr*1.8;stop=cur-(up?1:-1)*atr*.9;reason=`Dirección normal confirmada. Vigilar ${hold}; salir antes si la estructura se invalida.`}
 }
 // Spike is shown independently. Only block a normal entry when spike points against it with high score.
 if(spikeDir!=='NEUTRAL'&&spikeScore>=58){const spUp=spikeDir.startsWith('ALZA');const spikeLevel=spUp?cur-atr*.25:cur+atr*.25;if(phase.includes('NO OPERAR')){phase=spikeScore>=72?'⚡ POSIBLE SPIKE':'⚡ PRE-ALERTA SPIKE';preAlert=spikeLevel;reason=`Compresión/aceleración detectada: vigilar posible spike ${spUp?'ALZA':'BAJA'} cerca de ${fmtPrice(spikeLevel)}.`}if(dir!=='NEUTRAL'&&spikeScore>=78&&dir.startsWith(spUp?'BAJA':'ALZA')){phase='⚠️ NO OPERAR';entry=null;reason=`Spike ${spUp?'ALZA':'BAJA'} de riesgo alto contradice la dirección normal. Esperar.`}}
 const prev=S.signal;S.signal={dir,conf,phase,preAlert,alert,entry,exit:target,stop,hold,spikeRisk:spikeScore,spikeSignal,spikeDir,price:cur,time:Date.now()};
 els.price.textContent=fmtPrice(cur);els.direction.textContent=dir;els.confidence.textContent=conf+'%';els.phase.textContent=phase;els.reason.textContent=reason;els.alert.textContent=fmtPrice(alert||preAlert);els.entry.textContent=fmtPrice(entry);els.exit.textContent=fmtPrice(target);els.spike.textContent=spikeScore+'%';els.ind.innerHTML=`Momentum: ${mom.toFixed(5)}<br>Aceleración: ${accel.toFixed(3)}<br>Compresión: ${(compression*100).toFixed(0)}%<br>Volatilidad: ${vol.toFixed(5)}<br>EMA rápida/lenta: ${fast.toFixed(5)} / ${slow.toFixed(5)}<br>Spike: ${spikeSignal}`;
 syncUI();signalUiV161(S.signal);
 const key=phase+'|'+dir+'|'+spikeSignal+'|'+fmtPrice(alert||preAlert);if(key!==S.lastLogged&&(phase.includes('PRE-ALERTA')||phase.includes('POSIBLE')||phase.includes('ENTRAR'))){S.lastLogged=key;logSignal();const vk=phase+'|'+dir+'|'+spikeDir;if(vk!==S.lastSignalVoice){S.lastSignalVoice=vk;if(phase.includes('SPIKE'))speak(`${phase.includes('POSIBLE')?'Posible':'Pre alerta'} spike ${spikeDir.startsWith('ALZA')?'al alza':'a la baja'}`);else if(phase.includes('ENTRAR'))speak(`Entrar ahora, ${dir.startsWith('ALZA')?'alza':'baja'}`);else speak(`${phase.includes('PRE-ALERTA')?'Pre alerta':'Posible entrada'} ${dir.startsWith('ALZA')?'al alza':'a la baja'}, vigilar ${fmtPrice(alert||preAlert)}`)}}
 // If a manual trade preceded RADAR confirmation, record the delay for calibration.
 if(S.demoPosition?.source==='MANUAL'&&phase.includes('ENTRAR')&&!S.demoPosition.radarConfirmedAt&&S.demoPosition.dir.startsWith(dir.startsWith('ALZA')?'ALZA':'BAJA')){S.demoPosition.radarConfirmedAt=Date.now();S.demoPosition.radarDelayMs=S.demoPosition.radarConfirmedAt-S.demoPosition.opened;renderDemoPosition()}
}
function chooseManualDirection(dir){S.manualDirection=dir;const up=$('manualUp'),dn=$('manualDown');up?.classList.toggle('selected',dir==='ALZA ↑');dn?.classList.toggle('selected',dir==='BAJA ↓');speak(`Dirección manual ${dir.startsWith('ALZA')?'alza':'baja'} seleccionada`)}
function openDemoPosition(){if(S.demoPosition){speak('Ya existe una posición demo activa.');return}const s=S.signal,cur=S.prices.at(-1);if(!Number.isFinite(cur)){speak('Aún no hay precio disponible.');return}let dir=S.manualDirection;if(!dir&&s?.phase?.includes('ENTRAR'))dir=s.dir;if(!dir){speak('Seleccione alza manual o baja manual.');return}const confirmed=!!(s?.phase?.includes('ENTRAR')&&s.dir===dir);const atr=atrFromCandles(14)||sd(S.prices.slice(-35))||Math.abs(cur)*.00001;S.demoPosition={id:'D'+Date.now().toString().slice(-6),symbol:S.symbol,dir,entry:cur,target:confirmed?s.exit:cur+(dir.startsWith('ALZA')?1:-1)*atr*1.8,stop:confirmed?s.stop:cur-(dir.startsWith('ALZA')?1:-1)*atr*.9,opened:Date.now(),source:confirmed?'RADAR':'MANUAL',radarPhaseAtEntry:s?.phase||'SIN SEÑAL'};renderDemoPosition();speak(confirmed?'Entrada demo confirmada registrada':'Entrada manual demo registrada sin confirmación del radar')}
function closeDemoPosition(){if(!S.demoPosition)return;const cur=S.prices.at(-1),d=S.demoPosition;const pnl=(cur-d.entry)*(d.dir.startsWith('ALZA')?1:-1);d.closed=Date.now();d.close=cur;d.pnl=pnl;S.manualComparisons.push({...d});S.demoPosition=null;renderDemoPosition();speak('Salida demo registrada')}
function renderDemoPosition(){const box=document.querySelector('.positions');if(!box)return;const d=S.demoPosition;if(!d){box.innerHTML='<span>ID</span><span>MERCADO</span><span>TIPO</span><span>ENTRADA</span><span>PRECIO ACTUAL</span><span>OBJETIVO</span><span>STOP LOSS</span><span>PROFIT</span><span>ESTADO</span>';document.querySelector('.bottom-tabs button.active').textContent='▣ POSICIONES (0)';return}const cur=S.prices.at(-1),pnl=(cur-d.entry)*(d.dir.startsWith('ALZA')?1:-1),delay=Number.isFinite(d.radarDelayMs)?` · RADAR +${(d.radarDelayMs/1000).toFixed(1)}s`:'';box.innerHTML=`<span>${d.id}</span><span>${S.symbol}</span><span>${d.dir}</span><span>${fmtPrice(d.entry)}</span><span>${fmtPrice(cur)}</span><span>${fmtPrice(d.target)}</span><span>${fmtPrice(d.stop)}</span><span>${pnl.toFixed(5)}</span><span class="active-demo">${d.source}${delay}</span>`;document.querySelector('.bottom-tabs button.active').textContent='▣ POSICIONES (1)'}
$('manualUp')?.addEventListener('click',()=>chooseManualDirection('ALZA ↑'));$('manualDown')?.addEventListener('click',()=>chooseManualDirection('BAJA ↓'));$('manualEnter')?.addEventListener('click',openDemoPosition);$('manualExit')?.addEventListener('click',closeDemoPosition);$('executionMode')?.addEventListener('change',()=>{setText('graphExecMode',$('executionMode').value.toUpperCase());if($('executionMode').value==='auto')speak('Modo automático de señales. La ejecución automática permanece bloqueada en esta versión.')});
setInterval(()=>{if(S.demoPosition)renderDemoPosition()},1000);

/* ==========================================================
   V1.6.2 · CICLO OPERATIVO + VISIBILIDAD + VOZ CON ARRANQUE
   ========================================================== */
S.bootReadyAt=0; S.tradeLines=[]; S.lastTradeResult=null; S.positionAdvice='SIN POSICIÓN';
const _speakV162=speak;
speak=function(t){ if(Date.now()<S.bootReadyAt && !String(t).toLowerCase().includes('conect')) return; _speakV162(t) }
function clearTradeLines(){if(!S.candleSeries)return;for(const l of S.tradeLines){try{S.candleSeries.removePriceLine(l)}catch{}}S.tradeLines=[]}
function addTradeLine(price,title,color){if(!S.candleSeries||!Number.isFinite(price))return;try{S.tradeLines.push(S.candleSeries.createPriceLine({price,color,lineWidth:3,lineStyle:0,axisLabelVisible:true,title}))}catch{}}
function drawTradePosition(){clearTradeLines();const d=S.demoPosition;if(!d)return;addTradeLine(d.entry,d.dir.startsWith('ALZA')?'BUY / ENTRADA':'SELL / ENTRADA','#16c784');addTradeLine(d.target,'PROFIT / OBJETIVO','#36a2ff');addTradeLine(d.stop,'STOP LOSS','#ff5a67')}
const _connectV162=connect;
connect=function(){S.bootReadyAt=Date.now()+6500;S.lastSignalVoice='';_connectV162();setTimeout(()=>{if(S.voice)_speakV162('Radar listo. Iniciando vigilancia del mercado.')},5600)};
els.connect.onclick=connect;
const _drawSignalLevelsV162=drawSignalLevels;
drawSignalLevels=function(s){_drawSignalLevelsV162(s);drawTradePosition()}
const _openDemoV162=openDemoPosition;
openDemoPosition=function(){_openDemoV162();if(S.demoPosition){drawTradePosition();const o=$('signalOverlay');if(o)o.textContent=`OPERACIÓN ${S.demoPosition.dir.startsWith('ALZA')?'BUY / ALZA':'SELL / BAJA'} · ${fmtPrice(S.demoPosition.entry)}`}};
const _closeDemoV162=closeDemoPosition;
closeDemoPosition=function(reason='MANUAL'){if(!S.demoPosition)return;const d=S.demoPosition,cur=S.prices.at(-1);const pnl=(cur-d.entry)*(d.dir.startsWith('ALZA')?1:-1);S.lastTradeResult={...d,close:cur,pnl,reason,closed:Date.now()};_closeDemoV162();clearTradeLines();const won=pnl>0;const o=$('signalOverlay');if(o){o.className='signal-overlay '+(won?'entry':'exit');o.textContent=`${won?'GANADA / PROFIT':'PERDIDA'} · ${pnl>=0?'+':''}${pnl.toFixed(5)} · ${reason}`}_speakV162(won?'Operación cerrada en profit':'Operación cerrada en pérdida')};
$('manualEnter').onclick=openDemoPosition;$('manualExit').onclick=()=>closeDemoPosition('SALIDA MANUAL');
function monitorOpenPosition(){const d=S.demoPosition;if(!d)return;const cur=S.prices.at(-1);if(!Number.isFinite(cur))return;const up=d.dir.startsWith('ALZA'),pnl=(cur-d.entry)*(up?1:-1),distTarget=Math.abs(d.target-d.entry)||1,progress=pnl/distTarget;let advice='MANTENER';if((up&&cur<=d.stop)||(!up&&cur>=d.stop))advice='🔴 SALIR AHORA · STOP';else if((up&&cur>=d.target)||(!up&&cur<=d.target))advice='🟢 PROFIT / OBJETIVO';else if(progress>=.72)advice='🟠 PREPARAR SALIDA';else if(S.signal&&S.signal.dir!=='NEUTRAL'&&S.signal.dir!==d.dir&&S.signal.conf>=72)advice='🔴 SALIR AHORA · SEÑAL INVALIDADA';if(advice!==S.positionAdvice){S.positionAdvice=advice;const o=$('signalOverlay');if(o){o.className='signal-overlay '+(advice.includes('SALIR')?'exit':'entry');o.textContent=advice+' · P/L '+(pnl>=0?'+':'')+pnl.toFixed(5)}if(advice.includes('SALIR'))_speakV162('Salir ahora. La operación perdió confirmación.');else if(advice.includes('PREPARAR'))_speakV162('Preparar salida.');else if(advice.includes('PROFIT'))_speakV162('Objetivo alcanzado. Profit.')}if(advice.includes('STOP'))closeDemoPosition('STOP LOSS');else if(advice.includes('PROFIT'))closeDemoPosition('PROFIT')}
setInterval(monitorOpenPosition,700);
// Zoom táctil más evidente: botones cambian el espaciado de barras, además del rango.
$('zoomIn').onclick=()=>{if(!S.chart)return;const ts=S.chart.timeScale();const opt=ts.options?.()||{};const b=Math.min(30,(opt.barSpacing||10)*1.35);ts.applyOptions({barSpacing:b,rightOffset:4})};
$('zoomOut').onclick=()=>{if(!S.chart)return;const ts=S.chart.timeScale();const opt=ts.options?.()||{};const b=Math.max(3,(opt.barSpacing||10)/1.35);ts.applyOptions({barSpacing:b,rightOffset:6})};
$('resetChart').onclick=()=>{if(!S.chart)return;S.chart.timeScale().applyOptions({barSpacing:10,rightOffset:5});showRecentCandles(70)};

/* ==========================================================
   V1.6.3 · MAPA VISUAL DE OPERACIÓN
   ALERTA -> ENTRADA -> REBOTE -> SALIDA
   ========================================================== */
S.visualMarkers=[];S.lastVisualSignalKey='';S.activeVisualAlert=null;S.lastReboundKey='';
function markerNow(){return S.candles.at(-1)?.time||Math.floor(Date.now()/1000)}
function markerTTL(){return Math.max(45000,Math.min(180000,(S.timeframe||60)*1000*3))}
function markerKind(dir,kind){if(kind==='alert'||kind==='rebound')return kind;if(kind==='exit')return 'exit';return String(dir||'').startsWith('ALZA')?'buy':'sell'}
function addVisualMarker({kind='alert',dir='NEUTRAL',price,time,label,persistent=false,expiresAt=null}){
 if(!Number.isFinite(price))return null;const m={id:'M'+Date.now()+Math.random().toString(16).slice(2,6),kind:markerKind(dir,kind),dir,price,time:time||markerNow(),label,persistent,createdAt:Date.now(),expiresAt:expiresAt??(persistent?null:Date.now()+markerTTL()),cancelled:false};S.visualMarkers.push(m);if(S.visualMarkers.length>40)S.visualMarkers.splice(0,S.visualMarkers.length-40);renderVisualMarkers();return m
}
function clearVisualMarkers(all=false){S.visualMarkers=S.visualMarkers.filter(m=>!all&&m.persistent);if(all)S.activeVisualAlert=null;renderVisualMarkers()}
function renderVisualMarkers(){const layer=$('visualMarkerLayer');if(!layer||!S.chart||!S.candleSeries)return;const now=Date.now();for(const m of S.visualMarkers){if(!m.persistent&&m.expiresAt&&now>m.expiresAt&&!m.cancelled)m.cancelled=true}S.visualMarkers=S.visualMarkers.filter(m=>m.persistent||!m.cancelled||now-(m.expiresAt||now)<18000);layer.innerHTML='';for(const m of S.visualMarkers){const x=S.chart.timeScale().timeToCoordinate(m.time);const y=S.candleSeries.priceToCoordinate(m.price);if(x==null||y==null||!Number.isFinite(x)||!Number.isFinite(y))continue;const e=document.createElement('div');e.className='vm '+m.kind+(m.cancelled?' cancelled':'');e.style.left=x+'px';e.style.top=y+'px';const up=String(m.dir).startsWith('ALZA');const arrow=m.kind==='exit'?'◆':(up?'↑':'↓');e.innerHTML=`<span class="vm-arrow">${arrow}</span><span class="vm-label">${m.label}</span>`;layer.appendChild(e)}}
setInterval(renderVisualMarkers,350);window.addEventListener('resize',renderVisualMarkers);
const _signalUiV163=signalUiV161;
signalUiV161=function(s){_signalUiV163(s);clearSignalLines();drawTradePosition();if(!s)return;const p=s.alert||s.preAlert;const dir=s.spikeDir&&s.spikeDir!=='NEUTRAL'&&s.phase.includes('SPIKE')?s.spikeDir:s.dir;const phase=s.phase||'';if((phase.includes('PRE-ALERTA')||phase.includes('POSIBLE'))&&Number.isFinite(p)){
 const key=`A|${dir}|${fmtPrice(p)}|${Math.floor(Date.now()/Math.max(15000,markerTTL()/3))}`;if(key!==S.lastVisualSignalKey){if(S.activeVisualAlert&&!S.activeVisualAlert.persistent)S.activeVisualAlert.cancelled=true;S.lastVisualSignalKey=key;S.activeVisualAlert=addVisualMarker({kind:'alert',dir,price:p,label:`ALERTA ${String(dir).startsWith('ALZA')?'ALZA':'BAJA'} · ${fmtPrice(p)}`})}}
 if(phase.includes('ENTRAR')&&Number.isFinite(s.entry)){const key=`E|${dir}|${fmtPrice(s.entry)}`;if(key!==S.lastVisualSignalKey){if(S.activeVisualAlert)S.activeVisualAlert.cancelled=true;S.lastVisualSignalKey=key;addVisualMarker({kind:'entry',dir,price:s.entry,label:`${String(dir).startsWith('ALZA')?'BUY / ALZA':'SELL / BAJA'} · ${fmtPrice(s.entry)}`,persistent:true});S.activeVisualAlert=null}}
 renderVisualMarkers();
}
const _openDemoV163=openDemoPosition;
openDemoPosition=function(){const had=!!S.demoPosition;_openDemoV163();if(!had&&S.demoPosition)addVisualMarker({kind:'entry',dir:S.demoPosition.dir,price:S.demoPosition.entry,label:`MANUAL ${S.demoPosition.dir.startsWith('ALZA')?'BUY':'SELL'} · ${fmtPrice(S.demoPosition.entry)}`,persistent:true})};$('manualEnter').onclick=openDemoPosition;
const _closeDemoV163=closeDemoPosition;
closeDemoPosition=function(reason='MANUAL'){const d=S.demoPosition?{...S.demoPosition}:null;const cur=S.prices.at(-1);_closeDemoV163(reason);if(d&&Number.isFinite(cur))addVisualMarker({kind:'exit',dir:d.dir,price:cur,label:`SALIDA · ${fmtPrice(cur)} · ${reason}`,persistent:true})};$('manualExit').onclick=()=>closeDemoPosition('SALIDA MANUAL');
const _monitorV163=monitorOpenPosition;
monitorOpenPosition=function(){const d=S.demoPosition;if(d&&S.signal&&S.signal.dir!=='NEUTRAL'&&S.signal.dir!==d.dir&&S.signal.conf>=62&&S.signal.conf<72){const cur=S.prices.at(-1);const key=`R|${d.id}|${S.signal.dir}|${Math.floor(Date.now()/30000)}`;if(key!==S.lastReboundKey&&Number.isFinite(cur)){S.lastReboundKey=key;addVisualMarker({kind:'rebound',dir:S.signal.dir,price:cur,label:`POSIBLE REBOTE ${S.signal.dir.startsWith('ALZA')?'ALZA':'BAJA'} · ${fmtPrice(cur)}`})}}_monitorV163()}

// Paneles: el botón ahora sí expande/reduce el mapa de velas.
$('togglePanel').onclick=()=>{document.body.classList.toggle('chart-focus');$('togglePanel').textContent=document.body.classList.contains('chart-focus')?'☰ MOSTRAR PANELES':'☰ PANELES';setTimeout(()=>{S.chart?.resize?.();renderVisualMarkers()},120)};
$('clearMarks').onclick=()=>clearVisualMarkers(true);

// Pantalla completa para reducir al máximo la barra del navegador cuando el dispositivo lo permita.
async function toggleFullscreen(){try{if(!document.fullscreenElement){await (document.documentElement.requestFullscreen?.()||document.documentElement.webkitRequestFullscreen?.());$('fullscreenBtn')?.classList.add('full')}else{await (document.exitFullscreen?.()||document.webkitExitFullscreen?.());$('fullscreenBtn')?.classList.remove('full')}}catch(e){const o=$('signalOverlay');if(o){o.className='signal-overlay wait';o.textContent='El navegador no permitió pantalla completa. Puede instalar RADAR como app/PWA.'}}}
$('fullscreenBtn').onclick=toggleFullscreen;document.addEventListener('fullscreenchange',()=>$('fullscreenBtn')?.classList.toggle('full',!!document.fullscreenElement));

// Cola de voz: evita cortar el mensaje de arranque con una alerta inmediata.
S.voiceQueue=[];S.voiceSpeaking=false;S.lastVoiceAt=0;
function pumpVoice(){if(S.voiceSpeaking||!S.voiceQueue.length||!S.voice||!('speechSynthesis'in window))return;if(Date.now()<S.bootReadyAt){setTimeout(pumpVoice,700);return}const item=S.voiceQueue.shift();const u=new SpeechSynthesisUtterance(item.text);u.lang='es-SV';u.rate=.95;S.voiceSpeaking=true;u.onend=u.onerror=()=>{S.voiceSpeaking=false;S.lastVoiceAt=Date.now();setTimeout(pumpVoice,220)};speechSynthesis.speak(u)}
speak=function(t){if(!S.voice)return;const text=String(t||'').trim();if(!text)return;if(S.voiceQueue.some(x=>x.text===text))return;S.voiceQueue.push({text});if(S.voiceQueue.length>5)S.voiceQueue=S.voiceQueue.slice(-5);pumpVoice()}

// Redibuja marcas al mover/zoom del gráfico.
setTimeout(()=>{try{S.chart?.timeScale().subscribeVisibleLogicalRangeChange(renderVisualMarkers)}catch{}},800);
