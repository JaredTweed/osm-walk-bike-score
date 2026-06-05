const EARTH_RADIUS_M = 6371008.8;
const DENSIFY_STEP_M = 45;
const GRID_TARGET_POINTS = 42;
const DRAFT_GRID_TARGET_POINTS = 18;

let layerDefinitions = {};
const tileElementKeysCache = new Map();
const elementFeatureCache = new Map();

self.addEventListener("message", (event) => {
  const message = event.data || {};
  if (message.type !== "score") return;

  const startedAt = performance.now();
  layerDefinitions = message.layerDefinitions || {};

  try {
    self.postMessage({
      type: "progress",
      jobId: message.jobId,
      message: "Building cached feature buckets in a background worker...",
    });
    const parsed = message.scanRequests
      ? parseFeaturesFromScanRequests(message.scanRequests, message.bbox)
      : parseFeatures(message.osmJson, message.bbox);

    self.postMessage({
      type: "progress",
      jobId: message.jobId,
      message: "Scoring a fast draft grid in a background worker...",
    });
    const draftGrid = scoreGrid(parsed.features, parsed.projection, message.bbox, message.activeLayerIds, DRAFT_GRID_TARGET_POINTS);
    self.postMessage({
      type: "partial",
      jobId: message.jobId,
      projectionCenterLat: parsed.projectionCenterLat,
      grid: draftGrid,
      gridMeta: draftGrid.meta,
    });

    self.postMessage({
      type: "progress",
      jobId: message.jobId,
      message: "Refining the full-resolution grid in a background worker...",
    });
    const grid = scoreGrid(parsed.features, parsed.projection, message.bbox, message.activeLayerIds, GRID_TARGET_POINTS);
    const gridMeta = grid.meta;

    self.postMessage({
      type: "result",
      jobId: message.jobId,
      features: parsed.features,
      projectionCenterLat: parsed.projectionCenterLat,
      grid,
      gridMeta,
      elapsedMs: performance.now() - startedAt,
      cache: parsed.cache || null,
      parsedScanKeys: parsed.parsedScanKeys || [],
    });
  } catch (err) {
    self.postMessage({
      type: "error",
      jobId: message.jobId,
      message: err.message || "Worker scoring failed.",
    });
  }
});

function parseFeaturesFromScanRequests(scanRequests, bbox) {
  const projectionCenterLat = (bbox.north + bbox.south) / 2;
  const projection = makeProjection(projectionCenterLat);
  const elementKeys = new Set();
  let tileHits = 0;
  let tileMisses = 0;
  let elementHits = 0;
  let elementMisses = 0;
  const parsedScanKeys = [];

  for (const request of scanRequests || []) {
    if (tileElementKeysCache.has(request.key)) {
      tileHits++;
      for (const key of tileElementKeysCache.get(request.key)) elementKeys.add(key);
      parsedScanKeys.push(request.key);
      continue;
    }

    if (!request.osmJson) {
      throw new Error("A cached scan request was not available in the worker.");
    }

    tileMisses++;
    const tileKeys = [];
    for (const el of request.osmJson.elements || []) {
      const key = `${el.type}/${el.id}`;
      tileKeys.push(key);
      elementKeys.add(key);
      if (elementFeatureCache.has(key)) {
        elementHits++;
      } else {
        const feature = parseElementFeature(el);
        if (feature) {
          elementFeatureCache.set(key, feature);
          elementMisses++;
        }
      }
    }
    tileElementKeysCache.set(request.key, tileKeys);
    parsedScanKeys.push(request.key);
  }

  const normalized = emptyFeatureBuckets();
  for (const key of elementKeys) {
    const feature = elementFeatureCache.get(key);
    if (!feature) continue;
    mergeFeatureBuckets(normalized, feature);
  }

  return {
    features: projectFeatureBuckets(normalized, projection),
    projection,
    projectionCenterLat,
    cache: { tileHits, tileMisses, elementHits, elementMisses },
    parsedScanKeys,
  };
}

