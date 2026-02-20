import './styles.css';
import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { forceX as d3ForceX, forceY as d3ForceY, forceZ as d3ForceZ, forceManyBody as d3ForceManyBody } from 'd3-force-3d';
import { initHands, stopHands } from './hands.js';

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
  nodes = [];
  links = [];
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
let _uiClickedAt = 0; // timestamp to prevent UI clicks from triggering backgroundClick

// Any pointerdown outside the graph canvas marks as UI click
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest('#graph')) _uiClickedAt = Date.now();
}, true);

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

  // Nodes — prominent colored stars that stand out from the background
  .nodeThreeObject((node) => {
    const isCore = node.connections >= 10;
    const r = isCore ? 1.2 : 0.35 + Math.min(node.connections, 8) * 0.1;
    const color = new THREE.Color(node.categoryData.color);
    const group = new THREE.Group();

    // Star point — bright and solid
    const star = new THREE.Mesh(
      new THREE.SphereGeometry(r, 12, 12),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1.0 })
    );
    group.add(star);

    // Inner glow — visible colored halo
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(r * (isCore ? 4 : 3), 12, 12),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: isCore ? 0.12 : 0.06,
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
    // Ignore if a UI overlay was just clicked
    if (_uiClickedAt && Date.now() - _uiClickedAt < 400) return;
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
panel.addEventListener('pointerdown', (e) => { e.stopPropagation(); _uiClickedAt = Date.now(); });
document.body.appendChild(panel);

