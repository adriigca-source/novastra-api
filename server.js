const express = require("express");
const cors = require("cors");
const { MongoClient } = require("mongodb");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || "novastra_db";
const collectionName = process.env.MONGODB_COLLECTION || "lanzamientos";
const syncSecret = process.env.SYNC_SECRET || "";

if (!uri) {
  throw new Error("Falta la variable de entorno MONGODB_URI");
}

const client = new MongoClient(uri);

async function getCollection() {
  await client.connect();
  return client.db(dbName).collection(collectionName);
}

function isAuthorized(req) {
  if (!syncSecret) return true;
  const providedSecret = req.headers["x-sync-secret"] || req.query.secret;
  return providedSecret === syncSecret;
}

async function downloadLaunches() {
  const [futureResponse, pastResponse] = await Promise.all([
    fetch("https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=100"),
    fetch("https://ll.thespacedevs.com/2.2.0/launch/previous/?limit=100")
  ]);

  if (!futureResponse.ok || !pastResponse.ok) {
    throw new Error("No se pudieron descargar los lanzamientos desde The Space Devs.");
  }

  const futureData = await futureResponse.json();
  const pastData = await pastResponse.json();

  return {
    futuras: futureData.results || [],
    pasadas: pastData.results || []
  };
}

app.get("/api/sync", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "No autorizado para sincronizar." });
  }

  try {
    const collection = await getCollection();
    const data = await downloadLaunches();

    await collection.deleteMany({});
    await collection.insertOne({
      id_guardado: "historial_maestro",
      futuras: data.futuras,
      pasadas: data.pasadas,
      fecha_actualizacion: new Date()
    });

    return res.json({
      mensaje: "Base de datos MongoDB actualizada con exito",
      futuras_guardadas: data.futuras.length,
      pasadas_guardadas: data.pasadas.length
    });
  } catch (error) {
    console.error("Error en /api/sync:", error);
    return res.status(500).json({
      error: "Fallo en la sincronizacion",
      detalle: error.message
    });
  }
});

app.get("/api/misiones", async (req, res) => {
  try {
    const collection = await getCollection();
    const datos = await collection.findOne({ id_guardado: "historial_maestro" });

    if (!datos) {
      return res.json({ futuras: [], pasadas: [] });
    }

    return res.json({
      futuras: datos.futuras || [],
      pasadas: datos.pasadas || []
    });
  } catch (error) {
    console.error("Error en /api/misiones:", error);
    return res.status(500).json({
      error: "Error leyendo de Mongo",
      detalle: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});

process.on("SIGINT", async () => {
  await client.close();
  process.exit(0);
});
