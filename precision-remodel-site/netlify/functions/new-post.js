/* --------------------------------------------------------
   Strip code fences and duplicate frontmatter from Claude output
   Claude sometimes wraps output in ```markdown ... ``` or
   includes a second frontmatter block inside the content.
   -------------------------------------------------------- */
function sanitizeClaudeOutput(raw) {
  if (!raw) return raw;

  let text = raw.trim();

  // Strip ```markdown ... ``` or ``` ... ``` wrappers
  text = text.replace(/^```[a-z]*\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  // If there's a frontmatter block at the top, strip it — new-post.js builds its own
  // Match one or two frontmatter blocks (Claude sometimes nests them)
  text = text.replace(/^---[\s\S]*?---\s*/m, '');
  text = text.replace(/^---[\s\S]*?---\s*/m, '');

  // Strip any remaining ``` fences inside the content
  text = text.replace(/^```[a-z]*\s*/gim, '').replace(/^```\s*$/gim, '');

  return text.trim();
}

/**
 * Netlify Function: new-post
 * POST /api/new-post
 *
 * Accepts { title, slug, content, category, tags, date, rowNumber } and writes a markdown
 * file to /blog/posts/[slug].md, then triggers a Netlify deploy hook so the
 * new post becomes live. After successful deploy, calls Make.com webhook to
 * mark the Google Sheet row as PUBLISHED.
 *
 * Environment variables required:
 *   NETLIFY_DEPLOY_HOOK  — Your Netlify build hook URL
 *   NEW_POST_SECRET      — A secret token to protect this endpoint
 *   GITHUB_TOKEN         — GitHub personal access token
 *   GITHUB_REPO          — e.g. "precisionremodelmd-wq/precision-remodel-site"
 *   GITHUB_BRANCH        — defaults to "main"
 *   MAKE_WEBHOOK_URL     — Make.com webhook to mark sheet row PUBLISHED
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

  const { title, slug, content: rawContent, category = 'General', tags = [], date, excerpt = '', metaDescription = '', rowNumber } = data;

  /* Strip code fences and duplicate frontmatter that Claude sometimes adds */
  const content = sanitizeClaudeOutput(rawContent);

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
excerpt: "${excerpt.replace(/"/g, '\\"')}"
metaDescription: "${metaDescription.replace(/"/g, '\\"')}"
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

    /* Update posts.json manifest (non-fatal if it fails) */
    const bodyForExcerpt = content
      .replace(/^```+\w*\s*/i, '')
      .replace(/^---[\s\S]*?---\s*/m, '')
      .replace(/^---[\s\S]*?---\s*/m, '')
      .trim();
    const excerptForManifest = excerpt || bodyForExcerpt
      .replace(/^#{1,6}\s+.+$/gm, '')
      .replace(/[*_`#>\[\]!]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 220);
    await updatePostsManifest(githubToken, githubRepo, githubBranch, {
      title,
      slug: safeSlug,
      date: postDate,
      category,
      excerpt: excerptForManifest,
      readTime,
      author: 'Precision Remodel LLC',
    }).catch(() => { /* manifest update failure is non-fatal */ });

    /* Write static pre-rendered HTML page for this post */
    await writeStaticPostHtml(githubToken, githubRepo, githubBranch, {
      safeSlug, title, postDate, category, excerpt, metaDescription, readTime, sanitizedContent: content,
    });

    /* Trigger Netlify deploy hook */
    await triggerDeploy();

    /* Mark Google Sheet row as PUBLISHED via Make.com webhook */
    if (rowNumber) {
      await markPublished(rowNumber);
    }

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
    /* __dirname is precision-remodel-site/netlify/functions — two levels up = precision-remodel-site/ */
    const siteRoot = path.resolve(__dirname, '..', '..');
    const outPath = path.join(siteRoot, 'blog', 'posts', `${safeSlug}.md`);
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
   Update blog/posts.json manifest (newest post first)
   -------------------------------------------------------- */
async function updatePostsManifest(token, repo, branch, newPost) {
  const apiUrl = `https://api.github.com/repos/${repo}/contents/precision-remodel-site/blog/posts.json`;
  const headers = {
    Authorization: `token ${token}`,
    'User-Agent': 'Precision-Remodel-CMS',
    Accept: 'application/vnd.github.v3+json',
  };

  let posts = [];
  try {
    const existing = await httpGet(apiUrl, headers);
    if (existing.content) {
      const decoded = Buffer.from(existing.content, 'base64').toString('utf8');
      posts = JSON.parse(decoded);
    }
  } catch { /* file doesn't exist yet — start fresh */ }

  /* Remove any existing entry with the same slug (re-publish case) */
  posts = posts.filter(p => p.slug !== newPost.slug);
  /* Prepend new post so newest is first */
  posts.unshift(newPost);

  return githubWrite(token, repo, branch, 'precision-remodel-site/blog/posts.json', JSON.stringify(posts, null, 2));
}

/* --------------------------------------------------------
   Mark Google Sheet row PUBLISHED via Make.com webhook
   -------------------------------------------------------- */
async function markPublished(rowNumber) {
  const webhookUrl = process.env.MAKE_WEBHOOK_URL ||
    'https://hook.us2.make.com/38xt6c5mh71a16iybmn8a7595d2cxght';
  return new Promise(resolve => {
    const body = JSON.stringify({ rowNumber });
    const u = new URL(webhookUrl);
    const options = {
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, res => {
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.on('error', resolve); /* non-fatal — don't fail the whole request */
    req.write(body);
    req.end();
  });
}

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

/* --------------------------------------------------------
   Build and write a fully pre-rendered static HTML blog post
   -------------------------------------------------------- */
async function writeStaticPostHtml(token, repo, branch, {
  safeSlug, title, postDate, category, excerpt, metaDescription, readTime, sanitizedContent,
}) {
  const bodyHtml = markdownToHtml(sanitizedContent);
  const displayDate = formatPostDate(postDate);
  const pageTitle = `${escapeHtml(title)} | Precision Remodel LLC`;
  const pageDesc = escapeHtml(metaDescription || excerpt || '');
  const canonicalUrl = `https://precisionremodelingmd.com/blog/${safeSlug}`;

  const ldJson = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: title,
    datePublished: postDate,
    author: { '@type': 'Organization', name: 'Precision Remodel LLC' },
    publisher: { '@type': 'Organization', name: 'Precision Remodel LLC', url: 'https://precisionremodelingmd.com' },
    description: metaDescription || excerpt || '',
    url: canonicalUrl,
  }, null, 2).replace(/<\/script>/gi, '<\\/script>');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <!-- Google Analytics GA4 -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-ZVFS59JZZC"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-ZVFS59JZZC');
  </script>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${pageTitle}</title>
  <meta name="description" content="${pageDesc}">
  <link rel="canonical" href="${canonicalUrl}">

  <meta property="og:type" content="article">
  <meta property="og:url" content="${canonicalUrl}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${pageDesc}">
  <meta property="og:image" content="https://precisionremodelingmd.com/images/projects/kitchen-perry-hall-after.png">

  <script type="application/ld+json">
  ${ldJson}
  </script>

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../css/styles.css">
  <link rel="icon" type="image/png" href="../images/projects/kitchen-perry-hall-after.png">
  <link rel="apple-touch-icon" href="../images/projects/kitchen-perry-hall-after.png">
</head>
<body>

  <nav class="nav" id="nav">
    <div class="nav-inner">
      <a href="/" class="nav-logo">
        <span class="nav-logo-name">Precision Remodel</span>
        <span class="nav-logo-tag">MHIC #151439 · NE Baltimore County</span>
      </a>
      <ul class="nav-links" id="navLinks">
        <li><a href="/kitchens.html">Kitchens</a></li>
        <li><a href="/bathrooms.html">Bathrooms</a></li>
        <li><a href="/structural-repairs.html">Structural Repairs</a></li>
        <li><a href="/our-work.html">Our Work</a></li>
        <li><a href="/process.html">Process</a></li>
        <li><a href="/about.html">About</a></li>
        <li><a href="/blog/index.html" class="active">Blog</a></li>
        <li><a href="tel:4437619209" class="nav-phone"><svg class="icon-phone" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15" aria-hidden="true"><path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/></svg><span class="nav-phone-num">443-761-9209</span></a></li>
        <li><a href="/contact.html" class="nav-cta">Free Consultation</a></li>
      </ul>
      <button class="nav-toggle" id="navToggle" aria-label="Toggle menu" aria-expanded="false">
        <span></span><span></span><span></span>
      </button>
    </div>
  </nav>

  <section class="page-hero">
    <div class="page-hero-inner">
      <nav class="breadcrumb" aria-label="Breadcrumb">
        <a href="/">Home</a><span>›</span><a href="/blog/index.html">Blog</a><span>›</span><span>${escapeHtml(title)}</span>
      </nav>
      <span class="section-label">${escapeHtml(category)}</span>
      <h1>${escapeHtml(title)}</h1>
      <div class="divider"></div>
      <p style="color:var(--text-muted);font-size:0.85rem;letter-spacing:0.04em;margin:0;">${displayDate} &nbsp;&middot;&nbsp; ${escapeHtml(readTime)}</p>
    </div>
  </section>

  <article class="section">
    <div class="container" style="max-width:740px;">
      <div class="post-body" style="line-height:1.85;font-size:1.05rem;">
        ${bodyHtml}
      </div>
    </div>
  </article>

  <section class="section section--alt" aria-labelledby="post-cta-heading">
    <div class="container" style="max-width:640px;text-align:center;">
      <span class="section-label">Get Started</span>
      <h2 id="post-cta-heading">Ready to Talk<br><em style="font-style:italic;">About Your Project?</em></h2>
      <div class="divider"></div>
      <p style="margin:0 auto 2.5rem;">Free in-home consultation. Jonathan will walk your space, discuss your goals, and give you an honest assessment of what&rsquo;s possible at your budget. No obligation.</p>
      <a href="/contact.html" class="btn btn-primary">Request a Free Consultation</a>
      <p style="margin-top:1.25rem;font-size:0.8rem;color:var(--text-muted);">We serve Essex, White Marsh, Perry Hall, Towson, and surrounding NE Baltimore County communities only.</p>
    </div>
  </section>

  <footer>
    <div class="footer-inner">
      <div class="footer-top">
        <div class="footer-brand">
          <span class="nav-logo-name" style="display:block;margin-bottom:4px;">Precision Remodel LLC</span>
          <span class="nav-logo-tag" style="display:block;">MHIC #151439 · NE Baltimore County</span>
          <p>Luxury kitchen and bathroom remodeling for homeowners in NE Baltimore County.</p>
          <div class="footer-contact">
            <div class="footer-contact-item"><span class="lbl">Phone</span><a href="tel:4437619209">443-761-9209</a></div>
            <div class="footer-contact-item"><span class="lbl">Email</span><a href="mailto:jon@precisionremodelingmd.com">jon@precisionremodelingmd.com</a></div>
          </div>
        </div>
        <div class="footer-col">
          <h5>Services</h5>
          <ul>
            <li><a href="/kitchens.html">Kitchen Remodeling</a></li>
            <li><a href="/bathrooms.html">Bathroom Remodeling</a></li>
            <li><a href="/structural-repairs.html">Structural Repairs</a></li>
            <li><a href="/contact.html">Free Consultation</a></li>
          </ul>
        </div>
        <div class="footer-col">
          <h5>Company</h5>
          <ul>
            <li><a href="/about.html">About Jonathan</a></li>
            <li><a href="/process.html">Our Process</a></li>
            <li><a href="/service-area.html">Service Area</a></li>
            <li><a href="/blog/index.html">Blog</a></li>
          </ul>
        </div>
        <div class="footer-col">
          <h5>Contact</h5>
          <ul>
            <li><a href="/contact.html">Free Consultation</a></li>
            <li><a href="tel:4437619209">443-761-9209</a></li>
          </ul>
        </div>
      </div>
      <div class="footer-bottom">
        <p>&copy; 2026 Precision Remodel LLC &middot; NE Baltimore County, MD</p>
        <span class="footer-license">MHIC #151439</span>
      </div>
    </div>
  </footer>

  <script src="../js/main.js"></script>
</body>
</html>`;

  return githubWrite(token, repo, branch, `precision-remodel-site/blog/${safeSlug}.html`, html);
}

/* --------------------------------------------------------
   Format a YYYY-MM-DD date string for display
   -------------------------------------------------------- */
function formatPostDate(dateStr) {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const [year, month, day] = dateStr.split('-').map(Number);
  return `${months[month - 1]} ${day}, ${year}`;
}

/* --------------------------------------------------------
   Escape HTML special characters for use in attributes / text
   -------------------------------------------------------- */
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* --------------------------------------------------------
   Convert inline markdown to HTML (bold, italic, code, links)
   -------------------------------------------------------- */
function inlineMarkdown(text) {
  return text
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/_([^_\n]+)_/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

/* --------------------------------------------------------
   Convert a markdown string to an HTML string.
   Handles headings, paragraphs, lists, blockquotes,
   fenced code blocks, horizontal rules, and inline styles.
   -------------------------------------------------------- */
function markdownToHtml(md) {
  if (!md) return '';

  /* Protect fenced code blocks */
  const codeBlocks = [];
  let text = md.replace(/```[\w]*\n([\s\S]*?)```/gm, (_, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code>${escapeHtml(code.trim())}</code></pre>`);
    return `\x00CODE${idx}\x00`;
  });

  const lines = text.split('\n');
  const output = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    /* Code block placeholder */
    if (/\x00CODE\d+\x00/.test(line)) {
      output.push(line);
      i++;
      continue;
    }

    /* Blank line */
    if (line.trim() === '') { i++; continue; }

    /* Heading */
    const hm = line.match(/^(#{1,6})\s+(.+)$/);
    if (hm) {
      const lvl = hm[1].length;
      output.push(`<h${lvl}>${inlineMarkdown(hm[2])}</h${lvl}>`);
      i++;
      continue;
    }

    /* Horizontal rule */
    if (/^[-*_]{3,}\s*$/.test(line)) {
      output.push('<hr>');
      i++;
      continue;
    }

    /* Blockquote */
    if (line.startsWith('> ')) {
      const bq = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        bq.push(lines[i].slice(2));
        i++;
      }
      output.push(`<blockquote><p>${inlineMarkdown(bq.join(' '))}</p></blockquote>`);
      continue;
    }

    /* Unordered list */
    if (/^[-*+]\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*+]\s/.test(lines[i])) {
        items.push(`<li>${inlineMarkdown(lines[i].replace(/^[-*+]\s+/, ''))}</li>`);
        i++;
      }
      output.push(`<ul>\n${items.join('\n')}\n</ul>`);
      continue;
    }

    /* Ordered list */
    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(`<li>${inlineMarkdown(lines[i].replace(/^\d+\.\s+/, ''))}</li>`);
        i++;
      }
      output.push(`<ol>\n${items.join('\n')}\n</ol>`);
      continue;
    }

    /* Paragraph — accumulate lines until a blank or block-level element */
    const para = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') break;
      if (/^#{1,6}\s/.test(l)) break;
      if (/^[-*+]\s/.test(l)) break;
      if (/^\d+\.\s/.test(l)) break;
      if (l.startsWith('> ')) break;
      if (/^[-*_]{3,}\s*$/.test(l)) break;
      if (/\x00CODE\d+\x00/.test(l)) break;
      para.push(l);
      i++;
    }
    if (para.length > 0) {
      output.push(`<p>${inlineMarkdown(para.join(' '))}</p>`);
    }
  }

  /* Restore code blocks */
  let result = output.join('\n');
  codeBlocks.forEach((block, idx) => {
    result = result.replace(`\x00CODE${idx}\x00`, block);
  });
  return result;
}
