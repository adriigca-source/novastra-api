const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());

// Tu Llave Maestra (Ya configurada con tu usuario y contraseña)
const uri = "mongodb+srv://adriigca_db_user:PvRoATvGjkYiEiaB@cluster0.psometw.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const client = new MongoClient(uri);

// 1. RUTA SECRETA PARA SINCRONIZAR (Descarga y guarda)
app.get('/api/sync', async (req, res) => {
    try {
        console.log("Conectando a MongoDB...");
        await client.connect();
        const db = client.db("novastra_db");
        const collection = db.collection('lanzamientos');

        console.log("Descargando datos de la NASA...");
        const resFuturas = await fetch('https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=100');
        const dataFuturas = await resFuturas.json();

        const resPasadas = await fetch('https://ll.thespacedevs.com/2.2.0/launch/previous/?limit=100');
        const dataPasadas = await resPasadas.json();

        // Borramos lo viejo y guardamos lo nuevo
        await collection.deleteMany({});
        await collection.insertOne({
            id_guardado: "historial_maestro",
            futuras: dataFuturas.results || [],
            pasadas: dataPasadas.results || [],
            fecha_actualizacion: new Date()
        });

        res.json({ 
            mensaje: "✅ Base de datos MongoDB actualizada con éxito", 
            futuras_guardadas: dataFuturas.results?.length || 0,
            pasadas_guardadas: dataPasadas.results?.length || 0
        });
    } catch (error) {
        console.error("Error:", error);
        res.status(500).json({ error: "Fallo en la conexión. Detalle: " + error.message });
    }
});

// 2. RUTA PARA TU WEB (Lee rápido de tu Mongo)
app.get('/api/misiones', async (req, res) => {
    try {
        await client.connect();
        const db = client.db("novastra_db");
        const collection = db.collection('lanzamientos');
        
        const datos = await collection.findOne({ id_guardado: "historial_maestro" });

        if (datos) {
            res.json({ futuras: datos.futuras, pasadas: datos.pasadas });
        } else {
            res.json({ futuras: [], pasadas: [] });
        }
    } catch (error) {
        res.status(500).json({ error: "Error leyendo de Mongo: " + error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor activo en puerto ${PORT}`);
});
