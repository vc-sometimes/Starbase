import './styles.css';
import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { forceX as d3ForceX, forceY as d3ForceY, forceZ as d3ForceZ, forceManyBody as d3ForceManyBody } from 'd3-force-3d';

// ---------------------------------------------------------------------------
// Load graph data
// ---------------------------------------------------------------------------
let nodes, links;
let repoMeta = null;
try {
  const res = await fetch('/repo-graph.json');
  if (!res.ok) throw new Error(res.status);
  const json = await res.json();
  const categories = json.categories || {};
  repoMeta = json.meta || null;
  nodes = json.nodes;
  links = json.links;
  const connectionCount = {};
  links.forEach((l) => {
    connectionCount[l.source] = (connectionCount[l.source] || 0) + 1;
    connectionCount[l.target] = (connectionCount[l.target] || 0) + 1;
  });
  nodes.forEach((n) => {
    n.connections = connectionCount[n.id] || 0;
    n.categoryData = categories[n.category] || { color: '#999999', label: n.category };
  });
  console.log(`Loaded repo graph: ${json.meta?.repo} (${nodes.length} nodes, ${links.length} links)`);
} catch {
  console.log('No repo-graph.json found, using mock data');
  const data = await import('./data.js');
  nodes = data.nodes;
  links = data.links;
}

const container = document.getElementById('graph');

const adj = {};
links.forEach((l) => {
  const s = l.source.id ?? l.source;
  const t = l.target.id ?? l.target;
  (adj[s] ??= new Set()).add(t);
  (adj[t] ??= new Set()).add(s);
});

let hovered = null;
let selected = null;

// Category clustering — tight clusters near center, forming a nebula
const categoryKeys = [...new Set(nodes.map((n) => n.category))];
const clusterCenters = {};
const CLUSTER_RADIUS = 40; // tight — the whole nebula fits in ~80 unit sphere
categoryKeys.forEach((cat, i) => {
  const phi = Math.acos(1 - (2 * (i + 0.5)) / categoryKeys.length);
  const theta = Math.PI * (1 + Math.sqrt(5)) * i;
  clusterCenters[cat] = {
    x: Math.sin(phi) * Math.cos(theta) * CLUSTER_RADIUS,
    y: Math.cos(phi) * CLUSTER_RADIUS * 0.6,
    z: Math.sin(phi) * Math.sin(theta) * CLUSTER_RADIUS,
  };
});

// 3D Force Graph
const graph = ForceGraph3D({ controlType: 'orbit' })(container)
  .graphData({ nodes: [...nodes], links: [...links] })
  .backgroundColor('#000005')
  .showNavInfo(false)

  // Links fully hidden
  .linkWidth(0)
  .linkOpacity(0)
  .linkColor(() => 'rgba(0,0,0,0)')

  // Nodes — tiny bright stars, not big blobs
  .nodeThreeObject((node) => {
    const isCore = node.connections >= 10;
    const r = isCore ? 0.7 : 0.15 + Math.min(node.connections, 8) * 0.06;
    const color = new THREE.Color(node.categoryData.color);
    const group = new THREE.Group();

    // Star point
    const star = new THREE.Mesh(
      new THREE.SphereGeometry(r, 8, 8),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: isCore ? 1 : 0.9 })
    );
    group.add(star);

    // Soft glow
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(r * (isCore ? 4 : 2.5), 8, 8),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: isCore ? 0.06 : 0.025,
        side: THREE.BackSide,
        depthWrite: false,
      })
    );
    group.add(glow);

    node.__star = star;
    node.__glow = glow;
    node.__baseR = r;
    node.__color = color;
    node.__isCore = isCore;
    node.__phase = Math.random() * Math.PI * 2;

    return group;
  })
  .nodeLabel('')

  // Physics — tight clustering
  .d3AlphaDecay(0.01)
  .d3VelocityDecay(0.3)
  .d3Force('clusterX', d3ForceX((n) => clusterCenters[n.category]?.x || 0).strength(0.25))
  .d3Force('clusterY', d3ForceY((n) => clusterCenters[n.category]?.y || 0).strength(0.25))
  .d3Force('clusterZ', d3ForceZ((n) => clusterCenters[n.category]?.z || 0).strength(0.25))
  .d3Force('charge', d3ForceManyBody().strength(-3))

  .onNodeHover((node) => {
    container.style.cursor = node ? 'pointer' : 'default';
    hovered = node || null;
  })

  .onNodeClick((node) => {
    if (selected && selected.id === node.id) {
      closeDetail();
      playClose();
      clearConstellations();
      return;
    }
    selected = node;
    openDetail(node);
    flyToSelected(node);
    playSelect();
    updateHash(node.id);
    // Draw constellations after physics positions settle
    setTimeout(() => drawConstellations(node), 100);
    setTimeout(() => playConstellation(), 200);
  })
  .onBackgroundClick(() => {
    closeDetail();
    playClose();
    clearConstellations();
  });

/* ------------------------------------------------------------------ */
/*  Fly camera so selected node is centered in left half of screen     */
/* ------------------------------------------------------------------ */