function parseElementFeature(el) {
  const tags = el.tags || {};
  const latlngs = elementLatLngs(el);
  if (!latlngs.length) return null;

  const feature = emptyFeatureBuckets();
  const center = averageLatLng(latlngs);
  const projection = makeProjection(center?.lat || latlngs[0].lat);
  const isLinear = el.type === "way" && latlngs.length > 1;

  if (isPedestrianWay(tags)) addLatLngPoints(feature.pedestrianNetwork, latlngs, projection, { densify: isLinear });
  if (isWalkableStreet(tags)) addLatLngPoints(feature.walkableStreets, latlngs, projection, { densify: isLinear });
  if (tags.highway === "crossing" || tags.crossing) addLatLngPoints(feature.crossings, latlngs.slice(0, 1), projection);
  const category = destinationCategory(tags);
  if (category) addLatLngCenterPoint(feature.destinations, latlngs, { category });
  if (isTransitStop(tags)) addLatLngPoints(feature.transitStops, latlngs.slice(0, 1), projection);
  if (isGreenSpace(tags)) {
    addLatLngPoints(feature.greenSpace, latlngs, projection, { densify: isLinear, stepM: 70 });
    addLatLngCenterPoint(feature.greenSpace, latlngs);
  }
  if (hasBikeInfra(tags)) addLatLngPoints(feature.bikeNetwork, latlngs, projection, { densify: isLinear });
  if (isLowStressBikeStreet(tags)) addLatLngPoints(feature.lowStressBikeStreets, latlngs, projection, { densify: isLinear });
  if (tags.amenity === "bicycle_parking") addLatLngCenterPoint(feature.bikeParking, latlngs);
  if (tags.traffic_calming) addLatLngPoints(feature.trafficCalming, latlngs, projection, { densify: isLinear });
  if (isHighStressRoad(tags)) addLatLngPoints(feature.highStressRoads, latlngs, projection, { densify: isLinear });

  if (isLinear && (isPedestrianWay(tags) || hasBikeInfra(tags) || isHighStressRoad(tags))) {
    feature.debug.push({ latlngs, tags });
  }

  return feature;
}

function mergeFeatureBuckets(target, source) {
  for (const key of Object.keys(target)) {
    if (!Array.isArray(source[key]) || !source[key].length) continue;
    target[key].push(...source[key]);
  }
}

function projectFeatureBuckets(normalized, projection) {
  const features = emptyFeatureBuckets();
  for (const [key, values] of Object.entries(normalized)) {
    if (key === "debug") {
      features.debug.push(...values);
      continue;
    }
    for (const point of values) {
      features[key].push({ ...point, ...projection.toXY(point.lat, point.lng) });
    }
  }
  return features;
}

function addLatLngPoints(bucket, latlngs, projection, options = {}) {
  if (!latlngs.length) return;
  const points = options.densify
    ? densifyLatLngPoints(latlngs, projection, options.stepM || DENSIFY_STEP_M)
    : latlngs.map((p) => ({ lat: p.lat, lng: p.lng }));
  bucket.push(...points);
}

function addLatLngCenterPoint(bucket, latlngs, extra = {}) {
  const center = averageLatLng(latlngs);
  if (!center) return;
  bucket.push({ lat: center.lat, lng: center.lng, ...extra });
}

function densifyLatLngPoints(latlngs, projection, stepM = DENSIFY_STEP_M) {
  return densifyLatLngs(latlngs, projection, stepM)
    .map((point) => ({ lat: point.lat, lng: point.lng }));
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
  const projectionCenterLat = (bbox.north + bbox.south) / 2;
  const projection = makeProjection(projectionCenterLat);
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

  return { features, projection, projectionCenterLat };
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

function generateGrid(bbox, projection, targetPoints = GRID_TARGET_POINTS) {
  const sw = projection.toXY(bbox.south, bbox.west);
  const se = projection.toXY(bbox.south, bbox.east);
  const nw = projection.toXY(bbox.north, bbox.west);
  const widthM = Math.max(1, Math.abs(se.x - sw.x));
  const heightM = Math.max(1, Math.abs(nw.y - sw.y));
  const lngCount = targetPoints;
  const latCount = clamp(Math.round((lngCount * heightM) / widthM), Math.max(10, Math.round(targetPoints * 0.45)), Math.max(24, Math.round(targetPoints * 1.7)));
  const grid = [];

  for (let y = 0; y <= latCount; y++) {
    const lat = bbox.south + ((bbox.north - bbox.south) * y) / latCount;
    for (let x = 0; x <= lngCount; x++) {
      const lng = bbox.west + ((bbox.east - bbox.west) * x) / lngCount;
      grid.push({ lat, lng, xIndex: x, yIndex: y, ...projection.toXY(lat, lng), score: 0, components: [] });
    }
  }
  grid.meta = { bbox, lngCount, latCount };
  return grid;
}

function scoreGrid(features, projection, bbox, activeLayerIds, targetPoints = GRID_TARGET_POINTS) {
  const grid = generateGrid(bbox, projection, targetPoints);
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
