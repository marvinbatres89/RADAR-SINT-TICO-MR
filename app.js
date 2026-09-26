/**
 * RADAR SINTÉTICO MR V1.9.0 - MOTOR ESPACIO-TIEMPO + SPIKE
 */
const DERIV_WS_URL = 'wss://ws.derivws.com/websockets/v3?app_id=1089';

const MARKETS = [
  { symbol: 'BOOM1000', name: 'Boom 1000 Index', type: 'BOOM' },
  { symbol: 'BOOM500', name: 'Boom 500 Index', type: 'BOOM' },
  { symbol: 'BOOM300', name: 'Boom 300 Index', type: 'BOOM' },
  { symbol: 'CRASH1000', name: 'Crash 1000 Index', type: 'CRASH' },
  { symbol: 'CRASH500', name: 'Crash 500 Index', type: 'CRASH' },
  { symbol: 'CRASH300', name: 'Crash 300 Index', type: 'CRASH' },
  { symbol: 'R_75', name: 'Volatility 75 Index', type: 'VOL' },
  { symbol: 'R_100', name: 'Volatility 100 Index', type: 'VOL' }
];

let ws = null;
let currentSymbol = 'BOOM1000';
let activeView = 'radar';
let voiceEnabled = true;
let spikeEngineEnabled = true;
let bgModeEnabled = false;
let executionMode = 'manual';

let tickCount = 0;
let lastPrice = 0;
let ticksSinceLastSpike = 0;
let priceHistory = [];
let chartInstance = null;
let candleSeries = null;
let activePosition = null;
let stats = JSON.parse(localStorage.getItem('radar_stats') || '{"wins":0,"losses":0,"pnl":0}');
let historyLog = JSON.parse(localStorage.getItem('radar_history') || '[]');

// DOM Elements Initialization
document.addEventListener('DOMContentLoaded', () => {
  initUI();
  initChart();
  renderStats();
  renderHistory();
});

function initUI() {
  // Populate symbol selects
  const symSelects = [document.getElementById('symbol'), document.getElementById('graphSymbol')];
  symSelects.forEach(sel => {
    if (!sel) return;
    sel.innerHTML = '';
    MARKETS.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.symbol;
      opt.textContent = m.name;
      if (m.symbol === currentSymbol) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', (e) => {
      currentSymbol = e.target.value;
      symSelects.forEach(s => s.value = currentSymbol);
      document.getElementById('graphMarketName').textContent = MARKETS.find(m => m.symbol === currentSymbol)?.name || currentSymbol;
      subscribeSymbol(currentSymbol);
    });
  });

  // Navigation
  document.querySelectorAll('nav .nav').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('nav .nav').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      const view = e.target.dataset.view;
      e.target.classList.add('active');
      document.getElementById(view + 'View').classList.add('active');
      activeView = view;
      if (view === 'graph' && chartInstance) chartInstance.timeScale().fitContent();
    });
  });

  document.getElementById('openGraph').addEventListener('click', () => {
    document.querySelector('[data-view="graph"]').click();
  });
  document.getElementById('backRadar').addEventListener('click', () => {
    document.querySelector('[data-view="radar"]').click();
  });

  // Action Buttons
  document.getElementById('connect').addEventListener('click', toggleConnection);
  document.getElementById('voice').addEventListener('click', (e) => {
    voiceEnabled = !voiceEnabled;
    e.target.textContent = voiceEnabled ? '🔊 Voz: ON' : '🔇 Voz: OFF';
  });
  document.getElementById('spikeToggle').addEventListener('click', (e) => {
    spikeEngineEnabled = !spikeEngineEnabled;
    e.target.textContent = spikeEngineEnabled ? '⚡ Motor spike: ON' : '⚡ Motor spike: OFF';
  });
  document.getElementById('bgToggle').addEventListener('click', (e) => {
    bgModeEnabled = !bgModeEnabled;
    e.target.textContent = bgModeEnabled ? '🌙 Segundo plano: ON' : '🌙 Segundo plano: OFF';
    showToast(bgModeEnabled ? 'Modo segundo plano activado' : 'Modo segundo plano desactivado');
  });
  document.getElementById('statsReset').addEventListener('click', () => {
    stats = { wins: 0, losses: 0, pnl: 0 };
    localStorage.removeItem('radar_stats');
    renderStats();
    showToast('Estadísticas reiniciadas');
  });

  document.getElementById('manualUp').addEventListener('click', () => executeTrade('BUY'));
  document.getElementById('manualDown').addEventListener('click', () => executeTrade('SELL'));
  document.getElementById('manualExit').addEventListener('click', closeTrade);

  // Drawer toggle
  document.getElementById('toggleDrawer').addEventListener('click', () => {
    document.getElementById('controlDrawer').style.display = 'flex';
  });
  document.getElementById('closeDrawer').addEventListener('click', () => {
    document.getElementById('controlDrawer').style.display = 'none';
  });
}

