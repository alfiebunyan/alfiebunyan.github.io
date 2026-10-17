const html = document.documentElement;

// Visit stats: privacy-friendly GoatCounter (no cookies, no banner needed).
// Paste your GoatCounter code here (the "alfie" in alfie.goatcounter.com) to switch it on.
const GOATCOUNTER = 'alfiebunyan';
if (GOATCOUNTER) {
  const s = document.createElement('script');
  s.async = true; s.src = 'https://gc.zgo.at/count.js'; s.dataset.goatcounter = `https://${GOATCOUNTER}.goatcounter.com/count`;
  document.head.appendChild(s);
}
const sent = new Set();
function track(name, once = true) {
  if (!GOATCOUNTER || (once && sent.has(name))) return;
  sent.add(name);
  const fire = () => window.goatcounter && window.goatcounter.count && window.goatcounter.count({ path: name, title: name, event: true });
  window.goatcounter && window.goatcounter.count ? fire() : setTimeout(fire, 1500);
}
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const stops = $$('.stop');
let planet = null, planetLoading = null;

// Looping clips stay still for people who prefer reduced motion; they can press play instead.
if (reduceMotion) $$('video[autoplay]').forEach(v => { v.removeAttribute('autoplay'); v.pause(); v.controls = true; });

/* ---------- Hero title letters ---------- */
const h1 = $('#hero-title');
h1.setAttribute('aria-label', h1.textContent);
let li = 0;
h1.innerHTML = h1.textContent.split(' ').map(word => `<span class="w">${[...word].map(ch => `<span class="l" aria-hidden="true" style="animation-delay:${(0.04 * li++).toFixed(2)}s">${ch}</span>`).join('')}</span>`).join(' ');

/* ---------- Route map ---------- */
const route = $('#route');
const stopColor = s => getComputedStyle(s).getPropertyValue('--c').trim();
route.innerHTML = '<span class="route-fill"></span>' + stops.map((s, i) =>
  `<a href="#${s.id || 'top'}" style="--c:${stopColor(s)}" data-i="${i}"><span class="dot"><svg><use href="#i-${s.dataset.stop}"/></svg></span><span class="lbl">${s.dataset.label}</span></a>`
).join('') + '<span class="route-count" id="route-count"></span>';
const routeLinks = $$('a', route);

// "Next stop" button at the end of every walk panel.
stops.forEach((s, i) => {
  const next = stops[i + 1];
  if (i === 0 || !next) return;
  const div = document.createElement('div');
  div.className = 'next-stop';
  div.innerHTML = `<button type="button" style="--nc:${stopColor(next)}"><span class="nd"><svg><use href="#i-${next.dataset.stop}"/></svg></span>Next stop: ${next.dataset.label} &darr;</button><span>or keep scrolling</span>`;
  div.querySelector('button').addEventListener('click', () => go(i + 1));
  s.appendChild(div);
});

const isWalk = () => html.dataset.mode === 'walk';
const roaming = () => html.classList.contains('roam');
const modalOpen = () => !!$('.modal.open');

/* ---------- Shared: which stop is current ---------- */
let current = -1, finished = false;
function setCurrent(idx) {
  if (idx === current) return;
  current = idx;
  routeLinks.forEach((a, i) => { a.classList.toggle('current', i === idx); a.classList.toggle('passed', i < idx); a.toggleAttribute('aria-current', i === idx); });
  $('#route-count').textContent = idx === 0 ? 'START' : `STOP ${idx} OF ${stops.length - 1}`;
  $('#topbar-label').textContent = idx === 0 ? 'Start' : `${idx}/${stops.length - 1} · ${stops[idx].dataset.label}`;
  html.classList.toggle('past-hero', idx > 0);
  const p = idx / (stops.length - 1);
  route.style.setProperty('--p', p);
  $('.topbar').style.setProperty('--p', p);
  if (idx === stops.length - 1 && !finished && isWalk()) { finished = true; achievement('Journey complete: you walked the whole planet'); }
  if (idx > 0) track(`${isWalk() ? 'walk' : 'read'}/stop-${idx}-${stops[idx].dataset.stop}`);
  if (isWalk() && idx > 0) $('#sr-stop').textContent = `Stop ${idx} of ${stops.length - 1}: ${stops[idx].dataset.label}`;
}

/* ---------- Read mode: ordinary scrolling ---------- */
function readScroll() {
  if (isWalk()) return;
  let idx = 0;
  stops.forEach((st, i) => { if (st.getBoundingClientRect().top <= innerHeight * 0.45) idx = i; });
  setCurrent(idx);
}
let ticking = false;
addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(() => { ticking = false; readScroll(); }); } }, { passive: true });

// Draw each heading's squiggle the first time it comes into view.
const seenObs = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('seen'); seenObs.unobserve(e.target); } }), { threshold: 0.15 });
stops.forEach(s => seenObs.observe(s));

