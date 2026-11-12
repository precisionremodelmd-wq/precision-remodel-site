/**
 * generate-html-local.js
 * Generates static HTML files for blog posts that are missing them,
 * writing directly into the local repo so they can be committed and pushed.
 *
 * Usage:  node generate-html-local.js
 */

const fs   = require('fs');
const path = require('path');

const SLUGS = [
  'how-long-does-a-kitchen-remodel-take-in-baltimore-county',
  '5-signs-its-time-to-remodel-your-kitchen',
  'bathroom-remodel-cost-guide-northeast-baltimore-county-2026',
  'walk-in-shower-vs-tub-what-adds-more-resale-value-in-md',
  'how-to-verify-a-maryland-contractor-license-before-hiring-anyone',
  'quartz-vs-granite-countertops-which-is-right-for-your-baltimore-county-kitchen',
  'what-to-expect-during-a-kitchen-remodel-week-by-week-in-baltimore-county',
];

const SITE_DIR  = path.join(__dirname, 'precision-remodel-site');
const POSTS_DIR = path.join(SITE_DIR, 'blog', 'posts');
const BLOG_DIR  = path.join(SITE_DIR, 'blog');

/* -------------------------------------------------------- */

function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error('No frontmatter block found');
  const fm      = match[1];
  const content = match[2].trim();
  const data    = {};
  for (const line of fm.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let   val = line.slice(colon + 1).trim();
    if (val.startsWith('[')) {
      try { data[key] = JSON.parse(val); }
      catch { data[key] = val.replace(/[\[\]]/g,'').split(',').map(s=>s.trim().replace(/^["']|["']$/g,'')).filter(Boolean); }
    } else {
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1);
      data[key] = val.replace(/\\"/g, '"').replace(/\\'/g, "'");
    }
  }
  return { data, content };
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatPostDate(dateStr) {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const [year, month, day] = dateStr.split('-').map(Number);
  return `${months[month - 1]} ${day}, ${year}`;
}

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

function markdownToHtml(md) {
  if (!md) return '';
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
    if (/\x00CODE\d+\x00/.test(line)) { output.push(line); i++; continue; }
    if (line.trim() === '') { i++; continue; }
    const hm = line.match(/^(#{1,6})\s+(.+)$/);
    if (hm) { output.push(`<h${hm[1].length}>${inlineMarkdown(hm[2])}</h${hm[1].length}>`); i++; continue; }
    if (/^[-*_]{3,}\s*$/.test(line)) { output.push('<hr>'); i++; continue; }
    if (line.startsWith('> ')) {
      const bq = [];
      while (i < lines.length && lines[i].startsWith('> ')) { bq.push(lines[i].slice(2)); i++; }
      output.push(`<blockquote><p>${inlineMarkdown(bq.join(' '))}</p></blockquote>`); continue;
    }
    if (/^[-*+]\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*+]\s/.test(lines[i]))
        items.push(`<li>${inlineMarkdown(lines[i++].replace(/^[-*+]\s+/, ''))}</li>`);
      output.push(`<ul>\n${items.join('\n')}\n</ul>`); continue;
    }
    if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i]))
        items.push(`<li>${inlineMarkdown(lines[i++].replace(/^\d+\.\s+/, ''))}</li>`);
      output.push(`<ol>\n${items.join('\n')}\n</ol>`); continue;
    }
    const para = [];
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '' || /^#{1,6}\s/.test(l) || /^[-*+]\s/.test(l) || /^\d+\.\s/.test(l) ||
          l.startsWith('> ') || /^[-*_]{3,}\s*$/.test(l) || /\x00CODE\d+\x00/.test(l)) break;
      para.push(l); i++;
    }
    if (para.length > 0) output.push(`<p>${inlineMarkdown(para.join(' '))}</p>`);
  }
  let result = output.join('\n');
  codeBlocks.forEach((b, idx) => { result = result.replace(`\x00CODE${idx}\x00`, b); });
  return result;
}

function buildHtml({ safeSlug, title, postDate, category, excerpt, metaDescription, readTime, sanitizedContent }) {
  const bodyHtml     = markdownToHtml(sanitizedContent);
  const displayDate  = formatPostDate(postDate);
  const pageTitle    = `${escapeHtml(title)} | Precision Remodel LLC`;
  const pageDesc     = escapeHtml(metaDescription || excerpt || '');
  const canonicalUrl = `https://precisionremodelingmd.com/blog/${safeSlug}`;
  const ldJson = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'BlogPosting',
    headline: title, datePublished: postDate,
    author: { '@type': 'Organization', name: 'Precision Remodel LLC' },
    publisher: { '@type': 'Organization', name: 'Precision Remodel LLC', url: 'https://precisionremodelingmd.com' },
    description: metaDescription || excerpt || '', url: canonicalUrl,
  }, null, 2).replace(/<\/script>/gi, '<\\/script>');

  return `<!DOCTYPE html>
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
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400..600&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../css/styles.css?v=20261112">
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
      <h2 id="post-cta-heading">Ready to Talk<br><em>About Your Project?</em></h2>
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
}

/* -------------------------------------------------------- */

let generated = 0;
for (const slug of SLUGS) {
  const mdPath   = path.join(POSTS_DIR, `${slug}.md`);
  const htmlPath = path.join(BLOG_DIR,  `${slug}.html`);

  if (!fs.existsSync(mdPath)) {
    console.log(`SKIP (no .md): ${slug}`);
    continue;
  }

  let fm, content;
  try {
    const raw = fs.readFileSync(mdPath, 'utf8');
    ({ data: fm, content } = parseFrontmatter(raw));
  } catch (err) {
    console.log(`ERROR parsing ${slug}: ${err.message}`);
    continue;
  }

  const wordCount = content.split(/\s+/).length;
  const readTime  = fm.readTime || `${Math.max(1, Math.ceil(wordCount / 200))} min read`;

  const html = buildHtml({
    safeSlug:         slug,
    title:            fm.title            || '',
    postDate:         fm.date             || '2026-01-01',
    category:         fm.category         || 'General',
    excerpt:          fm.excerpt          || '',
    metaDescription:  fm.metaDescription  || '',
    readTime,
    sanitizedContent: content,
  });

  fs.writeFileSync(htmlPath, html, 'utf8');
  console.log(`✓ ${slug}.html  (${html.length} bytes)`);
  generated++;
}

console.log(`\nDone — ${generated}/${SLUGS.length} files written.`);
