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
const NEWS_LIMIT = 40;
const NEWS_LOOKBACK_DAYS = 7;

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

function toIsoDate(value) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function stripHtml(text = "") {
    return String(text).replace(/<[^>]*>/g, "").trim();
}

async function translateEnToEs(text) {
    const clean = stripHtml(text);
    if (!clean) return "";

    try {
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(clean)}&langpair=en|es`;
        const res = await fetch(url);
        if (!res.ok) return clean;
        const data = await res.json();
        const translated = data?.responseData?.translatedText;
        return translated ? stripHtml(translated) : clean;
    } catch {
        return clean;
    }
}

async function fetchRecentSpaceNews() {
    const res = await fetch("https://api.spaceflightnewsapi.net/v4/articles/?limit=80&ordering=-published_at");
    if (!res.ok) {
        throw new Error("No se pudieron descargar noticias espaciales.");
    }

    const data = await res.json();
    const results = Array.isArray(data.results) ? data.results : [];
    const since = Date.now() - NEWS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

    const filtered = results
        .filter((item) => {
            const t = new Date(item.published_at || item.publishedAt || 0).getTime();
            return Number.isFinite(t) && t >= since;
        })
        .filter((item) => item.url)
        .slice(0, NEWS_LIMIT * 2);

    const seen = new Set();
    const dedup = [];
    for (const item of filtered) {
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        dedup.push(item);
        if (dedup.length >= NEWS_LIMIT) break;
    }

    const translated = [];
    for (const item of dedup) {
        const titleEs = await translateEnToEs(item.title || "");
        const summaryEs = await translateEnToEs(item.summary || "");

        translated.push({
            tipo_documento: "noticia",
            news_id: String(item.id || item.url),
            url: item.url,
            title: titleEs || item.title || "",
            summary: summaryEs || item.summary || "",
            image_url: item.image_url || item.imageUrl || "",
            source: item.news_site || item.newsSite || "Fuente externa",
            published_at: toIsoDate(item.published_at || item.publishedAt),
            updated_at: new Date().toISOString()
        });
    }

    return translated;
}

async function syncNewsToMongo() {
    const collection = await getCollection();
    const news = await fetchRecentSpaceNews();

    await collection.deleteMany({ tipo_documento: "noticia" });

    if (news.length > 0) {
        await collection.insertMany(news);
    }

    return news.length;
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
    const imported = await importPastLaunchesFromOffset(collection, 0, maxPages, pageSize);
    return imported.registrosImportados;
}

async function getHistoricImportCursor(collection) {
    const cursorDoc = await collection.findOne({ id_guardado: "historial_import_cursor" });
    if (!cursorDoc || !Number.isFinite(Number(cursorDoc.offset_actual))) {
        return 0;
    }

    return Math.max(0, Number(cursorDoc.offset_actual));
}

async function setHistoricImportCursor(collection, nextOffset) {
    await collection.updateOne(
        { id_guardado: "historial_import_cursor" },
        {
            $set: {
                offset_actual: Math.max(0, Number(nextOffset || 0)),
                fecha_actualizacion: new Date()
            }
        },
        { upsert: true }
    );
}

async function importPastLaunchesFromOffset(collection, startOffset = 0, maxPages = 5, pageSize = IMPORT_PAGE_SIZE) {
    let totalImported = 0;
    let pagesProcessed = 0;
    let currentOffset = Math.max(0, Number(startOffset || 0));
    let totalAvailable = null;
    let exhausted = false;

    for (let page = 0; page < maxPages; page += 1) {
        const data = await downloadPastLaunchesPage(currentOffset, pageSize);
        const launches = Array.isArray(data.results) ? data.results : [];

        if (Number.isFinite(Number(data.count))) {
            totalAvailable = Number(data.count);
        }

        if (launches.length === 0) {
            exhausted = true;
            break;
        }

        totalImported += await upsertHistoricLaunches(collection, launches);
        pagesProcessed += 1;
        currentOffset += pageSize;

        if (totalAvailable !== null && currentOffset >= totalAvailable) {
            exhausted = true;
            break;
        }
    }

    const hasMore = !exhausted && (totalAvailable === null || currentOffset < totalAvailable);

    return {
        registrosImportados: totalImported,
        paginasProcesadas: pagesProcessed,
        offsetSiguiente: currentOffset,
        totalDisponible: totalAvailable,
        quedanMas: hasMore
    };
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
        const collection = await getCollection();
        const pages = Math.max(1, Number(req.query.pages || 5));
        const pageSize = Math.min(IMPORT_PAGE_SIZE, Math.max(10, Number(req.query.limit || IMPORT_PAGE_SIZE)));
        const resetCursor = String(req.query.reset || "").toLowerCase() === "true";
        const hasOffset = req.query.offset !== undefined;

        if (resetCursor) {
            await setHistoricImportCursor(collection, 0);
        }

        const startOffset = hasOffset
            ? Math.max(0, Number(req.query.offset || 0))
            : await getHistoricImportCursor(collection);

        const imported = await importPastLaunchesFromOffset(collection, startOffset, pages, pageSize);
        await setHistoricImportCursor(collection, imported.offsetSiguiente);

        return res.json({
            mensaje: "Historial importado correctamente",
            paginas_procesadas: imported.paginasProcesadas,
            registros_importados: imported.registrosImportados,
            offset_inicial: startOffset,
            offset_siguiente: imported.offsetSiguiente,
            total_disponible_api: imported.totalDisponible,
            quedan_mas: imported.quedanMas,
            sugerencia: imported.quedanMas
                ? "Vuelve a llamar /api/import-past para seguir importando mas historial."
                : "Historial agotado: ya no quedan mas paginas por importar."
        });
    } catch (error) {
        console.error("Error en /api/import-past:", error);
        return res.status(500).json({
            error: "Fallo importando historial pasado",
            detalle: error.message
        });
    }
});

app.get("/api/import-past-status", async (req, res) => {
    if (!isAuthorized(req)) {
        return res.status(401).json({ error: "No autorizado para consultar estado de importacion." });
    }

    try {
        const collection = await getCollection();
        const offsetActual = await getHistoricImportCursor(collection);
        const totalHistorico = await collection.countDocuments({ tipo_documento: "historico" });

        return res.json({
            offset_actual: offsetActual,
            historico_guardado: totalHistorico,
            ayuda: "Llama /api/import-past para seguir trayendo bloques historicos."
        });
    } catch (error) {
        console.error("Error en /api/import-past-status:", error);
        return res.status(500).json({
            error: "Error consultando estado de importacion",
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

app.get("/api/estadisticas", async (req, res) => {
    try {
        const collection = await getCollection();

        const yearsPipeline = [
            { $match: { tipo_documento: "historico" } },
            {
                $addFields: {
                    parsedNet: {
                        $dateFromString: {
                            dateString: "$net",
                            onError: null,
                            onNull: null
                        }
                    }
                }
            },
            { $match: { parsedNet: { $ne: null } } },
            { $group: { _id: { $year: "$parsedNet" } } },
            { $sort: { _id: -1 } }
        ];

        const yearsDocs = await collection.aggregate(yearsPipeline).toArray();
        const years = yearsDocs.map((doc) => doc._id).filter((year) => Number.isFinite(year));
        const latestYear = years.length > 0 ? years[0] : new Date().getFullYear();
        const selectedYear = Number(req.query.year || latestYear);

        const statsPipeline = [
            { $match: { tipo_documento: "historico" } },
            {
                $addFields: {
                    parsedNet: {
                        $dateFromString: {
                            dateString: "$net",
                            onError: null,
                            onNull: null
                        }
                    }
                }
            },
            {
                $match: {
                    parsedNet: { $ne: null },
                    $expr: { $eq: [{ $year: "$parsedNet" }, selectedYear] }
                }
            },
            {
                $facet: {
                    monthly: [
                        { $group: { _id: { $month: "$parsedNet" }, count: { $sum: 1 } } },
                        { $sort: { _id: 1 } }
                    ],
                    agencies: [
                        {
                            $group: {
                                _id: {
                                    $ifNull: ["$launch_service_provider.name", "Desconocida"]
                                },
                                count: { $sum: 1 }
                            }
                        },
                        { $sort: { count: -1 } },
                        { $limit: 10 }
                    ],
                    statuses: [
                        {
                            $group: {
                                _id: {
                                    $toLower: {
                                        $ifNull: ["$status.name", ""]
                                    }
                                },
                                count: { $sum: 1 }
                            }
                        }
                    ],
                    totals: [{ $count: "total" }]
                }
            }
        ];

        const [statsDoc] = await collection.aggregate(statsPipeline).toArray();
        const monthlyRaw = statsDoc?.monthly || [];
        const agenciesRaw = statsDoc?.agencies || [];
        const statusesRaw = statsDoc?.statuses || [];
        const totalLaunches = statsDoc?.totals?.[0]?.total || 0;

        const monthlyMap = new Map(monthlyRaw.map((item) => [item._id, item.count]));
        const monthly = Array.from({ length: 12 }, (_, index) => {
            const month = index + 1;
            return {
                month,
                count: monthlyMap.get(month) || 0
            };
        });

        let successCount = 0;
        let failedCount = 0;

        statusesRaw.forEach((item) => {
            const key = String(item._id || "");
            const count = Number(item.count || 0);
            if (key.includes("success") || key.includes("exito")) {
                successCount += count;
            } else if (key.includes("fail") || key.includes("fall")) {
                failedCount += count;
            }
        });

        const byAgency = agenciesRaw.map((item) => ({
            name: item._id || "Desconocida",
            count: item.count,
            percent: totalLaunches > 0 ? Math.round((item.count / totalLaunches) * 100) : 0
        }));

        return res.json({
            year: selectedYear,
            years,
            total_launches: totalLaunches,
            success_count: successCount,
            failed_count: failedCount,
            by_agency: byAgency,
            by_month: monthly
        });
    } catch (error) {
        console.error("Error en /api/estadisticas:", error);
        return res.status(500).json({
            error: "Error calculando estadisticas",
            detalle: error.message
        });
    }
});

app.get("/api/sync-news", async (req, res) => {
    if (!isAuthorized(req)) {
        return res.status(401).json({ error: "No autorizado para sincronizar noticias." });
    }

    try {
        const total = await syncNewsToMongo();
        return res.json({
            mensaje: "Noticias sincronizadas correctamente",
            noticias_guardadas: total,
            ventana_dias: NEWS_LOOKBACK_DAYS
        });
    } catch (error) {
        console.error("Error en /api/sync-news:", error);
        return res.status(500).json({
            error: "Fallo sincronizando noticias",
            detalle: error.message
        });
    }
});

app.get("/api/noticias", async (req, res) => {
    try {
        const collection = await getCollection();
        const resultados = await collection
            .find({ tipo_documento: "noticia" })
            .sort({ published_at: -1 })
            .limit(NEWS_LIMIT)
            .toArray();

        return res.json({
            resultados,
            total: resultados.length
        });
    } catch (error) {
        console.error("Error en /api/noticias:", error);
        return res.status(500).json({
            error: "Error leyendo noticias",
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
