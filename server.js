const express = require('express');
const cors = require('cors');
const { MongoClient } = require('mongodb');

const app = express();
app.use(cors());

// TU LLAVE MAESTRA DE MONGODB (Con tu contraseña integrada)
const uri = "mongodb+srv://adriigca_db_user:PvRoATvGjkYiEiaB@cluster0.psometw.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const client = new MongoClient(uri);

let db;

// 1. Conectar a la base de datos al arrancar el servidor
async function conectarMongo() {
    try {
        await client.connect();
        db = client.db("novastra_db"); // Crea una base de datos llamada novastra_db
        console.log("🚀 Conectado a la Bóveda de MongoDB!");
    } catch (e) {
        console.error("Error conectando a Mongo:", e);
    }
}
conectarMongo();

// 2. RUTA SECRETA PARA SINCRONIZAR (Descarga de The Space Devs y guarda en tu Mongo)
app.get('/api/sync', async (req, res) => {
    try {
        console.log("Descargando datos de la agencia espacial...");
        
        // Pedimos 100 de cada
        const resFuturas = await fetch('https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=100');
        const dataFuturas = await resFuturas.json();

        const resPasadas = await fetch('https://ll.thespacedevs.com/2.2.0/launch/previous/?limit=100');
        const dataPasadas = await resPasadas.json();

        const collection = db.collection('lanzamientos');
        
        // Borramos los datos viejos para no duplicar
        await collection.deleteMany({});
        
        // Guardamos todo de golpe en tu MongoDB
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
        res.status(500).json({ error: "Error sincronizando: " + error.message });
    }
});

// 3. RUTA PARA TU WEB (Lee directo de tu MongoDB, rápido y sin límites de API)
app.get('/api/misiones', async (req, res) => {
    try {
        const collection = db.collection('lanzamientos');
        // Busca nuestro archivo maestro
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

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor activo en puerto ${PORT}`);
});
