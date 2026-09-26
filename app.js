// ==========================================
// RADAR SINTÉTICO MR V2.0 - MOTOR ESPACIO-TIEMPO
// Integración de Eje Vertical (Precio) y Eje Horizontal (Tiempo)
// ==========================================

console.log("Radar Sintético V2.0 Inicializado: Motor Espacio-Tiempo Activo");

/**
 * Motor Espacio-Temporal: Cruza el eje vertical (precio) y horizontal (tiempo)
 * para optimizar las señales del Radar Sintético y evitar falsos spikes.
 * @param {Array} velas - Arreglo con los datos históricos o en tiempo real de tu app.
 * @param {Number} periodos - Bloques de tiempo de referencia (por defecto 5 velas).
 */
function procesarMotorEspacioTiempo(velas, periodos = 5) {
    let senalesOptimizadas = [];

    // Verificamos que existan suficientes datos para calcular
    if (!velas || velas.length < periodos) {
        console.warn("Datos insuficientes para el análisis espacio-temporal.");
        return senalesOptimizadas;
    }

    for (let i = periodos; i < velas.length; i++) {
        // 1. Eje Vertical: Magnitud del cambio de precio (Delta Precio)
        let deltaPrecio = velas[i].close - velas[i - periodos].close;

        // 2. Eje Horizontal: Bloques de tiempo transcurridos (Delta Tiempo)
        let deltaTiempo = periodos;

        // 3. Cálculo de la Velocidad del Mercado (Espacio / Tiempo)
        let velocidadMercado = deltaPrecio / deltaTiempo;

        let estadoRadar = "Monitoreando";
        let umbralSpike = 0.08; // Umbral de velocidad ajustable según la volatilidad del activo

        // --- LÓGICA DE VALIDACIÓN CRUZADA DE LOS DOS EJES ---
        if (velocidadMercado > umbralSpike) {
            estadoRadar = "Spike Alcista - Alerta de Agotamiento / Venta";
        } else if (velocidadMercado < -umbralSpike) {
            estadoRadar = "Spike Bajista - Alerta de Agotamiento / Compra";
        } else if (Math.abs(velocidadMercado) < 0.01) {
            estadoRadar = "Compresión Horizontal - Preparando Rango";
        }

        // Empaquetamos el resultado para que tu interfaz web lo lea y dibuje
        senalesOptimizadas.push({
            tiempo: velas[i].time || i,
            precioActual: velas[i].close,
            velocidad: velocidadMercado.toFixed(4),
            estado: estadoRadar
        });
    }

    return senalesOptimizadas;
}

/**
 * Función puente para conectar el motor con tu interfaz web (index.html)
 * @param {Array} datosMercado - Datos de velas que recibe tu aplicación
 */
ha
function actualizarRadarVisual(datosMercado) {
    const resultados = procesarMotorEspacioTiempo(datosMercado);
    
    if (resultados.length > 0) {
        const ultimaSenal = resultados[resultados.length - 1];
        console.log("Última señal analizada:", ultimaSenal);

        // Si en tu index.html tienes un elemento con id 'panel-senales', lo actualiza automáticamente
        const panelUI = document.getElementById('panel-senales');
        if (panelUI) {
            panelUI.innerHTML = `
                Precio: <b>${ultimaSenal.precioActual}</b> | 
                Velocidad: <b>${ultimaSenal.velocidad}</b> | 
                Estado: <span style="color: #38bdf8;">${ultimaSenal.estado}</span>
            `;
        }
    }
}
