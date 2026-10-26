/*
 * Netlify runs THIS file (the repo-root netlify.toml sets functions = "netlify/functions"),
 * but the site itself is published from precision-remodel-site/. The real code lives in
 * precision-remodel-site/netlify/functions/new-post.js; edit that file, not this one.
 * (Until 2026-10-26 this was a stale copy without photos, metaTitle or the update action.)
 */
module.exports = require('../../precision-remodel-site/netlify/functions/new-post.js');
