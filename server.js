require("dotenv").config();

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

const UPCOMING_LIMIT = 60;
const RECENT_PAST_LIMIT = 30;
const IMPORT_PAGE_SIZE = 100;
const HISTORY_PAGE_LIMIT_MAX = 100;

if (!uri) {
    throw new Error("Falta la variable de entorno MONGODB_URI");
}

const client = new MongoClient(uri);

async function getCollection() {
    await client.connect();
    return client.db(dbName).collection(collectionName);
}

function isAuthorized(req) {
    if (!syncSecret) {
        return true;
    }

    const providedSecret = req.headers["x-sync-secret"] || req.query.secret;
    return providedSecret === syncSecret;
}

function compactLaunch(launch, tipoDocumento = "historico") {
    return {
        launch_id: launch.id || launch.launch_id || "",
        tipo_documento: tipoDocumento,
        name: launch.name || "",
        net: launch.net || null,
        image: launch.image || launch.image_url || launch.rocket?.configuration?.image_url || "",
        status: launch.status
            ? {
                  id: launch.status.id || null,
                  name: launch.status.name || ""
              }
            : null,
        mission: launch.mission
            ? {
                  type: launch.mission.type || "",
                  description: launch.mission.description || "",
                  orbit: launch.mission.orbit
                      ? {
                            name: launch.mission.orbit.name || ""
                        }
                      : null
              }
            : null,
        rocket: launch.rocket
            ? {
                  configuration: launch.rocket.configuration
                      ? {
                            name: launch.rocket.configuration.name || "",
                            full_name: launch.rocket.configuration.full_name || launch.rocket.configuration.name || "",
                            image_url: launch.rocket.configuration.image_url || launch.image || ""
                        }
                      : null
              }
            : null,
        launch_service_provider: launch.launch_service_provider
            ? {
                  name: launch.launch_service_provider.name || ""
              }
            : null,
        pad: launch.pad
            ? {
                  name: launch.pad.name || "",
                  latitude: launch.pad.latitude || null,
                  longitude: launch.pad.longitude || null,
                  location: launch.pad.location
                      ? {
                            name: launch.pad.location.name || ""
                        }
                      : null
              }
            : null,
        imported_at: new Date()
    };
}

function sortByNetAsc(a, b) {
    return new Date(a.net || 0).getTime() - new Date(b.net || 0).getTime();
}

function sortByNetDesc(a, b) {
    return new Date(b.net || 0).getTime() - new Date(a.net || 0).getTime();
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
        futuras: Array.isArray(futureData.results) ? futureData.results : [],
        pasadas: Array.isArray(pastData.results) ? pastData.results : []
    };
}

async function downloadPastLaunchesPage(offset = 0, limit = IMPORT_PAGE_SIZE) {
    const response = await fetch(
        `https://ll.thespacedevs.com/2.2.0/launch/previous/?limit=${limit}&offset=${offset}`
    );

    if (!response.ok) {
        throw new Error(`No se pudo descargar la pagina offset=${offset}`);
    }

    return response.json();
}

async function upsertHistoricLaunches(collection, launches) {
    let total = 0;

    for (const launch of launches) {
        const compact = compactLaunch(launch, "historico");
        if (!compact.launch_id) {
            continue;
        }

        await collection.updateOne(
            { launch_id: compact.launch_id, tipo_documento: "historico" },
            { $set: compact },
            { upsert: true }
        );

        total += 1;
    }

    return total;
}

async function importPastLaunches(maxPages = 5, pageSize = IMPORT_PAGE_SIZE) {
    const collection = await getCollection();
    let totalImported = 0;

    for (let page = 0; page < maxPages; page += 1) {
        const offset = page * pageSize;
        const data = await downloadPastLaunchesPage(offset, pageSize);
        const launches = Array.isArray(data.results) ? data.results : [];

        if (launches.length === 0) {
            break;
        }

        totalImported += await upsertHistoricLaunches(collection, launches);
    }

    return totalImported;
}