function initChart() {
  const container = document.getElementById('lwChart');
  if (!container || typeof LightweightCharts === 'undefined') return;

  chartInstance = LightweightCharts.createChart(container, {
    layout: { background: { type: 'solid', color: '#0f1c2e' }, textColor: '#e2e8f0' },
    grid: { vertLines: { color: '#1e334d' }, horzLines: { color: '#1e334d' } },
    timeScale: { timeVisible: true, secondsVisible: true }
  });

  candleSeries = chartInstance.addCandlestickSeries({
    upColor: '#10b981', downColor: '#ef4444', borderUpColor: '#10b981', borderDownColor: '#ef4444', wickUpColor: '#10b981', wickDownColor: '#ef4444'
  });

  window.addEventListener('resize', () => {
    if (chartInstance && container) chartInstance.resize(container.clientWidth, container.clientHeight);
  });
}

function toggleConnection() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close();
    document.getElementById('conn').className = 'pill off';
    document.getElementById('conn').textContent = '● DESCONECTADO';
    document.getElementById('connect').textContent = '⏻ Encender RADAR';
    showToast('RADAR apagado');
  } else {
    connectDeriv();
  }
}

function connectDeriv() {
  document.getElementById('conn').textContent = '● CONECTANDO...';
  ws = new WebSocket(DERIV_WS_URL);

  ws.onopen = () => {
    document.getElementById('conn.className') = 'pill on';
    document.getElementById('conn').textContent = '● CONECTADO';
    document.getElementById('connect').textContent = '⏻ Apagar RADAR';
    document.getElementById('scanCount').textContent = '8 MERCADOS VIGILADOS';
    showToast('Conectado a Deriv exitosamente');
    subscribeSymbol(currentSymbol);
    startMultiMarketScan();
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleDerivMessage(data);
  };

  ws.onerror = () => {
    showToast('Error de conexión con Deriv');
    document.getElementById('conn').className = 'pill off';
    document.getElementById('conn').textContent = '● ERROR';
  };

  ws.onclose = () => {
    document.getElementById('conn').className = 'pill off';
    document.getElementById('conn').textContent = '● DESCONECTADO';
  };
}

function subscribeSymbol(sym) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ ticks: sym }));
  ws.send(JSON.stringify({ ticks_history: sym, count: 100, end: 'latest', style: 'candles', granularity: 60 }));
}

function startMultiMarketScan() {
  const scanList = document.getElementById('scanList');
  scanList.innerHTML = '';
  MARKETS.forEach(m => {
    const div = document.createElement('div');
    div.className = 'scan-item';
    div.innerHTML = `<b>${m.name}</b><br><small>Analizando Espacio-Tiempo...</small>`;
    div.onclick = () => {
      currentSymbol = m.symbol;
      document.getElementById('symbol').value = currentSymbol;
      document.getElementById('graphSymbol').value = currentSymbol;
      document.getElementById('graphMarketName').textContent = m.name;
      subscribeSymbol(currentSymbol);
    };
    scanList.appendChild(div);
  });
}

function handleDerivMessage(data) {
  if (data.msg_type === 'tick') {
    const tick = data.tick;
    if (tick.symbol !== currentSymbol) return;

    tickCount++;
    const price = tick.quote;
    const diff = price - lastPrice;
    lastPrice = price;

    // Detect spike (sudden large price jump characteristic of Boom/Crash)
    const isSpike = Math.abs(diff) > 1.5;
    if (isSpike) {
      ticksSinceLastSpike = 0;
      speak('¡Atención, spike detectado!');
    } else {
      ticksSinceLastSpike++;
    }

    updateLiveUI(price, diff, isSpike);
  } else if (data.msg_type === 'candles') {
    if (candleSeries && data.candles) {
      const formatted = data.candles.map(c => ({
        time: c.epoch,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close
      }));
      candleSeries.setData(formatted);
      document.getElementById('chartBadge').textContent = 'Datos OHLC cargados';
    }
  }
}

