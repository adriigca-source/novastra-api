const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

// Memoria temporal para no saturar la API externa
let cache = { futuras: [], pasadas: [], ultimaActualizacion: 0 };
const TIEMPO_CACHE = 5 * 60 * 1000; // 5 minutos

app.get('/api/misiones', async (req, res) => {
    const ahora = Date.now();

    // Solo pedimos datos nuevos si han pasado más de 5 minutos
    if (ahora - cache.ultimaActualizacion > TIEMPO_CACHE) {
        console.log("Sincronizando con The Space Devs...");
        try {
            const [resFuturas, resSDPasadas] = await Promise.all([
                fetch('https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=20'),
                fetch('https://ll.thespacedevs.com/2.2.0/launch/previous/?limit=20')
            ]);

            const datosF = await resFuturas.json();
            const datosP = await resSDPasadas.json();

            cache = { 
                futuras: datosF.results || [], 
                pasadas: datosP.results || [], 
                ultimaActualizacion: ahora 
            };
        } catch (error) {
            console.error("Error en la conexión con la API:", error);
        }
    }

    res.json({ futuras: cache.futuras, pasadas: cache.pasadas });
});

// Puerta trasera para el robot de cron-job.org
app.get('/ping', (req, res) => {
    res.send('Novastra OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor Novastra activo en puerto ${PORT}`);
});
