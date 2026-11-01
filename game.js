(() => {
  'use strict';

  // =========================================================
  //  ユーティリティ
  // =========================================================
  const PI = Math.PI, DEG = PI / 180;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const smooth = t => t * t * (3 - 2 * t);
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const mix = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const approach = (cur, target, rate, dt) => mix(cur, target, 1 - Math.exp(-rate * dt));
  const hdist = p => Math.hypot(p[0], p[2]);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * PI * Math.random());
  const $ = id => document.getElementById(id);

  // =========================================================
  //  キャンバス
  // =========================================================
  const canvas = $('game');
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0;
  const COARSE = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  function resize() {
    // 高精細な画面でも描画負荷を抑えるため 2 倍までにする（スマホを 1.5 倍に落とすとぼやけて見える）
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 200));
  resize();

  // =========================================================
  //  球場データ  (x:一塁側が+, y:上, z:センター方向が+, 本塁=原点)
  // =========================================================
  const BASES = [[0, 0, 0], [19.4, 0, 19.4], [0, 0, 38.8], [-19.4, 0, 19.4], [0, 0, 0]];
  const BALL_R = 0.037;
  const FAIR = PI / 4;
  const ZONE = { x0: -0.215, x1: 0.215, y0: 0.5, y1: 1.06 };
  const BATTER_X = -0.95;   // 打者の立ち位置（三塁側）
  const G = 9.8, DRAG = 0.0042;
  const STAND_SLOPE = 0.6, STAND_DEPTH = 42;
  const POS_NAME = { P: 'ピッチャー', C: 'キャッチャー', '1B': 'ファースト', '2B': 'セカンド', SS: 'ショート', '3B': 'サード', LF: 'レフト', CF: 'センター', RF: 'ライト' };

  function wallR(th) {
    const a = Math.abs(th);
    if (a <= FAIR) return 98 + 24 * Math.cos(2 * th);
    if (a <= PI / 2) return lerp(98, 26, smooth((a - FAIR) / (PI / 4)));
    return lerp(26, 18, (a - PI / 2) / (PI / 2));
  }
  const wallH = th => (Math.abs(th) <= FAIR ? 4 : 2.4);
  const polar = (th, r, y) => [r * Math.sin(th), y, r * Math.cos(th)];

  // =========================================================
  //  難易度・球種
  // =========================================================
  const DIFFS = {
    easy:   { vmin: 95,  vmax: 118, brk: 0.55, rx: 0.23, ry: 0.14,  win: 0.32,  field: 0.85, types: ['ストレート', 'カーブ', 'チェンジアップ'] },
    normal: { vmin: 120, vmax: 145, brk: 1.0,  rx: 0.19, ry: 0.115, win: 0.26,  field: 1.0,  types: ['ストレート', 'カーブ', 'スライダー', 'フォーク', 'スプリット', 'チェンジアップ', 'シュート'] },
    hard:   { vmin: 135, vmax: 158, brk: 1.3,  rx: 0.16, ry: 0.095, win: 0.205, field: 1.06, types: ['ストレート', 'カーブ', 'スライダー', 'フォーク', 'スプリット', 'チェンジアップ', 'シュート', 'カットボール'] },
  };
  // drop: 手元で落ちる量（途中まではストレートと同じ軌道を通り、本塁の直前で s^DROP_BEND で落ちる。正なら浮き上がる）
  const DROP_BEND = 5;
  const PITCHES = {
    'ストレート':   { sp: 1.0,  bx: 0.0,   by: -0.12, w: 3 },
    'カーブ':       { sp: 0.76, bx: 0.32,  by: -0.62, w: 1.2 },
    'スライダー':   { sp: 0.86, bx: 0.38,  by: -0.22, w: 1.5 },
    'フォーク':     { sp: 0.88, bx: 0.0,   by: -0.12, drop: -0.48, w: 1 },
    'スプリット':   { sp: 0.94, bx: 0.0,   by: -0.12, drop: -0.26, w: 1 },
    'チェンジアップ': { sp: 0.82, bx: -0.15, by: -0.35, w: 1 },
    'シュート':     { sp: 0.93, bx: -0.28, by: -0.15, w: 1 },
    'カットボール': { sp: 0.95, bx: 0.14,  by: -0.12, w: 1 },
    // 以下はピッチングモード専用 (cost: スタミナ消費, ctl: ばらつき倍率, rd: 打者の見極め補正)
    '剛速球':       { sp: 1.137,bx: 0.0,   by: -0.06, cost: 2.8, ctl: 1.35, heat: true },
    'ライジング':   { sp: 0.99, bx: 0.0,   by: -0.12, drop: 0.3, cost: 2.0 },
    'ナックルカーブ': { sp: 0.8,  bx: 0.18,  by: -0.78 },
    'スローカーブ': { sp: 0.62, bx: 0.26,  by: -0.8 },
    '縦スライダー': { sp: 0.87, bx: 0.12,  by: -0.5 },
    'スイーパー':   { sp: 0.84, bx: 0.55,  by: -0.12 },
    'シンカー':     { sp: 0.9,  bx: -0.26, by: -0.45 },
    'ナックル':     { sp: 0.68, bx: 0.0,   by: 0.0,   cost: 1.2, rd: -0.5, knuckle: true },
  };
  let D = DIFFS.normal;

  // ピッチングモード: 相手打者の強さ (rx/ry: バットの当たり範囲, read: 変化の見極め, adapt: 球速への対応)
  const PDIFFS = {
    easy:   { rx: 0.10, ry: 0.075, win: 0.07, read: 0.35, adapt: 0.55, field: 1.06 },
    normal: { rx: 0.12, ry: 0.09,  win: 0.08, read: 0.5,  adapt: 0.68, field: 1.0 },
    hard:   { rx: 0.14, ry: 0.105, win: 0.09, read: 0.62, adapt: 0.78, field: 0.95 },
  };
  // 相手打線 (con: ミート, pow: パワー, eye: 選球眼)
  // spd: 走力（塁間を走る速さの倍率）
  const LINEUP = [
    { con: 1.08, pow: 0.85, eye: 1.2,  spd: 1.18 }, { con: 1.04, pow: 0.88, eye: 1.1,  spd: 1.1 },  { con: 1.1,  pow: 1.05, eye: 1.15, spd: 1.02 },
    { con: 0.98, pow: 1.22, eye: 1.0,  spd: 0.86 }, { con: 0.97, pow: 1.12, eye: 0.95, spd: 0.92 }, { con: 1.0,  pow: 1.0,  eye: 1.0,  spd: 1.0 },
    { con: 0.94, pow: 0.95, eye: 0.9,  spd: 1.08 }, { con: 0.9,  pow: 0.88, eye: 0.85, spd: 0.95 }, { con: 0.84, pow: 0.8,  eye: 0.8,  spd: 0.9 },
  ];
  const P_TYPES = ['ストレート', '剛速球', 'ライジング','カーブ', 'スローカーブ', 'ナックルカーブ', 'スライダー', '縦スライダー', 'スイーパー', 'フォーク', 'スプリット', 'チェンジアップ', 'シュート', 'シンカー', 'カットボール', 'ナックル'];
  const P_SHORT = { 'ナックルカーブ': 'ナックルC', 'スローカーブ': 'スローC', '縦スライダー': '縦スラ', 'チェンジアップ': 'チェンジ', 'カットボール': 'カット', 'スプリット': 'スプリ' };
  // 12番目は JIS キーボードの「^」（US 配列では「=」）、13番目は「¥」（US 配列では「\」）、14番目は「@」（US 配列では「[」）、15番目は「[」（US 配列では「]」）、16番目は「;」
  const P_DESC = {
    '剛速球': '最速170km/h。スタミナ消費大で荒れやすい',
    'ライジング': 'ストレートの軌道から手元でホップする',
    'カーブ': '大きく曲がりながら落ちる遅い球',
    'スローカーブ': '山なりの超スロー。球速差でタイミングを外す',
    'ナックルカーブ': '縦に鋭く落ちるカーブ',
    'スライダー': '横に鋭く曲がる',
    '縦スライダー': '斜め下へ落ちるスライダー',
    'スイーパー': '横へ大きく滑るように曲がる',
    'フォーク': 'ストレートの軌道から手元でストンと落ちる',
    'スプリット': '速いまま、ストレートの軌道から小さく鋭く落ちる',
    'チェンジアップ': '腕の振りはそのまま、遅く沈む',
    'シュート': '右打者の内角へ食い込む',
    'シンカー': '内角へ曲がりながら沈む',
    'カットボール': '速くて小さく曲がる',
    'ナックル': '揺れて行き先が読めない魔球',
  };
  // 持ち球: ストレート + 試合前に選ぶ5球種
  const ARSENAL_SIZE = 5;
  const ARSENAL_KEY = 'homerun-stadium-arsenal';
  let arsenal = ['カーブ', 'スライダー', 'フォーク', 'チェンジアップ', 'シュート'];
  try {
    const saved = JSON.parse(localStorage.getItem(ARSENAL_KEY));
    if (Array.isArray(saved) && saved.length === ARSENAL_SIZE && saved.every(n => P_DESC[n])) arsenal = saved;
  } catch (e) { /* 保存領域が使えなくても既定の持ち球で遊べる */ }
  let myPitches = [];
  const P_CODES = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal', 'IntlYen', 'BracketLeft', 'BracketRight', 'Semicolon'];
  const P_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '^', '¥', '@', '[', ';'];
  // P_VMAX: ストレートの最高球速, P_BRK: 変化量の倍率, P_BEND: 曲がり始めの遅さ（大きいほど手元で鋭く曲がる）
  const P_VMAX = 148, P_BRK = 2.1, P_BEND = 3, INNINGS = 3;
  // 落ちる球の倍率は P_BRK より小さくする（落ち幅が大きすぎると、途中のストレート軌道が上向きになり浮いてから落ちて見える）
  const P_DROP = 1.3;
  const dropK = d => (d < 0 ? P_DROP : P_BRK);
  let mode = 'bat', selDiff = 'normal';
  // 投球練習: ピッチングモードの一種（打者なし・全球種・スタミナ無限）
  let practice = false;
  const prac = { strikes: 0, perfect: 0, best: 0, miss: 0 };   // miss: 狙いからのズレの合計 (m)
  // 試合: CPUと対戦（自分が先攻。表はバッティング、裏はピッチング）
  let vs = false;
  // line: イニングごとの得点, saved: 攻守それぞれの成績, skip: 最終回裏なし, walkoff: サヨナラ
  const vsm = { innings: 3, line: { me: [], cpu: [] }, saved: {}, skip: false, walkoff: false };
  const SIDE_KEYS = ['runs', 'hits', 'hrs', 'best', 'ks', 'bb', 'pitches', 'batter'];
  const sum = a => a.reduce((s, v) => s + (v || 0), 0);
  const vsTotals = () => ({ me: sum(vsm.line.me), cpu: sum(vsm.line.cpu) });

  // =========================================================
  //  カメラ & 投影
  // =========================================================
  const NEAR = 0.05;
  const BAT_CAM = { pos: [0, 1.45, -3.1], tgt: [0, 0.38, 6.9], fs: 1.35 };
  const PITCH_CAM = { pos: [0, 3.2, 27], tgt: [0, 0.85, 0], fs: 3.6 };
  // 投球前後の定位置カメラ（ピッチングはバックスクリーン側から望遠）
  function homeCam() {
    if (mode !== 'pitch') return BAT_CAM;
    return { pos: PITCH_CAM.pos, tgt: PITCH_CAM.tgt, fs: PITCH_CAM.fs * (W < H ? 1.3 : H < 500 ? 1.6 : 1) };   // 横向きスマホは高さが低いので寄る
  }
  // 縦長画面では横幅基準で少しズームしてゾーンを大きく見せる
  const baseF = () => Math.min(H, W * (W < H ? 1.3 : 0.9));
  const cam = { pos: [0, 30, -20], tgt: [0, 0, 45], fs: 0.85, f: 1, cx: 0, cy: 0, fwd: [0, 0, 1], right: [1, 0, 0], up: [0, 1, 0] };

  function updateBasis() {
    cam.fwd = norm(sub(cam.tgt, cam.pos));
    cam.right = norm(cross([0, 1, 0], cam.fwd));
    cam.up = cross(cam.fwd, cam.right);
    cam.f = baseF() * cam.fs;
    cam.cx = W / 2; cam.cy = H / 2;
  }
  function toCam(p) {
    const d0 = p[0] - cam.pos[0], d1 = p[1] - cam.pos[1], d2 = p[2] - cam.pos[2];
    const r = cam.right, u = cam.up, f = cam.fwd;
    return [d0 * r[0] + d1 * r[1] + d2 * r[2], d0 * u[0] + d1 * u[1] + d2 * u[2], d0 * f[0] + d1 * f[1] + d2 * f[2]];
  }
  const proj = c => [cam.cx + cam.f * c[0] / c[2], cam.cy - cam.f * c[1] / c[2]];

  function clipNear(cs) {
    const out = [];
    for (let i = 0; i < cs.length; i++) {
      const a = cs[i], b = cs[(i + 1) % cs.length];
      const ain = a[2] > NEAR, bin = b[2] > NEAR;
      if (ain) out.push(a);
      if (ain !== bin) {
        const t = (NEAR - a[2]) / (b[2] - a[2]);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]);
      }
    }
    return out;
  }
  function polyPath(pts) {
    const cs = clipNear(pts.map(toCam));
    if (cs.length < 3) return false;
    ctx.beginPath();
    for (let i = 0; i < cs.length; i++) {
      const s = proj(cs[i]);
      if (i) ctx.lineTo(s[0], s[1]); else ctx.moveTo(s[0], s[1]);
    }
    ctx.closePath();
    return true;
  }
  function fillPoly(pts, color) {
    if (polyPath(pts)) { ctx.fillStyle = color; ctx.fill(); }
  }
  // 太さをメートルで指定する3D線分
  function limb(a, b, w, col) {
    let ca = toCam(a), cb = toCam(b);
    if (ca[2] < NEAR && cb[2] < NEAR) return;
    if (ca[2] < NEAR) ca = mix(ca, cb, (NEAR - ca[2]) / (cb[2] - ca[2]));
    else if (cb[2] < NEAR) cb = mix(cb, ca, (NEAR - cb[2]) / (ca[2] - cb[2]));
    const sa = proj(ca), sb = proj(cb);
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(1, cam.f * w * 2 / (ca[2] + cb[2]));
    ctx.beginPath(); ctx.moveTo(sa[0], sa[1]); ctx.lineTo(sb[0], sb[1]); ctx.stroke();
  }
  function groundEllipse(x, z, r, style) {
    const c = toCam([x, 0.02, z]);
    if (c[2] < NEAR) return;
    const s = proj(c);
    const fh = norm([cam.fwd[0], 0, cam.fwd[2]]);
    const rh = [fh[2], 0, -fh[0]];
    const cx = toCam([x + rh[0] * r, 0.02, z + rh[2] * r]);
    const cz = toCam([x + fh[0] * r, 0.02, z + fh[2] * r]);
    if (cx[2] < NEAR || cz[2] < NEAR) return;
    const px = proj(cx), pz = proj(cz);
    const rx = Math.max(1, Math.hypot(px[0] - s[0], px[1] - s[1]));
    const ry = Math.max(0.5, Math.abs(pz[1] - s[1]));
    ctx.fillStyle = style;
    ctx.beginPath(); ctx.ellipse(s[0], s[1], rx, ry, 0, 0, PI * 2); ctx.fill();
  }

  // =========================================================
  //  ジオメトリ構築
  // =========================================================
  const GEO = { far: [] };
  function circle(cx, cz, r, n = 36) {
    const pts = [];
    for (let i = 0; i < n; i++) { const a = (i / n) * PI * 2; pts.push([cx + Math.cos(a) * r, 0, cz + Math.sin(a) * r]); }
    return pts;
  }
  function lineQuad(a, b, w) {
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
    const px = -dz / l * w / 2, pz = dx / l * w / 2;
    return [[a[0] + px, 0, a[1] + pz], [b[0] + px, 0, b[1] + pz], [b[0] - px, 0, b[1] - pz], [a[0] - px, 0, a[1] - pz]];
  }
  function rectLines(x0, z0, x1, z1, w) {
    return [lineQuad([x0, z0], [x1, z0], w), lineQuad([x1, z0], [x1, z1], w), lineQuad([x1, z1], [x0, z1], w), lineQuad([x0, z1], [x0, z0], w)];
  }
  // k: 明るさ, m: グレーに寄せる割合
  function shade(hex, k, m = 0) {
    const n = parseInt(hex.slice(1), 16);
    const gray = 96;
    const ch = v => Math.round(lerp(v, gray, m) * k);
    const r = ch((n >> 16) & 255), g = ch((n >> 8) & 255), b = ch(n & 255);
    return `rgb(${clamp(r, 0, 255)},${clamp(g, 0, 255)},${clamp(b, 0, 255)})`;
  }

  function buildField() {
    const STEP = 2 * DEG;
    const N = Math.round(2 * PI / STEP);

    GEO.outline = [];
    const outer = [], inner = [];
    for (let i = 0; i <= N; i++) {
      const th = -PI + i * STEP, R = wallR(th);
      if (i < N) GEO.outline.push(polar(th, R, 0));
      outer.push(polar(th, R, 0));
      inner.push(polar(th, Math.max(R - 4.5, 6), 0));
    }
    GEO.track = outer.concat(inner.reverse());

    // 芝の刈り込み模様
    GEO.stripes = [];
    for (let k = 0; k < 10; k++) {
      const r1 = 30 + k * 10, r2 = r1 + 5, o = [], n = [];
      for (let th = -FAIR; th <= FAIR + 1e-6; th += STEP) {
        const lim = wallR(th) - 4.5;
        o.push(polar(th, Math.min(r2, lim), 0));
        n.push(polar(th, Math.min(r1, lim), 0));
      }
      GEO.stripes.push(o.concat(n.reverse()));
    }

    // 内野の土
    const dirt = [[2.6, 0, -1.2]];
    for (let a = 76; a >= -76; a -= 2) { const t = a * DEG; dirt.push([29 * Math.sin(t), 0, 18.44 + 29 * Math.cos(t)]); }
    dirt.push([-2.6, 0, -1.2]);
    GEO.dirt = dirt;
    GEO.infieldGrass = [[0, 0, 1.8], [17.6, 0, 19.4], [0, 0, 37.0], [-17.6, 0, 19.4]];
    GEO.homeDirt = circle(0, 0, 4.0, 40);
    GEO.mound = circle(0, 18.44, 2.74, 32);
    GEO.rubber = [[-0.3, 0, 18.3], [0.3, 0, 18.3], [0.3, 0, 18.46], [-0.3, 0, 18.46]];
    GEO.plate = [[-0.215, 0, 0.215], [0.215, 0, 0.215], [0.215, 0, 0], [0, 0, -0.215], [-0.215, 0, 0]];
    GEO.bases = [1, 2, 3].map(i => { const c = BASES[i], h = 0.27; return [[c[0], 0, c[2] + h], [c[0] + h, 0, c[2]], [c[0], 0, c[2] - h], [c[0] - h, 0, c[2]]]; });

    // ライン
    const L = [];
    const fl = wallR(FAIR);
    L.push(lineQuad([0, 0], [fl * Math.sin(FAIR), fl * Math.cos(FAIR)], 0.12));
    L.push(lineQuad([0, 0], [-fl * Math.sin(FAIR), fl * Math.cos(FAIR)], 0.12));
    L.push(...rectLines(-1.55, -0.9, -0.35, 0.9, 0.07));
    L.push(...rectLines(0.35, -0.9, 1.55, 0.9, 0.07));
    GEO.lines = L;

    // 外野フェンス・スタンド
    const crowd = ['#b85450', '#d8d4cc', '#46619c', '#c9a24a', '#6f5687', '#3d7d6c', '#9099a8', '#c87444', '#5a6273', '#d9b99a', '#a03838', '#2f4a7a'];
    let seed = 12345;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const S = STAND_SLOPE;
    for (let i = 0; i < N; i++) {
      const t1 = -PI + i * STEP, t2 = t1 + STEP, tm = t1 + STEP / 2;
      const R1 = wallR(t1), R2 = wallR(t2), h = wallH(tm), fair = Math.abs(tm) <= FAIR;
      GEO.far.push({ pts: [polar(t1, R1, 0), polar(t2, R2, 0), polar(t2, R2, h), polar(t1, R1, h)], color: fair ? '#1d5a3a' : '#2a6447', top: fair ? '#f2c230' : null });
      const aisle = i % 12 === 0;
      for (let k = 0; k < 6; k++) {
        const ra = k * 7, rb = ra + 7;
        const base = aisle ? '#8d8f96' : crowd[Math.floor(rnd() * crowd.length)];
        const col = shade(base, 0.85 + 0.2 * rnd() - k * 0.03, 0.4);
        GEO.far.push({ pts: [polar(t1, R1 + ra, h + ra * S), polar(t2, R2 + ra, h + ra * S), polar(t2, R2 + rb, h + rb * S), polar(t1, R1 + rb, h + rb * S)], color: col, seam: true });
      }
      const rb = STAND_DEPTH, yb = h + rb * S;
      GEO.far.push({ pts: [polar(t1, R1 + rb, yb), polar(t2, R2 + rb, yb), polar(t2, R2 + rb, yb + 5), polar(t1, R1 + rb, yb + 5)], color: '#39404d', seam: true });
    }
    // バックスクリーン
    const rS = wallR(0) + STAND_DEPTH + 1.5;
    GEO.far.push({ pts: [polar(-11 * DEG, rS, 28), polar(11 * DEG, rS, 28), polar(11 * DEG, rS, 50), polar(-11 * DEG, rS, 50)], color: '#1e232b' });
    GEO.far.push({ pts: [polar(-9.5 * DEG, rS - 0.6, 31), polar(9.5 * DEG, rS - 0.6, 31), polar(9.5 * DEG, rS - 0.6, 47), polar(-9.5 * DEG, rS - 0.6, 47)], color: '#123826' });
    // ポール
    for (const s of [-1, 1]) {
      const r = wallR(FAIR) + 0.3;
      GEO.far.push({ pole: true, a: polar(s * FAIR, r, 0), b: polar(s * FAIR, r, 22), color: '#f5d000' });
    }
    for (const q of GEO.far) {
      if (q.pole) { q.c = mix(q.a, q.b, 0.5); continue; }
      q.c = mul(q.pts.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / q.pts.length);
    }
  }
  buildField();

  // =========================================================
  //  サウンド (Web Audio)
  // =========================================================
  let AC = null, NOISE = null;
  function ac() {
    if (!AC) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      AC = new C();
      const len = AC.sampleRate * 2;
      NOISE = AC.createBuffer(1, len, AC.sampleRate);
      const d = NOISE.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (AC.state === 'suspended') AC.resume();
    return AC;
  }
  function noise(o) {
    const a = ac(); if (!a) return;
    const t = a.currentTime + (o.delay || 0);
    const src = a.createBufferSource(); src.buffer = NOISE; src.loop = true;
    const flt = a.createBiquadFilter(); flt.type = o.type || 'bandpass';
    flt.frequency.setValueAtTime(o.f || 1000, t);
    if (o.f2) flt.frequency.exponentialRampToValueAtTime(o.f2, t + o.dur);
    flt.Q.value = o.q || 1;
    const g = a.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.gain || 0.5, t + (o.at || 0.003));
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    src.connect(flt); flt.connect(g); g.connect(a.destination);
    src.start(t, Math.random()); src.stop(t + o.dur + 0.05);
  }
  function tone(o) {
    const a = ac(); if (!a) return;
    const t = a.currentTime;
    const os = a.createOscillator(); os.type = o.type || 'sine';
    os.frequency.setValueAtTime(o.f, t);
    if (o.f2) os.frequency.exponentialRampToValueAtTime(o.f2, t + o.dur);
    const g = a.createGain();
    g.gain.setValueAtTime(o.gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    os.connect(g); g.connect(a.destination);
    os.start(t); os.stop(t + o.dur + 0.02);
  }
  const sfx = {
    bat(q) { noise({ f: 2400, q: 0.7, dur: 0.18, gain: 0.35 + 0.5 * q }); noise({ f: 900, q: 1.4, dur: 0.09, gain: 0.4 }); tone({ f: 1500, f2: 450, dur: 0.07, gain: 0.15 + 0.25 * q, type: 'triangle' }); },
    swing() { noise({ f: 300, f2: 1600, q: 1.2, dur: 0.22, gain: 0.16, at: 0.08 }); },
    mitt() { noise({ type: 'lowpass', f: 700, dur: 0.1, gain: 0.8 }); tone({ f: 160, f2: 70, dur: 0.08, gain: 0.35 }); },
    // 剛速球: 空気を裂く音と重い捕球音
    heat() { noise({ f: 1800, f2: 5000, q: 2, dur: 0.3, gain: 0.22, at: 0.04 }); },
    bigMitt() { noise({ type: 'lowpass', f: 1200, dur: 0.14, gain: 1.0 }); tone({ f: 120, f2: 45, dur: 0.16, gain: 0.6 }); },
    glove() { noise({ type: 'lowpass', f: 900, dur: 0.07, gain: 0.35 }); },
    hbp() { noise({ type: 'lowpass', f: 450, dur: 0.12, gain: 0.9 }); tone({ f: 220, f2: 90, dur: 0.1, gain: 0.4 }); },
    cheer(d) { noise({ f: 1100, q: 0.6, dur: d, gain: 0.3, at: 0.3 }); noise({ f: 2400, q: 0.7, dur: d * 0.9, gain: 0.12, at: 0.4 }); noise({ f: 500, q: 0.5, dur: d, gain: 0.18, at: 0.5 }); },
    ooh() { noise({ f: 650, q: 0.8, dur: 1.2, gain: 0.14, at: 0.25 }); },
  };

  // =========================================================
  //  ゲーム状態
  // =========================================================
  const game = { state: 'title', st: 0, betweenDur: 1, outs: 0, balls: 0, strikes: 0, runs: 0, hits: 0, hrs: 0, best: 0, inning: 1, ks: 0, bb: 0, pitches: 0, batter: 0 };
  let runners = [];           // {b:塁位置(0..4), target, speed, delay, out, batter}
  let pitch = null, play = null;
  let ballPos = null, ballTrail = [];
  let swingStart = -1, swingCY = 0.8, batterVisible = true;
  let lastCross = null;
  let flash = 0;
  const particles = [];
  const cursor = { x: 0, y: 0.78 };
  let mouse = null;
  const keys = {};
  let catcherMitt = [0, 0.75, -0.9];
  let selPitch = P_TYPES[0], stamina = 100, meter = null;
  const cpuMem = { kmh: 146, last: '' };   // 打者が覚えている直近の球速・球種

  const SWING_LEAD = 0.12;    // スイング開始からミートまでの時間
  const HIT_LEAD = 0.05;      // 打撃判定で使うボタンからミートまでの時間（体感に合わせて短め）
  const WINDUP = 1.25;
  const REL = [-0.4, 1.85, 18.3 - 0.85];

  const FIELD_DEF = [
    { id: 'P',  x: 0,     z: 18.3,  sp: 5.5, re: 0.42, reach: 0.95 },
    { id: 'C',  x: 0,     z: -1.15, sp: 5.0, re: 0.5,  reach: 1.0, air: true },
    { id: '1B', x: 20.0,  z: 25.5,  sp: 6.6, re: 0.25, reach: 1.1, inf: true },
    { id: '2B', x: 9.5,   z: 35.5,  sp: 6.6, re: 0.25, reach: 1.1, inf: true },
    { id: 'SS', x: -9.5,  z: 35.5,  sp: 6.6, re: 0.25, reach: 1.1, inf: true },
    { id: '3B', x: -20.0, z: 25.5,  sp: 6.6, re: 0.25, reach: 1.1, inf: true },
    { id: 'LF', x: -52,   z: 74,    sp: 7.6, re: 0.35, reach: 1.2, of: true },
    { id: 'CF', x: 0,     z: 93,    sp: 7.6, re: 0.35, reach: 1.2, of: true },
    { id: 'RF', x: 52,    z: 74,    sp: 7.6, re: 0.35, reach: 1.2, of: true },
  ];
  const fielders = FIELD_DEF.map(d => ({ ...d, hx: d.x, hz: d.z, face: Math.atan2(-d.x, -d.z), moving: false, phase: 0, hasBall: false }));
  function resetFielders(snap) {
    for (const f of fielders) {
      if (snap) { f.x = f.hx; f.z = f.hz; }
      f.moving = false; f.hasBall = false;
      f.face = Math.atan2(-f.hx, -f.hz);
    }
  }

  // =========================================================
  //  HUD
  // =========================================================
  let msgTimer = 0;
  function showMsg(main, sub, cls, dur = 1.6) {
    // ピッチングでは打たれる＝悪い、アウト＝良い
    if (mode === 'pitch') cls = { good: 'bad', bad: 'good', hr: 'bad' }[cls] || cls;
    const m = $('msg');
    $('msgMain').textContent = main;
    $('msgSub').textContent = sub || '';
    m.className = '';
    void m.offsetWidth;
    m.className = 'show ' + (cls || '');
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { m.className = ''; }, dur * 1000);
  }
  const setSub = t => { $('msgSub').textContent = t; };
  function dots(id, n, max) {
    $(id).innerHTML = Array.from({ length: max }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('');
  }
  const grade = v => (v >= 1.15 ? 'S' : v >= 1.07 ? 'A' : v >= 1.0 ? 'B' : v >= 0.93 ? 'C' : v >= 0.86 ? 'D' : 'E');
  const inningLbl = () => game.inning + '回' + (vs ? (mode === 'bat' ? '表' : '裏') : '');
  function updateHUD() {
    $('runs').textContent = game.runs;
    dots('ballDots', game.balls, 3);
    dots('strikeDots', game.strikes, 2);
    dots('outDots', game.outs, 2);
    for (let b = 1; b <= 3; b++) $('base' + b).classList.toggle('on', runners.some(r => !r.out && Math.round(r.b) === b));
    if (practice) {
      $('runs').textContent = game.pitches;
      const rate = game.pitches ? Math.round(prac.strikes / game.pitches * 100) + '%' : '-';
      $('stats').innerHTML = `ストライク率 <b>${rate}</b> PERFECT <b>${prac.perfect}</b> 最速 <b>${prac.best ? prac.best + 'km/h' : '-'}</b>`;
    } else if (mode === 'pitch') {
      $('stats').innerHTML = `<b>${inningLbl()}</b> <b>${game.ks}K</b> 被安打 <b>${game.hits}</b> 球数 <b>${game.pitches}</b>`;
      const n = game.batter % LINEUP.length, b = LINEUP[n];
      $('batterInfo').innerHTML = `${n + 1}番打者　ミート <b>${grade(b.con)}</b> パワー <b>${grade(b.pow)}</b> 走力 <b>${grade(b.spd)}</b>`;
      const bar = $('staBar');
      bar.style.width = stamina + '%';
      bar.style.background = stamina > 50 ? '#5fe07a' : stamina > 25 ? '#ffd84a' : '#ff5a5a';
    } else {
      $('stats').innerHTML = `${vs ? `<b>${inningLbl()}</b> ` : ''}安打 <b>${game.hits}</b> 本塁打 <b>${game.hrs}</b> 最長 <b>${game.best ? Math.round(game.best) + 'm' : '-'}</b>`;
    }
    if (vs) { const t = vsTotals(); $('runs').textContent = `${t.me}-${t.cpu}`; }
  }
  function setLive(text) {
    const el = $('live');
    if (text) { el.textContent = text; el.classList.add('show'); } else el.classList.remove('show');
  }

  // =========================================================
  //  投球
  // =========================================================
  function inZone(x, y) {
    return x >= ZONE.x0 - BALL_R && x <= ZONE.x1 + BALL_R && y >= ZONE.y0 - BALL_R && y <= ZONE.y1 + BALL_R;
  }
  function makePitch() {
    const total = D.types.reduce((s, n) => s + PITCHES[n].w, 0);
    let r = Math.random() * total, name = D.types[0];
    for (const n of D.types) { r -= PITCHES[n].w; if (r <= 0) { name = n; break; } }
    const def = PITCHES[name];
    const kmh = rand(D.vmin, D.vmax) * def.sp;
    let tx, ty;
    if (Math.random() < 0.6) { tx = rand(-0.2, 0.2); ty = rand(0.52, 1.04); }
    else if (Math.random() < 0.04) { tx = rand(-0.9, -0.76); ty = rand(0.5, 1.4); }   // すっぽ抜けて打者の体へ
    else { do { tx = rand(-0.5, 0.5); ty = rand(0.25, 1.35); } while (inZone(tx, ty)); }
    const brk = [def.bx * D.brk * rand(0.8, 1.15), def.by * D.brk * rand(0.8, 1.15), 0];
    return buildPitch(name, kmh, [tx, ty, 0], brk, 2, (def.drop || 0) * D.brk * rand(0.8, 1.15));
  }
  // tgt: 本塁上を通過する位置, brk: 変化量, bend: 変化の効き始め（s^bend で曲がる）, drop: 手元での落ち幅
  function buildPitch(name, kmh, tgt, brk, bend = 2, drop = 0) {
    const aim = sub(tgt, brk);
    aim[1] -= drop;
    return { name, kmh: Math.round(kmh), rel: REL.slice(), aim, brk, bend, drop, T: REL[2] / (kmh / 3.6), sEnd: 1 + 0.95 / REL[2], t0: 0, t: 0, crossed: false, swung: false, swingT: 0, cross: null, inZone: false, cpu: null, wob: null };
  }
  function pitchPos(p, s) {
    const k = Math.pow(s, p.bend);
    const pos = [
      p.rel[0] + (p.aim[0] - p.rel[0]) * s + p.brk[0] * k,
      p.rel[1] + (p.aim[1] - p.rel[1]) * s + p.brk[1] * k + p.drop * Math.pow(s, DROP_BEND),
      p.rel[2] + (p.aim[2] - p.rel[2]) * s,
    ];
    if (p.wob) {
      // ナックルの揺れ（リリース直後と本塁上では 0）
      const w = p.wob, k = 4 * s * (1 - s);
      pos[0] += w.ax * k * Math.sin(w.f * s + w.ph);
      pos[1] += w.ay * k * Math.sin(w.f * 1.3 * s + w.ph * 0.7);
    }
    return pos;
  }
  function releasePitch(now, p) {
    pitch = p || makePitch();
    pitch.t0 = now;
    ballPos = REL.slice();
    ballTrail = [];
    game.state = 'pitch'; game.st = 0;
    $('pitchName').textContent = pitch.name;
    $('pitchSpeed').textContent = pitch.kmh + ' km/h';
    $('pSpeed').innerHTML = `${pitch.name} <b>${pitch.kmh}</b> km/h`;
    $('pitchInfo').classList.add('show');
  }

  function swing() {
    if (game.state !== 'pitch' || pitch.swung) return;
    const now = performance.now();
    pitch.swung = true;
    pitch.swingT = (now - pitch.t0) / 1000;
    swingStart = now;
    swingCY = cursor.y;
    sfx.swing();
    // ボールが本塁を通過した後の振り遅れでも、許容幅の内なら当てる
    if (pitch.crossed) tryHit(pitch.cross, pitch.T - (pitch.swingT + HIT_LEAD));
  }

  // =========================================================
  //  ピッチングモード
  // =========================================================
  const RING0 = 0.45, RING_HIT = 0.06;   // 縮むリングの初期半径・的の半径 (m)
  const ringR = st => RING0 * (1 - (st - 0.1) / 1.05);

  function selectPitch(name) {
    selPitch = name;
    document.querySelectorAll('#pitchBtns button').forEach(b => b.classList.toggle('sel', b.dataset.p === name));
  }
  function idealPitch(name) {
    const def = PITCHES[name];
    return buildPitch(name, P_VMAX * def.sp, [cursor.x, cursor.y, 0], [def.bx * P_BRK, def.by * P_BRK, 0], P_BEND, (def.drop || 0) * dropK(def.drop));
  }
  function makePlayerPitch() {
    const def = PITCHES[selPitch], acc = meter.acc, sta = stamina / 100;
    const sd = (0.025 + (1 - acc) * 0.17 + (1 - sta) * 0.06) * (def.ctl || 1);
    const tgt = [cursor.x + gauss() * sd, cursor.y + gauss() * sd, 0];
    const kmh = P_VMAX * def.sp * (0.94 + 0.06 * acc) * (0.92 + 0.08 * sta) * rand(0.985, 1.01);
    if (def.knuckle) {
      // ナックルは投げた本人にも行き先が読めない
      const brk = [rand(-0.18, 0.18), rand(-0.25, 0.05), 0];
      const p = buildPitch(selPitch, kmh, add(tgt, brk), brk);
      p.wob = { ax: rand(0.04, 0.08) * P_BRK * (Math.random() < 0.5 ? -1 : 1), ay: rand(0.03, 0.06) * P_BRK, f: rand(2, 3.5) * PI * 2, ph: rand(0, PI * 2) };
      return p;
    }
    return buildPitch(selPitch, kmh, tgt, [def.bx * P_BRK * rand(0.9, 1.1), def.by * P_BRK * rand(0.9, 1.1), 0], P_BEND, (def.drop || 0) * dropK(def.drop) * rand(0.9, 1.1));
  }

  // CPU打者: 見えたコースと予想タイミングからスイングを決める
  function planBatter(p) {
    const b = LINEUP[game.batter % LINEUP.length];
    const def = PITCHES[p.name];
    const cross = pitchPos(p, 1);
    // 遅い球ほど変化を見極めやすく、同じ球種が続くと慣れる
    const read = clamp(D.read * b.con + (1 - def.sp) * 1.2 + (def.rd || 0) + (p.name === cpuMem.last ? 0.12 : 0), 0, 0.95);
    // 見た目の変化量を増やしても打者の騙されやすさは変えない（変化量 1.5 倍のときの 0.45 が基準）
    const mis = (1 - read) * 0.45 * 1.5 / P_BRK;
    // 真ん中から離れるほど芯で捉えにくい
    const loc = Math.min(1.5, Math.hypot(cross[0] / 0.3, (cross[1] - 0.78) / 0.4));
    const sd = 0.022 + 0.07 * loc;
    // 落ち幅も倍率で割り戻して、P_DROP を変えても騙されやすさが変わらないようにする
    const misD = mis * P_BRK / dropK(p.drop);
    const perc = [cross[0] - p.brk[0] * mis + gauss() * sd, cross[1] - p.brk[1] * mis - p.drop * misD + gauss() * sd];
    const two = game.strikes >= 2, wait = game.balls === 3 && !two;
    let ps;
    if (inZone(perc[0], perc[1])) ps = two ? 0.92 : wait ? 0.55 : game.balls + game.strikes === 0 ? 0.6 : 0.75;
    else {
      const dx = Math.max(ZONE.x0 - perc[0], 0, perc[0] - ZONE.x1), dy = Math.max(ZONE.y0 - perc[1], 0, perc[1] - ZONE.y1);
      ps = 0.42 * Math.exp(-Math.hypot(dx, dy) / 0.09) * (two ? 1.5 : 1) * (wait ? 0.5 : 1) / b.eye;
    }
    const Tavg = REL[2] / (cpuMem.kmh / 3.6);
    const Texp = lerp(Tavg, p.T, clamp(D.adapt * b.con, 0, 0.95)) + gauss() * (0.018 + Math.max(0, p.kmh - 120) * 0.0004);
    // 体に向かってくる球は振らずによける
    return { swing: !hitsBatter(cross) && Math.random() < ps, perc, Texp, early: p.T - Texp, bat: { x: perc[0], y: perc[1], rx: D.rx * b.con, ry: D.ry * b.con, win: D.win, pow: b.pow } };
  }
  function cpuSwing(now) {
    pitch.swung = true;
    swingStart = now;
    swingCY = pitch.cpu.perc[1];
    sfx.swing();
  }

  function throwPitch() {
    game.state = 'windup'; game.st = 0;
    meter = { acc: null, grade: '' };
    $('pitchSel').classList.add('lock');
  }
  function lockMeter(auto) {
    if (!meter || meter.acc !== null || game.st < 0.1) return;
    meter.acc = auto ? 0 : clamp(1 - Math.abs(ringR(game.st) - RING_HIT) / 0.16, 0, 1);
    meter.grade = meter.acc > 0.85 ? 'PERFECT' : meter.acc > 0.55 ? 'GOOD' : 'BAD';
    setLive(meter.grade);
  }
  function releasePlayerPitch(now) {
    if (meter.acc === null) lockMeter(true);
    releasePitch(now, makePlayerPitch());
    const def = PITCHES[pitch.name];
    if (def.heat) sfx.heat();
    game.pitches++;
    if (practice) { updateHUD(); return; }
    pitch.cpu = planBatter(pitch);
    cpuMem.kmh = lerp(cpuMem.kmh, pitch.kmh, 0.5);
    cpuMem.last = pitch.name;
    stamina = Math.max(0, stamina - (def.cost || (def.sp < 0.9 ? 1.9 : 1.4)));
    updateHUD();
  }
  function startAim() {
    startWindup();
    game.state = 'aim';
    meter = null;
    setLive('');
    $('pitchSel').classList.remove('lock');
  }
  function nextInning() {
    game.inning++; game.outs = 0; game.balls = game.strikes = 0;
    runners = [];
    stamina = Math.min(100, stamina + 8);
    updateHUD();
    showMsg(game.inning + '回', '', 'neutral', 1.4);
    toBetween(1.6);
  }
  const startNext = () => (mode === 'pitch' ? startAim() : startWindup());

  // 試合: 攻守交代（成績・打順は攻守ごとに持ち越す）
  const pickSide = () => Object.fromEntries(SIDE_KEYS.map(k => [k, game[k]]));
  const SIDE0 = Object.fromEntries(SIDE_KEYS.map(k => [k, 0]));
  function switchSide(next) {
    vsm.saved[mode] = pickSide();
    mode = next;
    Object.assign(game, vsm.saved[mode] || SIDE0);
    D = (mode === 'pitch' ? PDIFFS : DIFFS)[selDiff];
    game.outs = game.balls = game.strikes = 0;
    runners = []; pitch = null; play = null; ballPos = null; ballTrail = []; lastCross = null; meter = null;
    $('pitchInfo').classList.remove('show');
    if (mode === 'pitch' && game.inning > 1) stamina = Math.min(100, stamina + 8);
    startHalf();
  }
  function startHalf() {
    const side = vsm.line[mode === 'bat' ? 'me' : 'cpu'];
    side[game.inning - 1] = side[game.inning - 1] || 0;
    cursor.x = 0; cursor.y = 0.78;
    $('pitchSel').classList.add('lock');
    $('pSpeed').textContent = '';
    resetFielders(true);
    applyModeUI();
    updateHUD();
    showMsg(inningLbl(), mode === 'bat' ? '攻撃' : '守備', 'neutral', 1.6);
    toBetween(1.8);
  }
  function endHalf() {
    const t = vsTotals();
    if (mode === 'bat') {
      // 最終回の表を終えて CPU がリードしていれば裏は行わない
      if (game.inning >= vsm.innings && t.cpu > t.me) { vsm.skip = true; gameOver(); return; }
      switchSide('pitch');
    } else {
      if (game.inning >= vsm.innings) { gameOver(); return; }
      game.inning++;
      switchSide('bat');
    }
  }
  function renderLine() {
    const n = vsm.innings, L = vsm.line;
    const cell = (side, i) => {
      const v = L[side][i];
      if (side === 'cpu' && i === n - 1) { if (vsm.skip) return 'X'; if (vsm.walkoff) return v + 'x'; }
      return v == null ? '' : v;
    };
    const cols = f => Array.from({ length: n }, (_, i) => f(i)).join('');
    const row = (side, name) => `<tr><th>${name}</th>${cols(i => `<td>${cell(side, i)}</td>`)}<td class="tot">${sum(L[side])}</td></tr>`;
    $('ovLine').innerHTML = `<table><tr><th></th>${cols(i => `<th>${i + 1}</th>`)}<th>計</th></tr>${row('me', '自分')}${row('cpu', 'CPU')}</table>`;
  }

  function endPitch() {
    if (!pitch.hbp) { if (PITCHES[pitch.name].heat) sfx.bigMitt(); else sfx.mitt(); }
    setLive('');
    lastCross = { p: pitch.cross, strike: pitch.swung || pitch.inZone };
    if (practice) { practicePitchResult(); return; }
    let walk = false;
    if (pitch.hbp) {
      walk = true;
      showMsg('デッドボール', '', 'good');
    } else if (pitch.swung) {
      game.strikes++;
      if (game.strikes >= 3) showMsg('三振', mode === 'pitch' ? `空振り ${game.ks + 1}K` : '空振り', 'bad'); else showMsg('空振り', '', 'strike', 1.1);
    } else if (pitch.inZone) {
      game.strikes++;
      if (game.strikes >= 3) showMsg('見逃し三振', mode === 'pitch' ? `${game.ks + 1}K` : '', 'bad'); else showMsg('ストライク', '', 'strike', 1.1);
    } else {
      game.balls++;
      if (game.balls >= 4) { walk = true; showMsg('フォアボール', '', 'good'); } else showMsg('ボール', '', 'neutral', 1.1);
    }
    if (game.strikes >= 3) { game.outs++; game.ks++; game.batter++; game.balls = game.strikes = 0; }
    if (walk) {
      const spd = batterSpd();   // 打順を進める前に四死球の打者の走力を取る
      game.bb++; game.batter++;  // bb: 四死球の数
      game.balls = game.strikes = 0;
      const sorted = runners.filter(r => !r.out).sort((a, b) => a.b - b.b);
      let need = 1;
      for (const r of sorted) { if (r.b === need) { r.target = r.b + 1; r.speed = 0.35; r.delay = 0; need++; } else break; }
      runners.push({ b: 0, target: 1, speed: 0.35, delay: 0, out: false, batter: false, spd });
      batterVisible = false;
    }
    updateHUD();
    toBetween(walk ? 2.6 : 1.2);
  }

  // デッドボール: 本塁上で打者の体に当たったか（振っていたらストライク扱いなので呼ばない）
  const hitsBatter = c => !practice && c[0] <= BATTER_X + 0.17 + BALL_R && c[0] >= BATTER_X - 0.25 && c[1] >= 0.1 && c[1] <= 1.75;
  function startHBP() {
    pitch.hbp = true;
    sfx.hbp();
    flash = 0.35;
    ballPos = pitch.cross.slice();
    ballTrail = [];
    // 体に当たって跳ね返る
    pitch.vel = [rand(0.8, 1.6), rand(1.0, 2.0), rand(2.0, 3.5)];
    lastCross = { p: pitch.cross, strike: false };
    game.state = 'hbp'; game.st = 0;
  }

  // 投球練習: カウントは進めず、球速と狙いからのズレを見せる（狙いのカーソルは投球中は動かない）
  function practicePitchResult() {
    const miss = Math.hypot(pitch.cross[0] - cursor.x, pitch.cross[1] - cursor.y);
    if (pitch.inZone) prac.strikes++;
    if (meter.grade === 'PERFECT') prac.perfect++;
    prac.best = Math.max(prac.best, pitch.kmh);
    prac.miss += miss;
    showMsg(pitch.inZone ? 'ストライク' : 'ボール', `${pitch.kmh} km/h ／ 狙いから ${Math.round(miss * 100)} cm`, pitch.inZone ? 'strike' : 'neutral', 1.1);
    updateHUD();
    toBetween(1.0);
  }
  function quitPractice() {
    if (!practice || game.state === 'title' || game.state === 'over') return;
    gameOver();
  }

  function toBetween(dur) {
    game.state = 'between'; game.st = 0; game.betweenDur = dur;
  }

  // =========================================================
  //  打球
  // =========================================================
  // bat: ミートの中心・範囲とパワー（省略時はプレイヤーのカーソル）
  // rect: ミート範囲を横長の四角にする（プレイヤー）。CPU打者は楕円のまま
  function tryHit(cp, early, bat = { x: cursor.x, y: cursor.y, rx: D.rx, ry: D.ry, win: D.win, pow: 1, rect: true }) {
    const ex = (cp[0] - bat.x) / bat.rx, ey = (cp[1] - bat.y) / bat.ry;
    const e = bat.rect ? Math.max(Math.abs(ex), Math.abs(ey)) : Math.hypot(ex, ey);
    if (e > 1 || Math.abs(early) > bat.win) return false;
    const qt = 1 - Math.abs(early) / bat.win;
    const q = (1 - Math.pow(e, 1.7)) * (0.5 + 0.5 * Math.pow(qt, 0.6));
    let ev = (19 + 33 * q) * lerp(1, bat.pow, 0.6);
    let la = 13 + ey * 50 + rand(-4, 4);
    let spray = -(early / bat.win) * 52 + rand(-3, 3);
    if (e > 0.82 && Math.random() < 0.6) { // バットの芯を外したファウル
      spray = (Math.random() < 0.5 ? -1 : 1) * rand(95, 165);
      la = rand(15, 65);
      ev = rand(16, 26);
    }
    la = clamp(la, -40, 75);
    const L = la * DEG, S = spray * DEG;
    const v0 = [ev * Math.cos(L) * Math.sin(S), ev * Math.sin(L), ev * Math.cos(L) * Math.cos(S)];
    play = planPlay(cp.slice(), v0, la, S);
    sfx.bat(q);
    flash = 0.6 + q * 0.4;
    ballPos = cp.slice();
    ballTrail = [];
    game.state = 'hitstop'; game.st = 0;
    return true;
  }

  // 打球の軌道をあらかじめシミュレート
  function simulate(p0, v0) {
    const dt = 1 / 240, SUBS = 2;
    const p = p0.slice(), v = v0.slice();
    const S = [];
    const r = { S, sdt: dt * SUBS, firstT: -1, firstPos: null, overT: -1, overFair: false, landT: -1, landPos: null };
    let over = false, rest = false, t = 0;
    const steps = 240 * 14;
    for (let i = 0; i <= steps; i++, t += dt) {
      if (i % SUBS === 0) S.push([p[0], p[1], p[2]]);
      if (rest) continue;
      const sp = Math.hypot(v[0], v[1], v[2]);
      const rolling = !over && p[1] <= BALL_R + 1e-4 && v[1] === 0;
      if (!rolling) {
        v[0] -= DRAG * sp * v[0] * dt;
        v[1] -= (G + DRAG * sp * v[1]) * dt;
        v[2] -= DRAG * sp * v[2] * dt;
      } else {
        const hs = Math.hypot(v[0], v[2]), dec = 4.2 * dt;
        if (hs <= dec) { v[0] = v[2] = 0; rest = true; continue; }
        v[0] *= (hs - dec) / hs; v[2] *= (hs - dec) / hs;
      }
      p[0] += v[0] * dt; p[1] += v[1] * dt; p[2] += v[2] * dt;
      const rr = Math.hypot(p[0], p[2]), th = Math.atan2(p[0], p[2]), R = wallR(th);
      if (!over) {
        if (rr >= R - BALL_R) {
          if (p[1] < wallH(th)) { // フェンス直撃
            const n = [p[0] / rr, 0, p[2] / rr];
            const vn = v[0] * n[0] + v[2] * n[2];
            if (vn > 0) { v[0] -= n[0] * vn * 1.4; v[2] -= n[2] * vn * 1.4; v[0] *= 0.8; v[1] *= 0.8; v[2] *= 0.8; }
            const k = (R - BALL_R - 0.02) / rr; p[0] *= k; p[2] *= k;
            if (r.firstT < 0) { r.firstT = t; r.firstPos = p.slice(); }
          } else { over = true; r.overT = t; r.overFair = Math.abs(th) <= FAIR; }
        }
        if (!over && p[1] < BALL_R) {
          p[1] = BALL_R;
          if (r.firstT < 0) { r.firstT = t; r.firstPos = p.slice(); }
          if (v[1] < 0) {
            if (v[1] < -1.5) { v[1] = -v[1] * 0.42; v[0] *= 0.7; v[2] *= 0.7; } else v[1] = 0;
          }
        }
      } else {
        const sy = wallH(th) + clamp(rr - R, 0, STAND_DEPTH) * STAND_SLOPE;
        if (p[1] < sy) {
          p[1] = sy;
          if (r.landT < 0) { r.landT = t; r.landPos = p.slice(); }
          v[0] *= 0.3; v[1] = Math.abs(v[1]) * 0.25; v[2] *= 0.3;
          if (Math.hypot(v[0], v[1], v[2]) < 2) { v[0] = v[1] = v[2] = 0; rest = true; }
        }
      }
    }
    return r;
  }
  function sampleAt(sim, t) {
    const f = t / sim.sdt, i = Math.floor(f), S = sim.S;
    if (i >= S.length - 1) return S[S.length - 1].slice();
    if (i < 0) return S[0].slice();
    return mix(S[i], S[i + 1], f - i);
  }
  // 打者の走力（バッティングモードの自分は 1）
  const batterSpd = () => (mode === 'pitch' ? LINEUP[game.batter % LINEUP.length].spd : 1);
  const runT = n => 0.5 + n * 3.7 / batterSpd();   // 打者走者が n 塁に到達する時刻

  function planPlay(p0, v0, la, spray) {
    const sim = simulate(p0, v0);
    const pl = { sim, t: 0, events: [], kind: '', best: null, holder: -1, thr: null, endT: 3, camDir: [Math.sin(spray), Math.cos(spray)], liveEnd: 0, bases: 0, dist: 0, fair: false };
    const ev = (t, fn) => pl.events.push({ t, fn, done: false });

    const overFirst = sim.overT >= 0 && (sim.firstT < 0 || sim.overT < sim.firstT);
    let fair, decT;
    if (overFirst) { fair = sim.overFair; decT = sim.overT; }
    else if (sim.firstT >= 0) { fair = Math.abs(Math.atan2(sim.firstPos[0], sim.firstPos[2])) <= FAIR; decT = sim.firstT; }
    else { fair = false; decT = 1; }
    pl.fair = fair;

    // 野手の捕球判定
    let best = null;
    fielders.forEach((f, i) => {
      const airOnly = !fair || f.air;
      const spd = f.sp * D.field;
      for (let j = 0; j < sim.S.length; j++) {
        const t = j * sim.sdt;
        if (t < f.re) continue;
        if (airOnly && sim.firstT >= 0 && t >= sim.firstT) break;
        if (sim.overT >= 0 && t >= sim.overT) break;
        const b = sim.S[j];
        if (b[1] > 2.5) continue;
        const d = Math.hypot(b[0] - f.hx, b[2] - f.hz) - f.reach;
        if (d <= spd * (t - f.re)) { if (!best || t < best.t) best = { i, t, pos: b.slice() }; break; }
      }
    });
    if (!best && fair && !overFirst && sim.overT < 0) {
      // 念のため: 誰も間に合わない場合は最後に止まった位置へ一番近い野手
      const last = sim.S[sim.S.length - 1];
      let bi = 2, bd = Infinity;
      fielders.forEach((f, i) => { const d = Math.hypot(last[0] - f.hx, last[2] - f.hz); if (i > 1 && d < bd) { bd = d; bi = i; } });
      best = { i: bi, t: (sim.S.length - 1) * sim.sdt, pos: last.slice() };
    }
    const air = best && (sim.firstT < 0 || best.t < sim.firstT);
    const deep = best && hdist(best.pos) > 42;

    if (air) {
      // フライ・ライナーアウト
      pl.kind = 'flyout'; pl.best = best;
      pl.dist = hdist(best.pos);
      const name = POS_NAME[fielders[best.i].id];
      const label = !fair ? 'ファウルフライ' : name + (la < 12 ? 'ライナー' : 'フライ');
      ev(best.t, () => { catchBall(best.i); showMsg('アウト', label, 'bad'); });
      pl.liveEnd = best.t;
      if (deep) {
        const to = [BASES[2][0], 1.4, BASES[2][2]];
        const dur = Math.max(0.35, Math.hypot(to[0] - best.pos[0], to[2] - best.pos[2]) / 30);
        pl.thr = { start: best.t + 0.7, to, dur };
        pl.endT = pl.thr.start + dur + 0.7;
      } else pl.endT = best.t + 1.6;
      if (fair && deep && game.outs < 2) tagUp(pl, best.t);
      if (fair) runners.push({ b: 0, target: 1, speed: 0.27, delay: 0.5, out: true, batter: true, spd: batterSpd() });
    } else if (!fair) {
      pl.kind = 'foul';
      ev(decT, () => { showMsg('ファウル', '', 'neutral', 1.2); sfx.ooh(); });
      pl.liveEnd = decT;
      pl.endT = decT + 1.3;
    } else if (overFirst) {
      // ホームラン
      pl.kind = 'hr';
      const lt = sim.landT >= 0 ? sim.landT : sim.overT + 1.5;
      pl.dist = hdist(sim.landT >= 0 ? sim.landPos : sampleAt(sim, lt));
      ev(sim.overT, () => { showMsg('ホームラン!!', '', 'hr', 4.2); sfx.cheer(4); if (mode === 'bat') confetti(); });
      ev(lt, () => setSub(`飛距離 ${Math.round(pl.dist)}m`));
      pl.liveEnd = lt;
      pl.endT = lt + 2.6;
      for (const r of runners) if (!r.out) { r.target = 4; r.speed = 0.24; r.delay = 0.6; }
      runners.push({ b: 0, target: 4, speed: 0.24, delay: 0.8, out: false, batter: true, spd: batterSpd() });
      pl.bases = 4;
    } else if (sim.overT >= 0) {
      // ワンバウンドでスタンドイン
      pl.kind = 'hit'; pl.bases = 2;
      pl.dist = hdist(sim.firstPos);
      ev(sim.overT, () => showMsg('エンタイトルツーベース', '', 'good', 2));
      pl.liveEnd = sim.firstT;
      pl.endT = Math.max(sim.overT + 2.2, runT(2) * 0.6);
      advanceAll(2);
    } else {
      // ゴロ・ヒット
      const f = fielders[best.i];
      pl.best = best;
      pl.dist = hdist(sim.firstPos);
      let n = 0;
      for (let k = 1; k <= 3; k++) {
        const thr = best.t + 0.65 + Math.hypot(BASES[k][0] - best.pos[0], BASES[k][2] - best.pos[2]) / 30;
        if (runT(k) < thr - 0.15) n = k; else break;
      }
      pl.bases = n;
      if (n === 0 && tryDoublePlay(pl, f, best)) return pl;
      pl.kind = n === 0 ? 'groundout' : 'hit';
      const tb = n === 0 ? BASES[1] : BASES[Math.min(n + 1, 4)];
      const to = [tb[0], 1.3, tb[2]];
      const dur = Math.max(0.3, Math.hypot(to[0] - best.pos[0], to[2] - best.pos[2]) / 30);
      pl.thr = { start: best.t + 0.65, to, dur };
      const thrEnd = pl.thr.start + dur;
      ev(best.t, () => {
        catchBall(best.i);
        if (n > 0) showMsg(['', 'ヒット', 'ツーベースヒット', 'スリーベースヒット'][n], la > 8 ? `飛距離 ${Math.round(pl.dist)}m` : '', 'good', 2);
      });
      ev(thrEnd, () => { sfx.glove(); if (n === 0) showMsg('アウト', POS_NAME[f.id] + 'ゴロ', 'bad'); });
      pl.liveEnd = la > 8 ? sim.firstT : 0;
      pl.endT = Math.max(thrEnd + 0.9, Math.min(runT(Math.max(n, 1)) + 0.3, thrEnd + 2.6));
      if (n === 0) runners.push({ b: 0, target: 1, speed: 0.27, delay: 0.5, out: true, batter: true, spd: batterSpd() });
      else advanceAll(n);
    }
    if (runners.some(r => r.batter)) batterVisible = false;
    return pl;
  }
  // 併殺: 一塁走者がいて、内野手（投手含む）が素早く捕れたゴロなら 二塁→一塁 と転送して2アウト
  function tryDoublePlay(pl, f, best) {
    if (game.outs >= 2 || f.of || f.id === 'C') return false;
    const live = runners.filter(r => !r.out);
    const on = b => live.find(r => Math.round(r.b) === b);
    const r1 = on(1);
    if (!r1) return false;
    const to2 = [BASES[2][0], 1.3, BASES[2][2]], to1 = [BASES[1][0], 1.3, BASES[1][2]];
    const start = best.t + 0.55;
    const dur2 = Math.max(0.3, Math.hypot(to2[0] - best.pos[0], to2[2] - best.pos[2]) / 30);
    const end2 = start + dur2;
    const relay = end2 + 0.45;
    const dur1 = Math.hypot(to1[0] - to2[0], to1[2] - to2[2]) / 30;
    const end1 = relay + dur1;
    const r1Arrive = 0.3 + 1 / (0.27 * (r1.spd || 1));
    if (r1Arrive < end2 + 0.1 || end1 > runT(1) - 0.3) return false;   // どちらかが間に合わなければ通常のゴロ

    pl.kind = 'dp';
    pl.thr = { start, to: to2, dur: dur2 };
    pl.thr2 = { start: relay, to: to1, dur: dur1 };
    const ev = (t, fn) => pl.events.push({ t, fn, done: false });
    ev(best.t, () => catchBall(best.i));
    ev(end2, () => { sfx.glove(); showMsg('アウト', '二塁フォースアウト', 'bad', 1.2); });
    ev(end1, () => { sfx.glove(); showMsg('ダブルプレー', POS_NAME[f.id] + 'ゴロ', 'bad', 2); });
    pl.liveEnd = 0;
    pl.endT = end1 + 1.2;
    // 一塁走者は二塁でアウト。無死なら押し出される走者は1つ進む（2アウト目で攻撃終了ならそのまま）
    r1.out = true; r1.target = 2; r1.speed = 0.27; r1.delay = 0.3;
    if (game.outs === 0) {
      const r2 = on(2);
      if (r2) {
        r2.target = 3; r2.speed = 0.27; r2.delay = 0.3;
        const r3 = on(3);
        if (r3) { r3.target = 4; r3.speed = 0.27; r3.delay = 0.3; }
      }
    }
    runners.push({ b: 0, target: 1, speed: 0.27, delay: 0.5, out: true, batter: true, spd: batterSpd() });
    batterVisible = false;
    return true;
  }
  // 外野フライのタッチアップ: 捕球後に塁を離れ、飛距離が十分なら次の塁へ進む
  // （前の走者が進まない限り後ろの走者は進めない）
  const TAG_DIST = { 3: 50, 2: 72, 1: 95 };   // 元の塁ごとに必要な飛距離 (m)
  function tagUp(pl, catchT) {
    const live = runners.filter(r => !r.out).sort((a, b) => b.b - a.b);
    let open = true, lead = null, arrive = 0;
    for (const r of live) {
      const from = Math.round(r.b);
      if (!open || pl.dist < TAG_DIST[from]) { open = false; continue; }
      r.target = from + 1; r.speed = 0.3; r.delay = catchT + 0.15;
      arrive = Math.max(arrive, r.delay + 1 / (r.speed * (r.spd || 1)));
      if (!lead) lead = r;
    }
    if (!lead) return;
    const scored = lead.target >= 4;
    pl.events.push({ t: arrive, done: false, fn: () => showMsg(scored ? '犠牲フライ' : 'タッチアップ', scored ? 'タッチアップで1点' : '進塁', scored ? 'good' : 'neutral', 1.8) });
    pl.endT = Math.max(pl.endT, arrive + 0.6);
  }
  function advanceAll(n) {
    for (const r of runners) if (!r.out) { r.target = Math.min(4, r.b + n); r.speed = 0.27; r.delay = 0.3; }
    runners.push({ b: 0, target: n, speed: 0.27, delay: 0.5, out: false, batter: true, spd: batterSpd() });
  }
  function catchBall(i) {
    play.holder = i;
    fielders[i].hasBall = true;
    sfx.glove();
  }
  function playBallPos() {
    const pl = play;
    if (pl.holder >= 0) {
      const f = fielders[pl.holder];
      if (pl.thr2 && pl.t >= pl.thr2.start) {   // 併殺の一塁への転送
        const u = clamp((pl.t - pl.thr2.start) / pl.thr2.dur, 0, 1);
        const p = mix(pl.thr.to, pl.thr2.to, u);
        p[1] += u * (1 - u) * 4 * Math.min(5, pl.thr2.dur * 2);
        return p;
      }
      if (pl.thr && pl.t >= pl.thr.start) {
        if (!pl.thr.from) { pl.thr.from = [f.x, 1.7, f.z]; f.hasBall = false; }
        const u = clamp((pl.t - pl.thr.start) / pl.thr.dur, 0, 1);
        const p = mix(pl.thr.from, pl.thr.to, u);
        p[1] += u * (1 - u) * 4 * Math.min(5, pl.thr.dur * 2);
        return p;
      }
      return [f.x + Math.sin(f.face) * 0.3, 1.2, f.z + Math.cos(f.face) * 0.3];
    }
    return sampleAt(pl.sim, pl.t);
  }

  function finishPlay() {
    const k = play.kind;
    if (k === 'foul') {
      if (game.strikes < 2) game.strikes++;
    } else {
      game.balls = game.strikes = 0;
      game.batter++;
      if (k === 'flyout' || k === 'groundout') game.outs++;
      if (k === 'dp') game.outs += 2;
      if (k === 'hit' || k === 'hr') {
        game.hits++;
        if (k === 'hr') game.hrs++;
        game.best = Math.max(game.best, play.dist);
      }
    }
    settleRunners();
    setLive('');
    updateHUD();
    toBetween(1.9);
  }
  function settleRunners() {
    const keep = [];
    for (const r of runners) {
      if (r.out) continue;
      r.b = r.target;
      if (r.b >= 4) {
        game.runs++;
        if (vs) { const side = vsm.line[mode === 'bat' ? 'me' : 'cpu']; side[game.inning - 1] = (side[game.inning - 1] || 0) + 1; }
        continue;
      }
      r.batter = false;
      keep.push(r);
    }
    runners = keep;
  }
  function updateRunners(dt, t) {
    for (const r of runners) {
      if (r.b < r.target && t >= r.delay) r.b = Math.min(r.target, r.b + r.speed * (r.spd || 1) * dt);
    }
  }
  function runnerPos(b) {
    const i = clamp(Math.floor(b), 0, 3), u = b - i;
    return mix(BASES[i], BASES[i + 1], clamp(u, 0, 1));
  }

  // =========================================================
  //  守備の動き
  // =========================================================
  function moveToward(f, tx, tz, spd, stop, dt) {
    const dx = tx - f.x, dz = tz - f.z, d = Math.hypot(dx, dz);
    if (d > stop + 0.05) {
      const step = Math.min(d - stop, spd * dt);
      f.x += dx / d * step; f.z += dz / d * step;
      f.face = Math.atan2(dx, dz);
      f.moving = true; f.phase += step * 2.4;
    } else f.moving = false;
  }
  function updateFielders(dt) {
    const pl = play, b = ballPos;
    fielders.forEach((f, i) => {
      if (pl.t < f.re) return;
      const spd = f.sp * D.field;
      if (pl.best && i === pl.best.i) {
        if (pl.holder !== i) moveToward(f, pl.best.pos[0], pl.best.pos[2], spd, 0, dt);
        else f.moving = false;
      } else if (pl.holder < 0 && (f.of || (f.inf && hdist(b) < 40))) {
        moveToward(f, b[0], b[2], spd * 0.7, 7, dt);
      } else f.moving = false;
      if (!f.moving) {
        if (pl.thr && pl.holder === i && !pl.thr.from) f.face = Math.atan2(pl.thr.to[0] - f.x, pl.thr.to[2] - f.z);
        else f.face = Math.atan2(b[0] - f.x, b[2] - f.z);
      }
    });
  }

  // =========================================================
  //  入力
  // =========================================================
  function canAim() {
    const st = game.state;
    return mode === 'pitch' ? st === 'aim' : st === 'windup' || st === 'pitch';
  }
  // ピッチャー視点では画面の左右と x 軸が逆になる
  const sideSign = () => (mode === 'pitch' ? -1 : 1);
  function action() {
    ac();
    if (mode === 'bat') swing();
    else if (game.state === 'aim') throwPitch();
    else if (game.state === 'windup') lockMeter(false);
  }
  function updateCursorFromMouse() {
    if (!mouse || !canAim()) return;
    updateBasis();
    const dx = (mouse.x - cam.cx) / cam.f, dy = -(mouse.y - cam.cy) / cam.f;
    const dir = add(add(cam.fwd, mul(cam.right, dx)), mul(cam.up, dy));
    if (Math.abs(dir[2]) < 1e-6) return;
    const t = -cam.pos[2] / dir[2];
    if (t <= 0) return;
    cursor.x = clamp(cam.pos[0] + dir[0] * t, -0.7, 0.7);
    cursor.y = clamp(cam.pos[1] + dir[1] * t, 0.15, 1.5);
  }
  canvas.addEventListener('mousemove', e => { mouse = { x: e.clientX, y: e.clientY }; });
  canvas.addEventListener('mousedown', e => { if (e.button === 0) { ac(); mouse = { x: e.clientX, y: e.clientY }; updateCursorFromMouse(); action(); } });
  // タッチ: 画面をなぞるとカーソルが相対移動（指でゾーンが隠れない）、ボタンでスイング・投球
  function enableTouch() {
    if (document.body.classList.contains('touch')) return;
    document.body.classList.add('touch');
    applyModeUI();
  }
  window.addEventListener('touchstart', enableTouch, { passive: true });
  let drag = null;
  canvas.addEventListener('touchstart', e => {
    e.preventDefault(); ac();
    mouse = null;
    if (!drag) { const t = e.changedTouches[0]; drag = { id: t.identifier, x: t.clientX, y: t.clientY }; }
  }, { passive: false });
  canvas.addEventListener('touchmove', e => {
    e.preventDefault();
    if (!drag) return;
    for (const t of e.changedTouches) {
      if (t.identifier !== drag.id) continue;
      if (mode === 'bat' || canAim()) {
        const hc = homeCam();
        const k = (mode === 'pitch' ? 1.1 : 1.5) * Math.abs(hc.pos[2]) / (baseF() * hc.fs);   // 画面px → ゾーン面のm
        cursor.x = clamp(cursor.x + (t.clientX - drag.x) * k * sideSign(), -0.7, 0.7);
        cursor.y = clamp(cursor.y - (t.clientY - drag.y) * k, 0.15, 1.5);
      }
      drag.x = t.clientX; drag.y = t.clientY;
    }
  }, { passive: false });
  const endDrag = e => { for (const t of e.changedTouches) if (drag && t.identifier === drag.id) drag = null; };
  canvas.addEventListener('touchend', endDrag);
  canvas.addEventListener('touchcancel', endDrag);

  const swingBtn = $('swingBtn');
  swingBtn.addEventListener('touchstart', e => { e.preventDefault(); swingBtn.classList.add('press'); action(); }, { passive: false });
  const release = () => swingBtn.classList.remove('press');
  swingBtn.addEventListener('touchend', release);
  swingBtn.addEventListener('touchcancel', release);
  swingBtn.addEventListener('mousedown', e => { e.preventDefault(); action(); });
  window.addEventListener('keydown', e => {
    keys[e.code] = true;
    if (e.code === 'Space') { e.preventDefault(); action(); }
    if (e.code === 'Escape') quitPractice();
    const pi = P_CODES.indexOf(e.code.replace('NumpadSubtract', 'Minus').replace('Numpad', 'Digit').replace('Backslash', 'IntlYen'));
    if (mode === 'pitch' && game.state === 'aim' && pi >= 0 && pi < myPitches.length) selectPitch(myPitches[pi]);
    if (e.code.startsWith('Arrow') || ['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) mouse = null;
  });
  window.addEventListener('keyup', e => { keys[e.code] = false; });

  // =========================================================
  //  更新
  // =========================================================
  function update(dt, now) {
    const st = game.state;
    game.st += dt;

    if (canAim()) {
      const kx = ((keys.ArrowRight || keys.KeyD ? 1 : 0) - (keys.ArrowLeft || keys.KeyA ? 1 : 0)) * sideSign();
      const ky = (keys.ArrowUp || keys.KeyW ? 1 : 0) - (keys.ArrowDown || keys.KeyS ? 1 : 0);
      cursor.x = clamp(cursor.x + kx * 1.1 * dt, -0.7, 0.7);
      cursor.y = clamp(cursor.y + ky * 1.1 * dt, 0.15, 1.5);
      updateCursorFromMouse();
    }

    if (st === 'windup') {
      if (mode === 'pitch') {
        if (meter.acc === null && ringR(game.st) <= 0) lockMeter(true);
        if (game.st >= WINDUP) releasePlayerPitch(now);
      } else if (game.st >= WINDUP) releasePitch(now);
    } else if (st === 'pitch') {
      pitch.t = (now - pitch.t0) / 1000;
      const s = pitch.t / pitch.T;
      const cpu = pitch.cpu;
      if (cpu && cpu.swing && !pitch.swung && pitch.t >= cpu.Texp - SWING_LEAD) cpuSwing(now);
      if (!pitch.crossed && s >= 1) {
        pitch.crossed = true;
        pitch.cross = pitchPos(pitch, 1);
        pitch.inZone = inZone(pitch.cross[0], pitch.cross[1]);
        if (cpu) {
          if (cpu.swing) {
            if (!pitch.swung) cpuSwing(now);
            if (tryHit(pitch.cross, cpu.early, cpu.bat)) return;
          }
        } else if (pitch.swung && tryHit(pitch.cross, pitch.T - (pitch.swingT + HIT_LEAD))) return;
        if (!pitch.swung && hitsBatter(pitch.cross)) { startHBP(); return; }
      }
      ballPos = pitchPos(pitch, Math.min(s, pitch.sEnd));
      // バッティングでまだ振っていなければ、振り遅れの許容幅が終わるまで判定を待つ
      const lateEnd = pitch.T + D.win - HIT_LEAD;
      if (s >= pitch.sEnd && (mode !== 'bat' || pitch.swung || pitch.t >= lateEnd)) endPitch();
    } else if (st === 'hbp') {
      const v = pitch.vel;
      v[1] -= G * dt;
      ballPos = add(ballPos, mul(v, dt));
      if (ballPos[1] < BALL_R) { ballPos[1] = BALL_R; v[1] = Math.abs(v[1]) * 0.4; v[0] *= 0.7; v[2] *= 0.7; }
      if (game.st >= 0.8) endPitch();
    } else if (st === 'hitstop') {
      if (game.st >= 0.09) { game.state = 'play'; game.st = 0; }
    } else if (st === 'play') {
      const pl = play;
      pl.t += dt;
      for (const e of pl.events) if (!e.done && pl.t >= e.t) { e.done = true; e.fn(); }
      ballPos = playBallPos();
      ballTrail.push(ballPos.slice());
      if (ballTrail.length > 16) ballTrail.shift();
      updateFielders(dt);
      updateRunners(dt, pl.t);
      if (pl.t < pl.liveEnd) setLive(hdist(ballPos).toFixed(1) + ' m');
      else if (pl.kind === 'hr' || pl.liveEnd === 0) setLive('');
      if (pl.t >= pl.endT) finishPlay();
    } else if (st === 'between') {
      updateRunners(dt, game.st);
      for (const f of fielders) {
        const k = 1 - Math.exp(-4 * dt);
        f.x = lerp(f.x, f.hx, k); f.z = lerp(f.z, f.hz, k);
        f.moving = false; f.hasBall = false;
        f.face = Math.atan2(-f.hx, -f.hz);
      }
      if (game.st >= game.betweenDur) {
        settleRunners();
        updateHUD();
        const t = vs && vsTotals();
        if (vs && mode === 'pitch' && game.inning >= vsm.innings && t.cpu > t.me) { vsm.walkoff = true; gameOver(); }
        else if (vs && game.outs >= 3) endHalf();
        else if (game.outs >= 3 && mode === 'pitch' && game.inning < INNINGS) nextInning();
        else if (game.outs >= 3) gameOver();
        else startNext();
      }
    }

    // 剛速球は残像を長く引く
    if (ballPos && st === 'pitch') { ballTrail.push(ballPos.slice()); if (ballTrail.length > (PITCHES[pitch.name].heat ? 14 : 6)) ballTrail.shift(); }

    // キャッチャーミット（ピッチングでは狙ったコースに構える）
    const mt = pitch && st === 'pitch' ? pitchPos(pitch, pitch.sEnd)
      : mode === 'pitch' && (st === 'aim' || st === 'windup') ? [cursor.x, cursor.y, -0.9] : [0, 0.75, -0.9];
    catcherMitt = approach(catcherMitt, mt, 8, dt);

    // 紙吹雪
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.vy += 160 * dt; p.vx *= 0.99;
      p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt; p.life -= dt;
      if (p.life <= 0 || p.y > H + 20) particles.splice(i, 1);
    }
    flash = Math.max(0, flash - dt * 3);

    updateCamera(dt, now);
  }

  function startWindup() {
    game.state = 'windup'; game.st = 0;
    pitch = null; play = null; ballPos = null; ballTrail = []; lastCross = null;
    swingStart = -1; batterVisible = !practice;
    resetFielders(true);
  }

  function updateCamera(dt, now) {
    const st = game.state;
    let P, T, F, rp, rt;
    if (st === 'title' || st === 'over') {
      const a = now * 0.00007;
      P = [Math.sin(a) * 62, 30, 42 - Math.cos(a) * 62]; T = [0, 2, 45]; F = 0.85; rp = rt = 3;
    } else if (st === 'hitstop') {
      return;
    } else if (st === 'play') {
      const b = ballPos, pl = play;
      const hl = Math.hypot(b[0], b[2]);
      if (hl > 4) pl.camDir = [b[0] / hl, b[2] / hl];
      const d = pl.camDir;
      const back = 16 + Math.min(8, b[1] * 0.2);
      const chase = [b[0] - d[0] * back, clamp(b[1] * 0.85 + 5, 3, 40), b[2] - d[1] * back];
      const k = smooth(clamp((pl.t - 0.12) / 0.9, 0, 1));
      const hc = homeCam();
      P = mix(hc.pos, chase, k); T = b; F = lerp(hc.fs, 0.95, k);
      rp = 3.5; rt = lerp(14, 7, k);
    } else {
      const hc = homeCam();
      P = hc.pos; T = hc.tgt; F = hc.fs;
      const back = st === 'between';
      rp = back ? 2.6 : 9; rt = back ? 3.2 : 9;
    }
    cam.pos = approach(cam.pos, P, rp, dt);
    cam.tgt = approach(cam.tgt, T, rt, dt);
    cam.fs = lerp(cam.fs, F, 1 - Math.exp(-rp * dt));
    // スタンドの内側に制限
    const r = Math.hypot(cam.pos[0], cam.pos[2]);
    const th = Math.atan2(cam.pos[0], cam.pos[2]);
    const Rm = wallR(th) - 2.5;
    if (r > Rm) { cam.pos[0] *= Rm / r; cam.pos[2] *= Rm / r; }
    cam.pos[1] = clamp(cam.pos[1], 0.8, 40);
  }

  // =========================================================
  //  描画
  // =========================================================
  const SKIN = '#e9b48a';
  // under: アンダーシャツ, sock: ストッキング・文字色, team: 胸マーク, helmet: 打者・走者はヘルメット
  // 実在球団と似た配色を避ける（守備: ウォームグレー×深緑、打撃: アイボリー×紫）
  const DEF_COL = { shirt: '#c9c4b8', pants: '#c9c4b8', cap: '#0f6b5f', under: '#0c5a50', sock: '#0f6b5f', belt: '#083d36', team: 'BLAZE' };
  const BAT_COL = { shirt: '#f3ecdb', pants: '#f3ecdb', cap: '#55307a', under: '#55307a', sock: '#55307a', belt: '#3a1f56', team: 'STARS', helmet: true };
  const OUTLINE = 'rgba(16,22,38,0.9)', SHOE = '#1b1d22', GEAR = '#2c3446', HAIR = '#2a1d16';
  const UNI_NUM = { P: 18, C: 27, '1B': 3, '2B': 4, SS: 6, '3B': 5, LF: 7, CF: 8, RF: 9 };

  function poseJoints(pose, ph) {
    switch (pose) {
      case 'run': {
        const s = Math.sin(ph);
        return { fl: [-0.12, Math.max(0, s) * 0.18, -s * 0.42 + 0.05], fr: [0.12, Math.max(0, -s) * 0.18, s * 0.42 + 0.05], hip: [0, 0.92, 0], sh: [0, 1.42, 0.1], hl: [-0.26, 1.05, s * 0.3 + 0.05], hr: [0.26, 1.05, -s * 0.3 + 0.05], head: [0, 1.62, 0.14] };
      }
      case 'ready':
        return { fl: [-0.3, 0, 0], fr: [0.3, 0, 0], hip: [0, 0.8, -0.05], sh: [0, 1.27, 0.14], hl: [-0.2, 0.72, 0.38], hr: [0.2, 0.72, 0.38], head: [0, 1.47, 0.2] };
      case 'crouch':
        return { fl: [-0.32, 0, 0.1], fr: [0.32, 0, 0.1], hip: [0, 0.52, -0.15], sh: [0, 0.98, 0], hl: [-0.2, 0.75, 0.3], hr: [0.18, 0.7, 0.2], head: [0, 1.16, 0.05] };
      default:
        return { fl: [-0.14, 0, 0], fr: [0.14, 0, 0], hip: [0, 0.95, 0], sh: [0, 1.45, 0], hl: [-0.24, 0.96, 0.06], hr: [0.24, 0.96, 0.06], head: [0, 1.64, 0] };
    }
  }
  function pitcherJoints(mode, p) {
    const J = poseJoints('stand');
    if (mode === 'set') { J.hl = [-0.05, 1.25, 0.18]; J.hr = [0.05, 1.25, 0.18]; }
    else if (mode === 'wind') {
      if (p < 0.35) {
        const u = smooth(p / 0.35);
        J.fl = [-0.15, 0.55 * u, 0.15 * u];
        J.hl = [-0.05, 1.25 + 0.1 * u, 0.18]; J.hr = [0.05, 1.25 + 0.1 * u, 0.18];
        J.hip = [0, 0.95, -0.05 * u];
      } else if (p < 0.75) {
        const u = smooth((p - 0.35) / 0.4);
        J.fl = [lerp(-0.15, -0.22, u), lerp(0.55, 0, u), lerp(0.15, 0.95, u)];
        J.hr = mix([0.05, 1.35, 0.18], [0.6, 1.55, -0.55], u);
        J.hl = mix([-0.05, 1.35, 0.18], [-0.35, 1.35, 0.5], u);
        J.hip = [0, lerp(0.95, 0.82, u), lerp(-0.05, 0.25, u)];
        J.sh = [0, lerp(1.45, 1.35, u), lerp(0, 0.2, u)];
        J.head = [0, lerp(1.64, 1.55, u), lerp(0, 0.22, u)];
      } else {
        const u = (p - 0.75) / 0.25;
        const a = [0.6, 1.55, -0.55], b = [0.5, 2.05, 0.1], c = [0.4, 1.85, 0.85];
        J.hr = u < 0.5 ? mix(a, b, u * 2) : mix(b, c, (u - 0.5) * 2);
        J.fl = [-0.22, 0, 0.95]; J.hl = [-0.3, 1.1, 0.4];
        J.hip = [0, 0.82, 0.3]; J.sh = [0, 1.35, 0.35]; J.head = [0, 1.55, 0.42];
      }
    } else if (mode === 'follow') {
      J.fl = [-0.22, 0, 0.95]; J.fr = [0.2, 0.25, -0.3];
      J.hr = [-0.25, 0.95, 0.75]; J.hl = [-0.35, 1.0, 0.1];
      J.hip = [0, 0.8, 0.35]; J.sh = [0, 1.25, 0.6]; J.head = [0, 1.42, 0.72];
    }
    return J;
  }

  function drawPerson(o) {
    const s = Math.sin(o.face), c = Math.cos(o.face);
    const toW = l => [o.x + c * l[0] + s * l[2], l[1], o.z - s * l[0] + c * l[2]];
    const J = o.J;
    const w = {};
    for (const k in J) w[k] = toW(J[k]);
    if (o.ovW) for (const k in o.ovW) w[k] = o.ovW[k];
    const hipL = toW(add(J.hip, [-0.11, 0, 0])), hipR = toW(add(J.hip, [0.11, 0, 0]));
    const knee = (h, f) => toW([(h[0] + f[0]) / 2, (J.hip[1] + f[1]) / 2 + 0.03, (J.hip[2] + f[2]) / 2 + 0.13]);
    const kneeL = knee([-0.11], J.fl), kneeR = knee([0.11], J.fr);
    const shL = toW(add(J.sh, [-0.19, -0.04, 0])), shR = toW(add(J.sh, [0.19, -0.04, 0]));
    const col = o.col, fwd = [s, 0, c], rgt = [c, 0, -s];
    // ひじ: 肩と手の距離が腕の長さより短ければ、外側・下側へ曲げる
    const ARM = 0.3;
    const elbow = (sh, h) => {
      const v = sub(h, sh), d = Math.hypot(v[0], v[1], v[2]) || 1e-6, u = mul(v, 1 / d);
      const out = add(sub(sh, w.sh), [0, -0.25, 0]);
      const perp = sub(out, mul(u, dot(out, u)));
      const pl = Math.hypot(perp[0], perp[1], perp[2]) || 1e-6;
      return add(mix(sh, h, 0.5), mul(perp, Math.sqrt(Math.max(0, ARM * ARM - d * d / 4)) / pl));
    };
    const elL = elbow(shL, w.hl), elR = elbow(shR, w.hr);
    // すね: 膝下の 45% まではパンツ、その先はストッキング
    const shinL = mix(kneeL, w.fl, 0.45), shinR = mix(kneeR, w.fr, 0.45);
    const toe = f => add(f, add(mul(fwd, 0.13), [0, 0.03, 0]));
    const chest = mix(w.hip, w.sh, 0.55);
    const cc = toCam(chest);
    if (cc[2] <= NEAR) return;
    // 近くの選手だけ輪郭線や顔・文字を描く（遠くでは黒くつぶれるため）
    const big = cam.f * 0.3 / cc[2] > 7;
    const view = norm(sub(cam.pos, chest)), facing = dot(fwd, view);
    const sees = d => dot(norm(d), view) > 0.12;
    const loc = l => toW(add(J.hip, l));   // 腰からの相対位置
    const catcher = o.mitt;
    ctx.globalAlpha = o.alpha == null ? 1 : o.alpha;

    const draw = segs => {
      if (big) for (const g of segs) limb(g[0], g[1], g[2] + 0.035, OUTLINE);
      for (const g of segs) limb(g[0], g[1], g[2], g[3]);
    };
    const dot2 = (p, r, fill, line = big) => {
      const pc = toCam(p);
      if (pc[2] <= NEAR) return null;
      const ps = proj(pc), pr = Math.max(1, cam.f * r / pc[2]);
      if (line) { ctx.fillStyle = OUTLINE; ctx.beginPath(); ctx.arc(ps[0], ps[1], pr + cam.f * 0.018 / pc[2], 0, PI * 2); ctx.fill(); }
      ctx.fillStyle = fill;
      ctx.beginPath(); ctx.arc(ps[0], ps[1], pr, 0, PI * 2); ctx.fill();
      return [ps, pr];
    };
    const poly = (pts, fill) => {
      if (!polyPath(pts)) return;
      ctx.fillStyle = fill; ctx.fill();
      if (big) { ctx.strokeStyle = OUTLINE; ctx.lineWidth = Math.max(1, cam.f * 0.016 / cc[2]); ctx.stroke(); }
    };
    // 体の表面に貼る文字（左右の端を投影して、遠近と向きに合わせて伸縮）
    const decal = (ctr, hw, h, text, fill, stroke) => {
      const a = toCam(add(ctr, mul(rgt, hw))), b = toCam(sub(ctr, mul(rgt, hw)));
      if (a[2] <= NEAR || b[2] <= NEAR) return;
      let p1 = proj(a), p2 = proj(b);
      if (p2[0] < p1[0]) [p1, p2] = [p2, p1];
      const wpx = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      if (wpx < 6) return;
      const fs = cam.f * h / ((a[2] + b[2]) / 2);
      ctx.save();
      ctx.translate((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2);
      ctx.rotate(Math.atan2(p2[1] - p1[1], p2[0] - p1[0]));
      ctx.font = `900 ${fs}px "Arial Black", Impact, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.scale(wpx / ctx.measureText(text).width, 1);
      if (stroke) { ctx.lineWidth = fs * 0.16; ctx.strokeStyle = stroke; ctx.strokeText(text, 0, 0); }
      ctx.fillStyle = fill; ctx.fillText(text, 0, 0);
      ctx.restore();
    };

    // ---- 脚（捕手はレガース） ----
    const legs = [[w.fl, toe(w.fl), 0.1, SHOE], [w.fr, toe(w.fr), 0.1, SHOE],
      [hipL, kneeL, 0.14, col.pants], [hipR, kneeR, 0.14, col.pants]];
    if (catcher) legs.push([kneeL, w.fl, 0.13, GEAR], [kneeR, w.fr, 0.13, GEAR]);
    else legs.push([kneeL, shinL, 0.12, col.pants], [shinL, w.fl, 0.095, col.sock],
      [kneeR, shinR, 0.12, col.pants], [shinR, w.fr, 0.095, col.sock]);
    draw(legs);

    // ---- 腕（カメラから見て胴体の奥にある腕は先に描く） ----
    const arm = (sh, el, h, left) => ({
      z: toCam(el)[2],
      draw() {
        draw([[sh, el, 0.095, col.shirt], [el, h, 0.075, col.under]]);
        if (left && o.glove) {
          const r = o.mitt ? 0.13 : 0.095;
          dot2(h, r, '#8a5427');
          dot2(add(h, [0, 0.01, 0]), r * 0.62, '#a8693a', false);   // 革の明るい面
          dot2(add(h, [0, 0.01, 0]), r * 0.22, '#6a3d1c', false);   // ポケット
        } else if (!left && o.ball) {
          dot2(h, 0.04, '#fff');
        } else dot2(h, 0.045, o.bat ? col.under : SKIN);   // 打者は手袋
      },
    });
    const arms = [arm(shL, elL, w.hl, true), arm(shR, elR, w.hr, false)].sort((a, b) => b.z - a.z);
    const back = arms.filter(a => a.z > cc[2] + 0.04), front = arms.filter(a => a.z <= cc[2] + 0.04);
    for (const a of back) a.draw();

    // ---- 胴体 ----
    const bz = 0.06;
    draw([[loc([0, 0.1, 0]), chest, 0.28, col.shirt], [chest, w.sh, 0.32, col.shirt], [shL, shR, 0.12, col.shirt], [w.sh, w.head, 0.08, SKIN]]);
    // 腰（パンツ）でシャツの裾を隠す
    draw([[loc([-0.06, 0, 0]), loc([0.06, 0, 0]), 0.17, col.pants]]);
    // ベルト（腰回りの帯）
    if (big) limb(loc([-0.14, bz, 0]), loc([0.14, bz, 0]), 0.07, OUTLINE);
    limb(loc([-0.13, bz, 0]), loc([0.13, bz, 0]), 0.045, col.belt);
    const torsoUp = mix(J.hip, J.sh, 0.62);
    const surf = (z, y = 0) => toW(add(torsoUp, [0, y, z]));
    if (catcher && facing > 0) {
      // プロテクター
      poly([loc([-0.15, 0.12, 0.15]), loc([0.15, 0.12, 0.15]), toW(add(J.sh, [0.17, -0.03, 0.12])), toW(add(J.sh, [-0.17, -0.03, 0.12]))], GEAR);
    } else if (big && facing > 0.2) {
      // 前立てのパイピングと胸マーク
      limb(toW(add(J.sh, [0, -0.02, 0.15])), loc([0, bz + 0.03, 0.15]), 0.012, col.sock);
      decal(surf(0.165, 0.02), 0.13, 0.085, col.team, col.sock, 'rgba(255,255,255,0.9)');
    } else if (big && facing < -0.2 && o.num != null) {
      // 背番号
      decal(surf(-0.165, 0.04), 0.07 + 0.035 * String(o.num).length, 0.17, String(o.num), col.sock, OUTLINE);
    }

    // ---- 頭 ----
    const hw = w.head;
    // 耳は頭の前に描くと顔に重なるので先に描く。ヘルメットのイヤーフラップ（投手側=左）は後で上から描く
    const flapSide = col.helmet && !catcher ? -1 : 0;
    const ear = sgn => {
      const d = mul(rgt, sgn);
      if (!big || !sees(d)) return;
      if (sgn === flapSide) return;
      dot2(add(hw, add(mul(d, 0.105), [0, -0.01, 0])), 0.03, SKIN);
    };
    const flap = () => {
      const d = mul(rgt, flapSide);
      if (!flapSide || !sees(add(d, mul(fwd, 0.3)))) return;
      dot2(add(hw, add(add(mul(d, 0.08), mul(fwd, 0.01)), [0, -0.025, 0])), 0.068, col.cap);
    };
    // つば（後ろ向きのときは頭の陰に隠れるので先に描く）
    const brim = () => {
      if (catcher) return;
      const by = col.helmet ? 0.035 : 0.055, near = col.helmet ? 0.09 : 0.07, far = col.helmet ? 0.17 : 0.21;
      const at = (f, r, y) => add(hw, add(add(mul(fwd, f), mul(rgt, r)), [0, y, 0]));
      poly([at(near, -0.105, by), at(near, 0.105, by), at(far, 0.075, by - 0.02), at(far, -0.075, by - 0.02)], col.cap);
    };
    if (facing < 0) brim();
    ear(1); ear(-1);
    const hd = dot2(hw, 0.115, SKIN);
    if (hd) {
      const [hs, hr] = hd;
      // 横・後ろから見ると髪が見える
      if (big && facing < 0.4 && !col.helmet) {
        ctx.save();
        ctx.beginPath(); ctx.arc(hs[0], hs[1], hr, 0, PI * 2); ctx.clip();
        // 後頭部の方向へずらした楕円を頭の形で切り抜く（下端は丸く、襟足は肌を見せる）
        const bc = toCam(add(hw, mul(fwd, -0.07)));
        const bp = bc[2] > NEAR ? proj(bc) : hs;
        ctx.fillStyle = HAIR;
        ctx.beginPath(); ctx.ellipse(bp[0], hs[1] - hr * 0.3, hr * 0.92, hr * 0.85, 0, 0, PI * 2); ctx.fill();
        ctx.restore();
      }
      // 目（顔がこちらを向いているときだけ）
      if (big && facing > 0.1) {
        ctx.fillStyle = '#1d1a1f';
        for (const sg of [-1, 1]) {
          const ed = add(mul(fwd, 0.9), mul(rgt, 0.42 * sg));
          if (!sees(ed)) continue;
          const ec = toCam(add(hw, add(add(mul(fwd, 0.1), mul(rgt, 0.04 * sg)), [0, -0.005, 0])));
          if (ec[2] <= NEAR) continue;
          const es = proj(ec), er = cam.f * 0.016 / ec[2];
          ctx.beginPath(); ctx.ellipse(es[0], es[1], er * 0.8, er * 1.15, 0, 0, PI * 2); ctx.fill();
        }
        // 頬の赤み
        ctx.fillStyle = 'rgba(230,110,90,0.22)';
        for (const sg of [-1, 1]) {
          if (!sees(add(fwd, mul(rgt, 0.8 * sg)))) continue;
          const kc = toCam(add(hw, add(add(mul(fwd, 0.085), mul(rgt, 0.06 * sg)), [0, -0.04, 0])));
          if (kc[2] <= NEAR) continue;
          const ks = proj(kc);
          ctx.beginPath(); ctx.arc(ks[0], ks[1], cam.f * 0.022 / kc[2], 0, PI * 2); ctx.fill();
        }
      }
      // 帽子・ヘルメットのドーム
      const cr = col.helmet || catcher ? 1.16 : 1.06, cy = hs[1] - hr * (col.helmet || catcher ? 0.04 : 0.14);
      ctx.fillStyle = catcher ? GEAR : col.cap;
      ctx.beginPath(); ctx.arc(hs[0], cy, hr * cr, PI, 0); ctx.closePath(); ctx.fill();
      if (big) { ctx.strokeStyle = OUTLINE; ctx.lineWidth = Math.max(1, hr * 0.12); ctx.stroke(); }
      ctx.fillStyle = 'rgba(255,255,255,0.28)';   // つや
      ctx.beginPath(); ctx.ellipse(hs[0] - hr * 0.38, cy - hr * 0.6, hr * 0.3, hr * 0.13, -0.45, 0, PI * 2); ctx.fill();
      // 帽子のマーク
      if (big && !col.helmet && !catcher && facing > 0.3) {
        ctx.fillStyle = '#fff';
        ctx.font = `900 ${hr * 0.62}px "Arial Black", sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(col.team[0], hs[0], cy - hr * 0.45);
      }
      // 捕手のマスク
      if (catcher && facing > 0.2 && big) {
        ctx.strokeStyle = '#2b2f38'; ctx.lineWidth = Math.max(1, hr * 0.12);
        ctx.beginPath(); ctx.roundRect(hs[0] - hr * 0.8, hs[1] - hr * 0.35, hr * 1.6, hr * 1.25, hr * 0.4); ctx.stroke();
        ctx.beginPath();
        for (const k of [0.15, 0.5]) { ctx.moveTo(hs[0] - hr * 0.8, hs[1] + hr * k); ctx.lineTo(hs[0] + hr * 0.8, hs[1] + hr * k); }
        ctx.moveTo(hs[0], hs[1] - hr * 0.35); ctx.lineTo(hs[0], hs[1] + hr * 0.9);
        ctx.stroke();
      }
    }
    flap();
    if (facing >= 0) brim();

    for (const a of front) a.draw();
    ctx.globalAlpha = 1;
  }

  // バットの姿勢
  function batPose() {
    const READY_H = [-0.72, 1.3, -0.22], READY_D = norm([0.25, 0.85, -0.45]);
    if (swingStart < 0) return { h: READY_H, d: READY_D, p: 0 };
    const p = (performance.now() - swingStart) / 300;
    const cy = clamp(swingCY, 0.3, 1.4);
    const CONTACT_H = [-0.52, cy + 0.03, 0.02];
    const FINISH_H = [-0.72, 1.35, 0.22];
    const vy0 = clamp((cy - 1.15) * 0.7, -0.5, 0.05);
    const planar = (th, vy) => norm([Math.cos(th), vy, Math.sin(th)]);
    if (p < 0.4) {
      const u = p / 0.4, e = u * u;
      const th = lerp(-150, 0, e) * DEG;
      return { h: mix(READY_H, CONTACT_H, smooth(u)), d: norm(mix(READY_D, planar(th, vy0), smooth(u))), p };
    }
    const u = clamp((p - 0.4) / 0.6, 0, 1);
    return { h: mix(CONTACT_H, FINISH_H, smooth(u)), d: planar(lerp(0, 165, smooth(u)) * DEG, lerp(vy0, 0.45, u)), p };
  }
  function drawBatter() {
    const bp = batPose();
    const sw = clamp(bp.p, 0, 1);
    const J = {
      fl: [-0.4, 0, 0.05], fr: [0.38, 0, 0],
      hip: [-0.08 * sw, 0.88, -0.05], sh: [-0.1 * sw, 1.38, -0.02],
      hl: [0, 0, 0], hr: [0, 0, 0], head: [-0.04 - 0.08 * sw, 1.58, 0.02],
    };
    drawPerson({ x: BATTER_X, z: 0, face: PI / 2, J, col: BAT_COL, ovW: { hl: bp.h, hr: bp.h }, bat: true, num: mode === 'pitch' ? game.batter % LINEUP.length + 1 : 51 });
    const mid = add(bp.h, mul(bp.d, 0.42)), tip = add(bp.h, mul(bp.d, 0.86));
    limb(bp.h, mid, 0.035, '#c9995e');
    limb(mid, tip, 0.065, '#d9b07a');
  }

  function drawBall() {
    if (!ballPos) return;
    if (ballTrail.length > 1) {
      const heat = game.state === 'pitch' && pitch && PITCHES[pitch.name].heat;
      for (let i = 1; i < ballTrail.length; i++) {
        const a = toCam(ballTrail[i - 1]), b = toCam(ballTrail[i]);
        if (a[2] < NEAR || b[2] < NEAR) continue;
        const sa = proj(a), sb = proj(b);
        const k = i / ballTrail.length;
        ctx.strokeStyle = heat ? `rgba(140,215,255,${k * 0.8})` : `rgba(255,255,255,${k * 0.45})`;
        ctx.lineWidth = Math.max(1.5, cam.f * BALL_R * (heat ? 2.2 : 1.6) / b[2]);
        ctx.beginPath(); ctx.moveTo(sa[0], sa[1]); ctx.lineTo(sb[0], sb[1]); ctx.stroke();
      }
    }
    const c = toCam(ballPos);
    if (c[2] < NEAR) return;
    const s = proj(c), r = Math.max(2.2, cam.f * BALL_R / c[2]);
    const g = ctx.createRadialGradient(s[0] - r * 0.3, s[1] - r * 0.3, r * 0.1, s[0], s[1], r);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.7, '#f1efe8'); g.addColorStop(1, '#b9b4a8');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(s[0], s[1], r, 0, PI * 2); ctx.fill();
    if (r > 6) {
      ctx.strokeStyle = '#d23b3b'; ctx.lineWidth = Math.max(1, r * 0.12);
      ctx.beginPath(); ctx.arc(s[0] - r * 0.9, s[1], r * 0.7, -0.9, 0.9); ctx.stroke();
      ctx.beginPath(); ctx.arc(s[0] + r * 0.9, s[1], r * 0.7, PI - 0.9, PI + 0.9); ctx.stroke();
    }
    if (r < 4 && game.state === 'play') {
      ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(s[0], s[1], r + 5, 0, PI * 2); ctx.stroke();
    }
  }

  function drawZone() {
    const { x0, x1, y0, y1 } = ZONE;
    const q = [[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0]];
    if (polyPath(q)) {
      ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
      const x = lerp(x0, x1, i / 3), y = lerp(y0, y1, i / 3);
      for (const [a, b] of [[[x, y0, 0], [x, y1, 0]], [[x0, y, 0], [x1, y, 0]]]) {
        const ca = toCam(a), cb = toCam(b);
        if (ca[2] < NEAR || cb[2] < NEAR) continue;
        const sa = proj(ca), sb = proj(cb);
        ctx.beginPath(); ctx.moveTo(sa[0], sa[1]); ctx.lineTo(sb[0], sb[1]); ctx.stroke();
      }
    }
    if (lastCross && lastCross.p && game.state === 'between') {
      const pts = [];
      for (let i = 0; i < 20; i++) { const a = i / 20 * PI * 2; pts.push([lastCross.p[0] + Math.cos(a) * BALL_R * 1.2, lastCross.p[1] + Math.sin(a) * BALL_R * 1.2, 0]); }
      if (polyPath(pts)) { ctx.strokeStyle = lastCross.strike ? '#ffd84a' : '#5fe07a'; ctx.lineWidth = 2.5; ctx.stroke(); }
    }
  }
  function drawCursor() {
    const x0 = cursor.x - D.rx, x1 = cursor.x + D.rx, y0 = cursor.y - D.ry, y1 = cursor.y + D.ry;
    if (polyPath([[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0]])) {
      ctx.fillStyle = 'rgba(255,216,40,0.16)'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,216,40,0.95)'; ctx.lineWidth = 2.5; ctx.stroke();
    }
    const cc = toCam([cursor.x, cursor.y, 0]);
    if (cc[2] < NEAR) return;
    const c = proj(cc);
    const r = cam.f * D.ry * 0.5 / cc[2];
    ctx.strokeStyle = 'rgba(255,240,150,0.9)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(c[0], c[1], r, 0, PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(c[0] - r * 1.8, c[1]); ctx.lineTo(c[0] - r * 0.6, c[1]);
    ctx.moveTo(c[0] + r * 0.6, c[1]); ctx.lineTo(c[0] + r * 1.8, c[1]);
    ctx.stroke();
  }

  function zoneCircle(x, y, r, n = 40) {
    const pts = [];
    for (let i = 0; i < n; i++) { const a = i / n * PI * 2; pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r, 0]); }
    return polyPath(pts);
  }
  // ピッチング: 狙いの的・予想軌道・コントロールリング
  function drawAim() {
    const st = game.state;
    if (st === 'aim') {
      const p = idealPitch(selPitch);
      ctx.setLineDash([3, 5]);
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i <= 30; i++) {
        const c = toCam(pitchPos(p, i / 30));
        if (c[2] < NEAR) continue;
        const s = proj(c);
        if (started) ctx.lineTo(s[0], s[1]); else { ctx.moveTo(s[0], s[1]); started = true; }
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const g = meter && meter.acc !== null ? meter.grade : '';
    const col = g === 'PERFECT' ? '#6fe8ff' : g === 'GOOD' ? '#5fe07a' : g === 'BAD' ? '#ff6464' : 'rgba(255,216,40,0.95)';
    if (zoneCircle(cursor.x, cursor.y, RING_HIT)) {
      ctx.fillStyle = 'rgba(255,216,40,0.2)'; ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.stroke();
    }
    const cc = toCam([cursor.x, cursor.y, 0]);
    if (cc[2] > NEAR) {
      const c = proj(cc), r = Math.max(5, cam.f * RING_HIT / cc[2]);
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(c[0] - r - 9, c[1]); ctx.lineTo(c[0] - r - 2, c[1]);
      ctx.moveTo(c[0] + r + 2, c[1]); ctx.lineTo(c[0] + r + 9, c[1]);
      ctx.moveTo(c[0], c[1] - r - 9); ctx.lineTo(c[0], c[1] - r - 2);
      ctx.moveTo(c[0], c[1] + r + 2); ctx.lineTo(c[0], c[1] + r + 9);
      ctx.stroke();
    }
    if (st === 'windup' && meter && meter.acc === null && game.st >= 0.1) {
      const r = ringR(game.st);
      if (r > 0 && zoneCircle(cursor.x, cursor.y, r)) { ctx.strokeStyle = 'rgba(255,140,60,0.95)'; ctx.lineWidth = 3; ctx.stroke(); }
    }
  }

  function drawGround() {
    fillPoly(GEO.outline, '#3c8a3a');
    for (const s of GEO.stripes) fillPoly(s, '#47993f');
    fillPoly(GEO.track, '#b5865a');
    fillPoly(GEO.dirt, '#c4935f');
    fillPoly(GEO.infieldGrass, '#46963e');
    fillPoly(GEO.homeDirt, '#c4935f');
    fillPoly(GEO.mound, '#c99a66');
    fillPoly(GEO.rubber, '#f4f4f0');
    for (const l of GEO.lines) fillPoly(l, 'rgba(250,250,245,0.92)');
    fillPoly(GEO.plate, '#fafaf5');
    for (const b of GEO.bases) fillPoly(b, '#fafaf5');
  }
  const farSorted = [];
  function drawFar() {
    if (!farSorted.length) farSorted.push(...GEO.far);
    const p = cam.pos;
    for (const q of farSorted) { const c = q.c; q.d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2; }
    farSorted.sort((a, b) => b.d - a.d);
    ctx.lineWidth = 1;
    for (const q of farSorted) {
      if (q.pole) { limb(q.a, q.b, 0.35, q.color); continue; }
      if (!polyPath(q.pts)) continue;
      ctx.fillStyle = q.color; ctx.fill();
      if (q.seam) { ctx.strokeStyle = q.color; ctx.lineWidth = 1; ctx.stroke(); }
      if (q.top) limb(q.pts[3], q.pts[2], 0.25, q.top);
    }
  }

  function render() {
    updateBasis();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#2b67bd'); sky.addColorStop(0.55, '#86bff0'); sky.addColorStop(1, '#d6edfc');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);

    drawGround();
    drawFar();

    const st = game.state;
    const batting = st === 'aim' || st === 'windup' || st === 'pitch' || st === 'hbp' || st === 'between' || st === 'hitstop';

    // 投球練習はブルペンのイメージで投手と捕手だけ
    const crew = practice && st !== 'title' ? fielders.slice(0, 2) : fielders;

    // 影
    for (const f of crew) groundEllipse(f.x, f.z, 0.45, 'rgba(0,0,0,0.25)');
    for (const r of runners) { const p = runnerPos(r.b); groundEllipse(p[0], p[2], 0.45, 'rgba(0,0,0,0.25)'); }
    if (ballPos && st !== 'pitch') {
      const a = clamp(0.45 - ballPos[1] * 0.006, 0.12, 0.45);
      groundEllipse(ballPos[0], ballPos[2], 0.14 + Math.min(0.6, ballPos[1] * 0.004), `rgba(0,0,0,${a})`);
    }

    // 奥から手前に並べて描画
    const objs = [];
    const push = (p, fn) => { const c = toCam(p); if (c[2] > NEAR) objs.push({ d: c[2], fn }); };

    crew.forEach((f, i) => {
      let J, alpha = 1, glove = true, mitt = false, ovW = null, ball = false;
      if (i === 0 && (st === 'aim' || st === 'windup' || st === 'pitch' || st === 'hbp' || st === 'hitstop' || (st === 'play' && play.t < f.re))) {
        J = st === 'aim' ? pitcherJoints('set')
          : st === 'windup' ? pitcherJoints(game.st < 0.25 ? 'set' : 'wind', clamp((game.st - 0.25) / (WINDUP - 0.25), 0, 1)) : pitcherJoints('follow');
        ball = st === 'windup' || st === 'aim';
      } else if (i === 1 && batting) {
        // 打席視点ではキャッチャーの体がゾーンに重なるのでミットだけ描く
        if (cam.pos[2] < 0) {
          push(catcherMitt, () => {
            const c = toCam(catcherMitt);
            if (c[2] < NEAR) return;
            const s = proj(c);
            ctx.fillStyle = 'rgba(122,74,34,0.55)';
            ctx.beginPath(); ctx.arc(s[0], s[1], cam.f * 0.13 / c[2], 0, PI * 2); ctx.fill();
          });
          return;
        }
        J = poseJoints('crouch'); mitt = true;
        ovW = { hl: catcherMitt };
      } else if (f.moving) J = poseJoints('run', f.phase);
      else if (st === 'play' || st === 'between') J = poseJoints('stand');
      else J = poseJoints('ready');
      if (f.hasBall) ball = true;
      push([f.x, 1, f.z], () => drawPerson({ x: f.x, z: f.z, face: f.face, J, col: DEF_COL, alpha, glove, mitt, ovW, ball, num: UNI_NUM[f.id] }));
    });

    for (const r of runners) {
      if (r.out && st === 'between') continue;
      const p = runnerPos(r.b);
      const i = clamp(Math.floor(r.b), 0, 3);
      const nb = BASES[Math.min(i + 1, 4)], pb = BASES[i];
      const face = Math.atan2(nb[0] - pb[0], nb[2] - pb[2]);
      const moving = r.b < r.target && (st === 'play' || st === 'between');
      const J = moving ? poseJoints('run', r.b * 27.43 * 2.4) : poseJoints('stand');
      push([p[0], 1, p[2]], () => drawPerson({ x: p[0], z: p[2], face, J, col: BAT_COL }));
    }

    if (batterVisible && st !== 'title' && st !== 'over') push([BATTER_X, 1, 0], drawBatter);
    if (batting) push([0, 0.78, 0], drawZone);
    if (ballPos) push(ballPos, drawBall);

    objs.sort((a, b) => b.d - a.d);
    for (const o of objs) o.fn();

    if (mode === 'bat' && (st === 'windup' || st === 'pitch')) drawCursor();
    if (mode === 'pitch' && (st === 'aim' || st === 'windup')) drawAim();

    // 紙吹雪
    for (const p of particles) {
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(p.r);
      ctx.fillStyle = p.c;
      ctx.globalAlpha = clamp(p.life, 0, 1);
      ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      ctx.restore();
    }
    if (flash > 0) { ctx.fillStyle = `rgba(255,255,255,${flash * 0.5})`; ctx.fillRect(0, 0, W, H); }
  }

  function confetti() {
    const cols = ['#ffd43a', '#ff5a5a', '#5fe07a', '#6fc8ff', '#ffffff', '#ff9a3a'];
    for (let i = 0; i < 180; i++) {
      particles.push({ x: rand(0, W), y: rand(-H * 0.3, -10), vx: rand(-60, 60), vy: rand(40, 180), r: rand(0, PI), vr: rand(-8, 8), c: cols[i % cols.length], s: rand(6, 12), life: rand(2.5, 4.5) });
    }
  }

  // =========================================================
  //  ゲーム進行
  // =========================================================
  function resetGame() {
    Object.assign(game, { outs: 0, balls: 0, strikes: 0, runs: 0, hits: 0, hrs: 0, best: 0, inning: 1, ks: 0, bb: 0, pitches: 0, batter: 0 });
    runners = []; pitch = null; play = null; ballPos = null; ballTrail = [];
    $('pitchInfo').classList.remove('show');
    batterVisible = !practice; swingStart = -1;
    stamina = 100; meter = null;
    Object.assign(prac, { strikes: 0, perfect: 0, best: 0, miss: 0 });
    cpuMem.kmh = 146; cpuMem.last = '';
    $('pitchSel').classList.add('lock');
    $('pSpeed').textContent = '';
    resetFielders(true);
    cursor.x = 0; cursor.y = 0.78;
    updateHUD();
  }
  function applyModeUI() {
    const P = mode === 'pitch', touch = document.body.classList.contains('touch');
    document.body.classList.toggle('pmode', P);
    document.body.classList.toggle('practice', practice);
    document.body.classList.toggle('vs', vs);
    $('help').textContent = practice
      ? 'マウスで狙う ／ クリックで投球 → リングが的に重なる瞬間にもう一度クリック ／ 1〜0・-・^・¥・@・[・;キーで球種 ／ Escで終了'
      : P ? 'マウスで狙う ／ クリックで投球 → 縮むリングが的に重なる瞬間にもう一度クリック ／ 1〜6キーで球種'
      : touch ? '画面をなぞってカーソル移動 ／ ボタンでスイング' : 'マウスでカーソル移動 ／ クリック・スペースでスイング';
    $('swingBtn').textContent = P ? '投げる' : 'スイング';
    $('runsLbl').textContent = vs ? '自分-CPU' : practice ? '球数' : P ? '失点' : '得点';
  }
  // ピッチャー視点の変化方向（+x は画面左）
  function pitchArrow(n) {
    const d = PITCHES[n], by = d.by + (d.drop || 0);
    return d.knuckle ? '?' : Math.hypot(d.bx, by) < 0.15 ? '●'
      : `<span class="arw" style="transform:rotate(${Math.round(Math.atan2(-by, -d.bx) / DEG)}deg)">→</span>`;
  }
  function buildPitchButtons() {
    myPitches = practice ? P_TYPES.slice() : P_TYPES.filter(n => n === 'ストレート' || arsenal.includes(n));
    $('pitchBtns').innerHTML = myPitches.map((n, i) =>
      `<button data-p="${n}"><i>${P_KEYS[i]}</i>${pitchArrow(n)}<span class="pc-only">${n}</span><span class="touch-only">${P_SHORT[n] || n}</span></button>`
    ).join('');
    document.querySelectorAll('#pitchBtns button').forEach(b => b.addEventListener('click', () => selectPitch(b.dataset.p)));
    selectPitch(myPitches.includes(selPitch) ? selPitch : myPitches[0]);
  }

  // ---- 試合前の持ち球選択 ----
  let picking = [];
  function renderArsenal() {
    const full = picking.length >= ARSENAL_SIZE;
    $('arsList').innerHTML = P_TYPES.filter(n => P_DESC[n]).map(n => {
      const on = picking.includes(n);
      return `<button class="ars${on ? ' sel' : ''}${full && !on ? ' off' : ''}" data-p="${n}">
        <span class="ars-head">${pitchArrow(n)}<b>${n}</b><em>${Math.round(P_VMAX * PITCHES[n].sp * 0.975)}km/h</em></span>
        <small>${P_DESC[n]}</small></button>`;
    }).join('');
    $('arsCount').textContent = `${picking.length} / ${ARSENAL_SIZE}`;
    $('arsGo').disabled = !full;
  }
  $('arsList').addEventListener('click', e => {
    const b = e.target.closest('button.ars');
    if (!b) return;
    const n = b.dataset.p, i = picking.indexOf(n);
    if (i >= 0) picking.splice(i, 1);
    else if (picking.length < ARSENAL_SIZE) picking.push(n);
    renderArsenal();
  });
  function openArsenal() {
    picking = arsenal.slice();
    renderArsenal();
    $('title').classList.add('hidden');
    $('arsenal').classList.remove('hidden');
  }
  $('arsGo').addEventListener('click', () => {
    if (picking.length !== ARSENAL_SIZE) return;
    arsenal = picking.slice();
    try { localStorage.setItem(ARSENAL_KEY, JSON.stringify(arsenal)); } catch (e) { /* 保存できなくても続行 */ }
    buildPitchButtons();
    startGame();
  });
  $('arsBack').addEventListener('click', () => {
    $('arsenal').classList.add('hidden');
    $('title').classList.remove('hidden');
  });

  function startGame() {
    ac();
    if (vs) {
      mode = 'bat';
      Object.assign(vsm, { line: { me: [], cpu: [] }, saved: {}, skip: false, walkoff: false });
    }
    D = (mode === 'pitch' ? PDIFFS : DIFFS)[selDiff];
    applyModeUI();
    if (mode === 'pitch' || vs) buildPitchButtons();
    resetGame();
    $('title').classList.add('hidden');
    $('arsenal').classList.add('hidden');
    $('over').classList.add('hidden');
    $('hud').classList.remove('hidden');
    document.body.classList.add('playing');
    if (vs) startHalf(); else toBetween(1.8);
  }
  function gameOver() {
    game.state = 'over';
    document.body.classList.remove('playing');
    const P = mode === 'pitch';
    $('ovLbl').textContent = practice ? '投球数' : P ? '失点' : '得点';
    $('ovRuns').textContent = practice ? game.pitches : game.runs;
    $('ovUnit').textContent = practice ? '球' : '点';
    const n = game.pitches || 1;
    const rows = practice
      ? [['ストライク率', game.pitches ? Math.round(prac.strikes / n * 100) + '%' : '-'], ['平均のズレ', game.pitches ? Math.round(prac.miss / n * 100) + 'cm' : '-'], ['最速', prac.best ? prac.best + 'km/h' : '-']]
      : P
      ? [['奪三振', game.ks + 'K'],['被安打', game.hits], ['球数', game.pitches]]
      : [['安打', game.hits], ['本塁打', game.hrs], ['最長飛距離', game.best ? Math.round(game.best) + 'm' : '-']];
    rows.forEach(([k, v], i) => { $('ovK' + (i + 1)).textContent = k; $('ovV' + (i + 1)).textContent = v; });
    let note = '';
    if (practice) note = prac.perfect ? `PERFECT ${prac.perfect}回` : '';
    else if (P && game.runs === 0) note = game.hits === 0 ? (game.bb === 0 ? '完全試合！' : 'ノーヒットノーラン！') : '完封！';
    else if (P && game.runs <= 2) note = 'ナイスピッチング！';
    $('ovLine').innerHTML = '';
    if (vs) {
      const t = vsTotals();
      const bat = mode === 'bat' ? pickSide() : vsm.saved.bat || SIDE0, pit = mode === 'pitch' ? pickSide() : vsm.saved.pitch || SIDE0;
      $('ovLbl').textContent = '自分 - CPU';
      $('ovRuns').textContent = `${t.me} - ${t.cpu}`;
      $('ovUnit').textContent = '';
      [['安打', bat.hits], ['本塁打', bat.hrs], ['奪三振', pit.ks + 'K']].forEach(([k, v], i) => { $('ovK' + (i + 1)).textContent = k; $('ovV' + (i + 1)).textContent = v; });
      note = t.me > t.cpu ? (t.cpu === 0 ? '完封勝利！' : '勝利！') : t.me < t.cpu ? (vsm.walkoff ? 'サヨナラ負け…' : '敗戦…') : '引き分け';
      renderLine();
    }
    $('ovNote').textContent = note;
    setTimeout(() => $('over').classList.remove('hidden'), 400);
  }

  function radio(groupId, fn) {
    const btns = document.querySelectorAll(`#${groupId} button`);
    btns.forEach(b => b.addEventListener('click', () => {
      btns.forEach(x => x.classList.toggle('sel', x === b));
      fn(b);
    }));
  }
  radio('modeSel', b => {
    practice = b.dataset.mode === 'practice';
    vs = b.dataset.mode === 'match';
    mode = practice ? 'pitch' : vs ? 'bat' : b.dataset.mode;
    applyModeUI();
  });
  radio('diffSel', b => { selDiff = b.dataset.diff; });
  radio('innSel', b => { vsm.innings = +b.dataset.inn; });
  buildPitchButtons();
  if (COARSE) enableTouch();
  applyModeUI();
  $('startBtn').addEventListener('click', () => ((mode === 'pitch' && !practice) || vs ? openArsenal() : startGame()));
  $('quitBtn').addEventListener('click', quitPractice);
  $('retryBtn').addEventListener('click', startGame);
  $('titleBtn').addEventListener('click', () => {
    $('over').classList.add('hidden');
    $('hud').classList.add('hidden');
    $('title').classList.remove('hidden');
    game.state = 'title';
    if (vs) { mode = 'bat'; applyModeUI(); }
  });

  resetFielders(true);
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    update(dt, now);
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
