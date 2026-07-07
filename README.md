# Haunted Points

A browser-based instrument for haunting 3D scans with data.

A point-cloud scan of an organic form (a leaf) is displaced by datasets that
describe the place it came from — an audio recording of the site, and hourly
ERA5 climate reanalysis for its coordinates. The result is an ephemeral,
data-troubled object: the unwitting weight of the Stack made visible on nature.

## What it does
- load a `.ply` point cloud (ASCII or binary, with or without colours)
- true 3D preview (Three.js): orbit, pan, zoom, point size, density
- compute per-point edge strength (WASM core with JS fallback) so haunting
  concentrates on edges, veins and silhouettes
- **audio dataset**: decode any audio file, extract the amplitude envelope and
  low / mid / high frequency bands, and sweep the signal across the cloud along
  a chosen axis; a slider sets how strongly audio drives the points
- **climate dataset (ERA5)**: fetch hourly reanalysis for the scan's lat/lon —
  temperature, wind speed + direction, humidity, precipitation, pressure, soil
  moisture, solar radiation — and scrub or play through time on the timeline;
  the chosen variable scales displacement (wind vector mode also pushes the
  cloud downwind)
- export the displaced point cloud as `.ply` at any timeline moment, with
  provenance comments (scan, audio file, climate variable, timestamp) baked
  into the header

## Files
- `index.html` — the whole app (open it in a browser; needs internet for the
  Three.js CDN and the climate fetch)
- `edge.ts` — AssemblyScript source of the WASM edge-detection core
- `fetch_era5_cds.py` — optional: fetch ERA5 directly from the Copernicus
  Climate Data Store with your CDS API key and convert it to the JSON the app
  loads (Climate panel → "load CDS JSON")
- `kinect_bridge.py` — optional: stream a live Kinect v2 point cloud into the
  app over a local WebSocket for on-location scanning

## Live scanning (Kinect v2)
1. On the machine with the Kinect: install the Kinect for Windows SDK 2.0,
   then `pip install pykinect2 numpy websockets`.
2. `python kinect_bridge.py` (options: `--stride`, `--near`, `--far`,
   `--mirror`; use `--fake` to test the whole path with no hardware).
3. In the app's Live scan panel hit **connect** — the cloud streams in live
   with displacement, audio and climate layers applied on top. Edge scores
   refresh every few seconds while streaming.
4. **freeze frame** captures the current frame and runs the full edge pass so
   you can plot it and export the `.ply`.

If the app is open from GitHub Pages (https) and the browser refuses
`ws://localhost`, serve the folder locally instead (`python -m http.server`)
and open `http://localhost:8000`.
If pykinect2 fails to import, replace its two module files with the fixed
versions from github.com/KonstantinosAng/PyKinect2 (see script header).

## Usage
1. Open `index.html` in a browser (or serve the folder and visit it).
2. Drop your `.ply` scan in the Geometry panel ("rotate up-axis" if it lies wrong).
3. Load an audio recording of the site; pick a band and raise *audio → points*.
4. Enter the scan's coordinates (or "use my location"), pick a date range and
   fetch ERA5; choose a variable and raise *climate → points*.
5. Scrub or play the timeline; shape the haunting with the edge and
   displacement panels.
6. Export the displaced `.ply` at the moment you want to keep.

## ERA5 data routes
- **In-app fetch** uses the Open-Meteo archive API, which serves the Copernicus
  ERA5 reanalysis as JSON (cite: Hersbach et al., ERA5, Copernicus Climate
  Change Service). Instant, no key.
- **CDS route** for provenance: `python fetch_era5_cds.py --lat 51.5 --lon -0.12
  --start 2024-01-01 --end 2024-12-31 -o site.json` (needs `pip install cdsapi
  xarray netCDF4` and `~/.cdsapirc`). CDS queues requests server-side, so this
  can take a while. Load the resulting JSON in the Climate panel.

## GitHub Pages
Push the repo, enable Pages from `main` at the repository root, and the app
runs as-is (the climate fetch and CDN work fine from Pages).
