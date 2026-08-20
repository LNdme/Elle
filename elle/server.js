"use strict";
/* =========================================================================
   Elle — serveur v2 (Node + SQLite), pensé pour Termux / Android.
   Contenus : Blog / Projets / Podcasts. Héro configurable, espace Questions,
   assistant IA, carrousels, pages centrées. Aucune dépendance obligatoire.
   Lancement :  node server.js   (ou : node --experimental-sqlite server.js)
   ========================================================================= */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL, URLSearchParams } = require("url");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
// Version des assets statiques (styles.css / app.js) — dérivée de leur date de
// modification, ajoutée en query pour forcer le navigateur à recharger le CSS/JS
// après une mise à jour (évite de rester bloqué sur une ancienne feuille de style).
function assetVersion(){
  let v = 0;
  for(const f of ["styles.css", "app.js"]){
    try { v = Math.max(v, fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs | 0); } catch(e){}
  }
  return String(v || 1);
}
let ASSET_V = assetVersion();
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const DB_PATH = path.join(DATA_DIR, "elle.db");
const PORT = parseInt(process.env.PORT || "3000", 10);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ------------------------------- Types de contenu ---------------------- */
const TYPES = {
  blog:    { key: "blog",    one: "Article", many: "Blog",     listPath: "/blog",     nav: "blog" },
  project: { key: "project", one: "Projet",  many: "Projets",  listPath: "/projects", nav: "projects" },
  podcast: { key: "podcast", one: "Podcast", many: "Podcasts", listPath: "/podcasts", nav: "podcasts" },
  course:  { key: "course",  one: "Cours",   many: "Cours",    listPath: "/courses",  nav: "courses" }
};
function typeOf(t){ return TYPES[t] || TYPES.blog; }
function itemUrl(e){ return "/post/" + e.slug; }

/* ----------------------------- Base de données ------------------------- */
let db = null, DB_DRIVER = "";
function openDatabase(){
  try {
    const Database = require("better-sqlite3");
    db = new Database(DB_PATH);
    DB_DRIVER = "better-sqlite3";
  } catch (e) {
    try {
      const { DatabaseSync } = require("node:sqlite");
      db = new DatabaseSync(DB_PATH);
      DB_DRIVER = "node:sqlite (intégré)";
    } catch (e2) {
      console.error("\n[Elle] Impossible de charger un moteur SQLite.");
      console.error("  → Avec Node ≥ 22.5 :  node --experimental-sqlite server.js");
      console.error("  → Ou installez le moteur :  npm install better-sqlite3  puis  node server.js\n");
      process.exit(1);
    }
  }
  try { db.exec("PRAGMA journal_mode = WAL;"); } catch (e) {}
}
const run = (sql, ...a) => db.prepare(sql).run(...a);
const get = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);

