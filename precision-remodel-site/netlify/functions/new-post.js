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

  if (data && data.action === 'update') {
    return updatePost(data);
  }

  const { title, slug, content: rawContent, category = 'General', tags = [], date, excerpt = '', metaDescription = '', metaTitle = '', rowNumber, images = [] } = data;

  /* Optional job photos sent with the post: [{ filename, base64 }] → committed to /images/blog/.
     The site's CSP only allows its own images, so photos must live in the repo. */
  const imgErr = validateImages(images);
  if (imgErr) return { statusCode: 400, body: JSON.stringify({ error: imgErr }) };

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
${metaTitle ? `metaTitle: "${metaTitle.replace(/"/g, '\\"')}"\n` : ''}author: "Precision Remodel LLC"
readTime: "${readTime}"
---

${content.trim()}
`;

  /* --- Option A: GitHub API (production-recommended) --- */
  const githubToken = process.env.GITHUB_TOKEN;
  const githubRepo = process.env.GITHUB_REPO; /* e.g. "username/repo-name" */
  const githubBranch = process.env.GITHUB_BRANCH || 'main';

  if (githubToken && githubRepo) {
    for (const img of images) {
      const r = await githubWrite(githubToken, githubRepo, githubBranch,
        `precision-remodel-site/images/blog/${img.filename}`, img.base64, true);
      if (!r.ok) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Image write failed', file: img.filename, detail: r.error }) };
      }
    }

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
    const firstImg = (content.match(/!\[[^\]]*\]\((\/images\/blog\/[a-z0-9-]+\.(?:jpg|jpeg|png|webp))/) || [])[1];
    const htmlResult = await writeStaticPostHtml(githubToken, githubRepo, githubBranch, {
      safeSlug, title, postDate, category, excerpt, metaDescription, metaTitle, readTime, sanitizedContent: content,
      ogImage: firstImg ? `https://precisionremodelingmd.com${firstImg}` : null,
    });
    if (!htmlResult.ok) {
      return { statusCode: 500, body: JSON.stringify({ error: 'HTML write failed', detail: htmlResult.error }) };
    }

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
  const webhookUrl = process.env.MAKE_WEBHOOK_URL;
  if (!webhookUrl) {
    throw new Error('MAKE_WEBHOOK_URL environment variable is not set');
  }
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
async function githubWrite(token, repo, branch, filePath, content, isBase64 = false) {
  const encoded = isBase64 ? content : Buffer.from(content).toString('base64');
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
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers }, res => {
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
async function writeStaticPostHtml(token, repo, branch, opts) {
  const html = buildStaticPostHtml(opts);
  return githubWrite(token, repo, branch, `precision-remodel-site/blog/${opts.safeSlug}.html`, html);
}

function buildStaticPostHtml({
  safeSlug, title, postDate, category, excerpt, metaDescription, metaTitle, readTime, sanitizedContent, ogImage,
}) {
  const bodyHtml = markdownToHtml(sanitizedContent);
  const displayDate = formatPostDate(postDate);
  const pageTitle = metaTitle ? escapeHtml(metaTitle) : `${escapeHtml(title)} | Precision Remodel LLC`;
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
  <meta property="og:title" content="${escapeHtml(metaTitle || title)}">
  <meta property="og:description" content="${pageDesc}">
  <meta property="og:image" content="${escapeHtml(ogImage || 'https://precisionremodelingmd.com/images/projects/kitchen-perry-hall-after.png')}">

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

  return html;
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
function imageTag(alt, src, title) {
  /* only the site's own blog images or https URLs */
  if (!/^(\/images\/[a-z0-9/_-]+\.(jpg|jpeg|png|webp)|https:\/\/[^\s"<>]+)$/i.test(src)) return '';
  const t = title ? ` title="${escapeHtml(title)}"` : '';
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${t} loading="lazy" style="max-width:100%;height:auto;border-radius:6px;">`;
}

const IMG_RE = /!\[([^\]]*)\]\(([^\s)]+)(?:\s+"(.*?)")?\)/g;

function inlineMarkdown(text) {
  text = text.replace(IMG_RE, (m, alt, src, title) => imageTag(alt, src, title));
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

    /* Image on its own line → figure with caption */
    const im = line.trim().match(/^!\[([^\]]*)\]\(([^\s)]+)(?:\s+"(.*?)")?\)$/);
    if (im) {
      const tag = imageTag(im[1], im[2], '');
      if (tag) {
        const cap = im[3] ? `<figcaption style="font-size:0.9rem;color:var(--text-muted);margin-top:0.4rem;">${escapeHtml(im[3])}</figcaption>` : '';
        output.push(`<figure style="margin:2rem 0;">${tag}${cap}</figure>`);
      }
      i++;
      continue;
    }

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

/* --------------------------------------------------------
   Shared validation for photos sent with a post
   -------------------------------------------------------- */
function validateImages(images) {
  if (!Array.isArray(images) || images.length > 8) return 'images must be an array of at most 8 files';
  for (const img of images) {
    if (!img || !/^[a-z0-9][a-z0-9-]{0,80}\.(jpg|jpeg|png|webp)$/.test(img.filename || '') || typeof img.base64 !== 'string') {
      return 'Each image needs a safe filename (a-z, 0-9, -) and base64 data';
    }
    if (Buffer.byteLength(img.base64, 'base64') > 6 * 1024 * 1024) return `Image too large: ${img.filename}`;
  }
  return null;
}

/* --------------------------------------------------------
   Update an existing post (approved in the SEO Command Center):
   { action: "update", slug, metaTitle?, metaDescription?, title?,
     images?: [{ filename, base64 }],
     insertions?: [{ afterHeading, markdown: '![alt](/images/blog/x.jpg "caption")' }],
     body?: "full replacement markdown body" }
   body replaces everything after the front matter (front matter kept, readTime recomputed; insertions are
   then applied to the new body). The slug / URL never changes.
   Rewrites blog/posts/<slug>.md and re-renders blog/<slug>.html as a full static page
   (older posts were client-rendered shells that Google saw as "Blog | ..." / "Loading…").
   -------------------------------------------------------- */
const FM_ORDER = ['title', 'slug', 'date', 'category', 'tags', 'excerpt', 'metaDescription', 'metaTitle', 'author', 'readTime'];
const INSERT_RE = /^!\[[^\]\n]{0,200}\]\(\/images\/blog\/[a-z0-9-]+\.(?:jpg|jpeg|png|webp)(?:\s+"[^"\n]{0,300}")?\)$/;

function parseFrontmatter(raw) {
  const text = raw.replace(/\r\n/g, '\n');
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { fm: {}, raw: {}, body: text };
  const fm = {}, rawVals = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z_][\w]*):\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    rawVals[k] = v;
    if (v.startsWith('"')) {
      try { fm[k] = JSON.parse(v); } catch { fm[k] = v.replace(/^"|"$/g, '').replace(/\\"/g, '"'); }
    } else {
      fm[k] = v;
    }
  }
  return { fm, raw: rawVals, body: m[2] };
}

function buildFrontmatter(fm, rawVals) {
  const keys = [...FM_ORDER.filter(k => k in fm), ...Object.keys(fm).filter(k => !FM_ORDER.includes(k))];
  const lines = keys.map(k => {
    if (k === 'tags') return `tags: ${rawVals.tags || '[]'}`;
    return `${k}: ${JSON.stringify(String(fm[k] ?? ''))}`;
  });
  return `---\n${lines.join('\n')}\n---\n`;
}

function normHeading(s) {
  return String(s || '').toLowerCase().replace(/[*_`#]/g, '').replace(/&[a-z]+;/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/* Insert a standalone markdown line after the heading whose text matches; returns [body, inserted?] */
function insertAfterHeading(body, heading, markdownLine) {
  const target = normHeading(heading);
  if (!target) return [body, false];
  const lines = body.split('\n');
  let idx = lines.findIndex(l => /^#{2,4}\s/.test(l) && normHeading(l) === target);
  if (idx < 0) idx = lines.findIndex(l => /^#{2,4}\s/.test(l) && normHeading(l).startsWith(target));
  if (idx < 0) return [body, false];
  lines.splice(idx + 1, 0, '', markdownLine, '');
  return [lines.join('\n').replace(/\n{3,}/g, '\n\n'), true];
}

function stripLeadingH1(md) {
  return md.replace(/^\s*#\s+[^\n]+\n+/, '');
}

async function githubRead(token, repo, branch, filePath) {
  const data = await httpGet(
    `https://api.github.com/repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(branch)}`,
    { Authorization: `token ${token}`, 'User-Agent': 'Precision-Remodel-CMS', Accept: 'application/vnd.github.v3+json' });
  if (!data || typeof data.content !== 'string') {
    return { ok: false, error: (data && data.message) || 'not found' };
  }
  return { ok: true, text: Buffer.from(data.content, 'base64').toString('utf8') };
}

const MAX_BODY = 60000;

/* A replacement body from the SEO Command Center: same markdown the converter already renders. Images may only
   point at the site's own /images/blog/ files (the CSP blocks everything else). */
function validateBody(body) {
  if (typeof body !== 'string' || !body.trim()) return 'body must be non-empty markdown';
  if (body.length > MAX_BODY) return `body must be at most ${MAX_BODY} characters`;
  if (/^\s*---\s*\n[\s\S]*?\n---\s*(\n|$)/.test(body) && /^\s*---\s*\n[A-Za-z_]\w*:/.test(body)) return 'body must not include front matter';
  if (/<\/?[a-z][^>]*>/i.test(body.replace(/```[\s\S]*?```/g, ''))) return 'body must be markdown, not HTML';
  for (const m of body.matchAll(/!\[[^\]]*\]\(([^\s)]+)/g)) {
    if (!/^\/images\/blog\/[a-z0-9-]+\.(?:jpg|jpeg|png|webp)$/.test(m[1])) return `image not allowed in body: ${m[1]}`;
  }
  return null;
}

function applyUpdate(rawMd, { metaTitle, metaDescription, title, insertions = [], body: newBody }) {
  const { fm, raw, body: origBody } = parseFrontmatter(rawMd);
  let body = origBody;
  if (typeof newBody === 'string' && newBody.trim()) {
    body = stripLeadingH1(newBody.replace(/\r\n/g, '\n')).trim() + '\n';   /* not sanitizeClaudeOutput: it would eat --- rules and code fences */
    const words = body.split(/\s+/).filter(Boolean).length;
    fm.readTime = `${Math.max(1, Math.ceil(words / 200))} min read`;
  }
  const inserted = [], skipped = [];
  for (const ins of insertions) {
    const src = (ins.markdown.match(/\((\/images\/blog\/[^\s)]+)/) || [])[1];
    if (src && body.includes(src)) { skipped.push(ins.afterHeading); continue; }
    const [next, ok] = insertAfterHeading(body, ins.afterHeading, ins.markdown);
    if (ok) { body = next; inserted.push(ins.afterHeading); } else { skipped.push(ins.afterHeading); }
  }
  if (metaTitle) fm.metaTitle = metaTitle;
  if (metaDescription) {
    fm.metaDescription = metaDescription;
    if (!fm.excerpt) fm.excerpt = metaDescription;
  }
  if (title) fm.title = title;
  const md = buildFrontmatter(fm, raw) + '\n' + body.replace(/^\n+/, '');
  return { fm, body, md, inserted, skipped };
}

async function updatePost(data) {
  const json = (statusCode, obj) => ({ statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) });
  const { slug, metaTitle = '', metaDescription = '', title = '', images = [], insertions = [], body } = data;
  if (!/^[a-z0-9][a-z0-9-]{0,150}$/.test(slug || '')) return json(400, { error: 'invalid slug' });
  const imgErr = validateImages(images);
  if (imgErr) return json(400, { error: imgErr });
  if (!Array.isArray(insertions) || insertions.length > 8) return json(400, { error: 'insertions must be an array of at most 8' });
  for (const ins of insertions) {
    if (!ins || typeof ins.afterHeading !== 'string' || !INSERT_RE.test(ins.markdown || '')) {
      return json(400, { error: 'each insertion needs afterHeading and a single /images/blog/ image line' });
    }
  }
  if (body !== undefined && body !== null && body !== '') {
    const bodyErr = validateBody(body);
    if (bodyErr) return json(400, { error: bodyErr });
  }
  for (const [k, v, max] of [['metaTitle', metaTitle, 80], ['metaDescription', metaDescription, 200], ['title', title, 160]]) {
    if (typeof v !== 'string' || v.length > max || /[\n<>]/.test(v)) return json(400, { error: `${k} must be plain text up to ${max} characters` });
  }

  const token = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPO, branch = process.env.GITHUB_BRANCH || 'main';
  if (!token || !repo) return json(500, { error: 'GITHUB_TOKEN / GITHUB_REPO not configured' });

  const mdPath = `precision-remodel-site/blog/posts/${slug}.md`;
  const cur = await githubRead(token, repo, branch, mdPath);
  if (!cur.ok) return json(cur.error === 'Not Found' ? 404 : 500, { error: 'Could not read post', detail: cur.error });

  const up = applyUpdate(cur.text, { metaTitle, metaDescription, title, insertions, body: body || undefined });

  for (const img of images) {
    const r = await githubWrite(token, repo, branch, `precision-remodel-site/images/blog/${img.filename}`, img.base64, true);
    if (!r.ok) return json(500, { error: 'Image write failed', file: img.filename, detail: r.error });
  }
  const w = await githubWrite(token, repo, branch, mdPath, up.md);
  if (!w.ok) return json(500, { error: 'GitHub write failed', detail: w.error });

  const fm = up.fm;
  const wordCount = up.body.split(/\s+/).length;
  const firstImg = (up.body.match(/!\[[^\]]*\]\((\/images\/blog\/[a-z0-9-]+\.(?:jpg|jpeg|png|webp))/) || [])[1];
  const html = await writeStaticPostHtml(token, repo, branch, {
    safeSlug: slug, title: fm.title || slug, postDate: /^\d{4}-\d{2}-\d{2}$/.test(fm.date || '') ? fm.date : new Date().toISOString().split('T')[0],
    category: fm.category || 'Remodeling', excerpt: fm.excerpt || '', metaDescription: fm.metaDescription || '',
    metaTitle: fm.metaTitle || '', readTime: fm.readTime || `${Math.max(1, Math.ceil(wordCount / 200))} min read`,
    sanitizedContent: stripLeadingH1(up.body),
    ogImage: firstImg ? `https://precisionremodelingmd.com${firstImg}` : null,
  });
  if (!html.ok) return json(500, { error: 'HTML write failed', detail: html.error });

  const manifest = {};
  if (title) manifest.title = title;
  if (body) {
    manifest.readTime = fm.readTime;
    /* the blog index card showed the old (generic) text: refresh it */
    manifest.excerpt = fm.excerpt || stripLeadingH1(up.body).replace(/^#{1,6}\s+.+$/gm, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/[*_`#>\[\]!]/g, '').replace(/\s+/g, ' ').trim().slice(0, 220);
  }
  if (Object.keys(manifest).length) {
    await updateManifestEntry(token, repo, branch, slug, manifest).catch(() => {});
  }
  await triggerDeploy();
  return json(200, { success: true, slug, url: `/blog/${slug}`, inserted: up.inserted, skipped: up.skipped,
    bodyReplaced: !!body });
}

async function updateManifestEntry(token, repo, branch, slug, fields) {
  const r = await githubRead(token, repo, branch, 'precision-remodel-site/blog/posts.json');
  if (!r.ok) return;
  const posts = JSON.parse(r.text);
  const p = posts.find(x => x.slug === slug);
  if (!p) return;
  Object.assign(p, fields);
  return githubWrite(token, repo, branch, 'precision-remodel-site/blog/posts.json', JSON.stringify(posts, null, 2));
}

exports._test = { parseFrontmatter, buildFrontmatter, insertAfterHeading, applyUpdate, buildStaticPostHtml, stripLeadingH1, validateImages, validateBody };