/* ---------- Walk mode: one stop at a time ---------- */
let lastMove = 0;
function go(i, { focus = true } = {}) {
  i = Math.max(0, Math.min(stops.length - 1, i));
  if (!isWalk()) { stops[i].scrollIntoView({ behavior: reduceMotion ? 'instant' : 'smooth', block: 'start' }); return; }
  // Already here (e.g. scrolling past the last stop or above the first): nothing to do.
  if (i === current && stops[i].classList.contains('active')) return;
  if (transferring) return;
  // Next stop: walk. Two or three away: hop over the planet. Further: take the plane.
  const dist = current >= 0 ? Math.abs(i - current) : 0;
  if (planet && dist >= 4 && !reduceMotion) { planeTransfer(i, focus); return; }
  arrive(i, focus, dist >= 2);
}

// A one-second hop: a plane crosses with a cloud wall behind it, and while the clouds
// cover the screen the walk jumps straight to the destination.
let transferring = false;
function planeTransfer(i, focus) {
  transferring = true;
  lastMove = performance.now();
  const fx = $('#transfer');
  $('#transfer-to').textContent = i === 0 ? 'Back to the start' : `Flying to: ${stops[i].dataset.label}`;
  fx.classList.remove('go'); void fx.offsetWidth; fx.classList.add('go');
  setTimeout(() => {
    html.classList.add('booting');
    arrive(i, focus);
    planet.jumpTo(i);
    setTimeout(() => html.classList.remove('booting'), 60);
  }, 500);
  setTimeout(() => { fx.classList.remove('go'); transferring = false; }, 1050);
}

function arrive(i, focus, hop = false) {
  lastMove = performance.now();
  stops.forEach((s, k) => { s.classList.toggle('active', k === i); s.inert = k !== i; });
  stops[i].scrollTop = 0;
  edgeSince = { top: lastMove, bottom: 0 };
  prevEdge = panelEdges(stops[i]);
  if (planet) planet.setStop(i, { hop });
  setCurrent(i);
  history.replaceState(null, '', location.pathname + location.search + (i ? '#' + stops[i].id : ''));
  if (focus && i > 0) setTimeout(() => stops[i].focus({ preventScroll: true }), 350);
}
stops.forEach(s => { if (!s.classList.contains('hero')) s.tabIndex = -1; });

// A panel hands over to the next stop when you keep scrolling past its end. To stop
// trackpad momentum from skipping a stop, the push has to be a new one: a fresh
// gesture after a pause, a clear speed-up (a second swipe during momentum), or
// simply resting at the edge for a moment.
let edgeSince = { top: 0, bottom: 0 }, prevEdge = { top: true, bottom: true }, wheelAcc = 0, wheelTimer, lastWheel = 0, lastAbs = 0, gestureStart = 0;
const panelEdges = p => ({ top: p.scrollTop <= 1, bottom: Math.ceil(p.scrollTop + p.clientHeight) >= p.scrollHeight - 3 });
stops.forEach(s => s.addEventListener('scroll', () => {
  const e = panelEdges(s), now = performance.now();
  edgeSince.top = e.top ? (edgeSince.top || now) : 0;
  edgeSince.bottom = e.bottom ? (edgeSince.bottom || now) : 0;
}, { passive: true }));
function settledAt(dir, since = performance.now() - 250) {
  const p = stops[current];
  if (!p || p.classList.contains('hero')) return true;
  const e = panelEdges(p), key = dir > 0 ? 'bottom' : 'top';
  if (!e[key]) return false;
  const now = performance.now();
  // At the edge with no scroll seen getting there (a short panel, or a jump): it has been resting.
  if (!edgeSince[key]) edgeSince[key] = now - 10000;
  return edgeSince[key] <= since || now - edgeSince[key] > 900;
}
addEventListener('wheel', e => {
  if (!isWalk() || roaming() || modalOpen()) return;
  const now = performance.now();
  const px = e.deltaY * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? innerHeight : 1), abs = Math.abs(px);
  if (now - lastWheel > 200 || abs > lastAbs * 1.6 + 6) gestureStart = now;
  lastWheel = now; lastAbs = abs;
  const panel = stops[current];
  // Note the moment the panel arrives at an edge, judged from the wheel events themselves
  // so it does not depend on when the browser delivers scroll events.
  if (panel && !panel.classList.contains('hero')) {
    const ed = panelEdges(panel);
    for (const k of ['top', 'bottom']) { if (ed[k] && !prevEdge[k]) edgeSince[k] = now; if (!ed[k]) edgeSince[k] = 0; }
    prevEdge = ed;
  }
  // Scrolling over the planet still reads the panel.
  if (panel && !panel.classList.contains('hero') && !panel.contains(e.target)) panel.scrollTop += px;
  if (now - lastMove < 800) return;
  const dir = Math.sign(px);
  if (!dir || !settledAt(dir, gestureStart)) { wheelAcc = 0; return; }
  wheelAcc += abs;
  clearTimeout(wheelTimer); wheelTimer = setTimeout(() => (wheelAcc = 0), 300);
  if (wheelAcc > 60) { wheelAcc = 0; go(current + dir); }
}, { passive: true });

