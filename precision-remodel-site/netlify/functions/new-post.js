const https = require('https');

exports.handler = async (event) => {
  // Only accept POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Auth check
  const secret = process.env.NEW_POST_SECRET;
  const authHeader = event.headers['x-post-secret'] || event.headers['authorization'];
  if (secret && authHeader !== secret && authHeader !== `Bearer ${secret}`) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  // Parse body — handle both JSON and form-encoded
  let title, slug, content, category, date;
  try {
    const body = JSON.parse(event.body);
    title = body.title;
    slug = body.slug;
    content = body.content;
    category = body.category || 'General';
    date = body.date || new Date().toISOString().split('T')[0];
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body', detail: e.message }) };
  }

  // Validate
  if (!title || !content) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Required fields: title, content' }) };
  }

  // Generate slug from title if not provided
  if (!slug) {
    slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  // Build frontmatter + content
  const markdown = `---
title: "${title.replace(/"/g, '\\"')}"
slug: "${slug}"
date: "${date}"
category: "${category}"
author: "Precision Remodel LLC"
---

${content}`;

  // GitHub API — write file
  const githubToken = process.env.GITHUB_TOKEN;
  const githubRepo = process.env.GITHUB_REPO;
  const githubBranch = process.env.GITHUB_BRANCH || 'main';

  if (!githubToken || !githubRepo) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing GITHUB_TOKEN or GITHUB_REPO env vars' }) };
  }

  const filePath = `precision-remodel-site/blog/posts/${slug}.md`;
  const encoded = Buffer.from(markdown).toString('base64');

  const payload = JSON.stringify({
    message: `Add blog post: ${title}`,
    content: encoded,
    branch: githubBranch
  });

  const [owner, repo] = githubRepo.split('/');

  const result = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/contents/${filePath}`,
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${githubToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'Netlify-Function',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

  if (result.status !== 201 && result.status !== 200) {
    return { statusCode: 500, body: JSON.stringify({ error: 'GitHub write failed', detail: result.body }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ success: true, slug, path: filePath })
  };
};
