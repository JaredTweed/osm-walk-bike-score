/*
  OSM Access Score prototype
  - Uses public OpenStreetMap tiles for the base map.
  - Uses Overpass API for visible-map OSM tags.
  - Scores a regular grid of points and renders it as a red-to-green overlay.
*/

const DEFAULT_OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
const EARTH_RADIUS_M = 6371008.8;
const DENSIFY_STEP_M = 45;
const SCORE_CELL_SIZE_M = 100;
const DRAFT_SCORE_CELL_SIZE_M = 300;
const SCAN_TILE_SIZE_M = 5000 / 3;
const SCAN_TILE_LABEL = formatDistance(SCAN_TILE_SIZE_M);
const SCAN_PADDING_EXTRA_M = 180;
const MAX_SINGLE_SCAN_AREA_DEG2 = 0.08;
const MAX_SINGLE_SCAN_LAT_SPAN_DEG = 0.30;
const MAX_SINGLE_SCAN_LNG_SPAN_DEG = 0.50;
const MAX_SCAN_TILES = 900;
const SCAN_TILE_DELAY_MS = 450;
const OVERPASS_RETRY_DELAYS_MS = [1800, 4500];
const CUSTOM_ENDPOINT_MAX_CONCURRENCY = 4;
const CACHE_DB_NAME = "osm-access-score-cache";
const CACHE_DB_VERSION = 1;
const SCORE_AREAS_STORE = "scoreAreas";
const SCAN_TILES_STORE = "scanTiles";
const OVERLAY_VISIBLE_KEY = "osmScoreOverlayVisible";

const map = L.map("map", {
  zoomControl: true,
  preferCanvas: true,
  fadeAnimation: false,
  markerZoomAnimation: false,
  zoomAnimation: false,
}).setView([49.8954, -97.1385], 14); // Winnipeg by default

L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  updateWhenZooming: false,
  keepBuffer: 3,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

let compositeLayer = null;
let draftArea = null;
let featureLayer = L.layerGroup().addTo(map);
let scoreAreas = [];
let compositeGrid = [];
let lastGrid = [];
let lastFeatures = null;
let lastProjection = null;
let lastScan = null;
let lastBbox = null;
let activeFetchController = null;
let activeScoreController = null;
let rescoreTimer = null;
let scoringWorker = null;
let scoringWorkerJobId = 0;
let scorePopup = null;
let overpassEndpoint = DEFAULT_OVERPASS_ENDPOINT;
let overlayVisible = localStorage.getItem(OVERLAY_VISIBLE_KEY) !== "false";
let persistentCacheReady = Promise.resolve();
let persistentDbPromise = null;
const scanCache = new Map();
const workerCachedScanKeys = new Set();

const statusEl = document.getElementById("status");
const scoreButton = document.getElementById("scoreButton");
const clearButton = document.getElementById("clearButton");
const toggleOverlayButton = document.getElementById("toggleOverlayButton");
const showFeaturesEl = document.getElementById("showFeatures");
const clickInspectEl = document.getElementById("clickInspect");

const layerDefinitions = {
  "walk-network": {
    label: "Walking network",
    type: "walkNetwork",
    groups: ["pedestrianNetwork"],
    fallbackGroups: ["walkableStreets"],
    radius: 170,
    fallbackMaxScore: 55,
    weight: 1.0,
  },
  "walk-crossings": {
    label: "Crossings",
    type: "near",
    groups: ["crossings"],
    radius: 140,
    weight: 0.75,
  },
  "walk-groceries": {
    label: "Groceries",
    type: "categoryAccess",
    groups: ["destinations"],
    categories: ["groceries"],
    radius: 950,
    weight: 1.35,
  },
  "walk-destinations": {
    label: "Daily destinations",
    type: "destinationPortfolio",
    groups: ["destinations"],
    radius: 850,
    weight: 1.1,
  },
  "walk-fitness": {
    label: "Gyms / fitness",
    type: "categoryAccess",
    groups: ["destinations"],
    categories: ["fitness"],
    radius: 1000,
    weight: 0.45,
  },
  "walk-transit": {
    label: "Transit stops",
    type: "near",
    groups: ["transitStops"],
    radius: 460,
    weight: 0.7,
  },
  "walk-parks": {
    label: "Parks / green space",
    type: "near",
    groups: ["greenSpace"],
    radius: 520,
    weight: 0.55,
  },
  "walk-comfort": {
    label: "Avoid high-stress roads",
    type: "avoid",
    groups: ["highStressRoads"],
    radius: 145,
    weight: 0.95,
  },
  "bike-network": {
    label: "Bike lanes / cycleways",
    type: "near",
    groups: ["bikeNetwork"],
    radius: 270,
    weight: 1.35,
  },
  "bike-low-stress": {
    label: "Low-stress streets",
    type: "near",
    groups: ["lowStressBikeStreets"],
    radius: 230,
    maxScore: 65,
    weight: 0.95,
  },
  "bike-parking": {
    label: "Bike parking",
    type: "near",
    groups: ["bikeParking"],
    radius: 520,
    weight: 0.45,
  },
  "bike-calm": {
    label: "Traffic calming",
    type: "near",
    groups: ["trafficCalming"],
    radius: 220,
    weight: 0.35,
  },
  "bike-parks-trails": {
    label: "Parks / trails",
    type: "near",
    groups: ["greenSpace", "bikeNetwork"],
    radius: 520,
    weight: 0.55,
  },
  "bike-stress": {
    label: "Avoid high-stress roads",
    type: "avoid",
    groups: ["highStressRoads"],
    radius: 160,
    weight: 1.0,
  },
};

const walkPreset = ["walk-network", "walk-crossings", "walk-groceries", "walk-destinations", "walk-comfort"];
const bikePreset = ["bike-network", "bike-low-stress", "bike-parking", "bike-calm", "bike-parks-trails", "bike-stress"];
const MAX_SCORE_RADIUS_M = Math.max(...Object.values(layerDefinitions).map((layer) => layer.radius || 0));
const SCAN_PADDING_M = MAX_SCORE_RADIUS_M + SCAN_PADDING_EXTRA_M;

function setStatus(message, level = "") {
  statusEl.textContent = message;
  statusEl.className = `status ${level}`.trim();
}

function selectedLayerIds() {
  return [...document.querySelectorAll(".score-layer:checked")].map((el) => el.value);
}

function setSelectedLayers(ids) {
  const chosen = new Set(ids);
  document.querySelectorAll(".score-layer").forEach((el) => {
    el.checked = chosen.has(el.value);
  });
}

function endpointHost(endpoint) {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "";
  }
}

function isPublicOverpassEndpoint() {
  const host = endpointHost(overpassEndpoint);
  return !host || host === "overpass-api.de" || host.endsWith(".overpass-api.de");
}

function scanConcurrency() {
  if (isPublicOverpassEndpoint()) return 1;
  return Math.max(2, Math.min(CUSTOM_ENDPOINT_MAX_CONCURRENCY, navigator.hardwareConcurrency || 2));
}

function scanDelayMs() {
  return isPublicOverpassEndpoint() ? SCAN_TILE_DELAY_MS : 0;
}

function openPersistentDb() {
  if (!window.indexedDB) return Promise.resolve(null);
  if (persistentDbPromise) return persistentDbPromise;

  persistentDbPromise = new Promise((resolve) => {
    const request = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SCORE_AREAS_STORE)) {
        db.createObjectStore(SCORE_AREAS_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(SCAN_TILES_STORE)) {
        db.createObjectStore(SCAN_TILES_STORE, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      console.warn("Persistent cache is unavailable.", request.error);
      resolve(null);
    };
  });

  return persistentDbPromise;
}

async function getAllFromStore(storeName) {
  const db = await openPersistentDb();
  if (!db) return [];

  return new Promise((resolve) => {
    const transaction = db.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => {
      console.warn(`Could not load ${storeName}.`, request.error);
      resolve([]);
    };
  });
}

async function putInStore(storeName, value) {
  const db = await openPersistentDb();
  if (!db) return false;

  return new Promise((resolve) => {
    const transaction = db.transaction(storeName, "readwrite");
    try {
      transaction.objectStore(storeName).put(value);
    } catch (err) {
      console.warn(`Could not save ${storeName}.`, err);
      resolve(false);
      return;
    }
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => {
      console.warn(`Could not save ${storeName}.`, transaction.error);
      resolve(false);
    };
  });
}

async function clearStore(storeName) {
  const db = await openPersistentDb();
  if (!db) return false;

  return new Promise((resolve) => {
    const transaction = db.transaction(storeName, "readwrite");
    try {
      transaction.objectStore(storeName).clear();
    } catch (err) {
      console.warn(`Could not clear ${storeName}.`, err);
      resolve(false);
      return;
    }
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => {
      console.warn(`Could not clear ${storeName}.`, transaction.error);
      resolve(false);
    };
  });
}

async function hydratePersistentCaches() {
  const [storedTiles, storedAreas] = await Promise.all([
    getAllFromStore(SCAN_TILES_STORE),
    getAllFromStore(SCORE_AREAS_STORE),
  ]);

  for (const tile of storedTiles) {
    if (tile?.key && tile.osmJson) scanCache.set(tile.key, tile);
  }

  scoreAreas = storedAreas
    .map(normalizeStoredScoreArea)
    .filter(Boolean)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  renderScoreAreas();
  const newest = scoreAreas.at(-1);
  if (newest) {
    setLastArea(newest);
    setStatus(
      `Ready. Restored ${scoreAreas.length.toLocaleString()} saved gradient area${scoreAreas.length === 1 ? "" : "s"} and ${scanCache.size.toLocaleString()} cached scan request${scanCache.size === 1 ? "" : "s"}.`
    );
  }
}

