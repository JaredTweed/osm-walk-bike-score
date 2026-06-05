# OSM Walkability + Bikability Gradient Prototype

This is a static browser-based prototype that scores the visible map area using OpenStreetMap tags and draws a gradient overlay.

## How to run

Open `index.html` in a browser, or serve the folder locally:

```bash
python3 -m http.server 8000
```

Then visit:

```text
http://localhost:8000
```

## What it does

1. Uses Leaflet for the map.
2. Uses OpenStreetMap raster tiles for the base map.
3. Fetches one padded Overpass scan for the visible map area when it fits public-service limits.
4. Uses fixed 1.7 km scan tiles only for larger areas, and keeps scan results in the browser cache.
5. Converts selected walking/biking layers into cached feature buckets.
6. Keeps completed gradient areas visible together instead of replacing older calculations.
7. Saves completed gradients and scan tiles in IndexedDB so they can restore after restarting the browser.
8. Re-scores saved scans automatically when layer checkboxes change, without another Overpass request when the cached scan tiles are available.
9. Parses features and scores a physically even grid of map points from 0 to 100, using a Web Worker when served over HTTP.
10. Renders a coarse draft gradient first, then replaces it with the full-resolution result.

## Current scoring layers

Walking:

- walking network: sidewalks, footways, paths, pedestrian ways, walkable streets
- crossings
- groceries: high-priority walking access to supermarkets, convenience stores, bakeries, butchers, greengrocers, and related food shops
- daily destinations: proximity plus diversity across groceries, food, healthcare, education, civic, retail, fitness, culture, and related categories
- gyms / fitness: optional access layer for fitness centres, gyms, sports centres, and fitness stations
- transit stops
- parks / green space
- avoiding high-stress roads

Biking:

- bike lanes / cycleways
- low-stress streets
- bike parking
- traffic calming
- parks / trails
- avoiding high-stress roads

## Important limitations

This is not an official accessibility, safety, or transportation model. It does not currently account for:

- sidewalk width or condition
- curb cuts
- lighting
- slope / hills
- winter maintenance
- collision history
- traffic volume
- protected-vs-painted lane quality beyond basic OSM tags
- signal timing
- subjective comfort
- missing or incorrectly tagged OSM data
- very large scans beyond a city-sized view; those are still blocked to avoid overloading public Overpass service
- faster CPU scoring requires serving the app over HTTP; direct `file://` loading falls back to main-thread scoring because browsers often block local Web Workers
- public Overpass requests remain serial by design to avoid rate-limit slowdowns

For production use, consider:

- hosting your own tiles or using a commercial tile provider
- caching Overpass responses or importing OSM data into PostGIS
- replacing the built-in public Overpass endpoint with a local Overpass instance or an Overpass-compatible proxy backed by imported OSM data
- replacing the simple distance model with a routable network model
- calibrating weights against local policy goals or survey data
- adding official municipal open data for sidewalks, traffic volumes, collisions, speed limits, cycling facilities, and transit frequency
