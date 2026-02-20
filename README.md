# Starbase

Interactive 3D codebase visualizer. Parses a GitHub repository's import graph and renders it as an explorable star nebula using Three.js and force-directed layout.

## Features

- **3D force graph** — files as stars, imports as connections, clustered by category
- **GitHub OAuth** — sign in and visualize any repo you have access to
- **Cmd+K search** — fuzzy-find nodes across the graph
- **Blast radius** — BFS traversal showing transitive dependency reach
- **Constellation arcs** — curved lines between a selected node and its neighbors
- **Hand gesture control** — rotate, zoom, and pan with MediaPipe hand tracking
- **Orchestral sound design** — reverb-heavy Web Audio feedback on interactions
- **Deep links** — shareable `#node=path/to/file` URLs
- **Demo mode** — works without a backend using bundled mock data

## Getting started

```bash
npm install
```

### Development (full stack)

Requires a GitHub OAuth app. Copy `.env.example` to `.env` and fill in your credentials.

```bash
npm run dev        # Express server + Vite HMR on :3000
```

### Development (frontend only)

```bash
npm run dev:vite   # Vite dev server — demo mode with mock data
```

### Production build

```bash
npm run build      # Vite builds static output to dist/
npm start          # Express serves from dist/ in production
```

## Deployment

Deployed as a static Vite site on Vercel. The frontend's demo mode handles the missing backend gracefully — when the server is unreachable, it fakes a user and loads mock data.

```json
// vercel.json
{
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "framework": "vite"
}
```

## Controls

| Input | Action |
|---|---|
| Click node | Select — fly to node, open detail panel, draw constellations |
| Click background | Deselect |
| Cmd/Ctrl+K | Search palette |
| R | Reset camera to overview |
| Hand toggle | Enable MediaPipe hand tracking |
| L hand move | Rotate view |
| L hand proximity | Zoom |
| R hand pinch+move | Pan |
| Hands together | Recenter |

## Tech

- [3d-force-graph](https://github.com/vasturiano/3d-force-graph) + Three.js
- Vite
- Express (backend)
- MediaPipe Hands
- Web Audio API
