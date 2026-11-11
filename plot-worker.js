// plot-worker.js — builds the plot away from the main thread, so the camera and the
// 3D view stay smooth while a heavy style is drawing.
//
// Written as a factory: the page calls it directly for the in-thread fallback, and
// builds the worker from the factory's own source text (Function.prototype.toString)
// in a blob URL. That way the worker starts from file:// too, where Chrome refuses
// to load a worker script from disk.
//
// A job carries the view: every visible point already projected to page mm, with its
// distance, height, surface facing, light, colour, edge score and data shift. Nothing
// here touches the scene, the camera or the DOM.
self.PlotWorkFactory = (CS) => {
  'use strict';
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // ---------------- the picture PlotterLens's filters read ----------------
  // Points are splatted nearest-first, so each cell belongs to the point you can see
  // there. From that one pass come the tone (how much ink), the structure field
  // (which way lines run) and the 3D fields the form lines are traced from.
  function rasterField(view, d, res, prm) {
    let w = res, h = Math.round(w * d.dh / d.dw);
    const maxH = Math.round(res * 1.45);
    if (h > maxH) { h = maxH; w = Math.round(h * d.dw / d.dh); }
    w = Math.max(w, 8); h = Math.max(h, 8);
    const N = w * h, win = new Int32Array(N).fill(-1), zb = new Float32Array(N).fill(Infinity);
    const cellPerPx = w / (d.dw * prm.frameS);
    const sizeK = prm.psize * 0.004 * prm.frameVh * 0.5;   // same size law as the point shader
    const { count, nd, dist } = view;
    for (let k = 0; k < count; k++) {
      const z = dist[k];
      const x = (nd[k*2] - d.mx) / d.dw * w, y = (nd[k*2+1] - d.my) / d.dh * h;
      const r = Math.max(0.5, Math.min(6, 0.5 * Math.min(prm.maxPointPx, sizeK / z) * cellPerPx));
      const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(w - 1, Math.floor(x + r));
      const y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(h - 1, Math.floor(y + r));
      for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
        const dx = xx + 0.5 - x, dy = yy + 0.5 - y;
        if (r > 1 && dx*dx + dy*dy > r*r) continue;
        const c = yy * w + xx;
        if (z < zb[c]) { zb[c] = z; win[c] = k; }
      }
    }
    const range = arr => { let a = Infinity, b = -Infinity; for (let k = 0; k < count; k++) { if (arr[k] < a) a = arr[k]; if (arr[k] > b) b = arr[k]; } return [a, (b - a) || 1]; };
    const [dn, dSpan] = range(dist), [hn, hSpan] = range(view.hgt);
    const CH = {   // per point, 0..1
      seen: k => view.lum[k],
      depth: k => (dist[k] - dn) / dSpan,               // 0 near .. 1 far
      height: k => (view.hgt[k] - hn) / hSpan,          // 0 low .. 1 high
      facing: k => view.facing[k],                      // 1 square on .. 0 edge on
      light: k => view.shade[k],
      edge: k => view.edge[k],
      data: k => view.mag[k]
    };
    const mask = new Float32Array(N);
    for (let c = 0; c < N; c++) if (win[c] >= 0) mask[c] = 1;
    const splat = f => { const A = new Float32Array(N); for (let c = 0; c < N; c++) if (win[c] >= 0) A[c] = f(win[c]); return A; };
    const blur = Math.max(1, Math.round(w / 130));
    const M = CS.boxBlur(mask, w, h, blur);
    // smooth a channel and carry it on past the edge of the scan, so it has no false cliff there
    const filled = A => {
      const out = new Float32Array(N), done = new Uint8Array(N);
      let left = N;
      for (const r of [blur, blur * 4, blur * 16, blur * 64]) {
        const T = CS.boxBlur(A, w, h, r), Mr = r === blur ? M : CS.boxBlur(mask, w, h, r), thr = r === blur ? 0.15 : 0.01;
        for (let c = 0; c < N; c++) if (!done[c] && Mr[c] > thr) { out[c] = T[c] / Mr[c]; done[c] = 1; left--; }
        if (!left) break;
      }
      if (left) { let sum = 0, cnt = 0; for (let c = 0; c < N; c++) if (done[c]) { sum += out[c]; cnt++; } for (let c = 0; c < N; c++) if (!done[c]) out[c] = cnt ? sum / cnt : 0.5; }
      return out;
    };
    const cache = {};
    const field = name => cache[name] || (cache[name] = filled(splat(CH[name])));
    let silhouette = null;
    const sil = () => silhouette || (silhouette = CS.boxBlur(mask, w, h, Math.max(2, Math.round(w / 70))));

    // tone: 1 is bare paper, 0 full ink
    const src = prm.toneSrc, gray = new Float32Array(N);
    if (src === 'density') for (let c = 0; c < N; c++) gray[c] = 1 - Math.min(1, Math.sqrt(M[c]) * 1.15);
    else {
      const tone = {
        seen: CH.seen, lit: k => CH.seen(k) * (0.3 + 0.7 * CH.light(k)), shaded: CH.light, depth: CH.depth, facing: CH.facing,
        height: k => 1 - CH.height(k), edge: k => 1 - CH.edge(k), data: k => 1 - CH.data(k)
      }[src] || CH.seen;
      const T = CS.boxBlur(splat(tone), w, h, blur);
      for (let c = 0; c < N; c++) {
        const m = M[c];
        if (m < 1e-3) { gray[c] = 1; continue; }
        const a = clamp((m - 0.03) / 0.17, 0, 1);
        gray[c] = 1 + (T[c] / m - 1) * a * a * (3 - 2 * a);
      }
    }
    if (prm.depthFade) { // atmospheric perspective: one side of the scan thins out towards bare paper
      const D = field('depth'), f = Math.abs(prm.depthFade) / 100;
      for (let c = 0; c < N; c++) { const t = prm.depthFade > 0 ? D[c] : 1 - D[c]; gray[c] += (1 - gray[c]) * f * t; }
    }

    // structure: high values read as dark, as PlotterLens's own tone field does
    let shape = null;
    if (prm.follow !== 'tone') {
      const fl = prm.follow;
      const F = fl === 'depth' ? field('depth') : fl === 'height' ? field('height') : fl === 'facing' ? field('facing') : fl === 'light' ? field('light') : field('data');
      const invert = fl === 'depth' || fl === 'facing' || fl === 'light';
      let lo = Infinity, hi = -Infinity;
      for (let c = 0; c < N; c++) if (M[c] > 0.2) { if (F[c] < lo) lo = F[c]; if (F[c] > hi) hi = F[c]; }
      if (!isFinite(lo)) { lo = 0; hi = 1; }
      const span = (hi - lo) || 1;
      shape = new Float32Array(N);
      const S0 = sil();
      for (let c = 0; c < N; c++) {
        let t = clamp((F[c] - lo) / span, 0, 1);
        if (invert) t = 1 - t;
        const a = clamp((S0[c] - 0.15) / 0.3, 0, 1);
        shape[c] = t * a * a * (3 - 2 * a);   // off the scan it settles to 0: far, low, flat
      }
    }
    return { gray, w, h, shape, M, field, sil };
  }

  // ---------------- form lines: traced from the 3D fields, over any style ----------------
  function formLines(fld, d, prm) {
    const out = [], pen = prm.formPen, { w, h } = fld;
    if (!(prm.formSil || prm.formTurn || prm.formSlices || prm.formHeight)) return out;
    const S0 = fld.sil(), SIL = 0.3;
    const at = (F, x, y) => F[clamp(Math.floor((y - d.my) / d.dh * h), 0, h - 1) * w + clamp(Math.floor((x - d.mx) / d.dw * w), 0, w - 1)];
    const minLen = Math.max(2, Math.hypot(d.dw, d.dh) * 0.006);
    const push = pts => {
      let len = 0;
      for (let i = 2; i < pts.length; i += 2) len += Math.hypot(pts[i] - pts[i-2], pts[i+1] - pts[i-1]);
      if (len >= minLen) out.push({ layer: pen, pts });
    };
    const insideOnly = pts => { // keep the runs that lie on the scan, not on the fill carried past its edge
      let cur = [];
      for (let i = 0; i < pts.length; i += 2) {
        if (at(S0, pts[i], pts[i+1]) > SIL) cur.push(pts[i], pts[i+1]);
        else { if (cur.length >= 4) push(cur); cur = []; }
      }
      if (cur.length >= 4) push(cur);
    };
    const levels = k => Array.from({ length: k }, (_, i) => (i + 1) / (k + 1));
    if (prm.formSil) CS.iso(S0, w, h, [SIL], d)[0].forEach(push);
    if (prm.formTurn) depthEdges(fld.field('depth'), w, h, d).forEach(insideOnly);
    for (const [name, k] of [['depth', prm.formSlices], ['height', prm.formHeight]]) {
      if (!k) continue;
      const F = fld.field(name);
      let lo = Infinity, hi = -Infinity;
      for (let c = 0; c < F.length; c++) if (S0[c] > SIL) { if (F[c] < lo) lo = F[c]; if (F[c] > hi) hi = F[c]; }
      if (!isFinite(lo)) continue;
      const lv = levels(k).map(t => lo + t * (hi - lo));
      CS.iso(F, w, h, lv, d).forEach(lines => lines.forEach(insideOnly));
    }
    return out;
  }

  // Occlusion edges: where depth jumps, something stands in front of something else.
  // Gradient of log depth, thinned to one cell (non-maximum suppression), then walked
  // into polylines and lightly smoothed so the pixel steps don't show.
  function depthEdges(D, w, h, d) {
    const N = w * h, L = new Float32Array(N), G = new Float32Array(N), A = new Uint8Array(N);
    for (let c = 0; c < N; c++) L[c] = Math.log(0.05 + D[c]);
    for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
      const c = j * w + i, gx = (L[c + 1] - L[c - 1]) / 2, gy = (L[c + w] - L[c - w]) / 2;
      G[c] = Math.hypot(gx, gy);
      const a = Math.atan2(gy, gx) * 4 / Math.PI;               // gradient direction in eighths
      A[c] = ((Math.round(a) % 4) + 4) % 4;                     // 0 across, 1 diagonal, 2 down, 3 other diagonal
    }
    const thr = 0.03 * 320 / w;                                 // a jump of a few percent of depth per cell, whatever the resolution
    const OFF = [[1, 0], [1, 1], [0, 1], [-1, 1]];
    const E = new Uint8Array(N);
    for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
      const c = j * w + i, g = G[c];
      if (g < thr) continue;
      const [ox, oy] = OFF[A[c]];
      if (g >= G[c + oy * w + ox] && g > G[c - oy * w - ox]) E[c] = 1;
    }
    const NB = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    const walk = (c, chain) => {
      for (;;) {
        const i = c % w, j = (c / w) | 0;
        let next = -1;
        for (const [dx, dy] of NB) {
          const x = i + dx, y = j + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const q = y * w + x;
          if (E[q] === 1) { next = q; break; }
        }
        if (next < 0) return;
        E[next] = 2; chain.push(next); c = next;
      }
    };
    const toMm = c => [d.mx + ((c % w) + 0.5) / w * d.dw, d.my + (((c / w) | 0) + 0.5) / h * d.dh];
    const out = [];
    for (let c = 0; c < N; c++) {
      if (E[c] !== 1) continue;
      E[c] = 2;
      const fwd = [c], back = [];
      walk(c, fwd); walk(c, back);
      const chain = back.reverse().concat(fwd);
      if (chain.length < 4) continue;
      const P2 = chain.map(toMm), pts = [];
      for (let k = 0; k < P2.length; k++) { // three-tap average keeps the ends where they are
        const a = P2[Math.max(0, k - 1)], b = P2[k], e = P2[Math.min(P2.length - 1, k + 1)];
        pts.push((a[0] + 2 * b[0] + e[0]) / 4, (a[1] + 2 * b[1] + e[1]) / 4);
      }
      out.push(pts);
    }
    return out;
  }

  // Give each stretch of a stroke the pen of the band it passes through, cutting at band edges.
  function splitByPen(list, penAt, step) {
    const out = [];
    for (const p of list) {
      const q = p.pts;
      if (q.length < 4) { out.push(p); continue; }
      let cur = [q[0], q[1]], curP = penAt(q[0], q[1]);
      for (let i = 2; i < q.length; i += 2) {
        const ax = q[i-2], ay = q[i-1], bx = q[i], by = q[i+1], m = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
        for (let k = 1; k < m; k++) {
          const x = ax + (bx - ax) * k / m, y = ay + (by - ay) * k / m, pn = penAt(x, y);
          if (pn !== curP) { cur.push(x, y); if (cur.length >= 4) out.push({ layer: curP, pts: cur }); cur = [x, y]; curP = pn; }
        }
        const pn = penAt(bx, by);
        if (pn !== curP) { cur.push(bx, by); if (cur.length >= 4) out.push({ layer: curP, pts: cur }); cur = [bx, by]; curP = pn; }
        else cur.push(bx, by);
      }
      if (cur.length >= 4) out.push({ layer: curP, pts: cur });
    }
    return out;
  }
  function depthPens(list, d, fld, prm) {
    const D = fld.field('depth'), { w, h } = fld, N = prm.depthBands;
    const penAt = (x, y) => {
      const t = D[clamp(Math.floor((y - d.my) / d.dh * h), 0, h - 1) * w + clamp(Math.floor((x - d.mx) / d.dw * w), 0, w - 1)];
      const b = Math.min(N - 1, Math.floor((prm.depthRev ? 1 - t : t) * N));
      return b < 0 ? 0 : b;
    };
    return splitByPen(list, penAt, Math.max(0.25, d.dw / w * 0.7));
  }

  // ---------------- point styles: marks and curves from the points themselves ----------------
  function catmullPath(pts, closed, f) {
    const m = pts.length;
    if (m < 2) return '';
    let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
    const end = closed ? m : m - 1;
    for (let i = 0; i < end; i++) {
      const p1 = pts[i], p2 = pts[(i + 1) % m];
      const p0 = (closed || i > 0) ? pts[(i - 1 + m) % m] : p1;
      const p3 = (closed || i < m - 2) ? pts[(i + 2) % m] : p2;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ` C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(p2[0])} ${f(p2[1])}`;
    }
    if (closed) d += ' Z';
    return d;
  }

  // Returns { paths: string[][] (SVG path data per pen), texts: [{x,y,s,ch}][] }.
  function pointStyle(view, d, prm) {
    const style = prm.pointStyle, layers = prm.plotPens, g = prm.plotGlyph, W = d.W, H = d.H;
    const fmt = v => (Math.round(v * 100) / 100).toString();
    const layerPaths = Array.from({ length: layers }, () => []);
    const layerTexts = Array.from({ length: layers }, () => []);
    const { count, nd, nb, mag, attr, base } = view;
    if (!count) return { paths: layerPaths, texts: layerTexts };
    const DX = k => nd[k*2],  DY = k => nd[k*2+1];
    const BX = k => nb[k*2], BY = k => nb[k*2+1];
    const layerOf = k => Math.min(layers - 1, Math.floor(attr[k] * layers));
    const rankPens = allRuns => { // assign pens by quantile so every layer gets a share of the drawing
      const sortedAttr = allRuns.map(r => r.attr).sort((a, b) => a - b);
      for (const r of allRuns) {
        let rank = sortedAttr.findIndex(v => v >= r.attr);
        if (rank < 0) rank = sortedAttr.length - 1;
        const L = Math.min(layers - 1, Math.floor(rank / (sortedAttr.length || 1) * layers));
        layerPaths[L].push(catmullPath(r.pts, r.closed, fmt));
      }
    };

    if (style === 'contour' || style === 'rings') {
      const allRuns = [];
      const bands = Math.round(6 + prm.plotDetail * 0.54);
      const axis = prm.plotAxis, sortAxis = axis === 0 ? 2 : 0;
      const bandVal = style === 'rings' ? k => Math.hypot(base[k*3], base[k*3+2]) : k => base[k*3 + axis];
      let vmn = Infinity, vmx = -Infinity;
      for (let k = 0; k < count; k++) { const bv = bandVal(k); vmn = Math.min(vmn, bv); vmx = Math.max(vmx, bv); }
      const span = vmx - vmn || 1;
      const groups = Array.from({ length: bands }, () => []);
      for (let k = 0; k < count; k++) groups[Math.min(bands - 1, Math.floor((bandVal(k) - vmn) / span * bands))].push(k);
      for (const grp of groups) {
        if (grp.length < 3) continue;
        if (style === 'rings') grp.sort((a, b) => Math.atan2(base[a*3+2], base[a*3]) - Math.atan2(base[b*3+2], base[b*3]));
        else grp.sort((a, b) => base[a*3 + sortAxis] - base[b*3 + sortAxis]);
        // split runs where object-space gaps are large
        const runs = [];
        let run = [grp[0]];
        for (let q = 1; q < grp.length; q++) {
          const a = grp[q-1], b = grp[q];
          const gap = Math.hypot(base[b*3]-base[a*3], base[b*3+1]-base[a*3+1], base[b*3+2]-base[a*3+2]);
          if (gap > 0.1) { if (run.length > 2) runs.push(run); run = []; }
          run.push(grp[q]);
        }
        if (run.length > 2) runs.push(run);
        for (const r of runs) {
          const closed = style === 'rings' && r.length === grp.length && grp.length > 8;
          // resample the run so curves stay smooth instead of tracing every jitter
          const maxPts = Math.round(18 + prm.plotDetail * 1.2);
          let r2 = r;
          if (r.length > maxPts) {
            r2 = [];
            const st = (r.length - 1) / (maxPts - 1);
            for (let q = 0; q < maxPts; q++) r2.push(r[Math.round(q * st)]);
          }
          let acc = 0;
          for (const k of r2) acc += attr[k];
          allRuns.push({ pts: r2.map(k => [DX(k), DY(k)]), closed, attr: acc / r2.length });
        }
      }
      rankPens(allRuns);
    } else if (style === 'flow') {
      // streamlines through the displacement vector field: splat every point's page-space
      // displacement into a coarse grid, then integrate seed points through the bilinearly-sampled field
      const GW = 56, GH = Math.max(8, Math.round(56 * H / W));
      const cellW = W / GW, cellH = H / GH;
      const fvx = new Float32Array(GW * GH), fvy = new Float32Array(GW * GH), fc = new Float32Array(GW * GH);
      for (let k = 0; k < count; k++) {
        const gxi = Math.floor(DX(k) / cellW), gyi = Math.floor(DY(k) / cellH);
        if (gxi < 0 || gxi >= GW || gyi < 0 || gyi >= GH) continue;
        const c = gyi * GW + gxi;
        fvx[c] += DX(k) - BX(k); fvy[c] += DY(k) - BY(k); fc[c]++;
      }
      for (let c = 0; c < GW * GH; c++) if (fc[c]) { fvx[c] /= fc[c]; fvy[c] /= fc[c]; }
      const sampleField = (x, y) => {
        const fx = x / cellW - 0.5, fy = y / cellH - 0.5;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        let sx = 0, sy = 0, sw = 0;
        for (let b = 0; b <= 1; b++) for (let a = 0; a <= 1; a++) {
          const xx = x0 + a, yy = y0 + b;
          if (xx < 0 || xx >= GW || yy < 0 || yy >= GH) continue;
          const c = yy * GW + xx;
          if (!fc[c]) continue;
          const wgt = (1 - Math.abs(fx - xx)) * (1 - Math.abs(fy - yy));
          sx += fvx[c] * wgt; sy += fvy[c] * wgt; sw += wgt;
        }
        return sw > 0 ? [sx / sw, sy / sw] : null;
      };
      const target = Math.round(60 + prm.plotDetail * 12);
      const step = Math.max(1, Math.floor(count / target));
      const stepLen = Math.max(0.6, g * 0.5);
      const maxSteps = 34;
      for (let k = 0; k < count; k += step) {
        let x = BX(k), y = BY(k);
        const pts = [[x, y]];
        for (let q = 0; q < maxSteps; q++) {
          const v = sampleField(x, y);
          if (!v) break;
          const l = Math.hypot(v[0], v[1]);
          if (l < 0.01) break;
          x += v[0] / l * stepLen; y += v[1] / l * stepLen;
          if (x < 2 || x > W - 2 || y < 2 || y > H - 2) break;
          pts.push([x, y]);
        }
        if (pts.length > 2) layerPaths[layerOf(k)].push(catmullPath(pts, false, fmt));
      }
    } else if (style === 'rd') {
      // Gray-Scott reaction-diffusion over the cloud's footprint; the data value
      // at each cell sets feed/kill, so the climate chooses the pattern's shape
      const GW2 = 110, GH2 = Math.max(12, Math.round(110 * H / W));
      const NC = GW2 * GH2, cw2 = W / GW2, ch2 = H / GH2;
      let U = new Float32Array(NC).fill(1), Vf = new Float32Array(NC);
      const U2 = new Float32Array(NC), V2 = new Float32Array(NC);
      const rdMask = new Uint8Array(NC), attrG = new Float32Array(NC), cntG = new Float32Array(NC);
      for (let k = 0; k < count; k++) {
        const gxi = Math.floor(DX(k) / cw2), gyi = Math.floor(DY(k) / ch2);
        if (gxi < 0 || gxi >= GW2 || gyi < 0 || gyi >= GH2) continue;
        const c = gyi * GW2 + gxi;
        rdMask[c] = 1; attrG[c] += attr[k]; cntG[c]++;
      }
      for (let c = 0; c < NC; c++) if (cntG[c]) attrG[c] /= cntG[c];
      // seed gentle V blobs sparsely (~2% of cells; dense seeding crashes U globally)
      for (let c = 0; c < NC; c++) {
        if (!rdMask[c] || ((c * 2654435761 >>> 0) % 47) >= 1) continue;
        for (const o of [0, -1, 1, -GW2, GW2]) {
          const c2 = c + o;
          if (c2 >= 0 && c2 < NC && rdMask[c2]) { Vf[c2] = 0.55; U[c2] = 0.45; }
        }
      }
      const iters = Math.round(160 + prm.plotDetail * 3);
      const Du = 0.21, Dv = 0.105;
      let Ua = U, Va = Vf, Ub = U2, Vb = V2;
      for (let it = 0; it < iters; it++) {
        for (let j = 0; j < GH2; j++) for (let i = 0; i < GW2; i++) {
          const c = j * GW2 + i;
          if (!rdMask[c]) { Ub[c] = 1; Vb[c] = 0; continue; }
          const u = Ua[c], v = Va[c];
          // outside the footprint counts as fresh chemical (u=1, v=0) so the
          // boundary feeds the reaction instead of starving it
          let lU = 0, lV = 0;
          if (i > 0 && rdMask[c-1])        { lU += Ua[c-1];   lV += Va[c-1];   } else lU += 1;
          if (i < GW2-1 && rdMask[c+1])    { lU += Ua[c+1];   lV += Va[c+1];   } else lU += 1;
          if (j > 0 && rdMask[c-GW2])      { lU += Ua[c-GW2]; lV += Va[c-GW2]; } else lU += 1;
          if (j < GH2-1 && rdMask[c+GW2])  { lU += Ua[c+GW2]; lV += Va[c+GW2]; } else lU += 1;
          const lapU = lU - 4 * u, lapV = lV - 4 * v;
          const a = attrG[c];
          const F = 0.034 + 0.022 * a, K = 0.060 + 0.004 * a;
          const uvv = u * v * v;
          const nu = u + Du * lapU - uvv + F * (1 - u);
          const nv = v + Dv * lapV + uvv - (F + K) * v;
          Ub[c] = nu < 0 ? 0 : nu > 1 ? 1 : nu; // clamp to keep the sim stable
          Vb[c] = nv < 0 ? 0 : nv > 1 ? 1 : nv;
        }
        const su = Ua; Ua = Ub; Ub = su;
        const sv = Va; Va = Vb; Vb = sv;
      }
      // scanline runs where V is high -> plotter-friendly stripes/spots
      const allRuns = [];
      const thr = 0.2;
      for (let j = 0; j < GH2; j++) {
        let run = null;
        for (let i = 0; i <= GW2; i++) {
          const c = j * GW2 + i;
          const on = i < GW2 && rdMask[c] && Va[c] > thr;
          if (on) {
            if (!run) run = { pts: [], acc: 0, m: 0 };
            run.pts.push([(i + 0.5) * cw2, (j + 0.5) * ch2 - Va[c] * ch2 * 0.4]);
            run.acc += attrG[c]; run.m++;
          } else if (run) {
            if (run.pts.length >= 2) allRuns.push({ pts: run.pts, closed: false, attr: run.acc / run.m });
            run = null;
          }
        }
      }
      rankPens(allRuns);
    } else {
      const target = Math.round(100 + prm.plotDetail * 40);
      const step = Math.max(1, Math.floor(count / target));
      const ramp = ['.', ':', '-', '=', '+', '*', '#', '%', '@'];
      for (let k = 0; k < count; k += step) {
        const x = DX(k), y = DY(k), m = mag[k], L = layerOf(k);
        const push = s => layerPaths[L].push(s);
        if (style === 'points') {
          // stipple: tiny dot per point; glyph slider sets dot size, displacement adds a touch
          const r = Math.max(0.06, g * 0.09 * (0.6 + m * 0.8));
          push(`M${fmt(x - r)} ${fmt(y)} a${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(2*r)} 0 a${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(-2*r)} 0`);
        } else if (style === 'hairs') {
          const hx = BX(k) + (x - BX(k)) * g, hy = BY(k) + (y - BY(k)) * g;
          push(`M${fmt(BX(k))} ${fmt(BY(k))} L${fmt(hx)} ${fmt(hy)}`);
        } else if (style === 'arrows') {
          const hx = BX(k) + (x - BX(k)) * g, hy = BY(k) + (y - BY(k)) * g;
          const a = Math.atan2(hy - BY(k), hx - BX(k));
          const hl = Math.max(0.6, (0.25 + m * 0.6) * g);
          push(`M${fmt(BX(k))} ${fmt(BY(k))} L${fmt(hx)} ${fmt(hy)}`);
          push(`M${fmt(hx)} ${fmt(hy)} L${fmt(hx - hl*Math.cos(a - 0.45))} ${fmt(hy - hl*Math.sin(a - 0.45))}`);
          push(`M${fmt(hx)} ${fmt(hy)} L${fmt(hx - hl*Math.cos(a + 0.45))} ${fmt(hy - hl*Math.sin(a + 0.45))}`);
        } else if (style === 'circles') {
          const r = (0.2 + m * 0.8) * g;
          push(`M${fmt(x - r)} ${fmt(y)} a${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(2*r)} 0 a${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(-2*r)} 0`);
        } else if (style === 'suns') {
          const r = (0.2 + m * 0.5) * g;
          push(`M${fmt(x - r)} ${fmt(y)} a${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(2*r)} 0 a${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(-2*r)} 0`);
          for (let q = 0; q < 7; q++) {
            const a = q / 7 * Math.PI * 2 + m * 2;
            push(`M${fmt(x + Math.cos(a)*r*1.35)} ${fmt(y + Math.sin(a)*r*1.35)} L${fmt(x + Math.cos(a)*r*2)} ${fmt(y + Math.sin(a)*r*2)}`);
          }
        } else if (style === 'spirals') {
          const rmax = (0.25 + m * 0.75) * g, segs = 30;
          let s = `M${fmt(x)} ${fmt(y)}`;
          for (let q = 1; q <= segs; q++) {
            const t = q / segs, a = t * Math.PI * 2 * 2.2 + m * 5;
            s += ` L${fmt(x + Math.cos(a) * rmax * t)} ${fmt(y + Math.sin(a) * rmax * t)}`;
          }
          push(s);
        } else { // ascii
          const ch = ramp[Math.min(ramp.length - 1, Math.floor(m * ramp.length))];
          layerTexts[L].push({ x, y, s: g * 2.2, ch });
        }
      }
    }
    return { paths: layerPaths, texts: layerTexts };
  }

  // ---------------- jobs ----------------
  // Polylines travel as one flat buffer: pts[offs[i] .. offs[i+1]) is stroke i on pen layers[i].
  function packPolys(list) {
    let np = 0;
    for (const p of list) np += p.pts.length;
    const pts = new Float32Array(np), offs = new Int32Array(list.length + 1), layers = new Int32Array(list.length);
    let o = 0;
    list.forEach((p, i) => { layers[i] = p.layer; offs[i] = o; pts.set(p.pts, o); o += p.pts.length; });
    offs[list.length] = o;
    return { pts, offs, layers };
  }

  // ---------------- painting: done here on an OffscreenCanvas, so the page only blits a bitmap ----------------
  // Stroking tens of thousands of segments is real work for the browser's canvas; deep
  // inside a cloud the picture is nearly solid ink and that work would stall the page.
  // The canvases are rasterized in software here (willReadFrequently asks Chrome for a
  // CPU canvas), so the page's GPU process, which the compositor shares, only ever
  // receives a finished bitmap. A GPU canvas would hand it every stroke to tessellate.
  const canvases = {};
  function canvasFor(which, w, h) {
    if (typeof OffscreenCanvas === 'undefined') return null;
    let c = canvases[which];
    if (!c || c.cv.width !== w || c.cv.height !== h) {
      const cv = new OffscreenCanvas(w, h);
      c = canvases[which] = { cv, ctx: cv.getContext('2d', { willReadFrequently: true }) };
    }
    return c;
  }
  // Vertices closer together than a fraction of a pixel add nothing but stroking work, so
  // they are skipped; the ends of every stroke are always kept. Length is measured on the originals.
  function strokePolys(ctx, polys, k, ox, oy, duo) {
    const byLayer = [], tol2 = 0.5 * 0.5;
    for (const p of polys) (byLayer[p.layer] || (byLayer[p.layer] = [])).push(p);
    ctx.globalCompositeOperation = duo ? (CS.darkPaper() ? 'screen' : 'multiply') : 'source-over';   // overlapping inks mix like print
    let length = 0;
    byLayer.forEach((arr, li) => {
      if (!arr) return;
      ctx.strokeStyle = CS.penColour(li);
      ctx.beginPath();
      for (const p of arr) {
        const q = p.pts, last = q.length - 2;
        let px = ox + q[0] * k, py = oy + q[1] * k;
        ctx.moveTo(px, py);
        for (let i = 2; i < q.length; i += 2) {
          length += Math.hypot(q[i] - q[i-2], q[i+1] - q[i-1]);
          const x = ox + q[i] * k, y = oy + q[i+1] * k, dx = x - px, dy = y - py;
          if (dx * dx + dy * dy < tol2 && i < last) continue;
          ctx.lineTo(x, y); px = x; py = y;
        }
      }
      ctx.stroke();
    });
    ctx.globalCompositeOperation = 'source-over';
    return length;
  }
  // pt: { pw, ph, k, dpr, paper (fill the paper colour, or stay transparent for the page to put the scan under), focusMark }
  function paintPlot(res, d, pt) {
    const cc = canvasFor('plot', pt.pw, pt.ph);
    if (!cc) return null;
    const cv = cc.cv, c = cc.ctx, k = pt.k, S = CS.S;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over';
    if (pt.paper) { c.fillStyle = S.paperCol; c.fillRect(0, 0, pt.pw, pt.ph); } else c.clearRect(0, 0, pt.pw, pt.ph);
    c.strokeStyle = CS.darkPaper() ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.12)';
    c.lineWidth = 1; c.setLineDash([5, 5]);
    c.strokeRect(d.mx * k, d.my * k, d.dw * k, d.dh * k);
    c.setLineDash([]);
    c.lineCap = 'round';
    let lines = 0, length = 0;
    if (res.polys) {
      c.lineWidth = Math.max(S.pen * k, 1);
      c.lineJoin = c.lineWidth > 2.5 ? 'round' : 'bevel';   // round joins cost stroking work and can't be seen on a thin line
      length = strokePolys(c, res.polys, k, 0, 0, S.mode === 'duotone' && pt.paper);
      lines = res.polys.length;
    } else {
      c.setTransform(k, 0, 0, k, 0, 0);
      c.lineWidth = Math.max(S.pen, 1 / k);
      c.lineJoin = 'round';
      c.textAlign = 'center';
      for (let L = 0; L < res.paths.length; L++) {
        const col = S.pens[L % 4];
        if (res.paths[L].length) { c.strokeStyle = col; c.stroke(new Path2D(res.paths[L].join(' '))); lines += res.paths[L].length; }
        if (res.texts[L].length) {
          c.fillStyle = col;
          for (const t of res.texts[L]) { c.font = t.s.toFixed(2) + 'px monospace'; c.fillText(t.ch, t.x, t.y); }
          lines += res.texts[L].length;
        }
      }
      c.setTransform(1, 0, 0, 1, 0, 0);
    }
    if (S.focus && pt.focusMark) {
      const x = S.focus.x * d.W * k, y = S.focus.y * d.H * k, r = 15 * pt.dpr;
      c.strokeStyle = '#e5f15c'; c.lineWidth = 2 * pt.dpr;
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2);
      c.moveTo(x - r * 1.5, y); c.lineTo(x + r * 1.5, y); c.moveTo(x, y - r * 1.5); c.lineTo(x, y + r * 1.5);
      c.stroke();
    }
    return { bitmap: cv.transferToImageBitmap(), lines, length };
  }
  function paintThumb(polys, d, mode, size) {
    const cc = canvasFor('thumb', size, size);
    if (!cc) return null;
    const cv = cc.cv, ctx = cc.ctx, W = size, H = size;
    const k = Math.max(W / d.W, H / d.H) * 1.08, ox = (W - d.W * k) / 2, oy = (H - d.H * k) / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = CS.S.paperCol; ctx.fillRect(0, 0, W, H);
    ctx.lineWidth = 1.6; ctx.lineCap = 'round'; ctx.lineJoin = 'bevel';
    const keep = CS.S.mode;
    CS.S.mode = mode;   // colour by the thumbnail's own style
    strokePolys(ctx, polys, k, ox, oy, mode === 'duotone');
    CS.S.mode = keep;
    return cv.transferToImageBitmap();
  }

  let thumbSnap = null;   // the view the style thumbnails are drawn from
  function job(msg) {
    if (msg.LS) Object.assign(CS.S, msg.LS);   // the page's PlotterLens settings
    const { d, prm, view } = msg;
    if (msg.kind === 'snap') {
      const fld = rasterField(view, d, 200, prm);
      thumbSnap = { gray: fld.gray, w: fld.w, h: fld.h, d, shape: fld.shape };
      return { ok: true };
    }
    if (msg.kind === 'thumb') {
      if (!thumbSnap) return { polys: packPolys([]) };
      const t = thumbSnap, polys = CS.thumb(msg.mode, t.gray, t.w, t.h, t.d, t.shape);
      const bitmap = msg.paint ? paintThumb(polys, t.d, msg.mode, msg.paint.size) : null;
      return bitmap ? { bitmap } : { polys: packPolys(polys) };
    }
    if (prm.pointStyle) {
      const out = pointStyle(view, d, prm);
      if (prm.formOn) { // the point styles can carry form lines too
        const fld = rasterField(view, d, msg.final ? 480 : 320, prm), f2 = v => +v.toFixed(2);
        for (const p of formLines(fld, d, prm)) {
          while (out.paths.length <= p.layer) { out.paths.push([]); out.texts.push([]); }
          let s = `M${f2(p.pts[0])} ${f2(p.pts[1])}`;
          for (let i = 2; i < p.pts.length; i += 2) s += ` L${f2(p.pts[i])} ${f2(p.pts[i+1])}`;
          out.paths[p.layer].push(s);
        }
      }
      return (msg.paint && paintPlot(out, d, msg.paint)) || out;
    }
    const fld = rasterField(view, d, msg.res, prm);
    // while the camera moves the style draws with wider spacing, so slow styles keep up; it refines when the camera stops
    const spacing = CS.S.spacing;
    if (msg.coarse) CS.S.spacing = spacing * 1.5;
    let polys;
    try { polys = CS.run(fld.gray, fld.w, fld.h, d, { live: !msg.final, settle: msg.final ? 600 : 0, shape: fld.shape }); }
    finally { CS.S.spacing = spacing; }
    if (prm.depthPens) polys = depthPens(polys, d, fld, prm);
    polys = polys.concat(formLines(fld, d, prm));
    const painted = msg.paint && paintPlot({ polys }, d, msg.paint);
    if (painted) return { ...painted, loopBusy: CS.loopBusy() };
    return { polys: packPolys(polys), loopBusy: CS.loopBusy() };
  }

  // one message in, one result out; `post` is the worker's postMessage
  function handle(m, post) {
    let r;
    try { r = job(m); }
    catch (err) { post({ id: m.id, error: String(err && err.stack || err) }); return; }
    const transfer = r.polys ? [r.polys.pts.buffer, r.polys.offs.buffer, r.polys.layers.buffer] : r.bitmap ? [r.bitmap] : [];
    post({ id: m.id, ...r }, transfer);
  }
  return { job, handle };
};
// on the page: the in-thread fallback
if (self.PlotterLensCore) self.PlotWork = self.PlotWorkFactory(self.PlotterLensCore);