function flyToSelected(node) {
  const PANEL_WIDTH = 380;
  const screenW = window.innerWidth;
  // The visible area left of the panel
  const visibleW = screenW - PANEL_WIDTH;
  // Center of the visible area in NDC (-1 to 1): panel eats the right side
  // Visible area goes from screen left (0) to (screenW - PANEL_WIDTH)
  // Its center in pixels = visibleW / 2
  // In NDC: ((visibleW / 2) / screenW) * 2 - 1
  const centerNDC = (visibleW / screenW) - 1;
  // We need to shift the camera RIGHT so the node (at lookAt center = NDC 0)
  // appears at centerNDC. That means we offset camera right by enough to
  // shift the projection left by -centerNDC (since centerNDC is negative).
  // Offset in world units ≈ -centerNDC * dist * tan(fov/2) * aspect

  const cam = graph.camera();
  const dist = 25; // how close to zoom in
  const fovRad = (cam.fov * Math.PI) / 180;
  const aspect = screenW / window.innerHeight;
  const rightShift = -centerNDC * dist * Math.tan(fovRad / 2) * aspect;

  // Camera direction toward node
  const camPos = graph.cameraPosition();
  const dir = new THREE.Vector3(
    camPos.x - node.x,
    camPos.y - node.y,
    camPos.z - node.z
  ).normalize();

  // If camera is too close/on top of node, pick a default direction
  if (dir.length() < 0.01) dir.set(0, 0.3, 1).normalize();

  // Camera right vector (perpendicular to dir and world up)
  const up = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(up, dir).normalize();
  if (right.length() < 0.01) right.set(1, 0, 0);

  // Final camera position: behind the node along dir, shifted right
  const newCam = {
    x: node.x + dir.x * dist + right.x * rightShift,
    y: node.y + dir.y * dist + right.y * rightShift,
    z: node.z + dir.z * dist + right.z * rightShift,
  };

  graph.cameraPosition(newCam, node, 800);
}

/* ------------------------------------------------------------------ */
/*  Detail panel                                                       */
/* ------------------------------------------------------------------ */

const panel = document.createElement('div');
panel.id = 'detail-panel';
document.body.appendChild(panel);

function openDetail(node) {
  const neighbors = adj[node.id] || new Set();
  const neighborNodes = nodes.filter((n) => neighbors.has(n.id))
    .sort((a, b) => (b.connections || 0) - (a.connections || 0));
  const catColor = node.categoryData?.color || '#999';

  panel.innerHTML = `
    <div class="panel-header">
      <span class="panel-title">${node.label}</span>
      <div class="panel-actions">
        <button class="panel-action-btn" id="detail-close">&times;</button>
      </div>
    </div>

    <div class="panel-body">
      <div class="panel-category" style="color:${catColor}; border-color:${catColor}40;">
        ${node.categoryData?.label || node.category}
      </div>

      <div class="panel-stats">
        <div class="panel-stat">
          <div class="panel-stat-label">Connections</div>
          <div class="panel-stat-value">${node.connections}</div>
        </div>
        <div class="panel-stat">
          <div class="panel-stat-label">Files</div>
          <div class="panel-stat-value">${node.fileCount || '\u2014'}</div>
        </div>
      </div>

      <button class="blast-radius-btn" id="blast-toggle">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>
        Blast radius
      </button>
      <div id="blast-info"></div>

      <div class="panel-section">
        <div class="panel-section-label">Path</div>
        <div class="panel-path">${node.id}</div>
        ${repoMeta?.repo ? `
          <a href="https://github.com/${repoMeta.repo}/tree/canary/${repoMeta.pathPrefix ? repoMeta.pathPrefix + '/' : ''}${node.id}" target="_blank" rel="noopener"
            style="display:inline-flex; align-items:center; gap:6px; margin-top:8px; font-size:10px; color:var(--text-tertiary); text-decoration:none; letter-spacing:0.08em; text-transform:uppercase; transition:color 0.15s;"
            onmouseenter="this.style.color='var(--accent)'" onmouseleave="this.style.color='var(--text-tertiary)'"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
            View on GitHub
          </a>
        ` : ''}
      </div>

      ${neighborNodes.length > 0 ? `
        <div class="panel-section">
          <div class="panel-section-label">Connected to (${neighborNodes.length})</div>
          <div class="panel-neighbors">
            ${neighborNodes.slice(0, 25).map((n) => `
              <div class="neighbor-item" data-id="${n.id}">
                <div class="neighbor-dot" style="background:${n.categoryData?.color || '#666'};"></div>
                <span class="neighbor-name">${n.label}</span>
                <span class="neighbor-cat">${n.categoryData?.label || n.category}</span>
              </div>
            `).join('')}
            ${neighborNodes.length > 25 ? `<div class="panel-overflow">+${neighborNodes.length - 25} more</div>` : ''}
          </div>
        </div>
      ` : ''}
    </div>
  `;

  panel.classList.add('open');

  panel.querySelector('#detail-close').addEventListener('click', () => {
    closeDetail();
    playClose();
    clearConstellations();
  });

  // Blast radius toggle
  const blastBtn = panel.querySelector('#blast-toggle');
  const blastInfo = panel.querySelector('#blast-info');
  if (blastBtn) {
    blastBtn.addEventListener('click', () => {
      if (blastNodes) {
        blastNodes = null;
        blastBtn.classList.remove('active');
        blastInfo.innerHTML = '';
      } else {
        blastNodes = computeBlastRadius(node.id);
        blastBtn.classList.add('active');
        const maxDepth = Math.max(...blastNodes.values());
        blastInfo.innerHTML = `<div class="panel-blast-info">${blastNodes.size} nodes reachable across ${maxDepth} hops</div>`;
        playTone(330, 0.2, 'sine', 0.04);
      }
    });
  }

  panel.querySelectorAll('.neighbor-item').forEach((el) => {
    el.addEventListener('click', () => {
      const n = nodes.find((n) => n.id === el.dataset.id);
      if (n) graph.onNodeClick()(n);
    });
  });
}

