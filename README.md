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
4. Uses fixed 5 km scan tiles only for larger areas, and keeps scan results in memory while the tab is open.
5. Converts selected walking/biking layers into feature buckets.
6. Parses features and scores a physically even grid of map points from 0 to 100, using a Web Worker when served over HTTP.
7. Renders a red-to-green score overlay directly from those scores.

## Current scoring layers

Walking:

- walking network: sidewalks, footways, paths, pedestrian ways, walkable streets
- crossings
- nearby destinations: proximity plus diversity across groceries, food, healthcare, education, civic, retail, culture, and related categories
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

For production use, consider:

- hosting your own tiles or using a commercial tile provider
- caching Overpass responses or importing OSM data into PostGIS
- replacing the simple distance model with a routable network model
- calibrating weights against local policy goals or survey data
- adding official municipal open data for sidewalks, traffic volumes, collisions, speed limits, cycling facilities, and transit frequency
