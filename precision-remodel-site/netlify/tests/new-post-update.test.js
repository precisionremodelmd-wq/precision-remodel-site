/* Exercises new-post.js's { action: "update" } path with the GitHub API stubbed (no network).
   Run:  node --test precision-remodel-site/netlify/tests/   (Node 18+) */
const test = require('node:test');
const assert = require('node:assert');
const https = require('https');
const { EventEmitter } = require('events');

/* ---- fake GitHub contents API: an in-memory repo ---- */
const files = new Map();
const puts = [];
let deploys = 0;
https.request = (opts, cb) => {
  const req = new EventEmitter();
  let sent = '';
  req.write = (d) => { sent += d; };
  req.end = () => {
    const res = new EventEmitter();
    let status = 200, out = '';
    if (opts.hostname === 'api.netlify.com') { deploys++; }
    else {
      const path = decodeURIComponent(opts.path.replace(/^\/repos\/[^/]+\/[^/]+\/contents\//, '').replace(/\?.*$/, ''));
      if (opts.method === 'GET') {
        if (files.has(path)) out = JSON.stringify({ sha: 'sha-' + path, content: Buffer.from(files.get(path)).toString('base64') });
        else { status = 404; out = JSON.stringify({ message: 'Not Found' }); }
      } else if (opts.method === 'PUT') {
        const b = JSON.parse(sent);
        puts.push(path);
        files.set(path, Buffer.from(b.content, 'base64').toString('utf8'));
        status = 201; out = '{}';
      }
    }
    res.statusCode = status;
    cb(res);
    setImmediate(() => { res.emit('data', out); res.emit('end'); });
  };
  return req;
};

process.env.GITHUB_TOKEN = 't';
process.env.GITHUB_REPO = 'o/r';
process.env.NEW_POST_SECRET = 's';
process.env.NETLIFY_DEPLOY_HOOK = 'https://api.netlify.com/build_hooks/x';
const fn = require('../functions/new-post.js');

const SLUG = 'quartz-vs-granite-countertops-which-is-right-for-your-baltimore-county-kitchen';
const MD = `---
title: "Quartz vs granite countertops — which is right for your Baltimore County kitchen"
slug: "${SLUG}"
date: "2026-07-01"
category: "Kitchen"
tags: ["countertops"]
excerpt: ""
metaDescription: ""
author: "Precision Remodel LLC"
readTime: "4 min read"
---

# Home Remodeling Tips for Northeast Baltimore County Homeowners

Generic text.

## Start With a Clear Vision

More generic text.
`;
const NEW_BODY = `Quartz is the lower-maintenance pick for most busy kitchens; granite wins on heat and on one-of-a-kind stone.

## Which is more durable, quartz or granite?

Both are hard. Quartz is non-porous.

![Quartz counter with undermount sink](/images/blog/quartz-sink-abc123.jpg "A quartz top on a recent job.")

- Quartz: no sealing
- Granite: seal yearly

---

## Frequently asked questions

### Does quartz stain?

Rarely.
`;
const call = (payload) => fn.handler({ httpMethod: 'POST', headers: { 'x-post-secret': 's' }, body: JSON.stringify(payload) });

test('update with body replaces the markdown body, keeps front matter, re-renders the page', async () => {
  files.clear(); puts.length = 0; deploys = 0;
  files.set(`precision-remodel-site/blog/posts/${SLUG}.md`, MD);
  files.set('precision-remodel-site/blog/posts.json', JSON.stringify([{ slug: SLUG, title: 'Quartz vs granite', excerpt: '', readTime: '4 min read' }]));
  const res = await call({ action: 'update', slug: SLUG, metaTitle: 'Quartz vs Granite Countertops in Baltimore County',
    metaDescription: 'd'.repeat(150), title: '', body: '# Should Be Dropped\n\n' + NEW_BODY,
    images: [{ filename: 'quartz-sink-abc123.jpg', base64: Buffer.from('jpeg').toString('base64') }], insertions: [] });
  assert.strictEqual(res.statusCode, 200, res.body);
  const out = JSON.parse(res.body);
  assert.strictEqual(out.bodyReplaced, true);
  assert.strictEqual(out.url, `/blog/${SLUG}`);

  const md = files.get(`precision-remodel-site/blog/posts/${SLUG}.md`);
  const { fm, body } = fn._test.parseFrontmatter(md);
  assert.strictEqual(fm.slug, SLUG);                              // slug untouched
  assert.strictEqual(fm.title, 'Quartz vs granite countertops — which is right for your Baltimore County kitchen');
  assert.strictEqual(fm.date, '2026-07-01');
  assert.strictEqual(fm.metaTitle, 'Quartz vs Granite Countertops in Baltimore County');
  assert.match(md, /^tags: \["countertops"\]$/m);
  assert.ok(!body.includes('Generic text') && !body.includes('Should Be Dropped'));
  assert.ok(body.trimStart().startsWith('Quartz is the lower-maintenance pick'));
  assert.ok(body.includes('---\n\n## Frequently asked questions'));  // a horizontal rule survives

  const html = files.get(`precision-remodel-site/blog/${SLUG}.html`);
  assert.ok(html.includes('<h2>Which is more durable, quartz or granite?</h2>'));
  assert.ok(html.includes('<figure style="margin:2rem 0;"><img src="/images/blog/quartz-sink-abc123.jpg"'));
  assert.ok(html.includes('<link rel="canonical" href="https://precisionremodelingmd.com/blog/' + SLUG + '">'));
  assert.ok(html.includes('og:image" content="https://precisionremodelingmd.com/images/blog/quartz-sink-abc123.jpg'));
  assert.ok(!html.includes('Generic text'));
  assert.ok(files.has('precision-remodel-site/images/blog/quartz-sink-abc123.jpg'));
  const manifest = JSON.parse(files.get('precision-remodel-site/blog/posts.json'));
  assert.strictEqual(manifest[0].slug, SLUG);
  assert.strictEqual(manifest[0].excerpt, 'd'.repeat(150));   // excerpt filled from the new description
  assert.strictEqual(deploys, 1);
});

test('update without body still only inserts photos / meta (old behaviour)', async () => {
  files.clear(); puts.length = 0;
  files.set(`precision-remodel-site/blog/posts/${SLUG}.md`, MD);
  const res = await call({ action: 'update', slug: SLUG, metaTitle: 'T', metaDescription: '', title: '', images: [],
    insertions: [{ afterHeading: 'Start With a Clear Vision', markdown: '![a](/images/blog/x.jpg "c")' }] });
  assert.strictEqual(res.statusCode, 200, res.body);
  const md = files.get(`precision-remodel-site/blog/posts/${SLUG}.md`);
  assert.ok(md.includes('Generic text') && md.includes('## Start With a Clear Vision\n\n![a](/images/blog/x.jpg "c")'));
  assert.strictEqual(JSON.parse(res.body).bodyReplaced, false);
});

test('unsafe bodies are refused before anything is written', async () => {
  for (const body of ['<script>alert(1)</script>', '![x](https://evil.example/x.jpg)', '---\ntitle: "x"\n---\nhi', 'x'.repeat(70000)]) {
    files.clear(); puts.length = 0;
    files.set(`precision-remodel-site/blog/posts/${SLUG}.md`, MD);
    const res = await call({ action: 'update', slug: SLUG, body });
    assert.strictEqual(res.statusCode, 400, body.slice(0, 40));
    assert.strictEqual(puts.length, 0);
  }
});