function closeDetail() {
  selected = null;
  blastNodes = null;
  panel.classList.remove('open');
  updateHash(null);
}

/* ------------------------------------------------------------------ */
/*  Blast radius — BFS transitive dependencies                         */
/* ------------------------------------------------------------------ */

let blastNodes = null; // Map<id, depth> when active

function computeBlastRadius(startId, maxDepth = 50) {
  const visited = new Map();
  visited.set(startId, 0);
  const queue = [startId];
  while (queue.length > 0) {
    const id = queue.shift();
    const depth = visited.get(id);
    if (depth >= maxDepth) continue;
    const neighbors = adj[id] || new Set();
    for (const nId of neighbors) {
      if (!visited.has(nId)) {
        visited.set(nId, depth + 1);
        queue.push(nId);
      }
    }
  }
  return visited;
}

/* ------------------------------------------------------------------ */
/*  Constellation arcs — lines between active node and neighbors       */
/* ------------------------------------------------------------------ */

const constellationLines = [];
let constellationGroup = null;

function drawConstellations(node) {
  clearConstellations();
  const scene = graph.scene();
  if (!scene || !node || !node.x) return;
  constellationGroup = new THREE.Group();
  const neighbors = adj[node.id] || new Set();
  const catColor = new THREE.Color(node.categoryData?.color || '#a855f7');

  for (const nId of neighbors) {
    const n = nodes.find((x) => x.id === nId);
    if (!n || !n.x) continue;

    // Curved arc via quadratic bezier
    const start = new THREE.Vector3(node.x, node.y, node.z);
    const end = new THREE.Vector3(n.x, n.y, n.z);
    const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
    // Push midpoint outward for curve
    const offset = new THREE.Vector3().subVectors(end, start).cross(new THREE.Vector3(0, 1, 0)).normalize();
    mid.add(offset.multiplyScalar(start.distanceTo(end) * 0.15));

    const curve = new THREE.QuadraticBezierCurve3(start, mid, end);
    const points = curve.getPoints(20);
    const geo = new THREE.BufferGeometry().setFromPoints(points);
    const mat = new THREE.LineBasicMaterial({
      color: catColor,
      transparent: true,
      opacity: 0.25,
      depthWrite: false,
    });
    const line = new THREE.Line(geo, mat);
    constellationGroup.add(line);
    constellationLines.push({ line, mat, targetOpacity: 0.25, currentOpacity: 0 });
  }
  scene.add(constellationGroup);
}

function clearConstellations() {
  if (constellationGroup) {
    const scene = graph.scene();
    if (scene) scene.remove(constellationGroup);
    constellationGroup.traverse((c) => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    });
    constellationGroup = null;
  }
  constellationLines.length = 0;
}

/* ------------------------------------------------------------------ */
/*  Sound design — ethereal orchestral via Web Audio API               */
/* ------------------------------------------------------------------ */

let audioCtx = null;
let reverbNode = null;

function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // Impulse-response reverb — large cathedral hall, 3s tail
    const rate = audioCtx.sampleRate;
    const len = rate * 3;
    const impulse = audioCtx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2);
      }
    }
    reverbNode = audioCtx.createConvolver();
    reverbNode.buffer = impulse;
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// Core voice: 3 detuned oscillators → gain envelope → dry/wet reverb split
function etherealVoice(freq, duration, vol = 0.04, { attack = 0.08, detune = 6, wet = 0.6 } = {}) {
  try {
    const ctx = ensureAudio();
    const t = ctx.currentTime;
    const dry = ctx.createGain();
    const wetGain = ctx.createGain();
    dry.gain.value = 1 - wet;
    wetGain.gain.value = wet;
    dry.connect(ctx.destination);
    wetGain.connect(reverbNode).connect(ctx.destination);

    for (const d of [-detune, 0, detune]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.detune.value = d;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vol / 3, t + attack);
      g.gain.setValueAtTime(vol / 3, t + duration * 0.4);
      g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      osc.connect(g);
      g.connect(dry);
      g.connect(wetGain);
      osc.start(t);
      osc.stop(t + duration + 0.1);
    }
  } catch {}
}

// Pad: wide chord, slow attack, long tail
function padChord(freqs, duration, vol = 0.025) {
  freqs.forEach((f, i) => {
    setTimeout(() => etherealVoice(f, duration, vol, { attack: 0.3 + i * 0.05, detune: 8, wet: 0.7 }), i * 30);
  });
}

function playSelect() {
  // Ascending maj7 arpeggio — harp-like, long reverb tail
  [523, 659, 784, 988].forEach((f, i) => {
    setTimeout(() => etherealVoice(f, 1.8 - i * 0.2, 0.035, { attack: 0.02, detune: 4, wet: 0.5 }), i * 70);
  });
}

function playClose() {
  // Descending minor — gentle dissolve
  etherealVoice(392, 1.2, 0.025, { attack: 0.01, wet: 0.6 });
  setTimeout(() => etherealVoice(330, 1.5, 0.02, { attack: 0.05, wet: 0.7 }), 80);
}

function playConstellation() {
  // Open fifth pad — vast, spacey
  padChord([220, 330, 440, 660], 3, 0.02);
}

