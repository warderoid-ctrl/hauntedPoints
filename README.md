# Haunted Points

A browser-based instrument for haunting 3D scans with data.

A point-cloud scan of an organic form (a leaf) is displaced by datasets that
describe the place it came from — an audio recording of the site, and hourly
ERA5 climate reanalysis for its coordinates. The result is an ephemeral,
data-troubled object: the unwitting weight of the Stack made visible on nature.

## What it does
- load a `.ply` point cloud (ASCII or binary, with or without colours)
- true 3D preview (Three.js): orbit, or fly and walk through the scan with
  WASD; point size, density
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
- **planetary dataset (NOAA / OWID)**: a second, slower layer *underneath* the
  site — global gas concentrations from NOAA GML (CO₂ 1979–, CH₄ 1983–,
  N₂O 2001–, SF₆ 1997–) or emissions from Our World in Data (annual, cumulative,
  per-capita, consumption-based, all-GHG, CH₄, N₂O, temperature anomaly; any of
  ~250 countries, back to 1750). It has its own gain and composes with ERA5
  rather than replacing it, and binds two ways:
  *deep time* scrubs the series on its own timeline in the panel, while
  *site timeline* resamples it onto the fetched ERA5 hours
- export the displaced point cloud as `.ply` at any timeline moment, with
  provenance comments (scan, audio file, climate variable, timestamp) baked
  into the header

## Moving through the scan
The three buttons at the top are **Orbit**, **Fly** and **Walk** (keys `1` `2` `3`).
Pressing WASD in Orbit switches to Fly.

| Input | Does |
| --- | --- |
| W A S D or arrows | Move. Fly goes where you look; Walk stays level |
| Q / E | Down / up |
| Drag | Look around |
| Right-drag | Slide sideways and up or down |
| Scroll | Forward and back (in Orbit it pushes on through the cloud) |
| Shift | Move faster |
| Esc | Back to Orbit, around a point just ahead of you |
| H | Data on / off |
| P | Scan view / plot view |

**Data on / off** shows the bare scan or the scan with every data layer, shimmer
and tint acting on it. Exports follow the switch, so with data off you plot and
export the untouched scan.

## Plotting
The lime frame is the page. Whatever is inside it in scan view lands in the same
place on the paper, and that is what the SVG holds.

The panel runs in working order: **Scan** (load, camera, points), then **Plot**
(style, scan mapping, colours, paper, export), then **Haunting** (the data).

Picture styles are PlotterLens's own filters and sliders. Point styles plot the
points themselves and how far the data moved them.

**Scan mapping** feeds the filters what a photo can't give them:

- *Tone comes from* sets how much ink goes where: colour, colour lit by a
  light you place, light on the surface normals alone, depth, how squarely the
  surface faces you, height, edge strength, data displacement or point density.
- *Depth fade* thins the far (or near) side of the scan out to bare paper.
- *Lines follow* sets which way lines run and what traced shapes trace: depth,
  height, surface facing, light or data, instead of the picture. Contour then
  draws real depth slices, and Engrave hatches around the 3D form.
- *Form lines* go over any style, picture or point, on a pen of their own:
  silhouette, depth edges (where one thing stands in front of another), depth
  slices and height lines.

*Colours → Depth* gives each band of distance from the camera its own pen.

## Files
- `index.html` — the app (open it in a browser; needs internet for the
  Three.js CDN and the climate fetch)
- `plotterlens-core.js` — PlotterLens's filters, generated: don't edit by hand.
  After changing PlotterLens, run `python tools/sync_plotterlens.py` to pull
  the new version across
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
5. In the Planetary panel pick an archive and series, hit *fetch series*, and
   raise *planet → points* — leave it in deep time to scrub centuries on the
   panel's own slider, or bind it to the site timeline to sit the leaf inside
   the atmosphere of the hour you fetched.
6. Scrub or play the timeline; shape the haunting with the edge and
   displacement panels.
7. Export the displaced `.ply` at the moment you want to keep.

## Planetary data routes
Both archives are fetched straight from the browser — no key, no proxy, CORS
open on every endpoint used.
- **NOAA GML** globally averaged marine surface means
  (`gml.noaa.gov/webdata/ccgg/trends/<gas>/<gas>_mm_gl.txt`, ~50 KB each). All
  four gases share the columns `year month decimal average average_unc trend
  trend_unc`; the *reading* control picks the seasonal `average` or the
  deseasonalised `trend`.
- **Our World in Data** single-indicator grapher CSVs
  (`ourworldindata.org/grapher/<slug>.csv`, ~0.8 MB, `Entity,Code,Year,<value>`)
  rather than the 14 MB combined `owid/co2-data` CSV. Note that the obvious
  `cumulative-co2-emissions` slug 301-redirects and the redirect response
  carries no `Access-Control-Allow-Origin`, so a browser fetch fails CORS — the
  app uses the redirect target `cumulative-co-emissions` directly.

Behaviours are chosen for a curve that mostly only goes up: *weight* presses the
cloud down and draws it inward (edges sag most), *press* flattens it toward the
midplane, *drift* disperses it, *swell* pushes along normals. Bound to a short
site window a cumulative series is almost flat — that is the reading, not a bug,
and the panel says so. Set *scale* to log to make the early centuries legible.
Open with `?planettest` to walk both archives, both binding modes and the export
paths, and print the results to the console.

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
