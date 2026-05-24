/**
 * Netlify Function: new-post
 * POST /api/new-post
 *
 * Accepts { title, slug, content, category, tags, date } and writes a markdown
 * file to /blog/posts/[slug].md, then triggers a Netlify deploy hook so the
 * new post becomes live.
 *
 * Environment variables required:
 *   NETLIFY_DEPLOY_HOOK  — Your Netlify build hook URL
 *   NEW_POST_SECRET      — A secret token to protect this endpoint
 *
 * Note: Netlify Functions run in a read-only filesystem at runtime. Writing
 * directly to the repo requires the GitHub API (recommended) or a writable
 * volume. See README.md for the GitHub API integration approach.
 * The filesystem write below works in local dev (netlify dev) only.
 */

const https = require('https');

exports.handler = async (event) => {
  /* Only accept POST */
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  /* Auth check */
  const secret = process.env.NEW_POST_SECRET;
  const authHeader = event.headers['x-post-secret'] || event.headers['authorization'];
  if (secret && authHeader !== secret && authHeader !== `Bearer ${secret}`) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  /* Parse body */
  let data;
  try {
    data = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON body' };
  }

  const { title, slug, content, category = 'General', tags = [], date } = data;

  if (!title || !slug || !content) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Required fields: title, slug, content' }),
    };
  }

  /* Sanitize slug */
  const safeSlug = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const postDate = date || new Date().toISOString().split('T')[0];

  /* Build frontmatter */
  const tagList = Array.isArray(tags) ? tags.map(t => `"${t}"`).join(', ') : `"${tags}"`;
  const wordCount = content.split(/\s+/).length;
  const readTime = `${Math.max(1, Math.ceil(wordCount / 200))} min read`;

  const markdown = `---
title: "${title.replace(/"/g, '\\"')}"
slug: "${safeSlug}"
date: "${postDate}"
category: "${category}"
tags: [${tagList}]
excerpt: ""
metaDescription: ""
author: "Precision Remodel LLC"
readTime: "${readTime}"
---

${content.trim()}
`;

  /* --- Option A: GitHub API (production-recommended) --- */
  const githubToken = process.env.GITHUB_TOKEN;
  const githubRepo = process.env.GITHUB_REPO; /* e.g. "username/repo-name" */
  const githubBranch = process.env.GITHUB_BRANCH || 'main';

  if (githubToken && githubRepo) {
    const filePath = `precision-remodel-site/blog/posts/${safeSlug}.md`;
    const result = await githubWrite(githubToken, githubRepo, githubBranch, filePath, markdown);
    if (!result.ok) {
      return { statusCode: 500, body: JSON.stringify({ error: 'GitHub write failed', detail: result.error }) };
    }
    /* Trigger Netlify deploy hook */
    await triggerDeploy();
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, slug: safeSlug, url: `/blog/${safeSlug}` }),
    };
  }

  /* --- Option B: Local filesystem (netlify dev only) --- */
  try {
    const fs = require('fs');
    const path = require('path');
    /* __dirname is netlify/functions — resolve to repo root */
    const repoRoot = path.resolve(__dirname, '..', '..');
    const outPath = path.join(repoRoot, 'blog', 'posts', `${safeSlug}.md`);
    fs.writeFileSync(outPath, markdown, 'utf8');
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, slug: safeSlug, note: 'Written locally — deploy manually or configure GITHUB_TOKEN + GITHUB_REPO for production.' }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Filesystem write failed. In production, set GITHUB_TOKEN and GITHUB_REPO environment variables. See README.',
        detail: err.message,
      }),
    };
  }
};

/* --------------------------------------------------------
   GitHub API helper — creates or updates a file in the repo
   -------------------------------------------------------- */
async function githubWrite(token, repo, branch, filePath, content) {
  const encoded = Buffer.from(content).toString('base64');
  const apiUrl = `https://api.github.com/repos/${repo}/contents/${filePath}`;

  /* Check if file already exists (to get its SHA for update) */
  let sha = null;
  try {
    const existing = await httpGet(apiUrl, {
      Authorization: `token ${token}`,
      'User-Agent': 'Precision-Remodel-CMS',
      Accept: 'application/vnd.github.v3+json',
    });
    if (existing.sha) sha = existing.sha;
  } catch { /* file doesn't exist yet — that's fine */ }

  const body = {
    message: `Add blog post: ${filePath}`,
    content: encoded,
    branch,
    ...(sha ? { sha } : {}),
  };

  return new Promise(resolve => {
    const url = new URL(apiUrl);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'PUT',
      headers: {
        Authorization: `token ${token}`,
        'User-Agent': 'Precision-Remodel-CMS',
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true });
        } else {
          resolve({ ok: false, error: data });
        }
      });
    });

    req.on('error', err => resolve({ ok: false, error: err.message }));
    req.write(JSON.stringify(body));
    req.end();
  });
}

function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'GET', headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/* --------------------------------------------------------
   Trigger a Netlify deploy hook
   -------------------------------------------------------- */
async function triggerDeploy() {
  const hookUrl = process.env.NETLIFY_DEPLOY_HOOK;
  if (!hookUrl) return;
  return new Promise(resolve => {
    const u = new URL(hookUrl);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST' }, res => {
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.on('error', resolve);
    req.end();
  });
}
