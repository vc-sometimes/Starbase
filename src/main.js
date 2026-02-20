import './styles.css';
import ForceGraph from 'force-graph';
import { nodes, links } from './data.js';

const container = document.getElementById('graph');
let hoveredNode = null;
let neighbors = new Set();
let animFrame = 0;

// Adjacency map
const adjacency = {};
links.forEach((l) => {
  const s = l.source.id ?? l.source;
  const t = l.target.id ?? l.target;
  if (!adjacency[s]) adjacency[s] = new Set();
  if (!adjacency[t]) adjacency[t] = new Set();
  adjacency[s].add(t);
  adjacency[t].add(s);
});

// Helpers
function rgba([r, g, b], a) {
  return `rgba(${r},${g},${b},${a})`;
}

function lerpColor([r, g, b], t) {
  // blend toward white
  return [r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t];
}

const graph = ForceGraph()(container)
  .graphData({ nodes: [...nodes], links: [...links] })
  .backgroundColor('#080810')

  // Physics — tighter clusters, more organic
  .d3AlphaDecay(0.015)
  .d3VelocityDecay(0.25)
  .d3Force('charge', null) // we'll configure manually
  .d3Force('link', null)
  .warmupTicks(120)
  .cooldownTicks(300)

  // Zoom
  .minZoom(0.2)
  .maxZoom(10)
  .enableZoomInteraction(true)
  .enablePanInteraction(true)

  // --- LINKS ---
  .linkCanvasObjectMode(() => 'replace')
  .linkCanvasObject((link, ctx) => {
    const src = link.source;
    const tgt = link.target;
    if (!src.x || !tgt.x) return;

    const sid = src.id;
    const tid = tgt.id;
    const isActive =
      hoveredNode && (sid === hoveredNode.id || tid === hoveredNode.id);
    const dimmed = hoveredNode && !isActive;

    const alpha = dimmed ? 0.015 : isActive ? 0.35 : 0.055;
    const width = isActive ? 1.2 : 0.4;

    ctx.beginPath();
    ctx.moveTo(src.x, src.y);
    ctx.lineTo(tgt.x, tgt.y);
    ctx.strokeStyle = isActive
      ? rgba(hoveredNode.categoryData.color, alpha)
      : `rgba(255,255,255,${alpha})`;
    ctx.lineWidth = width;
    ctx.stroke();

    // Animated particle on active links
    if (isActive) {
      const t = ((animFrame % 120) / 120);
      const px = src.x + (tgt.x - src.x) * t;
      const py = src.y + (tgt.y - src.y) * t;
      ctx.beginPath();
      ctx.arc(px, py, 1.2, 0, Math.PI * 2);
      ctx.fillStyle = rgba(hoveredNode.categoryData.color, 0.6);
      ctx.fill();
    }
  })

  // --- NODES ---
  .nodeCanvasObject((node, ctx, globalScale) => {
    const isHovered = hoveredNode && node.id === hoveredNode.id;
    const isNeighbor = neighbors.has(node.id);
    const dimmed = hoveredNode && !isHovered && !isNeighbor;

    const baseRadius = 2 + node.connections * 0.5;
    const radius = isHovered ? baseRadius * 1.6 : isNeighbor ? baseRadius * 1.15 : baseRadius;
    const col = node.categoryData.color;

    // Outer glow (always, subtle)
    if (!dimmed) {
      const glowRadius = radius * 3;
      const grad = ctx.createRadialGradient(
        node.x, node.y, radius * 0.5,
        node.x, node.y, glowRadius
      );
      grad.addColorStop(0, rgba(col, isHovered ? 0.2 : 0.06));
      grad.addColorStop(1, rgba(col, 0));
      ctx.beginPath();
      ctx.arc(node.x, node.y, glowRadius, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
    }

    // Core dot
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    if (dimmed) {
      ctx.fillStyle = rgba(col, 0.08);
    } else if (isHovered) {
      // Bright filled circle with inner highlight
      const innerGrad = ctx.createRadialGradient(
        node.x - radius * 0.3, node.y - radius * 0.3, 0,
        node.x, node.y, radius
      );
      innerGrad.addColorStop(0, rgba(lerpColor(col, 0.5), 1));
      innerGrad.addColorStop(1, rgba(col, 1));
      ctx.fillStyle = innerGrad;
    } else {
      ctx.fillStyle = rgba(col, isNeighbor ? 0.85 : 0.55);
    }
    ctx.fill();

    // Ring on hover
    if (isHovered) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius + 1.5, 0, Math.PI * 2);
      ctx.strokeStyle = rgba(col, 0.4);
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }

    // Label
    const showLabel =
      isHovered ||
      isNeighbor ||
      globalScale > 2.2 ||
      (!hoveredNode && node.connections >= 6);

    if (showLabel) {
      const fontSize = isHovered
        ? Math.max(12 / globalScale, 3)
        : Math.max(10 / globalScale, 2.2);

      ctx.font = `${isHovered ? '600' : '400'} ${fontSize}px -apple-system, BlinkMacSystemFont, "Inter", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      const labelY = node.y + radius + (isHovered ? 3 : 2);
      const text = node.label;

      if (dimmed) {
        ctx.fillStyle = 'rgba(255,255,255,0.06)';
      } else if (isHovered) {
        ctx.fillStyle = '#ffffff';
      } else if (isNeighbor) {
        ctx.fillStyle = rgba(lerpColor(col, 0.3), 0.9);
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
      }

      // Subtle text shadow for readability
      if (isHovered || isNeighbor) {
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 4 / globalScale;
        ctx.fillText(text, node.x, labelY);
        ctx.restore();
      } else {
        ctx.fillText(text, node.x, labelY);
      }
    }
  })

  .nodePointerAreaPaint((node, color, ctx) => {
    const r = 4 + node.connections * 0.6;
    ctx.beginPath();
    ctx.arc(node.x, node.y, r + 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  })

  // Interaction
  .onNodeHover((node) => {
    container.style.cursor = node ? 'pointer' : 'default';
    hoveredNode = node || null;
    neighbors = new Set();
    if (node && adjacency[node.id]) {
      neighbors = new Set(adjacency[node.id]);
    }
  })
  .onNodeClick((node) => {
    graph.centerAt(node.x, node.y, 800);
    graph.zoom(5, 800);
  })
  .onBackgroundClick(() => {
    graph.zoomToFit(600, 80);
  });

// Configure forces after init
import('d3-force').then((d3) => {
  graph
    .d3Force('charge', d3.forceManyBody().strength(-120).distanceMax(300))
    .d3Force(
      'link',
      d3
        .forceLink()
        .id((d) => d.id)
        .distance(50)
        .strength(0.6)
    )
    .d3Force('center', d3.forceCenter(0, 0).strength(0.05))
    .d3Force('collision', d3.forceCollide().radius((d) => 4 + d.connections * 0.8))
    .d3ReheatSimulation();
});

// Animation loop for particles
function tick() {
  animFrame++;
  requestAnimationFrame(tick);
}
tick();

// Responsive
window.addEventListener('resize', () => {
  graph.width(window.innerWidth).height(window.innerHeight);
});

// Fit everything nicely after warmup
setTimeout(() => graph.zoomToFit(1000, 80), 800);
