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

async function downloadPastLaunchesPage(offset = 0, limit = 100) {
  const response = await fetch(
    `https://ll.thespacedevs.com/2.2.0/launch/previous/?limit=${limit}&offset=${offset}`
  );

  if (!response.ok) {
    throw new Error(`No se pudo descargar la pagina offset=${offset}`);
  }

  return response.json();
}

async function importPastLaunches(maxPages = 5, pageSize = 100) {
  const collection = await getCollection();
  let totalImported = 0;

  for (let page = 0; page < maxPages; page++) {
    const offset = page * pageSize;
    const data = await downloadPastLaunchesPage(offset, pageSize);
    const launches = Array.isArray(data.results) ? data.results : [];

    if (launches.length === 0) {
      break;
    }

    const docs = launches.map((launch) => ({
      launch_id: launch.id,
      tipo_documento: "historico",
      name: launch.name || "",
      net: launch.net || null,
      image: launch.image || launch.image_url || "",
      status: launch.status || null,
      mission: launch.mission || null,
      rocket: launch.rocket || null,
      launch_service_provider: launch.launch_service_provider || null,
      pad: launch.pad || null,
      imported_at: new Date()
    }));

    for (const doc of docs) {
      await collection.updateOne(
        { launch_id: doc.launch_id, tipo_documento: "historico" },
        { $set: doc },
        { upsert: true }
      );
    }

    totalImported += docs.length;
  }

  return totalImported;
}

app.get("/api/sync", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "No autorizado para sincronizar." });
  }

  try {
    const collection = await getCollection();
    const data = await downloadLaunches();

    await collection.deleteMany({ id_guardado: "historial_maestro" });
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

app.get("/api/import-past", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "No autorizado para importar historial." });
  }

  try {
    const pages = Number(req.query.pages || 5);
    const imported = await importPastLaunches(pages, 100);

    return res.json({
      mensaje: "Historial importado correctamente",
      paginas_procesadas: pages,
      registros_importados: imported
    });
  } catch (error) {
    console.error("Error en /api/import-past:", error);
    return res.status(500).json({
      error: "Fallo importando historial pasado",
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

app.get("/api/buscar", async (req, res) => {
  try {
    const collection = await getCollection();
    const q = String(req.query.q || "").trim();
    const limit = Math.min(Number(req.query.limit || 20), 100);

    if (!q) {
      return res.json({ resultados: [] });
    }

    const regex = new RegExp(q, "i");

    const resultados = await collection
      .find({
        tipo_documento: "historico",
        $or: [
          { name: regex },
          { "rocket.configuration.name": regex },
          { "launch_service_provider.name": regex },
          { "mission.type": regex }
        ]
      })
      .sort({ net: -1 })
      .limit(limit)
      .toArray();

    return res.json({ resultados });
  } catch (error) {
    console.error("Error en /api/buscar:", error);
    return res.status(500).json({
      error: "Error buscando en MongoDB",
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