function persistScanTile(entry) {
  putInStore(SCAN_TILES_STORE, {
    key: entry.key,
    bbox: entry.bbox,
    osmJson: entry.osmJson,
    elementCount: entry.elementCount,
    fetchedAt: entry.fetchedAt,
  });
}

function persistScoreArea(area) {
  putInStore(SCORE_AREAS_STORE, serializeScoreArea(area));
}

function resetScanCaches() {
  if (activeFetchController) {
    activeFetchController.abort();
    activeFetchController = null;
  }
  scanCache.clear();
  clearStore(SCAN_TILES_STORE);
  workerCachedScanKeys.clear();
  terminateScoringWorker();
}

function formatDistance(meters) {
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}

function getBbox() {
  const b = map.getBounds();
  return {
    south: b.getSouth(),
    west: b.getWest(),
    north: b.getNorth(),
    east: b.getEast(),
  };
}

function expandedBboxMeters(bbox, meters) {
  const centerLat = (bbox.north + bbox.south) / 2;
  const latPad = (meters / EARTH_RADIUS_M) * (180 / Math.PI);
  const lngPad = latPad / Math.max(0.2, Math.cos(degToRad(centerLat)));
  return {
    south: clamp(bbox.south - latPad, -85, 85),
    west: clamp(bbox.west - lngPad, -180, 180),
    north: clamp(bbox.north + latPad, -85, 85),
    east: clamp(bbox.east + lngPad, -180, 180),
  };
}

function bboxSpan(bbox) {
  return {
    lat: Math.abs(bbox.north - bbox.south),
    lng: Math.abs(bbox.east - bbox.west),
  };
}

function bboxAreaDeg2(bbox) {
  const span = bboxSpan(bbox);
  return span.lat * span.lng;
}

function canUseSingleScan(bbox) {
  const span = bboxSpan(bbox);
  return bboxAreaDeg2(bbox) <= MAX_SINGLE_SCAN_AREA_DEG2 &&
    span.lat <= MAX_SINGLE_SCAN_LAT_SPAN_DEG &&
    span.lng <= MAX_SINGLE_SCAN_LNG_SPAN_DEG;
}

function roundedBboxKey(bbox) {
  return [bbox.south, bbox.west, bbox.north, bbox.east]
    .map((value) => value.toFixed(5))
    .join(":");
}

function metersToLatDegrees(meters) {
  return (meters / EARTH_RADIUS_M) * (180 / Math.PI);
}

function lngDegreesForMeters(meters, lat) {
  return metersToLatDegrees(meters) / Math.max(0.2, Math.cos(degToRad(lat)));
}

function scanTilesForBbox(bbox) {
  const expanded = expandedBboxMeters(bbox, SCAN_PADDING_M);
  if (canUseSingleScan(expanded)) {
    return {
      expanded,
      mode: "single",
      tiles: [{ key: `scan-v4:single:${roundedBboxKey(expanded)}`, bbox: expanded }],
    };
  }

  const latSizeDeg = metersToLatDegrees(SCAN_TILE_SIZE_M);
  const minLatIndex = Math.floor(expanded.south / latSizeDeg);
  const maxLatIndex = Math.floor((expanded.north - 1e-10) / latSizeDeg);
  const tiles = [];

  for (let latIndex = minLatIndex; latIndex <= maxLatIndex; latIndex++) {
    const south = latIndex * latSizeDeg;
    const north = south + latSizeDeg;
    const centerLat = (south + north) / 2;
    const lngSizeDeg = lngDegreesForMeters(SCAN_TILE_SIZE_M, centerLat);
    const minLngIndex = Math.floor(expanded.west / lngSizeDeg);
    const maxLngIndex = Math.floor((expanded.east - 1e-10) / lngSizeDeg);

    for (let lngIndex = minLngIndex; lngIndex <= maxLngIndex; lngIndex++) {
      const west = lngIndex * lngSizeDeg;
      tiles.push({
        key: `scan-v4:${latIndex}:${lngIndex}`,
        bbox: {
          south,
          west,
          north,
          east: west + lngSizeDeg,
        },
      });
    }
  }

  return { expanded, mode: "tiled", tiles };
}

function scanPlanTooLarge(plan) {
  return plan.tiles.length > MAX_SCAN_TILES;
}

function buildOverpassQuery(bbox) {
  const box = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  return `
[out:json][timeout:30];
(
  way["highway"](${box});
  way["cycleway"](${box});
  way["cycleway:left"](${box});
  way["cycleway:right"](${box});
  way["sidewalk"](${box});
  way["footway"](${box});
  way["amenity"](${box});
  way["shop"](${box});
  way["tourism"~"^(attraction|museum|gallery|viewpoint)$"](${box});
  way["leisure"~"^(park|playground|garden|nature_reserve|fitness_centre|fitness_station|sports_centre)$"](${box});
  way["landuse"~"^(grass|recreation_ground|village_green)$"](${box});
  way["traffic_calming"](${box});
  node["highway"="crossing"](${box});
  node["crossing"](${box});
  node["amenity"](${box});
  node["shop"](${box});
  node["tourism"~"^(attraction|museum|gallery|viewpoint)$"](${box});
  node["leisure"~"^(park|playground|garden|nature_reserve|fitness_centre|fitness_station|sports_centre)$"](${box});
  node["public_transport"](${box});
  node["highway"="bus_stop"](${box});
  node["railway"~"^(station|halt|tram_stop|subway_entrance)$"](${box});
  node["traffic_calming"](${box});
);
out body geom;
`.trim();
}

async function fetchOsmData(bbox, signal) {
  const body = new URLSearchParams({ data: buildOverpassQuery(bbox) });

  for (let attempt = 0; attempt <= OVERPASS_RETRY_DELAYS_MS.length; attempt++) {
    const response = await fetch(overpassEndpoint, {
      method: "POST",
      body,
      signal,
    });

    if (response.ok) return response.json();

    const canRetry = [429, 502, 503, 504].includes(response.status) && attempt < OVERPASS_RETRY_DELAYS_MS.length;
    if (!canRetry) {
      throw new Error(`Overpass returned ${response.status}. Already saved scan results remain cached; try again in a minute or zoom in slightly.`);
    }

    const retryAfter = Number(response.headers.get("Retry-After"));
    const delayMs = Number.isFinite(retryAfter)
      ? Math.min(retryAfter * 1000, 12000)
      : OVERPASS_RETRY_DELAYS_MS[attempt];
    await wait(delayMs, signal);
  }
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Scan aborted", "AbortError"));
      return;
    }
    const timeoutId = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timeoutId);
      reject(new DOMException("Scan aborted", "AbortError"));
    }, { once: true });
  });
}

async function scanOsmData(bbox, signal) {
  const plan = scanTilesForBbox(bbox);
  if (scanPlanTooLarge(plan)) {
    throw new Error(`This view needs ${plan.tiles.length} fixed ${SCAN_TILE_LABEL} scan requests. Zoom in until it needs ${MAX_SCAN_TILES} or fewer requests, then calculate again.`);
  }

  const missingTiles = plan.tiles.filter((tile) => !scanCache.has(tile.key));
  await fetchMissingScanTiles(missingTiles, plan, signal);

  return mergeScanTiles(plan.tiles, missingTiles.length);
}

async function fetchMissingScanTiles(missingTiles, plan, signal) {
  if (!missingTiles.length) return;

  const concurrency = Math.min(scanConcurrency(), missingTiles.length);
  const delayMs = scanDelayMs();
  let nextIndex = 0;
  let completed = 0;

  async function runFetcher() {
    while (nextIndex < missingTiles.length) {
      if (signal.aborted) throw new DOMException("Scan aborted", "AbortError");
      const index = nextIndex++;
      const tile = missingTiles[index];
      setStatus(
        `Scanning visible area with ${plan.mode === "single" ? "one padded request" : `fixed ${SCAN_TILE_LABEL} reusable tiles`}…\n` +
        `Completed ${completed} of ${missingTiles.length} new request${missingTiles.length === 1 ? "" : "s"}; ${plan.tiles.length - missingTiles.length} reused from this browser.\n` +
        `Active fetches: ${concurrency}. Total scan requests for this view: ${plan.tiles.length}.`
      );
      const osmJson = await fetchOsmData(tile.bbox, signal);
      const cacheEntry = {
        key: tile.key,
        bbox: tile.bbox,
        osmJson,
        elementCount: Number(osmJson.elements?.length || 0),
        fetchedAt: Date.now(),
      };
      scanCache.set(tile.key, cacheEntry);
      persistScanTile(cacheEntry);
      completed++;
      if (delayMs && nextIndex < missingTiles.length) await wait(delayMs, signal);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, runFetcher));
}