let touchY = null, touchEdge = null;
addEventListener('touchstart', e => {
  if (!isWalk() || roaming()) return;
  touchY = e.touches[0].clientY;
  touchEdge = { down: settledAt(1), up: settledAt(-1) };
}, { passive: true });
addEventListener('touchend', e => {
  if (touchY === null || !isWalk() || roaming()) return;
  const dy = touchY - e.changedTouches[0].clientY; touchY = null;
  if (Math.abs(dy) < 70 || performance.now() - lastMove < 700) return;
  if (dy > 0 && touchEdge.down) go(current + 1);
  if (dy < 0 && touchEdge.up) go(current - 1);
}, { passive: true });

addEventListener('keydown', e => {
  if (!isWalk() || roaming() || modalOpen()) return;
  if (e.target.closest && e.target.closest('input, textarea, select, video')) return;
  const down = ['ArrowDown', 'PageDown', ' '].includes(e.key), up = ['ArrowUp', 'PageUp'].includes(e.key);
  if (e.key === 'ArrowRight') { e.preventDefault(); go(current + 1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); go(current - 1); }
  else if ((down || up) && performance.now() - lastMove > 500) {
    const p = stops[current], edges = p && panelEdges(p);
    if (current === 0 || (down && edges.bottom) || (up && edges.top)) { e.preventDefault(); go(current + (down ? 1 : -1)); }
  }
});

// In-page links (#about, the route map, "Get in touch") move along the walk instead of scrolling.
document.addEventListener('click', e => {
  const a = e.target.closest('a[href^="#"]');
  if (!a || !isWalk()) return;
  const el = a.getAttribute('href') === '#top' ? stops[0] : document.querySelector(a.getAttribute('href'));
  const stop = el && el.closest('.stop');
  if (!stop) return;
  e.preventDefault();
  if (roaming()) leaveRoam(stop.dataset.stop); else go(stops.indexOf(stop));
});

/* ---------- Walk / Read ---------- */
const modeBtns = $$('[data-set-mode]');
function syncModeButtons() { $$('.modes button').forEach(b => b.setAttribute('aria-checked', b.dataset.setMode === html.dataset.mode)); }
function panelWidth() { return isWalk() && innerWidth > 860 ? stops[1].offsetWidth : 0; }
addEventListener('resize', () => { if (planet) planet.setPanelWidth(panelWidth()); });

async function ensurePlanet() {
  if (planet) return planet;
  if (!planetLoading) {
    planetLoading = import('./planet.js?v=26').then(({ createPlanet, EGGS }) => {
      eggs = EGGS;
      planet = createPlanet({ canvas: $('#world'), pinsEl: $('#pins'), onPick: id => leaveRoam(id), onEgg: foundEgg });
      // Regenerates assets/planet.webp (the Read mode hero): run __planetSnapshot() in the console.
      window.__planetSnapshot = planet.snapshot;
      $('#world').classList.add('ready');
      html.classList.add('planet-ready');
      return planet;
    });
  }
  return planetLoading;
}

async function setMode(mode, { save = true, start } = {}) {
  if (mode === html.dataset.mode && planet && !start) return;
  const keep = start ?? Math.max(0, current);
  if (roaming()) leaveRoam();
  html.dataset.mode = mode;
  syncModeButtons();
  if (save) { try { localStorage.setItem('mode', mode); } catch (e) {} }
  const q = new URLSearchParams(location.search);
  if (q.has('mode')) { q.delete('mode'); history.replaceState(null, '', location.pathname + (q.size ? '?' + q : '') + location.hash); }
  if (mode === 'walk') {
    current = -1;
    go(keep, { focus: false });
    try {
      const p = await ensurePlanet();
      p.pause(false); p.setPanelWidth(panelWidth()); p.setStop(current);
    } catch (err) {
      console.error(err);
      achievement('The 3D planet could not load, so here is the reading view');
      setMode('read', { save: false });
    }
  } else {
    stops.forEach(s => { s.classList.remove('active'); s.inert = false; });
    if (planet) planet.pause(true);
    if (keep > 0) stops[keep].scrollIntoView({ behavior: 'instant', block: 'start' });
    current = -1; readScroll();
  }
}
modeBtns.forEach(b => b.addEventListener('click', () => { setMode(b.dataset.setMode); track(`mode/${b.dataset.setMode}`, false); }));
// The Walk / Read switch behaves like a proper radio group with the arrow keys.
$('.modes').addEventListener('keydown', e => {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault(); e.stopPropagation();
  const next = html.dataset.mode === 'walk' ? 'read' : 'walk';
  setMode(next); track(`mode/${next}`, false);
  $(`.modes [data-set-mode="${next}"]`).focus();
});
$$('a[download]').forEach(a => a.addEventListener('click', () => track('cv-download', false)));

