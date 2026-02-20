#!/usr/bin/env node

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname, extname, basename, resolve } from 'node:path';
import { init, parse as parseImports } from 'es-module-lexer';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return args[i + 1] ?? fallback;
}

const repo = flag('repo', 'vercel/next.js');
const mode = flag('mode', 'directory');
const maxFiles = parseInt(flag('max', '600'), 10);
const sparseDir = flag('sparse', 'packages/next/src');
const outPath = flag('out', 'public/repo-graph.json');

const CACHE_DIR = '.repo-cache';
const repoSlug = repo.replace('/', '__');
const cloneDir = join(CACHE_DIR, repoSlug);

// ---------------------------------------------------------------------------
// 1. Sparse clone
// ---------------------------------------------------------------------------
function cloneRepo() {
  if (existsSync(join(cloneDir, '.git'))) {
    console.log(`Using cached clone: ${cloneDir}`);
    return;
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  console.log(`Sparse-cloning ${repo} into ${cloneDir} ...`);
  execSync(
    `git clone --depth 1 --filter=blob:none --sparse https://github.com/${repo}.git ${cloneDir}`,
    { stdio: 'inherit' }
  );
  execSync(`git sparse-checkout set ${sparseDir}`, {
    cwd: cloneDir,
    stdio: 'inherit',
  });
  console.log('Clone complete.');
}

// ---------------------------------------------------------------------------
// 2. Walk files
// ---------------------------------------------------------------------------
const SKIP_DIRS = new Set([
  'node_modules', '__tests__', '__mocks__', 'test', 'tests',
  'dist', 'build', '.next', '.turbo', 'fixtures', '__snapshots__',
]);
const EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs']);

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = resolve(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(full, files);
    } else if (EXTENSIONS.has(extname(entry))) {
      files.push(full);
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// 3. Parse imports
// ---------------------------------------------------------------------------
const REQUIRE_RE = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
// Match: from './path' | import './path' | export './path'
const FROM_RE = /\bfrom\s+['"](\.[^'"]+)['"]/g;
const BARE_IMPORT_RE = /\bimport\s+['"](\.[^'"]+)['"]/g;

function resolveImport(fromFile, specifier, allFilesSet) {
  const dir = dirname(fromFile);
  const target = resolve(dir, specifier);

  // Try exact, then with extensions, then as directory/index
  const candidates = [target];
  for (const ext of EXTENSIONS) {
    candidates.push(target + ext);
  }
  // index files
  for (const ext of EXTENSIONS) {
    candidates.push(join(target, `index${ext}`));
  }

  for (const c of candidates) {
    if (allFilesSet.has(c)) return c;
  }
  return null;
}

function addSpecifier(spec, filePath, allFilesSet, imports) {
  if (spec && (spec.startsWith('./') || spec.startsWith('../'))) {
    const resolved = resolveImport(filePath, spec, allFilesSet);
    if (resolved) imports.add(resolved);
  }
}

async function parseFile(filePath, allFilesSet) {
  const code = readFileSync(filePath, 'utf-8');
  const imports = new Set();
  const ext = extname(filePath);

  // For non-JSX files, try es-module-lexer first (more accurate)
  if (ext === '.js' || ext === '.ts' || ext === '.mjs' || ext === '.cjs') {
    try {
      const [esImports] = parseImports(code);
      for (const imp of esImports) {
        addSpecifier(imp.n, filePath, allFilesSet, imports);
      }
      // Also check require()
      let m;
      REQUIRE_RE.lastIndex = 0;
      while ((m = REQUIRE_RE.exec(code)) !== null) {
        addSpecifier(m[1], filePath, allFilesSet, imports);
      }
      return imports;
    } catch {
      // Fall through to regex
    }
  }

  // Regex fallback for JSX/TSX and any files es-module-lexer can't handle
  let m;
  FROM_RE.lastIndex = 0;
  while ((m = FROM_RE.exec(code)) !== null) {
    addSpecifier(m[1], filePath, allFilesSet, imports);
  }
  BARE_IMPORT_RE.lastIndex = 0;
  while ((m = BARE_IMPORT_RE.exec(code)) !== null) {
    addSpecifier(m[1], filePath, allFilesSet, imports);
  }
  REQUIRE_RE.lastIndex = 0;
  while ((m = REQUIRE_RE.exec(code)) !== null) {
    addSpecifier(m[1], filePath, allFilesSet, imports);
  }

  return imports;
}

// ---------------------------------------------------------------------------
// 4. Category assignment
// ---------------------------------------------------------------------------
function assignCategory(relPath) {
  const p = relPath.toLowerCase();
  const first = p.split('/')[0];
  if (first === 'server' || p.includes('/server/'))  return 'server';
  if (first === 'client' || p.includes('/client/'))  return 'client';
  if (first === 'shared' || p.includes('/shared/'))  return 'shared';
  if (first === 'lib' || p.includes('/lib/'))        return 'lib';
  if (first === 'build' || first === 'compiler' || p.includes('/build/') || p.includes('/compiler/') || p.includes('/trace/')) return 'build';
  if (first === 'api' || p.includes('/api/'))        return 'api';
  if (first === 'pages' || p.includes('/pages/'))    return 'pages';
  if (first === 'export' || p.includes('/export/'))  return 'export';
  return 'other';
}

const CATEGORY_COLORS = {
  server:  { color: '#50c8dc', label: 'Server' },
  client:  { color: '#a078ff', label: 'Client' },
  shared:  { color: '#64dca0', label: 'Shared' },
  lib:     { color: '#ffb446', label: 'Lib' },
  build:   { color: '#ff6478', label: 'Build' },
  api:     { color: '#dc82dc', label: 'API' },
  pages:   { color: '#88ccff', label: 'Pages' },
  export:  { color: '#ffd866', label: 'Export' },
  other:   { color: '#999999', label: 'Other' },
};

// ---------------------------------------------------------------------------
// 5. Build graph
// ---------------------------------------------------------------------------
async function buildGraph() {
  const srcRoot = resolve(cloneDir, sparseDir);
  if (!existsSync(srcRoot)) {
    console.error(`Source directory not found: ${srcRoot}`);
    process.exit(1);
  }

  console.log(`Walking ${srcRoot} ...`);
  const allFiles = walk(srcRoot);
  console.log(`Found ${allFiles.length} source files.`);

  const allFilesSet = new Set(allFiles);

  await init;

  console.log('Parsing imports ...');
  const fileImports = new Map(); // filePath -> Set<filePath>
  for (const f of allFiles) {
    const imports = await parseFile(f, allFilesSet);
    if (imports.size > 0) fileImports.set(f, imports);
  }

  const totalImports = [...fileImports.values()].reduce((s, v) => s + v.size, 0);
  console.log(`Parsed ${totalImports} resolved imports from ${fileImports.size} files.`);

  const result = mode === 'directory'
    ? buildDirectoryGraph(allFiles, fileImports, srcRoot)
    : buildFileGraph(allFiles, fileImports, srcRoot);
  return { ...result, allFiles, fileImports, srcRoot };
}

function buildDirectoryGraph(allFiles, fileImports, srcRoot) {
  // Collapse to directory level — use the first two path segments relative to srcRoot
  function dirKey(filePath) {
    const rel = relative(srcRoot, dirname(filePath));
    const parts = rel.split('/').filter(Boolean);
    // Use up to 2 levels deep for meaningful grouping
    return parts.slice(0, 2).join('/') || '.';
  }

  const dirFiles = new Map(); // dirKey -> count of files
  for (const f of allFiles) {
    const dk = dirKey(f);
    dirFiles.set(dk, (dirFiles.get(dk) || 0) + 1);
  }

  // Build edges between directories
  const edgeSet = new Set();
  for (const [file, imports] of fileImports) {
    const fromDir = dirKey(file);
    for (const imp of imports) {
      const toDir = dirKey(imp);
      if (fromDir !== toDir) {
        const edgeKey = [fromDir, toDir].sort().join('|||');
        edgeSet.add(edgeKey);
      }
    }
  }

  const nodes = [...dirFiles.entries()].map(([dir, fileCount]) => ({
    id: dir,
    label: dir === '.' ? 'src (root)' : basename(dir) || dir,
    category: assignCategory(dir + '/'),
    fileCount,
  }));

  const links = [...edgeSet].map((e) => {
    const [source, target] = e.split('|||');
    return { source, target };
  });

  return { nodes, links };
}

function buildFileGraph(allFiles, fileImports, srcRoot) {
  // Count connections per file
  const connCount = new Map();
  for (const [file, imports] of fileImports) {
    connCount.set(file, (connCount.get(file) || 0) + imports.size);
    for (const imp of imports) {
      connCount.set(imp, (connCount.get(imp) || 0) + 1);
    }
  }

  // Top N most connected
  const sorted = [...connCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxFiles);
  const kept = new Set(sorted.map(([f]) => f));

  const nodes = sorted.map(([f]) => {
    const rel = relative(srcRoot, f);
    return {
      id: rel,
      label: basename(rel, extname(rel)),
      category: assignCategory(rel),
      fileCount: 1,
    };
  });

  const linkSet = new Set();
  const links = [];
  for (const [file, imports] of fileImports) {
    if (!kept.has(file)) continue;
    const fromId = relative(srcRoot, file);
    for (const imp of imports) {
      if (!kept.has(imp)) continue;
      const toId = relative(srcRoot, imp);
      const key = [fromId, toId].sort().join('|||');
      if (!linkSet.has(key)) {
        linkSet.add(key);
        links.push({ source: fromId, target: toId });
      }
    }
  }

  return { nodes, links };
}

// ---------------------------------------------------------------------------
// 6. Exported API for server use
// ---------------------------------------------------------------------------

/**
 * Clone + parse a repo and return the graph JSON object (no file I/O).
 * @param {{ repo: string, sparseDir?: string, mode?: string, maxFiles?: number, token?: string }} opts
 */
export async function parseRepo(opts = {}) {
  const _repo = opts.repo || repo;
  const _sparseDir = opts.sparseDir || sparseDir;
  const _mode = opts.mode || mode;
  const _maxFiles = opts.maxFiles || maxFiles;
  const _token = opts.token || null;

  const _repoSlug = _repo.replace('/', '__');
  const _cloneDir = join(CACHE_DIR, _repoSlug);

  // Clone
  if (!existsSync(join(_cloneDir, '.git'))) {
    mkdirSync(CACHE_DIR, { recursive: true });
    console.log(`Sparse-cloning ${_repo} into ${_cloneDir} ...`);
    const cloneUrl = _token
      ? `https://x-access-token:${_token}@github.com/${_repo}.git`
      : `https://github.com/${_repo}.git`;
    // Redact token from error messages
    const safeUrl = cloneUrl.replace(/x-access-token:[^@]+@/, 'x-access-token:***@');
    try {
      execSync(
        `git clone --depth 1 --filter=blob:none --sparse "${cloneUrl}" "${_cloneDir}"`,
        { stdio: 'pipe', timeout: 60000 }
      );
    } catch (err) {
      const stderr = (err.stderr?.toString() || '').replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
      console.error(`git clone failed for ${safeUrl}:\n${stderr}`);
      throw new Error(`git clone failed: ${stderr || err.message}`);
    }
    try {
      execSync(`git sparse-checkout set ${_sparseDir}`, {
        cwd: _cloneDir,
        stdio: 'pipe',
        timeout: 30000,
      });
    } catch (err) {
      const stderr = err.stderr?.toString() || '';
      console.error(`git sparse-checkout failed:\n${stderr}`);
      throw new Error(`git sparse-checkout failed: ${stderr || err.message}`);
    }
  }

  const _srcRoot = resolve(_cloneDir, _sparseDir);
  if (!existsSync(_srcRoot)) {
    throw new Error(`Source directory not found: ${_srcRoot}`);
  }

  const allFiles = walk(_srcRoot);
  const allFilesSet = new Set(allFiles);
  await init;

  const fileImports = new Map();
  for (const f of allFiles) {
    const imports = await parseFile(f, allFilesSet);
    if (imports.size > 0) fileImports.set(f, imports);
  }

  const dirGraph = buildDirectoryGraph(allFiles, fileImports, _srcRoot);
  const fileGraph = buildFileGraph(allFiles, fileImports, _srcRoot);

  const usedCats = new Set([
    ...dirGraph.nodes.map((n) => n.category),
    ...fileGraph.nodes.map((n) => n.category),
  ]);
  const categories = {};
  for (const cat of usedCats) {
    categories[cat] = CATEGORY_COLORS[cat] || CATEGORY_COLORS.other;
  }

  function dirKeyForFile(filePath) {
    const rel = relative(_srcRoot, dirname(filePath));
    const parts = rel.split('/').filter(Boolean);
    return parts.slice(0, 2).join('/') || '.';
  }
  const fileToDirMap = {};
  for (const f of allFiles) {
    const rel = relative(_srcRoot, f);
    fileToDirMap[rel] = dirKeyForFile(f);
  }

  return {
    meta: { repo: _repo, mode: _mode, pathPrefix: _sparseDir, nodeCount: dirGraph.nodes.length, linkCount: dirGraph.links.length },
    categories,
    nodes: dirGraph.nodes,
    links: dirGraph.links,
    fileNodes: fileGraph.nodes,
    fileLinks: fileGraph.links,
    fileToDirMap,
  };
}

// ---------------------------------------------------------------------------
// 7. CLI main (only runs when executed directly)
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\nRepo:  ${repo}`);
  console.log(`Mode:  ${mode}`);
  console.log(`Sparse: ${sparseDir}\n`);

  cloneRepo();
  const output = await parseRepo({ repo, sparseDir, mode, maxFiles });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.log(`  ${output.nodes.length} dir nodes, ${output.links.length} dir links`);
  console.log(`  ${output.fileNodes.length} file nodes, ${output.fileLinks.length} file links`);
}

// Only run main() when executed as CLI (not when imported)
const isMainModule = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMainModule) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
