"use strict";

const TYPES = {
  blog:    { key: "blog",    one: "Article", many: "Blog",     listPath: "/blog",     nav: "blog" },
  project: { key: "project", one: "Projet",  many: "Projets",  listPath: "/projects", nav: "projects" },
  podcast: { key: "podcast", one: "Podcast", many: "Podcasts", listPath: "/podcasts", nav: "podcasts" },
  course:  { key: "course",  one: "Cours",   many: "Cours",    listPath: "/courses",  nav: "courses" }
};

const LIST_PATHS = { "/blog": "blog", "/projects": "project", "/podcasts": "podcast", "/courses": "course" };

function typeOf(t){ return TYPES[t] || TYPES.blog; }
function itemUrl(e){ return "/post/" + e.slug; }

function ensureContentSchema(db){
  db.exec(`
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE,
      title TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'blog',
      category TEXT,
      cover TEXT,
      blocks TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'published',
      featured INTEGER NOT NULL DEFAULT 0,
      views INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE,
      title TEXT NOT NULL,
      blocks TEXT NOT NULL DEFAULT '[]',
      in_nav INTEGER NOT NULL DEFAULT 1,
      show_on_index INTEGER NOT NULL DEFAULT 1,
      sort INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS faqs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      answer TEXT NOT NULL DEFAULT '',
      sort INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);

  const ensureColumn = (table, col, ddl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if(!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  ensureColumn("articles", "type", "type TEXT NOT NULL DEFAULT 'blog'");
  ensureColumn("articles", "featured", "featured INTEGER NOT NULL DEFAULT 0");
  ensureColumn("articles", "subtype", "subtype TEXT");
  ensureColumn("articles", "source_url", "source_url TEXT");
  ensureColumn("articles", "source_platform", "source_platform TEXT");
  ensureColumn("articles", "progress", "progress INTEGER NOT NULL DEFAULT 0");
}

function seedContent(ctx){
  const { get, run, getSetting, setSetting } = ctx;
  const defs = {
    site_name: "Elle",
    tagline: "Idées, projets et podcasts — un journal personnel.",
    footer: "© " + new Date().getFullYear() + " Elle — journal personnel.",
    contact_text: "Une question, une collaboration ? Écrivez-moi.",
    contact_email: "",
    theme_default: "light",
    hero_mode: "cta",
    hero_title: "",
    hero_subtitle: "",
    hero_cta_label: "Lire le blog",
    hero_cta_url: "/blog",
    hero_image: "",
    assistant_model: "claude-sonnet-4-6"
  };
  for(const k in defs) if(getSetting(k) === null) setSetting(k, defs[k]);

  if (!get("SELECT id FROM pages WHERE slug=?", "about")) {
    run("INSERT INTO pages(slug,title,blocks,in_nav,show_on_index,sort,updated_at) VALUES(?,?,?,?,?,?,?)",
      "about", "À propos", JSON.stringify([
        { type:"text", text:"Bienvenue ! **Elle** est un journal personnel : un espace pour écrire des articles, présenter des projets et imaginer des épisodes de podcast — le tout hébergé sur votre propre téléphone." },
        { type:"heading", level:2, text:"À propos" },
        { type:"text", text:"Modifiez librement cette page depuis l’Atelier (menu *Pages*)." }
      ]), 1, 0, 1, Date.now());
  }
  if (!get("SELECT id FROM pages WHERE slug=?", "contact")) {
    run("INSERT INTO pages(slug,title,blocks,in_nav,show_on_index,sort,updated_at) VALUES(?,?,?,?,?,?,?)",
      "contact", "Contact", JSON.stringify([
        { type:"text", text:"Envie d’échanger ? Écrivez-moi, je réponds avec plaisir." },
        { type:"text", text:"✉️  *Renseignez votre e-mail de contact dans l’Atelier → Réglages.*" }
      ]), 1, 0, 2, Date.now());
  }

  if (!get("SELECT id FROM articles WHERE type='blog' LIMIT 1")) {
    run("INSERT INTO articles(slug,title,type,category,cover,blocks,status,featured,views,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      "bienvenue-sur-elle", "Bienvenue sur Elle", "blog", "À la une", null, JSON.stringify([
        { type:"text", text:"Bienvenue sur **Elle** ! Cet article montre les blocs disponibles dans l’éditeur." },
        { type:"heading", level:2, text:"Des mathématiques" },
        { type:"text", text:"Une formule en ligne comme $E = mc^2$, ou mise en valeur :" },
        { type:"formula", mode:"block", tex:"\\int_0^{\\infty} e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}" },
        { type:"heading", level:2, text:"Du code" },
        { type:"code", lang:"python", code:"def fibonacci(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a" },
        { type:"quote", text:"Tout est enregistré dans une base SQLite, sur votre téléphone." }
      ]), "published", 1, 0, Date.now(), Date.now());
  }
  if (!get("SELECT id FROM articles WHERE type='project' LIMIT 1")) {
    run("INSERT INTO articles(slug,title,type,category,cover,blocks,status,featured,views,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      "mon-premier-projet", "Mon premier projet", "project", "En cours", null, JSON.stringify([
        { type:"text", text:"Décrivez ici un projet : son objectif, son état d’avancement et les prochaines étapes." },
        { type:"heading", level:2, text:"Objectif" },
        { type:"text", text:"- Étape 1\n- Étape 2\n- Étape 3" }
      ]), "published", 1, 0, Date.now() - 86400000, Date.now() - 86400000);
  }
  if (!get("SELECT id FROM articles WHERE type='podcast' LIMIT 1")) {
    run("INSERT INTO articles(slug,title,type,category,cover,blocks,status,featured,views,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      "idee-episode-1", "Idée d’épisode : commencer petit", "podcast", "Idées", null, JSON.stringify([
        { type:"text", text:"Une idée d’épisode : pourquoi commencer petit aide à finir grand." },
        { type:"heading", level:2, text:"Déroulé" },
        { type:"text", text:"1. Accroche\n2. Histoire\n3. Conseils pratiques\n4. Conclusion" }
      ]), "published", 1, 0, Date.now() - 172800000, Date.now() - 172800000);
  }

  if (!get("SELECT id FROM articles WHERE type='course' LIMIT 1")) {
    run("INSERT INTO articles(slug,title,type,category,cover,blocks,status,featured,views,created_at,updated_at,subtype,source_url,source_platform,progress) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      "notes-first-steps-donnees-numeriques", "Notes : les premières étapes avec des données numériques", "course", "Machine Learning", null, JSON.stringify([
        { type:"text", text:"Notes prises en suivant le cours Google Machine Learning Crash Course, module « Données numériques »." },
        { type:"heading", level:2, text:"Idée clé" },
        { type:"text", text:"Une bonne caractéristique numérique doit avoir une échelle raisonnable. On normalise souvent avant d’entraîner." }
      ]), "published", 0, 0, Date.now() - 43200000, Date.now() - 43200000,
      "external", "https://developers.google.com/machine-learning/crash-course/numerical-data/first-steps?hl=fr", "Google ML Crash Course", 35);
  }

  if (!get("SELECT id FROM faqs LIMIT 1")) {
    const now = Date.now();
    run("INSERT INTO faqs(question,answer,sort,updated_at) VALUES(?,?,?,?)", "Qu’est-ce que ce site ?", "Un journal personnel qui réunit des **articles**, des **projets** et des **idées de podcast**.", 1, now);
    run("INSERT INTO faqs(question,answer,sort,updated_at) VALUES(?,?,?,?)", "Comment publier un contenu ?", "Connectez-vous à l’Atelier, puis utilisez l’éditeur en blocs. Vous pouvez aussi demander des idées à l’assistant.", 2, now);
    run("INSERT INTO faqs(question,answer,sort,updated_at) VALUES(?,?,?,?)", "Où sont stockées les données ?", "Dans une base SQLite locale, sur votre téléphone. Vos contenus survivent au redémarrage.", 3, now);
  }
}

module.exports = { TYPES, LIST_PATHS, typeOf, itemUrl, ensureContentSchema, seedContent };
