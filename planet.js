import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* The planet: one small world, a path winding round it, and a landmark per stop.
   Performance rules: no point lights, no shadow maps, static parts merged into
   a handful of meshes, frame rate adapts to the device. */

const R = 10;
const Y = new THREE.Vector3(0, 1, 0);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

export const LANDMARKS = [
  { id: 'about',       label: 'About me',       color: '#ff6b5a', lat: 18,  lon: 0,   h: 3.0, clear: 0.42 },
  { id: 'studio',      label: 'Featured study', color: '#57c1ff', lat: 30,  lon: 48,  h: 3.4, clear: 0.26 },
  { id: 'research',    label: 'More research',  color: '#8b6cff', lat: 12,  lon: 98,  h: 2.8, clear: 0.26 },
  { id: 'skills',      label: 'Skills',         color: '#59d499', lat: -12, lon: 145, h: 3.6 },
  { id: 'experience',  label: 'Experience',     color: '#ffc533', lat: -26, lon: 195, h: 4.0 },
  { id: 'critiques',   label: 'Critiques',      color: '#57c1ff', lat: -6,  lon: 244, h: 3.3, clear: 0.34 },
  { id: 'recognition', label: 'Recognition',    color: '#ffc533', lat: 14,  lon: 292, h: 3.0, clear: 0.32 },
  { id: 'contact',     label: 'Contact',        color: '#ff8fa8', lat: 38,  lon: 334, h: 4.8, clear: 0.26 },
];

// Hidden in free roam. Each one is a bit of Alfie's life outside the CV.
export const EGGS = [
  { id: 'lol',      lat: 62,  lon: 40,  text: 'A Nexus! League of Legends, the game I know inside out (and have critiqued).' },
  { id: 'fortnite', lat: 55,  lon: 205, text: 'A supply drop. Fortnite, still dropping in.' },
  { id: 'rocket',   lat: -55, lon: 80,  text: 'Rocket League. What a save!' },
  { id: 'peak',     lat: -62, lon: 250, text: 'PEAK: co-op climbing chaos with friends.' },
  { id: 'balatro',  lat: 72,  lon: 300, text: 'A Joker card. Balatro: one more run, always.' },
  { id: 'chained',  lat: -38, lon: 330, text: 'Chained Together. Teamwork, tested.' },
  { id: 'fans',     lat: 50,  lon: 150, text: 'The fan corner: G2 in League, Paper Rex in Valorant, and Tottenham. Come on you Spurs!' },
  { id: 'travel',   text: 'The travel plane. When I am not researching, I am planning the next trip.' },
  { id: 'norman',   text: 'Woof! That is Norman, my black and tan sausage dog.' },
];

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */
let seed = 21;
const rnd = () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const easeIO = k => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const easeOut = k => 1 - Math.pow(1 - k, 3);
const dirOf = (lat, lon) => {
  const a = THREE.MathUtils.degToRad(lat), b = THREE.MathUtils.degToRad(lon);
  return new THREE.Vector3(Math.cos(a) * Math.sin(b), Math.sin(a), Math.cos(a) * Math.cos(b));
};

// Orientation that stands an object on the surface at n, with its front facing back down the path.
const _m = new THREE.Matrix4(), _x = new THREE.Vector3(), _z = new THREE.Vector3();
function frameAt(n, t, out = new THREE.Quaternion()) {
  _z.copy(t).addScaledVector(n, -t.dot(n)).normalize().negate();
  _x.crossVectors(n, _z).normalize();
  _m.makeBasis(_x, n, _z);
  return out.setFromRotationMatrix(_m);
}

// Geometry baking: everything static becomes position + colour, merged into one mesh.
function bakePart(geo, color, matrix, sway) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
  g.applyMatrix4(matrix);
  const c = new THREE.Color(color), n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  if (sway !== undefined) g.setAttribute('sway', new THREE.BufferAttribute(new Float32Array(n).fill(sway), 1));
  return g;
}
const tf = (o = {}) => {
  const s = o.s ?? 1;
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...(o.p || [0, 0, 0])),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...(o.r || [0, 0, 0]))),
    Array.isArray(s) ? new THREE.Vector3(...s) : new THREE.Vector3(s, s, s)
  );
};
const LIT = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 });
const GLOW = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });

// Shared clock for vertex animation: trees, grass and flowers sway; water ripples.
const uTime = { value: 0 };
function animated(mat, key, chunk) {
  mat.onBeforeCompile = sh => {
    sh.uniforms.uTime = uTime;
    sh.vertexShader = 'uniform float uTime;\n' + (key === 'sway' ? 'attribute float sway;\n' : '') +
      sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + chunk);
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}
const SWAY_CHUNK = `
  float ph = dot(position, vec3(0.31, 0.27, 0.23));
  transformed += vec3(sin(uTime * 1.6 + ph), sin(uTime * 1.1 + ph * 1.7) * 0.35, cos(uTime * 1.3 + ph)) * 0.06 * sway;`;
const LIT_SWAY = animated(LIT.clone(), 'sway', SWAY_CHUNK);
const GLOW_SWAY = animated(GLOW.clone(), 'sway', SWAY_CHUNK);

class Kit {
  constructor(opts = {}) { this.sway = !!opts.sway; this.litParts = []; this.glowParts = []; this.root = new THREE.Group(); this.updates = []; }
  lit(geo, color, o = {}, base) { this.litParts.push(bakePart(geo, color, base ? base.clone().multiply(tf(o)) : tf(o), this.sway ? (o.sway ?? 0) : undefined)); }
  glow(geo, color, o = {}, base) { this.glowParts.push(bakePart(geo, color, base ? base.clone().multiply(tf(o)) : tf(o), this.sway ? (o.sway ?? 0) : undefined)); }
  dyn(obj, update) { this.root.add(obj); if (update) this.updates.push(update); return obj; }
  finish() {
    if (this.litParts.length) this.root.add(new THREE.Mesh(mergeGeometries(this.litParts), this.sway ? LIT_SWAY : LIT));
    if (this.glowParts.length) this.root.add(new THREE.Mesh(mergeGeometries(this.glowParts), this.sway ? GLOW_SWAY : GLOW));
    this.litParts = this.glowParts = null;
    return this.root;
  }
}
const matCache = new Map();
const dynMat = (c, o = {}) => {
  const key = c + JSON.stringify(o);
  if (!matCache.has(key)) matCache.set(key, o.glow ? new THREE.MeshBasicMaterial({ color: c, toneMapped: false }) : new THREE.MeshStandardMaterial({ color: c, flatShading: true, roughness: 0.85, ...o }));
  return matCache.get(key);
};
const dm = (geo, c, o = {}, opts) => { const m = new THREE.Mesh(geo, dynMat(c, opts)); if (o.p) m.position.set(...o.p); if (o.r) m.rotation.set(...o.r); if (o.s) m.scale.setScalar(o.s); return m; };

const G = {
  box: (x, y, z) => new THREE.BoxGeometry(x, y, z),
  cyl: (a, b, h, s = 10) => new THREE.CylinderGeometry(a, b, h, s),
  cone: (r, h, s = 8) => new THREE.ConeGeometry(r, h, s),
  ico: (r, d = 0) => new THREE.IcosahedronGeometry(r, d),
  sph: (r, w = 8, h = 6) => new THREE.SphereGeometry(r, w, h),
};
const stone = '#d8d0e6';