function mergeScanTiles(tiles, fetchedTileCount) {
  const buildMergedOsm = !canUseScoringWorker();
  const elementsByKey = buildMergedOsm ? new Map() : null;
  let rawElementCount = 0;
  const requests = [];

  for (const tile of tiles) {
    const cached = scanCache.get(tile.key);
    if (!cached) continue;
    requests.push({
      key: tile.key,
      bbox: cached.bbox,
      osmJson: cached.osmJson,
      elementCount: cached.elementCount,
    });
    for (const el of cached.osmJson.elements || []) {
      rawElementCount++;
      if (elementsByKey) elementsByKey.set(`${el.type}/${el.id}`, el);
    }
  }

  return {
    osmJson: { elements: elementsByKey ? [...elementsByKey.values()] : [] },
    requests,
    tileCount: tiles.length,
    mode: tiles.length === 1 ? "single" : "tiled",
    fetchedTileCount,
    reusedTileCount: tiles.length - fetchedTileCount,
    rawElementCount,
    uniqueElementCount: elementsByKey ? elementsByKey.size : null,
  };
}

function canUseScoringWorker() {
  return Boolean(window.Worker) && location.protocol !== "file:";
}

function getScoringWorker() {
  if (!scoringWorker) {
    scoringWorker = new Worker("scoring-worker.js?v=20260605-composite1");
  }
  return scoringWorker;
}

function terminateScoringWorker() {
  if (!scoringWorker) return;
  scoringWorker.terminate();
  scoringWorker = null;
  workerCachedScanKeys.clear();
}

function scoreOsmData(scan, bbox, activeLayerIds, signal) {
  if (!canUseScoringWorker()) {
    const startedAt = performance.now();
    const parsed = parseFeatures(scan.osmJson, bbox);
    const grid = scoreGrid(parsed.features, parsed.projection, bbox, activeLayerIds);
    return Promise.resolve({
      parsed,
      grid,
      elapsedMs: performance.now() - startedAt,
      usedWorker: false,
      cache: null,
    });
  }

  const worker = getScoringWorker();
  const jobId = ++scoringWorkerJobId;
  const scanRequests = scan.requests.map((request) => {
    if (!workerCachedScanKeys.has(request.key)) return request;
    return { key: request.key, bbox: request.bbox, elementCount: request.elementCount };
  });

  return new Promise((resolve, reject) => {
    let settled = false;

    function cleanup() {
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
      signal.removeEventListener("abort", handleAbort);
    }

    function finish(fn, value) {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    }

    function handleAbort() {
      terminateScoringWorker();
      finish(reject, new DOMException("Scoring aborted", "AbortError"));
    }

    function handleError(err) {
      terminateScoringWorker();
      finish(reject, err.error || new Error(err.message || "Worker scoring failed."));
    }

    function handleMessage(event) {
      const message = event.data || {};
      if (message.jobId !== jobId) return;

      if (message.type === "progress") {
        setStatus(message.message);
        return;
      }

      if (message.type === "partial") {
        const projection = makeProjection(message.projectionCenterLat);
        message.grid.meta = message.gridMeta;
        lastProjection = projection;
        lastGrid = message.grid;
        showDraftGrid(lastGrid);
        setStatus(
          `Showing a fast draft gradient while final scoring continues…\n` +
          `Draft grid: ${lastGrid.length.toLocaleString()} points.`
        );
        return;
      }

      if (message.type === "error") {
        finish(reject, new Error(message.message || "Worker scoring failed."));
        return;
      }

      if (message.type !== "result") return;

      const projection = makeProjection(message.projectionCenterLat);
      message.grid.meta = message.gridMeta;
      for (const key of message.parsedScanKeys || []) workerCachedScanKeys.add(key);
      finish(resolve, {
        parsed: { features: message.features, projection },
        grid: message.grid,
        elapsedMs: message.elapsedMs,
        usedWorker: true,
        cache: message.cache,
      });
    }

    if (signal.aborted) {
      handleAbort();
      return;
    }

    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    signal.addEventListener("abort", handleAbort, { once: true });
    try {
      worker.postMessage({
        type: "score",
        jobId,
        osmJson: scan.osmJson,
        scanRequests,
        bbox,
        activeLayerIds,
        layerDefinitions,
      });
    } catch (err) {
      terminateScoringWorker();
      finish(reject, err);
    }
  });
}

function makeProjection(centerLat) {
  const lat0 = degToRad(centerLat);
  return {
    toXY(lat, lng) {
      return {
        x: EARTH_RADIUS_M * degToRad(lng) * Math.cos(lat0),
        y: EARTH_RADIUS_M * degToRad(lat),
      };
    },
  };
}

function degToRad(deg) { return deg * Math.PI / 180; }
function radToDeg(rad) { return rad * 180 / Math.PI; }

function toGlobalMeters(lat, lng) {
  const clampedLat = clamp(lat, -85.05112878, 85.05112878);
  return {
    x: EARTH_RADIUS_M * degToRad(lng),
    y: EARTH_RADIUS_M * Math.log(Math.tan((Math.PI / 4) + (degToRad(clampedLat) / 2))),
  };
}

function globalCellKey(xIndex, yIndex, cellSizeM) {
  return `${Math.round(cellSizeM)}:${xIndex}:${yIndex}`;
}

function latIndexForCell(lat, cellSizeM) {
  return Math.floor((EARTH_RADIUS_M * degToRad(lat)) / cellSizeM);
}

function latForCellIndex(yIndex, offset, cellSizeM) {
  return radToDeg(((yIndex + offset) * cellSizeM) / EARTH_RADIUS_M);
}

function lngStepForCellRow(yIndex, cellSizeM) {
  const centerLat = latForCellIndex(yIndex, 0.5, cellSizeM);
  const denominator = EARTH_RADIUS_M * Math.max(0.2, Math.cos(degToRad(centerLat)));
  return radToDeg(cellSizeM / denominator);
}

function globalCellCenter(xIndex, yIndex, cellSizeM) {
  const lngStep = lngStepForCellRow(yIndex, cellSizeM);
  return {
    lat: latForCellIndex(yIndex, 0.5, cellSizeM),
    lng: (xIndex + 0.5) * lngStep,
  };
}

function globalCellBounds(xIndex, yIndex, cellSizeM) {
  const lngStep = lngStepForCellRow(yIndex, cellSizeM);
  return {
    south: latForCellIndex(yIndex, 0, cellSizeM),
    west: xIndex * lngStep,
    north: latForCellIndex(yIndex, 1, cellSizeM),
    east: (xIndex + 1) * lngStep,
  };
}

function metersBetween(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function parseSpeedKmh(value) {
  if (!value) return null;
  const text = String(value).toLowerCase();
  const num = Number((text.match(/\d+(\.\d+)?/) || [])[0]);
  if (!Number.isFinite(num)) return null;
  if (text.includes("mph")) return num * 1.60934;
  return num;
}

function tagValue(tags, key) {
  return String(tags[key] || "").trim().toLowerCase();
}

function isPositiveTagValue(value) {
  if (value === undefined || value === null || value === "") return false;
  return !["no", "none", "false", "0", "separate"].includes(String(value).trim().toLowerCase());
}

function allowsAccess(tags, mode) {
  if (["no", "private"].includes(tagValue(tags, "access"))) return false;
  return !["no", "private"].includes(tagValue(tags, mode));
}

function averageLatLng(points) {
  if (!points.length) return null;
  const sum = points.reduce((acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }), { lat: 0, lng: 0 });
  return { lat: sum.lat / points.length, lng: sum.lng / points.length };
}

function densifyLatLngs(latlngs, projection, stepM = DENSIFY_STEP_M) {
  const output = [];
  for (let i = 0; i < latlngs.length; i++) {
    const curr = latlngs[i];
    output.push({ lat: curr.lat, lng: curr.lng, ...projection.toXY(curr.lat, curr.lng) });
    if (i === latlngs.length - 1) continue;
    const next = latlngs[i + 1];
    const a = projection.toXY(curr.lat, curr.lng);
    const b = projection.toXY(next.lat, next.lng);
    const dist = metersBetween(a, b);
    const steps = Math.floor(dist / stepM);
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const lat = curr.lat + (next.lat - curr.lat) * t;
      const lng = curr.lng + (next.lng - curr.lng) * t;
      output.push({ lat, lng, ...projection.toXY(lat, lng) });
    }
  }
  return output;
}

function elementLatLngs(el) {
  if (el.type === "node" && Number.isFinite(el.lat) && Number.isFinite(el.lon)) {
    return [{ lat: el.lat, lng: el.lon }];
  }
  if (Array.isArray(el.geometry)) {
    return el.geometry
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon))
      .map((p) => ({ lat: p.lat, lng: p.lon }));
  }
  return [];
}