function playSearch() {
  // Soft crystalline bell
  etherealVoice(880, 0.6, 0.02, { attack: 0.01, detune: 3, wet: 0.4 });
}

// Backward-compat for blast radius
function playTone(freq, duration, _type = 'sine', volume = 0.04) {
  etherealVoice(freq, duration, volume, { attack: 0.02, wet: 0.5 });
}

/* ------------------------------------------------------------------ */
/*  URL hash state — shareable deep links                              */
/* ------------------------------------------------------------------ */

function updateHash(nodeId) {
  if (nodeId) {
    history.replaceState(null, '', `#node=${encodeURIComponent(nodeId)}`);
  } else {
    history.replaceState(null, '', window.location.pathname);
  }
}

function loadFromHash() {
  const hash = window.location.hash;
  if (hash === '#authenticated') {
    // Just came back from OAuth — clear hash and refresh auth state
    history.replaceState(null, '', window.location.pathname);
    checkAuth();
    return;
  }
  if (!hash.startsWith('#node=')) return;
  const nodeId = decodeURIComponent(hash.slice(6));
  const node = nodes.find((n) => n.id === nodeId);
  if (node) {
    // Delay to let physics settle
    setTimeout(() => {
      selected = node;
      openDetail(node);
      flyToSelected(node);
    }, 2500);
  }
}
/* ------------------------------------------------------------------ */
/*  GitHub Auth + Repo selector                                        */
/* ------------------------------------------------------------------ */

const authBar = document.getElementById('auth-bar');
const authBtn = document.getElementById('auth-btn');
const repoOverlay = document.getElementById('repo-overlay');
const repoSearchInput = document.getElementById('repo-search');
const repoList = document.getElementById('repo-list');
const repoSparseInput = document.getElementById('repo-sparse');
const repoGoBtn = document.getElementById('repo-go');
const repoCloseBtn = document.getElementById('repo-close');
const parseOverlay = document.getElementById('parse-overlay');
const parseText = document.getElementById('parse-text');

let currentUser = null;
let userRepos = [];
let selectedRepo = null;
let authMenu = null;

async function checkAuth() {
  try {
    const res = await fetch('/api/me');
    const data = await res.json();
    if (data.authenticated) {
      currentUser = data;
      renderAuthButton();
    }
  } catch {}
}

function renderAuthButton() {
  if (currentUser) {
    authBtn.className = 'auth-btn authenticated';
    authBtn.innerHTML = `<img class="auth-avatar" src="${currentUser.avatar}" alt="" /> ${currentUser.login}`;
    // Create dropdown menu
    if (!authMenu) {
      authMenu = document.createElement('div');
      authMenu.className = 'auth-menu';
      authMenu.innerHTML = `
        <button class="auth-menu-item accent" id="menu-visualize">Visualize a repo</button>
        <button class="auth-menu-item" id="menu-logout">Sign out</button>
      `;
      authBar.appendChild(authMenu);

      authMenu.querySelector('#menu-visualize').addEventListener('click', () => {
        authMenu.classList.remove('open');
        openRepoSelector();
      });
      authMenu.querySelector('#menu-logout').addEventListener('click', async () => {
        authMenu.classList.remove('open');
        await fetch('/auth/logout', { method: 'POST' });
        currentUser = null;
        authBtn.className = 'auth-btn';
        authBtn.textContent = 'Sign in with GitHub';
        if (authMenu) { authMenu.remove(); authMenu = null; }
      });
    }
  }
}

authBtn.addEventListener('click', () => {
  if (currentUser && authMenu) {
    authMenu.classList.toggle('open');
  } else {
    window.location.href = '/auth/github';
  }
});

// Close auth menu on outside click
document.addEventListener('click', (e) => {
  if (authMenu && !authBar.contains(e.target)) {
    authMenu.classList.remove('open');
  }
});

// Repo selector
async function openRepoSelector() {
  repoOverlay.classList.add('open');
  repoSearchInput.value = '';
  selectedRepo = null;
  repoGoBtn.disabled = true;
  repoList.innerHTML = '<div class="repo-empty">Loading repositories...</div>';

  try {
    const res = await fetch('/api/repos');
    userRepos = await res.json();
    renderRepoList();
  } catch (err) {
    repoList.innerHTML = `<div class="repo-empty">Failed to load repos</div>`;
  }

  setTimeout(() => repoSearchInput.focus(), 100);
}

function closeRepoSelector() {
  repoOverlay.classList.remove('open');
}