function buildHistoricQuery(reqQuery) {
    const query = { tipo_documento: "historico" };
    const search = String(reqQuery.q || "").trim();
    const agencia = String(reqQuery.agencia || "").trim();
    const cohete = String(reqQuery.cohete || "").trim();
    const mision = String(reqQuery.mision || "").trim();

    if (search) {
        const regex = new RegExp(search, "i");
        query.$or = [
            { name: regex },
            { "rocket.configuration.name": regex },
            { "launch_service_provider.name": regex },
            { "mission.type": regex },
            { "pad.location.name": regex }
        ];
    }

    if (agencia) {
        query["launch_service_provider.name"] = agencia;
    }

    if (cohete) {
        query["rocket.configuration.name"] = cohete;
    }

    if (mision) {
        query["mission.type"] = mision;
    }

    return query;
}

async function syncMasterAndArchive() {
    const collection = await getCollection();
    const data = await downloadLaunches();
    const now = Date.now();

    const pastFromFuture = data.futuras.filter((launch) => {
        const launchTime = new Date(launch.net || 0).getTime();
        return Number.isFinite(launchTime) && launchTime <= now;
    });

    const allHistoric = [...data.pasadas, ...pastFromFuture];
    const compactHistoric = allHistoric.map((launch) => compactLaunch(launch, "historico"));
    const compactFuture = data.futuras
        .filter((launch) => {
            const launchTime = new Date(launch.net || 0).getTime();
            return !Number.isFinite(launchTime) || launchTime > now;
        })
        .sort(sortByNetAsc)
        .slice(0, UPCOMING_LIMIT)
        .map((launch) => compactLaunch(launch, "futura"));

    const compactRecentPast = data.pasadas
        .sort(sortByNetDesc)
        .slice(0, RECENT_PAST_LIMIT)
        .map((launch) => compactLaunch(launch, "pasada_reciente"));

    const archivedCount = await upsertHistoricLaunches(collection, compactHistoric);

    await collection.deleteMany({ id_guardado: "historial_maestro" });
    await collection.insertOne({
        id_guardado: "historial_maestro",
        futuras: compactFuture,
        pasadas: compactRecentPast,
        fecha_actualizacion: new Date()
    });

    return {
        futuras: compactFuture.length,
        pasadas_recientes: compactRecentPast.length,
        archivadas: archivedCount
    };
}

app.get("/api/sync", async (req, res) => {
    if (!isAuthorized(req)) {
        return res.status(401).json({ error: "No autorizado para sincronizar." });
    }

    try {
        const result = await syncMasterAndArchive();

        return res.json({
            mensaje: "Sincronizacion completada con exito",
            futuras_guardadas: result.futuras,
            pasadas_recientes_guardadas: result.pasadas_recientes,
            archivadas_en_historial: result.archivadas
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
        const pages = Math.max(1, Number(req.query.pages || 5));
        const imported = await importPastLaunches(pages, IMPORT_PAGE_SIZE);

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

app.get("/api/historial", async (req, res) => {
    try {
        const collection = await getCollection();
        const page = Math.max(1, Number(req.query.page || 1));
        const limit = Math.min(HISTORY_PAGE_LIMIT_MAX, Math.max(1, Number(req.query.limit || 20)));
        const skip = (page - 1) * limit;
        const query = buildHistoricQuery(req.query);

        const [total, resultados] = await Promise.all([
            collection.countDocuments(query),
            collection
                .find(query)
                .sort({ net: -1 })
                .skip(skip)
                .limit(limit)
                .toArray()
        ]);

        return res.json({
            resultados,
            total,
            page,
            limit,
            total_pages: Math.max(1, Math.ceil(total / limit))
        });
    } catch (error) {
        console.error("Error en /api/historial:", error);
        return res.status(500).json({
            error: "Error leyendo el historial paginado",
            detalle: error.message
        });
    }
});

app.get("/api/buscar", async (req, res) => {
    try {
        const collection = await getCollection();
        const q = String(req.query.q || "").trim();
        const limit = Math.min(Number(req.query.limit || 20), HISTORY_PAGE_LIMIT_MAX);

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
                    { "mission.type": regex },
                    { "pad.location.name": regex }
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