function destinationCategory(tags) {
  if (!tags || !allowsAccess(tags, "foot")) return null;

  const shop = tagValue(tags, "shop");
  if (shop && !["no", "vacant", "closed", "disused"].includes(shop)) {
    if ([
      "supermarket", "convenience", "greengrocer", "bakery", "butcher", "deli", "seafood", "cheese",
      "dairy", "frozen_food", "health_food", "farm", "confectionery", "alcohol", "beverages"
    ].includes(shop)) return "groceries";
    if (["chemist", "medical_supply", "optician", "hearing_aids"].includes(shop)) return "health";
    if (["department_store", "mall", "clothes", "shoes", "hardware", "doityourself", "books", "stationery"].includes(shop)) return "retail";
    return "shops";
  }

  const amenityCategories = {
    cafe: "food",
    restaurant: "food",
    fast_food: "food",
    pub: "food",
    bar: "food",
    ice_cream: "food",
    food_court: "food",
    gym: "fitness",
    fitness_centre: "fitness",
    library: "civic",
    school: "education",
    university: "education",
    college: "education",
    kindergarten: "education",
    childcare: "education",
    community_centre: "civic",
    place_of_worship: "community",
    clinic: "health",
    doctors: "health",
    dentist: "health",
    pharmacy: "health",
    hospital: "health",
    social_facility: "health",
    bank: "finance",
    atm: "finance",
    post_office: "civic",
    post_box: "civic",
    marketplace: "shops",
    theatre: "culture",
    cinema: "culture",
    arts_centre: "culture",
    townhall: "civic",
    courthouse: "civic",
    police: "civic",
  };
  if (amenityCategories[tags.amenity]) return amenityCategories[tags.amenity];

  const leisureCategories = {
    fitness_centre: "fitness",
    fitness_station: "fitness",
    sports_centre: "fitness",
  };
  if (leisureCategories[tags.leisure]) return leisureCategories[tags.leisure];

  const tourismCategories = {
    attraction: "culture",
    museum: "culture",
    gallery: "culture",
    viewpoint: "recreation",
  };
  return tourismCategories[tags.tourism] || null;
}

function hasSidewalk(tags) {
  return [tags.sidewalk, tags["sidewalk:left"], tags["sidewalk:right"], tags["sidewalk:both"]]
    .some(isPositiveTagValue);
}

function hasBikeInfra(tags) {
  if (!allowsAccess(tags, "bicycle")) return false;
  return Boolean(
    [tags.cycleway, tags["cycleway:left"], tags["cycleway:right"], tags["cycleway:both"]].some(isPositiveTagValue) ||
    tagValue(tags, "bicycle") === "designated" ||
    tags.highway === "cycleway" ||
    isPositiveTagValue(tags.lcn) ||
    isPositiveTagValue(tags.rcn) ||
    isPositiveTagValue(tags.ncn)
  );
}

function isPedestrianWay(tags) {
  if (!allowsAccess(tags, "foot")) return false;
  const h = tags.highway;
  return ["footway", "path", "pedestrian", "steps", "corridor", "track", "bridleway"].includes(h) || tags.footway || hasSidewalk(tags);
}

function isWalkableStreet(tags) {
  if (!allowsAccess(tags, "foot")) return false;
  const h = tags.highway;
  if (["living_street", "residential", "service", "unclassified", "pedestrian"].includes(h)) return true;
  const speed = parseSpeedKmh(tags.maxspeed);
  return Number.isFinite(speed) && speed <= 40 && !["motorway", "trunk"].includes(h);
}

function isLowStressBikeStreet(tags) {
  if (!allowsAccess(tags, "bicycle")) return false;
  const h = tags.highway;
  const speed = parseSpeedKmh(tags.maxspeed);
  if (hasBikeInfra(tags)) return true;
  if (["living_street", "residential", "service"].includes(h)) return true;
  if (["unclassified", "tertiary"].includes(h) && Number.isFinite(speed) && speed <= 40) return true;
  return false;
}

function isHighStressRoad(tags) {
  const h = tags.highway;
  const speed = parseSpeedKmh(tags.maxspeed);
  if (["motorway", "trunk", "primary", "secondary"].includes(h)) return true;
  if (["tertiary", "unclassified"].includes(h) && Number.isFinite(speed) && speed >= 50) return true;
  return false;
}

function isTransitStop(tags) {
  return Boolean(tags.public_transport || tags.highway === "bus_stop" || ["station", "halt", "tram_stop", "subway_entrance"].includes(tags.railway));
}

function isGreenSpace(tags) {
  return ["park", "playground", "garden", "nature_reserve"].includes(tags.leisure) ||
    ["grass", "recreation_ground", "village_green"].includes(tags.landuse);
}

function emptyFeatureBuckets() {
  return {
    pedestrianNetwork: [],
    walkableStreets: [],
    crossings: [],
    destinations: [],
    transitStops: [],
    greenSpace: [],
    bikeNetwork: [],
    lowStressBikeStreets: [],
    bikeParking: [],
    trafficCalming: [],
    highStressRoads: [],
    debug: [],
  };
}

function addPoints(bucket, latlngs, projection, options = {}) {
  if (!latlngs.length) return;
  const points = options.densify
    ? densifyLatLngs(latlngs, projection, options.stepM || DENSIFY_STEP_M)
    : latlngs.map((p) => ({ lat: p.lat, lng: p.lng, ...projection.toXY(p.lat, p.lng) }));
  bucket.push(...points);
}

function addCenterPoint(bucket, latlngs, projection, extra = {}) {
  const center = averageLatLng(latlngs);
  if (!center) return;
  bucket.push({ lat: center.lat, lng: center.lng, ...projection.toXY(center.lat, center.lng), ...extra });
}

function parseFeatures(osmJson, bbox) {
  const projection = makeProjection((bbox.north + bbox.south) / 2);
  const features = emptyFeatureBuckets();

  for (const el of osmJson.elements || []) {
    const tags = el.tags || {};
    const latlngs = elementLatLngs(el);
    if (!latlngs.length) continue;
    const isLinear = el.type === "way" && latlngs.length > 1;

    if (isPedestrianWay(tags)) addPoints(features.pedestrianNetwork, latlngs, projection, { densify: isLinear });
    if (isWalkableStreet(tags)) addPoints(features.walkableStreets, latlngs, projection, { densify: isLinear });
    if (tags.highway === "crossing" || tags.crossing) addPoints(features.crossings, latlngs.slice(0, 1), projection);
    const category = destinationCategory(tags);
    if (category) addCenterPoint(features.destinations, latlngs, projection, { category });
    if (isTransitStop(tags)) addPoints(features.transitStops, latlngs.slice(0, 1), projection);
    if (isGreenSpace(tags)) {
      addPoints(features.greenSpace, latlngs, projection, { densify: isLinear, stepM: 70 });
      addCenterPoint(features.greenSpace, latlngs, projection);
    }
    if (hasBikeInfra(tags)) addPoints(features.bikeNetwork, latlngs, projection, { densify: isLinear });
    if (isLowStressBikeStreet(tags)) addPoints(features.lowStressBikeStreets, latlngs, projection, { densify: isLinear });
    if (tags.amenity === "bicycle_parking") addCenterPoint(features.bikeParking, latlngs, projection);
    if (tags.traffic_calming) addPoints(features.trafficCalming, latlngs, projection, { densify: isLinear });
    if (isHighStressRoad(tags)) addPoints(features.highStressRoads, latlngs, projection, { densify: isLinear });

    if (isLinear && (isPedestrianWay(tags) || hasBikeInfra(tags) || isHighStressRoad(tags))) {
      features.debug.push({ latlngs, tags });
    }
  }

  return { features, projection };
}

function combineGroups(features, groups) {
  return groups.flatMap((group) => features[group] || []);
}

function matchesLayerCategories(candidate, categories) {
  return !categories?.length || categories.includes(candidate.category);
}