function openDetail(node) {
  blastNodes = null; // reset blast radius from previous selection
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
  if (hash === '#authenticated') return; // handled by login gate
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
    const avatarHtml = currentUser.avatar
      ? `<img class="auth-avatar" src="${currentUser.avatar}" alt="" />`
      : `<svg class="auth-avatar" width="18" height="18" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;
    authBtn.innerHTML = `${avatarHtml} ${currentUser.login}`;
    // Create dropdown menu
    if (!authMenu) {
      authMenu = document.createElement('div');
      authMenu.className = 'auth-menu';
      authMenu.innerHTML = `
        <button class="auth-menu-item" id="menu-logout">Sign out</button>
      `;
      authBar.appendChild(authMenu);

      authMenu.querySelector('#menu-logout').addEventListener('click', async () => {
        authMenu.classList.remove('open');
        await fetch('/auth/logout', { method: 'POST' });
        currentUser = null;
        authBtn.className = 'auth-btn';
        authBtn.textContent = 'Sign in with GitHub';
        if (authMenu) { authMenu.remove(); authMenu = null; }
        showLogin();
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

    // Show legend + shortcuts now that a repo is loaded
    dismissConnectScreen();

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

  // Update repo picker with repo name
  if (repoMeta?.repo) {
    repoPicker.textContent = repoMeta.repo;
    repoPicker.classList.add('has-repo');
  }

  // Reset state
  closeDetail();
  clearConstellations();
  blastNodes = null;
  highlightedCategories.clear();
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

  // Dim background starfield so data nodes stand out
  if (window.__dimStarfield) window.__dimStarfield(true);

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
  // Event delegation on legend handles clicks — no per-item listeners needed
  updateLegendClear();

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

// Auth check is handled by the login gate above

/* ------------------------------------------------------------------ */
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
  if (e.key === 'r' && !e.metaKey && !e.ctrlKey && !e.altKey
    && document.activeElement?.tagName !== 'INPUT') {
    const d = 180; // standard overview distance
    graph.cameraPosition({ x: 0, y: d * 0.17, z: d }, { x: 0, y: 0, z: 0 }, 800);
  }
});

// Keyboard shortcut hint
const hint = document.createElement('div');
hint.className = 'search-shortcut';
hint.textContent = '\u2318K search \u00b7 R reset view';
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

let highlightedCategories = new Set();

function updateLegendClear() {
  const existing = legend.querySelector('.legend-clear');
  if (highlightedCategories.size > 0) {
    if (!existing) {
      const clearEl = document.createElement('div');
      clearEl.className = 'legend-item legend-clear';
      clearEl.innerHTML = '<span class="legend-label">CLEAR ALL</span><span class="legend-clear-x">\u00d7</span>';
      legend.prepend(clearEl);
    }
  } else if (existing) {
    existing.remove();
  }
}

// Block ALL pointer/mouse events from reaching the 3D canvas behind the legend
['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'click'].forEach((evt) => {
  legend.addEventListener(evt, (e) => { e.stopPropagation(); _uiClickedAt = Date.now(); });
});

// Use pointerup for filter toggling (click is unreliable when pointerdown is intercepted)
legend.addEventListener('pointerup', (e) => {
  const item = e.target.closest('.legend-item');
  if (!item) return;

  // Handle "CLEAR ALL"
  if (item.classList.contains('legend-clear')) {
    highlightedCategories.clear();
    legend.querySelectorAll('.legend-item').forEach((el) => el.classList.remove('active'));
    updateLegendClear();
    return;
  }

  const cat = item.dataset.cat;
  if (!cat) return;

  if (highlightedCategories.has(cat)) {
    highlightedCategories.delete(cat);
  } else {
    highlightedCategories.add(cat);
  }
  legend.querySelectorAll('.legend-item[data-cat]').forEach((el) => {
    el.classList.toggle('active', highlightedCategories.has(el.dataset.cat));
  });
  updateLegendClear();
});

/* ------------------------------------------------------------------ */
/*  Login screen — replaces old STARBASE intro                         */
/* ------------------------------------------------------------------ */

const loginOverlay = document.createElement('div');
loginOverlay.id = 'login-overlay';
loginOverlay.innerHTML = `
  <canvas id="login-stars"></canvas>
  <div class="login-content">
    <div class="login-title">STARBASE</div>
    <div class="login-subtitle">explore your codebase</div>
    <button class="login-btn" id="login-btn">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
      Sign in with GitHub
    </button>
  </div>
`;
document.body.appendChild(loginOverlay);

/* ------------------------------------------------------------------ */
/*  Connect screen — shown after auth, before any repo is loaded       */
/* ------------------------------------------------------------------ */

// Repo picker button in auth bar (inserted before hand toggle)
const repoPicker = document.createElement('button');
repoPicker.id = 'repo-picker';
repoPicker.className = 'auth-btn repo-picker';
repoPicker.textContent = 'Connect a repo';
repoPicker.addEventListener('click', () => openRepoSelector());

/* Login starfield background */
(function initLoginStars() {
  const canvas = document.getElementById('login-stars');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  let w, h;

  function resize() {
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  const STAR_COUNT = 1200;
  const stars = [];
  for (let i = 0; i < STAR_COUNT; i++) {
    stars.push({
      x: Math.random() * 2 - 1,           // -1..1 normalized
      y: Math.random() * 2 - 1,
      z: Math.random(),                     // depth 0..1
      brightness: 0.06 + Math.random() * 0.25,
      twinkleSpeed: 1.5 + Math.random() * 3,
      twinkleOffset: Math.random() * Math.PI * 2,
    });
  }

  let raf;
  function draw(t) {
    if (!document.getElementById('login-stars')) return; // stop if removed
    ctx.clearRect(0, 0, w, h);

    const ts = t * 0.001;
    const cx = w / 2;
    const cy = h / 2;
    const drift = ts * 0.3; // slow drift

    for (let i = 0; i < STAR_COUNT; i++) {
      const s = stars[i];
      // Parallax drift based on depth
      const px = ((s.x + drift * (0.2 + s.z * 0.3)) % 2 + 3) % 2 - 1;
      const py = ((s.y + drift * 0.05 * (s.z - 0.5)) % 2 + 3) % 2 - 1;
      const sx = cx + px * cx * 1.2;
      const sy = cy + py * cy * 1.2;

      // Twinkle
      const twinkle = 0.5 + 0.5 * Math.sin(ts * s.twinkleSpeed + s.twinkleOffset);
      const alpha = s.brightness * (0.3 + twinkle * 0.5);
      const r = 0.4 + s.z * 1.0;

      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
      ctx.fill();

      // Subtle glow on brighter stars
      if (s.brightness > 0.22 && s.z > 0.7) {
        ctx.beginPath();
        ctx.arc(sx, sy, r * 3, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(200, 210, 255, ${alpha * 0.06})`;
        ctx.fill();
      }
    }

    raf = requestAnimationFrame(draw);
  }
  raf = requestAnimationFrame(draw);
})();

