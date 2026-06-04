import { useState, useRef, useEffect, useCallback, Component } from "react";
import * as THREE from "three";
import { supabase, supabaseEnabled } from "./supabaseClient";

// ─── FONTS ────────────────────────────────────────────────────────────────────
const FontLink = () => {
  useEffect(() => {
    ["https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap",
     "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0"
    ].forEach(href => {
      const l = document.createElement("link"); l.rel = "stylesheet"; l.href = href;
      document.head.appendChild(l);
    });
  }, []);
  return null;
};

// ─── ERROR BOUNDARY ───────────────────────────────────────────────────────────
class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    if (this.state.error) return (
      <div style={{ padding:24, color:"#D32F2F", fontFamily:"monospace", fontSize:12, background:"#1E1E1E", height:"100%", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center" }}>
        <div style={{ fontWeight:700, marginBottom:8 }}>3D Render Error: {this.state.error.message}</div>
        <button onClick={() => this.setState({ error:null })} style={{ marginTop:12, padding:"8px 16px", background:"#D32F2F", color:"#fff", border:"none", cursor:"pointer", fontFamily:"'Space Grotesk'", fontWeight:700, fontSize:11 }}>Retry</button>
      </div>
    );
    return this.props.children;
  }
}

// ─── PALLET PRESETS (cm — quy đổi từ 48×40×61 in và 43×43×61 in) ─────────────
const PALLET_PRESETS = [
  { label: "GMA    — 122×102×155 cm", w: 122, h: 155, d: 102 },
  { label: "Square — 109×109×155 cm", w: 109, h: 155, d: 109 },
  { label: "Nhập tay...",              w:   0, h:   0, d:   0, custom: true },
];

const VOL_DIVISOR = 6000;
const DEFAULT_GAP = 1.5; // cm — khoảng hở ngang giữa các kiện (1–2cm để công nhân kê tay)
const BOX_COLORS = [
  "#e53935","#42a5f5","#66bb6a","#ffa726","#ab47bc",
  "#26c6da","#d4e157","#ec407a","#8d6e63","#ff7043",
  "#5c6bc0","#26a69a","#ffca28","#7e57c2","#ef5350",
  "#29b6f6","#9ccc65","#ffb300","#f06292","#4db6ac",
];
const LS = { fontFamily:"'Space Grotesk'", fontSize:9, fontWeight:700, color:"#555", textTransform:"uppercase", letterSpacing:"0.13em" };

// ─── PARSER ───────────────────────────────────────────────────────────────────
// manual=true → bắt buộc cột thứ 6 là số pallet sếp chỉ định.
// Trả về { items, skipped }. skipped là array { id, lineNo, reason } để UI cảnh báo.
function parseExcelPaste(raw, manual = false) {
  const items = [];
  const skipped = [];
  const minCols = manual ? 6 : 5;
  const lines = raw.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const t = lines[li].trim(); if (!t) continue;
    const sep = t.includes("\t") ? "\t" : ",";
    const cols = t.split(sep).map(c => c.trim());
    const [id, c1, c2, c3, c4, c5] = cols;
    const lineNo = li + 1;
    if (cols.length < minCols) {
      skipped.push({ id: id || "(no id)", lineNo, reason: `thiếu cột (${cols.length}/${minCols})` });
      continue;
    }
    if (isNaN(+c1) || isNaN(+c2) || isNaN(+c3) || isNaN(+c4)) {
      skipped.push({ id: id || "(no id)", lineNo, reason: "W/H/D/Weight không phải số" });
      continue;
    }
    if (manual && (isNaN(+c5) || +c5 < 1)) {
      skipped.push({ id: id || "(no id)", lineNo, reason: "Pallet# không hợp lệ" });
      continue;
    }
    const w = Math.abs(+c1), h = Math.abs(+c2), d = Math.abs(+c3), wt = Math.abs(+c4);
    if (!w || !h || !d) {
      skipped.push({ id: id || "(no id)", lineNo, reason: "W/H/D = 0" });
      continue;
    }
    const item = { id: id || `BOX-${items.length+1}`, width:w, height:h, depth:d, weight:wt };
    if (manual) item.palletNum = Math.max(1, Math.round(+c5));
    items.push(item);
  }
  return { items, skipped };
}

// ─── PACKING — heightmap approach ─────────────────────────────────────────────
// 2D height field H[x][z] = top hiện tại tại (x,z). Kiện mới tự động "rest" trên
// max H trong footprint → không bao giờ float. Khoảng trống dưới (overhang)
// được tính như "không support".
//
// MIN_SUPPORT (0.7): đáy được đỡ ≥70% mới ưu tiên — kiện ổn định.
// FALLBACK_MIN_SUPPORT (0.5): nếu không vị trí nào ≥70%, chấp nhận ≥50% (kê
// chéo nhẹ vẫn không trôi). Không bao giờ <50% — staff không xếp được thực tế.

function newPalletState(PW, PH, PD) {
  const PWi = Math.round(PW), PDi = Math.round(PD);
  const stride = PWi + 1;
  return {
    H: new Int16Array(stride * (PDi + 1)),
    packed: [],
    candKeys: new Set(["0,0"]),
    maxY: 0,
    PWi, PDi, stride, PW, PH, PD,
  };
}

function findBestPlacement(item, s, minSup = 0.7, fbSup = 0.5) {
  const rots = [
    [item.width, item.height, item.depth],
    [item.width, item.depth,  item.height],
    [item.height, item.width, item.depth],
    [item.height, item.depth, item.width],
    [item.depth, item.width,  item.height],
    [item.depth, item.height, item.width],
  ];
  let best = null, bestFb = null;
  for (const key of s.candKeys) {
    const [xs, zs] = key.split(",");
    const x0 = +xs, z0 = +zs;
    for (const rot of rots) {
      const w = rot[0], h = rot[1], d = rot[2];
      if (x0 + w > s.PW + 0.01 || z0 + d > s.PD + 0.01) continue;
      const wi = Math.round(w), di = Math.round(d);
      const xi0 = Math.round(x0), zi0 = Math.round(z0);
      let restY = 0;
      for (let zi = zi0; zi < zi0 + di; zi++) {
        const row = zi * s.stride;
        for (let xi = xi0; xi < xi0 + wi; xi++) {
          const v = s.H[row + xi]; if (v > restY) restY = v;
        }
      }
      if (restY + h > s.PH + 0.01) continue;
      let supported = 0;
      for (let zi = zi0; zi < zi0 + di; zi++) {
        const row = zi * s.stride;
        for (let xi = xi0; xi < xi0 + wi; xi++) {
          if (s.H[row + xi] === restY) supported++;
        }
      }
      const support = restY === 0 ? 1.0 : supported / (wi * di);
      const score = restY*1e8 + x0*1e4 + z0 + h*0.001;
      if (support >= fbSup && (!bestFb || score < bestFb.score)) {
        bestFb = { x:x0, y:restY, z:z0, w, h, d, score };
      }
      if (support < minSup) continue;
      if (!best || score < best.score) {
        best = { x:x0, y:restY, z:z0, w, h, d, score };
      }
    }
  }
  return best || bestFb;
}

function applyPlacement(s, placed, gap) {
  s.packed.push(placed);
  const wi = Math.round(placed.w), di = Math.round(placed.d);
  const xi0 = Math.round(placed.x), zi0 = Math.round(placed.z);
  const newTop = placed.y + placed.h;
  const ziMax = Math.min(zi0 + di, s.PDi + 1);
  const xiMax = Math.min(xi0 + wi, s.PWi + 1);
  for (let zi = zi0; zi < ziMax; zi++) {
    const row = zi * s.stride;
    for (let xi = xi0; xi < xiMax; xi++) {
      if (s.H[row + xi] < newTop) s.H[row + xi] = newTop;
    }
  }
  if (newTop > s.maxY) s.maxY = newTop;
  const nx = placed.x + placed.w + gap;
  const nz = placed.z + placed.d + gap;
  if (nx < s.PW - 0.5) s.candKeys.add(`${nx},${placed.z}`);
  if (nz < s.PD - 0.5) s.candKeys.add(`${placed.x},${nz}`);
  if (nx < s.PW - 0.5 && nz < s.PD - 0.5) s.candKeys.add(`${nx},${nz}`);
}

function packOnePallet(items, PW, PH, PD, gap = 0) {
  const state = newPalletState(PW, PH, PD);
  for (const item of items) {
    const p = findBestPlacement(item, state);
    if (!p) continue;
    applyPlacement(state, { ...item, x:p.x, y:p.y, z:p.z, w:p.w, h:p.h, d:p.d }, gap);
  }
  const ids = new Set(state.packed.map(p=>p.id));
  return { packed: state.packed, unpacked: items.filter(it=>!ids.has(it.id)) };
}

// ─── MULTI-PALLET ENGINE ──────────────────────────────────────────────────────
function maxFootprint(it) {
  return Math.max(it.width*it.depth, it.width*it.height, it.height*it.depth);
}
// Sort mặc định cho auto mode: footprint DESC, weight DESC.
// Kiện đáy bự xuống sàn trước → tile sàn hiệu quả, kiện nhỏ chèn lên trên.
function sortPackOrder(a, b) {
  const fa = maxFootprint(a), fb = maxFootprint(b);
  if (Math.abs(fb - fa) > 0.5) return fb - fa;
  return b.weight - a.weight;
}