/* ------------------------------------------------------------------ */
/* Landmarks                                                           */
/* ------------------------------------------------------------------ */
const BUILD = {
  about(k) {
    // Guildford Cathedral: red brick, a long nave, the square central tower and its golden angel.
    const brick = '#b0603f', brickLight = '#c98a6a', roof = '#4b3a4a';
    k.lit(G.cyl(1.55, 1.7, 0.7, 10), stone, { p: [0, -0.2, 0] });
    k.lit(G.box(1.2, 1.25, 2.7), brick, { p: [0, 0.62, -0.15] });
    k.lit(G.cyl(0.72, 0.72, 2.7, 3), roof, { p: [0, 1.42, -0.15], r: [-Math.PI / 2, 0, 0], s: [1, 1, 0.55] });
    k.lit(G.box(2.5, 0.95, 0.8), brick, { p: [0, 0.48, -0.35] });
    k.lit(G.box(0.95, 2.5, 0.95), brick, { p: [0, 1.25, -0.35] });
    k.lit(G.box(1.05, 0.12, 1.05), brickLight, { p: [0, 2.52, -0.35] });
    for (const [x, z] of [[-0.47, 0.12], [0.47, 0.12], [-0.47, -0.82], [0.47, -0.82]]) k.lit(G.box(0.12, 2.6, 0.12), brickLight, { p: [x, 1.3, z] });
    k.lit(G.box(0.36, 0.6, 0.06), '#3a2230', { p: [0, 0.3, 1.21] });
    for (const x of [-0.32, 0, 0.32]) k.glow(G.box(0.1, 0.55, 0.03), '#ffd27a', { p: [x, 0.95, 1.21] });
    for (const x of [-0.16, 0.16]) k.glow(G.box(0.08, 0.7, 0.03), '#ffd27a', { p: [x, 1.9, 0.14] });
    // The angel on top of the tower
    k.lit(G.cyl(0.03, 0.03, 0.3, 5), '#e0a91f', { p: [0, 2.72, -0.35] });
    k.glow(G.cone(0.09, 0.32, 6), '#ffd45a', { p: [0, 3.0, -0.35] });
    k.glow(G.box(0.36, 0.1, 0.02), '#ffd45a', { p: [0, 3.06, -0.35], r: [0, 0, 0.15] });
    k.glow(G.sph(0.05, 6, 4), '#ffd45a', { p: [0, 3.2, -0.35] });

    // A little London to the right: Elizabeth Tower, the Shard, the Gherkin and the Eye.
    k.lit(G.cyl(1.4, 1.5, 0.8, 12), stone, { p: [3.1, -0.3, -0.1] });
    k.lit(G.box(0.32, 1.9, 0.32), '#d8b27a', { p: [2.4, 0.95, 0.2] });
    k.glow(G.box(0.24, 0.24, 0.03), '#fff3c4', { p: [2.4, 1.65, 0.37] });
    k.lit(G.cone(0.24, 0.6, 4), '#2f3b4a', { p: [2.4, 2.2, 0.2], r: [0, Math.PI / 4, 0] });
    k.lit(G.cone(0.42, 2.9, 4), '#9fc4e8', { p: [3.15, 1.45, -0.4], r: [0, Math.PI / 4, 0] });
    k.lit(G.sph(0.3, 10, 8), '#5a8fb0', { p: [3.8, 0.75, 0.25], s: [1, 2.2, 1] });
    k.lit(new THREE.TorusGeometry(0.62, 0.035, 4, 24), '#e8e6ee', { p: [3.1, 0.9, 0.75] });
    for (let i = 0; i < 4; i++) k.lit(G.box(0.025, 1.22, 0.025), '#e8e6ee', { p: [3.1, 0.9, 0.75], r: [0, 0, (i / 4) * Math.PI] });
    k.lit(G.box(0.05, 0.6, 0.05), '#e8e6ee', { p: [3.1, 0.3, 0.75] });

    // A wooden bench on the left, with someone sitting on it.
    const bench = new THREE.Matrix4().compose(new THREE.Vector3(-2.35, 0, 0.55), new THREE.Quaternion().setFromAxisAngle(Y, 0.4), new THREE.Vector3(1.05, 1.05, 1.05));
    const wood = '#9a6a42', woodDark = '#6b4a30';
    k.lit(G.cyl(0.95, 1.05, 0.6, 10), stone, { p: [0, -0.25, 0] }, bench);
    k.lit(G.box(1.2, 0.07, 0.42), wood, { p: [0, 0.45, 0] }, bench);
    for (const y of [0.66, 0.84]) k.lit(G.box(1.2, 0.08, 0.04), wood, { p: [0, y, -0.19] }, bench);
    for (const [x, z] of [[-0.52, 0.15], [0.52, 0.15], [-0.52, -0.17], [0.52, -0.17]]) k.lit(G.box(0.06, z < 0 ? 0.9 : 0.45, 0.06), woodDark, { p: [x, z < 0 ? 0.45 : 0.22, z] }, bench);
    for (const x of [-0.6, 0.6]) k.lit(G.box(0.06, 0.06, 0.42), woodDark, { p: [x, 0.62, 0] }, bench);
    {
      // Ginger, shoulder-length hair; black top under a brown leather jacket; denim shorts; knee-high boots.
      const skin = '#f5d3bc', hair = '#8e4f2c', top = '#1a1a1f', jacket = '#7a4a2a', denim = '#4a78b5', boot = '#3b2416';
      const sit = { x: 0.15 };
      const at = (x, y, z) => [sit.x + x, y, z];
      k.lit(G.box(0.36, 0.13, 0.32), denim, { p: at(0, 0.55, 0.0) }, bench);
      for (const x of [-0.09, 0.09]) {
        k.lit(G.box(0.15, 0.12, 0.16), denim, { p: at(x, 0.55, 0.2) }, bench);
        k.lit(G.box(0.13, 0.11, 0.16), skin, { p: at(x, 0.55, 0.35) }, bench);
        k.lit(G.box(0.14, 0.44, 0.15), boot, { p: at(x, 0.28, 0.43) }, bench);
        k.lit(G.box(0.15, 0.08, 0.24), boot, { p: at(x, 0.04, 0.48) }, bench);
      }
      k.lit(G.box(0.34, 0.36, 0.2), top, { p: at(0, 0.8, -0.02) }, bench);
      for (const x of [-0.15, 0.15]) k.lit(G.box(0.1, 0.38, 0.23), jacket, { p: at(x, 0.81, -0.01) }, bench);
      k.lit(G.box(0.38, 0.38, 0.05), jacket, { p: at(0, 0.81, -0.12) }, bench);
      for (const s of [-1, 1]) {
        k.lit(G.box(0.11, 0.3, 0.13), jacket, { p: at(s * 0.24, 0.8, 0.02), r: [-0.35, 0, s * 0.08] }, bench);
        k.lit(G.box(0.1, 0.09, 0.11), skin, { p: at(s * 0.2, 0.63, 0.16) }, bench);
      }
      k.lit(G.box(0.1, 0.07, 0.1), skin, { p: at(0, 1.01, 0) }, bench);
      k.lit(G.box(0.3, 0.3, 0.28), skin, { p: at(0, 1.19, 0.01) }, bench);
      for (const x of [-0.07, 0.07]) k.lit(G.box(0.045, 0.045, 0.02), '#2b1d14', { p: at(x, 1.21, 0.155) }, bench);
      k.lit(G.box(0.1, 0.025, 0.02), '#c86a6a', { p: at(0, 1.11, 0.155) }, bench);
      k.lit(G.box(0.34, 0.09, 0.32), hair, { p: at(0, 1.36, 0) }, bench);
      k.lit(G.box(0.3, 0.06, 0.06), hair, { p: at(0, 1.31, 0.14) }, bench);
      for (const x of [-0.17, 0.17]) k.lit(G.box(0.05, 0.38, 0.26), hair, { p: at(x, 1.15, -0.01) }, bench);
      k.lit(G.box(0.34, 0.42, 0.07), hair, { p: at(0, 1.13, -0.15) }, bench);
    }
  },
  studio(k) {
    k.lit(G.cyl(1.8, 1.95, 0.7, 10), stone, { p: [0, -0.2, 0] });
    k.lit(G.box(2.6, 1.5, 1.8), '#efe7ff', { p: [0, 0.75, 0] });
    k.lit(G.box(2.8, 0.18, 2.0), '#2b2160', { p: [0, 1.58, 0] });
    k.glow(G.box(2.2, 0.42, 0.05), '#9fe3ff', { p: [0, 0.98, 0.91] });
    k.lit(G.box(0.5, 0.75, 0.06), '#57c1ff', { p: [-0.8, 0.38, 0.92] });
    k.lit(G.box(0.8, 2.4, 0.8), '#57c1ff', { p: [1.15, 1.2, -0.45] });
    k.glow(G.box(0.82, 0.12, 0.82), '#ffc533', { p: [1.15, 2.45, -0.45] });
    k.lit(G.cyl(0.05, 0.05, 0.75, 6), '#3a2a50', { p: [-0.3, 1.95, 0] });
    k.lit(G.cyl(0.04, 0.05, 1.5, 5), '#7a4e35', { p: [-2.0, 0.75, 1.0] });
    [['#ff6b5a', 1.3, 0.3], ['#ffc533', 1.05, -0.4], ['#59d499', 0.8, 0.9]].forEach(([c, y, a]) => k.lit(G.box(0.62, 0.16, 0.04), c, { p: [-2.0 + Math.cos(a) * 0.25, y, 1.0 - Math.sin(a) * 0.25], r: [0, a, 0] }));
    const sign = k.dyn(new THREE.Group());
    sign.position.set(-0.3, 2.55, 0);
    sign.add(dm(new THREE.CapsuleGeometry(0.34, 0.9, 3, 8), '#ff6b5a', { r: [0, 0, Math.PI / 2] }));
    sign.add(dm(G.box(0.36, 0.1, 0.06), '#2b2160', { p: [-0.42, 0, 0.32] }), dm(G.box(0.1, 0.36, 0.06), '#2b2160', { p: [-0.42, 0, 0.32] }));
    [['#ffc533', 0.42, 0.13], ['#59d499', 0.55, 0], ['#57c1ff', 0.29, 0], ['#f6f2ff', 0.42, -0.13]].forEach(([c, x, y]) => sign.add(dm(G.sph(0.065), c, { p: [x, y, 0.32] }, { glow: true })));
    k.updates.push(t => { sign.rotation.y = Math.sin(t * 0.8) * 0.35; sign.position.y = 2.55 + Math.sin(t * 1.6) * 0.06; });
  },
  research(k) {
    // University of Surrey's Alan Turing Building: crisp modern blocks, glass bands, a cantilevered top floor.
    k.lit(G.cyl(1.8, 1.95, 0.7, 10), stone, { p: [0, -0.2, 0] });
    k.lit(G.box(2.6, 1.1, 1.6), '#e8e6ee', { p: [0, 0.55, 0] });
    k.lit(G.box(3.0, 0.9, 1.5), '#f6f4fb', { p: [0.25, 1.55, 0.06] });
    k.lit(G.box(3.1, 0.08, 1.62), '#3a3550', { p: [0.25, 2.04, 0.06] });
    k.lit(G.box(2.7, 0.08, 1.7), '#3a3550', { p: [0, 1.1, 0] });
    k.glow(G.box(2.3, 0.34, 0.03), '#8fd3ff', { p: [0, 0.62, 0.81] });
    k.glow(G.box(2.7, 0.32, 0.03), '#8fd3ff', { p: [0.25, 1.56, 0.82] });
    for (let i = 0; i < 9; i++) k.lit(G.box(0.05, 0.9, 0.06), '#5b5670', { p: [-1.1 + i * 0.32 + 0.25, 1.55, 0.84] });
    k.glow(G.box(0.6, 0.8, 0.03), '#c9ecff', { p: [-0.7, 0.4, 0.82] });
    k.lit(G.box(0.6, 0.06, 0.4), '#3a3550', { p: [-0.7, 0.85, 1.0] });
    const scope = k.dyn(new THREE.Group()); scope.position.set(-0.85, 2.1, -0.2); scope.scale.setScalar(0.45);
    scope.add(dm(G.cyl(0.22, 0.32, 2.5, 10), '#8b6cff', { p: [0, 0.9, 0.55], r: [0.75, 0, 0] }));
    scope.add(dm(G.cyl(0.2, 0.2, 0.06, 10), '#9fe3ff', { p: [0, 1.82, 1.38], r: [0.75, 0, 0] }, { glow: true }));
    k.updates.push(t => { scope.rotation.y = Math.sin(t * 0.25) * 0.9; });
  },
  skills(k) {
    k.lit(G.cyl(0.9, 1.0, 0.6, 9), '#8b6a52', { p: [0, -0.2, 0] });
    k.lit(G.cyl(0.2, 0.34, 1.8, 7), '#7a4e35', { p: [0, 0.9, 0] });
    [[0, 2.35, 0, 1.15, '#4fbf8a'], [-0.75, 1.95, 0.25, 0.8, '#3aa676'], [0.7, 2.0, -0.2, 0.85, '#45b07f'], [0.1, 2.9, -0.3, 0.75, '#59d499']]
      .forEach(([x, y, z, r, c]) => k.lit(G.ico(r), c, { p: [x, y, z] }));
    const fruit = k.dyn(new THREE.Group());
    ['#ff6b5a', '#57c1ff', '#59d499', '#ffc533', '#c88cff', '#ffffff'].forEach((c, i) => {
      const a = (i / 6) * Math.PI * 2;
      fruit.add(dm(G.ico(0.18, 1), c, { p: [Math.cos(a) * 1.08, 2.1 + (i % 3) * 0.35, Math.sin(a) * 1.08] }, { glow: true }));
    });
    k.updates.push(t => { fruit.position.y = Math.sin(t * 1.6) * 0.06; fruit.rotation.y = t * 0.15; });
  },
  experience(k) {
    k.lit(G.cyl(1.0, 1.1, 0.6, 9), stone, { p: [0, -0.2, 0] });
    k.lit(G.cyl(0.45, 0.78, 2.9, 8), '#f4ead9', { p: [0, 1.45, 0] });
    k.lit(G.cyl(0.62, 0.5, 0.18, 8), '#5b4bff', { p: [0, 2.95, 0] });
    k.lit(G.cone(0.62, 0.75, 8), '#5b4bff', { p: [0, 3.4, 0] });
    k.lit(G.box(0.36, 0.6, 0.06), '#6b3f2f', { p: [0, 0.3, 0.74] });
    k.glow(G.box(0.24, 0.24, 0.06), '#ffc56b', { p: [0, 1.7, 0.6] });
    const hub = k.dyn(new THREE.Group()); hub.position.set(0, 2.75, 0.62);
    hub.add(dm(G.cyl(0.12, 0.12, 0.3, 8), '#3a2a50', { r: [Math.PI / 2, 0, 0] }));
    for (let i = 0; i < 4; i++) {
      const arm = new THREE.Group(); arm.rotation.z = (i * Math.PI) / 2; hub.add(arm);
      arm.add(dm(G.box(0.07, 1.75, 0.05), '#8a5a4a', { p: [0, 0.95, 0] }), dm(G.box(0.42, 1.25, 0.03), '#ffc533', { p: [0.22, 1.1, 0.03] }));
    }
    k.updates.push(t => { hub.rotation.z = -t * 0.9; });
  },
  critiques(k) {
    k.lit(G.cyl(1.05, 1.15, 0.6, 9), '#3a2a62', { p: [0, -0.2, 0] });
    k.lit(G.box(1.25, 2.2, 1.0), '#2b2160', { p: [0, 1.1, 0] });
    for (const x of [-0.64, 0.64]) k.lit(G.box(0.04, 2.15, 0.95), '#57c1ff', { p: [x, 1.1, 0] });
    k.glow(G.box(1.28, 0.4, 1.12), '#ff6b5a', { p: [0, 2.38, 0.05] });
    k.lit(G.box(1.25, 0.14, 0.62), '#3f3290', { p: [0, 1.2, 0.62], r: [0.25, 0, 0] });
    k.lit(G.cyl(0.035, 0.035, 0.28, 6), '#222222', { p: [-0.28, 1.38, 0.66] });
    k.lit(G.sph(0.1), '#ff3c28', { p: [-0.28, 1.54, 0.66] });
    k.glow(G.cyl(0.075, 0.075, 0.06), '#ffc533', { p: [0.12, 1.3, 0.66] });
    k.glow(G.cyl(0.075, 0.075, 0.06), '#57c1ff', { p: [0.34, 1.3, 0.66] });
    // The O2: a white dome with yellow masts.
    k.lit(G.cyl(1.25, 1.3, 0.2, 16), stone, { p: [-2.4, 0.0, -0.2] });
    k.lit(new THREE.SphereGeometry(1.2, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2), '#f2eef8', { p: [-2.4, 0.08, -0.2], s: [1, 0.48, 1] });
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      k.lit(G.cyl(0.025, 0.035, 1.25, 5), '#ffc533', { p: [-2.4 + Math.cos(a) * 0.9, 0.7, -0.2 + Math.sin(a) * 0.9], r: [Math.sin(a) * 0.25, 0, -Math.cos(a) * 0.25] });
    }
    const sc = document.createElement('canvas'); sc.width = 64; sc.height = 48;
    const ctx = sc.getContext('2d');
    const tex = new THREE.CanvasTexture(sc); tex.magFilter = tex.minFilter = THREE.NearestFilter; tex.colorSpace = THREE.SRGBColorSpace;
    const screen = k.dyn(new THREE.Mesh(new THREE.PlaneGeometry(0.98, 0.74), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })));
    screen.position.set(0, 1.75, 0.505); screen.rotation.x = -0.08;
    const inv = ['00100000100', '00010001000', '00111111100', '01101110110', '11111111111', '10111111101', '10100000101', '00011011000'];
    let last = -1;
    k.updates.push(t => {
      const f = Math.floor(t * 6); if (f === last) return; last = f;
      ctx.fillStyle = '#0d0a26'; ctx.fillRect(0, 0, 64, 48);
      ctx.fillStyle = '#2a2470'; for (let i = 0; i < 18; i++) ctx.fillRect((i * 37 + f * 2) % 64, (i * 23) % 48, 1, 1);
      const ox = 12 + Math.round(Math.sin(f / 6) * 12), oy = 10 + (f % 24 < 12 ? 0 : 1);
      ctx.fillStyle = f % 16 < 8 ? '#59d499' : '#57c1ff';
      inv.forEach((row, y) => [...row].forEach((v, x) => { if (v === '1') ctx.fillRect(ox + x * 2, oy + y * 2, 2, 2); }));
      ctx.fillStyle = '#ffc533'; ctx.fillRect(28 + Math.round(Math.sin(f / 4) * 20), 40, 7, 3);
      ctx.fillStyle = 'rgba(0,0,0,.25)'; for (let y = 0; y < 48; y += 2) ctx.fillRect(0, y, 64, 1);
      tex.needsUpdate = true;
    });
  },
  recognition(k) {
    k.lit(G.cyl(1.5, 1.6, 0.6, 10), stone, { p: [0, -0.25, 0] });
    [[1.4, 0.05], [1.1, 0.3], [0.78, 0.55]].forEach(([r, y]) => k.lit(G.cyl(r, r + 0.08, 0.3, 10), stone, { p: [0, y, 0] }));
    // A Korean gate for the Gen.G practicum.
    for (const x of [1.75, 2.85]) k.lit(G.cyl(0.07, 0.08, 1.45, 8), '#c8322f', { p: [x, 0.62, 0.4] });
    k.lit(G.box(1.45, 0.09, 0.12), '#c8322f', { p: [2.3, 1.18, 0.4] });
    k.lit(G.box(1.3, 0.12, 0.13), '#2aa198', { p: [2.3, 1.3, 0.4] });
    k.lit(G.box(1.75, 0.1, 0.55), '#2f3b4a', { p: [2.3, 1.45, 0.4] });
    k.lit(G.box(1.2, 0.12, 0.4), '#2f3b4a', { p: [2.3, 1.55, 0.4] });
    for (const s of [-1, 1]) k.lit(G.box(0.3, 0.08, 0.5), '#2f3b4a', { p: [2.3 + s * 0.95, 1.5, 0.4], r: [0, 0, s * 0.35] });
    const gold = new THREE.MeshStandardMaterial({ color: 0xffc533, metalness: 0.8, roughness: 0.25, emissive: 0x7a4c00, emissiveIntensity: 0.55, flatShading: true });
    const cup = k.dyn(new THREE.Group()); cup.position.y = 0.72;
    const prof = [[0, 0], [0.42, 0], [0.42, 0.08], [0.14, 0.16], [0.1, 0.55], [0.22, 0.68], [0.55, 0.85], [0.6, 1.45], [0.56, 1.5]].map(([x, y]) => new THREE.Vector2(x, y));
    cup.add(new THREE.Mesh(new THREE.LatheGeometry(prof, 12), gold));
    for (const s of [-1, 1]) { const h = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.05, 6, 12, Math.PI), gold); h.position.set(s * 0.62, 1.15, 0); h.rotation.z = -s * Math.PI / 2; cup.add(h); }
    cup.add(dm(new THREE.OctahedronGeometry(0.16), '#fff3b0', { p: [0, 1.8, 0] }, { glow: true }));
    const sparks = k.dyn(new THREE.Group());
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; sparks.add(dm(new THREE.OctahedronGeometry(0.06), '#ffe28a', { p: [Math.cos(a) * 1.1, 1.6 + (i % 2) * 0.4, Math.sin(a) * 1.1] }, { glow: true })); }
    k.updates.push(t => { cup.rotation.y = t * 0.8; sparks.rotation.y = -t * 0.5; sparks.position.y = Math.sin(t * 2) * 0.1; });
  },
  contact(k) {
    k.lit(G.cyl(1.0, 1.25, 1.0, 9), '#8f7f9e', { p: [0, -0.3, 0] });
    const H = 3.3, n = 5;
    for (let i = 0; i < n; i++) {
      const r0 = 0.68 - (i / n) * 0.25, r1 = 0.68 - ((i + 1) / n) * 0.25;
      k.lit(G.cyl(r1, r0, H / n, 12), i % 2 ? '#f6f2ff' : '#ff5a4e', { p: [0, 0.3 + (i + 0.5) * (H / n), 0] });
    }
    k.lit(G.cyl(0.62, 0.62, 0.1, 12), '#2b2160', { p: [0, 3.65, 0] });
    k.glow(G.cyl(0.34, 0.34, 0.55, 10), '#fff1b0', { p: [0, 3.97, 0] });
    k.lit(G.cone(0.48, 0.55, 10), '#ff5a4e', { p: [0, 4.52, 0] });
    k.lit(G.box(0.3, 0.5, 0.06), '#3a2a50', { p: [0, 0.6, 0.66] });
    const beam = k.dyn(new THREE.Group()); beam.position.y = 3.97;
    const cg = new THREE.ConeGeometry(1.3, 9, 18, 1, true); cg.translate(0, -4.5, 0); cg.rotateZ(Math.PI / 2);
    const fade = document.createElement('canvas'); fade.width = 4; fade.height = 64;
    const fg = fade.getContext('2d'), grad = fg.createLinearGradient(0, 0, 0, 64);
    grad.addColorStop(0, '#fff'); grad.addColorStop(1, '#000'); fg.fillStyle = grad; fg.fillRect(0, 0, 4, 64);
    const bm = new THREE.MeshBasicMaterial({ color: 0xfff1b0, alphaMap: new THREE.CanvasTexture(fade), transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    for (const s of [0, Math.PI]) { const b = new THREE.Mesh(cg, bm); b.rotation.y = s; b.userData.noPick = true; beam.add(b); }
    k.updates.push(t => { beam.rotation.y = t * 0.7; });
  },
};

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */
export function createPlanet({ canvas, pinsEl, onPick, onEgg = () => {} }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  let dpr = Math.min(devicePixelRatio, 1.5);
  renderer.setPixelRatio(dpr);
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.1, 1200);
  const planet = new THREE.Group();
  scene.add(planet);
  const updates = [];

  /* ---------- Path ---------- */
  LANDMARKS.forEach(l => { l.dir = dirOf(l.lat, l.lon); });
  EGGS.forEach(e => { if (e.lat !== undefined) e.dir = dirOf(e.lat, e.lon); });
  const ctrl = [];
  const first = LANDMARKS[0].dir, second = LANDMARKS[1].dir;
  ctrl.push(first.clone().multiplyScalar(2).sub(second).normalize());
  LANDMARKS.forEach((l, i) => {
    ctrl.push(l.dir.clone());
    const next = LANDMARKS[i + 1];
    if (next) {
      const mid = l.dir.clone().add(next.dir).normalize();
      const side = new THREE.Vector3().crossVectors(mid, next.dir.clone().sub(l.dir)).normalize();
      ctrl.push(mid.addScaledVector(side, i % 2 ? 0.13 : -0.13).normalize());
    }
  });
  const lastL = LANDMARKS[LANDMARKS.length - 1].dir, prevL = LANDMARKS[LANDMARKS.length - 2].dir;
  ctrl.push(lastL.clone().multiplyScalar(1.6).sub(prevL.clone().multiplyScalar(0.6)).normalize());
  const curve = new THREE.CatmullRomCurve3(ctrl, false, 'centripetal');
  const NS = 700;
  const pts = curve.getSpacedPoints(NS).map(p => p.normalize());
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].angleTo(pts[i - 1]));
  const total = cum[cum.length - 1];
  const nearestIdx = d => { let best = 0, bd = -2; pts.forEach((p, i) => { const v = p.dot(d); if (v > bd) { bd = v; best = i; } }); return best; };
  LANDMARKS.forEach(l => { l.u = cum[nearestIdx(l.dir)] / total; });
  function pathAt(u, outP, outT) {
    const target = clamp(u, 0, 1) * total;
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] < target) lo = mid; else hi = mid; }
    const f = (target - cum[lo]) / Math.max(1e-6, cum[hi] - cum[lo]);
    outP.copy(pts[lo]).lerp(pts[hi], f).normalize();
    const a = pts[Math.max(0, lo - 2)], b = pts[Math.min(pts.length - 1, hi + 2)];
    outT.copy(b).sub(a).normalize();
    return outP;
  }

  /* ---------- Terrain ---------- */
  let terrain; // also used to block clicks aimed at things behind the planet
  const n1 = v => Math.sin(3.1 * v.x + 1.7) * Math.sin(2.9 * v.y + 0.4) * Math.sin(3.3 * v.z + 2.2) + 0.5 * Math.sin(7.3 * v.x + 0.3) * Math.sin(6.1 * v.y + 1.1) * Math.sin(6.7 * v.z + 0.7);
  const n2 = v => Math.sin(2.3 * v.x + 4.1) * Math.sin(2.7 * v.y + 1.9) * Math.sin(2.1 * v.z + 0.6) + 0.4 * Math.sin(5.9 * v.x + 2) * Math.sin(5.3 * v.y) * Math.sin(6.1 * v.z + 1);
  const sparse = pts.filter((_, i) => i % 2 === 0);
  const infoCache = new Map();
  function info(v) {
    const key = `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`;
    let r = infoCache.get(key);
    if (r) return r;
    let pd = -2; for (const p of sparse) { const d = p.dot(v); if (d > pd) pd = d; }
    pd = Math.acos(clamp(pd, -1, 1));
    let ld = 9; for (const l of LANDMARKS) ld = Math.min(ld, Math.acos(clamp(l.dir.dot(v), -1, 1)));
    const noise = n1(v);
    let h = 0.32 + 0.24 * noise;
    const flat = smooth(0.03, 0.12, pd) * smooth(0.2, 0.32, ld);
    h = 0.3 + (h - 0.3) * flat;
    const lake = smooth(-0.45, -0.85, n2(v)) * smooth(0.1, 0.22, pd) * smooth(0.34, 0.46, ld);
    h = h + (-0.5 - h) * lake;
    r = { h, pd, ld, noise };
    infoCache.set(key, r);
    return r;
  }
  const surface = (v, out = new THREE.Vector3()) => out.copy(v).multiplyScalar(R + info(v).h);

  {
    let geo = new THREE.IcosahedronGeometry(1, 5);
    geo.deleteAttribute('normal'); geo.deleteAttribute('uv');
    const p = geo.attributes.position, v = new THREE.Vector3();
    const infos = [];
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).normalize();
      const inf = info(v); infos.push(inf);
      p.setXYZ(i, v.x * (R + inf.h), v.y * (R + inf.h), v.z * (R + inf.h));
    }
    const cols = new Float32Array(p.count * 3), c = new THREE.Color();
    const grassA = new THREE.Color('#62c983'), grassB = new THREE.Color('#3f9f72'), grassHi = new THREE.Color('#84d98f');
    for (let f = 0; f < p.count; f += 3) {
      const a = infos[f], b = infos[f + 1], d = infos[f + 2];
      const h = (a.h + b.h + d.h) / 3, pd = Math.min(a.pd, b.pd, d.pd), ld = Math.min(a.ld, b.ld, d.ld), nz = (a.noise + b.noise + d.noise) / 3;
      if (h < 0.02) c.set('#c9b383');
      else if (h < 0.17) c.set('#e3c98f');
      else if (ld < 0.105) c.set('#efe2c4');
      else if (pd < 0.032) c.set('#ecd49e');
      else if (pd < 0.05) c.set('#a8d77f');
      else { c.copy(grassA).lerp(grassB, 0.5 + 0.5 * Math.sin(nz * 2.4)); if (h > 0.5) c.lerp(grassHi, 0.6); }
      c.offsetHSL(0, 0, (Math.sin(f * 12.9898) * 43758.5453 % 1) * 0.04);
      for (let k = 0; k < 3; k++) cols.set([c.r, c.g, c.b], (f + k) * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    terrain = new THREE.Mesh(geo, LIT);
    planet.add(terrain);
  }

  // Lakes and seas show through where the land dips below this shell.
  planet.add(new THREE.Mesh(new THREE.IcosahedronGeometry(R + 0.06, 5), animated(
    new THREE.MeshStandardMaterial({ color: 0x4aa8ff, emissive: 0x1d5fd6, emissiveIntensity: 0.55, roughness: 0.15, metalness: 0.1, flatShading: true, transparent: true, opacity: 0.88 }),
    'ripple', 'transformed += normalize(position) * (sin(uTime * 1.4 + dot(position, vec3(1.7, 2.1, 1.3))) * 0.035 + sin(uTime * 2.3 + dot(position, vec3(-2.6, 1.1, 2.9))) * 0.02);'
  )));

  /* ---------- Landmarks ---------- */
  const tmpP = new THREE.Vector3(), tmpT = new THREE.Vector3();
  for (const l of LANDMARKS) {
    const k = new Kit();
    BUILD[l.id](k);
    const root = k.finish();
    pathAt(l.u, tmpP, tmpT);
    root.position.copy(surface(l.dir));
    frameAt(l.dir, tmpT, root.quaternion);
    root.traverse(o => { if (o.isMesh && !o.userData.noPick) o.userData.lm = l.id; });
    planet.add(root);
    l.root = root;
    l.top = new THREE.Vector3(0, l.h + 0.5, 0);
    updates.push(...k.updates);
  }

  /* ---------- Scenery, all merged ---------- */
  {
    const k = new Kit({ sway: true });
    const q = new THREE.Quaternion(), twist = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
    const place = (v, s, lift = -0.04) => {
      q.setFromUnitVectors(Y, v).multiply(twist.setFromAxisAngle(Y, rnd() * 6.283));
      pos.copy(v).multiplyScalar(R + info(v).h + lift);
      return new THREE.Matrix4().compose(pos, q, scl.setScalar(s));
    };
    const randDir = () => { const u = rnd() * 2 - 1, t = rnd() * 6.283, s = Math.sqrt(1 - u * u); return new THREE.Vector3(Math.cos(t) * s, u, Math.sin(t) * s); };
    const pine = ['#2f8f6a', '#3aa676'], round = ['#4fbf8a', '#59d499', '#59d499', '#ff8fa8', '#ffc533'];
    for (let i = 0, made = 0; i < 900 && made < 230; i++) {
      const v = randDir(), inf = info(v);
      if (inf.pd < 0.085 || inf.h < 0.2 || LANDMARKS.some(l => l.dir.angleTo(v) < (l.clear || 0.2)) || EGGS.some(e => e.dir && e.dir.angleTo(v) < 0.2)) continue;
      made++;
      const m = place(v, 0.7 + rnd() * 0.65);
      k.lit(G.cyl(0.08, 0.12, 0.6, 5), '#7a4e35', { p: [0, 0.3, 0], sway: 0.12 }, m);
      if (rnd() < 0.55) {
        const c = pine[made % 2];
        k.lit(G.cone(0.62, 1.1, 6), c, { p: [0, 1.05, 0], sway: 0.6 }, m);
        k.lit(G.cone(0.48, 0.9, 6), c, { p: [0, 1.65, 0], sway: 1 }, m);
      } else {
        k.lit(G.ico(0.62), round[Math.floor(rnd() * round.length)], { p: [0, 1.05, 0], sway: 0.8 }, m);
      }
    }
    for (let i = 0, made = 0; i < 300 && made < 45; i++) {
      const v = randDir(), inf = info(v);
      if (inf.pd < 0.06 || LANDMARKS.some(l => l.dir.angleTo(v) < (l.clear || 0.2)) || EGGS.some(e => e.dir && e.dir.angleTo(v) < 0.16)) continue;
      made++;
      k.lit(new THREE.DodecahedronGeometry(0.32), '#b8aecb', { p: [0, 0.05, 0], s: [0.7 + rnd(), 0.45 + rnd() * 0.5, 0.7 + rnd()] }, place(v, 1));
    }
    const fl = ['#ff6b5a', '#ffc533', '#ffffff', '#c88cff', '#57c1ff'];
    for (let i = 0, made = 0; i < 1200 && made < 260; i++) {
      const v = randDir(), inf = info(v);
      if (inf.pd < 0.045 || inf.h < 0.18) continue;
      made++;
      k.glow(G.ico(0.07), fl[made % fl.length], { p: [0, 0.06, 0], sway: 0.6 }, place(v, 1, 0));
    }
    // Grass tufts
    const blades = ['#4fbf8a', '#3aa676', '#7fd68f'], blade = G.cone(0.05, 0.32, 3);
    for (let i = 0, made = 0; i < 2000 && made < 520; i++) {
      const v = randDir(), inf = info(v);
      if (inf.pd < 0.04 || inf.h < 0.2 || LANDMARKS.some(l => l.dir.angleTo(v) < (l.clear || 0.2) - 0.04) || EGGS.some(e => e.dir && e.dir.angleTo(v) < 0.12)) continue;
      made++;
      const m = place(v, 0.8 + rnd() * 0.6, -0.02);
      for (let b = 0; b < 3; b++) k.lit(blade, blades[(made + b) % 3], { p: [(b - 1) * 0.06, 0.15, (b % 2) * 0.05], r: [(b - 1) * 0.25, 0, (b - 1) * -0.3], sway: 1.2 }, m);
    }
    // Lanterns along the path, alternating sides, so the route reads at a glance.
    const side = new THREE.Vector3();
    for (let i = 20, s = 1; i < pts.length - 20; i += 26, s = -s) {
      const p = pts[i], t = pts[i + 1].clone().sub(pts[i - 1]).normalize();
      const nearL = LANDMARKS.some(l => l.dir.angleTo(p) < 0.15);
      if (nearL) continue;
      side.crossVectors(p, t).normalize();
      const v = p.clone().addScaledVector(side, 0.058 * s).normalize();
      const m = place(v, 1, 0);
      k.lit(G.cyl(0.04, 0.06, 0.8, 5), '#3a2a50', { p: [0, 0.4, 0] }, m);
      k.glow(G.sph(0.11, 6, 4), '#ffd27a', { p: [0, 0.86, 0] }, m);
    }
    planet.add(k.finish());
  }

  /* ---------- Space around it ---------- */
  const space = new THREE.Group(); scene.add(space);
  const ORB_DIR = new THREE.Vector3(-0.55, 0.42, -0.72).normalize();
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { uTop: { value: new THREE.Color() }, uMid: { value: new THREE.Color() }, uLow: { value: new THREE.Color() }, uOrb: { value: new THREE.Color() }, uOrbDir: { value: ORB_DIR } },
    vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `varying vec3 vP; uniform vec3 uTop, uMid, uLow, uOrb, uOrbDir;
      void main(){
        float h = vP.y;
        vec3 col = h > 0.0 ? mix(uMid, uTop, pow(clamp(h, 0.0, 1.0), 0.6)) : mix(uMid, uLow, pow(clamp(-h, 0.0, 1.0), 0.5));
        float m = max(dot(vP, uOrbDir), 0.0);
        col += uOrb * (pow(m, 30.0) * 0.4 + pow(m, 5.0) * 0.08);
        gl_FragColor = vec4(col, 1.0);
      }`
  });
  space.add(new THREE.Mesh(new THREE.SphereGeometry(600, 32, 16), skyMat));
  const glowTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.18, 'rgba(255,255,255,1)'); gr.addColorStop(0.24, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  })();
  const orb = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, transparent: true, depthWrite: false, toneMapped: false }));
  orb.position.copy(ORB_DIR).multiplyScalar(450); orb.scale.setScalar(110); space.add(orb);
  const starGeo = new THREE.BufferGeometry(), sp = new Float32Array(1600 * 3);
  for (let i = 0; i < 1600; i++) { const u = rnd() * 2 - 1, t = rnd() * 6.283, s = Math.sqrt(1 - u * u); sp.set([Math.cos(t) * s * 500, u * 500, Math.sin(t) * s * 500], i * 3); }
  starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, color: 0xfff6e8, transparent: true, opacity: 0.85, depthWrite: false }));
  space.add(stars);
  // A ringed planet and a little moon far away, for scale.
  const far = new THREE.Group(); far.position.set(-330, 190, -470); far.scale.setScalar(0.8); space.add(far);
  far.add(new THREE.Mesh(new THREE.IcosahedronGeometry(16, 2), new THREE.MeshStandardMaterial({ color: 0xff8f6b, flatShading: true, emissive: 0x5a1a10, emissiveIntensity: 0.5 })));
  const ring = new THREE.Mesh(new THREE.RingGeometry(22, 30, 48), new THREE.MeshBasicMaterial({ color: 0xffd9a8, side: THREE.DoubleSide, transparent: true, opacity: 0.45 }));
  ring.rotation.set(1.2, 0.3, 0); far.add(ring);
  const moon = new THREE.Mesh(new THREE.IcosahedronGeometry(6, 1), new THREE.MeshStandardMaterial({ color: 0xc9c2ff, flatShading: true, emissive: 0x2a2060, emissiveIntensity: 0.5 }));
  moon.position.set(170, -40, -260); space.add(moon);

  // Atmosphere glow
  const atmoMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uCol: { value: new THREE.Color() } },
    vertexShader: 'varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'varying vec3 vN; uniform vec3 uCol; void main(){ float i = pow(clamp(0.75 + dot(vN, vec3(0.0,0.0,1.0)), 0.0, 1.0), 3.0); gl_FragColor = vec4(uCol * i, i); }'
  });
  const atmo = new THREE.Mesh(new THREE.SphereGeometry(R * 1.14, 48, 32), atmoMat);
  scene.add(atmo);

  // Clouds circling the planet's waist, world-fixed so they never cover the path ahead.
  const clouds = new THREE.Group(); scene.add(clouds);
  {
    const k = new Kit();
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + rnd() * 0.4, r = R + 5 + rnd() * 3, y = -6 + rnd() * 5;
      const base = new THREE.Matrix4().compose(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r), new THREE.Quaternion().setFromAxisAngle(Y, -a), new THREE.Vector3(1, 1, 1).multiplyScalar(0.7 + rnd() * 0.6));
      const n = 4 + Math.floor(rnd() * 3);
      for (let j = 0; j < n; j++) k.lit(G.ico(0.6 + rnd() * 0.7, 1), '#e4defa', { p: [(rnd() - 0.5) * 0.8, rnd() * 0.5, (j - n / 2) * 0.8], s: [1, 0.72, 1] }, base);
    }
    clouds.add(k.finish());
  }
  updates.push(t => { clouds.rotation.y = t * 0.03; });

  // A few birds circling in daylight.
  const birds = new THREE.Group(); scene.add(birds);
  {
    const wingGeo = new THREE.BufferGeometry();
    wingGeo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -0.18, 0, 0, 0.18, 0.55, 0.05, 0], 3));
    const wingMat = new THREE.MeshBasicMaterial({ color: 0x2a2350, side: THREE.DoubleSide });
    const flock = [];
    for (let i = 0; i < 5; i++) {
      const b = new THREE.Group();
      const l = new THREE.Mesh(wingGeo, wingMat), r = new THREE.Mesh(wingGeo, wingMat); r.scale.x = -1;
      b.add(l, r); birds.add(b);
      flock.push({ b, l, r, a: rnd() * 6.28, rad: 7 + rnd() * 5, y: R + 6 + rnd() * 3, sp: 0.18 + rnd() * 0.1, ph: rnd() * 6 });
    }
    updates.push(t => flock.forEach(f => {
      const a = f.a + t * f.sp;
      f.b.position.set(Math.cos(a) * f.rad, f.y + Math.sin(t + f.ph) * 0.4, Math.sin(a) * f.rad - 6);
      f.b.rotation.y = -a;
      const flap = Math.sin(t * 9 + f.ph) * 0.6;
      f.l.rotation.z = flap; f.r.rotation.z = -flap;
    }));
  }

  /* ---------- Lights ---------- */
  const hemi = new THREE.HemisphereLight(0xc4bdff, 0x3a2350, 1.35); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff0e0, 2.3); sun.position.set(-6, 14, 9); scene.add(sun);
  const rim = new THREE.DirectionalLight(0x9f88ff, 1.2); rim.position.set(10, -2, -12); scene.add(rim);

  /* ---------- Time of day: the sky follows the visitor's own clock ---------- */
  const SKY = {
    night: { top: '#06051a', mid: '#2a1a55', low: '#0f0b2a', orb: '#fff1cf', sun: '#d6dcff', sunI: 2.0, hemi: '#a59ced', ground: '#2a1840', hemiI: 1.25, stars: 0.9, atmo: '#8c73ff', rim: '#9f88ff' },
    dawn:  { top: '#1c1f5a', mid: '#c8708a', low: '#3a2350', orb: '#ffd2a0', sun: '#ffd0a8', sunI: 2.4, hemi: '#f0bccb', ground: '#4a2a40', hemiI: 1.35, stars: 0.25, atmo: '#ff9a8a', rim: '#ff9fb5' },
    day:   { top: '#173f8f', mid: '#4a7acb', low: '#22396e', orb: '#fff6d8', sun: '#fff4e0', sunI: 2.9, hemi: '#d2e4ff', ground: '#4a603f', hemiI: 1.5, stars: 0.0, atmo: '#9fd0ff', rim: '#bfe0ff' },
    dusk:  { top: '#1a1446', mid: '#d0684a', low: '#3a1d48', orb: '#ffb07a', sun: '#ffb889', sunI: 2.4, hemi: '#ffc4a6', ground: '#4a2a40', hemiI: 1.35, stars: 0.3, atmo: '#ff8f6b', rim: '#ff9a7a' },
  };
  const KEYS = [[0, 'night'], [5, 'night'], [6.5, 'dawn'], [8.5, 'day'], [16.5, 'day'], [18.5, 'dusk'], [20.5, 'night'], [24, 'night']];
  const raw = (hex, out) => out.setStyle(hex, THREE.LinearSRGBColorSpace);
  const ca = new THREE.Color(), cb = new THREE.Color();
  let skyNow = SKY.night;
  function applySky() {
    const forced = new URLSearchParams(location.search).get('sky');
    const d = new Date(), hour = d.getHours() + d.getMinutes() / 60;
    let a = 'night', b = 'night', f = 0;
    if (SKY[forced]) { a = b = forced; }
    else for (let i = 0; i < KEYS.length - 1; i++) if (hour >= KEYS[i][0] && hour < KEYS[i + 1][0]) { a = KEYS[i][1]; b = KEYS[i + 1][1]; f = smooth(0, 1, (hour - KEYS[i][0]) / (KEYS[i + 1][0] - KEYS[i][0])); }
    const A = SKY[a], B = SKY[b];
    const mixRaw = (k, out) => out.lerpColors(raw(A[k], ca), raw(B[k], cb), f);
    const mixCol = (k, out) => out.lerpColors(ca.set(A[k]), cb.set(B[k]), f);
    const num = k => A[k] + (B[k] - A[k]) * f;
    mixRaw('top', skyMat.uniforms.uTop.value); mixRaw('mid', skyMat.uniforms.uMid.value); mixRaw('low', skyMat.uniforms.uLow.value);
    mixRaw('orb', skyMat.uniforms.uOrb.value); mixRaw('atmo', atmoMat.uniforms.uCol.value);
    mixCol('orb', orb.material.color);
    mixCol('sun', sun.color); sun.intensity = num('sunI');
    mixCol('hemi', hemi.color); mixCol('ground', hemi.groundColor); hemi.intensity = num('hemiI');
    mixCol('rim', rim.color);
    stars.material.opacity = num('stars');
    birds.visible = num('stars') < 0.5;
    skyNow = f < 0.5 ? A : B;
  }

  applySky();
  setInterval(applySky, 60000);

  /* ---------- The walker: a small Alfie who walks the route, with Norman ---------- */
  const walker = new THREE.Group();
  const body = new THREE.Group(); walker.add(body);
  let legL, legR, armL, armR;
  {
    const skin = '#f0c3a0', hair = '#5a3a26', beard = '#6b4a35', top = '#3d7be0', under = '#f6f2ff', jeans = '#1d1d24', shoe = '#f6f2ff';
    const k = new Kit();
    k.lit(G.box(0.46, 0.5, 0.28), top, { p: [0, 0.83, 0] });
    k.lit(G.box(0.2, 0.05, 0.02), under, { p: [0, 1.06, 0.14] });
    k.lit(G.box(0.36, 0.36, 0.34), skin, { p: [0, 1.3, 0] });
    // Short brown mullet: neat on top and at the sides, longer at the back.
    k.lit(G.box(0.4, 0.12, 0.38), hair, { p: [0, 1.51, -0.01] });
    k.lit(G.box(0.38, 0.05, 0.08), hair, { p: [0, 1.46, 0.15] });
    for (const x of [-0.19, 0.19]) k.lit(G.box(0.04, 0.12, 0.24), hair, { p: [x, 1.42, -0.04] });
    k.lit(G.box(0.38, 0.42, 0.08), hair, { p: [0, 1.29, -0.18] });
    // Short beard
    k.lit(G.box(0.34, 0.1, 0.03), beard, { p: [0, 1.16, 0.165] });
    for (const x of [-0.18, 0.18]) k.lit(G.box(0.02, 0.14, 0.18), beard, { p: [x, 1.2, 0.07] });
    k.lit(G.box(0.12, 0.025, 0.02), beard, { p: [0, 1.235, 0.175] });
    for (const x of [-0.08, 0.08]) k.lit(G.box(0.05, 0.05, 0.02), '#1b1430', { p: [x, 1.33, 0.175] });
    k.lit(G.box(0.3, 0.36, 0.14), '#ffc533', { p: [0, 0.86, -0.2] });
    k.lit(G.box(0.26, 0.12, 0.04), '#e0a91f', { p: [0, 0.78, -0.28] });
    body.add(k.finish());
    const limb = (x, y, parts) => {
      const pivot = new THREE.Group(); pivot.position.set(x, y, 0);
      const lk = new Kit(); parts.forEach(([g, c, o]) => lk.lit(g, c, o));
      pivot.add(lk.finish()); body.add(pivot); return pivot;
    };
    const leg = [[G.box(0.17, 0.48, 0.2), jeans, { p: [0, -0.24, 0] }], [G.box(0.19, 0.1, 0.28), shoe, { p: [0, -0.52, 0.04] }]];
    // Blue T-shirt sleeve over a white long sleeve
    const arm = [[G.box(0.15, 0.16, 0.17), top, { p: [0, -0.07, 0] }], [G.box(0.12, 0.28, 0.14), under, { p: [0, -0.28, 0] }], [G.box(0.12, 0.1, 0.12), skin, { p: [0, -0.47, 0] }]];
    legL = limb(-0.11, 0.58, leg); legR = limb(0.11, 0.58, leg);
    armL = limb(-0.3, 1.03, arm); armR = limb(0.3, 1.03, arm);
  }

  // Norman: black and tan sausage dog, trotting at Alfie's side.
  const dog = new THREE.Group(); dog.position.set(0.62, 0, 0.12); body.add(dog);
  let dogLegs = [], dogTail, dogHead;
  {
    const black = '#1d1818', tan = '#c58a4a';
    const k = new Kit();
    k.lit(G.box(0.2, 0.17, 0.62), black, { p: [0, 0.25, 0] });
    k.lit(G.box(0.16, 0.05, 0.5), tan, { p: [0, 0.165, 0.02] });
    k.lit(G.box(0.16, 0.12, 0.08), tan, { p: [0, 0.22, 0.29] });
    dog.add(k.finish());
    dogHead = new THREE.Group(); dogHead.position.set(0, 0.35, 0.33); dog.add(dogHead);
    const hk = new Kit();
    hk.lit(G.box(0.18, 0.17, 0.2), black, { p: [0, 0.03, 0.04] });
    hk.lit(G.box(0.11, 0.09, 0.16), tan, { p: [0, -0.01, 0.2] });
    hk.lit(G.box(0.05, 0.04, 0.03), '#0d0b0b', { p: [0, 0.02, 0.29] });
    for (const x of [-0.05, 0.05]) { hk.lit(G.box(0.035, 0.03, 0.02), '#0d0b0b', { p: [x, 0.06, 0.14] }); hk.lit(G.box(0.035, 0.02, 0.02), tan, { p: [x, 0.095, 0.14] }); }
    for (const x of [-0.1, 0.1]) hk.lit(G.box(0.03, 0.17, 0.11), black, { p: [x, -0.03, 0.02], r: [0, 0, x > 0 ? -0.2 : 0.2] });
    dogHead.add(hk.finish());
    for (const [x, z] of [[-0.07, 0.22], [0.07, 0.22], [-0.07, -0.22], [0.07, -0.22]]) {
      const pv = new THREE.Group(); pv.position.set(x, 0.17, z);
      const lk = new Kit(); lk.lit(G.box(0.06, 0.15, 0.06), tan, { p: [0, -0.08, 0] }); pv.add(lk.finish());
      dog.add(pv); dogLegs.push(pv);
    }
    dogTail = new THREE.Group(); dogTail.position.set(0, 0.31, -0.3); dog.add(dogTail);
    const tk = new Kit(); tk.lit(G.box(0.035, 0.035, 0.22), black, { p: [0, 0.05, -0.1], r: [0.5, 0, 0] }); dogTail.add(tk.finish());
  }
  walker.scale.setScalar(1.15);
  walker.traverse(o => { o.userData.noPick = true; });
  const hitArea = (r, y) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 10, 8), new THREE.MeshBasicMaterial({ visible: false })); m.position.y = y; return m; };
  dog.add(hitArea(0.55, 0.25));
  dog.traverse(o => { o.userData.noPick = false; o.userData.egg = 'norman'; });
  planet.add(walker);
  const AV_BACK = 0.2;
  const avP = new THREE.Vector3(), avT = new THREE.Vector3();
  let avU = null, avYaw = 0, walkPhase = 0, moveAmt = 0, waveT = 0;
  function updateWalker(dt, t, u) {
    const du = avU === null ? 0 : Math.abs(u - avU); avU = u;
    const goalMove = du > 1e-5 ? 1 : 0;
    const wasMoving = moveAmt > 0.5;
    moveAmt += (goalMove - moveAmt) * Math.min(1, dt * 8);
    if (wasMoving && moveAmt <= 0.5) waveT = 1.8;
    pathAt(clamp(u - AV_BACK / total, 0, 1), avP, avT);
    walker.position.copy(avP).multiplyScalar(R + 0.3);
    frameAt(avP, avT, walker.quaternion);
    avYaw += ((goalMove ? Math.PI : 0) - avYaw) * Math.min(1, dt * 5);
    body.rotation.y = avYaw;
    walkPhase += dt * 11 * moveAmt;
    const sw = Math.sin(walkPhase) * moveAmt;
    legL.rotation.x = sw * 0.7; legR.rotation.x = -sw * 0.7;
    armL.rotation.x = -sw * 0.6;
    body.position.y = Math.abs(Math.sin(walkPhase)) * 0.06 * moveAmt + Math.sin(t * 2) * 0.008;
    if (waveT > 0) {
      waveT -= dt;
      armR.rotation.x = 0; armR.rotation.z += (2.5 + Math.sin(t * 14) * 0.35 - armR.rotation.z) * Math.min(1, dt * 10);
    } else {
      armR.rotation.z *= 0.85; armR.rotation.x = sw * 0.6;
    }
    // Norman trots faster than Alfie walks, and his tail never stops.
    const trot = Math.sin(walkPhase * 1.6) * moveAmt;
    dogLegs.forEach((l, i) => { l.rotation.x = (i % 2 ? trot : -trot) * 0.8; });
    dogTail.rotation.y = Math.sin(t * (moveAmt > 0.5 ? 16 : 7)) * 0.6;
    dogHead.rotation.x = moveAmt > 0.5 ? Math.sin(walkPhase * 1.6) * 0.06 : Math.sin(t * 1.3) * 0.05 - 0.05;
    dog.position.y = Math.abs(trot) * 0.03;
  }

  /* ---------- Easter eggs ---------- */
  const eggRoots = [];
  {
    const EGG_BUILD = {
      lol(k) {
        k.lit(G.cyl(0.55, 0.65, 0.3, 6), '#cfc6e0', { p: [0, 0.15, 0] });
        k.lit(new THREE.TorusGeometry(0.5, 0.05, 4, 6), '#ffc533', { p: [0, 0.33, 0], r: [Math.PI / 2, 0, 0] });
        const c = k.dyn(dm(new THREE.OctahedronGeometry(0.4), '#5fd4ff', { p: [0, 1.0, 0] }, { glow: true })); c.scale.set(1, 1.7, 1);
        k.updates.push(t => { c.rotation.y = t * 0.8; c.position.y = 1.0 + Math.sin(t * 1.5) * 0.08; });
      },
      fortnite(k) {
        k.lit(G.box(0.7, 0.6, 0.7), '#8b6cff', { p: [0, 0.3, 0] });
        k.lit(G.box(0.72, 0.1, 0.72), '#57c1ff', { p: [0, 0.45, 0] });
        k.lit(G.cyl(0.01, 0.01, 1.2, 4), '#f6f2ff', { p: [0, 1.2, 0] });
        const b = k.dyn(dm(G.sph(0.42, 10, 8), '#57c1ff', { p: [0, 2.0, 0] }));
        k.updates.push(t => { b.position.y = 2.0 + Math.sin(t * 1.2) * 0.1; });
      },
      rocket(k) {
        k.lit(G.box(0.5, 0.16, 0.85), '#3b82f6', { p: [0, 0.28, 0] });
        k.lit(G.box(0.4, 0.16, 0.4), '#1d2a52', { p: [0, 0.44, -0.08] });
        for (const [x, z] of [[-0.27, 0.27], [0.27, 0.27], [-0.27, -0.27], [0.27, -0.27]]) k.lit(G.cyl(0.12, 0.12, 0.1, 10), '#111111', { p: [x, 0.14, z], r: [0, 0, Math.PI / 2] });
        k.glow(G.cone(0.1, 0.35, 6), '#ff8a3d', { p: [0, 0.3, -0.6], r: [-Math.PI / 2, 0, 0] });
        k.lit(G.ico(0.5, 1), '#e8e6ee', { p: [0, 0.5, 1.3] });
      },
      peak(k) {
        k.lit(G.cone(1.1, 2.2, 6), '#8a7f9a', { p: [0, 1.1, 0] });
        k.lit(G.cone(0.42, 0.85, 6), '#f6f2ff', { p: [0, 1.79, 0] });
        k.lit(G.cyl(0.02, 0.02, 0.6, 4), '#3a2a50', { p: [0, 2.4, 0] });
        const f = k.dyn(dm(G.box(0.32, 0.18, 0.02), '#ff6b5a', { p: [0.16, 2.6, 0] }));
        k.updates.push(t => { f.rotation.y = Math.sin(t * 3) * 0.3; });
      },
      balatro(k) {
        const card = k.dyn(new THREE.Group()); card.position.y = 0.95;
        card.add(dm(G.box(0.9, 1.3, 0.05), '#f6f2ff'));
        card.add(dm(G.box(0.8, 1.2, 0.06), '#ff4d4d'), dm(G.box(0.72, 1.12, 0.07), '#f6f2ff'));
        card.add(dm(G.sph(0.18, 10, 8), '#57c1ff', { p: [0, 0.05, 0.05] }, { glow: true }));
        card.add(dm(G.cone(0.14, 0.3, 4), '#ff4d4d', { p: [0, 0.35, 0.05] }));
        k.updates.push(t => { card.rotation.y = t * 0.6; card.position.y = 0.95 + Math.sin(t * 1.4) * 0.06; });
      },
      chained(k) {
        k.lit(G.cyl(0.55, 0.65, 0.9, 8), '#b8aecb', { p: [0, 0.45, 0] });
        [['#ff8a3d', -0.28], ['#59d499', 0.28]].forEach(([c, x]) => {
          k.lit(G.box(0.18, 0.3, 0.14), c, { p: [x, 1.08, 0] });
          k.lit(G.box(0.16, 0.16, 0.16), '#f0c3a0', { p: [x, 1.32, 0] });
        });
        for (let i = 0; i < 4; i++) k.lit(new THREE.TorusGeometry(0.045, 0.012, 4, 8), '#c9c2d8', { p: [-0.15 + i * 0.1, 1.1, 0.02], r: [0, i % 2 ? Math.PI / 2 : 0, 0] });
      },
      fans(k) {
        const flags = [
          ['#111111', '#f6f2ff', '#e1251b'],  // G2
          ['#ff5fa8', '#f6f2ff', '#ff5fa8'],  // Paper Rex
          ['#f6f2ff', '#132257', '#f6f2ff'],  // Tottenham
        ];
        flags.forEach((cols, i) => {
          const x = (i - 1) * 0.55;
          k.lit(G.cyl(0.025, 0.03, 1.5, 5), '#3a2a50', { p: [x, 0.75, 0] });
          const f = k.dyn(new THREE.Group()); f.position.set(x, 1.32, 0);
          cols.forEach((c, j) => f.add(dm(G.box(0.42, 0.1, 0.02), c, { p: [0.22, 0.1 - j * 0.1, 0] })));
          k.updates.push(t => { f.rotation.y = Math.sin(t * 2.4 + i) * 0.35; });
        });
      },
    };
    const tangent = new THREE.Vector3();
    for (const e of EGGS) {
      if (!EGG_BUILD[e.id]) continue;
      const k = new Kit();
      EGG_BUILD[e.id](k);
      const root = k.finish();
      tangent.crossVectors(e.dir, Math.abs(e.dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : Y).normalize();
      root.position.copy(e.dir).multiplyScalar(R + info(e.dir).h - 0.05);
      frameAt(e.dir, tangent, root.quaternion);
      root.add(hitArea(1.4, 1.0));
      root.traverse(o => { o.userData.egg = e.id; });
      planet.add(root); eggRoots.push(root);
      updates.push(...k.updates);
    }
    // The travel plane circles the planet.
    const plane = new THREE.Group();
    const pk = new Kit();
    pk.lit(G.box(0.22, 0.22, 1.1), '#f6f2ff', { p: [0, 0, 0] });
    pk.lit(G.box(1.4, 0.04, 0.32), '#f6f2ff', { p: [0, 0, 0.05] });
    pk.lit(G.box(0.5, 0.04, 0.2), '#f6f2ff', { p: [0, 0.05, -0.48] });
    pk.lit(G.box(0.04, 0.3, 0.22), '#ff6b5a', { p: [0, 0.18, -0.48] });
    pk.lit(G.box(0.24, 0.06, 0.9), '#ff6b5a', { p: [0, -0.04, 0] });
    pk.glow(G.box(0.18, 0.06, 0.02), '#8fd3ff', { p: [0, 0.06, 0.56] });
    plane.add(pk.finish());
    plane.traverse(o => { o.userData.egg = 'travel'; });
    const orbit = new THREE.Group(); orbit.rotation.set(0.5, 0, 0.35); scene.add(orbit);
    plane.position.set(0, 0, R + 4.2); plane.rotation.y = Math.PI / 2; orbit.add(plane);
    eggRoots.push(orbit);
    updates.push(t => { orbit.rotation.y = t * 0.12; plane.rotation.z = Math.sin(t) * 0.1; });
  }

  /* ---------- Pins (free roam) ---------- */
  const pins = LANDMARKS.map(l => {
    const b = document.createElement('button');
    b.className = 'pin hidden'; b.style.setProperty('--c', l.color); b.tabIndex = -1;
    b.innerHTML = `<span class="pd"><svg><use href="#i-${l.id}"/></svg></span>${l.label}`;
    b.addEventListener('click', () => onPick(l.id));
    pinsEl.appendChild(b);
    return b;
  });

  /* ---------- Controls for free roam ---------- */
  const controls = new OrbitControls(camera, canvas);
  controls.enabled = false; controls.enablePan = false; controls.enableDamping = true; controls.dampingFactor = 0.07;
  controls.minDistance = R * 1.7; controls.maxDistance = R * 6; controls.rotateSpeed = 0.6;
  controls.autoRotateSpeed = 0.5;

  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let down = null;
  // The first thing under the pointer wins, and the planet itself counts, so a click can
  // never reach a landmark or egg hidden on the far side.
  function pickAt(e) {
    ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects([terrain, ...LANDMARKS.map(l => l.root), ...eggRoots, dog], true)
      .find(h => h.object === terrain || h.object.userData.lm || h.object.userData.egg);
    return !hit || hit.object === terrain ? null : hit.object.userData;
  }
  canvas.addEventListener('pointermove', e => {
    if (!roam || e.buttons) return;
    canvas.style.cursor = pickAt(e) ? 'pointer' : '';
  });
  canvas.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; poke(); });
  canvas.addEventListener('pointerup', e => {
    if (!roam || !down) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y); down = null;
    if (moved > 6) return;
    const hit = pickAt(e);
    if (!hit) return;
    if (hit.egg) onEgg(hit.egg);
    else onPick(hit.lm);
  });
  controls.addEventListener('start', () => { controls.autoRotate = false; poke(); });

  /* ---------- Camera choreography ---------- */
  let sGoal = 0, sCur = 0, panelW = 0, roam = false, flying = null, paused = false, travel = null, lastU = LANDMARKS[0].u;
  const qWalk = new THREE.Quaternion(), qSway = new THREE.Quaternion();
  const heroPos = new THREE.Vector3(), walkPos = new THREE.Vector3(), walkTarget = new THREE.Vector3(), curTarget = new THREE.Vector3();
  const offset = { x: 0, y: 0 };
  const tv = () => Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const fitDist = (r, fw, fh) => (r * 1.1) / Math.min(tv() * fh, tv() * camera.aspect * fw);

  function walkState(s) {
    const small = innerWidth <= 860;
    const n = LANDMARKS.length;
    const i = clamp(Math.floor(s), 1, n), f = s >= n ? 0 : clamp(s - i, 0, 1);
    const a = LANDMARKS[i - 1], b = LANDMARKS[Math.min(i, n - 1)];
    const e = f;
    const u = a.u + (b.u - a.u) * e, h = a.h + (b.h - a.h) * e;
    lastU = u;
    pathAt(u, tmpP, tmpT);
    frameAt(tmpP, tmpT, qWalk).invert();

    const k = easeIO(clamp(s, 0, 1));
    // Hero: the whole planet. Walk: standing just behind the current landmark.
    const heroD = fitDist(R * (small ? 1.25 : 1.5), small ? 1 : 0.5, small ? 0.55 : 1);
    heroPos.set(0, heroD * 0.18, heroD);
    const r = 1.8 + h * 0.5;
    const baseY = 4.2 + h * 0.5, baseZ = 11.5 + h * 0.9;
    const need = fitDist(r, small ? 1 : (innerWidth - panelW * 0.6) / innerWidth, small ? 0.42 : 1);
    const fit = Math.max(1, need / Math.hypot(baseY, baseZ));
    walkTarget.set(0, R + 0.3 + h * 0.3, -1.2);
    walkPos.set(0, walkTarget.y + baseY * fit, baseZ * fit);
    const pos = heroPos.clone().lerp(walkPos, k);
    const target = new THREE.Vector3().lerp(walkTarget, k);
    const off = small
      ? { x: 0, y: -innerHeight * 0.2 * (1 - k) + innerHeight * 0.27 * k }
      : { x: -innerWidth * 0.25 * (1 - k) + panelW * 0.3 * k, y: 0 };
    return { pos, target, off, k };
  }

  function fly(toPos, toTarget, toOff, dur, done) {
    const p0 = camera.position.clone(), t0 = curTarget.clone(), o0 = { ...offset };
    flying = { start: performance.now(), dur: reduceMotion ? 1 : dur, step: e => {
      camera.position.lerpVectors(p0, toPos, e); curTarget.lerpVectors(t0, toTarget, e);
      offset.x = o0.x + (toOff.x - o0.x) * e; offset.y = o0.y + (toOff.y - o0.y) * e;
      camera.lookAt(curTarget);
    }, done };
  }

  /* ---------- Loop ---------- */
  let last = performance.now(), t = 0, intro = reduceMotion ? 1 : 0, lastPoke = performance.now(), frameNo = 0;
  const perf = { n: 0, sum: 0, checked: false };
  function poke() { lastPoke = performance.now(); }
  const wp = new THREE.Vector3(), camDir = new THREE.Vector3();

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (paused) return;
    frameNo++;
    // Idle: halve the frame rate when nothing is moving.
    if (!roam && !flying && !travel && now - lastPoke > 3500 && frameNo % 2) return;
    t += dt;

    if (!perf.checked && frameNo > 20) {
      perf.n++; perf.sum += dt;
      if (perf.n === 90) {
        perf.checked = true;
        if (perf.sum / perf.n > 0.024 && dpr > 1) { dpr = 1; renderer.setPixelRatio(1); renderer.setSize(innerWidth, innerHeight, false); }
      }
    }

    uTime.value = reduceMotion ? 0 : t;
    if (!reduceMotion) for (const u of updates) u(t);

    if (flying) {
      const k = Math.min(1, (now - flying.start) / flying.dur);
      flying.step(easeIO(k));
      if (k === 1) { const d = flying.done; flying = null; d && d(); }
    } else if (roam) {
      controls.update();
    } else {
      let lift = 0;
      if (travel) {
        const k = Math.min(1, (now - travel.start) / travel.dur);
        sCur = travel.from + (travel.to - travel.from) * easeIO(k);
        if (travel.hop) lift = Math.sin(Math.PI * k);
        if (k === 1) travel = null;
      }
      intro = Math.min(1, intro + dt);
      const st = walkState(sCur);
      if (intro < 1) st.pos.multiplyScalar(1 + 2.4 * (1 - easeOut(intro)));
      // Hop: rise to a bird's-eye view while the planet turns, then swoop back down.
      if (lift > 0) {
        st.pos.sub(st.target).multiplyScalar(1 + 1.9 * lift).add(st.target);
        st.pos.y += R * 0.9 * lift;
        st.target.y -= R * 0.35 * lift;
      }
      camera.position.copy(st.pos); curTarget.copy(st.target); camera.lookAt(curTarget);
      offset.x = st.off.x; offset.y = st.off.y;
      planet.quaternion.copy(qWalk);
      updateWalker(dt, t, lastU);
      if (!reduceMotion && st.k < 1) planet.quaternion.premultiply(qSway.setFromAxisAngle(Y, Math.sin(t * 0.15) * 0.5 * (1 - st.k)));
    }
    camera.setViewOffset(innerWidth, innerHeight, offset.x, offset.y, innerWidth, innerHeight);

    renderer.render(scene, camera);

    if (roam) {
      camera.getWorldDirection(camDir);
      LANDMARKS.forEach((l, i) => {
        wp.copy(l.top); l.root.localToWorld(wp);
        const facing = wp.clone().normalize().dot(camera.position.clone().sub(wp).normalize()) > 0.15;
        wp.project(camera);
        pins[i].classList.toggle('hidden', !facing || wp.z > 1);
        pins[i].style.left = ((wp.x * 0.5 + 0.5) * innerWidth).toFixed(1) + 'px';
        pins[i].style.top = ((-wp.y * 0.5 + 0.5) * innerHeight).toFixed(1) + 'px';
      });
    }
  }
  requestAnimationFrame(frame);

  function onResize() {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight, false);
    poke();
  }
  addEventListener('resize', onResize);

  return {
    // Land at a stop instantly (used behind the plane transfer's clouds), then wave hello.
    jumpTo(s) { sGoal = s; sCur = s; travel = null; avU = null; waveT = 1.8; poke(); },
    setStop(s, { hop = false } = {}) {
      if (s === sGoal) return;
      const d = Math.abs(s - sCur);
      travel = reduceMotion ? null : { from: sCur, to: s, start: performance.now(), hop, dur: hop ? 1500 : clamp(1500 * Math.sqrt(d), 1100, 3200) };
      if (reduceMotion) sCur = s;
      sGoal = s; poke();
    },
    setPanelWidth(w) { panelW = w; },
    pause(p) { paused = p; if (!p) { last = performance.now(); poke(); } },
    get roaming() { return roam; },
    enterRoam() {
      if (roam) return;
      roam = true; poke();
      // Fly out from wherever the camera is; if it was never placed (page not yet drawn), use a default view.
      const to = camera.position.lengthSq() > R * R ? camera.position.clone().normalize().multiplyScalar(R * 3.6) : new THREE.Vector3(0, R * 0.9, R * 3.4);
      to.y = Math.max(to.y, R * 0.8);
      fly(to, new THREE.Vector3(), { x: 0, y: 0 }, 1300, () => {
        controls.target.set(0, 0, 0); controls.enabled = true; controls.update();
        pins.forEach(p => (p.tabIndex = 0));
      });
    },
    exitRoam(done) {
      if (!roam) { done && done(); return; }
      controls.enabled = false; controls.autoRotate = false;
      pins.forEach(p => { p.tabIndex = -1; p.classList.add('hidden'); });
      const st = walkState(sGoal); sCur = sGoal; travel = null;
      const startQ = planet.quaternion.clone();
      const endQ = qWalk.clone();
      const p0 = camera.position.clone(), t0 = curTarget.clone(), o0 = { ...offset };
      flying = { start: performance.now(), dur: reduceMotion ? 1 : 1300, step: e => {
        camera.position.lerpVectors(p0, st.pos, e); curTarget.lerpVectors(t0, st.target, e);
        offset.x = o0.x + (st.off.x - o0.x) * e; offset.y = o0.y + (st.off.y - o0.y) * e;
        planet.quaternion.slerpQuaternions(startQ, endQ, e);
        camera.lookAt(curTarget);
      }, done: () => { roam = false; done && done(); } };
    },
    snapshot(size = 900) {
      const r2 = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      r2.setSize(size, size); r2.outputColorSpace = THREE.SRGBColorSpace; r2.toneMapping = THREE.ACESFilmicToneMapping; r2.toneMappingExposure = 1.1;
      const cam = new THREE.PerspectiveCamera(40, 1, 0.1, 1200);
      const d = (R * 1.72) / Math.tan(THREE.MathUtils.degToRad(20));
      cam.position.set(0, d * 0.18, d); cam.lookAt(0, 0, 0);
      space.visible = false; clouds.visible = true;
      r2.render(scene, cam);
      const url = r2.domElement.toDataURL('image/webp', 0.9);
      space.visible = true; r2.dispose();
      return url;
    },
  };
}