document.getElementById('login-btn').addEventListener('click', () => {
  window.location.href = '/auth/github';
});

function dismissLogin() {
  loginOverlay.classList.add('dissolve');
  setTimeout(() => loginOverlay.remove(), 1500);
}

function showConnectScreen() {
  document.body.classList.add('pre-connect');
}

function dismissConnectScreen() {
  document.body.classList.remove('pre-connect');
  // Re-trigger entrance animation so legend/shortcuts are noticeable
  legend.style.animation = 'none';
  legend.offsetHeight; // force reflow
  legend.style.animation = '';
  const shortcut = document.querySelector('.search-shortcut');
  if (shortcut) {
    shortcut.style.animation = 'none';
    shortcut.offsetHeight;
    shortcut.style.animation = '';
  }
}

function showLogin() {
  // Re-add if it was removed
  if (!document.getElementById('login-overlay')) {
    document.body.appendChild(loginOverlay);
    loginOverlay.classList.remove('dissolve');
  }
  requestAnimationFrame(() => {
    loginOverlay.classList.add('show-content');
  });
}

// Initial auth gate — check before showing anything
(async () => {
  const hash = window.location.hash;
  const isOAuthReturn = hash === '#authenticated';

  try {
    const res = await fetch('/api/me');
    const data = await res.json();

    // If OAuth isn't configured, fake a demo user and skip login
    if (!data.oauthConfigured) {
      currentUser = { authenticated: true, login: 'vc-sometimes', avatar: null };
      renderAuthButton();
      loginOverlay.remove();
      return;
    }

    if (data.authenticated) {
      currentUser = data;
      renderAuthButton();
      if (isOAuthReturn) {
        history.replaceState(null, '', window.location.pathname);
      }
      // Authenticated — replace login with connect screen
      loginOverlay.remove();
      showConnectScreen();
      return;
    }
  } catch {
    // Server not reachable (e.g. running with plain vite dev) — demo mode
    currentUser = { authenticated: true, login: 'vc-sometimes', avatar: null };
    renderAuthButton();
    loginOverlay.remove();
    return;
  }

  // Not authenticated but OAuth is configured — show login screen
  showLogin();
})();

/* ------------------------------------------------------------------ */
/*  Starfield — tens of thousands of stars filling all of space        */
/* ------------------------------------------------------------------ */