// Mulberry32 — seeded PRNG, đảm bảo kết quả lặp lại được giữa các lần run.
function mulberry32(seed) {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Best-of-N: thử nhiều sort + random shuffle, chọn kết quả ít overflow nhất
// (hoặc nhiều kiện packed nhất, hoặc bbox nhỏ nhất nếu hoà). Dùng cho manual
// mode khi user lock pallet — đảm bảo tận dụng tối đa group user chỉ định.
function bestPackForGroup(items, PW, PH, PD, gap, nRandom = 30) {
  const sorts = [
    sortPackOrder,
    (a,b) => b.width*b.height*b.depth - a.width*a.height*a.depth,                         // volume DESC
    (a,b) => Math.max(b.width,b.height,b.depth) - Math.max(a.width,a.height,a.depth),     // max_dim DESC
    (a,b) => Math.min(b.width,b.height,b.depth) - Math.min(a.width,a.height,a.depth),     // min_dim DESC
    (a,b) => b.weight - a.weight,                                                           // weight DESC
    (a,b) => maxFootprint(a) - maxFootprint(b),                                            // footprint ASC
  ];

  let best = null;
  const consider = (arr) => {
    const r = packOnePallet(arr, PW, PH, PD, gap);
    if (!best || r.unpacked.length < best.unpacked.length) best = r;
  };

  for (const sortFn of sorts) {
    consider([...items].sort(sortFn));
    if (best.unpacked.length === 0) return best;
  }
  const rand = mulberry32(items.length * 31 + (items[0]?.id?.length || 0));
  for (let i = 0; i < nRandom; i++) {
    const arr = [...items];
    for (let j = arr.length - 1; j > 0; j--) {
      const k = Math.floor(rand() * (j+1));
      [arr[j], arr[k]] = [arr[k], arr[j]];
    }
    consider(arr);
    if (best.unpacked.length === 0) return best;
  }
  return best;
}
function packAllItems(items, palletDim, gap = 0) {
  const { w:PW, h:PH, d:PD } = palletDim;
  const sorted = [...items].sort(sortPackOrder);

  // Phase 1: Sequential pack để xác định N pallets cần dùng.
  let trialCount = 0, remaining = sorted, guard = 0;
  while (remaining.length > 0 && guard < 500) {
    guard++;
    const r = packOnePallet(remaining, PW, PH, PD, gap);
    if (r.packed.length === 0) break;
    trialCount++;
    remaining = r.unpacked;
  }
  const N = Math.max(1, trialCount);

  // Phase 2: Balanced pack với N pallets pre-init.
  // Tiêu chí: kiện mới đặt vào pallet sao cho max-Y sau khi đặt thấp nhất, cùng
  // điểm thì pallet thấp hơn thắng → các pallet cao đều, không có cái thấp tịt.
  const states = [];
  for (let i = 0; i < N; i++) states.push(newPalletState(PW, PH, PD));
  for (const item of sorted) {
    let best = null;
    for (const s of states) {
      const p = findBestPlacement(item, s);
      if (!p) continue;
      const newMaxY = Math.max(s.maxY, p.y + p.h);
      if (!best || newMaxY < best.newMaxY ||
          (newMaxY === best.newMaxY && s.maxY < best.s.maxY)) {
        best = { s, p, newMaxY };
      }
    }
    if (best) applyPlacement(best.s, { ...item, x:best.p.x, y:best.p.y, z:best.p.z, w:best.p.w, h:best.p.h, d:best.p.d }, gap);
  }

  // Phase 3: Patch — kiện chưa fit thì thử lại với support relaxed (0.4/0.3)
  // tương đương sếp xếp tay với overhang nhẹ, tránh phát sinh pallet thừa.
  const packedIds = new Set();
  states.forEach(s => s.packed.forEach(b => packedIds.add(b.id)));
  const skipped = sorted.filter(it => !packedIds.has(it.id));
  for (const item of skipped) {
    let best = null;
    for (const s of states) {
      const p = findBestPlacement(item, s, 0.4, 0.3);
      if (!p) continue;
      const newMaxY = Math.max(s.maxY, p.y + p.h);
      if (!best || newMaxY < best.newMaxY) best = { s, p };
    }
    if (best) applyPlacement(best.s, { ...item, x:best.p.x, y:best.p.y, z:best.p.z, w:best.p.w, h:best.p.h, d:best.p.d }, gap);
  }

  // Phase 4: Nếu vẫn còn kiện chưa fit, mở pallet mới (rare case).
  states.forEach(s => s.packed.forEach(b => packedIds.add(b.id)));
  let stillSkipped = sorted.filter(it => !packedIds.has(it.id));
  guard = 0;
  while (stillSkipped.length > 0 && guard < 10) {
    guard++;
    const extra = newPalletState(PW, PH, PD);
    const before = extra.packed.length;
    for (const item of stillSkipped) {
      const p = findBestPlacement(item, extra);
      if (p) applyPlacement(extra, { ...item, x:p.x, y:p.y, z:p.z, w:p.w, h:p.h, d:p.d }, gap);
    }
    if (extra.packed.length === before) break;
    states.push(extra);
    extra.packed.forEach(b => packedIds.add(b.id));
    stillSkipped = sorted.filter(it => !packedIds.has(it.id));
  }

  const pallets = states.map(s => ({ packed: s.packed, overflow: [] }));
  let remainingFinal = sorted.filter(it => !packedIds.has(it.id));
  if (remainingFinal.length > 0 && pallets.length > 0) {
    pallets[pallets.length - 1].overflow = remainingFinal;
  }

  // CHW per pallet (IATA): max(tổng kg pallet, bbox_pallet/6000) — pallet bị tính
  // theo bbox không gian thực chiếm chứ không phải sum vol từng kiện.
  // CHW tổng = sum CHW từng pallet (mỗi pallet là 1 lô shipping riêng).
  let totalActualItemVolume = 0;
  let totalBoundingVolume   = 0;
  let totalDimWeight        = 0;
  let totalChw              = 0;
  pallets.forEach(p => {
    if (p.packed.length === 0) {
      p.boundingBox = { w:0, h:0, d:0 }; p.boundingVolume = 0;
      p.weight = 0; p.dimWeight = 0; p.chw = 0;
      return;
    }
    let maxX = 0, maxY = 0, maxZ = 0, palletKg = 0;
    for (const b of p.packed) {
      if (b.x + b.w > maxX) maxX = b.x + b.w;
      if (b.y + b.h > maxY) maxY = b.y + b.h;
      if (b.z + b.d > maxZ) maxZ = b.z + b.d;
      palletKg += b.weight;
      totalActualItemVolume += b.w * b.h * b.d;
    }
    p.boundingBox = { w: maxX, h: maxY, d: maxZ };
    p.boundingVolume = maxX * maxY * maxZ;
    p.weight    = palletKg;
    p.dimWeight = p.boundingVolume / VOL_DIVISOR;
    p.chw       = Math.max(p.weight, p.dimWeight);
    totalBoundingVolume += p.boundingVolume;
    totalDimWeight      += p.dimWeight;
    totalChw            += p.chw;
  });

  const totalWeight = items.reduce((s,i)=>s+i.weight,0);
  // Stack density = actual items / bounding box (độ chặt của khối hàng)
  const utilization = totalBoundingVolume > 0
    ? ((totalActualItemVolume / totalBoundingVolume) * 100).toFixed(1)
    : "0.0";
  const totalPacked = pallets.reduce((s,p)=>s+p.packed.length,0);

  const lookup = {};
  pallets.forEach((p,pi)=>p.packed.forEach((item,bi)=>{ lookup[item.id]={ palletIndex:pi, palletNum:pi+1, order:bi+1, item }; }));
  return { pallets, totalWeight, dimWeight: totalDimWeight, cw: totalChw, utilization, totalItems:items.length, totalPacked, lookup, palletDim, totalBoundingVolume, gap, mode:"auto" };
}

// ─── MANUAL MODE — sếp chỉ định pallet, app chỉ tính vị trí trong nhóm ────────
function packManualGroups(items, palletDim, gap = 0) {
  const { w:PW, h:PH, d:PD } = palletDim;
  const groups = {};
  for (const item of items) {
    const k = item.palletNum || 1;
    (groups[k] = groups[k] || []).push(item);
  }
  const palletNums = Object.keys(groups).map(Number).sort((a,b)=>a-b);

  const pallets = [];
  let totalActualItemVolume = 0;
  let totalBoundingVolume = 0;

  let totalDimWeight = 0;
  let totalChw       = 0;

  for (const num of palletNums) {
    // Manual mode: user đã chọn pallet → cần fit tối đa kiện trong group.
    // Best-of-N (sort variations + random shuffles) tăng khả năng fit hết.
    const { packed, unpacked } = bestPackForGroup(groups[num], PW, PH, PD, gap);
    let maxX = 0, maxY = 0, maxZ = 0, palletKg = 0;
    for (const b of packed) {
      if (b.x + b.w > maxX) maxX = b.x + b.w;
      if (b.y + b.h > maxY) maxY = b.y + b.h;
      if (b.z + b.d > maxZ) maxZ = b.z + b.d;
      palletKg += b.weight;
      totalActualItemVolume += b.w * b.h * b.d;
    }
    const bbox = { w:maxX, h:maxY, d:maxZ };
    const bboxVol = maxX * maxY * maxZ;
    const palletDimWt = bboxVol / VOL_DIVISOR;
    const palletChw = Math.max(palletKg, palletDimWt);
    totalBoundingVolume += bboxVol;
    totalDimWeight      += palletDimWt;
    totalChw            += palletChw;
    pallets.push({
      packed, overflow: unpacked,
      boundingBox: bbox, boundingVolume: bboxVol,
      weight: palletKg, dimWeight: palletDimWt, chw: palletChw,
      manualPalletNum: num,
    });
  }

  const totalWeight = items.reduce((s,i)=>s+i.weight,0);
  const utilization = totalBoundingVolume > 0
    ? ((totalActualItemVolume / totalBoundingVolume) * 100).toFixed(1)
    : "0.0";
  const totalPacked = pallets.reduce((s,p)=>s+p.packed.length,0);
  const totalOverflow = pallets.reduce((s,p)=>s+p.overflow.length,0);

  const lookup = {};
  pallets.forEach((p,pi)=>p.packed.forEach((item,bi)=>{
    lookup[item.id] = { palletIndex:pi, palletNum:p.manualPalletNum, order:bi+1, item };
  }));
  return { pallets, totalWeight, dimWeight: totalDimWeight, cw: totalChw, utilization, totalItems:items.length, totalPacked, totalOverflow, lookup, palletDim, totalBoundingVolume, gap, mode:"manual" };
}

// ─── 3D VIEWER ────────────────────────────────────────────────────────────────
function PalletViewer3D({ packedItems, palletIndex, totalPallets, highlightId, palletDim, boundingBox }) {
  const mountRef = useRef(null);
  const PW = palletDim.w, PH = palletDim.h, PD = palletDim.d;
  // Camera radius scales với pallet size (đơn vị thay đổi cm→inch không vỡ view)
  const SCALE   = Math.max(PW, PD, PH);
  const camRef  = useRef({ theta:0.7, phi:1.05, radius: SCALE*2.4, zoom:1, dragging:false, px:0, py:0 });
  const rafRef  = useRef(null);

  useEffect(() => {
    const mount = mountRef.current; if (!mount) return;
    const W = mount.clientWidth||600, H = mount.clientHeight||500;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c0c0c);
    const grid = new THREE.GridHelper(Math.max(PW,PD)*3, 24, 0x1a1a1a, 0x1a1a1a);
    grid.position.set(PW/2,-0.5,PD/2); scene.add(grid);

    const renderer = new THREE.WebGLRenderer({ antialias:true, powerPreference:"high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
    renderer.setSize(W,H); renderer.shadowMap.enabled=true;
    renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    const camera = new THREE.PerspectiveCamera(42, W/H, 0.1, 5000);
    scene.add(new THREE.AmbientLight(0xffffff,0.5));
    const sun = new THREE.DirectionalLight(0xffffff,0.9);
    sun.position.set(SCALE*1.5, SCALE*2.5, SCALE*1.5); sun.castShadow=true; sun.shadow.mapSize.set(1024,1024); scene.add(sun);
    scene.add(new THREE.HemisphereLight(0x334455,0x221100,0.45));

    // Pallet wireframe (red)
    const palletGeo = new THREE.BoxGeometry(PW,PH,PD);
    const palletCenter = new THREE.Vector3(PW/2,PH/2,PD/2);
    const wire = new THREE.LineSegments(new THREE.EdgesGeometry(palletGeo), new THREE.LineBasicMaterial({ color:0xD32F2F }));
    wire.position.copy(palletCenter); scene.add(wire);
    const shell = new THREE.Mesh(palletGeo, new THREE.MeshBasicMaterial({ color:0xD32F2F, transparent:true, opacity:0.025, side:THREE.BackSide }));
    shell.position.copy(palletCenter); scene.add(shell);

    // NEW: Bounding box wireframe (green dashed) — hiển thị CHW dimensions
    if (boundingBox && boundingBox.w > 0) {
      const bbGeo = new THREE.BoxGeometry(boundingBox.w, boundingBox.h, boundingBox.d);
      const bbMat = new THREE.LineDashedMaterial({ color:0x10B981, dashSize:3, gapSize:2 });
      const bbWire = new THREE.LineSegments(new THREE.EdgesGeometry(bbGeo), bbMat);
      bbWire.position.set(boundingBox.w/2, boundingBox.h/2, boundingBox.d/2);
      bbWire.computeLineDistances();
      scene.add(bbWire);
    }

    // Floor
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(PW,PD), new THREE.MeshStandardMaterial({ color:0x181818, roughness:1 }));
    floor.rotation.x=-Math.PI/2; floor.position.set(PW/2,0,PD/2); floor.receiveShadow=true; scene.add(floor);

    packedItems.forEach((item,idx)=>{
      if (item.w<=0||item.h<=0||item.d<=0) return;
      const isHighlighted = highlightId && item.id===highlightId;
      const isDimmed      = highlightId && item.id!==highlightId;
      const color = isHighlighted ? new THREE.Color(0xFFFFFF) : new THREE.Color(BOX_COLORS[idx%BOX_COLORS.length]);
      const geo = new THREE.BoxGeometry(item.w,item.h,item.d);
      const pos = new THREE.Vector3(item.x+item.w/2, item.y+item.h/2, item.z+item.d/2);

      const box = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
        color, transparent:true, opacity: isDimmed?0.18 : isHighlighted?1.0 : 0.84,
        specular:0x111111, shininess:20,
        emissive: isHighlighted ? new THREE.Color(0xD32F2F) : new THREE.Color(0x000000),
        emissiveIntensity: isHighlighted ? 0.4 : 0,
      }));
      box.position.copy(pos); box.castShadow=true; box.receiveShadow=true; scene.add(box);

      const edgeMesh = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: isHighlighted?0xFFFFFF:0x000000, transparent:true, opacity: isDimmed?0.08:0.3 })
      );
      edgeMesh.position.copy(pos); scene.add(edgeMesh);

      if (isHighlighted) {
        const glowGeo = new THREE.BoxGeometry(item.w+2, item.h+2, item.d+2);
        const glowMesh = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({ color:0xD32F2F, transparent:true, opacity:0.25, side:THREE.BackSide }));
        glowMesh.position.copy(pos); scene.add(glowMesh);
      }
    });

    const cx=PW/2, cy=PH*0.42, cz=PD/2;
    const updateCam=()=>{
      const {theta,phi,radius,zoom}=camRef.current, r=radius*zoom;
      camera.position.set(cx+r*Math.sin(phi)*Math.cos(theta), cy+r*Math.cos(phi), cz+r*Math.sin(phi)*Math.sin(theta));
      camera.lookAt(cx,cy,cz);
    };
    const animate=()=>{ rafRef.current=requestAnimationFrame(animate); updateCam(); renderer.render(scene,camera); };
    animate();

    const el=renderer.domElement;
    const onDown=e=>{ camRef.current.dragging=true; camRef.current.px=e.clientX; camRef.current.py=e.clientY; };
    const onMove=e=>{ if(!camRef.current.dragging) return; const dx=e.clientX-camRef.current.px, dy=e.clientY-camRef.current.py; camRef.current.theta-=dx*0.006; camRef.current.phi=Math.max(0.1,Math.min(Math.PI-0.1,camRef.current.phi+dy*0.006)); camRef.current.px=e.clientX; camRef.current.py=e.clientY; };
    const onUp=()=>{ camRef.current.dragging=false; };
    const onWheel=e=>{ camRef.current.zoom=Math.max(0.2,Math.min(5,camRef.current.zoom+e.deltaY*0.001)); };
    el.addEventListener("mousedown",onDown); window.addEventListener("mousemove",onMove); window.addEventListener("mouseup",onUp); el.addEventListener("wheel",onWheel,{passive:true});

    const ro=new ResizeObserver(()=>{ const nw=mount.clientWidth||1,nh=mount.clientHeight||1; renderer.setSize(nw,nh); camera.aspect=nw/nh; camera.updateProjectionMatrix(); });
    ro.observe(mount);

    return ()=>{
      cancelAnimationFrame(rafRef.current);
      el.removeEventListener("mousedown",onDown); window.removeEventListener("mousemove",onMove); window.removeEventListener("mouseup",onUp); el.removeEventListener("wheel",onWheel);
      ro.disconnect();
      if (mount.contains(el)) mount.removeChild(el);
      scene.traverse(obj=>{ if(obj.geometry) obj.geometry.dispose(); if(obj.material){ if(Array.isArray(obj.material)) obj.material.forEach(m=>m.dispose()); else obj.material.dispose(); } });
      renderer.dispose();
    };
  }, [packedItems, highlightId, PW, PH, PD, boundingBox]);

  const cs=camRef.current;
  const bbText = boundingBox && boundingBox.w > 0
    ? `BBox: ${boundingBox.w.toFixed(0)}×${boundingBox.d.toFixed(0)}×${boundingBox.h.toFixed(0)}cm`
    : "";

  return (
    <div style={{ position:"relative", width:"100%", height:"100%" }}>
      <div ref={mountRef} style={{ width:"100%", height:"100%", cursor:"grab" }} />
      <div style={{ position:"absolute", top:10, left:10, background:"rgba(0,0,0,0.72)", backdropFilter:"blur(6px)", border:"1px solid #2C2C2C", padding:"4px 10px", pointerEvents:"none" }}>
        <span style={{ fontFamily:"'Space Grotesk'", fontSize:10, color:"#fff", letterSpacing:"0.18em", textTransform:"uppercase", fontWeight:700 }}>
          Pallet {palletIndex+1}/{totalPallets} — {packedItems.length} kiện — {PW}×{PD}×{PH}cm
        </span>
      </div>
      <div style={{ position:"absolute", top:10, right:10, display:"flex", flexDirection:"column", gap:5 }}>
        {[["zoom_in",()=>{cs.zoom=Math.max(0.2,cs.zoom-0.2);}],["zoom_out",()=>{cs.zoom=Math.min(5,cs.zoom+0.2);}],["refresh",()=>{cs.theta=0.7;cs.phi=1.05;cs.zoom=1;}]].map(([icon,fn])=>(
          <button key={icon} onClick={fn} style={{ width:34,height:34,display:"flex",alignItems:"center",justifyContent:"center",background:"rgba(20,20,20,0.9)",border:"1px solid #2C2C2C",color:"#fff",cursor:"pointer",transition:"background .15s" }}
            onMouseEnter={e=>e.currentTarget.style.background="#D32F2F"} onMouseLeave={e=>e.currentTarget.style.background="rgba(20,20,20,0.9)"}>
            <span className="material-symbols-outlined" style={{fontSize:16}}>{icon}</span>
          </button>
        ))}
      </div>
      <div style={{ position:"absolute",bottom:0,left:0,right:0,padding:"8px 14px",background:"rgba(15,15,15,0.65)",backdropFilter:"blur(4px)",borderTop:"1px solid #2C2C2C",display:"flex",gap:16,flexWrap:"wrap",alignItems:"center" }}>
        {highlightId && <div style={{ display:"flex",alignItems:"center",gap:6 }}><div style={{ width:9,height:9,background:"#fff",boxShadow:"0 0 6px #D32F2F" }}/><span style={{ fontFamily:"'Space Grotesk'",fontSize:9,color:"#fff",textTransform:"uppercase",letterSpacing:"0.1em",fontWeight:700 }}>Highlighted: {highlightId}</span></div>}
        {bbText && <div style={{ display:"flex",alignItems:"center",gap:5 }}>
          <div style={{ width:14,height:2,background:"#10B981",boxShadow:"0 0 3px #10B981" }}/>
          <span style={{ fontFamily:"'Space Grotesk'",fontSize:9,color:"#10B981",textTransform:"uppercase",letterSpacing:"0.1em",fontWeight:700 }}>{bbText}</span>
        </div>}
        {[["#e53935","Heavy"],["#42a5f5","Standard"],["#66bb6a","Light"]].map(([c,l])=>(
          <div key={l} style={{ display:"flex",alignItems:"center",gap:5 }}>
            <div style={{ width:9,height:9,background:c }}/><span style={{ fontFamily:"'Space Grotesk'",fontSize:9,color:"#999",textTransform:"uppercase",letterSpacing:"0.1em" }}>{l}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── STAT CARD ────────────────────────────────────────────────────────────────
function StatCard({ label, value, sub, icon, bar }) {
  return (
    <div style={{ background:"#1E1E1E",padding:"16px 18px",border:"1px solid transparent",flex:1,minWidth:0,transition:"border-color .2s" }}
      onMouseEnter={e=>e.currentTarget.style.borderColor="#2C2C2C"} onMouseLeave={e=>e.currentTarget.style.borderColor="transparent"}>
      <div style={{ display:"flex",justifyContent:"space-between",marginBottom:10 }}>
        <span style={LS}>{label}</span>
        <span className="material-symbols-outlined" style={{ fontSize:17,color:"#D32F2F" }}>{icon}</span>
      </div>
      <div style={{ display:"flex",alignItems:"baseline",gap:7,minWidth:0 }}>
        <span className="stat-val" style={{ fontFamily:"'Space Grotesk'",fontSize:24,fontWeight:700,color:"#fff",lineHeight:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",minWidth:0 }}>{value}</span>
        {sub&&<span style={{ fontSize:11,color:"#555",fontFamily:"'Inter'",whiteSpace:"nowrap" }}>{sub}</span>}
      </div>
      {bar!==undefined&&<div style={{ marginTop:9,height:3,background:"#2C2C2C",borderRadius:2 }}><div style={{ height:"100%",width:`${Math.min(100,bar)}%`,background:"#D32F2F",borderRadius:2,transition:"width .7s ease" }}/></div>}
    </div>
  );
}

// ─── SAMPLE (cm) ──────────────────────────────────────────────────────────────
const SAMPLE = `ID, Width, Height, Depth, Weight
BOX-001, 50, 50, 50, 25
BOX-002, 50, 50, 50, 18
BOX-003, 50, 50, 50, 30
BOX-004, 50, 50, 50, 12
BOX-005, 50, 50, 50, 22
BOX-006, 50, 50, 50, 35
BOX-007, 50, 50, 50, 8
BOX-008, 50, 50, 50, 28
BOX-009, 50, 50, 50, 15`;

// Sample cho Manual mode — cột thứ 6 là số pallet sếp chỉ định
const SAMPLE_MANUAL = `ID, Width, Height, Depth, Weight, Pallet
BOX-001, 50, 50, 50, 25, 1
BOX-002, 50, 50, 50, 18, 1
BOX-003, 50, 50, 50, 30, 1
BOX-004, 50, 50, 50, 12, 2
BOX-005, 50, 50, 50, 22, 2
BOX-006, 50, 50, 50, 35, 2
BOX-007, 50, 50, 50, 8, 3
BOX-008, 50, 50, 50, 28, 3
BOX-009, 50, 50, 50, 15, 3`;

// ─── WAREHOUSE SCAN TAB ───────────────────────────────────────────────────────
function ScanTab({ result, onJumpToPallet }) {
  const [scanInput, setScanInput]   = useState("");
  const [scanResult, setScanResult] = useState(null);
  const [notFound, setNotFound]     = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const doScan = useCallback((val) => {
    const id = (val || scanInput).trim();
    if (!id) return;
    if (!result) { alert("Chưa có dữ liệu! Chạy Optimization trước."); return; }
    const found = result.lookup[id];
    if (found) { setScanResult(found); setNotFound(false); }
    else { setScanResult(null); setNotFound(true); }
  }, [scanInput, result]);

  const handleKey = e => { if (e.key === "Enter") doScan(); };

  const scanNext = () => {
    setScanInput(""); setScanResult(null); setNotFound(false);
    setTimeout(() => inputRef.current?.focus(), 30);
  };

  const tier = scanResult ? (
    scanResult.item.y < 40 ? "Tầng 1 (Sàn)" :
    scanResult.item.y < 90 ? "Tầng 2 (Giữa)" : "Tầng 3 (Trên)"
  ) : "";

  return (
    <div className="scan-scroll" style={{ flex:1, overflow:"auto", padding:"16px 14px", display:"flex", flexDirection:"column", gap:14, maxWidth:560, margin:"0 auto", width:"100%" }}>

      {/* Input — to, dễ scan trên phone */}
      <div style={{ background:"#1E1E1E", border:"1px solid #2C2C2C", padding:14 }}>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          <span className="material-symbols-outlined" style={{ fontSize:22, color:"#D32F2F" }}>qr_code_scanner</span>
          <input
            ref={inputRef}
            value={scanInput}
            onChange={e => { setScanInput(e.target.value); setScanResult(null); setNotFound(false); }}
            onKeyDown={handleKey}
            placeholder="Scan / nhập ID kiện..."
            autoComplete="off" autoCapitalize="characters" autoCorrect="off" spellCheck="false"
            style={{ flex:1, background:"#121212", border:"1px solid #2C2C2C", color:"#fff", fontFamily:"monospace", fontSize:16, padding:"12px 14px", outline:"none", letterSpacing:"0.05em", minWidth:0 }}
            onFocus={e=>e.target.style.borderColor="#D32F2F"} onBlur={e=>e.target.style.borderColor="#2C2C2C"}
          />
          {(scanInput || scanResult) && (
            <button onClick={scanNext} title="Xoá"
              style={{ background:"transparent", border:"1px solid #2C2C2C", color:"#888", padding:"10px 12px", cursor:"pointer", fontSize:16, lineHeight:1 }}>×</button>
          )}
        </div>
        {!result && (
          <div style={{ marginTop:10, padding:"10px 12px", background:"#1a0f0f", border:"1px solid #4a1a1a", color:"#ff6b6b", fontFamily:"'Space Grotesk'", fontSize:12 }}>
            ⚠ Chưa có dữ liệu — chạy Optimization hoặc chọn flight đã lưu
          </div>
        )}
      </div>

      {/* Result — pallet số TO ĐÙNG */}
      {scanResult && (
        <>
          <div style={{ background:"#D32F2F", padding:"28px 18px 22px", textAlign:"center", position:"relative", overflow:"hidden" }}>
            <div style={{ ...LS, color:"rgba(255,255,255,0.85)", marginBottom:4 }}>{scanResult.item.id}</div>
            <div style={{ ...LS, color:"rgba(255,255,255,0.7)", marginBottom:8 }}>ĐẶT VÀO PALLET</div>
            <div style={{ fontFamily:"'Space Grotesk'", fontWeight:700, color:"#fff", lineHeight:1, fontSize:"clamp(96px, 32vw, 180px)" }}>
              {scanResult.palletNum}
            </div>
            {scanResult.order && (
              <div style={{ marginTop:10, fontFamily:"'Space Grotesk'", fontSize:14, color:"rgba(255,255,255,0.9)", fontWeight:600 }}>
                Thứ tự xếp: #{scanResult.order}
              </div>
            )}
          </div>

          {/* Position + dim — compact 2 cột */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
            {[
              ["Tầng",        tier,                                                               "layers"],
              ["Cao Y",       `${scanResult.item.y.toFixed(0)} cm`,                              "height"],
              ["Vị trí X",    `${scanResult.item.x.toFixed(0)} cm`,                              "arrow_right_alt"],
              ["Vị trí Z",    `${scanResult.item.z.toFixed(0)} cm`,                              "arrow_right_alt"],
              ["Kích thước",  `${scanResult.item.w}×${scanResult.item.h}×${scanResult.item.d}`,  "straighten"],
              ["KG / CHW",    `${scanResult.item.weight} / ${Math.max(scanResult.item.weight, (scanResult.item.w*scanResult.item.h*scanResult.item.d)/6000).toFixed(2)}`, "weight"],
            ].map(([label, val, icon]) => (
              <div key={label} style={{ background:"#1E1E1E", border:"1px solid #2C2C2C", padding:"10px 12px" }}>
                <div style={{ display:"flex", alignItems:"center", gap:5, marginBottom:4 }}>
                  <span className="material-symbols-outlined" style={{ fontSize:13, color:"#D32F2F" }}>{icon}</span>
                  <span style={{ ...LS }}>{label}</span>
                </div>
                <div style={{ fontFamily:"'Space Grotesk'", fontSize:15, fontWeight:700, color:"#fff" }}>{val}</div>
              </div>
            ))}
          </div>

          {/* Big action buttons */}
          <button onClick={scanNext}
            style={{ background:"#D32F2F", color:"#fff", border:"none", padding:"16px 0", cursor:"pointer", fontFamily:"'Space Grotesk'", fontWeight:700, fontSize:14, textTransform:"uppercase", letterSpacing:"0.14em" }}>
            ▶ Scan tiếp
          </button>
          <button onClick={() => onJumpToPallet(scanResult.palletIndex, scanResult.item.id)}
            style={{ background:"transparent", border:"1px solid #2C2C2C", color:"#888", padding:"12px 0", cursor:"pointer", fontFamily:"'Space Grotesk'", fontWeight:700, fontSize:11, textTransform:"uppercase", letterSpacing:"0.14em" }}>
            Xem vị trí 3D
          </button>
        </>
      )}

      {/* Not found */}
      {notFound && (
        <>
          <div style={{ background:"#1a0f0f", border:"2px solid #D32F2F", padding:"30px 18px", textAlign:"center" }}>
            <span className="material-symbols-outlined" style={{ fontSize:60, color:"#D32F2F" }}>search_off</span>
            <div style={{ fontFamily:"'Space Grotesk'", fontSize:18, fontWeight:700, color:"#D32F2F", marginTop:8 }}>KHÔNG TÌM THẤY</div>
            <div style={{ fontFamily:"monospace", fontSize:14, color:"#fff", marginTop:6, wordBreak:"break-all" }}>{scanInput}</div>
            <div style={{ fontFamily:"'Inter'", fontSize:11, color:"#888", marginTop:8 }}>ID không có trong flight hiện tại</div>
          </div>
          <button onClick={scanNext}
            style={{ background:"#D32F2F", color:"#fff", border:"none", padding:"16px 0", cursor:"pointer", fontFamily:"'Space Grotesk'", fontWeight:700, fontSize:14, textTransform:"uppercase", letterSpacing:"0.14em" }}>
            ▶ Scan tiếp
          </button>
        </>
      )}

      {/* Idle hint — gọn */}
      {!scanResult && !notFound && result && (
        <div style={{ ...LS, color:"#555", textAlign:"center", padding:"40px 10px", lineHeight:1.8 }}>
          {result.totalItems} kiện trên {result.pallets.length} pallet<br/>
          Scan hoặc nhập ID để tra cứu
        </div>
      )}
    </div>
  );
}

// ─── LOGIN SCREEN ─────────────────────────────────────────────────────────────
function LoginScreen({ onSignedIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(null); setBusy(true);
    const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) { setError(error.message); return; }
    if (data?.session) onSignedIn(data.session);
  };

  return (
    <>
      <FontLink />
      <div style={{ height:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#121212",fontFamily:"'Inter',sans-serif" }}>
        <form onSubmit={submit} style={{ width:340,background:"#1E1E1E",border:"1px solid #2C2C2C",padding:"28px 26px" }}>
          <div style={{ fontFamily:"'Space Grotesk'",fontSize:18,fontWeight:700,color:"#fff",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:4 }}>3D Optimizer</div>
          <div style={{ ...LS,marginBottom:22 }}>Đăng nhập tài khoản kho</div>
          <div style={{ ...LS,marginBottom:6 }}>Email</div>
          <input value={email} onChange={e=>setEmail(e.target.value)} autoComplete="username" type="text"
            style={{ width:"100%",background:"#121212",border:"1px solid #2C2C2C",color:"#fff",fontFamily:"monospace",fontSize:12,padding:"9px 12px",outline:"none",marginBottom:14 }}
            onFocus={e=>e.target.style.borderColor="#D32F2F"} onBlur={e=>e.target.style.borderColor="#2C2C2C"} />
          <div style={{ ...LS,marginBottom:6 }}>Password</div>
          <input value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password" type="password"
            style={{ width:"100%",background:"#121212",border:"1px solid #2C2C2C",color:"#fff",fontFamily:"monospace",fontSize:12,padding:"9px 12px",outline:"none",marginBottom:14 }}
            onFocus={e=>e.target.style.borderColor="#D32F2F"} onBlur={e=>e.target.style.borderColor="#2C2C2C"} />
          {error && <div style={{ background:"#1a0f0f",border:"1px solid #4a1a1a",color:"#ff6b6b",fontSize:11,padding:"7px 10px",marginBottom:12,fontFamily:"'Inter'" }}>{error}</div>}
          <button type="submit" disabled={busy||!email||!password}
            style={{ width:"100%",background:busy?"#7a1a1a":"#D32F2F",color:"#fff",border:"none",padding:"10px 0",cursor:busy?"wait":"pointer",fontFamily:"'Space Grotesk'",fontWeight:700,fontSize:11,textTransform:"uppercase",letterSpacing:"0.14em" }}>
            {busy?"⟳ Đang đăng nhập...":"Đăng nhập"}
          </button>
        </form>
      </div>
    </>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [mode,        setMode]        = useState("auto"); // "auto" | "manual"
  const [rawAuto,     setRawAuto]     = useState(SAMPLE);
  const [rawManual,   setRawManual]   = useState(SAMPLE_MANUAL);
  const [resultAuto,  setResultAuto]  = useState(null);
  const [resultManual,setResultManual]= useState(null);
  const [timingAuto,  setTimingAuto]  = useState(null);
  const [timingManual,setTimingManual]= useState(null);
  const [running,     setRunning]     = useState(false);
  const [activePallet,setActive]      = useState(0);
  const [tab,         setTab]         = useState("dashboard");
  const [highlightId, setHighlight]   = useState(null);

  const [presetIdx,   setPresetIdx]   = useState(0);
  const [customW,     setCustomW]     = useState(122);
  const [customH,     setCustomH]     = useState(155);
  const [customD,     setCustomD]     = useState(102);
  const [gap,         setGap]         = useState(DEFAULT_GAP);

  // ─── Auth + Flights ────────────────────────────────────────────────────────
  const [session,        setSession]        = useState(null);
  const [authChecked,    setAuthChecked]    = useState(!supabaseEnabled);
  const [flights,        setFlights]        = useState([]);
  const [currentFlightId,setCurrentFlightId]= useState(() => {
    try { return localStorage.getItem("pallet:currentFlightId") || null; } catch { return null; }
  });
  const [autoLoadAttempted, setAutoLoadAttempted] = useState(false);
  const [showSaveModal,  setShowSaveModal]  = useState(false);
  const [saveFlightName, setSaveFlightName] = useState("");
  const [saving,         setSaving]         = useState(false);
  const [parseWarnings,  setParseWarnings]  = useState(null);
  const [showWarnings,   setShowWarnings]   = useState(false);

  useEffect(() => {
    if (!supabaseEnabled) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthChecked(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const refreshFlights = useCallback(async () => {
    if (!supabaseEnabled || !session) { setFlights([]); return; }
    const { data, error } = await supabase
      .from("flights")
      .select("id,name,mode,pallet_w,pallet_h,pallet_d,gap,updated_at")
      .order("updated_at", { ascending: false });
    if (!error) setFlights(data || []);
  }, [session]);

  useEffect(() => { refreshFlights(); }, [refreshFlights]);

  // Persist currentFlightId → localStorage để refresh không mất state
  useEffect(() => {
    try {
      if (currentFlightId) localStorage.setItem("pallet:currentFlightId", currentFlightId);
      else localStorage.removeItem("pallet:currentFlightId");
    } catch {}
  }, [currentFlightId]);

  // Auto-load flight sau khi flights về (lần đầu mount, chỉ 1 lần)
  useEffect(() => {
    if (autoLoadAttempted || !session || flights.length === 0 || !currentFlightId) return;
    if (flights.find(f => f.id === currentFlightId)) {
      handleLoadFlight(currentFlightId);
    }
    setAutoLoadAttempted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flights, session, currentFlightId, autoLoadAttempted]);

  // Derived (theo mode hiện tại)
  const raw    = mode === "auto" ? rawAuto    : rawManual;
  const result = mode === "auto" ? resultAuto : resultManual;
  const timing = mode === "auto" ? timingAuto : timingManual;
  const updateRaw = (val) => mode === "auto" ? setRawAuto(val) : setRawManual(val);

  const switchMode = (m) => {
    if (m === mode) return;
    setMode(m);
    setActive(0);
    setHighlight(null);
  };

  const getPalletDim = () => {
    const p = PALLET_PRESETS[presetIdx];
    if (p.custom) return { w: +customW||122, h: +customH||155, d: +customD||102 };
    return { w: p.w, h: p.h, d: p.d };
  };

  const handleOptimize = useCallback(() => {
    setRunning(true);
    const t0 = performance.now();
    setTimeout(() => {
      try {
        const { items, skipped } = parseExcelPaste(raw, mode === "manual");
        setParseWarnings(skipped.length > 0 ? skipped : null);
        if (!items.length) {
          alert(mode === "manual"
            ? "Không có dữ liệu hợp lệ!\nFormat Manual: ID, Width, Height, Depth, Weight, Pallet#"
            : "Không có dữ liệu hợp lệ!\nFormat: ID, Width, Height, Depth, Weight");
          setRunning(false); return;
        }
        const dim = getPalletDim();
        const g = Math.max(0, +gap || 0);
        const res = mode === "manual"
          ? packManualGroups(items, dim, g)
          : packAllItems(items, dim, g);
        const t = ((performance.now()-t0)/1000).toFixed(3);
        if (mode === "manual") { setResultManual(res); setTimingManual(t); }
        else                   { setResultAuto(res);   setTimingAuto(t);   }
        setActive(0); setHighlight(null);
      } catch(e) { alert("Lỗi: "+e.message); }
      setRunning(false);
    }, 30);
  }, [raw, mode, presetIdx, customW, customH, customD, gap]);

  const handleJumpToPallet = (palletIndex, itemId) => {
    setActive(palletIndex);
    setHighlight(itemId);
    setTab("dashboard");
  };

  // ─── Flight handlers ───────────────────────────────────────────────────────
  const handleSaveFlight = async () => {
    if (!supabaseEnabled || !session) return;
    const name = saveFlightName.trim();
    if (!name) { alert("Đặt tên flight"); return; }
    setSaving(true);
    const d = getPalletDim();
    const payload = {
      name, raw_input: raw, mode,
      pallet_w: d.w, pallet_h: d.h, pallet_d: d.d,
      gap: Math.max(0, +gap || 0),
      updated_at: new Date().toISOString(),
    };
    let res;
    if (currentFlightId) {
      res = await supabase.from("flights").update(payload).eq("id", currentFlightId).select().single();
    } else {
      res = await supabase.from("flights").insert(payload).select().single();
    }
    setSaving(false);
    if (res.error) { alert("Lỗi lưu: "+res.error.message); return; }
    setCurrentFlightId(res.data.id);
    setShowSaveModal(false);
    setSaveFlightName("");
    refreshFlights();
  };

  const handleLoadFlight = async (flightId) => {
    if (!supabaseEnabled) return;
    const { data, error } = await supabase.from("flights").select("*").eq("id", flightId).single();
    if (error) { alert("Lỗi load: "+error.message); return; }
    setMode(data.mode);
    if (data.mode === "manual") setRawManual(data.raw_input);
    else                        setRawAuto(data.raw_input);
    // Map pallet config sang preset hoặc custom
    const matchPreset = PALLET_PRESETS.findIndex(p =>
      !p.custom && Math.abs(p.w - data.pallet_w) < 0.5 && Math.abs(p.h - data.pallet_h) < 0.5 && Math.abs(p.d - data.pallet_d) < 0.5);
    if (matchPreset >= 0) {
      setPresetIdx(matchPreset);
    } else {
      setPresetIdx(PALLET_PRESETS.findIndex(p => p.custom));
      setCustomW(data.pallet_w); setCustomH(data.pallet_h); setCustomD(data.pallet_d);
    }
    setGap(+data.gap);
    setCurrentFlightId(data.id);
    setActive(0); setHighlight(null);
    setSaveFlightName(data.name);
    // Auto-run optimization sau khi state set
    setTimeout(() => handleOptimize(), 50);
  };

  const handleDeleteFlight = async (flightId, name) => {
    if (!supabaseEnabled) return;
    if (!confirm(`Xoá flight "${name}"?`)) return;
    const { error } = await supabase.from("flights").delete().eq("id", flightId);
    if (error) { alert("Lỗi xoá: "+error.message); return; }
    if (currentFlightId === flightId) setCurrentFlightId(null);
    refreshFlights();
  };

  const handleLogout = async () => {
    if (!supabaseEnabled) return;
    await supabase.auth.signOut();
    setCurrentFlightId(null);
    setFlights([]);
  };

  // Guard: chưa check auth → blank. Cần login → LoginScreen.
  if (!authChecked) return null;
  if (supabaseEnabled && !session) return <LoginScreen onSignedIn={(s)=>setSession(s)} />;

  const cur = result?.pallets[activePallet];
  const dim = result?.palletDim || getPalletDim();

  return (
    <>
      <FontLink />
      <style>{`
        *{box-sizing:border-box;}
        ::-webkit-scrollbar{width:4px}
        ::-webkit-scrollbar-track{background:#121212}
        ::-webkit-scrollbar-thumb{background:#2C2C2C}
        ::-webkit-scrollbar-thumb:hover{background:#D32F2F}
        .mobile-tabs{display:none;}
        @media (max-width: 768px) {
          html,body{height:auto !important;overflow-x:hidden !important;overflow-y:visible !important;overscroll-behavior-y:auto;}
          .app-root{height:auto !important;min-height:100vh;overflow:visible !important;}
          .app-main{height:auto !important;min-height:calc(100vh - 44px) !important;overflow:visible !important;}
          .scan-scroll{overflow:visible !important;flex:none !important;}
          .app-sidebar{display:none !important;}
          .desktop-only{display:none !important;}
          .mobile-tabs{display:flex !important;}
          .app-header{height:44px !important;padding:0 12px !important;position:sticky;top:0;z-index:50;}
          .app-footer{display:none !important;}
          /* Dashboard layout fixes */
          .stat-row{display:grid !important;grid-template-columns:1fr 1fr !important;gap:6px !important;}
          .stat-row > *{min-width:0 !important;flex:none !important;padding:10px 12px !important;}
          .stat-row > * div[style*="font-size: 24"],.stat-row .stat-val{font-size:18px !important;}
          .dashboard-grid{grid-template-columns:1fr !important;gap:10px !important;flex:none !important;}
          .dashboard-grid > div{min-height:0 !important;}
          .opt-buttons{flex-wrap:wrap !important;}
          .opt-buttons > button{flex:1 1 100% !important;padding:11px 8px !important;}
          .opt-buttons > button.opt-secondary{flex:1 1 calc(50% - 4px) !important;}
          .viewer-3d{min-height:340px !important;height:340px !important;}
        }
      `}</style>
      <div className="app-root" style={{ display:"flex", height:"100vh", overflow:"hidden", background:"#121212", color:"#f9dcd9", fontFamily:"'Inter',sans-serif" }}>

        <aside className="app-sidebar" style={{ width:228, flexShrink:0, background:"#1E1E1E", borderRight:"1px solid #2C2C2C", display:"flex", flexDirection:"column" }}>
          <div style={{ padding:"18px 18px 10px" }}>
            <div style={{ fontFamily:"'Space Grotesk'", fontSize:16, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.1em", color:"#fff" }}>3D Optimizer</div>
            <div style={{ ...LS, marginTop:2 }}>Command Center</div>
          </div>

          <nav style={{ marginTop:12 }}>
            {[
              ["dashboard","dashboard","Dashboard"],
              ["scan","qr_code_scanner","Warehouse Scan"],
              ["settings","settings","Settings"],
            ].map(([id,icon,label])=>(
              <button key={id} onClick={()=>setTab(id)}
                style={{ display:"flex",alignItems:"center",width:"100%",padding:"11px 18px",background:tab===id?"#2C2C2C":"transparent",color:tab===id?"#fff":"#555",border:"none",borderLeft:tab===id?"3px solid #D32F2F":"3px solid transparent",cursor:"pointer",gap:12,transition:"all .15s" }}
                onMouseEnter={e=>{if(tab!==id)e.currentTarget.style.background="#1a1a1a";}}
                onMouseLeave={e=>{if(tab!==id)e.currentTarget.style.background="transparent";}}>
                <span className="material-symbols-outlined" style={{fontSize:18}}>{icon}</span>
                <span style={{ fontFamily:"'Space Grotesk'",fontSize:11,textTransform:"uppercase",letterSpacing:"0.08em",fontWeight:tab===id?700:400 }}>{label}</span>
                {id==="scan"&&result&&<span style={{ marginLeft:"auto",background:"#D32F2F",color:"#fff",fontFamily:"'Space Grotesk'",fontSize:9,fontWeight:700,padding:"2px 6px" }}>{result.totalItems}</span>}
              </button>
            ))}
          </nav>

          <div style={{ padding:"14px", borderTop:"1px solid #2C2C2C", marginTop:8 }}>
            <div style={{ ...LS, marginBottom:8 }}>Loại Pallet</div>
            {PALLET_PRESETS.map((p,i)=>(
              <button key={i} onClick={()=>setPresetIdx(i)}
                style={{ display:"flex",alignItems:"center",width:"100%",padding:"8px 10px",marginBottom:4,background:presetIdx===i?"#2C2C2C":"transparent",border:presetIdx===i?"1px solid #D32F2F":"1px solid #2C2C2C",color:presetIdx===i?"#fff":"#666",cursor:"pointer",fontFamily:"monospace",fontSize:10,textAlign:"left",transition:"all .15s",gap:8 }}
                onMouseEnter={e=>{if(presetIdx!==i)e.currentTarget.style.borderColor="#555";}}
                onMouseLeave={e=>{if(presetIdx!==i)e.currentTarget.style.borderColor="#2C2C2C";}}>
                <span className="material-symbols-outlined" style={{fontSize:14,color:presetIdx===i?"#D32F2F":"#555",flexShrink:0}}>
                  {presetIdx===i?"radio_button_checked":"radio_button_unchecked"}
                </span>
                {p.label}
              </button>
            ))}

            {PALLET_PRESETS[presetIdx]?.custom && (
              <div style={{ marginTop:8, display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6 }}>
                {[["W",customW,setCustomW],["H",customH,setCustomH],["D",customD,setCustomD]].map(([label,val,setter])=>(
                  <div key={label}>
                    <div style={{ ...LS, marginBottom:4 }}>{label} (cm)</div>
                    <input type="number" value={val} onChange={e=>setter(e.target.value)}
                      style={{ width:"100%",background:"#121212",border:"1px solid #2C2C2C",color:"#fff",fontFamily:"monospace",fontSize:11,padding:"6px 8px",outline:"none",transition:"border-color .2s" }}
                      onFocus={e=>e.target.style.borderColor="#D32F2F"} onBlur={e=>e.target.style.borderColor="#2C2C2C"} />
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginTop:12 }}>
              <div style={{ ...LS, marginBottom:4 }}>Khoảng hở ngang (cm)</div>
              <input type="number" step="0.5" min="0" value={gap} onChange={e=>setGap(e.target.value)}
                style={{ width:"100%",background:"#121212",border:"1px solid #2C2C2C",color:"#fff",fontFamily:"monospace",fontSize:11,padding:"6px 8px",outline:"none",transition:"border-color .2s" }}
                onFocus={e=>e.target.style.borderColor="#D32F2F"} onBlur={e=>e.target.style.borderColor="#2C2C2C"} />
              <div style={{ fontFamily:"'Inter'", fontSize:10, color:"#555", marginTop:4, lineHeight:1.4 }}>
                Khe giữa các kiện theo chiều ngang. Chiều cao luôn khít.
              </div>
            </div>
          </div>

          {result && result.pallets.length>1 && (
            <div style={{ padding:"10px 14px", borderTop:"1px solid #2C2C2C" }}>
              <div style={{ ...LS, marginBottom:8 }}>Pallets — {result.pallets.length} tổng</div>
              <div style={{ display:"flex", flexDirection:"column", gap:4, maxHeight:130, overflowY:"auto" }}>
                {result.pallets.map((p,i)=>(
                  <button key={i} onClick={()=>{setActive(i);setHighlight(null);}}
                    style={{ padding:"7px 10px",background:activePallet===i&&tab==="dashboard"?"#D32F2F":"#252525",color:"#fff",border:"none",cursor:"pointer",fontFamily:"'Space Grotesk'",fontSize:10,textTransform:"uppercase",letterSpacing:"0.1em",fontWeight:700,textAlign:"left",transition:"background .15s" }}
                    onMouseEnter={e=>{if(!(activePallet===i&&tab==="dashboard"))e.currentTarget.style.background="#333";}}
                    onMouseLeave={e=>{if(!(activePallet===i&&tab==="dashboard"))e.currentTarget.style.background="#252525";}}>
                    Pallet {p.manualPalletNum ?? (i+1)} — {p.packed.length} kiện{p.overflow?.length>0?` (+${p.overflow.length} thừa)`:""}
                  </button>
                ))}
              </div>
            </div>
          )}

          {supabaseEnabled && flights.length > 0 && (
            <div style={{ padding:"10px 14px", borderTop:"1px solid #2C2C2C" }}>
              <div style={{ ...LS, marginBottom:8 }}>Flights — {flights.length} đã lưu</div>
              <div style={{ display:"flex", flexDirection:"column", gap:4, maxHeight:180, overflowY:"auto" }}>
                {flights.map(f => (
                  <div key={f.id} style={{ display:"flex", alignItems:"stretch", gap:2 }}>
                    <button onClick={()=>handleLoadFlight(f.id)} title={`${f.mode} — ${f.pallet_w}×${f.pallet_d}×${f.pallet_h}cm — gap ${f.gap}`}
                      style={{ flex:1,padding:"6px 9px",background:currentFlightId===f.id?"#D32F2F":"#252525",color:"#fff",border:"none",cursor:"pointer",fontFamily:"'Space Grotesk'",fontSize:10,letterSpacing:"0.05em",fontWeight:600,textAlign:"left",minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}
                      onMouseEnter={e=>{if(currentFlightId!==f.id)e.currentTarget.style.background="#333";}}
                      onMouseLeave={e=>{if(currentFlightId!==f.id)e.currentTarget.style.background="#252525";}}>
                      {f.name}
                    </button>
                    <button onClick={()=>handleDeleteFlight(f.id, f.name)} title="Xoá flight"
                      style={{ padding:"0 7px",background:"#252525",color:"#666",border:"none",cursor:"pointer",fontSize:11 }}
                      onMouseEnter={e=>{e.currentTarget.style.background="#4a1a1a";e.currentTarget.style.color="#ff6b6b";}}
                      onMouseLeave={e=>{e.currentTarget.style.background="#252525";e.currentTarget.style.color="#666";}}>×</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ padding:"14px 18px", borderTop:"1px solid #2C2C2C", marginTop:"auto", display:"flex", alignItems:"center", gap:10 }}>
            <div style={{ width:32,height:32,borderRadius:"50%",background:"#2C2C2C",display:"flex",alignItems:"center",justifyContent:"center" }}>
              <span className="material-symbols-outlined" style={{fontSize:16,color:"#D32F2F"}}>person</span>
            </div>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontFamily:"'Space Grotesk'",fontSize:10,fontWeight:700,color:"#fff",textTransform:"uppercase",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>
                {session?.user?.email?.split("@")[0] || "Ops Leader"}
              </div>
              <div style={LS}>{session?.user?.email?.split("@")[1] || "Station Alpha"}</div>
            </div>
            {supabaseEnabled && session && (
              <button onClick={handleLogout} title="Đăng xuất"
                style={{ background:"transparent",border:"1px solid #2C2C2C",color:"#666",cursor:"pointer",padding:"4px 6px",fontFamily:"'Space Grotesk'",fontSize:9 }}
                onMouseEnter={e=>{e.currentTarget.style.color="#ff6b6b";e.currentTarget.style.borderColor="#4a1a1a";}}
                onMouseLeave={e=>{e.currentTarget.style.color="#666";e.currentTarget.style.borderColor="#2C2C2C";}}>
                ⏻
              </button>
            )}
          </div>
        </aside>

        <main className="app-main" style={{ flex:1, display:"flex", flexDirection:"column", overflow:"hidden", minWidth:0 }}>
          <header className="app-header" style={{ height:52,background:"#121212",borderBottom:"1px solid #2C2C2C",display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 20px",flexShrink:0,gap:10 }}>
            <span style={{ fontFamily:"'Space Grotesk'",fontSize:14,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.14em",color:"#fff",whiteSpace:"nowrap" }}>
              {tab==="scan" ? "Warehouse Scan" : "3D Pallet Optimizer"}
            </span>
            {/* Mobile tab nav — chỉ hiện trên phone */}
            <div className="mobile-tabs" style={{ display:"none",gap:0,flex:1,marginLeft:8 }}>
              {[["dashboard","DASH"],["scan","SCAN"]].map(([id,label])=>(
                <button key={id} onClick={()=>setTab(id)}
                  style={{ flex:1,padding:"8px 0",background:tab===id?"#D32F2F":"#1E1E1E",color:tab===id?"#fff":"#888",border:"1px solid #2C2C2C",cursor:"pointer",fontFamily:"'Space Grotesk'",fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.1em" }}>
                  {label}
                </button>
              ))}
              {supabaseEnabled && session && (
                <button onClick={handleLogout} title="Đăng xuất"
                  style={{ padding:"8px 10px",background:"#1E1E1E",color:"#666",border:"1px solid #2C2C2C",cursor:"pointer",fontSize:13 }}>⏻</button>
              )}
            </div>
            <div className="desktop-only" style={{ display:"flex",alignItems:"center",gap:14 }}>
              <div style={{ display:"flex",alignItems:"center",background:"#1E1E1E",border:"1px solid #2C2C2C",padding:"5px 10px",gap:6 }}>
                <span className="material-symbols-outlined" style={{fontSize:13,color:"#555"}}>search</span>
                <input placeholder="SEARCH SHIPMENT ID..." style={{ background:"transparent",border:"none",outline:"none",color:"#fff",fontFamily:"'Space Grotesk'",fontSize:10,letterSpacing:"0.12em",textTransform:"uppercase",width:130 }} />
              </div>
              <span className="material-symbols-outlined" style={{fontSize:18,color:"#555",cursor:"pointer"}}>notifications</span>
              <span className="material-symbols-outlined" style={{fontSize:18,color:"#555",cursor:"pointer"}}>account_circle</span>
            </div>
          </header>

          {/* Mobile flight picker — hiện khi có flights, gọn 1 dòng */}
          {supabaseEnabled && flights.length > 0 && (
            <div className="mobile-tabs" style={{ display:"none",padding:"6px 10px",background:"#0c0c0c",borderBottom:"1px solid #2C2C2C",gap:6,overflowX:"auto",alignItems:"center" }}>
              <span style={{ ...LS, color:"#666", whiteSpace:"nowrap" }}>Flight:</span>
              {flights.map(f => (
                <button key={f.id} onClick={()=>handleLoadFlight(f.id)}
                  style={{ padding:"5px 10px",background:currentFlightId===f.id?"#D32F2F":"#1E1E1E",color:"#fff",border:"1px solid #2C2C2C",cursor:"pointer",fontFamily:"'Space Grotesk'",fontSize:10,fontWeight:600,whiteSpace:"nowrap",flexShrink:0 }}>
                  {f.name}
                </button>
              ))}
            </div>
          )}

          {tab==="scan" && (
            <ScanTab result={result} onJumpToPallet={handleJumpToPallet} />
          )}

          {tab==="dashboard" && (
            <div style={{ flex:1,overflow:"auto",padding:"14px 16px",display:"flex",flexDirection:"column",gap:14 }}>
              {parseWarnings && parseWarnings.length > 0 && (() => {
                const byReason = {};
                parseWarnings.forEach(w => { byReason[w.reason] = (byReason[w.reason] || 0) + 1; });
                return (
                  <div style={{ background:"#2a1f0a", border:"1px solid #6b4a1a" }}>
                    <button onClick={()=>setShowWarnings(!showWarnings)}
                      style={{ width:"100%",background:"transparent",border:"none",color:"#ffa726",padding:"10px 14px",cursor:"pointer",fontFamily:"'Space Grotesk'",fontWeight:700,fontSize:11,textTransform:"uppercase",letterSpacing:"0.1em",display:"flex",justifyContent:"space-between",alignItems:"center",textAlign:"left" }}>
                      <span>⚠ {parseWarnings.length} kiện bị bỏ qua khi parse — {Object.entries(byReason).map(([r,n])=>`${n}× ${r}`).join("  |  ")}</span>
                      <span style={{ fontSize:14 }}>{showWarnings?"▲":"▼"}</span>
                    </button>
                    {showWarnings && (
                      <div style={{ maxHeight:200, overflowY:"auto", borderTop:"1px solid #6b4a1a", padding:"8px 14px", background:"#1a1408" }}>
                        <table style={{ width:"100%", fontFamily:"monospace", fontSize:10, color:"#ccc" }}>
                          <thead>
                            <tr style={{ color:"#888" }}>
                              <th style={{ textAlign:"left", padding:"4px 8px" }}>Dòng</th>
                              <th style={{ textAlign:"left", padding:"4px 8px" }}>ID</th>
                              <th style={{ textAlign:"left", padding:"4px 8px" }}>Lý do</th>
                            </tr>
                          </thead>
                          <tbody>
                            {parseWarnings.map((w,i)=>(
                              <tr key={i} style={{ borderTop:"1px solid #2a1f0a" }}>
                                <td style={{ padding:"3px 8px", color:"#666" }}>{w.lineNo}</td>
                                <td style={{ padding:"3px 8px" }}>{w.id}</td>
                                <td style={{ padding:"3px 8px", color:"#ffa726" }}>{w.reason}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })()}
              <div className="stat-row" style={{ display:"flex",gap:10,flexWrap:"wrap" }}>
                <StatCard label="Total Items"       icon="inventory_2" value={result?`${result.totalPacked}/${result.totalItems}`:"—"} sub={result?`${result.pallets.length} pallet`:""} />
                <StatCard label="Chargeable Weight" icon="weight"      value={result?`${result.cw.toFixed(1)}kg`:"—"} sub={result?`Dim: ${result.dimWeight.toFixed(1)}kg`:""} />
                <StatCard label="Stack Density"     icon="percent"     value={result?`${result.utilization}%`:"—"} bar={result?+result.utilization:undefined} sub={result?"of bbox":""} />
                <StatCard label="Pallet Type"       icon="view_in_ar"  value={result?`${dim.w}×${dim.d}`:"—"} sub={result?`×${dim.h}cm`:""} />
              </div>

              <div className="dashboard-grid" style={{ display:"grid",gridTemplateColumns:"minmax(280px,390px) 1fr",gap:14,flex:1,minHeight:0 }}>
                <div style={{ display:"flex",flexDirection:"column",gap:12,minHeight:0 }}>
                  <div style={{ background:"#1E1E1E",border:"1px solid #2C2C2C" }}>
                    <div style={{ background:"#2C2C2C",padding:"7px 12px",display:"flex",justifyContent:"space-between",alignItems:"center",gap:8 }}>
                      <span style={{ ...LS,color:"#fff" }}>Input Data</span>
                      <div style={{ display:"flex" }}>
                        {[["auto","Auto","App tự xếp"],["manual","Manual","Sếp chỉ định pallet"]].map(([m,label,tip])=>(
                          <button key={m} onClick={()=>switchMode(m)} title={tip}
                            style={{ padding:"4px 10px",background:mode===m?"#D32F2F":"transparent",color:mode===m?"#fff":"#888",border:"1px solid "+(mode===m?"#D32F2F":"#3a3a3a"),cursor:"pointer",fontFamily:"'Space Grotesk'",fontSize:9,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.1em",transition:"all .15s" }}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div style={{ padding:12 }}>
                      <div style={{ ...LS,marginBottom:6 }}>
                        {mode==="manual"
                          ? "Format: ID, W, H, D, Weight, Pallet# — sếp chỉ định pallet"
                          : "Format: ID, Width, Height, Depth, Weight (cm / kg)"}
                      </div>
                      <textarea value={raw} onChange={e=>updateRaw(e.target.value)}
                        placeholder={mode==="manual"
                          ? "ID, W, H, D, Weight, Pallet#\nBOX-001, 40, 30, 20, 15, 1"
                          : "ID, Width, Height, Depth, Weight\nBOX-001, 40, 30, 20, 15"}
                        style={{ width:"100%",height:140,background:"#121212",border:"1px solid #2C2C2C",color:"#fff",fontFamily:"monospace",fontSize:11,padding:10,outline:"none",resize:"vertical",lineHeight:1.6,transition:"border-color .2s" }}
                        onFocus={e=>e.target.style.borderColor="#D32F2F"} onBlur={e=>e.target.style.borderColor="#2C2C2C"} />
                      <div className="opt-buttons" style={{ display:"flex",gap:8,marginTop:8 }}>
                        <button onClick={handleOptimize} disabled={running}
                          style={{ flex:1,background:running?"#7a1a1a":"#D32F2F",color:"#fff",border:"none",padding:"9px 0",cursor:running?"wait":"pointer",fontFamily:"'Space Grotesk'",fontWeight:700,fontSize:11,textTransform:"uppercase",letterSpacing:"0.14em",transition:"background .2s" }}
                          onMouseEnter={e=>{if(!running)e.currentTarget.style.background="#b52828";}} onMouseLeave={e=>{if(!running)e.currentTarget.style.background="#D32F2F";}}>
                          {running?"⟳ Computing...":`▶ Run ${mode==="manual"?"Manual":"Auto"} Optimization`}
                        </button>
                        {supabaseEnabled && result && (
                          <button title="Lưu vào flight" className="opt-secondary"
                            onClick={()=>{
                              if (!saveFlightName && currentFlightId) {
                                const f = flights.find(x=>x.id===currentFlightId);
                                if (f) setSaveFlightName(f.name);
                              }
                              setShowSaveModal(true);
                            }}
                            style={{ background:"#42a5f5",border:"none",color:"#fff",padding:"9px 14px",cursor:"pointer",fontFamily:"'Space Grotesk'",fontWeight:700,fontSize:11,textTransform:"uppercase",letterSpacing:"0.1em" }}>
                            💾 Lưu
                          </button>
                        )}
                        <button className="opt-secondary" onClick={()=>{
                          updateRaw("");
                          if(mode==="manual"){ setResultManual(null); setTimingManual(null); }
                          else               { setResultAuto(null);   setTimingAuto(null);   }
                          setHighlight(null);
                        }}
                          style={{ background:"transparent",border:"1px solid #2C2C2C",color:"#666",padding:"9px 14px",cursor:"pointer",fontFamily:"'Space Grotesk'",fontWeight:700,fontSize:11,textTransform:"uppercase",letterSpacing:"0.1em",transition:"all .2s" }}
                          onMouseEnter={e=>{e.currentTarget.style.background="#1E1E1E";e.currentTarget.style.color="#fff";}} onMouseLeave={e=>{e.currentTarget.style.background="transparent";e.currentTarget.style.color="#666";}}>
                          Clear
                        </button>
                      </div>
                    </div>
                  </div>

                  <div style={{ background:"#1E1E1E",border:"1px solid #2C2C2C",flex:1,display:"flex",flexDirection:"column",overflow:"hidden" }}>
                    <div style={{ background:"#2C2C2C",padding:"7px 12px",display:"flex",justifyContent:"space-between",alignItems:"center",flexShrink:0,gap:8 }}>
                      <span style={{ ...LS,color:"#fff",display:"inline-flex",alignItems:"center",gap:8 }}>
                        <span style={{ padding:"1px 6px",background:mode==="manual"?"#D32F2F":"#42a5f5",color:"#fff",fontSize:8,fontWeight:700,letterSpacing:"0.12em" }}>
                          {mode==="manual"?"MANUAL":"AUTO"}
                        </span>
                        {cur ? (mode==="manual" && cur.manualPalletNum
                            ? `Pallet ${cur.manualPalletNum} (sếp) — ${cur.packed.length} kiện`
                            : `Pallet ${activePallet+1} — ${cur.packed.length} kiện`)
                          : "Packing Result"}
                        {cur?.overflow?.length>0 && <span style={{ color:"#ff6b6b" }}>+{cur.overflow.length} thừa</span>}
                        {cur?.boundingBox?.w>0 && <span style={{ color:"#10B981" }}>
                          {cur.boundingBox.w.toFixed(0)}×{cur.boundingBox.d.toFixed(0)}×{cur.boundingBox.h.toFixed(0)}cm
                        </span>}
                        {cur && cur.packed.length > 0 && (
                          <span style={{ color:"#42a5f5" }} title={`Pallet kg = ${cur.weight.toFixed(1)}, dim = bbox/6000 = ${cur.dimWeight.toFixed(1)}, CHW = max(kg, dim)`}>
                            {cur.weight.toFixed(1)}kg / CHW {cur.chw.toFixed(1)}kg
                          </span>
                        )}
                      </span>
                      {highlightId&&<span style={{ ...LS,color:"#D32F2F" }}>Highlight: {highlightId}</span>}
                    </div>
                    <div style={{ overflowY:"auto",overflowX:"auto",flex:1 }}>
                      <table style={{ width:"100%",minWidth:480,borderCollapse:"collapse",whiteSpace:"nowrap" }}>
                        <thead>
                          <tr style={{ background:"#121212",borderBottom:"1px solid #2C2C2C",position:"sticky",top:0,zIndex:1 }}>
                            {["#","Item ID","W×H×D","X,Y,Z","Wt","CHW"].map((h,i)=>(<th key={i} style={{ padding:"7px 10px",...LS,textAlign:i>=3?"right":"left" }}>{h}</th>))}
                          </tr>
                        </thead>
                        <tbody>
                          {cur ? cur.packed.map((item,idx)=>(
                            <tr key={item.id}
                              onClick={()=>setHighlight(highlightId===item.id?null:item.id)}
                              style={{ borderBottom:"1px solid #191919",transition:"background .1s",background:highlightId===item.id?"#2a1010":"transparent",cursor:"pointer" }}
                              onMouseEnter={e=>{if(highlightId!==item.id)e.currentTarget.style.background="#2a2a2a";}}
                              onMouseLeave={e=>{e.currentTarget.style.background=highlightId===item.id?"#2a1010":"transparent";}}>
                              <td style={{ padding:"7px 10px",fontSize:10,color:"#D32F2F",fontFamily:"'Space Grotesk'",fontWeight:700 }}>{idx+1}</td>
                              <td style={{ padding:"7px 10px",fontSize:11,color:highlightId===item.id?"#fff":"#ccc",fontWeight:highlightId===item.id?700:600,fontFamily:"'Space Grotesk'" }}>
                                <span style={{ display:"inline-flex",alignItems:"center",gap:5 }}>
                                  <span style={{ width:7,height:7,background:BOX_COLORS[idx%BOX_COLORS.length],flexShrink:0 }} />
                                  {item.id}
                                  {highlightId===item.id&&<span className="material-symbols-outlined" style={{fontSize:12,color:"#D32F2F"}}>my_location</span>}
                                </span>
                              </td>
                              <td style={{ padding:"7px 10px",fontSize:10,color:"#666",fontFamily:"'Inter'" }}>{item.w}×{item.h}×{item.d}</td>
                              <td style={{ padding:"7px 10px",fontSize:10,color:"#888",fontFamily:"'Inter'",textAlign:"right" }}>{item.x.toFixed(0)},{item.y.toFixed(0)},{item.z.toFixed(0)}</td>
                              <td style={{ padding:"7px 10px",fontSize:10,color:"#666",fontFamily:"'Inter'",textAlign:"right" }}>{item.weight}kg</td>
                              <td style={{ padding:"7px 10px",fontSize:10,color:"#42a5f5",fontFamily:"'Inter'",textAlign:"right",fontWeight:600 }}>
                                {Math.max(item.weight, (item.w*item.h*item.d)/VOL_DIVISOR).toFixed(2)}kg
                              </td>
                            </tr>
                          )) : (
                            <tr><td colSpan={6} style={{ padding:"30px",textAlign:"center",...LS }}>Chạy optimization để xem kết quả</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

                <div className="viewer-3d" style={{ background:"#0c0c0c",border:"1px solid #2C2C2C",position:"relative",minHeight:460,overflow:"hidden" }}>
                  {result&&cur&&cur.packed.length>0 ? (
                    <ErrorBoundary key={activePallet}>
                      <PalletViewer3D key={`${activePallet}-${highlightId}`} packedItems={cur.packed} palletIndex={activePallet} totalPallets={result.pallets.length} highlightId={highlightId} palletDim={dim} boundingBox={cur.boundingBox} />
                    </ErrorBoundary>
                  ) : (
                    <div style={{ width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",position:"relative" }}>
                      <div style={{ position:"absolute",inset:0,opacity:0.06,backgroundImage:"radial-gradient(#D32F2F 1px, transparent 1px)",backgroundSize:"22px 22px" }} />
                      <div style={{ width:160,height:160,border:"2px dashed #2C2C2C",display:"flex",alignItems:"center",justifyContent:"center",position:"relative" }}>
                        <span className="material-symbols-outlined" style={{fontSize:50,color:"#D32F2F",opacity:.3}}>deployed_code</span>
                        {[{top:0,left:0},{top:0,right:0},{bottom:0,left:0},{bottom:0,right:0}].map((pos,i)=>(
                          <div key={i} style={{ position:"absolute",...pos,width:12,height:12,borderTop:i<2?"2px solid #D32F2F":undefined,borderBottom:i>=2?"2px solid #D32F2F":undefined,borderLeft:i%2===0?"2px solid #D32F2F":undefined,borderRight:i%2===1?"2px solid #D32F2F":undefined }} />
                        ))}
                      </div>
                      <p style={{ marginTop:18,fontFamily:"'Space Grotesk'",fontSize:10,color:"#444",textTransform:"uppercase",letterSpacing:"0.18em",fontWeight:700 }}>Waiting for simulation data...</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          <footer className="app-footer" style={{ height:26,background:"#121212",borderTop:"1px solid #2C2C2C",display:"flex",alignItems:"center",justifyContent:"space-between",padding:"0 16px",flexShrink:0 }}>
            <div style={{ display:"flex",alignItems:"center",gap:8 }}>
              <span style={LS}>System Status: Nominal</span>
              <div style={{ width:5,height:5,borderRadius:"50%",background:"#10B981",boxShadow:"0 0 5px rgba(16,185,129,.8)" }} />
            </div>
            <div style={{ display:"flex",gap:14,alignItems:"center" }}>
              {result&&<span style={LS}>
                [{mode.toUpperCase()}] {result.totalPacked}/{result.totalItems} packed
                {result.totalOverflow>0 && <span style={{ color:"#ff6b6b" }}> — {result.totalOverflow} thừa</span>}
                {" — "}{result.pallets.length} pallets — {dim.w}×{dim.d}×{dim.h}cm — gap {result.gap?.toFixed(1) ?? "0"}cm
              </span>}
              {timing&&<span style={LS}>Optimized in {timing}s</span>}
            </div>
          </footer>
        </main>
      </div>

      {showSaveModal && (
        <div onClick={()=>!saving&&setShowSaveModal(false)}
          style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center" }}>
          <div onClick={e=>e.stopPropagation()}
            style={{ width:380,background:"#1E1E1E",border:"1px solid #2C2C2C",padding:"22px 24px",fontFamily:"'Inter'" }}>
            <div style={{ fontFamily:"'Space Grotesk'",fontSize:13,fontWeight:700,color:"#fff",textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:14 }}>
              {currentFlightId ? "Cập nhật flight" : "Lưu flight mới"}
            </div>
            <div style={{ ...LS, marginBottom:6 }}>Tên flight</div>
            <input value={saveFlightName} onChange={e=>setSaveFlightName(e.target.value)} autoFocus
              placeholder="VD: BOM-20260601 / Container 1234"
              onKeyDown={e=>{ if(e.key==="Enter")handleSaveFlight(); }}
              style={{ width:"100%",background:"#121212",border:"1px solid #2C2C2C",color:"#fff",fontFamily:"monospace",fontSize:12,padding:"9px 12px",outline:"none",marginBottom:14 }}
              onFocus={e=>e.target.style.borderColor="#D32F2F"} onBlur={e=>e.target.style.borderColor="#2C2C2C"} />
            <div style={{ ...LS, color:"#666", fontSize:9, marginBottom:14, lineHeight:1.5 }}>
              Lưu: {mode==="manual"?"Manual":"Auto"} mode • {dim.w}×{dim.d}×{dim.h}cm • gap {gap}cm • {parseExcelPaste(raw, mode==="manual").items.length} kiện input
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={handleSaveFlight} disabled={saving||!saveFlightName.trim()}
                style={{ flex:1,background:saving?"#7a1a1a":"#D32F2F",color:"#fff",border:"none",padding:"9px 0",cursor:saving?"wait":"pointer",fontFamily:"'Space Grotesk'",fontWeight:700,fontSize:11,textTransform:"uppercase",letterSpacing:"0.14em" }}>
                {saving?"⟳ Đang lưu...":(currentFlightId?"Cập nhật":"Lưu mới")}
              </button>
              {currentFlightId && (
                <button onClick={()=>{ setCurrentFlightId(null); setSaveFlightName(""); }} disabled={saving}
                  title="Lưu thành flight mới"
                  style={{ background:"transparent",border:"1px solid #2C2C2C",color:"#888",padding:"9px 12px",cursor:"pointer",fontFamily:"'Space Grotesk'",fontSize:10 }}>
                  Tách mới
                </button>
              )}
              <button onClick={()=>setShowSaveModal(false)} disabled={saving}
                style={{ background:"transparent",border:"1px solid #2C2C2C",color:"#666",padding:"9px 14px",cursor:"pointer",fontFamily:"'Space Grotesk'",fontWeight:700,fontSize:11,textTransform:"uppercase" }}>
                Huỷ
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
