#!/usr/bin/env python3
"""Fetch ERA5 single-level reanalysis from the Copernicus Climate Data Store
and convert it to the JSON format that the Haunted Points app can load.

Setup (once):
    pip install cdsapi xarray netCDF4
    # put your key in ~/.cdsapirc  (see https://cds.climate.copernicus.eu/how-to-api)

Usage:
    python fetch_era5_cds.py --lat 51.5 --lon -0.12 --start 2024-01-01 --end 2024-12-31 -o leaf_site.json

Then in the app: Climate panel -> "load JSON file" -> pick leaf_site.json.

Note: CDS requests are queued server-side; this can take minutes to hours
depending on load. For instant in-app data use the built-in Open-Meteo ERA5
fetch instead (same reanalysis dataset).
"""

import argparse
import json
import sys
import tempfile
from datetime import date, timedelta

# CDS variable name -> (app series key, unit)
VARIABLES = {
    "2m_temperature": ("temperature_2m", "K"),
    "surface_pressure": ("surface_pressure", "Pa"),
    "total_precipitation": ("precipitation", "m"),
    "10m_u_component_of_wind": ("_u10", "m/s"),
    "10m_v_component_of_wind": ("_v10", "m/s"),
    "volumetric_soil_water_layer_1": ("soil_moisture_0_to_7cm", "m3/m3"),
    "surface_solar_radiation_downwards": ("shortwave_radiation", "J/m2"),
}


def daterange_months(start: date, end: date):
    """Yield (year, month) pairs covering [start, end]."""
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        yield y, m
        m += 1
        if m > 12:
            m = 1
            y += 1


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--start", required=True, help="YYYY-MM-DD")
    ap.add_argument("--end", required=True, help="YYYY-MM-DD")
    ap.add_argument("-o", "--out", default="era5_cds.json")
    args = ap.parse_args()

    try:
        import cdsapi
        import xarray as xr
    except ImportError as e:
        sys.exit(f"Missing dependency ({e.name}). Run: pip install cdsapi xarray netCDF4")

    start = date.fromisoformat(args.start)
    end = date.fromisoformat(args.end)
    if end < start:
        sys.exit("end date is before start date")

    client = cdsapi.Client()

    # Request a tiny bounding box around the point; ERA5 grid is 0.25 deg.
    area = [args.lat + 0.125, args.lon - 0.125, args.lat - 0.125, args.lon + 0.125]  # N, W, S, E

    days = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    request = {
        "product_type": ["reanalysis"],
        "variable": list(VARIABLES.keys()),
        "year": sorted({f"{d.year}" for d in days}),
        "month": sorted({f"{d.month:02d}" for d in days}),
        "day": sorted({f"{d.day:02d}" for d in days}),
        "time": [f"{h:02d}:00" for h in range(24)],
        "area": area,
        "data_format": "netcdf",
        "download_format": "unarchived",
    }

    print("Submitting request to CDS (this queues server-side; be patient)...")
    with tempfile.NamedTemporaryFile(suffix=".nc", delete=False) as tmp:
        target = tmp.name
    client.retrieve("reanalysis-era5-single-levels", request, target)
    print(f"Downloaded NetCDF -> {target}")

    ds = xr.open_dataset(target)
    # pick nearest grid cell to the exact point
    lat_name = "latitude" if "latitude" in ds.coords else "lat"
    lon_name = "longitude" if "longitude" in ds.coords else "lon"
    ds = ds.sel({lat_name: args.lat, lon_name: args.lon}, method="nearest")
    time_name = "valid_time" if "valid_time" in ds.coords else "time"
    ds = ds.sortby(time_name)
    # clip to the exact requested window (year/month/day cross product over-fetches)
    ds = ds.sel({time_name: slice(args.start, args.end + "T23:59")})

    times = ds[time_name].dt.strftime("%Y-%m-%dT%H:%M").values.astype(str).tolist()

    # short CDS netcdf variable names
    short = {
        "t2m": "temperature_2m",
        "sp": "surface_pressure",
        "tp": "precipitation",
        "u10": "_u10",
        "v10": "_v10",
        "swvl1": "soil_moisture_0_to_7cm",
        "ssrd": "shortwave_radiation",
    }

    series = {}
    for var, key in short.items():
        if var in ds:
            series[key] = [None if v != v else round(float(v), 5) for v in ds[var].values.tolist()]

    # convert to the units the app expects (matching Open-Meteo)
    if "temperature_2m" in series:
        series["temperature_2m"] = [None if v is None else round(v - 273.15, 2) for v in series["temperature_2m"]]  # K -> C
    if "surface_pressure" in series:
        series["surface_pressure"] = [None if v is None else round(v / 100.0, 2) for v in series["surface_pressure"]]  # Pa -> hPa
    if "precipitation" in series:
        series["precipitation"] = [None if v is None else round(v * 1000.0, 3) for v in series["precipitation"]]  # m -> mm
    if "shortwave_radiation" in series:
        series["shortwave_radiation"] = [None if v is None else round(v / 3600.0, 1) for v in series["shortwave_radiation"]]  # J/m2 per hour -> W/m2

    # derive wind speed / direction from u,v like Open-Meteo does
    if "_u10" in series and "_v10" in series:
        import math
        spd, ddir = [], []
        for u, v in zip(series.pop("_u10"), series.pop("_v10")):
            if u is None or v is None:
                spd.append(None); ddir.append(None)
            else:
                spd.append(round(math.hypot(u, v) * 3.6, 2))  # m/s -> km/h
                ddir.append(round((math.degrees(math.atan2(-u, -v)) + 360.0) % 360.0, 1))
        series["wind_speed_10m"] = spd
        series["wind_direction_10m"] = ddir

    out = {
        "source": "Copernicus CDS ERA5 single levels (reanalysis)",
        "latitude": args.lat,
        "longitude": args.lon,
        "hourly": {"time": times, **series},
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f)
    print(f"Wrote {args.out} with {len(out['hourly']['time'])} hourly steps and variables: {sorted(series)}")


if __name__ == "__main__":
    main()
