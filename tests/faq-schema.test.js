/* FAQ schema in new-post.js. Run: node tests/faq-schema.test.js */
const assert = require('assert');
const t = require('../precision-remodel-site/netlify/functions/new-post.js')._test;

const faq = [
  { question: 'How long does a bathroom remodel take?', answer: 'Most take 3 to 5 weeks. </script><b>x</b>' },
  { question: 'Do you pull permits?', answer: 'Yes, when Baltimore County requires them.' },
  { question: 'Is this question missing from the page?', answer: 'It is.' },
];
const md = '## How long does a bathroom remodel take?\n\nMost take 3 to 5 weeks.\n\n**Do you pull permits?** Yes.\n';

/* normalizeFaq */
assert.deepStrictEqual(t.normalizeFaq(undefined), { faq: [] });
assert.ok(t.normalizeFaq('nope').error);
assert.ok(t.normalizeFaq([{ question: 'q' }]).error);
assert.ok(t.normalizeFaq({}).error);
assert.strictEqual(t.normalizeFaq(JSON.stringify(faq)).faq.length, 3);
console.log('ok   normalizeFaq');

/* front matter round trip, including quotes and newlines */
const tricky = [{ question: 'Say "hi"?', answer: 'Line one\nline two: yes' }];
const line = `faq: ${t.faqFrontmatterValue(t.normalizeFaq(tricky).faq)}`;
assert.ok(!line.includes('\n'));
const raw = `---\ntitle: "T"\n${line}\nauthor: "A"\n---\n\nBody\n`;
const parsed = t.parseFrontmatter(raw);
assert.deepStrictEqual(t.normalizeFaq(parsed.fm.faq).faq, [{ question: 'Say "hi"?', answer: 'Line one line two: yes' }]);
const rebuilt = t.buildFrontmatter(parsed.fm, parsed.raw);
assert.ok(rebuilt.includes(line), 'buildFrontmatter keeps faq line unchanged');
const up = t.applyUpdate(raw, { metaTitle: 'New' });
assert.ok(up.md.includes(line), 'update path keeps faq in front matter');
console.log('ok   front matter round trip');

/* page output */
const base = { safeSlug: 's', title: 'T', postDate: '2026-10-26', category: 'C', excerpt: '', metaDescription: '', metaTitle: '', readTime: '1 min read', sanitizedContent: md, ogImage: null };
const withFaq = t.buildStaticPostHtml({ ...base, faq });
const blocks = [...withFaq.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => m[1]);
assert.strictEqual(blocks.length, 2, 'BlogPosting + FAQPage');
assert.ok(!blocks[1].includes('</'), 'no </ inside JSON-LD');
const ld = JSON.parse(blocks[1]);
assert.strictEqual(ld['@type'], 'FAQPage');
assert.deepStrictEqual(ld.mainEntity.map(q => q.name), ['How long does a bathroom remodel take?', 'Do you pull permits?']);
assert.strictEqual(ld.mainEntity[0].acceptedAnswer.text, 'Most take 3 to 5 weeks. </script><b>x</b>');
console.log('ok   FAQPage emitted only for visible questions, </ escaped');

const noneVisible = t.buildStaticPostHtml({ ...base, faq: [faq[2]] });
assert.ok(!noneVisible.includes('FAQPage'));
const noFaq = t.buildStaticPostHtml(base);
assert.ok(!noFaq.includes('FAQPage'));
assert.strictEqual(noFaq, t.buildStaticPostHtml({ ...base, faq: [] }));
console.log('ok   no FAQPage when absent or not visible');

/* partial-word match must not count: "permits" question vs "permit" in body */
assert.strictEqual(t.faqJsonLd([{ question: 'Do you pull permit', answer: 'x' }], '<p>Do you pull permits?</p>'), '');
console.log('ok   whole-phrase matching');
/* update path: a stored faq line survives applyUpdate with a replacement body,
   and buildStaticPostHtml accepts the raw front-matter string form */
const upBody = t.applyUpdate(raw.replace('Body', 'Say "hi"? is asked here'), { body: '## Say "hi"?\n\nNew body.' });
assert.ok(upBody.md.includes(line));
const rerender = t.buildStaticPostHtml({ ...base, sanitizedContent: upBody.body, faq: upBody.fm.faq });
assert.ok(rerender.includes('FAQPage'));
console.log('ok   update re-render keeps FAQPage');
console.log('\nall passed');