function ensureColumn(table, col, ddl){
  const cols = all("PRAGMA table_info(" + table + ")").map(c => c.name);
  if(cols.indexOf(col) < 0) db.exec("ALTER TABLE " + table + " ADD COLUMN " + ddl);
}
function migrate(){
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
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
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      is_active INTEGER NOT NULL DEFAULT 1,
      auth_version INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_login_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER,
      user_agent TEXT,
      ip TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      meta TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      ip TEXT,
      user_agent TEXT
    );
    CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      kind TEXT NOT NULL DEFAULT 'idea',
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      contact TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS contact_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT,
      subject TEXT,
      body TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      user_id INTEGER
    );
  `);
  // migrations douces pour bases existantes
  ensureColumn("articles", "type", "type TEXT NOT NULL DEFAULT 'blog'");
  ensureColumn("articles", "featured", "featured INTEGER NOT NULL DEFAULT 0");
  ensureColumn("articles", "subtype", "subtype TEXT");
  ensureColumn("articles", "source_url", "source_url TEXT");
  ensureColumn("articles", "source_platform", "source_platform TEXT");
  ensureColumn("articles", "progress", "progress INTEGER NOT NULL DEFAULT 0");
  ensureColumn("users", "role", "role TEXT NOT NULL DEFAULT 'admin'");
  ensureColumn("users", "is_active", "is_active INTEGER NOT NULL DEFAULT 1");
  ensureColumn("users", "auth_version", "auth_version INTEGER NOT NULL DEFAULT 0");
  ensureColumn("users", "last_login_at", "last_login_at INTEGER");
  // Profil public : ce qui signe les contenus sur le site.
  ensureColumn("users", "display_name", "display_name TEXT");
  ensureColumn("users", "job", "job TEXT");
  ensureColumn("users", "avatar", "avatar TEXT");
  ensureColumn("users", "bio", "bio TEXT");
  // Signature automatique : qui a écrit quoi.
  ensureColumn("articles", "author_id", "author_id INTEGER");
  // Contributions de la communauté (idées, bugs, suggestions…)
  ensureColumn("submissions", "kind", "kind TEXT NOT NULL DEFAULT 'idea'");
  ensureColumn("submissions", "contact", "contact TEXT");
  ensureColumn("submissions", "status", "status TEXT NOT NULL DEFAULT 'open'");
  ensureColumn("contact_messages", "status", "status TEXT NOT NULL DEFAULT 'new'");
  ensureColumn("contact_messages", "user_id", "user_id INTEGER");
  // Messages de contact
  ensureColumn("contact_messages", "name", "name TEXT");
  ensureColumn("contact_messages", "email", "email TEXT");
  ensureColumn("contact_messages", "subject", "subject TEXT");
}

/* --------------------------------- Réglages ---------------------------- */
function getSetting(k, d){ const r = get("SELECT value FROM settings WHERE key=?", k); return r ? r.value : (d === undefined ? null : d); }
function setSetting(k, v){ run("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", k, v == null ? "" : String(v)); }
function pinIsSet(){ return !!getSetting("admin_pin"); }
function apiKey(){ return process.env.ANTHROPIC_API_KEY || getSetting("anthropic_api_key", "") || ""; }

/* ------------------------------- Données de départ --------------------- */
function seed(){
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
  for (const k in defs) if (getSetting(k) === null) setSetting(k, defs[k]);

  if (!get("SELECT id FROM pages WHERE slug=?", "about")) {
    run("INSERT INTO pages(slug,title,blocks,in_nav,show_on_index,sort,updated_at) VALUES(?,?,?,?,?,?,?)",
      "about", "À propos", JSON.stringify([
        { type:"text", text:"Bienvenue ! **Elle** est un journal personnel : un espace pour écrire des articles, présenter des projets et imaginer des épisodes de podcast — le tout hébergé sur votre propre téléphone." },
        { type:"heading", level:2, text:"À propos" },
        { type:"text", text:"Modifiez librement cette page depuis l\u2019Atelier (menu *Pages*)." }
      ]), 1, 0, 1, Date.now());
  }
  if (!get("SELECT id FROM pages WHERE slug=?", "contact")) {
    run("INSERT INTO pages(slug,title,blocks,in_nav,show_on_index,sort,updated_at) VALUES(?,?,?,?,?,?,?)",
      "contact", "Contact", JSON.stringify([
        { type:"text", text:"Envie d\u2019échanger ? Écrivez-moi, je réponds avec plaisir." },
        { type:"text", text:"\u2709\uFE0F  *Renseignez votre e-mail de contact dans l\u2019Atelier → Réglages.*" }
      ]), 1, 0, 2, Date.now());
  }

  if (!get("SELECT id FROM articles WHERE type='blog' LIMIT 1")) {
    run("INSERT INTO articles(slug,title,type,category,cover,blocks,status,featured,views,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      "bienvenue-sur-elle", "Bienvenue sur Elle", "blog", "À la une", null, JSON.stringify([
        { type:"text", text:"Bienvenue sur **Elle** ! Cet article montre les blocs disponibles dans l\u2019éditeur." },
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
        { type:"text", text:"Décrivez ici un projet : son objectif, son état d\u2019avancement et les prochaines étapes." },
        { type:"heading", level:2, text:"Objectif" },
        { type:"text", text:"- Étape 1\n- Étape 2\n- Étape 3" }
      ]), "published", 1, 0, Date.now() - 86400000, Date.now() - 86400000);
  }
  if (!get("SELECT id FROM articles WHERE type='podcast' LIMIT 1")) {
    run("INSERT INTO articles(slug,title,type,category,cover,blocks,status,featured,views,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      "idee-episode-1", "Idée d\u2019épisode : commencer petit", "podcast", "Idées", null, JSON.stringify([
        { type:"text", text:"Une idée d\u2019épisode : pourquoi commencer petit aide à finir grand." },
        { type:"heading", level:2, text:"Déroulé" },
        { type:"text", text:"1. Accroche\n2. Histoire\n3. Conseils pratiques\n4. Conclusion" }
      ]), "published", 1, 0, Date.now() - 172800000, Date.now() - 172800000);
  }

  if (!get("SELECT id FROM articles WHERE type='course' LIMIT 1")) {
    run("INSERT INTO articles(slug,title,type,category,cover,blocks,status,featured,views,created_at,updated_at,subtype,source_url,source_platform,progress) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      "notes-first-steps-donnees-numeriques", "Notes : les premières étapes avec des données numériques", "course", "Machine Learning", null, JSON.stringify([
        { type:"text", text:"Notes prises en suivant le cours **Google Machine Learning Crash Course**, module « Données numériques »." },
        { type:"heading", level:2, text:"Idée clé" },
        { type:"text", text:"Une bonne caractéristique numérique doit avoir une échelle raisonnable et une distribution utile pour le modèle. On normalise souvent avant d\u2019entraîner." },
        { type:"formula", mode:"block", tex:"x' = \\frac{x - \\mu}{\\sigma}" },
        { type:"quote", text:"À réviser : la différence entre la normalisation Z-score et la mise à l\u2019échelle min-max." },
        { type:"heading", level:2, text:"À faire ensuite" },
        { type:"text", text:"- Refaire l\u2019exercice pratique\n- Comparer avec la mise à l\u2019échelle log" }
      ]), "published", 0, 0, Date.now() - 43200000, Date.now() - 43200000,
      "external", "https://developers.google.com/machine-learning/crash-course/numerical-data/first-steps?hl=fr", "Google ML Crash Course", 35);
  }

  if (!get("SELECT id FROM faqs LIMIT 1")) {
    const now = Date.now();
    run("INSERT INTO faqs(question,answer,sort,updated_at) VALUES(?,?,?,?)", "Qu\u2019est-ce que ce site ?", "Un journal personnel qui réunit des **articles**, des **projets** et des **idées de podcast**.", 1, now);
    run("INSERT INTO faqs(question,answer,sort,updated_at) VALUES(?,?,?,?)", "Comment publier un contenu ?", "Connectez-vous à l\u2019Atelier, puis utilisez l\u2019éditeur en blocs. Vous pouvez aussi demander des idées à l\u2019assistant.", 2, now);
    run("INSERT INTO faqs(question,answer,sort,updated_at) VALUES(?,?,?,?)", "Où sont stockées les données ?", "Dans une base SQLite locale, sur votre téléphone. Vos contenus survivent au redémarrage.", 3, now);
  }
}

/* --------------------------------- Sécurité ---------------------------- */
function hashSecret(secret){
  const salt = crypto.randomBytes(16).toString("hex");
  const h = crypto.scryptSync(String(secret), salt, 32).toString("hex");
  return "scrypt$" + salt + "$" + h;
}
function verifySecret(secret, stored){
  if(!stored) return false;
  const parts = String(stored).split("$");
  if(parts.length !== 3) return false;
  let h;
  try { h = crypto.scryptSync(String(secret), parts[1], 32); }
  catch(e){ return false; }
  const exp = Buffer.from(parts[2], "hex");
  return h.length === exp.length && crypto.timingSafeEqual(h, exp);
}
const hashPin = hashSecret;
const verifyPin = verifySecret;

function delSetting(k){ run("DELETE FROM settings WHERE key=?", k); }

function authSecret(){
  const env = process.env.AUTH_SECRET ? String(process.env.AUTH_SECRET).trim() : "";
  if(env) return env;
  let s = getSetting("auth_secret", "");
  if(!s){
    s = crypto.randomBytes(32).toString("hex");
    setSetting("auth_secret", s);
  }
  return s;
}
function parseCookies(req){ const out = {}; const c = req && req.headers ? req.headers.cookie : null; if(!c) return out; c.split(";").forEach(p => { const i = p.indexOf("="); if(i > 0) out[p.slice(0,i).trim()] = decodeURIComponent(p.slice(i+1).trim()); }); return out; }
function userCount(){ const r = get("SELECT COUNT(*) AS n FROM users"); return r ? (r.n|0) : 0; }
function publicUser(user){
  if(!user) return null;
  return {
    id: user.id,
    username: user.username,
    email: user.email || "",
    display_name: user.display_name || user.username,
    job: user.job || "",
    avatar: user.avatar || "",
    bio: user.bio || "",
    role: user.role,
    is_active: !!user.is_active,
    auth_version: user.auth_version | 0,
    created_at: user.created_at || null,
    updated_at: user.updated_at || null,
    last_login_at: user.last_login_at || null
  };
}
function cleanIdentifier(v){ return String(v || "").trim(); }
function findUserByIdentifier(identifier){
  identifier = cleanIdentifier(identifier);
  if(!identifier) return null;
  return get("SELECT * FROM users WHERE (lower(username)=lower(?) OR lower(email)=lower(?)) LIMIT 1", identifier, identifier);
}
function createUserAccount(data){
  const now = Date.now();
  const username = cleanIdentifier(data.username);
  const email = cleanIdentifier(data.email);
  const password = String(data.password || "");
  const role = ["admin", "editor", "author", "moderator", "visitor"].indexOf(data.role) >= 0 ? data.role : "admin";
  if(!username) throw new Error("Le nom d'utilisateur est requis.");
  if(password.length < 8) throw new Error("Le mot de passe doit comporter au moins 8 caractères.");
  const p = cleanProfile(data);
  const info = run("INSERT INTO users(username, email, password_hash, role, is_active, auth_version, created_at, updated_at, last_login_at, display_name, job, avatar, bio) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    username, email || null, hashSecret(password), role, 1, 0, now, now, now,
    p.display_name || username, p.job, p.avatar, p.bio);
  forgetAuthorCache();
  return get("SELECT * FROM users WHERE id=?", Number(info.lastInsertRowid));
}
function updateUserPassword(userId, password){
  if(!String(password || "").length) throw new Error("Le mot de passe est requis.");
  run("UPDATE users SET password_hash=?, auth_version=auth_version+1, updated_at=? WHERE id=?", hashSecret(password), Date.now(), userId);
}

/* ------------------------- Profil public des auteurs ------------------- */
// Le surnom (display_name) et le métier (job) signent chaque contenu sur le
// site public ; l'avatar et la bio alimentent la fiche auteur.
function cleanProfile(data){
  const cut = (v, n) => String(v || "").trim().slice(0, n);
  const avatar = cut(data.avatar, 400);
  return {
    display_name: cut(data.display_name, 60),
    job: cut(data.job, 80),
    // On n'accepte que des images servies par le site (évite d'injecter une URL arbitraire).
    avatar: /^\/uploads\/[A-Za-z0-9._-]+$/.test(avatar) ? avatar : "",
    bio: cut(data.bio, 600)
  };
}
function updateUserProfile(userId, data){
  const p = cleanProfile(data);
  run("UPDATE users SET display_name=?, job=?, avatar=?, bio=?, updated_at=? WHERE id=?",
    p.display_name || null, p.job || null, p.avatar || null, p.bio || null, Date.now(), userId);
  forgetAuthorCache();
}
// Auteur par défaut : le plus ancien compte actif. Sert de repli pour les
// contenus créés avant la signature automatique (ou par un agent sans compte).
function defaultAuthorId(){
  const r = get("SELECT id FROM users WHERE is_active=1 ORDER BY id LIMIT 1");
  return r ? r.id : null;
}
const AUTHOR_CACHE = new Map();
function authorById(id){
  if(!id) return null;
  if(AUTHOR_CACHE.has(id)) return AUTHOR_CACHE.get(id);
  const u = get("SELECT * FROM users WHERE id=?", id) || null;
  AUTHOR_CACHE.set(id, u);
  return u;
}
function forgetAuthorCache(){ AUTHOR_CACHE.clear(); }
function authorOf(entry){
  if(!entry) return null;
  return authorById(entry.author_id) || authorById(defaultAuthorId());
}
function authorName(u){ return u ? (String(u.display_name || "").trim() || u.username) : ""; }
function authorPath(u){ return u ? "/auteur/" + encodeURIComponent(u.username) : "#"; }
function authorInitials(u){
  const n = authorName(u).trim();
  if(!n) return "?";
  const parts = n.split(/\s+/);
  return ((parts[0][0] || "") + (parts.length > 1 ? parts[1][0] : "")).toUpperCase();
}
// `size` = classe CSS : "xs" (listes), "sm" (signature), "lg" (fiche auteur).
function avatarHtml(u, size){
  const cls = "avatar av-" + (size || "sm");
  if(u && u.avatar) return '<img class="' + cls + '" src="' + esc(u.avatar) + '" alt="" loading="lazy">';
  return '<span class="' + cls + ' av-ph">' + esc(authorInitials(u)) + '</span>';
}
function refreshTokenHash(token){
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}
function b64u(input){
  return Buffer.from(String(input)).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function fromB64u(s){
  s = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  while(s.length % 4) s += "=";
  return Buffer.from(s, "base64").toString();
}

const AUTH_ACCESS_TTL = 1000 * 60 * 15;
const AUTH_REFRESH_TTL = 1000 * 60 * 60 * 24 * 30;
const AUTH_ACCESS_COOKIE = "elle_at";
const AUTH_REFRESH_COOKIE = "elle_rt";

function accessCookie(token){ return AUTH_ACCESS_COOKIE + "=" + token + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + Math.floor(AUTH_ACCESS_TTL / 1000); }
function refreshCookie(token){ return AUTH_REFRESH_COOKIE + "=" + token + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + Math.floor(AUTH_REFRESH_TTL / 1000); }
function setAuthCookies(res, access, refresh){
  const cookies = [accessCookie(access)];
  if(refresh) cookies.push(refreshCookie(refresh));
  res.setHeader("Set-Cookie", cookies);
}
function clearAuthCookies(res){
  res.setHeader("Set-Cookie", [
    AUTH_ACCESS_COOKIE + "=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    AUTH_REFRESH_COOKIE + "=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
  ]);
}
function signAccessToken(user){
  const now = Date.now();
  const payload = { sub: user.id, role: user.role, v: user.auth_version | 0, iat: now, exp: now + AUTH_ACCESS_TTL };
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", authSecret()).update(body).digest("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return "e1." + body + "." + sig;
}
function verifyAccessToken(token){
  if(!token) return null;
  const parts = String(token).split(".");
  if(parts.length !== 3 || parts[0] !== "e1") return null;
  const body = parts[1], sig = parts[2];
  const expected = crypto.createHmac("sha256", authSecret()).update(body).digest("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  if(Buffer.byteLength(sig) !== Buffer.byteLength(expected)) return null;
  try { if(!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null; }
  catch(e){ return null; }
  let payload;
  try { payload = JSON.parse(fromB64u(body)); }
  catch(e){ return null; }
  if(!payload || !payload.sub || !payload.exp) return null;
  if(Date.now() > payload.exp) return null;
  const user = get("SELECT * FROM users WHERE id=?", payload.sub);
  if(!user || !user.is_active) return null;
  if((user.auth_version | 0) !== (payload.v | 0)) return null;
  return user;
}
function createRefreshToken(userId, req){
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  run("INSERT INTO refresh_tokens(user_id, token_hash, expires_at, created_at, revoked_at, user_agent, ip) VALUES(?,?,?,?,?,?,?)",
    userId, refreshTokenHash(token), now + AUTH_REFRESH_TTL, now, null,
    (req && req.headers && req.headers["user-agent"]) || "",
    (req && req.socket && req.socket.remoteAddress) || "");
  return token;
}
function findRefreshSession(token){
  if(!token) return null;
  const row = get("SELECT * FROM refresh_tokens WHERE token_hash=?", refreshTokenHash(token));
  if(!row) return null;
  if(row.revoked_at) return null;
  if(Date.now() > row.expires_at){ revokeRefreshTokenById(row.id); return null; }
  const user = get("SELECT * FROM users WHERE id=?", row.user_id);
  if(!user || !user.is_active) return null;
  return { row: row, user: user };
}
function revokeRefreshTokenById(id){ run("UPDATE refresh_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL", Date.now(), id); }
function revokeAllRefreshTokensForUser(userId){ run("UPDATE refresh_tokens SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL", Date.now(), userId); }
function issueAuthCookies(res, req, user){
  const access = signAccessToken(user);
  const refresh = createRefreshToken(user.id, req);
  setAuthCookies(res, access, refresh);
  return refresh;
}
function currentUser(req, res){
  const cookies = parseCookies(req);
  const access = verifyAccessToken(cookies[AUTH_ACCESS_COOKIE]);
  if(access) return access;
  const refresh = findRefreshSession(cookies[AUTH_REFRESH_COOKIE]);
  if(!refresh) return null;
  if(res) setAuthCookies(res, signAccessToken(refresh.user), cookies[AUTH_REFRESH_COOKIE]);
  return refresh.user;
}
function isAuthed(req, res){ return !!currentUser(req, res); }
function auditLog(userId, action, meta, req){
  try{
    run("INSERT INTO audit_logs(user_id, action, meta, created_at, ip, user_agent) VALUES(?,?,?,?,?,?)",
      userId || null,
      action,
      meta ? JSON.stringify(meta) : "{}",
      Date.now(),
      (req && req.socket && req.socket.remoteAddress) || "",
      (req && req.headers && req.headers["user-agent"]) || "");
  }catch(e){}
}

/* --------------------------------- Utils ------------------------------- */
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }
function slugify(s){
  return String(s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,80) || "element";
}
function uniqueSlug(table, base, id){
  let slug = base, n = 2;
  while(true){
    const row = get("SELECT id FROM " + table + " WHERE slug=?", slug);
    if(!row || row.id === id) return slug;
    slug = base + "-" + (n++);
  }
}
function safeParse(s){ try { const v = typeof s === "string" ? JSON.parse(s) : s; return Array.isArray(v) ? v : []; } catch(e){ return []; } }
function fmtDate(ts){ return new Date(ts).toLocaleDateString("fr-FR", { day:"2-digit", month:"long", year:"numeric" }); }
function fmtShort(ts){ return new Date(ts).toLocaleDateString("fr-FR", { day:"2-digit", month:"2-digit", year:"numeric" }); }
function jsonForScript(obj){ return JSON.stringify(obj).replace(/</g,"\\u003c").replace(/>/g,"\\u003e").replace(/&/g,"\\u0026").replace(/\u2028/g,"\\u2028").replace(/\u2029/g,"\\u2029"); }
function categoryList(){ return all("SELECT DISTINCT category FROM articles WHERE category IS NOT NULL AND category <> '' ORDER BY category").map(r => r.category); }

/* ----------------------- Rendu des blocs (HTML) ------------------------ */
function inlineFmt(str){
  if(str == null) return "";
  const stash = [];
  let s = String(str);
  s = s.replace(/\$([^\$\n]+?)\$/g, (m, tex) => { stash.push('<span class="ktx" data-mode="inline">' + esc(tex) + '</span>'); return "\u0000" + (stash.length-1) + "\u0000"; });
  s = s.replace(/`([^`]+?)`/g, (m, code) => { stash.push('<code class="inline">' + esc(code) + '</code>'); return "\u0000" + (stash.length-1) + "\u0000"; });
  s = esc(s);
  s = s.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+?)\*/g, "<em>$1</em>");
  s = s.replace(/\[([^\]]+?)\]\((https?:\/\/[^\s)]+)\)/g, (m, t, u) => '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + t + '</a>');
  s = s.replace(/\n/g, "<br>");
  s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => stash[+i]);
  return s;
}
function textBlockHtml(text){
  let out = "", para = [], li = [], ord = false;
  const lines = String(text||"").split(/\n/);
  const flushP = () => { if(para.length){ out += "<p>" + inlineFmt(para.join("\n")) + "</p>"; para = []; } };
  const flushL = () => { if(li.length){ out += (ord ? "<ol>" : "<ul>") + li.map(x => "<li>" + inlineFmt(x) + "</li>").join("") + (ord ? "</ol>" : "</ul>"); li = []; } };
  lines.forEach(line => {
    const ul = /^\s*[-*]\s+(.*)/.exec(line), ol = /^\s*\d+[.)]\s+(.*)/.exec(line);
    if(ul){ flushP(); if(li.length && ord) flushL(); ord = false; li.push(ul[1]); }
    else if(ol){ flushP(); if(li.length && !ord) flushL(); ord = true; li.push(ol[1]); }
    else if(/^\s*$/.test(line)){ flushP(); flushL(); }
    else { flushL(); para.push(line); }
  });
  flushP(); flushL();
  return out;
}
function blockHtml(b){
  if(!b || !b.type) return "";
  if(b.type === "heading"){ const lv = (b.level === 3 ? 3 : 2); return "<h" + lv + ">" + esc(b.text||"") + "</h" + lv + ">"; }
  if(b.type === "text"){ return textBlockHtml(b.text); }
  if(b.type === "quote"){ return "<blockquote>" + inlineFmt(b.text||"") + "</blockquote>"; }
  if(b.type === "code"){ const lang = String(b.lang||"").trim(); return "<pre><code" + (lang ? ' class="language-' + esc(lang) + '"' : "") + ">" + esc(b.code||"") + "</code></pre>"; }
  if(b.type === "formula"){
    if(b.mode === "inline") return '<p><span class="ktx" data-mode="inline">' + esc(b.tex||"") + "</span></p>";
    return '<div class="ktx" data-mode="block">' + esc(b.tex||"") + "</div>";
  }
  if(b.type === "image"){
    if(!b.url) return "";
    const cap = b.caption ? "<figcaption>" + esc(b.caption) + "</figcaption>" : "";
    return '<figure><img src="' + esc(b.url) + '" alt="' + esc(b.caption||"") + '">' + cap + "</figure>";
  }
  return "";
}
function renderBlocks(blocks){ return safeParse(blocks).map(blockHtml).join("\n"); }
function excerptFromBlocks(blocks, n){
  n = n || 160;
  const arr = safeParse(blocks);
  let text = "";
  for(const b of arr){ if(b.type === "text"){ text = b.text; break; } }
  if(!text){ for(const b of arr){ if(b.type === "heading"){ text = b.text; break; } } }
  text = String(text||"").replace(/^\s*[-*]\s+/gm,"").replace(/^\s*\d+[.)]\s+/gm,"")
    .replace(/\*\*|\*|`/g,"").replace(/\$[^$]*\$/g,"").replace(/\[([^\]]+)\]\([^)]+\)/g,"$1").replace(/\s+/g," ").trim();
  return text.length > n ? text.slice(0, n).trim() + "\u2026" : text;
}
function readingSeconds(blocks){
  const arr = safeParse(blocks);
  let words = 0;
  for(const b of arr){
    if(b.type === "text" || b.type === "quote" || b.type === "heading"){
      const t = String(b.text || "").trim(); if(t){ const mm = t.match(/\S+/g); words += mm ? mm.length : 0; }
    } else if(b.type === "code"){
      const t = String(b.code || "").trim(); if(t){ const mm = t.match(/\S+/g); words += mm ? mm.length : 0; }
    } else if(b.type === "image"){ words += 4; }
    else if(b.type === "formula"){ words += 8; }
  }
  return Math.max(1, Math.round(words / 200 * 60)); // ~200 mots/min
}
function fmtRead(secs){
  if(secs < 60) return secs + " s";
  const m = Math.floor(secs / 60), s = secs % 60;
  return s ? (m + " min " + s + " s") : (m + " min");
}

/* --------------------------------- Gabarit ----------------------------- */
function brandMark(name){ const initial = (String(name||"E").trim()[0] || "E").toUpperCase(); return esc(initial) + '<span class="dot">.</span>'; }

function layout(opts){
  const title = opts.title || "Elle";
  const theme = opts.theme || getSetting("theme_default", "light");
  return '<!DOCTYPE html><html lang="fr" data-theme="' + esc(theme) + '"><head>'
    + '<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">'
    + '<meta name="theme-color" content="#1A1613"><title>' + esc(title) + '</title>'
    + '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
    + '<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&family=Source+Serif+4:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500;1,600;1,700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">'
    + '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">'
    + '<link rel="stylesheet" href="/public/styles.css?v=' + ASSET_V + '">'
    + "<script>(function(){try{var t=localStorage.getItem('elle_theme');if(t)document.documentElement.setAttribute('data-theme',t);}catch(e){}})();</script>"
    + '</head><body>'
    + (opts.body || "")
    + '<div id="toast" class="toast"></div>'
    + '<script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>'
    + '<script src="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.9.0/highlight.min.js"></script>'
    + '<script src="/public/app.js?v=' + ASSET_V + '"></script>'
    + '</body></html>';
}
// `me` : l'utilisateur connecté (ou null). Un visiteur du site déployé ne voit
// aucune trace de la partie rédaction privée ; il voit par contre la porte
// d'entrée de la communauté (Connexion / Inscription / Mon espace) et le lien
// « Contribuer ». Le vrai Atelier n'est proposé qu'aux administrateurs.
function publicHeader(active, me){
  const name = getSetting("site_name", "Elle");
  const pages = all("SELECT slug,title FROM pages WHERE in_nav=1 ORDER BY sort,id");
  let nav = '<a href="/"' + (active === "home" ? ' class="on"' : '') + '>Accueil</a>'
    + '<a href="/library"' + (active === "library" ? ' class="on"' : '') + '>Library</a>'
    + '<a href="/blog"' + (active === "blog" ? ' class="on"' : '') + '>Blog</a>'
    + '<a href="/projects"' + (active === "projects" ? ' class="on"' : '') + '>Projets</a>'
    + '<a href="/podcasts"' + (active === "podcasts" ? ' class="on"' : '') + '>Podcasts</a>'
    + '<a href="/courses"' + (active === "courses" ? ' class="on"' : '') + '>Cours</a>'
    + '<a href="/contribuer"' + (active === "contribute" ? ' class="on"' : '') + '>Contribuer</a>';
  pages.forEach(p => { nav += '<a href="/p/' + esc(p.slug) + '"' + (active === "p:" + p.slug ? ' class="on"' : '') + '>' + esc(p.title) + '</a>'; });
  let actions;
  if(me && me.role === "admin"){
    actions = '<a href="/admin" class="link-chip"><span class="hc-dot hc-blog"></span>Atelier</a>';
  } else if(me){
    actions = '<a href="/contribuer/mes-idees" class="link-chip">Mon espace</a>'
      + '<a href="/contribuer/nouveau" class="link-chip link-chip-cta">+ Proposer</a>';
  } else {
    actions = '<a href="/connexion" class="link-chip">Connexion</a>'
      + '<a href="/inscription" class="link-chip link-chip-cta">Inscription</a>';
  }
  return '<header class="top"><div class="top-in">'
    + '<div class="top-left"><button class="icon-btn" data-action="theme" aria-label="Thème">\u263E</button></div>'
    + '<a href="/" class="brand">' + brandMark(name) + '</a>'
    + '<div class="top-actions">' + actions + '</div>'
    + '</div></header>'
    + '<nav class="nav"><div class="nav-in">' + nav + '</div></nav>';
}
function publicFooter(){
  const name = getSetting("site_name", "Elle");
  const email = getSetting("contact_email", "");
  const contact = email ? '<span><a href="mailto:' + esc(email) + '">' + esc(email) + '</a></span>' : '';
  return '<footer class="foot"><div class="foot-in">'
    + '<span class="fbrand">' + brandMark(name) + '</span>'
    + '<span>' + esc(getSetting("footer", "")) + '</span>'
    + contact + '</div></footer>';
}
function adminBar(active){
  const A = (id, href, label) => '<a href="' + href + '"' + (active === id ? ' class="on"' : '') + '>' + label + '</a>';
  const openCount = get("SELECT COUNT(*) AS n FROM submissions WHERE status='open'");
  const newMsgs = get("SELECT COUNT(*) AS n FROM contact_messages WHERE status='new'");
  const badge = (n) => (n > 0 ? ' <span class="nav-badge">' + n + '</span>' : "");
  return '<header class="adminbar"><div class="adminbar-in">'
    + '<a href="/admin" class="b">' + brandMark(getSetting("site_name","Elle")) + ' <small>Atelier</small></a>'
    + '<nav class="adminnav">'
      + A("dash", "/admin", "Tableau de bord")
      + A("pages", "/admin/pages", "Pages")
      + A("faq", "/admin/faq", "Questions")
      + '<a href="/admin/contributions"' + (active === "contrib" ? ' class="on"' : '') + '>Contributions' + badge(openCount ? openCount.n|0 : 0) + '</a>'
      + '<a href="/admin/messages"' + (active === "messages" ? ' class="on"' : '') + '>Messages' + badge(newMsgs ? newMsgs.n|0 : 0) + '</a>'
      + A("assistant", "/admin/assistant", "Agents")
      + A("settings", "/admin/settings", "Réglages")
      + '<a href="/">Voir le site</a>'
      + '<a href="/admin/new/blog" class="cta">+ Article</a>'
      + '<a class="ic" href="/admin/logout" title="Verrouiller l\u2019Atelier" aria-label="Verrouiller">\uD83D\uDD12</a>'
    + '</nav></div></header>';
}
function emptyState(t, txt, href, cta){
  return '<div class="empty"><div class="mk">\u2014</div><h3>' + esc(t) + '</h3><p>' + esc(txt) + '</p>'
    + (href ? '<a class="btn btn-primary" href="' + href + '">' + esc(cta) + '</a>' : '') + '</div>';
}

/* --------------------- Signature automatique des contenus -------------- */
// Ligne compacte \u00ab avatar + surnom \u00bb, pos\u00e9e sous chaque carte de liste.
function bylineMini(entry){
  const u = authorOf(entry);
  if(!u) return "";
  return '<span class="byline-mini">' + avatarHtml(u, "xs") + '<span>' + esc(authorName(u)) + '</span></span>';
}
// Signature compl\u00e8te en t\u00eate d'un contenu : photo, surnom, m\u00e9tier.
function bylineFull(entry){
  const u = authorOf(entry);
  if(!u) return "";
  return '<a class="byline" href="' + authorPath(u) + '">' + avatarHtml(u, "sm")
    + '<span class="by-txt"><span class="by-name">' + esc(authorName(u)) + '</span>'
    + (u.job ? '<span class="by-job">' + esc(u.job) + '</span>' : '') + '</span></a>';
}
// Fiche auteur en pied d'un contenu : le \u00ab profil de la personne \u00bb.
function authorCard(entry){
  const u = authorOf(entry);
  if(!u) return "";
  return '<aside class="author-card">' + avatarHtml(u, "lg")
    + '<div class="ac-body"><div class="ac-kick">\u00c9crit par</div>'
    + '<a class="ac-name" href="' + authorPath(u) + '">' + esc(authorName(u)) + '</a>'
    + (u.job ? '<div class="ac-job">' + esc(u.job) + '</div>' : '')
    + (u.bio ? '<p class="ac-bio">' + inlineFmt(u.bio) + '</p>' : '')
    + '<a class="ac-more" href="' + authorPath(u) + '">Tous ses contenus \u2192</a>'
    + '</div></aside>';
}

/* ------------------ Citations & auteurs les plus lus ------------------- */
// Les citations sont extraites des blocs \u00ab quote \u00bb \u00e9crits par les cr\u00e9ateurs :
// aucune saisie suppl\u00e9mentaire, elles remontent toutes seules.
function quoteHighlights(n){
  const rows = all("SELECT id,slug,title,type,blocks,author_id,views FROM articles WHERE status='published' AND blocks LIKE '%\"quote\"%' ORDER BY views DESC, created_at DESC LIMIT 40");
  const out = [];
  for(const a of rows){
    const b = safeParse(a.blocks).find(x => x && x.type === "quote" && String(x.text || "").trim());
    if(!b) continue;
    out.push({ text: String(b.text).trim(), entry: a });
    if(out.length >= n) break;
  }
  return out;
}
function quotesSection(){
  const items = quoteHighlights(3);
  if(!items.length) return "";
  const cards = items.map(q => {
    const u = authorOf(q.entry);
    return '<figure class="quote-card"><blockquote>' + inlineFmt(q.text) + '</blockquote>'
      + '<figcaption>' + (u ? avatarHtml(u, "sm") : "")
      + '<span class="qc-who"><a class="qc-name" href="' + authorPath(u) + '">' + esc(authorName(u)) + '</a>'
      + (u && u.job ? '<span class="qc-job">' + esc(u.job) + '</span>' : '') + '</span>'
      + '<a class="qc-src" href="' + itemUrl(q.entry) + '">' + esc(q.entry.title) + '</a>'
      + '</figcaption></figure>';
  }).join("");
  return '<div style="margin-top:56px">'
    + '<div class="section-eyebrow"><h2>Citations</h2><span class="rule"></span></div>'
    + '<p class="sec-desc">Des passages relev\u00e9s dans les contenus publi\u00e9s.</p>'
    + '<div class="quote-grid">' + cards + '</div></div>';
}
// Classement par lectures cumul\u00e9es. COALESCE rattache au compte principal les
// contenus ant\u00e9rieurs \u00e0 la signature automatique.
function topAuthors(n){
  const def = defaultAuthorId();
  if(!def) return [];
  return all(
    "SELECT u.*, COUNT(a.id) AS n_items, SUM(a.views) AS total_views "
    + "FROM users u JOIN articles a ON COALESCE(a.author_id, ?) = u.id "
    + "WHERE a.status='published' GROUP BY u.id "
    + "ORDER BY total_views DESC, n_items DESC LIMIT ?", def, n);
}
function topAuthorsSection(){
  const authors = topAuthors(4);
  if(!authors.length) return "";
  const cards = authors.map((u, i) =>
    '<a class="author-tile" href="' + authorPath(u) + '">'
    + '<span class="at-rank">' + (i + 1) + '</span>'
    + avatarHtml(u, "lg")
    + '<span class="at-name">' + esc(authorName(u)) + '</span>'
    + (u.job ? '<span class="at-job">' + esc(u.job) + '</span>' : '')
    + '<span class="at-stats">' + (u.n_items | 0) + ' contenu' + ((u.n_items | 0) > 1 ? "s" : "")
    + ' \u00b7 ' + (u.total_views | 0) + ' lecture' + ((u.total_views | 0) > 1 ? "s" : "") + '</span></a>').join("");
  return '<div style="margin-top:56px">'
    + '<div class="section-eyebrow"><h2>Les plus lus</h2><span class="rule"></span></div>'
    + '<p class="sec-desc">Les auteurs dont les contenus sont les plus consult\u00e9s.</p>'
    + '<div class="author-grid">' + cards + '</div></div>';
}

/* ------------------------------- Pages publiques ----------------------- */
function postRow(a){
  const ex = excerptFromBlocks(a.blocks, 120);
  const ph = (String(getSetting("site_name","E")).trim()[0] || "E").toUpperCase();
  const thumb = a.cover ? '<img class="thumb" src="' + esc(a.cover) + '" alt="">' : '<div class="thumb ph">' + esc(ph) + '</div>';
  return '<a class="post" href="' + itemUrl(a) + '">'
    + '<div><div class="kick">' + esc(a.category || typeOf(a.type).one) + '</div>'
    + '<h3>' + esc(a.title) + '</h3><p class="dek">' + esc(ex) + '</p>'
    + '<div class="meta">' + bylineMini(a) + '<span class="dot-sep"></span>'
    + '<span>' + fmtShort(a.created_at) + '</span><span class="dot-sep"></span>'
    + '<span class="views-pill">\uD83D\uDC41 ' + (a.views|0) + '</span><span class="dot-sep"></span>'
    + '<span class="read-pill">\u23F1 ' + fmtRead(readingSeconds(a.blocks)) + '</span></div></div>'
    + thumb + '</a>';
}
function railCard(e){
  const ex = excerptFromBlocks(e.blocks, 110);
  const ph = (String(getSetting("site_name","E")).trim()[0] || "E").toUpperCase();
  const media = e.cover ? '<img class="rc-media" src="' + esc(e.cover) + '" alt="">' : '<div class="rc-media ph">' + esc(ph) + '</div>';
  return '<a class="rail-card" href="' + itemUrl(e) + '">' + media
    + '<div class="rc-body"><div class="rc-kick">' + esc(e.category || typeOf(e.type).one) + '</div>'
    + '<div class="rc-title">' + esc(e.title) + '</div><p class="rc-ex">' + esc(ex) + '</p>'
    + '<div class="rc-meta"><span>' + fmtShort(e.created_at) + '</span><span>\u00B7</span><span>\u23F1 ' + fmtRead(readingSeconds(e.blocks)) + '</span></div></div></a>';
}
function railItems(type, n){
  let items = all("SELECT * FROM articles WHERE type=? AND status='published' AND featured=1 ORDER BY updated_at DESC LIMIT ?", type, n);
  if(items.length < n){
    const have = {}; items.forEach(x => have[x.id] = 1);
    const more = all("SELECT * FROM articles WHERE type=? AND status='published' ORDER BY created_at DESC LIMIT ?", type, n);
    for(const m of more){ if(!have[m.id]){ items.push(m); if(items.length >= n) break; } }
  }
  return items;
}
function railSection(type){
  const T = typeOf(type);
  const items = railItems(type, 8);
  if(!items.length) return "";
  return '<div class="section-eyebrow"><h2>' + esc(T.many) + '</h2><span class="rule"></span><a href="' + T.listPath + '">Tout voir</a></div>'
    + '<div class="rail">' + items.map(railCard).join("") + '</div>';
}
function heroSection(){
  const mode = getSetting("hero_mode", "cta");
  const name = getSetting("site_name", "Elle");
  const title = getSetting("hero_title", "") || name;
  const sub = getSetting("hero_subtitle", "") || getSetting("tagline", "");
  const label = getSetting("hero_cta_label", "");
  const url = getSetting("hero_cta_url", "") || "/blog";
  const img = getSetting("hero_image", "");
  const cta = label ? '<a class="btn btn-primary btn-lg" href="' + esc(url) + '">' + esc(label) + ' \u2192</a>' : "";
  if(mode === "split" && img){
    return '<section class="hero-split">'
      + '<div class="hero-split-text"><div class="kick">' + esc(name) + '</div><h1>' + esc(title) + '</h1>'
      + '<p>' + esc(sub) + '</p>' + cta + '</div>'
      + '<div class="hero-split-media"><img src="' + esc(img) + '" alt=""></div></section>';
  }
  return '<section class="hero-cta"><div class="eyebrow">' + esc(name) + '</div><h1>' + esc(title) + '</h1>'
    + '<p>' + esc(sub) + '</p>' + cta + '<div class="rule-wide"></div></section>';
}
function faqSection(){
  const faqs = all("SELECT * FROM faqs ORDER BY sort,id");
  if(!faqs.length) return "";
  const items = faqs.map(f => '<details class="faq"><summary>' + esc(f.question) + '</summary><div class="faq-a">' + inlineFmt(f.answer) + '</div></details>').join("");
  return '<div class="section-eyebrow"><h2>Des questions ?</h2><span class="rule"></span></div>'
    + '<section class="faq-wrap">' + items + '</section>';
}
function renderHome(me){
  const authed = !!me;
  const name = getSetting("site_name", "Elle");
  const tagline = getSetting("tagline", "") || "Articles, projets, podcasts et notes de cours \u2014 tout ce que j\u2019apprends et que je fabrique, r\u00E9uni au m\u00EAme endroit.";
  const blogItems = all("SELECT * FROM articles WHERE type=\u0027blog\u0027 AND status=\u0027published\u0027 ORDER BY created_at DESC LIMIT 4");
  const projectList = all("SELECT * FROM articles WHERE type=\u0027project\u0027 AND status=\u0027published\u0027 ORDER BY created_at DESC LIMIT 3");
  const podcastList = all("SELECT * FROM articles WHERE type=\u0027podcast\u0027 AND status=\u0027published\u0027 ORDER BY created_at DESC LIMIT 3");
  const courseList = all("SELECT * FROM articles WHERE type=\u0027course\u0027 AND status=\u0027published\u0027 ORDER BY created_at DESC LIMIT 4");
  const artsCount = get("SELECT COUNT(*) AS n FROM articles WHERE status=\u0027published\u0027");
  const hasContent = artsCount && artsCount.n > 0;
  const phChar = esc((String(name||"E").trim()[0]||"E").toUpperCase());
  const phPrefix = phChar + " \u00B7 ";
  function hCard(item){
    const T = typeOf(item.type);
    const ex = excerptFromBlocks(item.blocks, 90);
    return '<a class="rail-card" href="' + itemUrl(item) + '">'
      + (item.cover ? '<img class="rc-media" src="' + esc(item.cover) + '" alt="">' : '<div class="rc-media ph">' + esc(phPrefix + T.one.toUpperCase()) + '</div>')
      + '<div class="rc-body"><div class="rc-kick">' + esc(item.category || T.one) + '</div>'
      + '<h3 class="rc-title">' + esc(item.title) + '</h3><p class="rc-ex">' + esc(ex) + '</p>'
      + '<div class="rc-meta">' + bylineMini(item) + '<span>\u00B7</span><span>' + fmtShort(item.created_at) + '</span><span>\u00B7</span><span>' + fmtRead(readingSeconds(item.blocks)) + '</span></div></div></a>';
  }
  function pjCard(item){
    const T = typeOf(item.type);
    const ex = excerptFromBlocks(item.blocks, 100);
    const stack = (item.category || "").toUpperCase();
    return '<a class="project-card" href="' + itemUrl(item) + '">'
      + (item.cover ? '<img class="pc-media" src="' + esc(item.cover) + '" alt="">' : '<div class="pc-media ph">' + esc(phPrefix + T.one.toUpperCase()) + '</div>')
      + '<div class="pc-body">' + (stack ? '<span class="pc-stack">' + esc(stack) + '</span>' : '')
      + '<h3 class="pc-title">' + esc(item.title) + '</h3><p class="pc-ex">' + esc(ex) + '</p>'
      + '<div class="pc-foot">' + bylineMini(item) + '<span class="pc-go">Voir le projet \u2192</span></div></div></a>';
  }
  function podRow(item){
    return '<a class="pod-row" href="' + itemUrl(item) + '">'
      + '<span class="pod-play"></span>'
      + '<div class="pod-info"><div class="pod-cat">' + esc(item.category || "Podcast") + '</div>'
      + '<div class="pod-title">' + esc(item.title) + '</div></div>'
      + '<span class="pod-duration">' + fmtRead(readingSeconds(item.blocks)) + '</span>'
      + '<span class="pod-date">' + fmtShort(item.created_at) + '</span></a>';
  }
  function crRow(item){
    const pf = item.source_platform || item.category || "Cours";
    const hasPrg = item.type === "course" && item.subtype !== "authored";
    const pct = item.progress|0;
    return '<a class="course-row" href="' + itemUrl(item) + '">'
      + '<div class="cr-info"><span class="cr-platform">' + esc(pf) + '</span>'
      + '<div class="cr-title">' + esc(item.title) + '</div></div>'
      + (hasPrg
        ? '<span class="course-progress-wrap"><span class="course-progress-bar"><span class="course-progress-fill" style="width:' + pct + '%"></span></span><span class="course-progress-label">' + pct + '%</span></span>'
        : '<span class="course-module-label">\u00C0 suivre</span>')
      + '</a>';
  }
  function secIntro(label, desc, href, icon){
    return '<div class="section-eyebrow">' + icon + '<h2>' + label + '</h2><span class="rule"></span><a href="' + href + '">Tout voir \u2192</a></div><p class="sec-desc">' + desc + '</p>';
  }
  const dotB = '<span class="hc-dot hc-blog"></span>';
  const dotP = '<span class="hc-dot hc-project"></span>';
  const dotPod = '<span class="hc-dot hc-podcast"></span>';
  const dotC = '<span class="hc-dot hc-course"></span>';
  var body = publicHeader("home", me) + '<main class="wide">'
    + '<section class="hero"><div class="eyebrow">' + esc(name) + ' \u2014 journal personnel</div>'
    + '<h1>Construire en public,<br>une note \u00E0 la fois.</h1>'
    + '<p class="tagline">' + esc(tagline) + '</p>'
    + '<a class="btn" href="/library">Explorer la Library <span>\u2192</span></a>'
    + '<div class="hero-chips">'
    + '<a href="/blog" class="hero-chip">' + dotB + 'Blog</a>'
    + '<a href="/projects" class="hero-chip">' + dotP + 'Projets</a>'
    + '<a href="/podcasts" class="hero-chip">' + dotPod + 'Podcasts</a>'
    + '<a href="/courses" class="hero-chip">' + dotC + 'Cours</a>'
    + '</div><div class="rule-wide"></div></section>'
    + (blogItems.length ? secIntro("Blog","R\u00E9flexions et notes d\u2019apprentissage.","/blog",dotB) + '<div class="rail">' + blogItems.map(hCard).join("") + '</div>' : '')
    + (projectList.length ? '<div style="margin-top:56px">' + secIntro("Projets","Ce que je construis, du prototype au produit.","/projects",dotP) + '<div class="project-grid">' + projectList.map(pjCard).join("") + '</div></div>' : '')
    + (podcastList.length ? '<section class="pod-band"><div class="pod-band-in">' + secIntro("Podcasts","Conversations \u00E0 \u00E9couter en marchant.","/podcasts",dotPod) + podcastList.map(podRow).join("") + '</div></section>' : '')
    + (courseList.length ? '<div style="margin-top:56px">' + secIntro("Cours","Ce que j\u2019apprends, suivi \u00E0 la note pr\u00E8s.","/courses",dotC) + '<div class="course-list">' + courseList.map(crRow).join("") + '</div></div>' : '')
    + quotesSection()
    + topAuthorsSection()
    + faqSection()
    + (!hasContent ? (authed
        ? emptyState("Le journal est vide", "Publiez votre premier contenu depuis l\u2019Atelier.", "/admin", "Ouvrir l\u2019Atelier")
        : emptyState("Le journal est vide", "Les premiers contenus arrivent bient\u00F4t.", "", "")) : '')
    + '</main>' + publicFooter();
  return layout({ title: esc(name) + " \u2014 " + (tagline ? esc(tagline) : "Journal"), body });
}

function renderLibrary(me){
  const authed = !!me;
  const name = getSetting("site_name", "Elle");
  const blogItems = all("SELECT * FROM articles WHERE type=\u0027blog\u0027 AND status=\u0027published\u0027 ORDER BY created_at DESC LIMIT 6");
  const projectItems = all("SELECT * FROM articles WHERE type=\u0027project\u0027 AND status=\u0027published\u0027 ORDER BY created_at DESC LIMIT 6");
  const podcastItems = all("SELECT * FROM articles WHERE type=\u0027podcast\u0027 AND status=\u0027published\u0027 ORDER BY created_at DESC LIMIT 6");
  const courseItems = all("SELECT * FROM articles WHERE type=\u0027course\u0027 AND status=\u0027published\u0027 ORDER BY created_at DESC LIMIT 6");
  const total = blogItems.length + projectItems.length + podcastItems.length + courseItems.length;
  function lc(item){
    const T = typeOf(item.type);
    const ex = excerptFromBlocks(item.blocks, 80);
    return '<a class="lib-card" href="' + itemUrl(item) + '">'
      + '<span class="lib-type ' + item.type + '">' + T.one + '</span>'
      + '<h3 class="lib-title">' + esc(item.title) + '</h3>'
      + '<p class="lib-ex">' + esc(ex) + '</p>'
      + '<span class="lib-foot">' + bylineMini(item) + '<span class="lib-date">' + fmtShort(item.created_at) + '</span></span></a>';
  }
  function secH(label, href){
    return '<div class="section-eyebrow" style="margin-top:48px"><h2>' + label + '</h2><span class="rule"></span><a href="' + href + '">Tout voir \u2192</a></div>';
  }
  const allRecent = [].concat(blogItems, projectItems, podcastItems, courseItems).sort(function(a,b){ return b.created_at - a.created_at; }).slice(0,8);
  var body = publicHeader("library", me) + '<main class="wide">'
    + '<section class="lib-intro"><div class="eyebrow">' + esc(name) + ' \u2014 Library</div>'
    + '<h1>Tout ce qui compte,<br>au m\u00EAme endroit.</h1>'
    + '<p class="tagline">Recherchez, filtrez, parcourez. La Library rassemble chaque article, projet, podcast et cours.</p>'
    + '<div class="lib-search-wrap"><input class="lib-search" type="search" placeholder="Rechercher un article, un projet..." id="libSearch"></div></section>'
    + (total ? '<div class="section-eyebrow" style="margin-top:8px"><h2>R\u00E9cents</h2><span class="rule"></span></div><div class="lib-grid" id="libGrid">' + allRecent.map(lc).join("") + '</div>' : '')
    + (blogItems.length ? secH("Blog","/blog") + '<div class="lib-grid">' + blogItems.map(lc).join("") + '</div>' : '')
    + (projectItems.length ? secH("Projets","/projects") + '<div class="lib-grid">' + projectItems.map(lc).join("") + '</div>' : '')
    + (podcastItems.length ? secH("Podcasts","/podcasts") + '<div class="lib-grid">' + podcastItems.map(lc).join("") + '</div>' : '')
    + (courseItems.length ? secH("Cours","/courses") + '<div class="lib-grid">' + courseItems.map(lc).join("") + '</div>' : '')
    + (!total ? (authed
        ? emptyState("Library vide", "Publiez votre premier contenu dans l\u2019Atelier.", "/admin", "Ouvrir l\u2019Atelier")
        : emptyState("Library vide", "Les premiers contenus arrivent bient\u00f4t.", "", "")) : '')
    + '<script>(function(){var s=document.getElementById("libSearch");var g=document.querySelectorAll(".lib-grid");if(!s)return;s.addEventListener("input",function(){var q=s.value.toLowerCase().trim();g.forEach(function(x){var any=false;x.querySelectorAll(".lib-card").forEach(function(c){var t=(c.querySelector(".lib-title")||{}).textContent||"";var m=!q||t.toLowerCase().indexOf(q)>=0;c.style.display=m?"":"none";if(m)any=true;});x.style.display=any?"":"none";var h=x.previousElementSibling;if(h&&h.classList.contains("section-eyebrow"))h.style.display=any?"":"none";});});})();</script>'
    + '</main>' + publicFooter();
  return layout({ title: esc(name) + " \u2014 Library", body });
}

function listParams(sp){
  return { cat: sp.get("cat") || "", sort: sp.get("sort") || "recent" };
}
function applyListFilters(items, cat, sort){
  let out = items.slice();
  if(cat) out = out.filter(a => a.category === cat);
  out.sort((a, b) => sort === "views" ? (b.views|0) - (a.views|0) : sort === "old" ? a.created_at - b.created_at : b.created_at - a.created_at);
  return out;
}
function phChar(){ return (String(getSetting("site_name","E")).trim()[0] || "E").toUpperCase(); }
function listControls(T, sp, items){
  const cats = Array.from(new Set(items.map(a => a.category).filter(Boolean)));
  const { cat, sort } = listParams(sp);
  const q = (extra) => T.listPath + "?" + (cat ? "cat=" + encodeURIComponent(cat) + "&" : "") + extra;
  const chips = '<a class="chip' + (!cat ? " on" : "") + '" href="' + T.listPath + '">Tous</a>'
    + cats.map(c => '<a class="chip' + (cat === c ? " on" : "") + '" href="' + T.listPath + '?cat=' + encodeURIComponent(c) + (sort !== "recent" ? "&sort=" + sort : "") + '">' + esc(c) + '</a>').join("");
  const seg = '<div class="seg">'
    + '<a href="' + q("sort=recent") + '" class="' + (sort === "recent" ? "on" : "") + '">Récents</a>'
    + '<a href="' + q("sort=views") + '" class="' + (sort === "views" ? "on" : "") + '">Populaires</a>'
    + '<a href="' + q("sort=old") + '" class="' + (sort === "old" ? "on" : "") + '">Anciens</a></div>';
  return '<div class="list-tools"><div class="filters">' + chips + '</div>'
    + '<div class="sort-row">Trier : ' + seg + '</div></div>';
}
function listIntro(eyebrow, titleHtml, tagline, stats){
  return '<section class="lp-head"><div class="eyebrow">' + esc(eyebrow) + '</div><h1>' + titleHtml + '</h1>'
    + (tagline ? '<p class="tagline">' + esc(tagline) + '</p>' : '')
    + (stats ? '<div class="lp-stats">' + stats + '</div>' : '') + '</section>';
}
function statChip(n, label, alt){
  return '<span class="lp-stat' + (alt ? " alt" : "") + '"><b>' + n + '</b>' + esc(label) + '</span>';
}

/* ---------- Blog : une « à la une » + grille éditoriale ---------- */
function blogCard(a){
  const T = typeOf(a.type);
  const ex = excerptFromBlocks(a.blocks, 100);
  return '<a class="blog-card" href="' + itemUrl(a) + '">'
    + (a.cover ? '<img class="bc-media" src="' + esc(a.cover) + '" alt="">' : '<div class="bc-media ph">' + esc(phChar()) + '</div>')
    + '<div class="bc-body"><div class="rc-kick">' + esc(a.category || T.one) + '</div>'
    + '<h3 class="rc-title">' + esc(a.title) + '</h3><p class="rc-ex">' + esc(ex) + '</p>'
    + '<div class="rc-meta">' + bylineMini(a) + '<span>\u00B7</span><span>' + fmtShort(a.created_at) + '</span>'
    + '<span>\u00B7</span><span>\u23F1 ' + fmtRead(readingSeconds(a.blocks)) + '</span></div></div></a>';
}
function featuredBlog(a){
  if(!a) return "";
  const ex = excerptFromBlocks(a.blocks, 160);
  return '<a class="feat-blog" href="' + itemUrl(a) + '">'
    + (a.cover ? '<div class="feat-media"><img src="' + esc(a.cover) + '" alt=""></div>'
      : '<div class="feat-media ph">' + esc(phChar()) + '</div>')
    + '<div class="feat-body"><div class="rc-kick">' + esc(a.category || "À la une") + '</div>'
    + '<h2>' + esc(a.title) + '</h2><p class="dek">' + esc(ex) + '</p>'
    + '<div class="meta">' + bylineMini(a) + '<span class="dot-sep"></span><span>' + fmtDate(a.created_at) + '</span>'
    + '<span class="dot-sep"></span><span class="views-pill">\uD83D\uDC41 ' + (a.views|0) + '</span>'
    + '<span class="dot-sep"></span><span class="read-pill">\u23F1 ' + fmtRead(readingSeconds(a.blocks)) + '</span></div>'
    + '<span class="feat-more">Lire l\u2019article \u2192</span></div></a>';
}
function renderBlogPage(sp, me){
  const T = typeOf("blog");
  const name = getSetting("site_name", "Elle");
  const allItems = all("SELECT * FROM articles WHERE type='blog' AND status='published'");
  const { cat, sort } = listParams(sp);
  const featured = (!cat && sort === "recent") ? (allItems.filter(a => a.featured).sort((a,b) => b.created_at - a.created_at)[0] || allItems[0]) : null;
  const items = applyListFilters(allItems, cat, sort);
  const totalViews = items.reduce((s, a) => s + (a.views|0), 0);
  const body = publicHeader("blog", me) + '<main class="wide">'
    + listIntro("Le blog de " + name, "Penser tout haut,<br>une note \u00E0 la fois.",
      "R\u00E9flexions, exp\u00E9riences et apprentissages \u2014 \u00E9crits sans chichi.",
      statChip(items.length, " article" + (items.length > 1 ? "s" : "")) + statChip(totalViews, " lecture" + (totalViews > 1 ? "s" : ""), 1))
    + (featured ? featuredBlog(featured) : "")
    + listControls(T, sp, allItems)
    + (items.length
        ? '<div class="blog-grid">' + items.filter(a => !featured || a.id !== featured.id).map(blogCard).join("") + '</div>'
        : emptyState("Rien ici pour l\u2019instant", "Aucun article publi\u00e9.", "", ""))
    + '</main>' + publicFooter();
  return layout({ title: "Blog \u2014 " + name, body });
}

/* ---------- Projets : tuiles « carte projet » ---------- */
function projectTile(a){
  const ex = excerptFromBlocks(a.blocks, 100);
  const stack = (a.category || "").toUpperCase();
  return '<a class="project-card" href="' + itemUrl(a) + '">'
    + (a.cover ? '<img class="pc-media" src="' + esc(a.cover) + '" alt="">' : '<div class="pc-media ph">' + esc(phChar()) + '</div>')
    + '<div class="pc-body">' + (stack ? '<span class="pc-stack">' + esc(stack) + '</span>' : '')
    + '<h3 class="pc-title">' + esc(a.title) + '</h3><p class="pc-ex">' + esc(ex) + '</p>'
    + '<div class="pc-foot">' + bylineMini(a) + '<span class="pc-go">Voir le projet \u2192</span></div></div></a>';
}
function renderProjectsPage(sp, me){
  const T = typeOf("project");
  const name = getSetting("site_name", "Elle");
  const allItems = all("SELECT * FROM articles WHERE type='project' AND status='published'");
  const { cat, sort } = listParams(sp);
  const items = applyListFilters(allItems, cat, sort);
  const totalViews = items.reduce((s, a) => s + (a.views|0), 0);
  const inProgress = items.filter(a => String(a.category||"").toLowerCase() !== "termin\u00e9").length;
  const body = publicHeader("projects", me) + '<main class="wide">'
    + listIntro("Portfolio de " + name, "Des id\u00e9es<br>fabriqu\u00e9es pour de vrai.",
      "Du prototype au produit : ce que je construis et ce que j\u2019apprends en route.",
      statChip(items.length, " projet" + (items.length > 1 ? "s" : "")) + statChip(inProgress, " en cours", 1) + statChip(totalViews, " lecture" + (totalViews > 1 ? "s" : ""), 1))
    + listControls(T, sp, allItems)
    + (items.length
        ? '<div class="project-page-grid">' + items.map(projectTile).join("") + '</div>'
        : emptyState("Rien ici pour l\u2019instant", "Aucun projet publi\u00e9.", "", ""))
    + '</main>' + publicFooter();
  return layout({ title: "Projets \u2014 " + name, body });
}

/* ---------- Podcasts : scène épisodes pleine largeur ---------- */
function podCard(a, i){
  const ex = excerptFromBlocks(a.blocks, 90);
  return '<a class="ep-row" href="' + itemUrl(a) + '">'
    + '<span class="ep-num">' + String(i + 1).padStart(2, "0") + '</span>'
    + (a.cover ? '<img class="ep-art" src="' + esc(a.cover) + '" alt="">' : '<div class="ep-art ph">' + esc(phChar()) + '</div>')
    + '<span class="pod-play"></span>'
    + '<div class="ep-info"><div class="pod-cat">' + esc(a.category || "Podcast") + '</div>'
    + '<div class="pod-title">' + esc(a.title) + '</div><p class="ep-ex">' + esc(ex) + '</p></div>'
    + '<span class="pod-duration">\u23F1 ' + fmtRead(readingSeconds(a.blocks)) + '</span>'
    + '<span class="pod-date">\uD83D\uDC41 ' + (a.views|0) + '</span></a>';
}
function renderPodcastsPage(sp, me){
  const T = typeOf("podcast");
  const name = getSetting("site_name", "Elle");
  const allItems = all("SELECT * FROM articles WHERE type='podcast' AND status='published'");
  const { cat, sort } = listParams(sp);
  const items = applyListFilters(allItems, cat, sort);
  const totalViews = items.reduce((s, a) => s + (a.views|0), 0);
  const body = publicHeader("podcasts", me) + '<main class="wide">'
    + listIntro("Sur les ondes de " + name, "\u00C0 \u00E9couter<br>en marchant.",
      "Les \u00E9pisodes s\u2019entendent aussi comme on lit : un script, une id\u00E9e, une discussion.",
      statChip(items.length, " \u00E9pisode" + (items.length > 1 ? "s" : "")) + statChip(totalViews, " lecture" + (totalViews > 1 ? "s" : ""), 1))
    + listControls(T, sp, allItems)
    + '<div class="pod-stage">'
    + (items.length ? items.map(podCard).join("") : emptyState("Rien ici pour l\u2019instant", "Aucun podcast publi\u00e9.", "", ""))
    + '</div>'
    + '</main>' + publicFooter();
  return layout({ title: "Podcasts \u2014 " + name, body });
}

/* ---------- Cours : liste d'apprentissage avec progression ---------- */
function courseRow(a){
  const pf = a.source_platform || a.category || "Cours";
  const hasPrg = a.type === "course" && a.subtype !== "authored";
  const pct = Math.max(0, Math.min(100, a.progress|0));
  const done = hasPrg && pct >= 100;
  return '<a class="course-row" href="' + itemUrl(a) + '">'
    + '<div class="cr-icon">' + (done ? "\u2713" : "\uD83C\uDF93") + '</div>'
    + '<div class="cr-info"><span class="cr-platform">' + esc(pf) + '</span>'
    + '<div class="cr-title">' + esc(a.title) + '</div>'
    + (a.source_url ? '<span class="cr-src">' + esc(a.source_url) + '</span>' : '') + '</div>'
    + (hasPrg
        ? '<span class="course-progress-wrap"><span class="course-progress-bar"><span class="course-progress-fill" style="width:' + pct + '%"></span></span><span class="course-progress-label">' + (done ? "Termin\u00e9" : pct + "%") + '</span></span>'
        : '<span class="course-module-label">\u00C0 suivre</span>')
    + '<span class="cr-date">' + fmtShort(a.created_at) + '</span></a>';
}
function renderCoursesPage(sp, me){
  const T = typeOf("course");
  const name = getSetting("site_name", "Elle");
  const allItems = all("SELECT * FROM articles WHERE type='course' AND status='published'");
  const { cat, sort } = listParams(sp);
  const items = applyListFilters(allItems, cat, sort);
  const graded = items.filter(a => a.subtype !== "authored");
  const avg = graded.length ? Math.round(graded.reduce((s,a) => s + (a.progress|0), 0) / graded.length) : 0;
  const body = publicHeader("courses", me) + '<main class="wide">'
    + listIntro("La salle de classe de " + name, "Ce que j\u2019apprends,<br>suivi \u00E0 la note pr\u00E8s.",
      "Notes, MOOC et cours que je con\u00E7ois \u2014 avec la progression, \u00E7a aide \u00E0 tenir le rythme.",
      statChip(items.length, " cours") + statChip(avg, " % en moyenne", 1))
    + listControls(T, sp, allItems)
    + '<div class="course-page-list">'
    + (items.length ? items.map(courseRow).join("") : emptyState("Rien ici pour l\u2019instant", "Aucun cours publi\u00e9.", "", ""))
    + '</div>'
    + '</main>' + publicFooter();
  return layout({ title: "Cours \u2014 " + name, body });
}
function renderItem(req, res, slug){
  const me = currentUser(req, res);
  const authed = !!me;
  const a = get("SELECT * FROM articles WHERE slug=?", slug);
  if(!a) return sendHtml(res, notFound(me), 404);
  if(a.status === "draft" && !authed) return sendHtml(res, notFound(me), 404);
  let views = a.views | 0;
  if(a.status !== "draft"){ run("UPDATE articles SET views = views + 1 WHERE id=?", a.id); views += 1; }
  const T = typeOf(a.type);
  const rt = fmtRead(readingSeconds(a.blocks));
  const draftNote = a.status === "draft" ? '<div class="banner">Brouillon — visible seulement par vous.</div>' : '';
  const cover = a.cover ? '<img class="cover" src="' + esc(a.cover) + '" alt="">' : '';
  const courseInfo = a.type === "course" ? (
    '<div class="course-meta">'
    + (a.source_platform ? '<span class="course-pill">\uD83C\uDF93 ' + esc(a.source_platform) + '</span>' : '')
    + (a.source_url ? '<a class="course-pill" href="' + esc(a.source_url) + '" target="_blank" rel="noopener">\uD83D\uDD17 Voir la source</a>' : '')
    + (a.subtype !== "authored" ? '<span class="course-progress"><span class="course-progress-bar" style="width:' + Math.max(0, Math.min(100, a.progress|0)) + '%"></span></span><span class="course-pill">' + (a.progress|0) + '% termin\u00e9</span>' : '')
    + '</div>'
  ) : '';
  const body = publicHeader(T.nav, me) + '<main class="wrap reader">'
    + '<a class="back" href="' + T.listPath + '">\u2190 ' + esc(T.many) + '</a>'
    + '<div class="kick">' + esc(a.category || T.one) + '</div><h1>' + esc(a.title) + '</h1>'
    + '<div class="byline-row">' + bylineFull(a)
    + '<div class="meta"><span>' + fmtDate(a.created_at) + '</span><span class="dot-sep"></span>'
    + '<span class="views-pill">\uD83D\uDC41 ' + views + ' lecture' + (views > 1 ? "s" : "") + '</span>'
    + '<span class="dot-sep"></span><span class="read-pill">\u23F1 ' + rt + ' de lecture</span></div></div>'
    + courseInfo
    + draftNote + cover + '<div class="prose">' + renderBlocks(a.blocks) + '</div>'
    + authorCard(a)
    + '</main>' + publicFooter();
  sendHtml(res, layout({ title: a.title + " — " + getSetting("site_name","Elle"), body }));
}

/* ---------- Pages spéciales « À propos » et « Contact » ---------- */
function contactPageBody(p, me, sent, err){
  const name = getSetting("site_name", "Elle");
  const email = getSetting("contact_email", "");
  const text = getSetting("contact_text", "") || "Une question, une remarque, une collaboration\u00a0? \u00c9crivez-moi.";
  const emailUrl = email ? 'mailto:' + esc(email) + '?subject=' + encodeURIComponent(name + " — message via le site") : "";
  const banner = sent
    ? '<div class="banner ok">Merci\u00a0! Votre message est bien parti. Je vous r\u00e9ponds d\u00e8s que possible. \u2713</div>'
    : (err ? '<div class="banner" style="background:var(--accent-soft);color:var(--accent-ink)">' + esc(err) + '</div>' : "");
  const form = '<form class="contact-form" method="POST" action="/contact">'
    + '<div class="cf-cols">'
    + '<div class="field"><label>Votre nom</label><input type="text" name="name" required placeholder="Comment vous appelez-vous\u00a0?"></div>'
    + '<div class="field"><label>Votre e-mail</label><input type="email" name="email" required placeholder="vous@exemple.fr"></div>'
    + '</div>'
    + '<div class="field"><label>Objet</label><input type="text" name="subject" required maxlength="120" placeholder="De quoi voulez-vous parler\u00a0?"></div>'
    + '<div class="field"><label>Message</label><textarea name="body" rows="6" required placeholder="\u00c9crivez votre message\u2026"></textarea></div>'
    + '<button class="btn btn-primary btn-lg" type="submit">Envoyer le message \u2192</button></form>';
  const side = '<aside class="contact-side">'
    + '<div class="cs-block"><div class="cs-kick">\u2709\uFE0F</div><h3>M\'écrire directement</h3>'
    + '<p>' + esc(text) + '</p>'
    + (email ? '<a class="btn btn-ghost" href="' + emailUrl + '">' + esc(email) + '</a>' : '<p class="hint">Adresse e-mail \u00e0 configurer dans l\u2019Atelier \u2192 R\u00e9glages.</p>')
    + '</div>'
    + '<div class="cs-block"><div class="cs-kick">\uD83D\uDCA1</div><h3>Une idée ou un retour\u00a0?</h3>'
    + '<p>La communauté de ' + esc(name) + ' collecte aussi les id\u00e9es, les soucis et les suggestions.</p>'
    + '<a class="btn btn-ghost" href="/contribuer">Aller sur Contribuer \u2192</a></div>'
    + '<div class="cs-block"><div class="cs-kick">\u2753</div><h3>Questions fr\u00e9quentes</h3>'
    + '<a class="btn btn-ghost" href="/#questions">Voir la FAQ \u2192</a></div>'
    + '</aside>';
  const content = renderBlocks(p.blocks);
  const blocksLen = (safeParse(p.blocks).filter(b => (b.text||"").replace(/\s+/g,"").length > 24)).length;
  const body = publicHeader("p:contact", me) + '<main class="wrap">'
    + '<a class="back" href="/">\u2190 Accueil</a>'
    + '<section class="contact-hero"><div class="eyebrow">' + esc(name) + ' \u2014 contact</div>'
    + '<h1>Parlons-en.</h1>'
    + '<p class="tagline">' + esc(text) + '</p></section>'
    + banner
    + '<div class="contact-deck"><div class="contact-main">' + form + '</div>' + side + '</div>'
    + (blocksLen ? '<div class="contact-notes"><div class="prose">' + content + '</div></div>' : '')
    + '</main>' + publicFooter();
  return layout({ title: "Contact \u2014 " + name, body });
}
function aboutPageBody(p, me){
  const name = getSetting("site_name", "Elle");
  const tagline = getSetting("tagline", "") || "Le lieu où j\u2019écris, construis et partage en public.";
  const artsCount = get("SELECT COUNT(*) AS n FROM articles WHERE status='published'");
  const views = get("SELECT SUM(views) AS s FROM articles WHERE status='published'");
  const nArts = artsCount ? (artsCount.n|0) : 0;
  const nViews = views ? (views.s|0) : 0;
  const cats = get("SELECT COUNT(DISTINCT category) AS n FROM articles WHERE status='published' AND category IS NOT NULL AND category <> ''");
  const authors = all("SELECT COUNT(DISTINCT COALESCE(author_id, 0)) AS n FROM articles WHERE status='published'");
  const recent = all("SELECT * FROM articles WHERE status='published' ORDER BY created_at DESC LIMIT 6");
  const stats = '<div class="about-stats">'
    + statChip(nArts, " contenu" + (nArts > 1 ? "s" : ""))
    + statChip(nViews, " lecture" + (nViews > 1 ? "s" : ""), 1)
    + statChip((cats ? cats.n|0 : 0), " catégorie" + ((cats && cats.n > 1) ? "s" : ""), 1)
    + statChip((authors ? authors.n|0 : 0), " auteur" + (authors && authors.n > 1 ? "s" : ""), 1)
    + '</div>';
  const body = publicHeader("p:about", me) + '<main class="wide">'
    + '<section class="about-hero"><div class="eyebrow">' + esc(name) + '</div>'
    + '<h1>' + esc(name) + ', <em>c\u2019est quoi&nbsp;?</em></h1>'
    + '<p class="tagline">' + esc(tagline) + '</p></section>'
    + stats
    + '<div class="about-grid">'
    + '<div class="about-prose"><div class="prose">' + renderBlocks(p.blocks) + '</div>'
    + '<div class="about-cta"><a class="btn btn-primary" href="/library">Explorer la Library \u2192</a>'
    + '<a class="btn btn-ghost" href="/contribuer">Contribuer une idée \u2192</a></div></div>'
    + '<aside class="about-side">' + topAuthorsSection() + '</aside></div>'
    + '<section class="about-recent"><div class="section-eyebrow"><h2>Tout r\u00e9cemment</h2><span class="rule"></span><a href="/library">Tout voir \u2192</a></div>'
    + '<div class="rail">' + recent.map(railCard).join("") + '</div></section>'
    + '</main>' + publicFooter();
  return layout({ title: "À propos \u2014 " + name, body });
}
function renderPageView(slug, me, sp){
  const p = get("SELECT * FROM pages WHERE slug=?", slug);
  if(!p) return null;
  if(slug === "contact") return contactPageBody(p, me, sp && sp.get("sent") === "1", "");
  if(slug === "about") return aboutPageBody(p, me);
  const body = publicHeader("p:" + slug, me) + '<main class="wrap reader page-centered">'
    + '<a class="back" href="/">\u2190 Accueil</a><h1>' + esc(p.title) + '</h1>'
    + '<div class="prose">' + renderBlocks(p.blocks) + '</div></main>' + publicFooter();
  return layout({ title: p.title + " — " + getSetting("site_name","Elle"), body });
}
// Destination des signatures : la fiche publique d'un auteur et ses contenus.
function renderAuthorPage(username, me){
  const u = get("SELECT * FROM users WHERE lower(username)=lower(?) AND is_active=1", String(username || ""));
  if(!u) return null;
  const def = defaultAuthorId();
  const items = all(
    "SELECT * FROM articles WHERE status='published' AND COALESCE(author_id, ?) = ? ORDER BY created_at DESC",
    def, u.id);
  const views = items.reduce((s, a) => s + (a.views | 0), 0);
  const list = items.length ? items.map(postRow).join("")
    : emptyState("Rien de publié", "Cette personne n’a pas encore de contenu en ligne.", "", "");
  const body = publicHeader("", me) + '<main class="wide">'
    + '<section class="author-hero">' + avatarHtml(u, "xl")
    + '<div class="ah-body"><div class="eyebrow">Auteur</div>'
    + '<h1>' + esc(authorName(u)) + '</h1>'
    + (u.job ? '<div class="ah-job">' + esc(u.job) + '</div>' : '')
    + (u.bio ? '<p class="ah-bio">' + inlineFmt(u.bio) + '</p>' : '')
    + '<div class="ah-stats"><span>' + items.length + ' contenu' + (items.length > 1 ? "s" : "") + '</span>'
    + '<span class="dot-sep"></span><span>' + views + ' lecture' + (views > 1 ? "s" : "") + '</span></div>'
    + '</div></section><div class="rule-wide"></div>'
    + '<div style="margin-top:28px">' + list + '</div>'
    + '</main>' + publicFooter();
  return layout({ title: authorName(u) + " — " + getSetting("site_name", "Elle"), body });
}
function notFound(me){
  const body = publicHeader("", me) + '<main class="wrap"><div class="empty"><div class="mk">404</div>'
    + '<h3>Page introuvable</h3><p>Cette page n\u2019existe pas (ou plus).</p>'
    + '<a class="btn btn-primary" href="/">Retour à l\u2019accueil</a></div></main>' + publicFooter();
  return layout({ title: "404", body });
}

/* --------------------------------- Atelier ----------------------------- */
function authFormPage(opts){
  opts = opts || {};
  const create = !!opts.create;
  const migrate = !!opts.migrate;
  const err = opts.err || "";
  const mark = brandMark(getSetting("site_name","Elle"));
  const errHtml = err ? '<div class="pin-err">' + esc(err) + '</div>' : '<div class="pin-err"></div>';
  // Bloc profil public, commun à la création de compte et à la migration :
  // c'est lui qui signera ensuite chaque contenu publié.
  const v = opts.values || {};
  const profileFields = '<div class="lock-sep"><span>Votre profil public</span></div>'
    + '<div class="avatar-pick" data-uploader data-target="avatar_input">'
    + '<img class="prev av-lg" src="' + esc(v.avatar || "") + '" alt=""' + (v.avatar ? "" : ' style="display:none"') + '>'
    + (v.avatar ? '' : '<span class="av-lg av-ph av-empty">+</span>')
    + '<input type="file" accept="image/*" class="hidden">'
    + '<button type="button" class="btn btn-ghost btn-sm" data-pick>Photo de profil</button></div>'
    + '<input type="hidden" id="avatar_input" name="avatar" value="' + esc(v.avatar || "") + '">'
    + '<div class="pin-field"><input type="text" name="display_name" value="' + esc(v.display_name || "") + '" placeholder="Surnom affiché (signe vos contenus)"></div>'
    + '<div class="pin-field"><input type="text" name="job" value="' + esc(v.job || "") + '" placeholder="Métier — ex. Développeuse, Enseignant"></div>'
    + '<div class="pin-field"><textarea name="bio" rows="3" placeholder="Deux lignes sur vous (facultatif)">' + esc(v.bio || "") + '</textarea></div>';
  let inner = "";
  if(create){
    inner = '<div class="lock-badge">✨ Premier accès</div><h1>Créez l\u2019administrateur</h1>'
      + '<p>Choisissez un compte principal pour protéger l\u2019Atelier.</p>'
      + errHtml
      + '<form method="POST" action="/admin/login">'
      + '<div class="pin-field"><input type="text" name="username" id="uI" autocomplete="username" placeholder="Nom d\u2019utilisateur" autofocus></div>'
      + '<div class="pin-field"><input type="email" name="email" id="eI" autocomplete="email" placeholder="E-mail (optionnel)"></div>'
      + '<div class="pin-field"><input type="password" name="password" id="pI" autocomplete="new-password" placeholder="Mot de passe"></div>'
      + '<div class="pin-field"><input type="password" name="password2" id="pI2" autocomplete="new-password" placeholder="Confirmez le mot de passe"></div>'
      + profileFields
      + '<div class="lock-actions"><button class="btn btn-primary" type="submit">Créer le compte</button></div></form>';
  } else if(migrate){
    inner = '<div class="lock-badge">🔒 Migration du PIN</div><h1>Créez votre compte administrateur</h1>'
      + '<p>Votre ancien code PIN sert à valider la migration vers l\u2019authentification complète.</p>'
      + errHtml
      + '<form method="POST" action="/admin/login">'
      + '<div class="pin-field"><input type="password" name="current_pin" id="cI" inputmode="numeric" autocomplete="off" placeholder="PIN actuel" autofocus></div>'
      + '<div class="pin-field"><input type="text" name="username" id="uI" autocomplete="username" placeholder="Nom d\u2019utilisateur"></div>'
      + '<div class="pin-field"><input type="email" name="email" id="eI" autocomplete="email" placeholder="E-mail (optionnel)"></div>'
      + '<div class="pin-field"><input type="password" name="password" id="pI" autocomplete="new-password" placeholder="Nouveau mot de passe"></div>'
      + '<div class="pin-field"><input type="password" name="password2" id="pI2" autocomplete="new-password" placeholder="Confirmez le mot de passe"></div>'
      + profileFields
      + '<div class="lock-actions"><button class="btn btn-primary" type="submit">Migrer et ouvrir l\u2019Atelier</button></div></form>';
  } else {
    inner = '<div class="lock-badge">🔒 Atelier</div><h1>Connexion</h1>'
      + '<p>Entrez vos identifiants pour accéder à l\u2019Atelier.</p>'
      + errHtml
      + '<form method="POST" action="/admin/login">'
      + '<div class="pin-field"><input type="text" name="identifier" id="uI" autocomplete="username" placeholder="Nom d\u2019utilisateur ou e-mail" autofocus></div>'
      + '<div class="pin-field"><input type="password" name="password" id="pI" autocomplete="current-password" placeholder="Mot de passe"></div>'
      + '<div class="lock-actions"><button class="btn btn-primary" type="submit">Se connecter</button></div></form>';
  }
  const reveal = '<div style="margin-top:14px"><button type="button" class="btn btn-ghost btn-sm btn-block" id="revealBtn">Afficher le mot de passe</button></div>';
  const script = "<script>(function(){var b=document.getElementById('revealBtn');var els=[document.getElementById('pI'),document.getElementById('pI2')].filter(Boolean);if(!b)return;b.onclick=function(){var show=els[0]&&els[0].type==='password';els.forEach(function(i){i.type=show?'text':'password';});b.textContent=show?'Masquer le mot de passe':'Afficher le mot de passe';};})();</script>";
  const body = '<div class="lock-screen"><div class="lock-card"><div class="lock-mark">' + mark + '</div>'
    + inner + reveal + '<div class="lock-foot"><a href="/">← Retour au site</a></div></div></div>' + script;
  return layout({ title: "Atelier — " + getSetting("site_name","Elle"), body });
}

function dashboardPage(){
  const arts = all("SELECT * FROM articles ORDER BY created_at DESC");
  const totalViews = arts.reduce((s, a) => s + (a.views|0), 0);
  const counts = { blog:0, project:0, podcast:0, course:0 };
  arts.forEach(a => { counts[a.type] = (counts[a.type]||0) + 1; });
  let rows = arts.map(a => {
    const ex = excerptFromBlocks(a.blocks, 120);
    const T = typeOf(a.type);
    const tags = '<span class="tag">' + esc(T.one) + '</span>'
      + (a.featured ? ' <span class="tag muted">\u2605 Vedette</span>' : '')
      + (a.status === "draft" ? ' <span class="tag muted">Brouillon</span>' : '');
    return '<div class="row" data-type="' + esc(a.type) + '" data-search="' + esc(a.title + " " + (a.category||"") + " " + ex) + '" data-views="' + (a.views|0) + '" data-created="' + a.created_at + '">'
      + '<div class="rh"><div>' + tags
      + '<h3><a href="' + itemUrl(a) + '">' + esc(a.title) + '</a></h3>'
      + '<div class="rmeta">' + (a.category ? '<span>' + esc(a.category) + '</span><span>\u00B7</span>' : '')
      + '<span class="views-pill">\uD83D\uDC41 ' + (a.views|0) + '</span><span>\u00B7</span><span class="read-pill">\u23F1 ' + fmtRead(readingSeconds(a.blocks)) + '</span><span>\u00B7</span><span>Créé le ' + fmtShort(a.created_at) + '</span><span>\u00B7</span><span>Modifié le ' + fmtShort(a.updated_at) + '</span>'
      + (a.type === "course" && a.subtype !== "authored" ? '<span>\u00B7</span><span>' + (a.progress|0) + '% termin\u00e9</span>' : '') + '</div>'
      + '</div></div><div class="ract">'
      + '<a class="btn btn-ghost btn-sm" href="/admin/edit/' + a.id + '">Modifier</a>'
      + '<a class="btn btn-ghost btn-sm" href="' + itemUrl(a) + '">Voir</a>'
      + '<button class="btn btn-danger btn-sm" data-delete="/admin/entry/delete/' + a.id + '" data-label="' + esc(a.title) + '" data-after="/admin">Supprimer</button>'
      + '</div></div>';
  }).join("");
  if(!arts.length) rows = emptyState("Aucun contenu", "Créez votre premier article, projet ou podcast.", "/admin/new/blog", "Écrire");

  const chips = '<a class="chip on" data-typefilter="all" href="#">Tous</a>'
    + '<a class="chip" data-typefilter="blog" href="#">Blog</a>'
    + '<a class="chip" data-typefilter="project" href="#">Projets</a>'
    + '<a class="chip" data-typefilter="podcast" href="#">Podcasts</a>'
    + '<a class="chip" data-typefilter="course" href="#">Cours</a>';
  const body = adminBar("dash") + '<main class="admin">'
    + '<div class="page-head"><div><h1>Tableau de bord</h1><p>' + arts.length + ' contenu' + (arts.length > 1 ? "s" : "") + ' \u00B7 ' + totalViews + ' lecture' + (totalViews > 1 ? "s" : "") + '</p></div></div>'
    + '<a class="assist-cta" href="/admin/assistant"><span class="ac-ic">\u2728</span><span class="ac-text"><strong>Assistant IA</strong><small>Trouver et structurer des idées d\u2019articles, de projets et de podcasts.</small></span><span class="ac-go">Ouvrir \u2192</span></a>'
    + '<div class="stats">'
    + '<div class="stat"><div class="n">' + (counts.blog||0) + '</div><div class="l">Articles</div></div>'
    + '<div class="stat"><div class="n">' + (counts.project||0) + '</div><div class="l">Projets</div></div>'
    + '<div class="stat"><div class="n">' + (counts.podcast||0) + '</div><div class="l">Podcasts</div></div>'
    + '<div class="stat"><div class="n">' + (counts.course||0) + '</div><div class="l">Cours</div></div>'
    + '</div>'
    + '<div class="toolbar-row" style="margin-top:12px">'
    + '<a class="btn btn-primary btn-sm" href="/admin/new/blog">+ Article</a>'
    + '<a class="btn btn-ghost btn-sm" href="/admin/new/project">+ Projet</a>'
    + '<a class="btn btn-ghost btn-sm" href="/admin/new/podcast">+ Podcast</a>'
    + '<a class="btn btn-ghost btn-sm" href="/admin/new/course">+ Cours</a>'
    + '</div>'
    + '<div class="filters" style="margin-top:8px">' + chips + '</div>'
    + '<div class="toolbar-row">'
    + '<div class="search"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><path d="M21 21l-4.3-4.3"></path></svg>'
    + '<input id="dash-search" placeholder="Rechercher\u2026"></div>'
    + '<select class="input" id="dash-sort"><option value="recent">Plus récents</option><option value="old">Plus anciens</option><option value="views">Plus lus</option></select>'
    + '</div>'
    + '<div class="toc" id="toc-list">' + rows + '</div></main>';
  return layout({ title: "Tableau de bord — Atelier", body });
}

function pagesPage(){
  const pages = all("SELECT * FROM pages ORDER BY sort,id");
  let rows = pages.map(p => '<div class="row"><div class="rh"><div>'
    + (p.in_nav ? '<span class="tag">Menu</span>' : '<span class="tag muted">Masquée</span>')
    + '<h3><a href="/p/' + esc(p.slug) + '">' + esc(p.title) + '</a></h3>'
    + '<div class="rmeta"><span>/p/' + esc(p.slug) + '</span><span>\u00B7</span><span>Modifié le ' + fmtShort(p.updated_at) + '</span></div>'
    + '</div></div><div class="ract">'
    + '<a class="btn btn-ghost btn-sm" href="/admin/pages/edit/' + p.id + '">Modifier</a>'
    + '<a class="btn btn-ghost btn-sm" href="/p/' + esc(p.slug) + '">Voir</a>'
    + '<button class="btn btn-danger btn-sm" data-delete="/admin/page/delete/' + p.id + '" data-label="' + esc(p.title) + '" data-after="/admin/pages">Supprimer</button>'
    + '</div></div>').join("");
  if(!pages.length) rows = emptyState("Aucune page", "Créez une page (À propos, Contact\u2026).", "/admin/pages/new", "Nouvelle page");
  const body = adminBar("pages") + '<main class="admin">'
    + '<div class="page-head"><div><h1>Pages</h1><p>Pages fixes du site (À propos, Contact\u2026).</p></div>'
    + '<a class="btn btn-primary" href="/admin/pages/new">+ Nouvelle page</a></div>'
    + '<div class="toc">' + rows + '</div></main>';
  return layout({ title: "Pages — Atelier", body });
}

function faqPage(saved){
  const faqs = all("SELECT * FROM faqs ORDER BY sort,id");
  const items = faqs.map(f => '<div class="card"><form method="POST" action="/admin/faq">'
    + '<input type="hidden" name="id" value="' + f.id + '">'
    + '<div class="form-row"><label>Question</label><input type="text" name="question" value="' + esc(f.question) + '"></div>'
    + '<div class="form-row"><label>Réponse</label><textarea name="answer">' + esc(f.answer) + '</textarea></div>'
    + '<div class="editor-actions"><button class="btn btn-primary btn-sm" type="submit">Enregistrer</button>'
    + '<button class="btn btn-danger btn-sm" type="button" data-delete="/admin/faq/delete/' + f.id + '" data-label="' + esc(f.question) + '" data-after="/admin/faq">Supprimer</button></div>'
    + '</form></div>').join("");
  const body = adminBar("faq") + '<main class="admin">'
    + '<div class="page-head"><div><h1>Questions</h1><p>Le bloc questions / réponses affiché sur l\u2019accueil.</p></div></div>'
    + (saved ? '<div class="banner">Enregistré.</div>' : '')
    + '<div class="card"><h2>Ajouter une question</h2><form method="POST" action="/admin/faq">'
    + '<div class="form-row"><label>Question</label><input type="text" name="question" placeholder="Une question fréquente ?"></div>'
    + '<div class="form-row"><label>Réponse</label><textarea name="answer" placeholder="La réponse\u2026 (**gras**, *italique*, [lien](url) acceptés)"></textarea></div>'
    + '<div class="editor-actions"><button class="btn btn-primary" type="submit">Ajouter</button></div></form></div>'
    + (items ? '<div class="section-eyebrow"><h2>Questions existantes</h2><span class="rule"></span></div>' + items : '')
    + '</main>';
  return layout({ title: "Questions — Atelier", body });
}

function settingsPage(saved){
  const g = (k, d) => esc(getSetting(k, d || ""));
  const themeDef = getSetting("theme_default", "light");
  const heroMode = getSetting("hero_mode", "cta");
  const keySet = !!getSetting("anthropic_api_key", "");
  const envKey = !!process.env.ANTHROPIC_API_KEY;
  const body = adminBar("settings") + '<main class="admin">'
    + '<div class="page-head"><div><h1>Réglages</h1><p>Identité, page d\u2019accueil, contact, assistant.</p></div></div>'
    + (saved ? '<div class="banner">Modifications enregistrées.</div>' : '')
    + '<form method="POST" action="/admin/settings">'

    + '<div class="card"><h2>Identité</h2>'
    + '<div class="form-row"><label>Nom du site</label><input type="text" name="site_name" value="' + g("site_name","Elle") + '"><div class="hint">L\u2019initiale forme le logo « E. ».</div></div>'
    + '<div class="form-row"><label>Accroche</label><textarea name="tagline">' + g("tagline") + '</textarea></div>'
    + '</div>'

    + '<div class="card"><h2>Page d\u2019accueil (héro)</h2>'
    + '<div class="form-row"><label>Style</label><select class="input" name="hero_mode" style="width:100%">'
    + '<option value="cta"' + (heroMode !== "split" ? " selected" : "") + '>Grand texte + bouton</option>'
    + '<option value="split"' + (heroMode === "split" ? " selected" : "") + '>Image + texte</option></select></div>'
    + '<div class="form-row"><label>Titre du héro</label><input type="text" name="hero_title" value="' + g("hero_title") + '"><div class="hint">Vide = nom du site.</div></div>'
    + '<div class="form-row"><label>Sous-titre</label><textarea name="hero_subtitle">' + g("hero_subtitle") + '</textarea><div class="hint">Vide = accroche.</div></div>'
    + '<div class="form-row"><label>Texte du bouton</label><input type="text" name="hero_cta_label" value="' + g("hero_cta_label") + '" placeholder="ex. Lire le blog"></div>'
    + '<div class="form-row"><label>Lien du bouton</label><input type="text" name="hero_cta_url" value="' + g("hero_cta_url","/blog") + '"></div>'
    + '<div class="form-row"><label>Image (style « Image + texte »)</label>'
    + '<div class="img-pick" data-uploader data-target="hero_image_input">'
    + '<img class="prev" src="' + g("hero_image") + '" alt=""' + (getSetting("hero_image","") ? "" : ' style="display:none"') + '>'
    + '<input type="file" accept="image/*" class="hidden">'
    + '<button type="button" class="btn btn-ghost btn-sm" data-pick>Choisir une image</button></div>'
    + '<input type="hidden" id="hero_image_input" name="hero_image" value="' + g("hero_image") + '"></div>'
    + '</div>'

    + '<div class="card"><h2>Contact</h2>'
    + '<div class="form-row"><label>E-mail de contact</label><input type="email" name="contact_email" value="' + g("contact_email") + '"></div>'
    + '<div class="form-row"><label>Texte de contact</label><textarea name="contact_text">' + g("contact_text") + '</textarea></div>'
    + '</div>'

    + '<div class="card"><h2>Assistant (IA)</h2>'
    + '<div class="form-row"><label>Clé API Anthropic</label><input type="password" name="anthropic_api_key" autocomplete="off" placeholder="' + (keySet ? "•••• déjà définie — laisser vide pour conserver" : "sk-ant-\u2026") + '">'
    + '<div class="hint">' + (envKey ? "Une clé est fournie par la variable d\u2019environnement (prioritaire). " : "") + 'Stockée localement. Plus sûr : variable ANTHROPIC_API_KEY.</div></div>'
    + '<div class="form-row"><label>Modèle</label><input type="text" name="assistant_model" value="' + g("assistant_model","claude-sonnet-4-6") + '"></div>'
    + '</div>'

    + '<div class="card"><h2>Pied de page & thème</h2>'
    + '<div class="form-row"><label>Texte du pied de page</label><input type="text" name="footer" value="' + g("footer") + '"></div>'
    + '<div class="form-row"><label>Thème par défaut</label><select class="input" name="theme_default" style="width:100%">'
    + '<option value="light"' + (themeDef !== "dark" ? " selected" : "") + '>Clair</option>'
    + '<option value="dark"' + (themeDef === "dark" ? " selected" : "") + '>Sombre</option></select></div>'
    + '</div>'

    + '<div class="editor-actions"><button class="btn btn-primary" type="submit">Enregistrer</button>'
    + '<a class="btn btn-ghost" href="/admin/account">🔐 Compte</a>'
    + '<a class="btn btn-ghost" href="/admin">Retour</a></div>'
    + '</form></main>';
  return layout({ title: "Réglages — Atelier", body });
}

function accountPage(saved, err, user){
  const u = user || {};
  const av = u.avatar || "";
  const body = adminBar("settings") + '<main class="admin"><div class="editor" style="max-width:560px">'
    + '<a class="back" href="/admin/settings">← Réglages</a>'
    + '<div class="page-head" style="padding-top:6px"><div><h1>Profil &amp; compte</h1>'
    + '<p>Votre surnom, votre photo et votre métier signent chaque contenu que vous publiez.</p></div></div>'
    + (saved ? '<div class="banner">' + (saved === "profile" ? "Profil mis à jour." : "Compte mis à jour.") + '</div>' : '')
    + (err ? '<div class="banner" style="background:var(--accent-soft);color:var(--accent-ink)">' + esc(err) + '</div>' : '')

    + '<form method="POST" action="/admin/profile"><div class="card">'
    + '<h2>Profil public</h2>'
    + '<div class="form-row"><label>Photo de profil</label>'
    + '<div class="avatar-pick" data-uploader data-target="avatar_input">'
    + '<img class="prev av-lg" src="' + esc(av) + '" alt=""' + (av ? "" : ' style="display:none"') + '>'
    + (av ? '' : '<span class="av-lg av-ph av-empty">+</span>')
    + '<input type="file" accept="image/*" class="hidden">'
    + '<button type="button" class="btn btn-ghost btn-sm" data-pick>' + (av ? "Remplacer la photo" : "Choisir une photo") + '</button></div>'
    + '<input type="hidden" id="avatar_input" name="avatar" value="' + esc(av) + '"></div>'
    + '<div class="form-row"><label>Surnom affiché</label><input type="text" name="display_name" value="' + esc(u.display_name || "") + '" placeholder="' + esc(u.username || "") + '">'
    + '<div class="hint">C’est ce nom qui apparaît sous chaque article et projet. Vide = « ' + esc(u.username || "") + ' ».</div></div>'
    + '<div class="form-row"><label>Métier</label><input type="text" name="job" value="' + esc(u.job || "") + '" placeholder="ex. Développeuse, Enseignant, Étudiant"></div>'
    + '<div class="form-row"><label>Bio</label><textarea name="bio" placeholder="Deux lignes sur vous (**gras**, *italique*, [lien](url) acceptés)">' + esc(u.bio || "") + '</textarea></div>'
    + '</div><div class="editor-actions"><button class="btn btn-primary" type="submit">Enregistrer le profil</button>'
    + (u.username ? '<a class="btn btn-ghost" href="/auteur/' + encodeURIComponent(u.username) + '">Voir ma page publique</a>' : '')
    + '</div></form>'

    + '<form method="POST" action="/admin/account"><div class="card">'
    + '<h2>Connexion</h2>'
    + '<div class="form-row"><label>Identifiant</label><input type="text" value="' + esc(u.username || "") + '" disabled></div>'
    + '<div class="form-row"><label>Mot de passe actuel</label><input type="password" name="current_password" autocomplete="current-password"></div>'
    + '<div class="form-row"><label>Nouveau mot de passe</label><input type="password" name="password" autocomplete="new-password"></div>'
    + '<div class="form-row"><label>Confirmer le nouveau mot de passe</label><input type="password" name="password2" autocomplete="new-password"></div>'
    + '</div><div class="editor-actions"><button class="btn btn-primary" type="submit">Changer le mot de passe</button>'
    + '<a class="btn btn-ghost" href="/admin/settings">Retour</a></div></form></div></main>';
  return layout({ title: "Profil — Atelier", body });
}

function assistantPage(){
  const hasKey = !!apiKey();
  const banner = hasKey ? "" : '<div class="banner" style="display:flex; gap:12px; align-items:center; flex-wrap:wrap; justify-content:space-between">'
    + '<span>Pour l\u2019onglet « Rapide », ajoutez une clé API Anthropic (le reste de l\u2019Atelier fonctionne sans). Au lancement, vous pouvez aussi définir ANTHROPIC_API_KEY.</span>'
    + '<a class="btn btn-primary btn-sm" href="/admin/settings">Configurer la clé \u2192</a></div>';
  const body = adminBar("assistant") + '<main class="admin">'
    + '<div class="page-head"><div><h1>Agents</h1><p>Discutez avec l\u2019assistant rapide, ou avec les agents spécialisés qui peuvent créer ou mettre à jour un brouillon eux-mêmes.</p></div></div>'
    + banner
    + '<div class="tabs" id="agentTabs">'
      + '<button type="button" data-tab="quick" class="on">Rapide</button>'
      + '<button type="button" data-tab="blog">Blog</button>'
      + '<button type="button" data-tab="notes-cours">Notes de cours</button>'
      + '<button type="button" data-tab="creation-cours">Cr\u00e9ation de cours</button>'
      + '<button type="button" data-tab="projet">Projet</button>'
    + '</div>'
    + '<div id="agent-root" data-haskey="' + (hasKey ? "1" : "0") + '"><div class="chat-intro">Chargement\u2026</div></div>'
    + '</main>';
  return layout({ title: "Agents — Atelier", body });
}

function editorPage(o){
  const kind = o.kind, doc = o.doc || {};
  const isEntry = kind === "article";
  const cancelUrl = isEntry ? "/admin" : "/admin/pages";
  const cfg = {
    kind: kind,
    saveUrl: isEntry ? "/admin/entry" : "/admin/page",
    deleteUrl: doc.id ? (isEntry ? "/admin/entry/delete/" + doc.id : "/admin/page/delete/" + doc.id) : "",
    uploadUrl: "/admin/upload",
    cancelUrl: cancelUrl,
    categories: o.categories || [],
    doc: {
      id: doc.id || null,
      title: doc.title || "",
      slug: doc.slug || "",
      type: doc.type || "blog",
      category: doc.category || "",
      cover: doc.cover || "",
      status: doc.status || "published",
      featured: doc.featured ? 1 : 0,
      subtype: doc.subtype === "authored" ? "authored" : "external",
      source_url: doc.source_url || "",
      source_platform: doc.source_platform || "",
      progress: doc.progress || 0,
      blocks: safeParse(doc.blocks),
      in_nav: (doc.in_nav === undefined ? 1 : doc.in_nav),
      show_on_index: (doc.show_on_index === undefined ? 1 : doc.show_on_index),
      created_label: doc.created_at ? fmtDate(doc.created_at) : "",
      updated_label: doc.updated_at ? fmtDate(doc.updated_at) : ""
    }
  };
  const typeName = isEntry ? typeOf(cfg.doc.type).one.toLowerCase() : "page";
  const heading = (doc.id ? "Modifier" : "Nouveau") + " — " + typeName;
  const body = adminBar(isEntry ? "dash" : "pages") + '<main class="admin">'
    + '<a class="back" href="' + cancelUrl + '">\u2190 Retour</a>'
    + '<div id="doc-editor"></div>'
    + '<script type="application/json" id="doc-data">' + jsonForScript(cfg) + '</script>'
    + '</main>';
  return layout({ title: heading + " — Atelier", body });
}

/* ------------------------------ Actions (POST) ------------------------- */
function readBody(req){
  return new Promise(resolve => {
    // On accumule des Buffers, puis on décode une seule fois : concaténer en
    // chaîne décoderait chaque morceau isolément et couperait en deux les
    // caractères accentués tombant sur une frontière de paquet.
    const chunks = []; let size = 0; let tooBig = false;
    req.on("data", c => {
      chunks.push(c); size += c.length;
      if(size > 12 * 1024 * 1024){ tooBig = true; req.destroy(); }
    });
    req.on("end", () => resolve(tooBig ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}
function parseBody(raw, ctype){
  if(raw == null) return {};
  ctype = ctype || "";
  if(ctype.indexOf("application/json") >= 0){ try { return JSON.parse(raw || "{}"); } catch(e){ return {}; } }
  const out = {}; new URLSearchParams(raw).forEach((v, k) => { out[k] = v; }); return out;
}

function authSetupMode(){
  const n = userCount();
  if(n > 0) return "login";
  return pinIsSet() ? "migrate" : "create";
}
function validatePasswordPair(password, password2){
  const p = String(password || "");
  const p2 = String(password2 || "");
  if(p.length < 8) return "Le mot de passe doit comporter au moins 8 caractères.";
  if(p !== p2) return "Les deux mots de passe ne correspondent pas.";
  return "";
}
async function handleLogin(req, res){
  const body = parseBody(await readBody(req), req.headers["content-type"]);
  const mode = authSetupMode();
  // Ce que la personne vient de saisir : réaffiché tel quel si le formulaire
  // est rejeté, pour ne pas lui faire refaire son profil (photo comprise).
  const kept = { display_name: body.display_name, job: body.job, avatar: body.avatar, bio: body.bio };
  try{
    if(mode === "create"){
      const username = cleanIdentifier(body.username);
      const email = cleanIdentifier(body.email);
      const err = validatePasswordPair(body.password, body.password2);
      if(!username) return sendHtml(res, authFormPage({ create: true, values: kept, err: "Le nom d’utilisateur est requis." }));
      if(err) return sendHtml(res, authFormPage({ create: true, values: kept, err: err }));
      const user = createUserAccount({ username: username, email: email, password: body.password, role: "admin", ...kept });
      issueAuthCookies(res, req, user);
      auditLog(user.id, "auth.create", { username: user.username }, req);
      return redirect(res, "/admin");
    }
    if(mode === "migrate"){
      const currentPin = String(body.current_pin || "").trim();
      if(!verifyPin(currentPin, getSetting("admin_pin"))) return sendHtml(res, authFormPage({ migrate: true, values: kept, err: "Le PIN actuel est incorrect." }));
      const username = cleanIdentifier(body.username);
      const email = cleanIdentifier(body.email);
      const err = validatePasswordPair(body.password, body.password2);
      if(!username) return sendHtml(res, authFormPage({ migrate: true, values: kept, err: "Le nom d’utilisateur est requis." }));
      if(err) return sendHtml(res, authFormPage({ migrate: true, values: kept, err: err }));
      const user = createUserAccount({ username: username, email: email, password: body.password, role: "admin", ...kept });
      delSetting("admin_pin");
      issueAuthCookies(res, req, user);
      auditLog(user.id, "auth.migrate_pin", { username: user.username }, req);
      return redirect(res, "/admin");
    }
    const identifier = cleanIdentifier(body.identifier || body.username || body.email);
    const password = String(body.password || "");
    const user = findUserByIdentifier(identifier);
    if(!user || !verifySecret(password, user.password_hash) || !user.is_active){
      return sendHtml(res, authFormPage({ err: "Identifiants incorrects." }));
    }
    run("UPDATE users SET last_login_at=?, updated_at=? WHERE id=?", Date.now(), Date.now(), user.id);
    issueAuthCookies(res, req, user);
    auditLog(user.id, "auth.login", { username: user.username }, req);
    return redirect(res, "/admin");
  }catch(e){
    return sendHtml(res, authFormPage({ err: String((e && e.message) || e) }));
  }
}

function saveEntryCore(fields){
  const title = String(fields.title || "").trim();
  if(!title) return { error: "Le titre est requis." };
  const type = TYPES[fields.type] ? fields.type : "blog";
  const blocks = Array.isArray(fields.blocks) ? fields.blocks : [];
  const category = String(fields.category || "").trim();
  const status = fields.status === "draft" ? "draft" : "published";
  const featured = fields.featured ? 1 : 0;
  const cover = String(fields.cover || "").trim() || null;
  const subtype = fields.subtype === "authored" ? "authored" : "external";
  const sourceUrl = String(fields.source_url || "").trim() || null;
  const sourcePlatform = String(fields.source_platform || "").trim() || null;
  const progress = Math.max(0, Math.min(100, parseInt(fields.progress, 10) || 0));
  const base = slugify(fields.slug || title);
  const now = Date.now();
  // Signature automatique : l'auteur est celui qui écrit, jamais un champ à
  // remplir. À la mise à jour, la paternité d'origine ne change pas.
  const authorId = fields.author_id ? parseInt(fields.author_id, 10) : null;
  if(fields.id){
    const ex = get("SELECT * FROM articles WHERE id=?", fields.id);
    if(!ex) return { error: "Introuvable.", notFound: true };
    const slug = uniqueSlug("articles", base, ex.id);
    run("UPDATE articles SET slug=?, title=?, type=?, category=?, cover=?, blocks=?, status=?, featured=?, subtype=?, source_url=?, source_platform=?, progress=?, author_id=?, updated_at=? WHERE id=?",
      slug, title, type, category, cover, JSON.stringify(blocks), status, featured, subtype, sourceUrl, sourcePlatform, progress,
      ex.author_id || authorId || null, now, ex.id);
    return { ok: true, id: ex.id, slug: slug, type: type };
  }
  const slug = uniqueSlug("articles", base, null);
  const info = run("INSERT INTO articles(slug,title,type,category,cover,blocks,status,featured,views,created_at,updated_at,subtype,source_url,source_platform,progress,author_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    slug, title, type, category, cover, JSON.stringify(blocks), status, featured, 0, now, now, subtype, sourceUrl, sourcePlatform, progress,
    authorId || null);
  return { ok: true, id: Number(info.lastInsertRowid), slug: slug, type: type };
}

async function handleEntrySave(req, res){
  const user = currentUser(req, res);
  const body = parseBody(await readBody(req), req.headers["content-type"]);
  body.author_id = user ? user.id : null;   // jamais dicté par le client
  const result = saveEntryCore(body);
  if(result.error) return sendJson(res, { error: result.error }, result.notFound ? 404 : 400);
  return sendJson(res, { ok: true, id: result.id, slug: result.slug, viewUrl: "/admin" });
}

/* Réglages, pages fixes et questions — les trois formulaires de l'Atelier. */
const SETTING_KEYS = [
  "site_name", "tagline", "footer", "contact_text", "contact_email", "theme_default",
  "hero_mode", "hero_title", "hero_subtitle", "hero_cta_label", "hero_cta_url", "hero_image",
  "assistant_model"
];
async function handleSettingsSave(req, res){
  const body = parseBody(await readBody(req), req.headers["content-type"]);
  for(const k of SETTING_KEYS){
    if(Object.prototype.hasOwnProperty.call(body, k)) setSetting(k, String(body[k] == null ? "" : body[k]).trim());
  }
  // Une clé laissée vide conserve celle déjà enregistrée (le champ n'affiche
  // jamais la valeur existante).
  const key = String(body.anthropic_api_key || "").trim();
  if(key) setSetting("anthropic_api_key", key);
  return redirect(res, "/admin/settings?saved=1");
}

function savePageCore(fields){
  const title = String(fields.title || "").trim();
  if(!title) return { error: "Le titre est requis." };
  const blocks = Array.isArray(fields.blocks) ? fields.blocks : [];
  const inNav = fields.in_nav ? 1 : 0;
  const onIndex = fields.show_on_index ? 1 : 0;
  const base = slugify(fields.slug || title);
  const now = Date.now();
  if(fields.id){
    const ex = get("SELECT * FROM pages WHERE id=?", fields.id);
    if(!ex) return { error: "Introuvable.", notFound: true };
    const slug = uniqueSlug("pages", base, ex.id);
    run("UPDATE pages SET slug=?, title=?, blocks=?, in_nav=?, show_on_index=?, updated_at=? WHERE id=?",
      slug, title, JSON.stringify(blocks), inNav, onIndex, now, ex.id);
    return { ok: true, id: ex.id, slug: slug };
  }
  const slug = uniqueSlug("pages", base, null);
  const info = run("INSERT INTO pages(slug,title,blocks,in_nav,show_on_index,sort,updated_at) VALUES(?,?,?,?,?,?,?)",
    slug, title, JSON.stringify(blocks), inNav, onIndex, 0, now);
  return { ok: true, id: Number(info.lastInsertRowid), slug: slug };
}
async function handlePageSave(req, res){
  const body = parseBody(await readBody(req), req.headers["content-type"]);
  const result = savePageCore(body);
  if(result.error) return sendJson(res, { error: result.error }, result.notFound ? 404 : 400);
  return sendJson(res, { ok: true, id: result.id, slug: result.slug, viewUrl: "/admin/pages" });
}

async function handleFaqSave(req, res){
  const body = parseBody(await readBody(req), req.headers["content-type"]);
  const question = String(body.question || "").trim();
  const answer = String(body.answer || "").trim();
  if(!question) return redirect(res, "/admin/faq");
  const now = Date.now();
  if(body.id){
    run("UPDATE faqs SET question=?, answer=?, updated_at=? WHERE id=?", question, answer, now, parseInt(body.id, 10));
  } else {
    const last = get("SELECT MAX(sort) AS s FROM faqs");
    run("INSERT INTO faqs(question,answer,sort,updated_at) VALUES(?,?,?,?)", question, answer, ((last && last.s) | 0) + 1, now);
  }
  return redirect(res, "/admin/faq?saved=1");
}

function agentToken(){ return (process.env.ELLE_AGENT_TOKEN || "").trim(); }
function validAgentToken(req){
  const expected = agentToken();
  if(!expected) return false;
  const auth = String((req.headers && req.headers.authorization) || "").trim();
  const provided = auth.indexOf("Bearer ") === 0 ? auth.slice(7).trim() : "";
  if(!provided) return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function handleAgentDraft(req, res){
  if(!agentToken()) return sendJson(res, { ok:false, error: "ELLE_AGENT_TOKEN n\u2019est pas configur\u00e9 sur le serveur." }, 501);
  if(!validAgentToken(req)) return sendJson(res, { ok:false, error: "unauthorized" }, 401);
  const body = parseBody(await readBody(req), req.headers["content-type"]);
  if(body.id){
    // Mise à jour d'un contenu existant : un agent ne change jamais le statut,
    // qu'il ait déjà été publié ou non. Seule une personne publie ou dépublie.
    const existing = get("SELECT status FROM articles WHERE id=?", body.id);
    if(!existing) return sendJson(res, { ok:false, error: "Introuvable." }, 404);
    body.status = existing.status;
  } else {
    // Nouvelle création : toujours en brouillon, jamais publié directement.
    body.status = "draft";
  }
  // Un agent n'a pas de compte : le brouillon reste non signé jusqu'à ce
  // qu'une personne l'ouvre et l'enregistre — elle en devient l'auteur.
  body.author_id = null;
  const result = saveEntryCore(body);
  if(result.error) return sendJson(res, { ok:false, error: result.error }, result.notFound ? 404 : 400);
  auditLog(null, "agent.save_draft", { type: result.type, title: String(body.title||"").trim(), slug: result.slug, updated: !!body.id }, req);
  return sendJson(res, { ok: true, id: result.id, slug: result.slug, viewUrl: "/admin" });
}

function listContentForAgent(params){
  const type = TYPES[params.type] ? params.type : null;
  const status = (params.status === "draft" || params.status === "published") ? params.status : null;
  const limit = Math.max(1, Math.min(50, parseInt(params.limit, 10) || 20));
  let sql = "SELECT id,slug,title,type,category,status,subtype,source_platform,progress,featured,views,created_at,updated_at FROM articles WHERE 1=1";
  const args = [];
  if(type){ sql += " AND type=?"; args.push(type); }
  if(status){ sql += " AND status=?"; args.push(status); }
  sql += " ORDER BY created_at DESC LIMIT ?"; args.push(limit);
  return all(sql, ...args);
}
function getContentForAgent(slug){
  const a = get("SELECT * FROM articles WHERE slug=?", slug);
  if(!a) return null;
  return {
    id: a.id, slug: a.slug, title: a.title, type: a.type, category: a.category, status: a.status,
    subtype: a.subtype, source_url: a.source_url, source_platform: a.source_platform, progress: a.progress,
    featured: !!a.featured, views: a.views, blocks: safeParse(a.blocks),
    created_at: a.created_at, updated_at: a.updated_at
  };
}
function searchContentForAgent(q, limitRaw){
  q = String(q||"").trim();
  if(!q) return [];
  const limit = Math.max(1, Math.min(50, parseInt(limitRaw, 10) || 20));
  const likeEsc = q.replace(/[%_]/g, c => "\\"+c);
  const like = "%" + likeEsc + "%";
  return all("SELECT id,slug,title,type,category,status FROM articles WHERE (title LIKE ? ESCAPE '\\' OR blocks LIKE ? ESCAPE '\\') ORDER BY created_at DESC LIMIT ?", like, like, limit);
}
async function handleAgentContentList(req, res, u){
  if(!agentToken()) return sendJson(res, { ok:false, error: "ELLE_AGENT_TOKEN n\u2019est pas configur\u00e9 sur le serveur." }, 501);
  if(!validAgentToken(req)) return sendJson(res, { ok:false, error: "unauthorized" }, 401);
  const items = listContentForAgent({ type: u.searchParams.get("type"), status: u.searchParams.get("status"), limit: u.searchParams.get("limit") });
  return sendJson(res, { ok: true, items });
}
async function handleAgentContentGet(req, res, slug){
  if(!agentToken()) return sendJson(res, { ok:false, error: "ELLE_AGENT_TOKEN n\u2019est pas configur\u00e9 sur le serveur." }, 501);
  if(!validAgentToken(req)) return sendJson(res, { ok:false, error: "unauthorized" }, 401);
  const item = getContentForAgent(slug);
  if(!item) return sendJson(res, { ok:false, error: "Introuvable." }, 404);
  return sendJson(res, { ok: true, item });
}
async function handleAgentSearch(req, res, u){
  if(!agentToken()) return sendJson(res, { ok:false, error: "ELLE_AGENT_TOKEN n\u2019est pas configur\u00e9 sur le serveur." }, 501);
  if(!validAgentToken(req)) return sendJson(res, { ok:false, error: "unauthorized" }, 401);
  const items = searchContentForAgent(u.searchParams.get("q"), u.searchParams.get("limit"));
  return sendJson(res, { ok: true, items });
}

async function handleProfileSave(req, res){
  const user = currentUser(req, res);
  if(!user) return sendHtml(res, authFormPage({ err: "Connexion requise." }));
  const body = parseBody(await readBody(req), req.headers["content-type"]);
  updateUserProfile(user.id, body);
  auditLog(user.id, "profile.update", { username: user.username }, req);
  return redirect(res, "/admin/account?saved=profile");
}

async function handleAccountChange(req, res){
  const user = currentUser(req, res);
  if(!user) return sendHtml(res, authFormPage({ err: "Connexion requise." }));
  const body = parseBody(await readBody(req), req.headers["content-type"]);
  const currentPassword = String(body.current_password || "").trim();
  const password = String(body.password || "").trim();
  const password2 = String(body.password2 || "").trim();
  if(!verifySecret(currentPassword, user.password_hash)) return sendHtml(res, accountPage(false, "Le mot de passe actuel est incorrect.", user));
  const err = validatePasswordPair(password, password2);
  if(err) return sendHtml(res, accountPage(false, err, user));
  updateUserPassword(user.id, password);
  revokeAllRefreshTokensForUser(user.id);
  const fresh = get("SELECT * FROM users WHERE id=?", user.id);
  issueAuthCookies(res, req, fresh);
  auditLog(user.id, "auth.change_password", { username: user.username }, req);
  return redirect(res, "/admin/account?saved=1");
}

async function handleUpload(req, res){
  const body = parseBody(await readBody(req), req.headers["content-type"]);
  const m = /^data:([\w\/+.-]+);base64,(.*)$/s.exec(String(body.dataUrl || ""));
  if(!m) return sendJson(res, { error: "Image invalide." }, 400);
  const buf = Buffer.from(m[2], "base64");
  if(buf.length > 8 * 1024 * 1024) return sendJson(res, { error: "Image trop lourde (max 8 Mo)." }, 400);
  const extMap = { "image/png":".png", "image/jpeg":".jpg", "image/jpg":".jpg", "image/gif":".gif", "image/webp":".webp", "image/svg+xml":".svg" };
  const ext = extMap[m[1]] || ".bin";
  const fname = crypto.createHash("sha1").update(buf).digest("hex").slice(0, 16) + ext;
  try { fs.writeFileSync(path.join(UPLOAD_DIR, fname), buf); }
  catch(e){ return sendJson(res, { error: "Écriture impossible." }, 500); }
  return sendJson(res, { url: "/uploads/" + fname });
}

async function handleAssistantChat(req, res){
  const key = apiKey();
  if(!key) return sendJson(res, { error: "no_key" });
  const body = parseBody(await readBody(req), req.headers["content-type"]);
  const msgs = (Array.isArray(body.messages) ? body.messages : [])
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map(m => ({ role: m.role, content: m.content }))
    .slice(-20);
  if(!msgs.length) return sendJson(res, { error: "empty" });
  const model = getSetting("assistant_model", "") || "claude-sonnet-4-6";
  const site = getSetting("site_name", "Elle");
  const system = "Tu es l'assistant éditorial du blog personnel « " + site + " ». Tu aides à trouver, affiner et structurer des idées d'articles de blog, de projets et d'épisodes de podcast. Réponds toujours en français, de façon concise, concrète et actionnable. Quand on te demande de structurer un contenu, propose un titre accrocheur, un angle clair, puis un plan en sections avec des puces. Utilise le Markdown (titres ##, listes avec -, **gras**).";
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: model, max_tokens: 1024, system: system, messages: msgs })
    });
    const data = await r.json().catch(() => ({}));
    if(!r.ok){ return sendJson(res, { error: "api", detail: (data && data.error && data.error.message) || ("HTTP " + r.status) }); }
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    return sendJson(res, { reply: text || "(réponse vide)" });
  } catch(e){
    return sendJson(res, { error: "network", detail: String((e && e.message) || e) });
  }
}

const AGENT_KEYS = ["blog", "notes-cours", "creation-cours", "projet"];
function agentsBaseUrl(){ return (process.env.ELLE_AGENTS_URL || "http://localhost:8001").replace(/\/+$/, ""); }
async function handleAgentProxyChat(req, res, agentKey){
  if(AGENT_KEYS.indexOf(agentKey) < 0) return sendJson(res, { error: "Agent inconnu." }, 404);
  const body = parseBody(await readBody(req), req.headers["content-type"]);
  const message = String(body.message || "").trim();
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const history = Array.isArray(body.history) ? body.history : [];
  if(!message && !attachments.length) return sendJson(res, { error: "empty" }, 400);
  const base = agentsBaseUrl();

  // Propage une annulation navigateur (bouton Stop) jusqu'à elle-agents :
  // si la connexion entrante se ferme avant la fin, on annule notre propre
  // appel sortant, pour qu'elle-agents la détecte à son tour et arrête
  // réellement la génération en cours (voir main.py, _watch_disconnect).
  const controller = new AbortController();
  const onClientClose = () => controller.abort();
  res.on("close", onClientClose);

  try {
    const r = await fetch(base + "/agents/" + agentKey + "/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: message, session_id: body.session_id || null, attachments: attachments, history: history }),
      signal: controller.signal
    });
    const data = await r.json().catch(() => ({}));
    if(!r.ok) return sendJson(res, { error: "api", detail: (data && data.detail) || ("HTTP " + r.status) }, r.status);
    return sendJson(res, data);
  } catch(e){
    if(e && e.name === "AbortError") return; // client déjà parti : rien à renvoyer
    return sendJson(res, { error: "network", detail: "Service agents injoignable sur " + base + ". Est-il lancé ? (" + String((e && e.message) || e) + ")" }, 502);
  } finally {
    res.removeListener("close", onClientClose);
  }
}

async function handleAgentProxyRemark(req, res, agentKey){
  if(AGENT_KEYS.indexOf(agentKey) < 0) return sendJson(res, { error: "Agent inconnu." }, 404);
  const body = parseBody(await readBody(req), req.headers["content-type"]);
  const targetBlock = body.target_block && typeof body.target_block === "object" ? body.target_block : null;
  const remark = String(body.remark || "").trim();
  if(!targetBlock || !targetBlock.id || !targetBlock.type) return sendJson(res, { error: "bad_request", detail: "target_block invalide (id/type requis)." }, 400);
  if(!remark) return sendJson(res, { error: "bad_request", detail: "remark requis." }, 400);
  const base = agentsBaseUrl();

  const controller = new AbortController();
  const onClientClose = () => controller.abort();
  res.on("close", onClientClose);

  try {
    const r = await fetch(base + "/agents/" + agentKey + "/remark", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_block: targetBlock, remark: remark, session_id: body.session_id || null }),
      signal: controller.signal
    });
    const data = await r.json().catch(() => ({}));
    if(!r.ok) return sendJson(res, { error: "api", detail: (data && data.detail) || ("HTTP " + r.status) }, r.status);
    return sendJson(res, data);
  } catch(e){
    if(e && e.name === "AbortError") return;
    return sendJson(res, { error: "network", detail: "Service agents injoignable sur " + base + ". Est-il lancé ? (" + String((e && e.message) || e) + ")" }, 502);
  } finally {
    res.removeListener("close", onClientClose);
  }
}

async function handleAuthApi(req, res, pathn, method){
  if(pathn === "/api/auth/login" && method === "POST"){
    const body = parseBody(await readBody(req), req.headers["content-type"]);
    const mode = authSetupMode();
    try{
      if(mode === "create"){
        const username = cleanIdentifier(body.username);
        const email = cleanIdentifier(body.email);
        const err = validatePasswordPair(body.password, body.password2);
        if(!username) return sendJson(res, { ok:false, error:"Le nom d’utilisateur est requis." }, 400);
        if(err) return sendJson(res, { ok:false, error:err }, 400);
        const user = createUserAccount({ username: username, email: email, password: body.password, role: "admin" });
        issueAuthCookies(res, req, user);
        auditLog(user.id, "auth.create", { username: user.username }, req);
        return sendJson(res, { ok:true, user: publicUser(user), created:true });
      }
      if(mode === "migrate"){
        const currentPin = String(body.current_pin || "").trim();
        if(!verifyPin(currentPin, getSetting("admin_pin"))) return sendJson(res, { ok:false, error:"Le PIN actuel est incorrect." }, 400);
        const username = cleanIdentifier(body.username);
        const email = cleanIdentifier(body.email);
        const err = validatePasswordPair(body.password, body.password2);
        if(!username) return sendJson(res, { ok:false, error:"Le nom d’utilisateur est requis." }, 400);
        if(err) return sendJson(res, { ok:false, error:err }, 400);
        const user = createUserAccount({ username: username, email: email, password: body.password, role: "admin" });
        delSetting("admin_pin");
        issueAuthCookies(res, req, user);
        auditLog(user.id, "auth.migrate_pin", { username: user.username }, req);
        return sendJson(res, { ok:true, user: publicUser(user), migrated:true });
      }
      const identifier = cleanIdentifier(body.identifier || body.username || body.email);
      const password = String(body.password || "");
      const user = findUserByIdentifier(identifier);
      if(!user || !verifySecret(password, user.password_hash) || !user.is_active){
        return sendJson(res, { ok:false, error:"Identifiants incorrects." }, 401);
      }
      run("UPDATE users SET last_login_at=?, updated_at=? WHERE id=?", Date.now(), Date.now(), user.id);
      issueAuthCookies(res, req, user);
      auditLog(user.id, "auth.login", { username: user.username }, req);
      return sendJson(res, { ok:true, user: publicUser(user) });
    }catch(e){
      return sendJson(res, { ok:false, error:String((e && e.message) || e) }, 400);
    }
  }

  if(pathn === "/api/auth/me" && method === "GET"){
    const user = currentUser(req, res);
    if(!user) return sendJson(res, { ok:false, error:"unauthorized" }, 401);
    return sendJson(res, { ok:true, user: publicUser(user) });
  }

  if(pathn === "/api/auth/refresh" && method === "POST"){
    const body = parseBody(await readBody(req), req.headers["content-type"]);
    const token = String(body.refresh_token || parseCookies(req)[AUTH_REFRESH_COOKIE] || "").trim();
    const session = findRefreshSession(token);
    if(!session) return sendJson(res, { ok:false, error:"unauthorized" }, 401);
    const newRefresh = createRefreshToken(session.user.id, req);
    revokeRefreshTokenById(session.row.id);
    setAuthCookies(res, signAccessToken(session.user), newRefresh);
    auditLog(session.user.id, "auth.refresh", { username: session.user.username }, req);
    return sendJson(res, { ok:true, user: publicUser(session.user) });
  }

  if(pathn === "/api/auth/logout" && method === "POST"){
    const cookies = parseCookies(req);
    const rt = cookies[AUTH_REFRESH_COOKIE];
    const session = findRefreshSession(rt);
    if(session) revokeRefreshTokenById(session.row.id);
    clearAuthCookies(res);
    if(session) auditLog(session.user.id, "auth.logout", { username: session.user.username }, req);
    return sendJson(res, { ok:true });
  }

  if(pathn === "/api/auth/change-password" && method === "PUT"){
    const user = currentUser(req, res);
    if(!user) return sendJson(res, { ok:false, error:"unauthorized" }, 401);
    const body = parseBody(await readBody(req), req.headers["content-type"]);
    const currentPassword = String(body.current_password || "").trim();
    const err = validatePasswordPair(body.password, body.password2);
    if(!verifySecret(currentPassword, user.password_hash)) return sendJson(res, { ok:false, error:"Le mot de passe actuel est incorrect." }, 400);
    if(err) return sendJson(res, { ok:false, error:err }, 400);
    updateUserPassword(user.id, body.password);
    revokeAllRefreshTokensForUser(user.id);
    const fresh = get("SELECT * FROM users WHERE id=?", user.id);
    issueAuthCookies(res, req, fresh);
    auditLog(user.id, "auth.change_password", { username: user.username }, req);
    return sendJson(res, { ok:true, user: publicUser(fresh) });
  }

  return sendJson(res, { ok:false, error:"not_found" }, 404);
}

/* ------------------------------ Communauté publique --------------------- */
// L'Atelier est réservé aux administrateurs. Le reste des comptes (« visitor »,
// créés depuis /inscription) alimentent l'espace publique Contribuer : ils ne
// touchent jamais ni aux contenus éditoriaux ni aux réglages.

const SUBMISSION_KINDS = {
  idea:       { label: "Idée",        glyph: "\uD83D\uDCA1" },
  bug:        { label: "Bug / souci", glyph: "\uD83D\uDCA5" },
  suggestion: { label: "Suggestion",  glyph: "\u2728" },
  question:   { label: "Question",    glyph: "\u2753" },
  other:      { label: "Autre",       glyph: "\uD83D\uDCDD" }
};
function submissionKindLabel(kind){ const k = SUBMISSION_KINDS[kind]; return k ? k : SUBMISSION_KINDS.other; }
function submissionStatusLabel(s){ return s === "resolved" ? "Résolue" : s === "rejected" ? "Écartée" : "Ouverte"; }
function submissionStatusClass(s){ return s === "resolved" ? "resolved" : s === "rejected" ? "rejected" : "open"; }
function submissionUser(s){ return s && s.user_id ? authorById(s.user_id) : null; }

function clearAuthAndRedirect(res, req, loc){
  const cookies = parseCookies(req);
  const session = findRefreshSession(cookies[AUTH_REFRESH_COOKIE]);
  if(session) revokeRefreshTokenById(session.row.id);
  clearAuthCookies(res);
  if(session) auditLog(session.user.id, "auth.logout", { username: session.user.username }, req);
  return redirect(res, loc);
}

function publicAuthPage(mode, sp, err){
  const name = getSetting("site_name", "Elle");
  const isRegister = mode === "register";
  const errHtml = err ? '<div class="pin-err">' + esc(err) + '</div>' : '<div class="pin-err"></div>';
  const back = (sp && String(sp.get("back")||"").length > 1 && String(sp.get("back")).indexOf("//") < 0) ? String(sp.get("back")) : "/contribuer";
  const inner = isRegister
    ? '<div class="lock-badge">\u2728 Rejoindre la communauté</div><h1>Créez votre compte</h1>'
      + '<p>Pour déposer une idée, signaler un bug ou participer, il suffit d\u2019un petit compte \u2014 gratuit, sans engagement.</p>'
      + errHtml
      + '<form method="POST" action="/inscription">'
      + '<div class="pin-field"><input type="text" name="username" autocomplete="username" placeholder="Nom d\u2019utilisateur" required autofocus></div>'
      + '<div class="pin-field"><input type="email" name="email" autocomplete="email" placeholder="E-mail (optionnel)"></div>'
      + '<div class="pin-field"><input type="password" name="password" autocomplete="new-password" placeholder="Mot de passe (8 caractères min.)" required></div>'
      + '<div class="pin-field"><input type="password" name="password2" autocomplete="new-password" placeholder="Confirmez le mot de passe" required></div>'
      + '<div class="lock-actions"><button class="btn btn-primary btn-block" type="submit">Créer mon compte \u2192</button></div></form>'
      + '<div class="lock-alt">Déjà inscrit·e\u00a0? <a href="/connexion">Se connecter</a></div>'
    : '<div class="lock-badge">\uD83D\uDD12 Espace membres</div><h1>Connexion</h1>'
      + '<p>Retrouvez vos contributions et continuez à construire ensemble.</p>'
      + errHtml
      + '<form method="POST" action="/connexion">'
      + '<div class="pin-field"><input type="text" name="identifier" autocomplete="username" placeholder="Nom d\u2019utilisateur ou e-mail" required autofocus></div>'
      + '<div class="pin-field"><input type="password" name="password" autocomplete="current-password" placeholder="Mot de passe" required></div>'
      + '<div class="lock-actions"><button class="btn btn-primary btn-block" type="submit">Se connecter \u2192</button></div></form>'
      + '<div class="lock-alt">Pas encore de compte\u00a0? <a href="/inscription">S\u2019inscrire</a></div>';
  const body = publicHeader("", null) + '<div class="lock-screen">'
    + '<div class="lock-card"><div class="lock-mark">' + brandMark(name) + '</div>' + inner
    + '<div class="lock-foot"><a href="' + esc(back) + '">\u2190 Retour</a> \u00B7 <a href="/">Accueil</a></div></div></div>';
  return layout({ title: (isRegister ? "Inscription" : "Connexion") + " \u2014 " + name, body });
}

async function handlePublicLogin(req, res, sp){
  const body = parseBody(await readBody(req), req.headers["content-type"]);
  const identifier = cleanIdentifier(body.identifier || body.username || body.email);
  const password = String(body.password || "");
  if(!identifier || !password) return sendHtml(res, publicAuthPage("login", sp, "Renseignez vos identifiants."), 400);
  const user = findUserByIdentifier(identifier);
  if(!user || !verifySecret(password, user.password_hash) || !user.is_active){
    return sendHtml(res, publicAuthPage("login", sp, "Identifiants incorrects."), 401);
  }
  run("UPDATE users SET last_login_at=?, updated_at=? WHERE id=?", Date.now(), Date.now(), user.id);
  issueAuthCookies(res, req, user);
  auditLog(user.id, "auth.login", { username: user.username, via: "public" }, req);
  const back = String(body.back || "/contribuer");
  return redirect(res, back && back.indexOf("//") < 0 && back.length > 1 ? back : "/contribuer");
}

async function handlePublicRegister(req, res, sp){
  const body = parseBody(await readBody(req), req.headers["content-type"]);
  const kept = { username: body.username, email: body.email };
  try{
    const username = cleanIdentifier(body.username);
    const email = cleanIdentifier(body.email);
    const err = validatePasswordPair(body.password, body.password2);
    if(!username) return sendHtml(res, publicAuthPage("register", sp, "Le nom d\u2019utilisateur est requis."), 400);
    if(err) return sendHtml(res, publicAuthPage("register", sp, err), 400);
    const user = createUserAccount({ username: username, email: email, password: body.password, role: "visitor" });
    issueAuthCookies(res, req, user);
    auditLog(user.id, "auth.register", { username: user.username }, req);
    return redirect(res, "/contribuer");
  }catch(e){
    return sendHtml(res, publicAuthPage("register", sp, String((e && e.message) || e)), 400);
  }
}

async function handleContact(req, res){
  const body = parseBody(await readBody(req), req.headers["content-type"]);
  const me = currentUser(req, res);
  const name = cleanIdentifier(body.name).slice(0, 120);
  const email = cleanIdentifier(body.email).slice(0, 200);
  const subject = cleanIdentifier(body.subject).slice(0, 160);
  const msg = cleanIdentifier(body.body).slice(0, 8000);
  if(!name || !msg){ return sendHtml(res, contactPageBody(pFor("contact"), me, false, "Nom et message sont requis."), 400); }
  run("INSERT INTO contact_messages(name,email,subject,body,created_at,user_id) VALUES(?,?,?,?,?,?)",
    name, email || null, subject || null, msg, Date.now(), me ? me.id : null);
  auditLog(me ? me.id : null, "contact.submit", { subject: subject || "", name: name }, req);
  return redirect(res, "/p/contact?sent=1");
}
function pFor(slug){ const p = get("SELECT * FROM pages WHERE slug=?", slug); return p || { slug: slug, title: slug, blocks: "[]" }; }

/* ---- Espace Contribuer (public) ---- */
function submissionCard(s, i){
  const u = submissionUser(s);
  const k = submissionKindLabel(s.kind);
  const statusLbl = submissionStatusLabel(s.status);
  return '<div class="sub-card">'
    + '<div class="sub-top"><span class="sub-kind sub-kind-' + esc(s.kind) + '">' + k.glyph + ' ' + esc(k.label) + '</span>'
    + '<span class="sub-status sub-status-' + submissionStatusClass(s.status) + '">' + esc(statusLbl) + '</span></div>'
    + '<h3>' + esc(s.title) + '</h3>'
    + '<p>' + inlineFmt(String(s.body || "").slice(0, 240)) + '</p>'
    + '<div class="sub-foot">' + (u ? '<span class="byline-mini">' + avatarHtml(u, "xs") + '<span>' + esc(authorName(u)) + '</span></span>' : '<span class="byline-mini"><span>Anonyme</span></span>')
    + '<span class="sub-date">' + fmtDate(s.created_at) + '</span></div></div>';
}
function renderContribuer(me){
  const name = getSetting("site_name", "Elle");
  const items = all("SELECT * FROM submissions ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'resolved' THEN 1 ELSE 2 END, created_at DESC LIMIT 60");
  const opened = items.filter(s => s.status === "open").length;
  const body = publicHeader("contribute", me) + '<main class="wide">'
    + '<section class="contrib-hero">'
    + '<div class="eyebrow">' + esc(name) + ' \u2014 id\u00e9es & bugs</div>'
    + '<h1>Construisons<br>ensemble.</h1>'
    + '<p class="tagline">Une id\u00e9e\u00a0? Un bug\u00a0? Une envie\u00a0? Partagez-la ici, elle nourrit ce que nous fabriquons.</p>'
    + (me
        ? '<div class="contrib-cta"><a class="btn btn-primary btn-lg" href="/contribuer/nouveau">+ Proposer ici</a>'
          + '<a class="btn btn-ghost btn-lg" href="/contribuer/mes-idees">Mes contributions \u2192</a></div>'
        : '<div class="contrib-cta"><a class="btn btn-primary btn-lg" href="/contribuer/nouveau">Proposer ici \u2192</a>'
          + '<span class="hint">La proposition demande un petit compte \u2014 <a href="/inscription?back=/contribuer">s\u2019inscrire</a> ou <a href="/connexion?back=/contribuer">se connecter</a>.</span></div>')
    + '<div class="lp-stats">' + statChip(items.length, " contribution" + (items.length > 1 ? "s" : "")) + statChip(opened, " ouverte" + (opened > 1 ? "s" : ""), 1) + '</div>'
    + '</section>'
    + (items.length
        ? '<div class="sub-grid">' + items.map(submissionCard).join("") + '</div>'
        : emptyState("Aucune contribution", "Soyez le·la premier·e \u00e0 lancer une id\u00e9e ou \u00e0 signaler un souci.", "/contribuer/nouveau", "Proposer"))
    + '</main>' + publicFooter();
  return layout({ title: "Contribuer \u2014 " + name, body });
}

function renderSubmitForm(me, err, keptVals){
  keptVals = keptVals || {};
  const name = getSetting("site_name", "Elle");
  const kindOpts = Object.keys(SUBMISSION_KINDS).map(k => {
    const o = SUBMISSION_KINDS[k];
    return '<option value="' + k + '"' + (keptVals.kind === k ? " selected" : "") + '>' + o.glyph + ' ' + o.label + '</option>';
  }).join("");
  const errHtml = err ? '<div class="banner" style="background:var(--accent-soft);color:var(--accent-ink)">' + esc(err) + '</div>' : "";
  const body = publicHeader("contribute", me) + '<main class="wrap">'
    + '<a class="back" href="/contribuer">\u2190 Toutes les contributions</a>'
    + '<section class="submit-form">'
    + '<div class="eyebrow">' + esc(name) + ' \u2014 contribuer</div>'
    + '<h1>Proposer quelque chose</h1>'
    + '<p class="tagline">D\u00e9crivez votre id\u00e9e, le bug rencontr\u00e9 ou la suggestion. Tout reste public et mod\u00e9r\u00e9 avec bienveillance.</p>'
    + errHtml
    + '<form method="POST" action="/contribuer">'
    + '<div class="field"><label>Quel genre\u00a0:</label><select name="kind" class="input">' + kindOpts + '</select></div>'
    + '<div class="field"><label>Titre</label><input type="text" name="title" required maxlength="120" value="' + esc(keptVals.title||"") + '" placeholder="Un titre clair, court\u2026"></div>'
    + '<div class="field"><label>Description</label><textarea name="body" rows="7" required placeholder="D\u00e9veloppez : le contexte, ce que vous imaginez, ce qui coince\u2026">' + esc(keptVals.body||"") + '</textarea></div>'
    + '<div class="field"><label>Un moyen de vous joindre (facultatif)</label><input type="text" name="contact" maxlength="200" value="' + esc(keptVals.contact||"") + '" placeholder="E-mail, pseudo r\u00e9seau\u2026"></div>'
    + '<button class="btn btn-primary" type="submit">Publier la contribution \u2192</button></form>'
    + '</section></main>' + publicFooter();
  return layout({ title: "Proposer \u2014 " + name, body });
}

async function handleSubmitCreate(req, res){
  const me = currentUser(req, res);
  if(!me) return redirect(res, "/connexion?back=/contribuer/nouveau");
  const body = parseBody(await readBody(req), req.headers["content-type"]);
  const kind = SUBMISSION_KINDS[body.kind] ? body.kind : "idea";
  const title = cleanIdentifier(body.title).slice(0, 160);
  const text = String(body.body || "").trim().slice(0, 8000);
  const contact = cleanIdentifier(body.contact).slice(0, 200);
  if(!title) return sendHtml(res, renderSubmitForm(me, "Le titre est requis.", body));
  if(!text) return sendHtml(res, renderSubmitForm(me, "D\u00e9crivez un peu plus la chose.", body));
  run("INSERT INTO submissions(user_id,kind,title,body,contact,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
    me.id, kind, title, text, contact || null, "open", Date.now(), Date.now());
  auditLog(me.id, "submission.create", { kind: kind, title: title }, req);
  return redirect(res, "/contribuer/mes-idees");
}

function renderMySubmissions(me, msg){
  const name = getSetting("site_name", "Elle");
  const mine = all("SELECT * FROM submissions WHERE user_id=? ORDER BY created_at DESC", me.id);
  const rows = mine.length ? mine.map(s => {
    const k = submissionKindLabel(s.kind);
    return '<div class="row"><div class="rh"><div>'
      + '<span class="tag">' + esc(k.label) + '</span>'
      + ' <span class="tag ' + submissionStatusClass(s.status) + '-tag">' + esc(submissionStatusLabel(s.status)) + '</span>'
      + '<h3><a href="/contribuer">' + esc(s.title) + '</a></h3>'
      + '<div class="rmeta"><span>Publié le ' + fmtShort(s.created_at) + '</span></div></div></div>'
      + '<div class="ract">'
      + (s.status === "open" ? '<form method="POST" action="/contribuer/' + s.id + '/close"><button class="btn btn-ghost btn-sm" type="submit">Marquer résolue</button></form>' : '')
      + '<form method="POST" action="/contribuer/' + s.id + '/delete"><button class="btn btn-danger btn-sm" type="submit">Supprimer</button></form>'
      + '</div></div>';
  }).join("") : emptyState("Aucune contribution", "Vous n\u2019avez rien propos\u00e9 pour l\u2019instant.", "/contribuer/nouveau", "Proposer une idée");
  const banner = msg ? '<div class="banner ok">' + esc(msg) + '</div>' : "";
  const body = publicHeader("contribute", me) + '<main class="admin"><div class="page-head">'
    + '<div><h1>Mon espace</h1><p>Vos contributions \u00e0 la communaut\u00e9 de ' + esc(name) + '.</p></div>'
    + '<a class="btn btn-primary" href="/contribuer/nouveau">+ Proposer</a></div>'
    + banner
    + '<div class="toc">' + rows + '</div></main>' + publicFooter();
  return layout({ title: "Mon espace \u2014 " + name, body });
}

async function handleSubmitAction(req, res, id, action){
  const me = currentUser(req, res);
  if(!me) return redirect(res, "/connexion?back=/contribuer/mes-idees");
  const s = get("SELECT * FROM submissions WHERE id=?", id);
  if(!s) return redirect(res, "/contribuer/mes-idees");
  const isStaff = me.role === "admin" || me.role === "moderator";
  if(!isStaff && s.user_id !== me.id) return sendHtml(res, notFound(me), 403);
  if(action === "close") run("UPDATE submissions SET status=?, updated_at=? WHERE id=?", s.status === "open" ? "resolved" : "open", Date.now(), id);
  if(action === "delete") run("DELETE FROM submissions WHERE id=?", id);
  auditLog(me.id, "submission." + action, { id: id }, req);
  return isStaff ? redirect(res, "/admin/contributions") : redirect(res, "/contribuer/mes-idees");
}

/* ---- Modération : contributions et messages (réservé aux admins) ---- */
function adminRowActions(id, parts, base){
  return '<div class="ract">' + parts.map(p =>
    '<form method="POST" action="' + base + '/' + id + '/' + p.href + '">'
    + '<button class="btn ' + (p.danger ? "btn-danger" : "btn-ghost") + ' btn-sm" type="submit">' + esc(p.label) + '</button></form>'
  ).join("") + '</div>';
}
function contactsAdminRow(cm){
  const head = (cm.subject || "(sans objet)") + (cm.name ? " — " + cm.name : "");
  return '<div class="row"><div class="rh">'
    + '<div class="rmeta">' + (cm.status === "read" ? '<span class="tag">Lu</span>' : '<span class="tag">Nouveau</span>')
    + ' <span>' + fmtDate(cm.created_at) + '</span>'
    + (cm.email ? ' <span>· <a href="mailto:' + esc(cm.email) + '">' + esc(cm.email) + '</a></span>' : '')
    + (cm.user_id ? ' <span>· compte</span>' : '') + '</div>'
    + '<h3>' + esc(head) + '</h3>'
    + (cm.body ? '<div class="contact-quote">' + inlineFmt(String(cm.body).slice(0, 320)) + '</div>' : '')
    + '</div>'
    + adminRowActions(cm.id,
        [ { href:"read", label: cm.status === "read" ? "Marquer non lu" : "Marquer lu" },
          { href:"delete", label:"Supprimer", danger:true } ],
        "/admin/messages")
    + '</div>';
}
function handleAdminMessageAction(req, res, id, action){
  const me = currentUser(req, res);
  if(!me || me.role !== "admin") return redirect(res, "/contribuer");
  const m = get("SELECT * FROM contact_messages WHERE id=?", id);
  if(!m) return redirect(res, "/admin/messages");
  if(action === "read") run("UPDATE contact_messages SET status=? WHERE id=?", m.status === "read" ? "new" : "read", id);
  if(action === "delete") run("DELETE FROM contact_messages WHERE id=?", id);
  auditLog(me.id, "contact." + action, { id: id }, req);
  return redirect(res, "/admin/messages");
}
function contactMessagesPage(msg){
  const msgs = all("SELECT * FROM contact_messages ORDER BY CASE status WHEN 'new' THEN 0 ELSE 1 END, created_at DESC LIMIT 200");
  const banner = msg ? '<div class="banner ok">' + esc(msg) + '</div>' : "";
  const list = msgs.length
    ? '<div class="toc">' + msgs.map(contactsAdminRow).join("") + '</div>'
    : emptyState("Aucun message", "Les messages envoyés depuis la page Contact apparaîtront ici, conservés en base.", "", "");
  const body = adminBar("messages") + '<div class="page-head"><div><h1>Messages</h1>'
    + '<p>Vos échanges via le formulaire de contact \u2014 copie conservée en base.</p></div></div>'
    + banner + list;
  return layout({ title: "Messages — " + getSetting("site_name","Elle"), body });
}
function handleAdminSubmissionAction(req, res, id, action){
  const me = currentUser(req, res);
  if(!me || me.role !== "admin") return redirect(res, "/contribuer");
  const s = get("SELECT * FROM submissions WHERE id=?", id);
  if(!s) return redirect(res, "/admin/contributions");
  if(action === "resolve") run("UPDATE submissions SET status=?, updated_at=? WHERE id=?", s.status === "open" ? "resolved" : "open", Date.now(), id);
  if(action === "delete") run("DELETE FROM submissions WHERE id=?", id);
  auditLog(me.id, "submission." + action, { id: id }, req);
  return redirect(res, "/admin/contributions");
}
function submissionsAdminRow(s){
  const u = submissionUser(s);
  const k = submissionKindLabel(s.kind);
  const head = k.glyph + " " + esc(s.title);
  const actions = [ { href:"resolve", label: s.status === "open" ? "Résoudre" : "Rouvrir" }, { href:"delete", label:"Supprimer", danger:true } ];
  return '<div class="row"><div class="rh">'
    + '<div class="rmeta"><span class="tag">' + esc(k.label) + '</span>'
    + ' <span class="tag ' + submissionStatusClass(s.status) + '-tag">' + esc(submissionStatusLabel(s.status)) + '</span>'
    + ' <span>' + fmtDate(s.created_at) + '</span>'
    + (u ? ' <span>· ' + esc(authorName(u)) + '</span>' : '')
    + (s.contact ? ' <span>· contact : ' + esc(s.contact) + '</span>' : '') + '</div>'
    + '<h3>' + head + '</h3>'
    + (s.body ? '<div class="contact-quote">' + inlineFmt(String(s.body).slice(0, 320)) + '</div>' : '')
    + '</div>' + adminRowActions(s.id, actions, "/admin/contributions")
    + '</div>';
}
function contributionsAdminPage(msg){
  const subs = all("SELECT * FROM submissions ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'resolved' THEN 1 ELSE 2 END, created_at DESC LIMIT 200");
  const open = subs.filter(s => s.status === "open").length;
  const banner = msg ? '<div class="banner ok">' + esc(msg) + '</div>' : "";
  const list = subs.length
    ? '<div class="toc">' + subs.map(submissionsAdminRow).join("") + '</div>'
    : emptyState("Aucune contribution", "Les propositions du public apparaîtront ici (idées, bugs, suggestions…).", "", "");
  const body = adminBar("contrib") + '<div class="page-head"><div><h1>Contributions</h1>'
    + '<p>' + open + ' ouverte' + (open > 1 ? "s" : "") + ' · ' + subs.length + ' au total.</p></div>'
    + '<div class="sp"></div><a class="btn btn-primary" href="/contribuer">Voir sur le site</a></div>'
    + banner + list;
  return layout({ title: "Contributions — " + getSetting("site_name","Elle"), body });
}

/* ------------------------------ HTTP helpers --------------------------- */
function send(res, code, type, body){ res.statusCode = code; res.setHeader("Content-Type", type + "; charset=utf-8"); res.end(body); }
function sendHtml(res, html, code){ send(res, code || 200, "text/html", html); }
function sendJson(res, obj, code){ send(res, code || 200, "application/json", JSON.stringify(obj)); }
function redirect(res, loc){ res.statusCode = 302; res.setHeader("Location", loc); res.end(); }
function setSessionCookie(res, token){ res.setHeader("Set-Cookie", "elle_sess=" + token + "; HttpOnly; SameSite=Lax; Path=/; Max-Age=" + (60*60*24*30)); }
function clearSessionCookie(res){ res.setHeader("Set-Cookie", "elle_sess=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"); }

const MIME = { ".css":"text/css", ".js":"text/javascript", ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg", ".gif":"image/gif", ".webp":"image/webp", ".svg":"image/svg+xml", ".ico":"image/x-icon", ".json":"application/json", ".bin":"application/octet-stream" };
function serveStatic(res, baseDir, rel){
  const safe = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  const fp = path.join(baseDir, safe);
  if(fp.indexOf(baseDir) !== 0) return send(res, 403, "text/plain", "Interdit");
  fs.readFile(fp, (err, data) => {
    if(err) return send(res, 404, "text/plain", "Introuvable");
    const ext = path.extname(fp).toLowerCase();
    res.statusCode = 200;
    res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
    res.setHeader("Cache-Control", baseDir === UPLOAD_DIR ? "public, max-age=31536000" : "public, max-age=3600");
    res.end(data);
  });
}

/* --------------------------------- Routeur ----------------------------- */
async function handleAdmin(req, res, pathn, method, u){
  if(pathn === "/admin/login" && method === "POST") return handleLogin(req, res);
  if(pathn === "/admin/logout"){ const cookies = parseCookies(req); const session = findRefreshSession(cookies[AUTH_REFRESH_COOKIE]); if(session) revokeRefreshTokenById(session.row.id); clearAuthCookies(res); return redirect(res, "/"); }

  // Photo de profil choisie pendant la création du tout premier compte :
  // aucun compte n'existe encore, donc pas de session à exiger. Fenêtre fermée
  // dès qu'un compte existe.
  if(method === "POST" && pathn === "/admin/upload" && userCount() === 0) return handleUpload(req, res);

  const authUser = currentUser(req, res);
  if(!authUser) {
    const mode = authSetupMode();
    return sendHtml(res, authFormPage({ create: mode === "create", migrate: mode === "migrate" }));
  }
  // L'Atelier est réservé aux administrateurs : un compte « visitor » créé sur
  // la place publique ne doit jamais voir ni modifier la partie privée.
  if(authUser.role !== "admin") return redirect(res, "/contribuer");

  let m;
  if(method === "GET" && pathn === "/admin") return sendHtml(res, dashboardPage());

  if(method === "GET" && pathn === "/admin/contributions") return sendHtml(res, contributionsAdminPage(u.searchParams.get("msg")));
  if(method === "POST" && (m = pathn.match(/^\/admin\/contributions\/(\d+)\/(resolve|reopen|delete)$/))) return handleAdminSubmissionAction(req, res, +m[1], m[2]);

  if(method === "GET" && pathn === "/admin/messages") return sendHtml(res, contactMessagesPage(u.searchParams.get("msg")));
  if(method === "POST" && (m = pathn.match(/^\/admin\/messages\/(\d+)\/(read|unread|delete)$/))) return handleAdminMessageAction(req, res, +m[1], m[2]);

  if(method === "GET" && (m = pathn.match(/^\/admin\/new\/(blog|project|podcast|course)$/))) return sendHtml(res, editorPage({ kind: "article", doc: { type: m[1] }, categories: categoryList() }));
  if(method === "GET" && pathn === "/admin/new") return sendHtml(res, editorPage({ kind: "article", doc: { type: "blog" }, categories: categoryList() }));
  if(method === "GET" && (m = pathn.match(/^\/admin\/edit\/(\d+)$/))){
    const a = get("SELECT * FROM articles WHERE id=?", +m[1]);
    if(!a) return sendHtml(res, notFound(true), 404);
    return sendHtml(res, editorPage({ kind: "article", doc: a, categories: categoryList() }));
  }
  if(method === "POST" && pathn === "/admin/entry") return handleEntrySave(req, res);
  if(method === "POST" && (m = pathn.match(/^\/admin\/entry\/delete\/(\d+)$/))){ run("DELETE FROM articles WHERE id=?", +m[1]); return sendJson(res, { ok: true }); }

  if(method === "GET" && pathn === "/admin/pages") return sendHtml(res, pagesPage());
  if(method === "GET" && pathn === "/admin/pages/new") return sendHtml(res, editorPage({ kind: "page", doc: { in_nav: 1, show_on_index: 0 } }));
  if(method === "GET" && (m = pathn.match(/^\/admin\/pages\/edit\/(\d+)$/))){
    const p = get("SELECT * FROM pages WHERE id=?", +m[1]);
    if(!p) return sendHtml(res, notFound(true), 404);
    return sendHtml(res, editorPage({ kind: "page", doc: p }));
  }
  if(method === "POST" && pathn === "/admin/page") return handlePageSave(req, res);
  if(method === "POST" && (m = pathn.match(/^\/admin\/page\/delete\/(\d+)$/))){ run("DELETE FROM pages WHERE id=?", +m[1]); return sendJson(res, { ok: true }); }

  if(method === "GET" && pathn === "/admin/faq") return sendHtml(res, faqPage(u.searchParams.get("saved")));
  if(method === "POST" && pathn === "/admin/faq") return handleFaqSave(req, res);
  if(method === "POST" && (m = pathn.match(/^\/admin\/faq\/delete\/(\d+)$/))){ run("DELETE FROM faqs WHERE id=?", +m[1]); return sendJson(res, { ok: true }); }

  if(method === "GET" && pathn === "/admin/assistant") return sendHtml(res, assistantPage());
  if(method === "POST" && pathn === "/admin/assistant/chat") return handleAssistantChat(req, res);
  if(method === "POST" && (m = pathn.match(/^\/admin\/agents\/(blog|notes-cours|creation-cours|projet)\/chat$/))) return handleAgentProxyChat(req, res, m[1]);
  if(method === "POST" && (m = pathn.match(/^\/admin\/agents\/(blog|notes-cours|creation-cours|projet)\/remark$/))) return handleAgentProxyRemark(req, res, m[1]);

  if(method === "GET" && pathn === "/admin/settings") return sendHtml(res, settingsPage(u.searchParams.get("saved")));
  if(method === "POST" && pathn === "/admin/settings") return handleSettingsSave(req, res);

  if(method === "GET" && (pathn === "/admin/pin" || pathn === "/admin/account")) return sendHtml(res, accountPage(u.searchParams.get("saved"), "", authUser));
  if(method === "POST" && (pathn === "/admin/pin" || pathn === "/admin/account")) return handleAccountChange(req, res);
  if(method === "POST" && pathn === "/admin/profile") return handleProfileSave(req, res);

  if(method === "POST" && pathn === "/admin/upload") return handleUpload(req, res);

  return sendHtml(res, notFound(true), 404);
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, "http://localhost");
    let pathn = decodeURIComponent(u.pathname);
    const method = req.method;
    let m;

    if(pathn.startsWith("/public/")) return serveStatic(res, PUBLIC_DIR, pathn.slice(8));
    if(pathn.startsWith("/uploads/")) return serveStatic(res, UPLOAD_DIR, pathn.slice(9));
    if(pathn === "/favicon.ico") return send(res, 204, "text/plain", "");

    if(pathn.length > 1 && pathn.endsWith("/")) pathn = pathn.slice(0, -1);

    if(pathn.startsWith("/api/auth/")) return await handleAuthApi(req, res, pathn, method, u);
    if(pathn === "/api/agent/draft" && method === "POST") return await handleAgentDraft(req, res);
    if(pathn === "/api/agent/content" && method === "GET") return await handleAgentContentList(req, res, u);
    if(pathn === "/api/agent/search" && method === "GET") return await handleAgentSearch(req, res, u);
    if(method === "GET" && (m = pathn.match(/^\/api\/agent\/content\/(.+)$/))) return await handleAgentContentGet(req, res, decodeURIComponent(m[1]));
    if(pathn === "/admin" || pathn.startsWith("/admin/")) return await handleAdmin(req, res, pathn, method, u);

    // Un seul contrôle de session par requête : il décide si l'Atelier est
    // proposé dans l'en-tête et si les brouillons sont visibles.
    const me = currentUser(req, res);
    const authed = !!me;

    // Communauté : connexion / inscription / contribution ouverte.
    if(method === "GET" && pathn === "/connexion") return sendHtml(res, publicAuthPage("login", u.searchParams, ""));
    if(method === "POST" && pathn === "/connexion") return handlePublicLogin(req, res);
    if(method === "GET" && pathn === "/inscription") return sendHtml(res, publicAuthPage("register", u.searchParams, ""));
    if(method === "POST" && pathn === "/inscription") return handlePublicRegister(req, res);
    if((pathn === "/deconnexion" || pathn === "/logout")){ clearAuthAndRedirect(res, req, "/"); return; }
    if(method === "POST" && pathn === "/contact") return handleContact(req, res);

    if(method === "GET" && pathn === "/contribuer") return sendHtml(res, renderContribuer(me));
    if(method === "GET" && pathn === "/contribuer/nouveau") return (me ? sendHtml(res, renderSubmitForm(me, "", "")) : redirect(res, "/connexion?back=/contribuer/nouveau"));
    if(method === "POST" && pathn === "/contribuer") return handleSubmitCreate(req, res);
    if(method === "GET" && pathn === "/contribuer/mes-idees") return (me ? sendHtml(res, renderMySubmissions(me, "")) : redirect(res, "/connexion?back=/contribuer/mes-idees"));
    if(method === "POST" && (m = pathn.match(/^\/contribuer\/(\d+)\/(close|delete)$/))) return handleSubmitAction(req, res, +m[1], m[2]);

    if(method === "GET" && pathn === "/") return sendHtml(res, renderHome(me));
    if(method === "GET" && pathn === "/library") return sendHtml(res, renderLibrary(me));
    if(method === "GET" && pathn === "/blog") return sendHtml(res, renderBlogPage(u.searchParams, me));
    if(method === "GET" && pathn === "/projects") return sendHtml(res, renderProjectsPage(u.searchParams, me));
    if(method === "GET" && pathn === "/podcasts") return sendHtml(res, renderPodcastsPage(u.searchParams, me));
    if(method === "GET" && pathn === "/courses") return sendHtml(res, renderCoursesPage(u.searchParams, me));
    if(method === "GET" && pathn.startsWith("/post/")) return renderItem(req, res, pathn.slice(6));
    if(method === "GET" && pathn.startsWith("/auteur/")){ const html = renderAuthorPage(pathn.slice(8), me); return sendHtml(res, html || notFound(me), html ? 200 : 404); }
    if(method === "GET" && pathn.startsWith("/p/")){ const html = renderPageView(pathn.slice(3), me, u.searchParams); return sendHtml(res, html || notFound(me), html ? 200 : 404); }

    return sendHtml(res, notFound(me), 404);
  } catch(e){
    console.error(e);
    send(res, 500, "text/plain", "Erreur serveur");
  }
});

/* -------------------------------- Démarrage ---------------------------- */
openDatabase();
migrate();
seed();
server.listen(PORT, () => {
  console.log("");
  console.log("  Elle \u25B8 http://localhost:" + PORT);
  console.log("  Atelier \u25B8 http://localhost:" + PORT + "/admin");
  console.log("  Base \u25B8 " + DB_PATH + "  (moteur : " + DB_DRIVER + ")");
  console.log("  Ctrl+C pour arrêter.");
  console.log("");
});