function renderRepoList() {
  const query = repoSearchInput.value.toLowerCase().trim();
  let filtered = userRepos;
  if (query) {
    filtered = userRepos.filter((r) =>
      r.full_name.toLowerCase().includes(query) ||
      (r.description || '').toLowerCase().includes(query)
    );
  }

  if (filtered.length === 0) {
    // Check if query looks like owner/repo
    if (query.includes('/')) {
      repoList.innerHTML = `
        <div class="repo-item active" data-repo="${query}">
          <div>
            <div class="repo-item-name">${query}</div>
            <div class="repo-item-desc">Custom repository</div>
          </div>
        </div>
      `;
      selectedRepo = query;
      repoGoBtn.disabled = false;
    } else {
      repoList.innerHTML = '<div class="repo-empty">No matching repos — type owner/repo for any repo</div>';
    }
    return;
  }

  repoList.innerHTML = filtered.slice(0, 30).map((r) => `
    <div class="repo-item${selectedRepo === r.full_name ? ' active' : ''}" data-repo="${r.full_name}">
      <div>
        <div class="repo-item-name">${r.full_name}</div>
        ${r.description ? `<div class="repo-item-desc">${r.description}</div>` : ''}
      </div>
      <div class="repo-item-meta">
        ${r.language ? `<span class="repo-item-lang">${r.language}</span>` : ''}
        ${r.private ? '<span class="repo-item-private">Private</span>' : ''}
      </div>
    </div>
  `).join('');

  repoList.querySelectorAll('.repo-item').forEach((el) => {
    el.addEventListener('click', () => {
      repoList.querySelectorAll('.repo-item').forEach((e) => e.classList.remove('active'));
      el.classList.add('active');
      selectedRepo = el.dataset.repo;
      repoGoBtn.disabled = false;
      // Auto-detect source dir
      detectSrcDir(selectedRepo);
    });
  });
}

async function detectSrcDir(repo) {
  try {
    const res = await fetch(`/api/detect-src?repo=${encodeURIComponent(repo)}`);
    const data = await res.json();
    if (data.sparseDir) repoSparseInput.value = data.sparseDir;
  } catch {}
}

repoSearchInput.addEventListener('input', () => {
  renderRepoList();
});

repoCloseBtn.addEventListener('click', closeRepoSelector);
repoOverlay.addEventListener('click', (e) => {
  if (e.target === repoOverlay) closeRepoSelector();
});

repoGoBtn.addEventListener('click', async () => {
  if (!selectedRepo) return;
  closeRepoSelector();
  await visualizeRepo(selectedRepo, repoSparseInput.value || 'src');
});

repoSearchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeRepoSelector();
  if (e.key === 'Enter' && selectedRepo) {
    closeRepoSelector();
    visualizeRepo(selectedRepo, repoSparseInput.value || 'src');
  }
});

async function visualizeRepo(repo, sparseDir) {
  // Show parse overlay
  parseOverlay.classList.add('open');
  parseText.textContent = `Cloning ${repo}...`;

  try {
    const res = await fetch('/api/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, sparseDir }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Parse failed');
    }
    const json = await res.json();
    parseText.textContent = 'Building graph...';

    // Reload graph with new data
    reloadGraph(json);

    // Update page title
    document.title = `Starbase — ${repo}`;

    // Brief pause to show the graph building
    await new Promise((r) => setTimeout(r, 400));
  } catch (err) {
    parseText.textContent = `Error: ${err.message}`;
    await new Promise((r) => setTimeout(r, 2000));
  } finally {
    parseOverlay.classList.remove('open');
  }
}

function reloadGraph(json) {
  const categories = json.categories || {};
  repoMeta = json.meta || null;

  // Reset state
  closeDetail();
  clearConstellations();
  blastNodes = null;
  highlightedCategory = null;
  selected = null;
  hovered = null;

  // Replace nodes + links
  nodes.length = 0;
  links.length = 0;
  json.nodes.forEach((n) => nodes.push(n));
  json.links.forEach((l) => links.push(l));

  // Recompute connections
  const connectionCount = {};
  links.forEach((l) => {
    const s = l.source.id ?? l.source;
    const t = l.target.id ?? l.target;
    connectionCount[s] = (connectionCount[s] || 0) + 1;
    connectionCount[t] = (connectionCount[t] || 0) + 1;
  });
  nodes.forEach((n) => {
    n.connections = connectionCount[n.id] || 0;
    n.categoryData = categories[n.category] || { color: '#999999', label: n.category };
  });

  // Rebuild adjacency
  for (const k of Object.keys(adj)) delete adj[k];
  links.forEach((l) => {
    const s = l.source.id ?? l.source;
    const t = l.target.id ?? l.target;
    (adj[s] ??= new Set()).add(t);
    (adj[t] ??= new Set()).add(s);
  });

  // Update cluster centers for new categories
  const newCatKeys = [...new Set(nodes.map((n) => n.category))];
  for (const k of Object.keys(clusterCenters)) delete clusterCenters[k];
  newCatKeys.forEach((cat, i) => {
    const phi = Math.acos(1 - (2 * (i + 0.5)) / newCatKeys.length);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    clusterCenters[cat] = {
      x: Math.sin(phi) * Math.cos(theta) * CLUSTER_RADIUS,
      y: Math.cos(phi) * CLUSTER_RADIUS * 0.6,
      z: Math.sin(phi) * Math.sin(theta) * CLUSTER_RADIUS,
    };
  });

  // Reload graph data
  graph.graphData({ nodes: [...nodes], links: [...links] });

  // Rebuild legend
  const newCategoryCounts = {};
  nodes.forEach((n) => { newCategoryCounts[n.category] = (newCategoryCounts[n.category] || 0) + 1; });
  const newCategories = {};
  nodes.forEach((n) => { newCategories[n.category] = n.categoryData; });
  legend.innerHTML = Object.entries(newCategories).map(([key, cat]) => `
    <div class="legend-item" data-cat="${key}">
      <div class="legend-dot" style="background:${cat.color};"></div>
      <span class="legend-label">${cat.label}</span>
      <span class="legend-count">${newCategoryCounts[key] || 0}</span>
    </div>
  `).join('');
  legend.querySelectorAll('.legend-item').forEach((el) => {
    el.addEventListener('click', () => {
      const cat = el.dataset.cat;
      if (highlightedCategory === cat) {
        highlightedCategory = null;
        legend.querySelectorAll('.legend-item').forEach((e) => e.classList.remove('active'));
      } else {
        highlightedCategory = cat;
        legend.querySelectorAll('.legend-item').forEach((e) => e.classList.toggle('active', e.dataset.cat === cat));
      }
    });
  });

  // Remove old labels, rebuild them
  labelSprites.forEach(({ sprite }) => {
    const scene = graph.scene();
    if (scene) scene.remove(sprite);
    if (sprite.material?.map) sprite.material.map.dispose();
    if (sprite.material) sprite.material.dispose();
  });
  labelSprites.length = 0;

  setTimeout(() => {
    const scene = graph.scene();
    if (!scene) return;
    nodes.forEach((node) => {
      const cvs = document.createElement('canvas');
      const c = cvs.getContext('2d');
      cvs.width = 512;
      cvs.height = 64;
      c.font = `${node.__isCore ? '600' : '400'} ${node.__isCore ? 28 : 22}px -apple-system, BlinkMacSystemFont, "Inter", sans-serif`;
      c.fillStyle = '#ffffff';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(node.label, 256, 32);
      const tex = new THREE.CanvasTexture(cvs);
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, sizeAttenuation: true });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(16, 2, 1);
      scene.add(sprite);
      node.__label = sprite;
      node.__labelMat = mat;
      labelSprites.push({ sprite, node });
    });
  }, 500);

  // Fly camera back to overview
  setTimeout(() => {
    graph.cameraPosition({ x: 0, y: 30, z: 180 }, { x: 0, y: 0, z: 0 }, 2000);
  }, 300);

  console.log(`Loaded repo graph: ${json.meta?.repo} (${nodes.length} nodes, ${links.length} links)`);
}

