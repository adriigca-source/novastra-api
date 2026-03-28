const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

let cache = { futuras: [], pasadas: [], ultimaActualizacion: 0 };
const TIEMPO_CACHE = 5 * 60 * 1000; // 5 minutos

app.get('/api/misiones', async (req, res) => {
    const ahora = Date.now();

    if (ahora - cache.ultimaActualizacion > TIEMPO_CACHE) {
        console.log("Descargando datos frescos de The Space Devs (Producción)...");
        try {
            // Usamos SOLO la API de Producción oficial (la buena)
            const urlSDFuturas = 'https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=30';
            const urlSDPasadas = 'https://ll.thespacedevs.com/2.2.0/launch/previous/?limit=30';

            const [resSDFuturas, resSDPasadas] = await Promise.all([
                fetch(urlSDFuturas), fetch(urlSDPasadas)
            ]);

            const datosSDFuturas = await resSDFuturas.json();
            const datosSDPasadas = await resSDPasadas.json();

            // Guardamos los datos reales y actualizados
            cache.futuras = datosSDFuturas.results;
            cache.pasadas = datosSDPasadas.results;
            cache.ultimaActualizacion = ahora;

        } catch (error) {
            console.error("Error actualizando la base de datos:", error);
        }
    }

    res.json({ futuras: cache.futuras, pasadas: cache.pasadas });
});

// --- NUEVA PUERTA TRASERA LIGERA PARA EL VIGILANTE (CRON-JOB) ---
app.get('/ping', (req, res) => {
    res.send('El servidor de Novastra está despierto y operativo.');
});
// ----------------------------------------------------------------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor activado en puerto ${PORT}`);
});