/* ---------- Easter eggs ---------- */
let eggs = [];
const found = new Set();
function foundEgg(id) {
  const egg = eggs.find(e => e.id === id);
  if (!egg) return;
  const isNew = !found.has(id);
  if (isNew) track(`egg/${id}`);
  found.add(id);
  $('#egg-count').textContent = `${found.size}/${eggs.length}`;
  achievement(isNew ? `Easter egg ${found.size}/${eggs.length}: ${egg.text}` : egg.text);
  if (isNew && found.size === eggs.length) setTimeout(() => achievement('Completionist: every easter egg found. Thanks for exploring!'), 4200);
}

/* ---------- Free roam ---------- */
function enterRoam() {
  if (!planet) return;
  html.classList.add('roam');
  planet.enterRoam();
  track('roam/start');
  achievement('Free roam unlocked');
  setTimeout(() => $('#roam-exit').focus({ preventScroll: true }), 50);
}
function leaveRoam(id) {
  if (!roaming()) return;
  html.classList.remove('roam');
  planet.exitRoam(() => {
    const i = id ? stops.findIndex(s => s.dataset.stop === id) : -1;
    if (i >= 0) go(i);
  });
}
$('#roam-enter').addEventListener('click', enterRoam);
$('#roam-exit').addEventListener('click', () => leaveRoam());

/* ---------- Documents, images ---------- */
function openDoc(src, title) {
  track(`doc/${src.split('/').pop()}`, false);
  $('#doc-title').textContent = title; $('#doc-frame').src = src;
  $('#doc-modal').classList.add('open'); $('#doc-close').focus();
}
function closeDoc() { $('#doc-modal').classList.remove('open'); $('#doc-frame').src = 'about:blank'; }
window.closeDoc = closeDoc; // the critique pages call this from inside the viewer
$$('[data-doc]').forEach(b => b.addEventListener('click', () => openDoc(b.dataset.doc, b.dataset.title)));
$('#doc-close').addEventListener('click', closeDoc);
$('#doc-modal').addEventListener('click', e => { if (e.target.id === 'doc-modal') closeDoc(); });
$$('[data-zoom]').forEach(el => el.addEventListener('click', () => {
  const full = $('#img-full');
  full.src = el.dataset.zoom || el.src;
  full.alt = el.dataset.alt || el.alt || '';
  $('#img-modal').classList.add('open');
}));
$('#img-modal').addEventListener('click', () => $('#img-modal').classList.remove('open'));

/* ---------- Contact form ---------- */
$('#contact-form').addEventListener('submit', async e => {
  e.preventDefault();
  const form = e.currentTarget, status = $('#contact-status'), btn = form.querySelector('button[type=submit]');
  btn.disabled = true; btn.textContent = 'Sending...'; status.className = 'status'; status.textContent = '';
  try {
    const res = await fetch('https://api.web3forms.com/submit', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    const data = await res.json();
    if (!data.success) throw new Error(data.message);
    status.className = 'status ok'; status.textContent = 'Signal received. I will get back to you soon.';
    form.reset(); achievement('Message in a bottle: signal sent'); track('contact/sent', false);
  } catch (err) {
    status.className = 'status err'; status.textContent = 'Something went wrong. Please try LinkedIn instead.';
  }
  btn.disabled = false; btn.textContent = 'Send message';
});

/* ---------- Achievements and keys ---------- */
let toastTimer;
function achievement(text) {
  $('#toast-text').textContent = text;
  $('#toast').classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3800);
}
const konami = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a'];
let kPos = 0;
addEventListener('keydown', e => {
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  kPos = k === konami[kPos] ? kPos + 1 : (k === konami[0] ? 1 : 0);
  if (kPos === konami.length) { kPos = 0; achievement('Secret found: +30 lives. Thanks for exploring!'); }
  if (e.key === 'Escape') {
    if ($('#doc-modal').classList.contains('open')) closeDoc();
    else if ($('#img-modal').classList.contains('open')) $('#img-modal').classList.remove('open');
    else leaveRoam();
  }
});

/* ---------- Boot ---------- */
syncModeButtons();
html.classList.add('booting');
setTimeout(() => html.classList.remove('booting'), 60);
if (isWalk()) {
  const fromHash = stops.findIndex(st => st.id && '#' + st.id === location.hash);
  setMode('walk', { save: false, start: Math.max(0, fromHash) });
} else {
  readScroll();
}
