import express from 'express';
import cookieParser from 'cookie-parser';
import { createServer as createViteServer } from 'vite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Load .env if present
try {
  const { config } = await import('dotenv');
  config();
} catch {}

const PORT = process.env.PORT || 3000;
const CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const COOKIE_SECRET = process.env.COOKIE_SECRET || 'starbase-dev-secret';
const IS_DEV = process.env.NODE_ENV !== 'production';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn('\n⚠  GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET not set.');
  console.warn('   Create a .env file from .env.example to enable OAuth.\n');
}

const app = express();
app.set('trust proxy', 1);
app.use(cookieParser(COOKIE_SECRET));
app.use(express.json());

// ---------------------------------------------------------------------------
// GitHub OAuth
// ---------------------------------------------------------------------------

app.get('/auth/github', (req, res) => {
  if (!CLIENT_ID) return res.status(500).json({ error: 'OAuth not configured' });
  const redirect = `https://github.com/login/oauth/authorize?client_id=${CLIENT_ID}&scope=repo&redirect_uri=${encodeURIComponent(req.protocol + '://' + req.get('host') + '/auth/github/callback')}`;
  res.redirect(redirect);
});

app.get('/auth/github/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('Missing code');

  try {
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code }),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);

    // Store token in signed HTTP-only cookie
    res.cookie('gh_token', tokenData.access_token, {
      httpOnly: true,
      signed: true,
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
      sameSite: 'lax',
    });
    res.redirect('/#authenticated');
  } catch (err) {
    console.error('OAuth error:', err);
    res.status(500).send('Authentication failed: ' + err.message);
  }
});

app.post('/auth/logout', (req, res) => {
  res.clearCookie('gh_token');
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// API: Current user
// ---------------------------------------------------------------------------

function getToken(req) {
  return req.signedCookies?.gh_token || null;
}

async function ghFetch(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  return res.json();
}

app.get('/api/me', async (req, res) => {
  const oauthConfigured = !!(CLIENT_ID && CLIENT_SECRET);
  const token = getToken(req);
  if (!token) return res.json({ authenticated: false, oauthConfigured });
  try {
    const user = await ghFetch('/user', token);
    res.json({ authenticated: true, oauthConfigured, login: user.login, avatar: user.avatar_url, name: user.name });
  } catch {
    res.json({ authenticated: false, oauthConfigured });
  }
});

// ---------------------------------------------------------------------------
// API: List user repos
// ---------------------------------------------------------------------------

app.get('/api/repos', async (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const repos = await ghFetch('/user/repos?sort=updated&per_page=50&type=all', token);
    res.json(repos.map((r) => ({
      full_name: r.full_name,
      name: r.name,
      description: r.description,
      private: r.private,
      language: r.language,
      stars: r.stargazers_count,
      updated_at: r.updated_at,
      default_branch: r.default_branch,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// API: Detect src directory in a repo
// ---------------------------------------------------------------------------

app.get('/api/detect-src', async (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const { repo } = req.query;
  if (!repo) return res.status(400).json({ error: 'Missing repo param' });

  try {
    // Get the repo's tree (first level)
    const repoData = await ghFetch(`/repos/${repo}`, token);
    const tree = await ghFetch(`/repos/${repo}/git/trees/${repoData.default_branch}`, token);
    const dirs = tree.tree.filter((t) => t.type === 'tree').map((t) => t.path);

    // Heuristic: common source directories
    const candidates = ['src', 'lib', 'app', 'packages', 'source', 'core'];
    const detected = candidates.find((c) => dirs.includes(c)) || 'src';

    res.json({ sparseDir: detected, dirs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// API: Parse a repo
// ---------------------------------------------------------------------------

// Track in-progress parses
const parseJobs = new Map();

app.post('/api/parse', async (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const { repo: repoName, sparseDir: sd } = req.body;
  if (!repoName) return res.status(400).json({ error: 'Missing repo' });

  const jobKey = `${repoName}:${sd || 'src'}`;

  // If already parsing, wait for it
  if (parseJobs.has(jobKey)) {
    try {
      const result = await parseJobs.get(jobKey);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  const promise = (async () => {
    const { parseRepo } = await import('./scripts/parse-repo.mjs');
    return parseRepo({ repo: repoName, sparseDir: sd || 'src', token });
  })();

  parseJobs.set(jobKey, promise);

  try {
    const result = await promise;
    res.json(result);
  } catch (err) {
    console.error(`Parse error for ${repoName}:`, err);
    // Redact any tokens that might have leaked into error messages
    const safeMsg = (err.message || 'Unknown error').replace(/gho_\w+/g, '***').replace(/x-access-token:[^@\s]+/g, '***');
    res.status(500).json({ error: safeMsg });
  } finally {
    parseJobs.delete(jobKey);
  }
});

// ---------------------------------------------------------------------------
// Vite dev server or static files
// ---------------------------------------------------------------------------

if (IS_DEV) {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
} else {
  const distPath = resolve('dist');
  if (existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('/{*splat}', (req, res) => res.sendFile(resolve(distPath, 'index.html')));
  } else {
    console.warn('No dist/ found. Run `npm run build` first for production.');
  }
}

app.listen(PORT, () => {
  console.log(`\n  Starbase server running at http://localhost:${PORT}`);
  console.log(`  OAuth: ${CLIENT_ID ? 'configured' : 'NOT configured (set .env)'}\n`);
});