// Check auth on startup
checkAuth();

/*  Cmd+K Search palette                                               */
/* ------------------------------------------------------------------ */

const searchOverlay = document.createElement('div');
searchOverlay.id = 'search-overlay';
searchOverlay.innerHTML = `
  <div id="search-palette">
    <input type="text" id="search-input" placeholder="Search nodes..." autocomplete="off" spellcheck="false" />
    <div id="search-results"><div class="search-hint">Type to search ${nodes.length} nodes</div></div>
  </div>
`;
document.body.appendChild(searchOverlay);

const searchInput = document.getElementById('search-input');
const searchResults = document.getElementById('search-results');
let searchActiveIdx = 0;
let searchFiltered = [];

function openSearch() {
  searchOverlay.classList.add('open');
  searchInput.value = '';
  searchResults.innerHTML = `<div class="search-hint">Type to search ${nodes.length} nodes</div>`;
  searchActiveIdx = 0;
  searchFiltered = [];
  setTimeout(() => searchInput.focus(), 50);
  playSearch();
}

function closeSearch() {
  searchOverlay.classList.remove('open');
  searchInput.blur();
}

function renderSearchResults() {
  const q = searchInput.value.toLowerCase().trim();
  if (!q) {
    searchResults.innerHTML = `<div class="search-hint">Type to search ${nodes.length} nodes</div>`;
    searchFiltered = [];
    return;
  }
  searchFiltered = nodes
    .filter((n) => n.id.toLowerCase().includes(q) || n.label.toLowerCase().includes(q))
    .sort((a, b) => (b.connections || 0) - (a.connections || 0))
    .slice(0, 20);
  searchActiveIdx = Math.min(searchActiveIdx, Math.max(0, searchFiltered.length - 1));

  if (searchFiltered.length === 0) {
    searchResults.innerHTML = `<div class="search-hint">No results</div>`;
    return;
  }

  searchResults.innerHTML = searchFiltered.map((n, i) => `
    <div class="search-result${i === searchActiveIdx ? ' active' : ''}" data-id="${n.id}">
      <div class="search-result-dot" style="background:${n.categoryData?.color || '#666'};"></div>
      <span class="search-result-name">${n.label}</span>
      <span class="search-result-path">${n.categoryData?.label || n.category}</span>
    </div>
  `).join('');

  searchResults.querySelectorAll('.search-result').forEach((el) => {
    el.addEventListener('click', () => selectSearchResult(el.dataset.id));
  });
}

function selectSearchResult(nodeId) {
  const node = nodes.find((n) => n.id === nodeId);
  if (!node) return;
  closeSearch();
  selected = node;
  openDetail(node);
  flyToSelected(node);
  playSelect();
  updateHash(node.id);
}

searchInput.addEventListener('input', () => {
  searchActiveIdx = 0;
  renderSearchResults();
});

searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    searchActiveIdx = Math.min(searchActiveIdx + 1, searchFiltered.length - 1);
    renderSearchResults();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    searchActiveIdx = Math.max(searchActiveIdx - 1, 0);
    renderSearchResults();
  } else if (e.key === 'Enter' && searchFiltered.length > 0) {
    e.preventDefault();
    selectSearchResult(searchFiltered[searchActiveIdx].id);
  } else if (e.key === 'Escape') {
    closeSearch();
  }
});

searchOverlay.addEventListener('click', (e) => {
  if (e.target === searchOverlay) closeSearch();
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    if (searchOverlay.classList.contains('open')) closeSearch();
    else openSearch();
  }
});

// Keyboard shortcut hint
const hint = document.createElement('div');
hint.className = 'search-shortcut';
hint.textContent = '\u2318K to search';
document.body.appendChild(hint);

