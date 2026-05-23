/* ============================================================
   Precision Remodel LLC — Main JS
   precisionremodelingmd.com
   ============================================================ */

(function () {
  'use strict';

  /* --- Navigation ---------------------------------------- */
  const nav = document.getElementById('nav');
  const navToggle = document.getElementById('navToggle');
  const navLinks = document.getElementById('navLinks');

  if (nav) {
    const onScroll = () => {
      nav.classList.toggle('nav--scrolled', window.scrollY > 60);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  if (navToggle && navLinks) {
    navToggle.addEventListener('click', () => {
      const isOpen = navLinks.classList.toggle('open');
      navToggle.classList.toggle('open', isOpen);
      document.body.style.overflow = isOpen ? 'hidden' : '';
      navToggle.setAttribute('aria-expanded', isOpen);
    });

    navLinks.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        navLinks.classList.remove('open');
        navToggle.classList.remove('open');
        document.body.style.overflow = '';
        navToggle.setAttribute('aria-expanded', 'false');
      });
    });
  }

  /* Active nav link */
  const currentPath = window.location.pathname.replace(/\/$/, '') || '/index.html';
  document.querySelectorAll('.nav-links a').forEach(link => {
    const href = link.getAttribute('href').replace(/\/$/, '');
    if (href === currentPath || (currentPath === '' && href === '/index.html')) {
      link.classList.add('active');
    }
  });

  /* --- FAQ Accordion ------------------------------------- */
  document.querySelectorAll('.faq-question').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.faq-item');
      const isOpen = item.classList.contains('open');
      document.querySelectorAll('.faq-item.open').forEach(i => i.classList.remove('open'));
      if (!isOpen) item.classList.add('open');
    });
  });

  /* --- Portfolio Filter ---------------------------------- */
  const filterBtns = document.querySelectorAll('.filter-btn');
  const portfolioItems = document.querySelectorAll('.portfolio-item');

  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const filter = btn.dataset.filter;
      portfolioItems.forEach(item => {
        if (filter === 'all' || item.dataset.category === filter) {
          item.classList.remove('hidden');
        } else {
          item.classList.add('hidden');
        }
      });
    });
  });

  /* --- Netlify Form Submission --------------------------- */
  document.querySelectorAll('form[data-netlify]').forEach(form => {
    form.addEventListener('submit', async e => {
      e.preventDefault();
      const submitBtn = form.querySelector('[type="submit"]');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Sending…';
      }

      try {
        const res = await fetch('/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(new FormData(form)).toString(),
        });

        if (res.ok) {
          form.style.display = 'none';
          const success = document.getElementById(form.id + '-success') ||
                          form.nextElementSibling;
          if (success && success.classList.contains('form-success')) {
            success.style.display = 'block';
          }
        } else {
          throw new Error('Network response not ok');
        }
      } catch {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Try Again';
        }
        alert('Something went wrong. Please call us at 443-761-9209.');
      }
    });
  });

  /* --- Scroll Animations --------------------------------- */
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            entry.target.classList.add('in-view');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.08, rootMargin: '0px 0px -40px 0px' }
    );

    document.querySelectorAll('.fade-up').forEach(el => observer.observe(el));
  } else {
    document.querySelectorAll('.fade-up').forEach(el => el.classList.add('in-view'));
  }

  /* --- Blog Post Renderer -------------------------------- */
  const postBody = document.getElementById('post-body');
  if (postBody) {
    loadBlogPost();
  }

  async function loadBlogPost() {
    const segments = window.location.pathname.split('/').filter(Boolean);
    const slug = segments[segments.length - 1] || new URLSearchParams(window.location.search).get('slug');

    if (!slug) {
      postBody.innerHTML = '<p class="loading">Post not found.</p>';
      return;
    }

    try {
      const res = await fetch(`/blog/posts/${slug}.md`);
      if (!res.ok) throw new Error('Not found');
      const raw = await res.text();
      renderPost(raw, slug);
    } catch {
      postBody.innerHTML = '<p class="loading">Could not load post. <a href="/blog/">Return to blog</a></p>';
    }
  }

  function renderPost(raw, slug) {
    const { meta, content } = parseFrontmatter(raw);

    /* Update page metadata */
    document.title = (meta.title || 'Blog') + ' | Precision Remodel LLC';
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc && meta.metaDescription) metaDesc.content = meta.metaDescription;

    /* Populate hero */
    const titleEl = document.getElementById('post-title');
    const categoryEl = document.getElementById('post-category');
    const dateEl = document.getElementById('post-date');
    const readEl = document.getElementById('post-read');

    if (titleEl) titleEl.textContent = meta.title || '';
    if (categoryEl) categoryEl.textContent = meta.category || '';
    if (dateEl) dateEl.textContent = formatDate(meta.date);
    if (readEl) readEl.textContent = meta.readTime || '';

    /* Render markdown (basic; marked.js loaded in template) */
    if (window.marked) {
      postBody.innerHTML = window.marked.parse(content);
    } else {
      postBody.innerHTML = '<p>' + content.replace(/\n\n/g, '</p><p>') + '</p>';
    }
  }

  function parseFrontmatter(raw) {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) return { meta: {}, content: raw };

    const meta = {};
    match[1].split('\n').forEach(line => {
      const idx = line.indexOf(':');
      if (idx === -1) return;
      const key = line.slice(0, idx).trim();
      let val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      meta[key] = val;
    });

    return { meta, content: match[2].trim() };
  }

  function formatDate(str) {
    if (!str) return '';
    const d = new Date(str + 'T00:00:00');
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  }

})();