function buildSpatialIndex(candidates, radiusM) {
  const cellSizeM = clamp(radiusM / 2, 80, 260);
  const buckets = new Map();
  for (const candidate of candidates) {
    const xIndex = Math.floor(candidate.x / cellSizeM);
    const yIndex = Math.floor(candidate.y / cellSizeM);
    const key = `${xIndex}:${yIndex}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(candidate);
  }
  return { buckets, candidates, cellSizeM };
}

function candidatesWithin(point, source, radiusM) {
  if (!source || !source.candidates.length) return [];
  const range = Math.ceil(radiusM / source.cellSizeM);
  const centerX = Math.floor(point.x / source.cellSizeM);
  const centerY = Math.floor(point.y / source.cellSizeM);
  const radiusSquared = radiusM * radiusM;
  const found = [];

  for (let y = centerY - range; y <= centerY + range; y++) {
    for (let x = centerX - range; x <= centerX + range; x++) {
      const bucket = source.buckets.get(`${x}:${y}`);
      if (!bucket) continue;
      for (const candidate of bucket) {
        const dx = point.x - candidate.x;
        const dy = point.y - candidate.y;
        if ((dx * dx) + (dy * dy) <= radiusSquared) found.push(candidate);
      }
    }
  }

  return found;
}

function nearestDistanceWithin(point, source, radiusM) {
  const nearby = candidatesWithin(point, source, radiusM);
  if (!nearby.length) return Infinity;
  return nearestDistanceM(point, nearby);
}

function nearestDistanceM(point, candidates, stopAtM = 4) {
  if (!candidates.length) return Infinity;
  let best = Infinity;
  for (const c of candidates) {
    const dx = point.x - c.x;
    const dy = point.y - c.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) {
      best = d2;
      if (best <= stopAtM * stopAtM) break;
    }
  }
  return Math.sqrt(best);
}

function proximityScore(distanceM, radiusM) {
  if (!Number.isFinite(distanceM)) return 0;
  if (distanceM >= radiusM) return 0;
  const closeness = 1 - (distanceM / radiusM);
  return 100 * Math.pow(closeness, 1.35);
}

function avoidScore(distanceM, radiusM) {
  if (!Number.isFinite(distanceM)) return 100;
  return 100 - proximityScore(distanceM, radiusM);
}

function categoryAccessScore(point, source, radiusM) {
  if (!source.candidates.length) {
    return { score: 0, distance: Infinity, matchCount: 0 };
  }

  const nearby = candidatesWithin(point, source, radiusM);
  if (!nearby.length) {
    return { score: 0, distance: Infinity, matchCount: 0 };
  }

  const nearest = nearestDistanceM(point, nearby);
  const scores = nearby
    .map((candidate) => proximityScore(metersBetween(point, candidate), radiusM))
    .filter((score) => score > 0)
    .sort((a, b) => b - a);

  return {
    score: clamp(
      (scores[0] || 0) +
      ((scores[1] || 0) * 0.18) +
      ((scores[2] || 0) * 0.08) +
      ((scores[3] || 0) * 0.04),
      0,
      100
    ),
    distance: nearest,
    matchCount: scores.length,
  };
}

function destinationPortfolioScore(point, source, radiusM) {
  if (!source.candidates.length) {
    return { score: 0, distance: Infinity, categoryCount: 0 };
  }

  const nearby = candidatesWithin(point, source, radiusM);
  if (!nearby.length) {
    return { score: 0, distance: Infinity, categoryCount: 0 };
  }

  const nearest = nearestDistanceM(point, nearby);
  const categoryWeights = {
    groceries: 1.8,
    health: 1.0,
    food: 0.85,
    education: 0.75,
    civic: 0.65,
    shops: 0.6,
    retail: 0.5,
    fitness: 0.5,
    finance: 0.4,
    culture: 0.4,
    recreation: 0.35,
    community: 0.35,
  };
  const categoryScores = new Map();
  for (const candidate of nearby) {
    const distance = metersBetween(point, candidate);
    if (!candidate.category) continue;
    const score = proximityScore(distance, radiusM);
    if (score <= 0) continue;
    categoryScores.set(candidate.category, Math.max(categoryScores.get(candidate.category) || 0, score));
  }

  let weightedCategoryScore = 0;
  for (const [category, score] of categoryScores) {
    weightedCategoryScore += score * (categoryWeights[category] || 0.45);
  }

  return {
    score: clamp(weightedCategoryScore / 5.25, 0, 100),
    distance: nearest,
    categoryCount: categoryScores.size,
  };
}

function nearLayerScore(point, layer) {
  const distance = nearestDistanceWithin(point, layer.source, layer.radius);
  const score = proximityScore(distance, layer.radius);
  return {
    score: layer.maxScore ? Math.min(score, layer.maxScore) : score,
    distance,
  };
}

function walkNetworkScore(point, layer) {
  const pedestrian = nearLayerScore(point, layer);
  const streetDistance = nearestDistanceWithin(point, layer.fallbackSource, layer.radius * 0.8);
  const streetScore = Math.min(
    proximityScore(streetDistance, layer.radius * 0.8),
    layer.fallbackMaxScore || 45
  );
  return pedestrian.score >= streetScore
    ? pedestrian
    : { score: streetScore, distance: streetDistance };
}

function layerScore(point, layer) {
  if (layer.type === "categoryAccess") return categoryAccessScore(point, layer.source, layer.radius);
  if (layer.type === "destinationPortfolio") return destinationPortfolioScore(point, layer.source, layer.radius);
  if (layer.type === "walkNetwork") return walkNetworkScore(point, layer);
  return nearLayerScore(point, layer);
}

function generateGrid(bbox, projection, cellSizeM = SCORE_CELL_SIZE_M) {
  const minYIndex = latIndexForCell(bbox.south, cellSizeM);
  const maxYIndex = latIndexForCell(bbox.north - 1e-12, cellSizeM);
  const latCount = Math.max(1, maxYIndex - minYIndex + 1);
  let maxLngCount = 1;
  const grid = [];

  for (let yIndex = minYIndex; yIndex <= maxYIndex; yIndex++) {
    const lngStep = lngStepForCellRow(yIndex, cellSizeM);
    const minXIndex = Math.floor(bbox.west / lngStep);
    const maxXIndex = Math.floor((bbox.east - 1e-12) / lngStep);
    maxLngCount = Math.max(maxLngCount, maxXIndex - minXIndex + 1);
    for (let xIndex = minXIndex; xIndex <= maxXIndex; xIndex++) {
      const center = globalCellCenter(xIndex, yIndex, cellSizeM);
      grid.push({
        lat: center.lat,
        lng: center.lng,
        xIndex,
        yIndex,
        cellKey: globalCellKey(xIndex, yIndex, cellSizeM),
        cellSizeM,
        bounds: globalCellBounds(xIndex, yIndex, cellSizeM),
        ...projection.toXY(center.lat, center.lng),
        score: 0,
        components: [],
      });
    }
  }
  grid.meta = {
    bbox,
    gridType: "fixed",
    cellSizeM,
    lngCount: maxLngCount,
    latCount,
    minYIndex,
    maxYIndex,
  };
  return grid;
}

function scoreGrid(features, projection, bbox, activeLayerIds, cellSizeM = SCORE_CELL_SIZE_M) {
  const grid = generateGrid(bbox, projection, cellSizeM);
  const activeLayers = activeLayerIds
    .map((id) => {
      const definition = layerDefinitions[id];
      if (!definition) return null;
      const candidates = combineGroups(features, definition.groups)
        .filter((candidate) => matchesLayerCategories(candidate, definition.categories));
      return {
        id,
        ...definition,
        candidates,
        fallbackCandidates: combineGroups(features, definition.fallbackGroups || []),
      };
    })
    .map((layer) => {
      if (!layer) return null;
      return {
        ...layer,
        source: buildSpatialIndex(layer.candidates, layer.radius),
        fallbackSource: buildSpatialIndex(layer.fallbackCandidates, layer.radius),
      };
    })
    .filter(Boolean);

  if (!activeLayers.length) return grid.map((p) => ({ ...p, score: 0 }));

  for (const point of grid) {
    let weightedSum = 0;
    let totalWeight = 0;
    let comfortSum = 0;
    let comfortWeight = 0;
    let penaltyFactor = 1;
    const components = [];

    for (const layer of activeLayers) {
      const avoidLayer = layer.type === "avoid";
      const distance = avoidLayer ? nearestDistanceWithin(point, layer.source, layer.radius) : null;
      const result = avoidLayer
        ? { score: avoidScore(distance, layer.radius), distance }
        : layerScore(point, layer);
      const score = clamp(result.score, 0, 100);
      if (avoidLayer) {
        const stress = 1 - (score / 100);
        const maxPenalty = Math.min(0.6, 0.42 * layer.weight);
        penaltyFactor *= 1 - (stress * maxPenalty);
        comfortSum += score * layer.weight;
        comfortWeight += layer.weight;
      } else {
        weightedSum += score * layer.weight;
        totalWeight += layer.weight;
      }
      components.push({
        label: layer.label,
        score,
        distance: result.distance,
        type: layer.type,
        featureCount: layer.candidates.length,
        categoryCount: result.categoryCount,
        matchCount: result.matchCount,
      });
    }

    const baseScore = totalWeight > 0
      ? weightedSum / totalWeight
      : comfortWeight > 0
        ? comfortSum / comfortWeight
        : 0;
    point.score = clamp(totalWeight > 0 ? baseScore * penaltyFactor : baseScore, 0, 100);
    point.components = components;
  }

  return grid;
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

function scoreColor(score) {
  const stops = [
    { score: 0, color: [220, 38, 38] },
    { score: 35, color: [249, 115, 22] },
    { score: 55, color: [250, 204, 21] },
    { score: 80, color: [132, 204, 22] },
    { score: 100, color: [22, 163, 74] },
  ];
  const upperIndex = stops.findIndex((stop) => score <= stop.score);
  if (upperIndex <= 0) return rgb(stops[0].color);
  const lower = stops[upperIndex - 1];
  const upper = stops[upperIndex];
  const t = (score - lower.score) / (upper.score - lower.score);
  return rgb(lower.color.map((value, i) => Math.round(value + ((upper.color[i] - value) * t))));
}

function rgb(values) {
  return `rgb(${values[0]}, ${values[1]}, ${values[2]})`;
}

const ScoreGridLayer = L.Layer.extend({
  initialize(grid) {
    this.grid = grid;
  },

  onAdd(mapInstance) {
    this._map = mapInstance;
    this._canvas = L.DomUtil.create("canvas", "score-grid-layer leaflet-zoom-animated");
    this._canvas.style.opacity = "0.52";
    this._ctx = this._canvas.getContext("2d");
    mapInstance.getPanes().overlayPane.appendChild(this._canvas);
    mapInstance.on("moveend zoomend resize viewreset", this._reset, this);
    this._reset();
  },

  onRemove(mapInstance) {
    mapInstance.off("moveend zoomend resize viewreset", this._reset, this);
    L.DomUtil.remove(this._canvas);
    this._canvas = null;
    this._ctx = null;
  },

  _reset() {
    const size = this._map.getSize();
    const topLeft = this._map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(this._canvas, topLeft);
    this._canvas.width = size.x;
    this._canvas.height = size.y;
    this._redraw();
  },

  _redraw() {
    if (!this._ctx || !this.grid.length) return;
    const ctx = this._ctx;
    ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    ctx.globalAlpha = 1;

    for (const point of this.grid) {
      const bounds = scoreCellBounds(point, point.meta || this.grid.meta);
      const nw = this._map.latLngToContainerPoint([bounds.north, bounds.west]);
      const se = this._map.latLngToContainerPoint([bounds.south, bounds.east]);
      const x = Math.min(nw.x, se.x);
      const y = Math.min(nw.y, se.y);
      const width = Math.max(1, Math.abs(se.x - nw.x) + 1);
      const height = Math.max(1, Math.abs(se.y - nw.y) + 1);
      ctx.fillStyle = scoreColor(point.score);
      ctx.fillRect(x, y, width, height);
    }
  },
});

function scoreCellBounds(point, meta) {
  if (point.bounds) return point.bounds;
  if (meta?.gridType === "fixed" && Number.isFinite(point.xIndex) && Number.isFinite(point.yIndex)) {
    return globalCellBounds(point.xIndex, point.yIndex, point.cellSizeM || meta.cellSizeM || SCORE_CELL_SIZE_M);
  }
  const { bbox, lngCount, latCount } = meta;
  const latStep = (bbox.north - bbox.south) / latCount;
  const lngStep = (bbox.east - bbox.west) / lngCount;
  return {
    north: clamp(point.lat + (latStep / 2), bbox.south, bbox.north),
    south: clamp(point.lat - (latStep / 2), bbox.south, bbox.north),
    west: clamp(point.lng - (lngStep / 2), bbox.west, bbox.east),
    east: clamp(point.lng + (lngStep / 2), bbox.west, bbox.east),
  };
}

function estimateLegacyCellSizeM(meta) {
  if (!meta?.bbox) return SCORE_CELL_SIZE_M;
  const centerLat = (meta.bbox.north + meta.bbox.south) / 2;
  const west = toGlobalMeters(centerLat, meta.bbox.west);
  const east = toGlobalMeters(centerLat, meta.bbox.east);
  const south = toGlobalMeters(meta.bbox.south, meta.bbox.west);
  const north = toGlobalMeters(meta.bbox.north, meta.bbox.west);
  const widthM = Math.abs(east.x - west.x);
  const heightM = Math.abs(north.y - south.y);
  const lngCellM = widthM / Math.max(1, meta.lngCount || 1);
  const latCellM = heightM / Math.max(1, meta.latCount || 1);
  return Math.max(1, Math.min(lngCellM || SCORE_CELL_SIZE_M, latCellM || SCORE_CELL_SIZE_M));
}

function makeAreaId() {
  return `area:${Date.now()}:${Math.random().toString(36).slice(2, 9)}`;
}

function projectionCenterForBbox(bbox) {
  return (bbox.north + bbox.south) / 2;
}

function cloneBbox(bbox) {
  return {
    south: bbox.south,
    west: bbox.west,
    north: bbox.north,
    east: bbox.east,
  };
}

function compactComponents(components = []) {
  return components.map((component) => ({
    label: component.label,
    score: Number(component.score || 0),
    distance: Number.isFinite(component.distance) ? component.distance : null,
    type: component.type,
    featureCount: component.featureCount,
    categoryCount: component.categoryCount,
    matchCount: component.matchCount,
  }));
}

function serializeGrid(grid) {
  return grid.map((point) => ({
    lat: point.lat,
    lng: point.lng,
    xIndex: point.xIndex,
    yIndex: point.yIndex,
    cellKey: point.cellKey,
    cellSizeM: point.cellSizeM,
    bounds: point.bounds,
    score: point.score,
    components: compactComponents(point.components),
  }));
}

function normalizeGrid(grid, gridMeta, projectionCenterLat) {
  if (!Array.isArray(grid) || !gridMeta?.bbox) return null;
  const projection = makeProjection(projectionCenterLat);
  const normalized = grid.map((point) => ({
    lat: point.lat,
    lng: point.lng,
    xIndex: point.xIndex,
    yIndex: point.yIndex,
    cellKey: point.cellKey || (gridMeta.gridType === "fixed"
      ? globalCellKey(point.xIndex, point.yIndex, point.cellSizeM || gridMeta.cellSizeM || SCORE_CELL_SIZE_M)
      : null),
    cellSizeM: point.cellSizeM || gridMeta.cellSizeM || estimateLegacyCellSizeM(gridMeta),
    bounds: point.bounds || (gridMeta.gridType === "fixed"
      ? globalCellBounds(point.xIndex, point.yIndex, point.cellSizeM || gridMeta.cellSizeM || SCORE_CELL_SIZE_M)
      : null),
    score: point.score,
    components: (point.components || []).map((component) => ({
      ...component,
      distance: component.distance === null ? Infinity : component.distance,
    })),
    ...projection.toXY(point.lat, point.lng),
  }));
  normalized.meta = {
    bbox: cloneBbox(gridMeta.bbox),
    gridType: gridMeta.gridType || "legacy",
    cellSizeM: gridMeta.cellSizeM || estimateLegacyCellSizeM(gridMeta),
    lngCount: gridMeta.lngCount,
    latCount: gridMeta.latCount,
    minXIndex: gridMeta.minXIndex,
    maxXIndex: gridMeta.maxXIndex,
    minYIndex: gridMeta.minYIndex,
    maxYIndex: gridMeta.maxYIndex,
  };
  return normalized;
}

function normalizeStoredScoreArea(stored) {
  if (!stored?.grid?.length) return null;
  const gridMeta = stored.gridMeta || stored.grid.meta;
  if (!gridMeta?.bbox) return null;
  const projectionCenterLat = stored.projectionCenterLat || projectionCenterForBbox(gridMeta.bbox);
  const grid = normalizeGrid(stored.grid, gridMeta, projectionCenterLat);
  if (!grid) return null;
  return {
    id: stored.id || makeAreaId(),
    createdAt: stored.createdAt || Date.now(),
    bbox: cloneBbox(stored.bbox || gridMeta.bbox),
    grid,
    gridMeta: grid.meta,
    projectionCenterLat,
    layerIds: stored.layerIds || [],
    scanTileKeys: stored.scanTileKeys || [],
    stats: stored.stats || gridStats(grid),
  };
}

function serializeScoreArea(area) {
  return {
    id: area.id,
    createdAt: area.createdAt,
    bbox: cloneBbox(area.bbox),
    grid: serializeGrid(area.grid),
    gridMeta: area.grid.meta,
    projectionCenterLat: area.projectionCenterLat,
    layerIds: area.layerIds || [],
    scanTileKeys: area.scanTileKeys || [],
    stats: area.stats || gridStats(area.grid),
  };
}

function scanFromArea(area) {
  const keys = area.scanTileKeys || [];
  if (!keys.length) return null;

  const requests = [];
  const elementsByKey = new Map();
  let rawElementCount = 0;
  for (const key of keys) {
    const cached = scanCache.get(key);
    if (!cached?.osmJson) return null;
    requests.push({
      key: cached.key,
      bbox: cached.bbox,
      osmJson: cached.osmJson,
      elementCount: cached.elementCount,
    });
    for (const el of cached.osmJson.elements || []) {
      rawElementCount++;
      elementsByKey.set(`${el.type}/${el.id}`, el);
    }
  }

  return {
    osmJson: { elements: [...elementsByKey.values()] },
    requests,
    tileCount: requests.length,
    mode: requests.length === 1 ? "single" : "tiled",
    fetchedTileCount: 0,
    reusedTileCount: requests.length,
    rawElementCount,
    uniqueElementCount: elementsByKey.size,
  };
}

function createScoreArea(scored, scan, bbox, layerIds) {
  const grid = scored.grid;
  const gridMeta = grid.meta || { bbox, gridType: "fixed", cellSizeM: SCORE_CELL_SIZE_M, lngCount: 1, latCount: 1 };
  return {
    id: makeAreaId(),
    createdAt: Date.now(),
    bbox: cloneBbox(gridMeta.bbox || bbox),
    grid,
    gridMeta,
    projectionCenterLat: projectionCenterForBbox(gridMeta.bbox || bbox),
    layerIds: [...layerIds],
    scanTileKeys: (scan?.requests || []).map((request) => request.key),
    stats: gridStats(grid),
  };
}

function setLastArea(area, scan = null) {
  lastGrid = area.grid;
  lastProjection = makeProjection(area.projectionCenterLat);
  lastBbox = area.bbox;
  lastScan = scan || scanFromArea(area);
}

function cellResolutionM(point, area) {
  return point.cellSizeM || area.grid?.meta?.cellSizeM || area.gridMeta?.cellSizeM || estimateLegacyCellSizeM(area.grid?.meta || area.gridMeta);
}

function compositeCellForPoint(point, area) {
  const meta = area.grid?.meta || area.gridMeta;
  const bounds = scoreCellBounds(point, meta);
  return {
    ...point,
    bounds,
    meta,
    sourceAreaId: area.id,
    sourceCreatedAt: area.createdAt || 0,
    sourceResolutionM: cellResolutionM(point, area),
  };
}

function clearDraftLayer() {
  if (!draftArea) return;
  draftArea = null;
  renderScoreAreas();
}

function showDraftGrid(grid) {
  draftArea = {
    id: "draft",
    createdAt: Date.now() + 1,
    bbox: cloneBbox(grid.meta.bbox),
    grid,
    gridMeta: grid.meta,
    projectionCenterLat: projectionCenterForBbox(grid.meta.bbox),
    layerIds: selectedLayerIds(),
    scanTileKeys: [],
    stats: gridStats(grid),
    transient: true,
  };
  renderScoreAreas();
}

function buildCompositeGrid() {
  const keyedCells = new Map();
  const unkeyedCells = [];
  for (const area of [...scoreAreas, ...(draftArea ? [draftArea] : [])]) {
    for (const point of area.grid || []) {
      const cell = compositeCellForPoint(point, area);
      if (!cell.cellKey) {
        unkeyedCells.push(cell);
        continue;
      }
      const existing = keyedCells.get(cell.cellKey);
      if (!existing || compositeCellWins(cell, existing)) keyedCells.set(cell.cellKey, cell);
    }
  }

  const cells = [...unkeyedCells, ...keyedCells.values()];
  cells.sort((a, b) => {
    const resolutionDelta = (b.sourceResolutionM || SCORE_CELL_SIZE_M) - (a.sourceResolutionM || SCORE_CELL_SIZE_M);
    if (Math.abs(resolutionDelta) > 1) return resolutionDelta;
    return (a.sourceCreatedAt || 0) - (b.sourceCreatedAt || 0);
  });
  cells.meta = { composite: true };
  return cells;
}

function compositeCellWins(candidate, existing) {
  const resolutionDelta = (existing.sourceResolutionM || SCORE_CELL_SIZE_M) - (candidate.sourceResolutionM || SCORE_CELL_SIZE_M);
  if (Math.abs(resolutionDelta) > 1) return resolutionDelta > 0;
  return (candidate.sourceCreatedAt || 0) >= (existing.sourceCreatedAt || 0);
}

function renderScoreAreas() {
  if (compositeLayer) {
    map.removeLayer(compositeLayer);
    compositeLayer = null;
  }
  compositeGrid = buildCompositeGrid();
  if (overlayVisible && compositeGrid.length) {
    compositeLayer = new ScoreGridLayer(compositeGrid).addTo(map);
  }
  updateOverlayButton();
}

function updateOverlayButton() {
  if (!toggleOverlayButton) return;
  toggleOverlayButton.textContent = overlayVisible ? "Hide overlay" : "Show overlay";
  toggleOverlayButton.setAttribute("aria-pressed", String(!overlayVisible));
}

function setOverlayVisible(visible) {
  overlayVisible = visible;
  localStorage.setItem(OVERLAY_VISIBLE_KEY, String(overlayVisible));
  renderScoreAreas();
  closeScorePopup();
  setStatus(
    overlayVisible
      ? `Overlay shown. ${scoreAreas.length.toLocaleString()} saved gradient area${scoreAreas.length === 1 ? "" : "s"} visible.`
      : `Overlay hidden. ${scoreAreas.length.toLocaleString()} saved gradient area${scoreAreas.length === 1 ? "" : "s"} kept.`
  );
}

function addScoreArea(area) {
  scoreAreas.push(area);
  setLastArea(area);
  persistScoreArea(area);
  renderScoreAreas();
  return area;
}

function updateScoreArea(area, scored, scan, layerIds) {
  area.grid = scored.grid;
  area.gridMeta = scored.grid.meta;
  area.bbox = cloneBbox(scored.grid.meta.bbox);
  area.projectionCenterLat = projectionCenterForBbox(area.bbox);
  area.layerIds = [...layerIds];
  area.scanTileKeys = (scan?.requests || area.scanTileKeys || []).map((request) => request.key || request);
  area.stats = gridStats(area.grid);
  setLastArea(area, scan);
  persistScoreArea(area);
  renderScoreAreas();
  return area;
}

function renderFeatureLayer(parsed) {
  featureLayer.clearLayers();
  if (!showFeaturesEl.checked || !parsed) return;

  const { features } = parsed;
  addPointLayer(features.crossings, "Crossing", "#2563eb", 3);
  addPointLayer(features.destinations, "Destination", "#7c3aed", 3);
  addPointLayer(features.transitStops, "Transit stop", "#0284c7", 4);
  addPointLayer(features.bikeParking, "Bike parking", "#0f766e", 4);
  addPointLayer(features.trafficCalming, "Traffic calming", "#f59e0b", 3);

  for (const line of features.debug.slice(0, 600)) {
    const tags = line.tags || {};
    let color = "#64748b";
    let label = tags.highway || "way";
    if (hasBikeInfra(tags)) { color = "#059669"; label = "bike infra"; }
    if (isPedestrianWay(tags)) { color = "#2563eb"; label = "pedestrian"; }
    if (isHighStressRoad(tags)) { color = "#dc2626"; label = "high-stress road"; }
    L.polyline(line.latlngs.map((p) => [p.lat, p.lng]), {
      color,
      weight: 3,
      opacity: 0.65,
      className: "source-line",
    }).bindPopup(`<strong>${label}</strong><br>${escapeHtml(tags.name || "unnamed")}`).addTo(featureLayer);
  }
}

function addPointLayer(points, label, color, radius) {
  for (const point of points.slice(0, 500)) {
    L.circleMarker([point.lat, point.lng], {
      radius,
      color,
      fillColor: color,
      fillOpacity: 0.75,
      weight: 1,
      className: "source-point",
    }).bindPopup(label).addTo(featureLayer);
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
}

function summarizeFeatures(features) {
  const destinationTypes = new Set(features.destinations.map((point) => point.category).filter(Boolean)).size;
  const destinationCounts = features.destinations.reduce((counts, point) => {
    if (point.category) counts[point.category] = (counts[point.category] || 0) + 1;
    return counts;
  }, {});
  const names = [
    ["walk paths/sidewalks", features.pedestrianNetwork.length],
    ["crossing points", features.crossings.length],
    [`destinations across ${destinationTypes} types`, features.destinations.length],
    ["grocery destinations", destinationCounts.groceries || 0],
    ["fitness destinations", destinationCounts.fitness || 0],
    ["transit stops", features.transitStops.length],
    ["bike-network points", features.bikeNetwork.length],
    ["low-stress street points", features.lowStressBikeStreets.length],
    ["high-stress road points", features.highStressRoads.length],
  ];
  return names.map(([name, count]) => `${count.toLocaleString()} ${name}`).join("\n");
}

function clearGradientOverlay() {
  closeScorePopup();
  draftArea = null;
  if (compositeLayer) {
    map.removeLayer(compositeLayer);
    compositeLayer = null;
  }
  scoreAreas = [];
  compositeGrid = [];
  lastGrid = [];
  renderScoreAreas();
  clearStore(SCORE_AREAS_STORE);
}

function gridStats(grid) {
  if (!grid.length) return { avg: 0, min: 0, max: 0 };
  const sum = grid.reduce((total, point) => total + point.score, 0);
  return {
    avg: sum / grid.length,
    max: Math.max(...grid.map((point) => point.score)),
    min: Math.min(...grid.map((point) => point.score)),
  };
}

function applyScoredResult(scored, scan, heading, options = {}) {
  const parsed = scored.parsed;
  lastFeatures = parsed;
  lastProjection = parsed.projection;
  renderFeatureLayer(parsed);

  setStatus("Drawing the gradient overlay...");
  clearDraftLayer();
  const area = options.area
    ? updateScoreArea(options.area, scored, scan || scanFromArea(options.area), options.layerIds || options.area.layerIds || [])
    : addScoreArea(createScoreArea(scored, scan, options.bbox || scored.grid.meta.bbox, options.layerIds || selectedLayerIds()));

  const stats = area.stats;
  const scanRequestLine = scan
    ? `Scan requests: ${scan.tileCount} total, ${scan.fetchedTileCount} new, ${scan.reusedTileCount} reused from this browser.\n`
    : "";
  setStatus(
    `${heading}\nAverage score: ${stats.avg.toFixed(1)} / 100\nRange: ${stats.min.toFixed(1)}-${stats.max.toFixed(1)}\n` +
    `Scoring: ${scored.usedWorker ? "background worker" : "main thread fallback"} (${Math.round(scored.elapsedMs).toLocaleString()} ms).\n` +
    (scored.cache ? `Parsed cache: ${scored.cache.tileHits} reused, ${scored.cache.tileMisses} parsed.\n` : "") +
    scanRequestLine +
    `Saved gradients: ${scoreAreas.length.toLocaleString()} area${scoreAreas.length === 1 ? "" : "s"}.\n` +
    `Browser cache: ${scanCache.size} saved scan request${scanCache.size === 1 ? "" : "s"}.\n\nFeatures used:\n${summarizeFeatures(parsed.features)}`
  );
}

function scheduleRescoreFromLastScan(reason = "Layer selection changed.") {
  window.clearTimeout(rescoreTimer);
  rescoreTimer = window.setTimeout(() => {
    rescoreFromLastScan(reason);
  }, 180);
}

async function rescoreFromLastScan(reason = "Layer selection changed.") {
  await persistentCacheReady;
  const ids = selectedLayerIds();

  if (!ids.length) {
    if (activeScoreController) {
      activeScoreController.abort();
      activeScoreController = null;
    }
    clearDraftLayer();
    setStatus("Select at least one scoring layer to draw a gradient.", "warn");
    return;
  }

  const areasToRescore = scoreAreas.filter((area) => scanFromArea(area));
  if (!areasToRescore.length && (!lastScan || !lastBbox)) {
    return;
  }

  if (activeFetchController) {
    setStatus("Current scan is still loading. Layer changes will be used when it finishes.");
    return;
  }

  if (activeScoreController) activeScoreController.abort();
  const scoreController = new AbortController();
  activeScoreController = scoreController;
  scoreButton.disabled = true;
  setStatus(`${reason}\nRe-scoring saved gradient area${areasToRescore.length === 1 ? "" : "s"} without another Overpass request...`);

  try {
    if (areasToRescore.length) {
      let latestScored = null;
      let latestScan = null;
      let latestArea = null;
      for (const [index, area] of areasToRescore.entries()) {
        if (scoreController.signal.aborted) throw new DOMException("Scoring aborted", "AbortError");
        const scan = scanFromArea(area);
        setStatus(
          `${reason}\nRe-scoring saved gradient ${index + 1} of ${areasToRescore.length} without another Overpass request...`
        );
        const scored = await scoreOsmData(scan, area.bbox, ids, scoreController.signal);
        clearDraftLayer();
        updateScoreArea(area, scored, scan, ids);
        latestScored = scored;
        latestScan = scan;
        latestArea = area;
      }
      if (latestScored && latestArea) {
        lastFeatures = latestScored.parsed;
        lastProjection = latestScored.parsed.projection;
        renderFeatureLayer(latestScored.parsed);
        applyScoredResult(latestScored, latestScan, "Saved gradients updated.", { area: latestArea, layerIds: ids });
      }
    } else {
      const scored = await scoreOsmData(lastScan, lastBbox, ids, scoreController.signal);
      applyScoredResult(scored, lastScan, "Gradient updated from the saved scan.", { bbox: lastBbox, layerIds: ids });
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      setStatus(err.message || "Something went wrong while re-scoring.", "error");
    }
  } finally {
    if (activeScoreController === scoreController) activeScoreController = null;
    if (!activeFetchController && !activeScoreController) scoreButton.disabled = false;
  }
}

async function calculate() {
  await persistentCacheReady;
  const ids = selectedLayerIds();
  if (!ids.length) {
    setStatus("Select at least one scoring layer first.", "warn");
    return;
  }

  const bbox = getBbox();
  const scanPlan = scanTilesForBbox(bbox);
  if (scanPlanTooLarge(scanPlan)) {
    setStatus(`This view needs ${scanPlan.tiles.length} fixed ${SCAN_TILE_LABEL} scan requests, which is larger than the city-sized limit of ${MAX_SCAN_TILES}. Zoom in a bit and calculate again.`, "warn");
    return;
  }

  window.clearTimeout(rescoreTimer);
  if (activeFetchController) activeFetchController.abort();
  if (activeScoreController) {
    activeScoreController.abort();
    activeScoreController = null;
  }
  const fetchController = new AbortController();
  activeFetchController = fetchController;
  scoreButton.disabled = true;
  setStatus(scanPlan.mode === "single"
    ? "Preparing one padded Overpass request for the visible area…"
    : `Preparing ${scanPlan.tiles.length} fixed ${SCAN_TILE_LABEL} scan requests for the visible area…`);

  try {
    const scan = await scanOsmData(bbox, fetchController.signal);
    const elementSummary = scan.uniqueElementCount === null
      ? `${scan.rawElementCount.toLocaleString()} OSM element references`
      : `${scan.uniqueElementCount.toLocaleString()} unique OSM elements`;
    setStatus(
      `Loaded ${elementSummary} from ${scan.tileCount} scan request${scan.tileCount === 1 ? "" : "s"}.\n` +
      `${scan.fetchedTileCount} new request${scan.fetchedTileCount === 1 ? "" : "s"} fetched; ${scan.reusedTileCount} reused from this browser.\n` +
      `Building feature buckets and scoring in ${canUseScoringWorker() ? "a background worker" : "the main thread"}…`
    );
    lastScan = scan;
    lastBbox = bbox;

    const scoreIds = selectedLayerIds();
    if (!scoreIds.length) {
      clearDraftLayer();
      setStatus("Scan loaded and saved in this browser. Select at least one scoring layer to draw a gradient.", "warn");
      return;
    }

    const scored = await scoreOsmData(scan, bbox, scoreIds, fetchController.signal);
    applyScoredResult(scored, scan, "Gradient complete.", { bbox, layerIds: scoreIds });
  } catch (err) {
    if (err.name === "AbortError") return;
    setStatus(err.message || "Something went wrong while calculating.", "error");
  } finally {
    if (activeFetchController === fetchController) {
      activeFetchController = null;
      if (!activeScoreController) scoreButton.disabled = false;
    }
  }
}

function clearMap() {
  window.clearTimeout(rescoreTimer);
  if (activeFetchController) {
    activeFetchController.abort();
    activeFetchController = null;
    terminateScoringWorker();
  }
  if (activeScoreController) {
    activeScoreController.abort();
    activeScoreController = null;
  }
  clearGradientOverlay();
  featureLayer.clearLayers();
  lastFeatures = null;
  lastProjection = null;
  lastScan = null;
  lastBbox = null;
  setStatus(`Cleared saved gradient overlays. ${scanCache.size} scan request${scanCache.size === 1 ? "" : "s"} remain cached in this browser.`);
}

function nearestGridPoint(latlng) {
  if (!overlayVisible || !compositeGrid.length) return null;

  for (let i = compositeGrid.length - 1; i >= 0; i--) {
    const point = compositeGrid[i];
    if (boundsContainsLatLng(point.bounds || scoreCellBounds(point, point.meta), latlng)) {
      const d = distanceLatLngM(latlng, point);
      return { point, area: scoreAreas.find((area) => area.id === point.sourceAreaId) || null, distance: d };
    }
  }

  const clickMeters = toGlobalMeters(latlng.lat, latlng.lng);
  let bestDist = Infinity;
  let best = null;
  for (let i = compositeGrid.length - 1; i >= 0; i--) {
    const point = compositeGrid[i];
    const pointMeters = toGlobalMeters(point.lat, point.lng);
    const dx = clickMeters.x - pointMeters.x;
    const dy = clickMeters.y - pointMeters.y;
    const d = Math.sqrt((dx * dx) + (dy * dy));
    if (d < bestDist) {
      bestDist = d;
      best = { point, area: scoreAreas.find((area) => area.id === point.sourceAreaId) || null };
    }
  }
  return best ? { ...best, distance: bestDist } : null;
}

function boundsContainsLatLng(bounds, latlng) {
  if (!bounds) return false;
  return latlng.lat >= bounds.south &&
    latlng.lat <= bounds.north &&
    latlng.lng >= bounds.west &&
    latlng.lng <= bounds.east;
}

function distanceLatLngM(a, b) {
  const aMeters = toGlobalMeters(a.lat, a.lng);
  const bMeters = toGlobalMeters(b.lat, b.lng);
  const dx = aMeters.x - bMeters.x;
  const dy = aMeters.y - bMeters.y;
  return Math.sqrt((dx * dx) + (dy * dy));
}

function closeScorePopup() {
  if (!scorePopup) return;
  map.closePopup(scorePopup);
  scorePopup = null;
}

function inspectScore(e) {
  if (!clickInspectEl.checked || !compositeGrid.length || !overlayVisible) return;
  const found = nearestGridPoint(e.latlng);
  if (!found) return;
  const { point } = found;
  const rows = point.components
    .map((c) => {
      const dist = Number.isFinite(c.distance) ? `${Math.round(c.distance)} m` : "no data";
      const detail = c.categoryCount !== undefined
        ? `${dist}; ${c.categoryCount} types`
        : c.matchCount !== undefined
          ? `${dist}; ${c.matchCount} matches`
          : dist;
      return `<tr><td>${escapeHtml(c.label)}</td><td>${c.score.toFixed(0)}</td><td>${detail}</td></tr>`;
    })
    .join("");

  closeScorePopup();
  const popup = L.popup({ className: "score-inspect-popup", autoPan: false })
    .setLatLng([point.lat, point.lng])
    .setContent(`
      <div class="score-popup">
        <strong>Score: ${point.score.toFixed(1)} / 100</strong>
        <table>
          <thead><tr><th>Layer</th><th>Score</th><th>Nearest</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `)
    .openOn(map);
  scorePopup = popup;
  popup.on("remove", () => {
    if (scorePopup === popup) scorePopup = null;
  });
}

scoreButton.addEventListener("click", calculate);
clearButton.addEventListener("click", clearMap);
toggleOverlayButton?.addEventListener("click", () => setOverlayVisible(!overlayVisible));
showFeaturesEl.addEventListener("change", () => renderFeatureLayer(lastFeatures));
map.on("click", inspectScore);
map.on("dragstart", closeScorePopup);

map.on("moveend", () => {
  if (scoreAreas.length) {
    setStatus("Map moved. Click Calculate gradient again to add this visible area. Saved gradients and scan requests will be reused when possible.", "warn");
  }
});

document.querySelectorAll(".score-layer").forEach((el) => {
  el.addEventListener("change", () => scheduleRescoreFromLastScan("Layer selection changed."));
});

document.getElementById("presetWalk").addEventListener("click", () => {
  setSelectedLayers(walkPreset);
  scheduleRescoreFromLastScan("Walkability preset applied.");
});
document.getElementById("presetBike").addEventListener("click", () => {
  setSelectedLayers(bikePreset);
  scheduleRescoreFromLastScan("Bikability preset applied.");
});
document.getElementById("presetBoth").addEventListener("click", () => {
  setSelectedLayers([...walkPreset, ...bikePreset]);
  scheduleRescoreFromLastScan("Combined preset applied.");
});
document.getElementById("presetClear").addEventListener("click", () => {
  setSelectedLayers([]);
  scheduleRescoreFromLastScan("Layer selection cleared.");
});

updateOverlayButton();
persistentCacheReady = hydratePersistentCaches().catch((err) => {
  console.warn("Persistent cache restore failed.", err);
});
