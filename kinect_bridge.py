#!/usr/bin/env python3
"""Kinect v2 -> WebSocket point-cloud bridge for Haunted Points.

Streams live camera-space points (Float32 x,y,z triplets, little-endian)
to the app at ~15 fps. In the app: Live scan panel -> connect.

Requirements (Windows):
  1. Kinect for Windows SDK 2.0 installed (and the Kinect v2 + its PC adapter).
  2. pip install pykinect2 numpy websockets
     - pykinect2 is old; this script patches the known time.clock issue.
     - If import still fails, use the community-fixed fork: copy PyKinectV2.py
       and PyKinectRuntime.py from github.com/KonstantinosAng/PyKinect2 over
       the installed package files (site-packages/pykinect2/).

Usage:
  python kinect_bridge.py                 # defaults: port 8181, stride 3
  python kinect_bridge.py --stride 2 --near 0.4 --far 3.0 --mirror

Test without a Kinect:
  python kinect_bridge.py --fake          # streams a synthetic breathing leaf
"""

import argparse
import asyncio
import ctypes
import math
import sys
import time

import numpy as np

try:
    import websockets
except ImportError:
    sys.exit("Missing dependency. Run: pip install websockets numpy")

# pykinect2 uses time.clock, removed in Python 3.8+ — restore it before import
if not hasattr(time, "clock"):
    time.clock = time.perf_counter

DEPTH_W, DEPTH_H = 512, 424
DEPTH_N = DEPTH_W * DEPTH_H

clients = set()


def open_kinect():
    from pykinect2 import PyKinectV2, PyKinectRuntime
    kinect = PyKinectRuntime.PyKinectRuntime(PyKinectV2.FrameSourceTypes_Depth)
    csps = (PyKinectV2._CameraSpacePoint * DEPTH_N)()
    return kinect, csps


def grab_kinect_points(kinect, csps, args):
    """Return (m,3) float32 camera-space points for the newest depth frame, or None."""
    if not kinect.has_new_depth_frame():
        return None
    depth = kinect.get_last_depth_frame()  # flat uint16, 512*424
    ptr = depth.ctypes.data_as(ctypes.POINTER(ctypes.c_ushort))
    err = kinect._mapper.MapDepthFrameToCameraSpace(
        ctypes.c_uint(DEPTH_N), ptr, ctypes.c_uint(DEPTH_N), csps)
    if err:
        print("MapDepthFrameToCameraSpace error", err)
        return None
    pts = np.frombuffer(csps, dtype=np.float32).reshape(DEPTH_H, DEPTH_W, 3)
    s = args.stride
    pts = pts[::s, ::s].reshape(-1, 3)
    mask = np.isfinite(pts).all(axis=1) & (pts[:, 2] > args.near) & (pts[:, 2] < args.far)
    pts = pts[mask]
    if args.mirror:
        pts = pts * np.array([-1, 1, 1], dtype=np.float32)
    return pts


def grab_fake_points(t, args):
    """Synthetic breathing leaf so the pipeline can be tested without hardware."""
    N = 14000
    rng = np.random.default_rng(0)
    u = rng.uniform(-1, 1, N).astype(np.float32)
    v = (rng.uniform(-1, 1, N) * (1 - u * u) * 0.45).astype(np.float32)
    y = (0.18 * np.sin(u * 1.9 + t * 0.8) + 0.03 * np.exp(-(v * 14) ** 2)
         + 0.02 * np.sin(t * 2 + u * 6)).astype(np.float32)
    return np.stack([u, y, v + 2.0], axis=1)  # sits ~2 m "from the sensor"


async def handler(ws):
    clients.add(ws)
    print(f"client connected ({len(clients)} total)")
    try:
        await ws.wait_closed()
    finally:
        clients.discard(ws)
        print(f"client left ({len(clients)} total)")


async def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8181)
    ap.add_argument("--stride", type=int, default=3, help="take every Nth pixel in x and y (3 -> ~24k pts)")
    ap.add_argument("--near", type=float, default=0.4, help="near clip in metres")
    ap.add_argument("--far", type=float, default=4.5, help="far clip in metres")
    ap.add_argument("--fps", type=float, default=15)
    ap.add_argument("--mirror", action="store_true", help="flip x for a mirror view")
    ap.add_argument("--fake", action="store_true", help="stream a synthetic cloud (no Kinect needed)")
    args = ap.parse_args()

    kinect = csps = None
    if not args.fake:
        try:
            kinect, csps = open_kinect()
            print("Kinect v2 opened.")
        except Exception as e:
            sys.exit(f"Could not open Kinect ({e}).\n"
                     "Check the SDK 2.0 install and pykinect2 (see script header), "
                     "or run with --fake to test without hardware.")

    print(f"Streaming on ws://localhost:{args.port}  (stride {args.stride}, "
          f"clip {args.near}-{args.far} m, {'FAKE data' if args.fake else 'Kinect v2'})")

    sent = 0
    t0 = time.perf_counter()
    async with websockets.serve(handler, "localhost", args.port, max_size=None):
        while True:
            t = time.perf_counter() - t0
            pts = grab_fake_points(t, args) if args.fake else grab_kinect_points(kinect, csps, args)
            if pts is not None and len(pts) and clients:
                data = np.ascontiguousarray(pts, dtype="<f4").tobytes()
                for ws in list(clients):
                    try:
                        await ws.send(data)
                    except Exception:
                        clients.discard(ws)
                sent += 1
                if sent % 30 == 0:
                    print(f"{len(pts)} pts/frame -> {len(clients)} client(s)")
            await asyncio.sleep(1.0 / args.fps)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nbridge stopped")
