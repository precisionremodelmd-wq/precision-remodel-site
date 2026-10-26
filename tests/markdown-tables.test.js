/* Tests for markdownToHtml in precision-remodel-site/netlify/functions/new-post.js.
   Run: node tests/markdown-tables.test.js
   Optional parity check with the SEO dashboard preview port (remodelMd):
   DASHBOARD_HTML=/path/to/seo-command-center/dashboard/index.html node tests/markdown-tables.test.js */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { markdownToHtml } = require('../precision-remodel-site/netlify/functions/new-post.js')._test;

const CASES = [
  ['basic table',
    '| Item | Cost |\n|---|---|\n| Tile | $5 |\n| Grout | $1 |',
    '<div class="table-wrap"><table>\n<thead><tr><th>Item</th><th>Cost</th></tr></thead>\n<tbody>\n<tr><td>Tile</td><td>$5</td></tr>\n<tr><td>Grout</td><td>$1</td></tr>\n</tbody>\n</table></div>'],
  ['alignment',
    'Left | Center | Right | None\n:--- | :--: | ---: | ---\na | b | c | d',
    '<div class="table-wrap"><table>\n<thead><tr><th style="text-align:left">Left</th><th style="text-align:center">Center</th><th style="text-align:right">Right</th><th>None</th></tr></thead>\n<tbody>\n<tr><td style="text-align:left">a</td><td style="text-align:center">b</td><td style="text-align:right">c</td><td>d</td></tr>\n</tbody>\n</table></div>'],
  ['inline formatting, escaping, empty and missing cells, escaped pipe',
    '| A | B | C |\n|---|---|---|\n| **bold** <b>x</b> & y | [link](/contact.html) `a|b` | |\n| only \\| one |',
    '<div class="table-wrap"><table>\n<thead><tr><th>A</th><th>B</th><th>C</th></tr></thead>\n<tbody>\n<tr><td><strong>bold</strong> &lt;b&gt;x&lt;/b&gt; &amp; y</td><td><a href="/contact.html">link</a> <code>a|b</code></td><td></td></tr>\n<tr><td>only | one</td><td></td><td></td></tr>\n</tbody>\n</table></div>'],
  ['header only',
    '| A | B |\n|---|---|',
    '<div class="table-wrap"><table>\n<thead><tr><th>A</th><th>B</th></tr></thead>\n</table></div>'],
  ['table directly after paragraph line, then list and paragraph',
    'Here is the grid:\n| A | B |\n|---|---|\n| 1 | 2 |\n- item one\n- item two\n\nAfter.',
    '<p>Here is the grid:</p>\n<div class="table-wrap"><table>\n<thead><tr><th>A</th><th>B</th></tr></thead>\n<tbody>\n<tr><td>1</td><td>2</td></tr>\n</tbody>\n</table></div>\n<ul>\n<li>item one</li>\n<li>item two</li>\n</ul>\n<p>After.</p>'],
  ['not a table: column count mismatch stays a paragraph',
    '| A | B |\n|---|\n| 1 | 2 |',
    '<p>| A | B | |---| | 1 | 2 |</p>'],
  ['not a table: pipe in prose',
    'Choose this | or that\nnext line',
    '<p>Choose this | or that next line</p>'],
  ['hr is still hr',
    'Para\n\n---\n\nNext',
    '<p>Para</p>\n<hr>\n<p>Next</p>'],
  ['existing elements unchanged',
    '## Heading *em*\n\nPara with **b** and `c`.\nSecond line.\n\n> quote **q**\n> more\n\n1. one\n2. two\n\n```js\nconst a = "<x>";\n```\n\n![Alt](/images/blog/a.jpg "Cap")',
    '<h2>Heading <em>em</em></h2>\n<p>Para with <strong>b</strong> and <code>c</code>. Second line.</p>\n<blockquote><p>quote <strong>q</strong> more</p></blockquote>\n<ol>\n<li>one</li>\n<li>two</li>\n</ol>\n<pre><code>const a = &quot;&lt;x&gt;&quot;;</code></pre>\n<figure style="margin:2rem 0;"><img src="/images/blog/a.jpg" alt="Alt" loading="lazy" style="max-width:100%;height:auto;border-radius:6px;"><figcaption style="font-size:0.9rem;color:var(--text-muted);margin-top:0.4rem;">Cap</figcaption></figure>'],
  ['table inside code block is not converted',
    '```\n| A | B |\n|---|---|\n```',
    '<pre><code>| A | B |\n|---|---|</code></pre>'],
  ['CRLF input renders (used to hang)',
    '# Title\r\n\r\nPara one.\r\n\r\n| A | B |\r\n|---|---|\r\n| 1 | 2 |\r\n',
    '<h1>Title</h1>\n<p>Para one.</p>\n<div class="table-wrap"><table>\n<thead><tr><th>A</th><th>B</th></tr></thead>\n<tbody>\n<tr><td>1</td><td>2</td></tr>\n</tbody>\n</table></div>'],
];

function loadDashboardRemodelMd(file) {
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf('const htmlEsc =');
  const end = src.indexOf('/* Photo refs the publisher would drop');
  const chunk = src.slice(start, src.indexOf('\n', start)) + '\n' +
    src.slice(src.indexOf('function remodelImageTag'), end);
  return new Function(chunk + '\nreturn remodelMd;')();
}

const impls = [['new-post.js markdownToHtml', markdownToHtml]];
if (process.env.DASHBOARD_HTML) impls.push(['dashboard remodelMd', loadDashboardRemodelMd(process.env.DASHBOARD_HTML)]);

let failed = 0;
for (const [label, fn] of impls) {
  for (const [name, md, want] of CASES) {
    try { assert.strictEqual(fn(md), want); console.log(`ok   ${label}: ${name}`); }
    catch (e) { failed++; console.log(`FAIL ${label}: ${name}\n  got:  ${JSON.stringify(e.actual)}\n  want: ${JSON.stringify(want)}`); }
  }
}

/* Parity on every real post (only when the dashboard port is loaded) */
if (impls.length > 1) {
  const dir = path.join(__dirname, '../precision-remodel-site/blog/posts');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.md'))) {
    const md = fs.readFileSync(path.join(dir, f), 'utf8');
    if (impls[0][1](md) === impls[1][1](md)) console.log(`ok   parity: ${f}`);
    else { failed++; console.log(`FAIL parity: ${f}`); }
  }
}
if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('\nall passed');
