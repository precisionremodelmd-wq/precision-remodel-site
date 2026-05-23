# Precision Remodel LLC — Website

**precisionremodelingmd.com**  
Owner: Jonathan Kruse · MHIC #151439 · 443-761-9209

---

## Stack

- Pure HTML / CSS / JS — no build step, no framework
- Hosted on Netlify (drag-and-drop or Git-connected)
- Forms via Netlify Forms (zero config required)
- Blog posts as Markdown files in `/blog/posts/`
- Blog rendering via `marked.js` (loaded from CDN in post-template.html)
- New post API via Netlify Function at `/api/new-post`

---

## Project Structure

```
/
├── index.html              Homepage
├── kitchens.html           Kitchen service page
├── bathrooms.html          Bathroom service page
├── our-work.html           Portfolio gallery with filter
├── process.html            4-step process detail
├── service-area.html       Geographic SEO page
├── about.html              About Jonathan / credentials
├── contact.html            Full consultation request form
├── 404.html                Custom 404 page
│
├── css/
│   └── styles.css          Single stylesheet (all pages)
│
├── js/
│   └── main.js             Nav, FAQ, filter, form handling, blog renderer
│
├── blog/
│   ├── index.html          Blog listing page
│   ├── post-template.html  Dynamic post renderer (reads .md via fetch)
│   └── posts/
│       ├── kitchen-remodel-cost-essex-md.md
│       ├── bathroom-remodel-guide-perry-hall.md
│       └── mhic-licensing-maryland-contractor.md
│
├── netlify/
│   └── functions/
│       └── new-post.js     API endpoint to create new blog posts
│
├── netlify.toml            Netlify config: redirects, headers, functions
└── README.md               This file
```

---

## Deployment — Option A: Drag and Drop (Fastest)

1. Zip the entire project folder
2. Go to **app.netlify.com**
3. Drag the zip onto the deploy area
4. Set your custom domain to `precisionremodelingmd.com` in **Domain settings**
5. Enable HTTPS (automatic with Netlify)

Done — forms work automatically, no additional config needed.

---

## Deployment — Option B: GitHub (Recommended for ongoing updates)

1. Create a new GitHub repository
2. Push this folder to the `main` branch:
   ```bash
   git init
   git add .
   git commit -m "Initial site"
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```
3. In Netlify: **Add new site → Import from Git**
4. Select your repository — Netlify auto-detects `netlify.toml`
5. Set custom domain to `precisionremodelingmd.com`

Future updates: push to `main` and Netlify deploys automatically.

---

## Forms Setup

Forms use **Netlify Forms** — no server, no third-party service required.

Forms are active immediately on deploy. To view submissions:
1. Go to **Netlify → Your site → Forms**
2. You'll see all named forms: `consultation`, `kitchen-consultation`, `bathroom-consultation`, `contact`

**To enable email notifications:**
1. Netlify → Forms → Form name → Settings
2. Add your email under **Email notifications**

**Spam protection:** All forms include a honeypot field (`bot-field`). Netlify also has built-in spam filtering.

---

## Blog — Adding New Posts

### Option 1: Manually add a Markdown file

1. Create `/blog/posts/your-post-slug.md`
2. Use this frontmatter format:
   ```
   ---
   title: "Your Post Title"
   slug: "your-post-slug"
   date: "2024-12-01"
   category: "Cost Guide"
   tags: ["tag1", "tag2"]
   excerpt: "Short description for listing pages."
   metaDescription: "SEO meta description (150–160 chars)."
   author: "Precision Remodel LLC"
   readTime: "5 min read"
   ---
   
   Post content in Markdown here...
   ```
3. Add a card for the post in `/blog/index.html`
4. The post is live at `/blog/your-post-slug` (Netlify rewrites to post-template.html)

### Option 2: API endpoint (new-post.js function)

**POST** `/api/new-post`

Headers:
- `Content-Type: application/json`
- `x-post-secret: YOUR_SECRET` (set `NEW_POST_SECRET` env var in Netlify)

Body:
```json
{
  "title": "Post Title",
  "slug": "post-slug",
  "content": "Markdown content here...",
  "category": "Cost Guide",
  "tags": ["tag1", "tag2"],
  "date": "2024-12-01"
}
```

**For production:** Set these environment variables in Netlify → Site settings → Environment variables:
- `NEW_POST_SECRET` — random string to protect the endpoint
- `GITHUB_TOKEN` — a GitHub personal access token with `repo` scope
- `GITHUB_REPO` — `username/repo-name`
- `GITHUB_BRANCH` — `main` (or your deploy branch)
- `NETLIFY_DEPLOY_HOOK` — your Netlify build hook URL (Settings → Build & deploy → Build hooks)

With GitHub token configured, the function writes the `.md` file directly to your repo via the GitHub API and triggers a Netlify rebuild.

---

## Google Maps Embed

On `/service-area.html`, find the `<!-- Replace with Google Maps embed -->` comment and replace the `<div class="map-placeholder">` block with your iframe:

```html
<iframe 
  src="https://www.google.com/maps/embed?pb=PASTE_YOUR_EMBED_CODE_HERE"
  width="100%"
  height="420"
  style="border:0;border-radius:8px;"
  allowfullscreen=""
  loading="lazy"
  referrerpolicy="no-referrer-when-downgrade">
</iframe>
```

To get the embed code: Google Maps → search your service area → Share → Embed a map → Copy HTML.

---

## Replacing Image Placeholders

All image placeholders use the pattern:
```html
<div class="img-placeholder" style="aspect-ratio:4/3;">
  <span>Description of ideal photo</span>
</div>
```

Replace with a real `<img>` tag:
```html
<img 
  src="/images/perry-hall-kitchen-renovation.jpg" 
  alt="Perry Hall kitchen renovation — white shaker cabinetry, quartz island"
  style="width:100%;aspect-ratio:4/3;object-fit:cover;"
  loading="lazy"
>
```

Store images in an `/images/` directory. Recommended: optimize all photos to WebP format and under 200KB for fast load times.

---

## Environment Variables (Netlify)

Set in: Netlify → Site settings → Build & deploy → Environment variables

| Variable | Required | Description |
|---|---|---|
| `NEW_POST_SECRET` | Recommended | Protects the `/api/new-post` endpoint |
| `GITHUB_TOKEN` | For blog API | Personal access token with repo scope |
| `GITHUB_REPO` | For blog API | `username/repo` format |
| `GITHUB_BRANCH` | For blog API | Default: `main` |
| `NETLIFY_DEPLOY_HOOK` | For blog API | Build hook URL from Netlify |

---

## DNS Setup (Namecheap / Any Registrar)

Point your domain to Netlify:

1. In Netlify: **Domain settings → Add custom domain → precisionremodelingmd.com**
2. Netlify provides two DNS records — add them at your registrar:
   - `ALIAS` or `CNAME` for `@` → your-site.netlify.app
   - `CNAME` for `www` → your-site.netlify.app
3. Enable **HTTPS** in Netlify (automatic via Let's Encrypt)

---

## Contact

**Jonathan Kruse**  
Precision Remodel LLC  
443-761-9209  
jon@precisionremodelingmd.com  
MHIC #151439
