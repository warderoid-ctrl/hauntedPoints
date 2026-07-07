// Edge-detection compute core for the haunted plotter.
// Compiled to WASM via AssemblyScript. All buffers live in linear memory
// and are laid out by the JS host; functions receive byte pointers.

// Pipeline per call:
//   1. bin every point into a uniform spatial grid (counting sort, no alloc)
//   2. estimate a per-point normal = smallest eigenvector of the local
//      covariance matrix, via power iteration on (trace*I - C)
//   3. score each point as an "edge-ness" value depending on method
// method: 0 = curvature, 1 = normal deviation, 2 = local density, 3 = combined

// @ts-ignore: decorator
@inline
function cellOf(v: f32, mn: f32, cs: f32, g: i32): i32 {
  let c = <i32>((v - mn) / cs);
  if (c < 0) c = 0;
  if (c >= g) c = g - 1;
  return c;
}

export function computeEdges(
  ptsPtr: usize,        // f32[n*3]  interleaved x,y,z
  n: i32,
  radius: f32,
  method: i32,
  normalsPtr: usize,    // f32[n*3]  output/scratch
  scoresPtr: usize,     // f32[n]    output
  cellStartPtr: usize,  // i32[numCells+1]
  cellCurPtr: usize,    // i32[numCells]  scratch cursor
  sortedPtr: usize,     // i32[n]
  minx: f32, miny: f32, minz: f32,
  gx: i32, gy: i32, gz: i32
): void {
  const cs: f32 = radius;
  const numCells: i32 = gx * gy * gz;
  const r2: f32 = radius * radius;

  for (let c = 0; c < numCells; c++) {
    store<i32>(cellStartPtr + ((<usize>c) << 2), 0);
  }

  for (let i = 0; i < n; i++) {
    const b = ptsPtr + ((<usize>(i * 3)) << 2);
    const cx = cellOf(load<f32>(b),     minx, cs, gx);
    const cy = cellOf(load<f32>(b + 4), miny, cs, gy);
    const cz = cellOf(load<f32>(b + 8), minz, cs, gz);
    const cell = (cz * gy + cy) * gx + cx;
    const p = cellStartPtr + ((<usize>cell) << 2);
    store<i32>(p, load<i32>(p) + 1);
  }

  let acc = 0;
  for (let c = 0; c < numCells; c++) {
    const p = cellStartPtr + ((<usize>c) << 2);
    const cnt = load<i32>(p);
    store<i32>(p, acc);
    store<i32>(cellCurPtr + ((<usize>c) << 2), acc);
    acc += cnt;
  }
  store<i32>(cellStartPtr + ((<usize>numCells) << 2), acc);

  for (let i = 0; i < n; i++) {
    const b = ptsPtr + ((<usize>(i * 3)) << 2);
    const cx = cellOf(load<f32>(b),     minx, cs, gx);
    const cy = cellOf(load<f32>(b + 4), miny, cs, gy);
    const cz = cellOf(load<f32>(b + 8), minz, cs, gz);
    const cell = (cz * gy + cy) * gx + cx;
    const cp = cellCurPtr + ((<usize>cell) << 2);
    const idx = load<i32>(cp);
    store<i32>(sortedPtr + ((<usize>idx) << 2), i);
    store<i32>(cp, idx + 1);
  }

  for (let i = 0; i < n; i++) {
    const bi = ptsPtr + ((<usize>(i * 3)) << 2);
    const px = load<f32>(bi), py = load<f32>(bi + 4), pz = load<f32>(bi + 8);
    const cx = cellOf(px, minx, cs, gx);
    const cy = cellOf(py, miny, cs, gy);
    const cz = cellOf(pz, minz, cs, gz);

    let mx: f32 = 0, my: f32 = 0, mz: f32 = 0;
    let cnt = 0;
    for (let dz = -1; dz <= 1; dz++) {
      const z2 = cz + dz; if (z2 < 0 || z2 >= gz) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const y2 = cy + dy; if (y2 < 0 || y2 >= gy) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const x2 = cx + dx; if (x2 < 0 || x2 >= gx) continue;
          const cell = (z2 * gy + y2) * gx + x2;
          const s = load<i32>(cellStartPtr + ((<usize>cell) << 2));
          const e = load<i32>(cellStartPtr + ((<usize>(cell + 1)) << 2));
          for (let k = s; k < e; k++) {
            const j = load<i32>(sortedPtr + ((<usize>k) << 2));
            if (j == i) continue;
            const bj = ptsPtr + ((<usize>(j * 3)) << 2);
            const jx = load<f32>(bj), jy = load<f32>(bj + 4), jz = load<f32>(bj + 8);
            const ex = jx - px, ey = jy - py, ez = jz - pz;
            if (ex * ex + ey * ey + ez * ez < r2) { mx += jx; my += jy; mz += jz; cnt++; }
          }
        }
      }
    }

    const np = normalsPtr + ((<usize>(i * 3)) << 2);
    if (cnt < 3) {
      store<f32>(np, 0); store<f32>(np + 4, 1); store<f32>(np + 8, 0);
      if (method == 0 || method == 3) store<f32>(scoresPtr + ((<usize>i) << 2), 0);
      continue;
    }
    const inv: f32 = <f32>1.0 / <f32>cnt;
    mx *= inv; my *= inv; mz *= inv;

    let xx: f32 = 0, xy: f32 = 0, xz: f32 = 0, yy: f32 = 0, yz: f32 = 0, zz: f32 = 0;
    for (let dz = -1; dz <= 1; dz++) {
      const z2 = cz + dz; if (z2 < 0 || z2 >= gz) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const y2 = cy + dy; if (y2 < 0 || y2 >= gy) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const x2 = cx + dx; if (x2 < 0 || x2 >= gx) continue;
          const cell = (z2 * gy + y2) * gx + x2;
          const s = load<i32>(cellStartPtr + ((<usize>cell) << 2));
          const e = load<i32>(cellStartPtr + ((<usize>(cell + 1)) << 2));
          for (let k = s; k < e; k++) {
            const j = load<i32>(sortedPtr + ((<usize>k) << 2));
            if (j == i) continue;
            const bj = ptsPtr + ((<usize>(j * 3)) << 2);
            const jx = load<f32>(bj), jy = load<f32>(bj + 4), jz = load<f32>(bj + 8);
            const ex = jx - px, ey = jy - py, ez = jz - pz;
            if (ex * ex + ey * ey + ez * ez >= r2) continue;
            const ax = jx - mx, ay = jy - my, az = jz - mz;
            xx += ax * ax; xy += ax * ay; xz += ax * az;
            yy += ay * ay; yz += ay * az; zz += az * az;
          }
        }
      }
    }

    const tr = xx + yy + zz;
    const m00 = tr - xx, m01 = -xy, m02 = -xz;
    const m11 = tr - yy, m12 = -yz, m22 = tr - zz;
    let vx: f32 = 0.5773503, vy: f32 = 0.5773503, vz: f32 = 0.5773503;
    for (let it = 0; it < 12; it++) {
      const rx = m00 * vx + m01 * vy + m02 * vz;
      const ry = m01 * vx + m11 * vy + m12 * vz;
      const rz = m02 * vx + m12 * vy + m22 * vz;
      const nrm = Mathf.sqrt(rx * rx + ry * ry + rz * rz);
      if (nrm < <f32>1e-12) break;
      const invn: f32 = <f32>1.0 / nrm;
      vx = rx * invn; vy = ry * invn; vz = rz * invn;
    }
    store<f32>(np, vx); store<f32>(np + 4, vy); store<f32>(np + 8, vz);

    if (method == 0 || method == 3) {
      const cnx = xx * vx + xy * vy + xz * vz;
      const cny = xy * vx + yy * vy + yz * vz;
      const cnz = xz * vx + yz * vy + zz * vz;
      const lmin = vx * cnx + vy * cny + vz * cnz;
      const sv: f32 = tr > <f32>1e-12 ? lmin / tr : <f32>0;
      store<f32>(scoresPtr + ((<usize>i) << 2), sv);
    }
  }

  if (method == 1 || method == 2 || method == 3) {
    for (let i = 0; i < n; i++) {
      const bi = ptsPtr + ((<usize>(i * 3)) << 2);
      const px = load<f32>(bi), py = load<f32>(bi + 4), pz = load<f32>(bi + 8);
      const cx = cellOf(px, minx, cs, gx);
      const cy = cellOf(py, miny, cs, gy);
      const cz = cellOf(pz, minz, cs, gz);
      const nip = normalsPtr + ((<usize>(i * 3)) << 2);
      const nx = load<f32>(nip), ny = load<f32>(nip + 4), nz = load<f32>(nip + 8);

      let dev: f32 = 0;
      let cnt = 0;
      for (let dz = -1; dz <= 1; dz++) {
        const z2 = cz + dz; if (z2 < 0 || z2 >= gz) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const y2 = cy + dy; if (y2 < 0 || y2 >= gy) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const x2 = cx + dx; if (x2 < 0 || x2 >= gx) continue;
            const cell = (z2 * gy + y2) * gx + x2;
            const s = load<i32>(cellStartPtr + ((<usize>cell) << 2));
            const e = load<i32>(cellStartPtr + ((<usize>(cell + 1)) << 2));
            for (let k = s; k < e; k++) {
              const j = load<i32>(sortedPtr + ((<usize>k) << 2));
              if (j == i) continue;
              const bj = ptsPtr + ((<usize>(j * 3)) << 2);
              const jx = load<f32>(bj), jy = load<f32>(bj + 4), jz = load<f32>(bj + 8);
              const ex = jx - px, ey = jy - py, ez = jz - pz;
              if (ex * ex + ey * ey + ez * ez >= r2) continue;
              cnt++;
              const njp = normalsPtr + ((<usize>(j * 3)) << 2);
              let d = nx * load<f32>(njp) + ny * load<f32>(njp + 4) + nz * load<f32>(njp + 8);
              if (d < 0) d = -d;
              if (d > 1) d = 1;
              dev += <f32>1.0 - d;
            }
          }
        }
      }
      const nd: f32 = cnt > 0 ? dev / <f32>cnt : <f32>0;
      const sp = scoresPtr + ((<usize>i) << 2);
      if (method == 1) {
        store<f32>(sp, nd);
      } else if (method == 2) {
        store<f32>(sp, -(<f32>cnt));
      } else {
        let cur = load<f32>(sp) * <f32>3.0;
        if (cur > 1) cur = 1;
        store<f32>(sp, (cur + nd) * <f32>0.5);
      }
    }
  } else {
    for (let i = 0; i < n; i++) {
      const sp = scoresPtr + ((<usize>i) << 2);
      let v = load<f32>(sp) * <f32>3.0;
      if (v > 1) v = 1;
      store<f32>(sp, v);
    }
  }
}