setTimeout(() => {
  const scene = graph.scene();
  if (!scene) return;

  // Starfield materials stored for dimming when a repo is loaded
  const starfieldMats = [];

  // Layer 1: distant stars everywhere (the sky)
  const farCount = 15000;
  const farPos = new Float32Array(farCount * 3);
  for (let i = 0; i < farCount; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const dist = 800 + Math.random() * 3000;
    farPos[i * 3] = Math.sin(phi) * Math.cos(theta) * dist;
    farPos[i * 3 + 1] = Math.sin(phi) * Math.sin(theta) * dist;
    farPos[i * 3 + 2] = Math.cos(phi) * dist;
  }
  const farGeo = new THREE.BufferGeometry();
  farGeo.setAttribute('position', new THREE.BufferAttribute(farPos, 3));
  const farMat = new THREE.PointsMaterial({
    color: 0xccccee,
    size: 0.8,
    transparent: true,
    opacity: 0.5,
    sizeAttenuation: true,
    depthWrite: false,
  });
  scene.add(new THREE.Points(farGeo, farMat));
  starfieldMats.push({ mat: farMat, full: 0.5, dim: 0.15 });

  // Layer 2: medium stars
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
  const medMat = new THREE.PointsMaterial({
    color: 0xddddff,
    size: 1.2,
    transparent: true,
    opacity: 0.6,
    sizeAttenuation: true,
    depthWrite: false,
  });
  scene.add(new THREE.Points(medGeo, medMat));
  starfieldMats.push({ mat: medMat, full: 0.6, dim: 0.2 });

  // Layer 3: a few bright nearby stars
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
  const brightMat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 2.5,
    transparent: true,
    opacity: 0.8,
    sizeAttenuation: true,
    depthWrite: false,
  });
  scene.add(new THREE.Points(brightGeo, brightMat));
  starfieldMats.push({ mat: brightMat, full: 0.8, dim: 0.25 });

  // Expose a function to dim/restore the starfield
  window.__dimStarfield = (dim) => {
    const duration = 800;
    const start = performance.now();
    const from = starfieldMats.map(s => s.mat.opacity);
    const to = starfieldMats.map(s => dim ? s.dim : s.full);
    function tick(now) {
      const t = Math.min((now - start) / duration, 1);
      const ease = t * (2 - t); // ease-out quad
      starfieldMats.forEach((s, i) => {
        s.mat.opacity = from[i] + (to[i] - from[i]) * ease;
      });
      if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  };

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
      2.2, 0.5, 0.4
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
    const catDim = highlightedCategories.size > 0 && !highlightedCategories.has(n.category);
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

// Camera zoom happens in reloadGraph after a repo is connected

/* ------------------------------------------------------------------ */
/*  Hand gesture control                                               */
/* ------------------------------------------------------------------ */

let handActive = false;

let orbitAngleX = 0;
let orbitAngleY = 0.3;
let orbitDist = 180;
let lookAtX = 0;
let lookAtY = 0;
let lookAtZ = 0;

let tOrbitX = 0;
let tOrbitY = 0.3;
let tOrbitDist = 180;
let tLookX = 0;
let tLookY = 0;

const SM = 0.1;
let handControlling = false;

// Anchor-based rotation
let rotAnchorX = null;
let rotAnchorY = null;
let rotBaseX = 0;
let rotBaseY = 0;
const ROT_SCALE = 3;

// Anchor-based pan
let panAnchorX = null;
let panAnchorY = null;
let panBaseX = 0;
let panBaseY = 0;
const PAN_SCALE = 300;

// Proximity zoom: map hand size to orbit distance
// handSize ~0.15 (far) → zoom out, ~0.5 (close) → zoom in
const ZOOM_NEAR = 0.45;  // hand size when close to cam
const ZOOM_FAR = 0.15;   // hand size when far from cam
const DIST_MIN = 30;     // closest orbit distance
const DIST_MAX = 600;    // furthest orbit distance

let resetCooldown = false;
let noHandTimer = null;
const NO_HAND_TIMEOUT = 3000; // auto-off after 3s with no hands

function deactivateHands() {
  stopHands();
  handActive = false;
  handControlling = false;
  noHandTimer = null;
  const controls = graph.controls();
  if (controls) { controls.enabled = true; controls.autoRotate = true; }
  btn.textContent = 'Hands [off]';
  btn.classList.remove('active');
  status.textContent = '';

  // Recenter to standard overview distance (same as pressing R)
  const d = 180;
  graph.cameraPosition({ x: 0, y: d * 0.17, z: d }, { x: 0, y: 0, z: 0 }, 800);
}

function handleGesture({ panX, panY, isPinching, handSize, isLeftHand, isRightHand, detected, handsJoined }) {
  if (handsJoined && !resetCooldown) {
    // Hands together — recenter and reset view
    resetCooldown = true;
    setTimeout(() => { resetCooldown = false; }, 1500);

    tOrbitX = 0;
    tOrbitY = 0.3;
    // Keep current zoom distance
    tLookX = 0;
    tLookY = 0;
    rotAnchorX = null;
    rotAnchorY = null;
    panAnchorX = null;
    panAnchorY = null;
    return;
  }

  if (!detected) {
    handControlling = false;
    rotAnchorX = null;
    rotAnchorY = null;
    panAnchorX = null;
    panAnchorY = null;
    // Start auto-off timer when hands disappear
    if (!noHandTimer && handActive) {
      noHandTimer = setTimeout(() => deactivateHands(), NO_HAND_TIMEOUT);
    }
    return;
  }

  // Hands visible — cancel auto-off timer
  if (noHandTimer) {
    clearTimeout(noHandTimer);
    noHandTimer = null;
  }

  handControlling = true;
  const controls = graph.controls();
  if (controls) { controls.enabled = false; controls.autoRotate = false; }

  // Left hand: move = rotate, proximity = zoom (always, no pinch needed)
  if (isLeftHand) {
    // Rotation via hand movement (anchor-based)
    if (rotAnchorX === null) {
      rotAnchorX = panX;
      rotAnchorY = panY;
      rotBaseX = tOrbitX;
      rotBaseY = tOrbitY;
    }
    tOrbitX = rotBaseX + (panX - rotAnchorX) * ROT_SCALE;
    tOrbitY = rotBaseY - (panY - rotAnchorY) * ROT_SCALE;
    tOrbitY = Math.max(-Math.PI * 0.45, Math.min(Math.PI * 0.45, tOrbitY));

    // Zoom via hand proximity to camera
    if (handSize !== undefined) {
      const t = Math.max(0, Math.min(1, (handSize - ZOOM_FAR) / (ZOOM_NEAR - ZOOM_FAR)));
      tOrbitDist = DIST_MAX - t * (DIST_MAX - DIST_MIN);
    }
  }

  // Right hand: pinch+move = pan, open = rotate
  if (isRightHand) {
    if (isPinching) {
      rotAnchorX = null;
      rotAnchorY = null;
      if (panAnchorX === null) {
        panAnchorX = panX;
        panAnchorY = panY;
        panBaseX = tLookX;
        panBaseY = tLookY;
      }
      tLookX = panBaseX + (panX - panAnchorX) * PAN_SCALE;
      tLookY = panBaseY + (panY - panAnchorY) * PAN_SCALE;
    } else {
      panAnchorX = null;
      panAnchorY = null;
      if (rotAnchorX === null) {
        rotAnchorX = panX;
        rotAnchorY = panY;
        rotBaseX = tOrbitX;
        rotBaseY = tOrbitY;
      }
      tOrbitX = rotBaseX + (panX - rotAnchorX) * ROT_SCALE;
      tOrbitY = rotBaseY - (panY - rotAnchorY) * ROT_SCALE;
      tOrbitY = Math.max(-Math.PI * 0.45, Math.min(Math.PI * 0.45, tOrbitY));
    }
  }
}

function updateCamera() {
  if (handControlling) {
    orbitAngleX += (tOrbitX - orbitAngleX) * SM;
    orbitAngleY += (tOrbitY - orbitAngleY) * SM;
    orbitDist += (tOrbitDist - orbitDist) * SM;
    lookAtX += (tLookX - lookAtX) * SM;
    lookAtY += (tLookY - lookAtY) * SM;

    graph.cameraPosition(
      {
        x: lookAtX + orbitDist * Math.sin(orbitAngleX) * Math.cos(orbitAngleY),
        y: lookAtY + orbitDist * Math.sin(orbitAngleY),
        z: lookAtZ + orbitDist * Math.cos(orbitAngleX) * Math.cos(orbitAngleY),
      },
      { x: lookAtX, y: lookAtY, z: lookAtZ }
    );
  } else {
    const controls = graph.controls();
    if (controls) { controls.enabled = true; controls.autoRotate = true; }
  }
  requestAnimationFrame(updateCamera);
}
updateCamera();

/* ------------------------------------------------------------------ */
/*  Toggle button                                                      */
/* ------------------------------------------------------------------ */

authBar.appendChild(repoPicker);

const btn = document.createElement('button');
btn.id = 'hand-toggle';
btn.className = 'auth-btn';
btn.textContent = 'Hands [off]';
authBar.appendChild(btn);

const status = document.createElement('div');
status.id = 'hand-status';
authBar.appendChild(status);

btn.addEventListener('click', async () => {
  if (!handActive) {
    btn.textContent = 'Hands [loading]';
    try {
      await initHands(handleGesture);
      handActive = true;
      btn.textContent = 'Hands [on]';
      btn.classList.add('active');
      status.textContent = 'Palm to start · L: rotate+zoom · R-pinch: pan · Together: reset';
    } catch (err) {
      console.error(err);
      btn.textContent = 'Hands [error]';
      status.textContent = err.message;
    }
  } else {
    if (noHandTimer) { clearTimeout(noHandTimer); noHandTimer = null; }
    deactivateHands();
  }
});

/* ------------------------------------------------------------------ */
/*  Load from URL hash on startup                                      */
/* ------------------------------------------------------------------ */

loadFromHash();