/* ------------------------------------------------------------------ */
/*  Category Legend                                                     */
/* ------------------------------------------------------------------ */

const categoryCounts = {};
nodes.forEach((n) => { categoryCounts[n.category] = (categoryCounts[n.category] || 0) + 1; });

const legend = document.createElement('div');
legend.id = 'legend';
const categories = {};
nodes.forEach((n) => { categories[n.category] = n.categoryData; });

legend.innerHTML = Object.entries(categories).map(([key, cat]) => `
  <div class="legend-item" data-cat="${key}">
    <div class="legend-dot" style="background:${cat.color};"></div>
    <span class="legend-label">${cat.label}</span>
    <span class="legend-count">${categoryCounts[key] || 0}</span>
  </div>
`).join('');
document.body.appendChild(legend);

let highlightedCategory = null;

legend.querySelectorAll('.legend-item').forEach((el) => {
  el.addEventListener('click', () => {
    const cat = el.dataset.cat;
    if (highlightedCategory === cat) {
      highlightedCategory = null;
      legend.querySelectorAll('.legend-item').forEach((e) => e.classList.remove('active'));
    } else {
      highlightedCategory = cat;
      legend.querySelectorAll('.legend-item').forEach((e) => e.classList.toggle('active', e.dataset.cat === cat));
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Intro screen — STARBASE title, dissolve in/out                     */
/* ------------------------------------------------------------------ */

const introOverlay = document.createElement('div');
introOverlay.id = 'intro-overlay';
introOverlay.innerHTML = `<div id="intro-title">STARBASE</div>`;
document.body.appendChild(introOverlay);

(async () => {
  const titleEl = document.getElementById('intro-title');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Dissolve in
  await wait(100);
  introOverlay.classList.add('visible');
  await wait(600);
  titleEl.classList.add('visible');

  // Hold
  await wait(2500);

  // Dissolve out
  introOverlay.classList.add('dissolve');
  await wait(1500);
  introOverlay.remove();
})();

/* ------------------------------------------------------------------ */
/*  Starfield — tens of thousands of stars filling all of space        */
/* ------------------------------------------------------------------ */

setTimeout(() => {
  const scene = graph.scene();
  if (!scene) return;

  // Layer 1: distant dim stars everywhere (the sky)
  const farCount = 15000;
  const farPos = new Float32Array(farCount * 3);
  for (let i = 0; i < farCount; i++) {
    // Spread on a huge sphere shell so they surround you
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const dist = 800 + Math.random() * 3000;
    farPos[i * 3] = Math.sin(phi) * Math.cos(theta) * dist;
    farPos[i * 3 + 1] = Math.sin(phi) * Math.sin(theta) * dist;
    farPos[i * 3 + 2] = Math.cos(phi) * dist;
  }
  const farGeo = new THREE.BufferGeometry();
  farGeo.setAttribute('position', new THREE.BufferAttribute(farPos, 3));
  scene.add(new THREE.Points(farGeo, new THREE.PointsMaterial({
    color: 0xccccee,
    size: 0.8,
    transparent: true,
    opacity: 0.5,
    sizeAttenuation: true,
    depthWrite: false,
  })));

  // Layer 2: medium stars — closer, slightly brighter
  const medCount = 5000;
  const medPos = new Float32Array(medCount * 3);
  for (let i = 0; i < medCount; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const dist = 200 + Math.random() * 1000;
    medPos[i * 3] = Math.sin(phi) * Math.cos(theta) * dist;
    medPos[i * 3 + 1] = Math.sin(phi) * Math.sin(theta) * dist;
    medPos[i * 3 + 2] = Math.cos(phi) * dist;
  }
  const medGeo = new THREE.BufferGeometry();
  medGeo.setAttribute('position', new THREE.BufferAttribute(medPos, 3));
  scene.add(new THREE.Points(medGeo, new THREE.PointsMaterial({
    color: 0xddddff,
    size: 1.2,
    transparent: true,
    opacity: 0.6,
    sizeAttenuation: true,
    depthWrite: false,
  })));

  // Layer 3: a few bright nearby stars (scattered, not near the nebula center)
  const brightCount = 200;
  const brightPos = new Float32Array(brightCount * 3);
  for (let i = 0; i < brightCount; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const dist = 150 + Math.random() * 600;
    brightPos[i * 3] = Math.sin(phi) * Math.cos(theta) * dist;
    brightPos[i * 3 + 1] = Math.sin(phi) * Math.sin(theta) * dist;
    brightPos[i * 3 + 2] = Math.cos(phi) * dist;
  }
  const brightGeo = new THREE.BufferGeometry();
  brightGeo.setAttribute('position', new THREE.BufferAttribute(brightPos, 3));
  scene.add(new THREE.Points(brightGeo, new THREE.PointsMaterial({
    color: 0xffffff,
    size: 2.5,
    transparent: true,
    opacity: 0.8,
    sizeAttenuation: true,
    depthWrite: false,
  })));

  // Nebula fog around the data cluster center
  const nebColors = [0x221144, 0x112244, 0x1a0a33, 0x0a1133, 0x180828];
  nebColors.forEach((col, i) => {
    const neb = new THREE.Mesh(
      new THREE.SphereGeometry(60 + i * 20, 20, 20),
      new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.02, side: THREE.BackSide, depthWrite: false })
    );
    neb.position.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30);
    scene.add(neb);
  });
}, 100);

/* ------------------------------------------------------------------ */
/*  Bloom                                                              */
/* ------------------------------------------------------------------ */

setTimeout(() => {
  try {
    const bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      1.8, 0.6, 0.5
    );
    graph.postProcessingComposition().passes.push(bloomPass);
  } catch (e) {
    console.warn('Bloom not available:', e);
  }
}, 200);

/* ------------------------------------------------------------------ */
/*  Per-frame: twinkle + hover                                         */
/* ------------------------------------------------------------------ */

let time = 0;
const labelSprites = [];

graph.onEngineTick(() => {
  time += 0.016;
  const active = selected || hovered;
  const nb = active ? (adj[active.id] || new Set()) : new Set();

  const ACCENT = new THREE.Color(0xa855f7);

  nodes.forEach((n) => {
    if (!n.__star) return;
    const isH = active && n.id === active.id;
    const isN = nb.has(n.id);
    const catDim = highlightedCategory && n.category !== highlightedCategory;
    const dim = (active && !isH && !isN) || catDim;

    const sMat = n.__star.material;
    const gMat = n.__glow.material;
    const twinkle = 1 + Math.sin(time * 2.5 + n.__phase) * 0.1;

    // Blast radius override
    if (blastNodes && blastNodes.has(n.id)) {
      const depth = blastNodes.get(n.id);
      const maxD = Math.max(...blastNodes.values()) || 1;
      const t = 1 - depth / maxD; // 1 = center, 0 = edge
      sMat.opacity = 0.4 + t * 0.6;
      sMat.color.copy(ACCENT).lerp(n.__color, 1 - t);
      gMat.opacity = 0.03 + t * 0.12;
      gMat.color.copy(ACCENT);
      n.__star.scale.setScalar((1 + t * 0.8) * twinkle);
      n.__glow.scale.setScalar(1 + t * 0.5);
    } else if (blastNodes) {
      // Not in blast radius — very dim
      sMat.opacity = 0.05;
      sMat.color.copy(n.__color);
      gMat.opacity = 0.002;
      n.__star.scale.setScalar(0.4);
      n.__glow.scale.setScalar(0.3);
    } else if (isH) {
      sMat.opacity = 1;
      sMat.color.set(0xffffff);
      gMat.opacity = 0.15;
      n.__star.scale.setScalar(2 * twinkle);
      n.__glow.scale.setScalar(1.8);
    } else if (isN) {
      sMat.opacity = 1;
      sMat.color.copy(n.__color);
      gMat.opacity = 0.08;
      n.__star.scale.setScalar(1.4 * twinkle);
      n.__glow.scale.setScalar(1.2);
    } else if (dim) {
      sMat.opacity = 0.15;
      sMat.color.copy(n.__color);
      gMat.opacity = 0.005;
      n.__star.scale.setScalar(0.6);
      n.__glow.scale.setScalar(0.4);
    } else {
      sMat.opacity = n.__isCore ? 1 : 0.9;
      sMat.color.copy(n.__color);
      gMat.opacity = n.__isCore ? 0.06 : 0.025;
      n.__star.scale.setScalar(twinkle);
      n.__glow.scale.setScalar(twinkle);
    }
  });

  // Constellation arc fade-in
  constellationLines.forEach((cl) => {
    cl.currentOpacity += (cl.targetOpacity - cl.currentOpacity) * 0.08;
    cl.mat.opacity = cl.currentOpacity;
  });

  labelSprites.forEach(({ sprite, node }) => {
    if (!node.x) return;
    const r = node.__baseR || 0.5;
    sprite.position.set(node.x, node.y + r + 2, node.z);
    const isH = active && node.id === active.id;
    const isN = nb.has(node.id);
    let target = 0;
    if (isH) target = 1;
    else if (isN) target = 0.4;
    node.__labelMat.opacity += (target - node.__labelMat.opacity) * 0.12;
  });
});

/* ------------------------------------------------------------------ */
/*  Labels (only visible on hover)                                     */
/* ------------------------------------------------------------------ */

setTimeout(() => {
  const scene = graph.scene();
  if (!scene) return;
  nodes.forEach((node) => {
    const cvs = document.createElement('canvas');
    const c = cvs.getContext('2d');
    cvs.width = 512;
    cvs.height = 64;
    c.font = `${node.__isCore ? '600' : '400'} ${node.__isCore ? 28 : 22}px -apple-system, BlinkMacSystemFont, "Inter", sans-serif`;
    c.fillStyle = '#ffffff';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(node.label, 256, 32);
    const tex = new THREE.CanvasTexture(cvs);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0, depthWrite: false, sizeAttenuation: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(16, 2, 1);
    scene.add(sprite);
    node.__label = sprite;
    node.__labelMat = mat;
    labelSprites.push({ sprite, node });
  });
}, 500);

/* ------------------------------------------------------------------ */
/*  Auto-rotation                                                      */
/* ------------------------------------------------------------------ */

setTimeout(() => {
  const controls = graph.controls();
  if (controls) {
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.3;
  }
}, 1000);

// Start camera closer to see the nebula
setTimeout(() => {
  graph.cameraPosition({ x: 0, y: 30, z: 180 }, { x: 0, y: 0, z: 0 }, 2000);
}, 300);

/* ------------------------------------------------------------------ */
/*  Load from URL hash on startup                                      */
/* ------------------------------------------------------------------ */

loadFromHash();