function updateLiveUI(price, diff, isSpike) {
  document.getElementById('price').textContent = price.toFixed(2);
  document.getElementById('graphPrice').textContent = price.toFixed(2);
  document.getElementById('ticks').textContent = tickCount;
  document.getElementById('ticksSinceSpike').textContent = ticksSinceLastSpike;

  const dir = diff > 0 ? 'ALZA (↑)' : diff < 0 ? 'BAJA (↓)' : 'NEUTRAL';
  document.getElementById('direction').textContent = dir;
  document.getElementById('graphDir').textContent = dir;

  // Space-Time Motor calculation
  const speedScore = Math.min(100, Math.round((ticksSinceLastSpike / 20) * 100));
  document.getElementById('normalEngine').textContent = `Magnitud: ${Math.abs(diff).toFixed(2)}`;
  document.getElementById('spikeEngine').textContent = `Velocidad T/S: ${ticksSinceLastSpike} ticks`;
  document.getElementById('spikeRisk').textContent = `${speedScore}%`;
  document.getElementById('graphSpike').textContent = `${speedScore}%`;

  if (isSpike) {
    document.getElementById('timingState').textContent = '⚡ SPIKE EN CURSO - ZONA ACTIVA';
    document.getElementById('timingState').className = 'timing';
  } else {
    document.getElementById('timingState').textContent = `⏳ Esperando compresión (Ticks: ${ticksSinceLastSpike})`;
    document.getElementById('timingState').className = 'timing waiting';
  }
}

function executeTrade(type) {
  activePosition = { type, entry: lastPrice, lot: parseFloat(document.getElementById('lotSize').value) || 0.20 };
  document.getElementById('positionState').textContent = `ACTIVA: ${type} @ ${lastPrice.toFixed(2)}`;
  document.getElementById('positionCard').textContent = `${type} Lote: ${activePosition.lot} | Entrada: ${lastPrice.toFixed(2)}`;
  showToast(`Orden ${type} ejecutada con éxito`);
  speak(`Posición ${type} abierta`);
}

function closeTrade() {
  if (!activePosition) {
    showToast('No hay posición activa');
    return;
  }
  const pnl = (lastPrice - activePosition.entry) * (activePosition.type === 'BUY' ? 1 : -1) * activePosition.lot * 10;
  stats.pnl += pnl;
  if (pnl >= 0) stats.wins++; else stats.losses++;
  localStorage.setItem('radar_stats', JSON.stringify(stats));

  historyLog.unshift({ time: new Date().toLocaleTimeString(), symbol: currentSymbol, type: activePosition.type, pnl: pnl.toFixed(2) });
  localStorage.setItem('radar_history', JSON.stringify(historyLog));

  activePosition = null;
  document.getElementById('positionState').textContent = 'SIN POSICIÓN';
  document.getElementById('positionCard').textContent = 'Sin operación activa.';
  renderStats();
  renderHistory();
  showToast(`Posición cerrada. PnL: ${pnl.toFixed(2)}`);
  speak('Posición cerrada');
}

function renderStats() {
  const total = stats.wins + stats.losses;
  const wr = total > 0 ? Math.round((stats.wins / total) * 100) : 0;
  document.getElementById('statsBody').innerHTML = `Operaciones: ${total} | Victorias: ${stats.wins} (${wr}%) | PnL Total: $${stats.pnl.toFixed(2)}`;
}

function renderHistory() {
  const tbody = document.getElementById('history');
  if (!tbody) return;
  tbody.innerHTML = '';
  historyLog.slice(0, 20).forEach(h => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${h.time}</td><td>${h.symbol}</td><td style="color:${h.type==='BUY'?'#10b981':'#ef4444'}">${h.type}</td><td>Cierre</td><td>—</td><td>100%</td><td>PnL: $${h.pnl}</td>`;
    tbody.appendChild(tr);
  });
}

function speak(text) {
  if (!voiceEnabled || !('speechSynthesis' in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'es-ES';
  window.speechSynthesis.speak(utterance);
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.hidden = false;
  setTimeout(() => toast.hidden = true, 3000);
}
