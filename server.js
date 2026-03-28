const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

let cache = { futuras: [], pasadas: [], ultimaActualizacion: 0 };
const TIEMPO_CACHE = 5 * 60 * 1000; // 5 minutos

app.get('/api/misiones', async (req, res) => {
    const ahora = Date.now();

    if (ahora - cache.ultimaActualizacion > TIEMPO_CACHE) {
        console.log("Descargando datos frescos...");
        try {
            const urlSDFuturas = 'https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=30';
            const urlSDPasadas = 'https://ll.thespacedevs.com/2.2.0/launch/previous/?limit=30';
            const urlSpaceX = 'https://api.spacexdata.com/v4/launches/upcoming';

            const [resSDFuturas, resSDPasadas, resSpaceX] = await Promise.all([
                fetch(urlSDFuturas), fetch(urlSDPasadas), fetch(urlSpaceX)
            ]);

            const datosSDFuturas = await resSDFuturas.json();
            const datosSDPasadas = await resSDPasadas.json();
            const datosSpaceX = await resSpaceX.json();

            const futurasSinSpaceX = datosSDFuturas.results.filter(m => !(m.launch_service_provider?.name || "").toLowerCase().includes("spacex"));
            
            const futurasSpaceXTraducidas = datosSpaceX.map(sx => ({
                name: "SpaceX | " + sx.name,
                net: sx.date_utc,
                launch_service_provider: { name: "SpaceX" },
                rocket: { configuration: { name: "Falcon / Starship" } },
                pad: { location: { name: "Plataforma Oficial de SpaceX" } },
                mission: { type: "Comercial / Starlink", description: sx.details },
                vid_urls: sx.links.webcast ? [{ url: sx.links.webcast }] : [],
                webcast_live: false,
                image: sx.links.patch.large || 'https://images.unsplash.com/photo-1541185933-ef5d8ed016c2?q=80&w=1000&auto=format&fit=crop',
                is_verified: true
            }));

            cache.futuras = [...futurasSinSpaceX, ...futurasSpaceXTraducidas].sort((a, b) => new Date(a.net) - new Date(b.net));
            cache.pasadas = datosSDPasadas.results;
            cache.ultimaActualizacion = ahora;

        } catch (error) {
            console.error("Error actualizando la base de datos:", error);
        }
    }

    res.json({ futuras: cache.futuras, pasadas: cache.pasadas });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor activado en puerto ${PORT}`);
});
