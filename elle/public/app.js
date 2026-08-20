/* =========================================================
   Elle — script client (v2)
   - thème clair/sombre
   - rendu formules (KaTeX) + code (highlight.js)
   - tableau de bord : recherche / tri / filtre par type
   - éditeur en blocs (Blog / Projets / Podcasts + Pages)
   - assistant IA (Atelier)
   ========================================================= */
(function(){
  "use strict";
  var $ = function(s, r){ return (r||document).querySelector(s); };
  var $all = function(s, r){ return Array.prototype.slice.call((r||document).querySelectorAll(s)); };

  /* ---------- Thème ---------- */
  function applyTheme(t){ document.documentElement.setAttribute("data-theme", t); try{ localStorage.setItem("elle_theme", t); }catch(e){} }
  $all("[data-action='theme']").forEach(function(btn){
    btn.addEventListener("click", function(){
      var cur = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
      applyTheme(cur === "dark" ? "light" : "dark");
      btn.textContent = document.documentElement.getAttribute("data-theme") === "dark" ? "\u2600" : "\u263E";
    });
  });

  /* ---------- Toast ---------- */
  var toastT;
  function toast(msg){
    var el = $("#toast");
    if(!el){ el = document.createElement("div"); el.id = "toast"; el.className = "toast"; document.body.appendChild(el); }
    el.textContent = msg; el.classList.add("show");
    clearTimeout(toastT); toastT = setTimeout(function(){ el.classList.remove("show"); }, 2300);
  }

  function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g, function(c){ return ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[c]; }); }

  /* ---------- Formatage en ligne + blocs (identique au serveur) ---------- */
  function inlineFmt(str){
    if(str == null) return "";
    var stash = [], s = String(str);
    s = s.replace(/\$([^\$\n]+?)\$/g, function(m, tex){ stash.push('<span class="ktx" data-mode="inline">' + esc(tex) + '</span>'); return "\u0000" + (stash.length-1) + "\u0000"; });
    s = s.replace(/`([^`]+?)`/g, function(m, code){ stash.push('<code class="inline">' + esc(code) + '</code>'); return "\u0000" + (stash.length-1) + "\u0000"; });
    s = esc(s);
    s = s.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*]+?)\*/g, "<em>$1</em>");
    s = s.replace(/\[([^\]]+?)\]\((https?:\/\/[^\s)]+)\)/g, function(m, t, u){ return '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + t + '</a>'; });
    s = s.replace(/\n/g, "<br>");
    s = s.replace(/\u0000(\d+)\u0000/g, function(m, i){ return stash[+i]; });
    return s;
  }
  function listHtml(lines, ordered){
    var items = lines.map(function(l){ return "<li>" + inlineFmt(l) + "</li>"; }).join("");
    return ordered ? "<ol>" + items + "</ol>" : "<ul>" + items + "</ul>";
  }
  function blockHtml(b){
    if(!b || !b.type) return "";
    if(b.type === "heading"){ var lv = (b.level === 3 ? 3 : 2); return "<h" + lv + ">" + esc(b.text||"") + "</h" + lv + ">"; }
    if(b.type === "text"){
      // gère des listes simples - / * / 1. à l'intérieur d'un bloc texte
      var out = "", para = [], li = [], ord = false, lines = String(b.text||"").split(/\n/);
      function flushP(){ if(para.length){ out += "<p>" + inlineFmt(para.join("\n")) + "</p>"; para = []; } }
      function flushL(){ if(li.length){ out += listHtml(li, ord); li = []; } }
      lines.forEach(function(line){
        var ul = /^\s*[-*]\s+(.*)/.exec(line), ol = /^\s*\d+[.)]\s+(.*)/.exec(line);
        if(ul){ flushP(); if(li.length && ord){ flushL(); } ord = false; li.push(ul[1]); }
        else if(ol){ flushP(); if(li.length && !ord){ flushL(); } ord = true; li.push(ol[1]); }
        else if(/^\s*$/.test(line)){ flushP(); flushL(); }
        else { flushL(); para.push(line); }
      });
      flushP(); flushL();
      return out;
    }
    if(b.type === "quote"){ return "<blockquote>" + inlineFmt(b.text||"") + "</blockquote>"; }
    if(b.type === "code"){ var lang = String(b.lang||"").trim(); return "<pre><code" + (lang ? ' class="language-' + esc(lang) + '"' : "") + ">" + esc(b.code||"") + "</code></pre>"; }
    if(b.type === "formula"){
      if(b.mode === "inline") return '<p><span class="ktx" data-mode="inline">' + esc(b.tex||"") + "</span></p>";
      return '<div class="ktx" data-mode="block">' + esc(b.tex||"") + "</div>";
    }
    if(b.type === "image"){
      if(!b.url) return "";
      var cap = b.caption ? "<figcaption>" + esc(b.caption) + "</figcaption>" : "";
      return '<figure><img src="' + esc(b.url) + '" alt="' + esc(b.caption||"") + '">' + cap + "</figure>";
    }
    return "";
  }
  function renderDocHtml(blocks){ return (blocks||[]).map(blockHtml).join("\n"); }

  function renderMath(root){
    if(!window.katex) return;
    $all(".ktx", root).forEach(function(el){
      if(el.getAttribute("data-done")) return;
      try{ window.katex.render(el.textContent, el, { displayMode: el.getAttribute("data-mode") === "block", throwOnError: false }); el.setAttribute("data-done", "1"); }
      catch(e){}
    });
  }
  function highlightAll(root){ if(!window.hljs) return; $all("pre code", root).forEach(function(el){ try{ window.hljs.highlightElement(el); }catch(e){} }); }
  renderMath(document); highlightAll(document);

  /* ---------- Markdown -> blocs (pour l'assistant) ---------- */
  function mdToBlocks(md){
    var lines = String(md||"").replace(/\r/g, "").split("\n"), blocks = [], i = 0;
    while(i < lines.length){
      var line = lines[i];
      if(/^```/.test(line)){ var lang = line.replace(/^```/, "").trim(), buf = []; i++; while(i < lines.length && !/^```/.test(lines[i])){ buf.push(lines[i]); i++; } i++; blocks.push({ type:"code", lang:lang, code:buf.join("\n") }); continue; }
      var h = /^(#{1,6})\s+(.*)/.exec(line);
      if(h){ blocks.push({ type:"heading", level: Math.min(3, Math.max(2, h[1].length)), text: h[2].trim() }); i++; continue; }
      if(/^>\s?/.test(line)){ var qb = []; while(i < lines.length && /^>\s?/.test(lines[i])){ qb.push(lines[i].replace(/^>\s?/, "")); i++; } blocks.push({ type:"quote", text:qb.join("\n") }); continue; }
      if(/^\s*$/.test(line)){ i++; continue; }
      var pb = [];
      while(i < lines.length && !/^\s*$/.test(lines[i]) && !/^```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !/^>\s?/.test(lines[i])){ pb.push(lines[i]); i++; }
      blocks.push({ type:"text", text:pb.join("\n") });
    }
    return blocks.filter(function(b){ return (b.text && b.text.trim()) || (b.code && b.code.trim()); });
  }
  function draftTitle(md){
    var m = /^#{1,6}\s+(.*)/m.exec(String(md||""));
    if(m) return m[1].trim().slice(0, 90);
    var f = String(md||"").split("\n").filter(function(l){ return l.trim(); })[0] || "Brouillon";
    return f.replace(/^[#>*\-\s]+/, "").slice(0, 90);
  }

  /* ---------- Tableau de bord : recherche + tri + type ---------- */
  (function(){
    var list = $("#toc-list");
    if(!list) return;
    var search = $("#dash-search"), sortSel = $("#dash-sort");
    var chips = $all("[data-typefilter]");
    var rows = $all(".row", list);
    var curType = "all";
    function apply(){
      var q = (search && search.value || "").trim().toLowerCase();
      rows.forEach(function(r){
        var okType = (curType === "all" || r.getAttribute("data-type") === curType);
        var okQ = (!q || (r.getAttribute("data-search")||"").toLowerCase().indexOf(q) >= 0);
        r.style.display = (okType && okQ) ? "" : "none";
      });
      if(sortSel){
        var mode = sortSel.value;
        rows.slice().sort(function(a, b){
          if(mode === "views") return (+b.getAttribute("data-views")) - (+a.getAttribute("data-views"));
          if(mode === "old") return (+a.getAttribute("data-created")) - (+b.getAttribute("data-created"));
          return (+b.getAttribute("data-created")) - (+a.getAttribute("data-created"));
        }).forEach(function(r){ list.appendChild(r); });
      }
    }
    if(search) search.addEventListener("input", apply);
    if(sortSel) sortSel.addEventListener("change", apply);
    chips.forEach(function(c){ c.addEventListener("click", function(e){ e.preventDefault(); curType = c.getAttribute("data-typefilter"); chips.forEach(function(x){ x.classList.toggle("on", x === c); }); apply(); }); });
  })();

  /* ---------- Suppression générique ---------- */
  $all("[data-delete]").forEach(function(btn){
    btn.addEventListener("click", function(e){
      e.preventDefault();
      var url = btn.getAttribute("data-delete"), label = btn.getAttribute("data-label") || "cet élément";
      if(!confirm("Supprimer « " + label + " » ? Cette action est définitive.")) return;
      fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body:"{}" })
        .then(function(r){ return r.json(); })
        .then(function(d){ if(d && d.ok){ location.href = btn.getAttribute("data-after") || "/admin"; } else { toast("Suppression impossible."); } })
        .catch(function(){ toast("Erreur réseau."); });
    });
  });

  /* ---------- Uploader d'image générique (réglages : héro) ---------- */
  $all("[data-uploader]").forEach(function(zone){
    var input = zone.querySelector('input[type=file]');
    var hidden = $("#" + zone.getAttribute("data-target"));
    var prev = zone.querySelector(".prev");
    var btn = zone.querySelector("[data-pick]");
    if(btn && input) btn.addEventListener("click", function(){ input.click(); });
    var empty = zone.querySelector(".av-empty");
    if(input) input.addEventListener("change", function(){
      if(!input.files || !input.files[0]) return;
      uploadFile(input.files[0], function(url){
        if(hidden) hidden.value = url;
        if(prev){ prev.src = url; prev.style.display = ""; }
        if(empty) empty.style.display = "none";
        if(btn) btn.textContent = zone.classList.contains("avatar-pick") ? "Remplacer la photo" : "Remplacer l’image";
        toast("Image enregistrée");
      });
    });
  });

  function uploadFile(file, cb){
    var reader = new FileReader();
    reader.onload = function(){
      fetch("/admin/upload", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ name:file.name, dataUrl:reader.result }) })
        .then(function(r){ return r.json(); })
        .then(function(d){ if(d && d.url){ cb(d.url); } else { toast("Échec de l'envoi de l'image."); } })
        .catch(function(){ toast("Erreur réseau (image)."); });
    };
    reader.readAsDataURL(file);
  }

  /* ====================================================
     AGENTS (Rapide + Blog + Notes de cours + Création de cours + Projet)
     ==================================================== */
  (function(){
    var root = $("#agent-root");
    if(!root) return;
    var hasKey = root.getAttribute("data-haskey") === "1";

    var AGENTS = {
      "quick": {
        label: "Rapide", kind: "quick",
        intro: "Décrivez un sujet, un thème ou une envie : l\u2019assistant propose des idées et structure un article, un projet ou un épisode de podcast. Vous pourrez transformer une réponse en brouillon.",
        placeholder: "Ex. : 3 idées d\u2019articles sur le minimalisme, avec un plan"
      },
      "blog": {
        label: "Blog", kind: "mcp", endpoint: "/admin/agents/blog/chat",
        intro: "Cet agent connaît déjà votre blog (il peut chercher ce qui existe) et peut créer un brouillon lui-même quand vous le lui demandez.",
        placeholder: "Ex. : propose-moi 3 angles sur le minimalisme numérique"
      },
      "notes-cours": {
        label: "Notes de cours", kind: "mcp", endpoint: "/admin/agents/notes-cours/chat",
        intro: "Collez le texte d\u2019une leçon suivie ailleurs (ou décrivez ce que vous venez d\u2019apprendre) : l\u2019agent structure des notes révisables et peut les enregistrer comme cours.",
        placeholder: "Collez le texte d\u2019une leçon, ou décrivez ce que vous venez d\u2019apprendre\u2026"
      },
      "creation-cours": {
        label: "Création de cours", kind: "mcp", endpoint: "/admin/agents/creation-cours/chat",
        intro: "Décrivez le cours que vous voulez concevoir : l\u2019agent propose un plan, puis rédige module par module.",
        placeholder: "Ex. : un cours pour débutants sur les bases de Python"
      },
      "projet": {
        label: "Projet", kind: "mcp", endpoint: "/admin/agents/projet/chat",
        intro: "Décrivez une idée de projet : l\u2019agent challenge le cadrage (une question à la fois, parfois à choix), isole l\u2019hypothèse la plus risquée, propose un MVP minimal, puis prépare des entretiens avec de premiers utilisateurs.",
        placeholder: "Ex. : une appli pour aider les indépendants à suivre leurs devis"
      }
    };
    var state = {};
    Object.keys(AGENTS).forEach(function(k){ state[k] = { messages: [], sessionId: null, doc: null, pendingChoice: null, pendingAttachments: [], msgSeq: 0, abortController: null }; });
    var current = "quick";

    var tabBtns = $all("#agentTabs [data-tab]");
    var textEl, sendBtn, typingEl;

    function draftLinkFromToolCalls(toolCalls){
      if(!Array.isArray(toolCalls)) return null;
      for(var i = 0; i < toolCalls.length; i++){
        var r = toolCalls[i] && toolCalls[i].result;
        if(!r) continue;
        // Défensif : la forme exacte peut varier selon la version d'ADK.
        var flat = (r.ok !== undefined) ? r : (r.structuredContent || {});
        if(flat && flat.ok && flat.id){ return flat; }
      }
      return null;
    }

    /* ---- Canevas : blocs modifiables + remarque ciblée (✎ / 💬) ---- */
    var canvasBlockUid = 0;
    function canvasBlocksHtml(blocks){
      return (blocks||[]).map(function(b){
        if(!b._cid) b._cid = "cb" + (canvasBlockUid++);
        var canEdit = ["heading","text","quote"].indexOf(b.type) >= 0;
        var canRemark = ["text","quote"].indexOf(b.type) >= 0;
        var toolbar = (canEdit || canRemark) ? (
          '<div class="block-toolbar">'
          + (canEdit ? '<button type="button" data-act="edit-block" title="Modifier">&#9998;</button>' : '')
          + (canRemark ? '<button type="button" data-act="remark-block" title="Laisser une remarque">&#128172;</button>' : '')
          + '</div>'
        ) : "";
        return '<div class="block-wrap" data-cid="' + b._cid + '">' + toolbar + '<div class="block-content">' + blockHtml(b) + '</div></div>';
      }).join("\n");
    }
    function findCanvasBlock(cid){
      var doc = state[current].doc;
      if(!doc || !doc.blocks) return null;
      for(var i = 0; i < doc.blocks.length; i++) if(doc.blocks[i]._cid === cid) return doc.blocks[i];
      return null;
    }
    function rerenderOneBlock(cid){
      var b = findCanvasBlock(cid);
      var wrap = document.querySelector('.block-wrap[data-cid="' + cid + '"]');
      if(!b || !wrap) return;
      var tmp = document.createElement("div");
      tmp.innerHTML = canvasBlocksHtml([b]);
      wrap.replaceWith(tmp.firstElementChild);
    }
    function closeAllBlockEditors(){
      $all(".block-wrap.editing").forEach(function(w){ rerenderOneBlock(w.getAttribute("data-cid")); });
    }
    function closeAllBlockRemarks(){
      $all(".remark-pop").forEach(function(p){ var w = p.closest(".block-wrap"); if(w) w.classList.remove("editing"); p.remove(); });
    }
    function startBlockEdit(cid){
      closeAllBlockRemarks(); closeAllBlockEditors();
      var b = findCanvasBlock(cid);
      var wrap = document.querySelector('.block-wrap[data-cid="' + cid + '"]');
      if(!b || !wrap) return;
      wrap.classList.add("editing");
      var content = wrap.querySelector(".block-content");
      var val = b.type === "heading" ? (b.text||"") : (b.text||"");
      content.innerHTML = '<textarea class="block-edit-area" rows="' + (b.type === "heading" ? 1 : 4) + '">' + esc(val) + '</textarea>'
        + '<div class="block-edit-actions"><button type="button" class="mini-btn save" data-act="save-block">Enregistrer</button><button type="button" class="mini-btn cancel" data-act="cancel-block">Annuler</button></div>';
      var ta = content.querySelector("textarea"); ta.focus();
    }
    function saveBlockEdit(cid){
      var b = findCanvasBlock(cid);
      var wrap = document.querySelector('.block-wrap[data-cid="' + cid + '"]');
      if(!b || !wrap) return;
      var ta = wrap.querySelector("textarea");
      b.text = ta.value;
      wrap.classList.remove("editing");
      rerenderOneBlock(cid);
      toast("Modification enregistrée.");
    }
    function openBlockRemark(cid){
      closeAllBlockRemarks(); closeAllBlockEditors();
      var wrap = document.querySelector('.block-wrap[data-cid="' + cid + '"]');
      if(!wrap) return;
      wrap.classList.add("editing");
      var pop = document.createElement("div");
      pop.className = "remark-pop";
      pop.innerHTML = '<input type="text" placeholder="Votre remarque pour l\u2019agent\u2026"><button type="button" class="mini-btn save" data-act="send-block-remark">Envoyer</button><button type="button" class="mini-btn cancel" data-act="cancel-block-remark">Annuler</button>';
      wrap.appendChild(pop);
      pop.querySelector("input").focus();
    }
    function submitBlockRemark(cid){
      var wrap = document.querySelector('.block-wrap[data-cid="' + cid + '"]');
      var input = wrap && wrap.querySelector(".remark-pop input");
      var text = input ? input.value.trim() : "";
      if(!text) return;
      var b = findCanvasBlock(cid);
      var pop = wrap.querySelector(".remark-pop");
      pop.outerHTML = '<div class="remark-thinking"><span class="ink-dot" style="width:6px;height:6px"></span>L\u2019agent révise ce passage\u2026</div>';

      var a = AGENTS[current], s = state[current];
      fetch("/admin/agents/" + current + "/remark", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target_block: Object.assign({}, b, { id: b._cid }), remark: text, session_id: s.sessionId })
      })
        .then(function(r){ return r.json().then(function(d){ return { ok:r.ok, data:d }; }); })
        .then(function(res){
          var thinking = document.querySelector('.block-wrap[data-cid="' + cid + '"] .remark-thinking');
          if(thinking) thinking.remove();
          if(!res.ok){ toast((res.data && res.data.detail) || "Révision impossible."); rerenderOneBlock(cid); return; }
          if(res.data.session_id) s.sessionId = res.data.session_id;
          var revised = res.data.block;
          Object.keys(revised).forEach(function(k){ if(k !== "id") b[k] = revised[k]; });
          rerenderOneBlock(cid);
          toast("Passage révisé.");
        })
        .catch(function(){ toast("Erreur réseau."); rerenderOneBlock(cid); });
    }

    /* ---- Canevas : aperçu structuré (doc.title/kick/blocks/sources) ---- */
    /* Nombre de mots du document (titre + contenu des blocs, sans le HTML) */
    function canvasWordCount(doc){
      var html = (doc.title || "") + " " + renderDocHtml(doc.blocks || []);
      var text = html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ");
      var m = text.trim().match(/\S+/g);
      return m ? m.length : 0;
    }
    function canvasHtml(){
      var doc = state[current].doc;
      if(!doc) return '<div class="canvas-empty">L\u2019aperçu structuré appara\u00eetra ici d\u00e8s que l\u2019agent proposera un contenu concret \u2014 il garde alors sa derni\u00e8re version tant que la conversation continue.</div>';
      var kick = doc.kick ? '<div class="kick">' + esc(doc.kick) + '</div>' : '';
      var title = '<h3 class="canvas-title">' + esc(doc.title||"") + '</h3>';
      var body = '<div class="prose canvas-prose">' + canvasBlocksHtml(doc.blocks||[]) + '</div>';
      var sources = (doc.sources && doc.sources.length) ? (
        '<div class="canvas-sources"><div class="canvas-sources-label">Sources consult\u00e9es</div><ul>'
        + doc.sources.map(function(s){
            return '<li>' + (s.url
              ? '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.title||s.url) + '</a>'
              : esc(s.title||"Fichier joint") + ' <span class="src-file-tag">fichier joint</span>') + '</li>';
          }).join("")
        + '</ul></div>'
      ) : '';
      // Colonne meta (Statut / Mots / Mis a jour / Sources), a la maniere de la demo.
      var meta = '<aside class="canvas-meta">'
        + '<div class="canvas-meta-item"><div class="canvas-meta-label">Statut</div><span class="canvas-status-pill">Brouillon</span></div>'
        + '<div class="canvas-meta-item"><div class="canvas-meta-label">Mots</div><div class="canvas-meta-value big">' + canvasWordCount(doc) + '</div></div>'
        + '<div class="canvas-meta-item"><div class="canvas-meta-label">Mis à jour</div><div class="canvas-meta-value">à l’instant</div></div>'
        + sources
        + '</aside>';
      return '<div class="canvas-doc-grid"><div class="canvas-doc">' + kick + title + body + '</div>' + meta + '</div>';
    }
    function renderCanvas(){
      var el = $("#canvasBody");
      var pane = $(".canvas-pane");
      var status = $("#canvasStatus");
      if(!el) return;
      el.innerHTML = canvasHtml();
      renderMath(el); highlightAll(el);
      if(status) status.textContent = state[current].doc ? "brouillon prêt" : "";
      if(pane){
        // rejoue l'animation d'encre à chaque nouvelle version du document
        pane.classList.remove("reveal");
        void pane.offsetWidth; // force le reflow pour pouvoir relancer l'animation CSS
        pane.classList.add("reveal");
      }
      markCanvasUpdated();
    }

    /* ---- Cadrage à choix : question fermée à 2-4 options (jamais un QCM
       strict — la personne peut toujours répondre librement ci-dessous) ---- */
    function renderChoice(){
      var box = $("#choiceBox");
      if(!box) return;
      var choice = state[current].pendingChoice;
      if(!choice || !Array.isArray(choice.options) || !choice.options.length){
        box.innerHTML = ""; box.classList.add("hidden");
        return;
      }
      box.classList.remove("hidden");
      box.innerHTML = '<div class="choice-q">' + esc(choice.question||"") + '</div>'
        + '<div class="choice-opts">' + choice.options.map(function(o, i){
            return '<button type="button" class="choice-opt" data-choice-idx="' + i + '">'
              + '<span class="choice-opt-text">' + esc(o.text||"") + '</span>'
              + (o.why ? '<span class="choice-opt-why">' + esc(o.why) + '</span>' : '')
              + '</button>';
          }).join("")
        + '</div>'
        + '<div class="choice-free">Vous pouvez aussi r\u00e9pondre autrement, librement, ci-dessous.</div>';
      $all(".choice-opt", box).forEach(function(btn){
        btn.addEventListener("click", function(){
          var opt = choice.options[parseInt(btn.getAttribute("data-choice-idx"), 10)];
          if(opt) send(opt.text);
        });
      });
    }

    /* ---- Pi\u00e8ces jointes en attente d'envoi (agents MCP uniquement) ---- */
    function renderAttachments(){
      var row = $("#attachRow");
      if(!row) return;
      var atts = state[current].pendingAttachments;
      if(!atts.length){ row.classList.add("hidden"); row.innerHTML = ""; return; }
      row.classList.remove("hidden");
      row.innerHTML = atts.map(function(a, i){
        var glyph = a.kind === "image" ? '<img class="attach-thumb" src="' + esc(a.url) + '" alt="">' : '<span class="attach-ic">\uD83D\uDCDD</span>';
        return '<span class="attach-chip">' + glyph + esc(a.name) + '<button type="button" data-remove-attach="' + i + '" aria-label="Retirer">\u2715</button></span>';
      }).join("");
    }

    function renderShell(){
      var a = AGENTS[current];
      var isMcp = a.kind === "mcp";
      var draftBarHtml = a.kind === "quick"
        ? '<div class="chat-draft hidden" id="draftBar"><span>Transformer la dernière réponse en brouillon :</span>'
          + '<select id="draftType"><option value="blog">Article</option><option value="project">Projet</option><option value="podcast">Podcast</option></select>'
          + '<button class="btn btn-ghost btn-sm" id="draftBtn">Créer le brouillon</button></div>'
        : '<div class="hint" style="margin-top:10px">Cet agent peut créer ou mettre à jour un brouillon directement, sur simple demande — il reste toujours en statut brouillon, à publier vous-même.</div>';
      var enabled = a.kind === "quick" ? hasKey : true;
      var attachHtml = isMcp
        ? '<div class="attach-row hidden" id="attachRow"></div>'
          + '<div class="compose-hint">Joignez une image (illustration) ou un fichier .md/.txt (matière pour la bibliographie).</div>'
          + '<input type="file" id="agentFileInput" class="hidden" multiple accept="image/*,.md,.txt">'
        : "";
      var chatHtml =
        '<div class="chat' + (isMcp ? ' show' : '') + '">'
        + '<div class="chat-intro">' + a.intro + '</div>'
        + '<div class="chat-log" id="chatLog"></div>'
        + '<div class="typing hidden" id="chatTyping"><span class="ink-dot"></span><span class="ink-dot"></span><span class="ink-dot"></span>L\u2019agent réfléchit\u2026</div>'
        + '<div class="choice-box hidden" id="choiceBox"></div>'
        + attachHtml
        + '<div class="chat-input">'
        + (isMcp ? '<button type="button" class="attach-btn" id="agentAttachBtn" aria-label="Joindre un fichier">\uD83D\uDCCE</button>' : '')
        + '<textarea id="chatText" rows="1" placeholder="' + esc(a.placeholder||"") + '" ' + (enabled ? "" : "disabled") + '></textarea>'
        + '<button class="btn btn-primary" id="chatSend" data-mode="send" ' + (enabled ? "" : "disabled") + '>Envoyer</button></div>'
        + draftBarHtml
        + '</div>';
      var switchHtml = isMcp
        ? '<div class="canvas-switch" id="canvasSwitch">'
          + '<button type="button" class="on" data-view="chat">Discussion</button>'
          + '<button type="button" data-view="canvas">Page<span class="badge hidden" id="canvasBadge"></span></button>'
          + '</div>'
        : "";
      root.innerHTML = isMcp
        ? '<div class="agent-layout has-canvas">' + switchHtml + chatHtml
          + '<aside class="canvas-pane show"><div class="canvas-head"><span class="kick">' + esc(a.label||"") + '</span><span class="status" id="canvasStatus"></span></div><div class="canvas-body" id="canvasBody"></div></aside>'
          + '</div>'
        : chatHtml;
      wire();
      renderLog();
      mobileCanvasView = "chat";
      if(isMcp){ renderCanvas(); renderChoice(); renderAttachments(); }
    }

    /* ---- bascule mobile Discussion / Page (agents MCP, <880px) ---- */
    var mobileCanvasView = "chat";
    function markCanvasUpdated(){
      if(mobileCanvasView === "chat"){
        var badge = $("#canvasBadge");
        if(badge) badge.classList.remove("hidden");
      }
    }

    function renderLog(){
      var logEl = $("#chatLog");
      if(!logEl) return;
      logEl.innerHTML = state[current].messages.map(function(m){
        if(m.role === "interrupted") return '<div class="msg-interrupted">Message interrompu.</div>';
        var inner = m.role === "assistant" ? renderDocHtml(mdToBlocks(m.content)) : esc(m.content);
        var extra = m.draft ? '<div class="hint" style="margin-top:8px"><a href="/admin/edit/' + m.draft.id + '">\u2713 Brouillon enregistré — l\u2019ouvrir \u2192</a></div>' : "";
        var attsHtml = (m.atts && m.atts.length) ? '<div class="msg-atts">' + m.atts.map(function(a){ return '<span>' + (a.kind === "image" ? "\uD83D\uDDBC " : "\uD83D\uDCDD ") + esc(a.name) + '</span>'; }).join("") + '</div>' : "";
        var editBtn = (m.role === "user" && AGENTS[current].kind === "mcp") ? '<button type="button" class="msg-edit-btn" data-act="edit-msg" data-mid="' + m.id + '" title="Modifier ce message">&#9998;</button>' : "";
        return '<div class="msg ' + m.role + '" data-mid="' + (m.id||"") + '">' + editBtn + '<div class="bubble">' + inner + extra + attsHtml + '</div></div>';
      }).join("");
      renderMath(logEl); highlightAll(logEl);
      logEl.scrollTop = logEl.scrollHeight;
    }

    /* ---- Modifier un message déjà envoyé : tronque la suite de la
       conversation et repart d'une session neuve rejouant ce qui précède ---- */
    function startMsgEdit(mid){
      var s = state[current];
      var idx = s.messages.findIndex(function(m){ return String(m.id) === String(mid); });
      if(idx < 0) return;
      var bubble = document.querySelector('.msg[data-mid="' + mid + '"] .bubble');
      if(!bubble) return;
      var original = s.messages[idx].content;
      bubble.innerHTML = '<textarea class="msg-edit-area">' + esc(original) + '</textarea>'
        + '<div class="msg-edit-actions"><button type="button" class="mini-btn cancel" data-act="cancel-msg-edit">Annuler</button><button type="button" class="mini-btn save" data-act="save-msg-edit" data-mid="' + mid + '">Renvoyer</button></div>';
      var ta = bubble.querySelector("textarea"); ta.focus();
    }
    function saveMsgEdit(mid){
      var s = state[current];
      var idx = s.messages.findIndex(function(m){ return String(m.id) === String(mid); });
      if(idx < 0) return;
      var bubble = document.querySelector('.msg[data-mid="' + mid + '"] .bubble');
      var ta = bubble && bubble.querySelector("textarea");
      var newText = ta ? ta.value.trim() : "";
      if(!newText) return;
      var history = s.messages.slice(0, idx).filter(function(m){ return m.role === "user" || m.role === "assistant"; })
        .map(function(m){ return { role: m.role, content: m.content }; });
      s.messages = s.messages.slice(0, idx);
      // Le document du Canevas peut avoir été influencé par tout ce qui est
      // retiré : on le vide plutôt que de garder un aperçu potentiellement
      // incohérent avec la conversation modifiée.
      s.doc = null; s.pendingChoice = null;
      renderCanvas(); renderChoice();
      send(newText, history);
    }

    function autoGrow(){ if(textEl){ textEl.style.height = "auto"; textEl.style.height = Math.min(170, textEl.scrollHeight) + "px"; } }

    function send(overrideText, historyOverride){
      var t = String(overrideText != null ? overrideText : (textEl && textEl.value) || "").trim();
      var a = AGENTS[current], s = state[current];
      var atts = (a.kind === "mcp") ? s.pendingAttachments.slice() : [];
      if((!t && !atts.length) || (sendBtn && sendBtn.dataset.mode === "stop")) return;
      // Une réponse part (clic sur une option OU texte libre) : le quiz de
      // cadrage de ce tour n'a plus lieu d'être, il disparaît immédiatement.
      if(s.pendingChoice){ s.pendingChoice = null; renderChoice(); }
      s.messages.push({ id: ++s.msgSeq, role:"user", content: t || "(fichiers joints)", atts: atts });
      s.pendingAttachments = [];
      renderAttachments();
      if(textEl && overrideText == null){ textEl.value = ""; autoGrow(); }
      renderLog();
      if(sendBtn){ sendBtn.dataset.mode = "stop"; sendBtn.textContent = "Stop"; sendBtn.classList.add("send-btn-stop"); sendBtn.disabled = false; }
      if(typingEl) typingEl.classList.remove("hidden");

      var controller = new AbortController();
      s.abortController = controller;

      var url = a.kind === "quick" ? "/admin/assistant/chat" : a.endpoint;
      var payload = a.kind === "quick"
        ? { messages: s.messages }
        : { message: t, session_id: historyOverride ? null : s.sessionId, attachments: atts, history: historyOverride || [] };

      function finishComposer(){
        if(sendBtn){ sendBtn.dataset.mode = "send"; sendBtn.textContent = "Envoyer"; sendBtn.classList.remove("send-btn-stop"); }
        if(typingEl) typingEl.classList.add("hidden");
        s.abortController = null;
      }

      fetch(url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload), signal: controller.signal })
        .then(function(r){ return r.json(); })
        .then(function(d){
          finishComposer();
          if(d && d.reply){
            if(d.session_id) s.sessionId = d.session_id;
            var draft = draftLinkFromToolCalls(d.tool_calls);
            s.messages.push({ id: ++s.msgSeq, role:"assistant", content:d.reply, draft: draft });
            if(a.kind === "mcp"){
              // doc absent (null) = le tour était purement conversationnel :
              // le Canevas garde sa dernière version plutôt que de se vider.
              if(d.doc) s.doc = d.doc;
              s.pendingChoice = d.choice || null;
            }
            renderLog();
            if(a.kind === "mcp"){ renderCanvas(); renderChoice(); }
            if(a.kind === "quick"){ var db = $("#draftBar"); if(db) db.classList.remove("hidden"); }
          } else {
            var msg = "Une erreur est survenue.";
            if(d && d.error === "no_key") msg = "Ajoutez votre clé API Anthropic dans Réglages → Assistant pour activer cet onglet.";
            else if(d && d.detail) msg = "Erreur : " + d.detail;
            toast(msg);
          }
        })
        .catch(function(e){
          finishComposer();
          if(e && e.name === "AbortError"){
            s.messages.push({ id: ++s.msgSeq, role:"interrupted", content:"" });
            renderLog();
            return;
          }
          toast("Erreur réseau.");
        });
    }

    function wire(){
      textEl = $("#chatText"); sendBtn = $("#chatSend"); typingEl = $("#chatTyping");
      if(textEl) textEl.addEventListener("input", autoGrow);
      if(sendBtn) sendBtn.addEventListener("click", function(){
        if(sendBtn.dataset.mode === "stop"){
          var ctrl = state[current].abortController;
          if(ctrl) ctrl.abort();
          return;
        }
        send();
      });
      if(textEl) textEl.addEventListener("keydown", function(e){ if(e.key === "Enter" && !e.shiftKey){ e.preventDefault(); send(); } });

      var chatLogEl = $("#chatLog");
      if(chatLogEl) chatLogEl.addEventListener("click", function(e){
        var editBtn = e.target.closest('[data-act="edit-msg"]');
        if(editBtn){ startMsgEdit(editBtn.getAttribute("data-mid")); return; }
        var saveBtn = e.target.closest('[data-act="save-msg-edit"]');
        if(saveBtn){ saveMsgEdit(saveBtn.getAttribute("data-mid")); return; }
        var cancelBtn = e.target.closest('[data-act="cancel-msg-edit"]');
        if(cancelBtn){ renderLog(); return; }
      });

      var attachBtn = $("#agentAttachBtn"), fileInput = $("#agentFileInput"), attachRow = $("#attachRow");
      if(attachBtn && fileInput) attachBtn.addEventListener("click", function(){ fileInput.click(); });
      if(fileInput) fileInput.addEventListener("change", function(){
        Array.prototype.forEach.call(fileInput.files, function(file){
          var isImage = file.type.indexOf("image/") === 0;
          if(isImage){
            uploadFile(file, function(url){
              state[current].pendingAttachments.push({ kind:"image", name:file.name, url:url });
              renderAttachments();
              toast("Image ajoutée — elle sera proposée comme illustration.");
            });
          } else {
            var reader = new FileReader();
            reader.onload = function(){
              state[current].pendingAttachments.push({ kind:"text", name:file.name, content:String(reader.result) });
              renderAttachments();
              toast("Fichier ajouté — l\u2019agent pourra s\u2019en inspirer.");
            };
            reader.onerror = function(){ toast("Lecture du fichier impossible."); };
            reader.readAsText(file);
          }
        });
        fileInput.value = "";
      });
      if(attachRow) attachRow.addEventListener("click", function(e){
        var b = e.target.closest("[data-remove-attach]");
        if(!b) return;
        state[current].pendingAttachments.splice(parseInt(b.getAttribute("data-remove-attach"), 10), 1);
        renderAttachments();
      });

      var canvasSwitch = $("#canvasSwitch");
      if(canvasSwitch) canvasSwitch.addEventListener("click", function(e){
        var b = e.target.closest("[data-view]");
        if(!b) return;
        mobileCanvasView = b.getAttribute("data-view");
        $all("button", canvasSwitch).forEach(function(x){ x.classList.toggle("on", x === b); });
        var chatEl = root.querySelector(".agent-layout .chat");
        var paneEl = root.querySelector(".canvas-pane");
        if(chatEl) chatEl.classList.toggle("show", mobileCanvasView === "chat");
        if(paneEl) paneEl.classList.toggle("show", mobileCanvasView === "canvas");
        if(mobileCanvasView === "canvas"){ var badge = $("#canvasBadge"); if(badge) badge.classList.add("hidden"); }
      });

      var canvasBody = $("#canvasBody");
      if(canvasBody) canvasBody.addEventListener("click", function(e){
        var wrap;
        if((wrap = e.target.closest('[data-act="edit-block"]'))) startBlockEdit(wrap.closest(".block-wrap").getAttribute("data-cid"));
        else if((wrap = e.target.closest('[data-act="save-block"]'))) saveBlockEdit(wrap.closest(".block-wrap").getAttribute("data-cid"));
        else if((wrap = e.target.closest('[data-act="cancel-block"]'))) { var w = wrap.closest(".block-wrap"); w.classList.remove("editing"); rerenderOneBlock(w.getAttribute("data-cid")); }
        else if((wrap = e.target.closest('[data-act="remark-block"]'))) openBlockRemark(wrap.closest(".block-wrap").getAttribute("data-cid"));
        else if((wrap = e.target.closest('[data-act="send-block-remark"]'))) submitBlockRemark(wrap.closest(".block-wrap").getAttribute("data-cid"));
        else if((wrap = e.target.closest('[data-act="cancel-block-remark"]'))) { var w2 = wrap.closest(".block-wrap"); w2.classList.remove("editing"); rerenderOneBlock(w2.getAttribute("data-cid")); }
      });
      if(canvasBody) canvasBody.addEventListener("keydown", function(e){
        if(e.key === "Enter" && e.target.closest(".remark-pop input")){
          e.preventDefault();
          submitBlockRemark(e.target.closest(".block-wrap").getAttribute("data-cid"));
        }
      });

      var draftBtn = $("#draftBtn"), draftType = $("#draftType");
      if(draftBtn) draftBtn.addEventListener("click", function(){
        var msgs = state[current].messages, last = null;
        for(var i = msgs.length - 1; i >= 0; i--){ if(msgs[i].role === "assistant"){ last = msgs[i].content; break; } }
        if(!last){ toast("Aucune réponse à convertir."); return; }
        draftBtn.disabled = true; draftBtn.textContent = "Création\u2026";
        fetch("/admin/entry", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({
          title: draftTitle(last), type: draftType.value, status: "draft", featured: 0, category: "", cover: "", slug: "", blocks: mdToBlocks(last)
        }) })
          .then(function(r){ return r.json(); })
          .then(function(d){ if(d && d.ok){ location.href = "/admin/edit/" + d.id; } else { toast("Création impossible."); draftBtn.disabled = false; draftBtn.textContent = "Créer le brouillon"; } })
          .catch(function(){ toast("Erreur réseau."); draftBtn.disabled = false; draftBtn.textContent = "Créer le brouillon"; });
      });
    }

    tabBtns.forEach(function(btn){
      btn.addEventListener("click", function(){
        current = btn.getAttribute("data-tab");
        tabBtns.forEach(function(b){ b.classList.toggle("on", b === btn); });
        renderShell();
      });
    });

    renderShell();
  })();

  /* ====================================================
     ÉDITEUR EN BLOCS
     ==================================================== */
  var root = $("#doc-editor");
  if(!root) return;

  var cfg;
  try{ cfg = JSON.parse($("#doc-data").textContent); }catch(e){ return; }
  var kind = cfg.kind;            // 'article' (entrée) | 'page'
  var doc = cfg.doc || {};
  doc.blocks = Array.isArray(doc.blocks) ? doc.blocks : [];
  var uid = 0;
  doc.blocks.forEach(function(b){ b._id = "b" + (uid++); });

  var TYPES = [
    { t:"heading", label:"Titre",    gi:"H" },
    { t:"text",    label:"Texte",    gi:"\u00B6" },
    { t:"image",   label:"Image",    gi:"\u25A3" },
    { t:"code",    label:"Code",     gi:"{ }" },
    { t:"formula", label:"Formule",  gi:"\u2211" },
    { t:"quote",   label:"Citation", gi:"\u201C" }
  ];
  function typeLabel(t){ for(var i=0;i<TYPES.length;i++) if(TYPES[i].t === t) return TYPES[i]; return { label:t, gi:"" }; }

  var coverField = (kind === "article")
    ? '<div class="cover-drop" id="coverDrop"><input type="file" accept="image/*" id="coverInput" class="hidden"><div id="coverInner"></div></div>'
    : "";

  var metaFields = (kind === "article")
    ? '<div class="field-grid">'
        + '<div class="field"><label>Catégorie</label><input type="text" id="f-category" list="catlist" placeholder="ex. Carnet" value="' + esc(doc.category||"") + '"></div>'
        + '<div class="field"><label>Lien (slug)</label><input type="text" id="f-slug" placeholder="auto" value="' + esc(doc.slug||"") + '"></div>'
        + '<div class="field"><label>Statut</label><select id="f-status"><option value="published"' + (doc.status !== "draft" ? " selected" : "") + '>Publié</option><option value="draft"' + (doc.status === "draft" ? " selected" : "") + '>Brouillon</option></select></div>'
        + '<div class="field"><label>En vedette</label><select id="f-featured"><option value="0"' + (doc.featured ? "" : " selected") + '>Non</option><option value="1"' + (doc.featured ? " selected" : "") + '>Oui</option></select></div>'
      + '</div>'
      + '<datalist id="catlist">' + (cfg.categories||[]).map(function(c){ return '<option value="' + esc(c) + '">'; }).join("") + '</datalist>'
    : '<div class="field-grid">'
        + '<div class="field"><label>Lien (slug)</label><input type="text" id="f-slug" placeholder="auto" value="' + esc(doc.slug||"") + '"></div>'
        + '<div class="field"><label>Dans le menu</label><select id="f-nav"><option value="1"' + (doc.in_nav !== 0 ? " selected" : "") + '>Oui</option><option value="0"' + (doc.in_nav === 0 ? " selected" : "") + '>Non</option></select></div>'
        + '<div class="field"><label>Aperçu sur l\u2019accueil</label><select id="f-index"><option value="1"' + (doc.show_on_index !== 0 ? " selected" : "") + '>Oui</option><option value="0"' + (doc.show_on_index === 0 ? " selected" : "") + '>Non</option></select></div>'
      + '</div>';

  var courseFields = (kind === "article" && doc.type === "course")
    ? '<div class="field-grid">'
        + '<div class="field"><label>Type de cours</label><select id="f-subtype">'
          + '<option value="external"' + (doc.subtype !== "authored" ? " selected" : "") + '>Notes prises sur une plateforme</option>'
          + '<option value="authored"' + (doc.subtype === "authored" ? " selected" : "") + '>Cours que je conçois</option>'
        + '</select></div>'
      + '</div>'
      + '<div class="field-grid" id="courseSourceFields">'
        + '<div class="field"><label>Plateforme</label><input type="text" id="f-source-platform" placeholder="ex. Google ML Crash Course" value="' + esc(doc.source_platform||"") + '"></div>'
        + '<div class="field"><label>Lien de la source</label><input type="text" id="f-source-url" placeholder="https://\u2026" value="' + esc(doc.source_url||"") + '"></div>'
        + '<div class="field"><label>Progression (%)</label><input type="number" id="f-progress" min="0" max="100" value="' + (doc.progress||0) + '"></div>'
      + '</div>'
    : "";

  var dateChips = '<div class="date-chips">'
      + '<div class="date-chip"><div class="l">Création</div><div class="v">' + esc(doc.created_label || "à la création") + '</div></div>'
      + '<div class="date-chip"><div class="l">Dernière modification \uD83D\uDD12</div><div class="v">' + esc(doc.updated_label || "automatique") + '</div></div>'
    + '</div>';

  var delBtn = doc.id ? '<button type="button" class="btn btn-danger" id="delBtn">Supprimer</button>' : "";

  root.innerHTML =
    '<div class="editor">'
    + '<input type="text" class="title-in" id="f-title" placeholder="' + (kind === "article" ? "Titre\u2026" : "Titre de la page\u2026") + '" value="' + esc(doc.title||"") + '">'
    + metaFields + courseFields + dateChips + coverField
    + '<div class="tabs"><button type="button" id="tabWrite" class="on">Écrire</button><button type="button" id="tabPrev">Aperçu</button></div>'
    + '<div id="writePane"><div class="blocks" id="blocks-list"></div>'
      + '<div class="add-block"><div class="lab">Ajouter un bloc</div><div class="add-grid" id="addGrid">'
        + TYPES.map(function(x){ return '<button type="button" data-add="' + x.t + '"><span class="gi">' + x.gi + '</span>' + x.label + '</button>'; }).join("")
      + '</div></div></div>'
    + '<div id="prevPane" class="prose hidden" style="margin-top:6px"></div>'
    + '<div class="editor-actions">'
      + '<button type="button" class="btn btn-primary" id="saveBtn">' + (doc.id ? "Enregistrer" : "Publier") + '</button>'
      + '<a class="btn btn-ghost" href="' + esc(cfg.cancelUrl || "/admin") + '">Annuler</a>'
      + '<span class="spacer"></span>' + delBtn
    + '</div></div>';

  var listEl = $("#blocks-list");

  if(kind === "article" && doc.type === "course"){
    var subtypeSel = $("#f-subtype"), courseSrc = $("#courseSourceFields");
    var syncCourseFields = function(){ if(courseSrc) courseSrc.classList.toggle("hidden", !!(subtypeSel && subtypeSel.value === "authored")); };
    if(subtypeSel) subtypeSel.addEventListener("change", syncCourseFields);
    syncCourseFields();
  }

  function blockBody(b){
    if(b.type === "heading"){
      return '<div class="mini"><select data-f="level"><option value="2"' + (b.level !== 3 ? " selected" : "") + '>Titre H2</option><option value="3"' + (b.level === 3 ? " selected" : "") + '>Sous-titre H3</option></select></div>'
        + '<input type="text" data-f="text" placeholder="Texte du titre" value="' + esc(b.text||"") + '">';
    }
    if(b.type === "text"){
      return '<textarea class="text" data-f="text" placeholder="Écrivez\u2026 (**gras**, *italique*, `code`, [lien](url), $formule$, listes avec -)">' + esc(b.text||"") + '</textarea>'
        + '<div class="hint">Une ligne vide sépare deux paragraphes.</div>';
    }
    if(b.type === "quote"){ return '<textarea class="text" data-f="text" placeholder="Citation\u2026">' + esc(b.text||"") + '</textarea>'; }
    if(b.type === "code"){
      return '<div class="mini"><input type="text" data-f="lang" placeholder="langage (python, js\u2026)" value="' + esc(b.lang||"") + '"></div>'
        + '<textarea class="mono" data-f="code" spellcheck="false" placeholder="Collez votre code ici">' + esc(b.code||"") + '</textarea>';
    }
    if(b.type === "formula"){
      return '<div class="mini"><select data-f="mode"><option value="block"' + (b.mode !== "inline" ? " selected" : "") + '>En bloc (centré)</option><option value="inline"' + (b.mode === "inline" ? " selected" : "") + '>En ligne</option></select></div>'
        + '<textarea class="mono" data-f="tex" spellcheck="false" placeholder="Formule LaTeX, ex. \\int_0^1 x^2\\,dx">' + esc(b.tex||"") + '</textarea>'
        + '<div class="hint">Syntaxe LaTeX (KaTeX). Pas besoin des $.</div>';
    }
    if(b.type === "image"){
      var prev = b.url ? '<div class="blk-img-prev"><img src="' + esc(b.url) + '" alt=""></div>' : "";
      return '<input type="file" accept="image/*" data-f="file" class="hidden">'
        + '<div class="mini"><button type="button" class="btn btn-ghost btn-sm" data-pick="1">' + (b.url ? "Remplacer l\u2019image" : "Choisir une image") + '</button></div>'
        + '<input type="text" data-f="caption" placeholder="Légende (facultatif)" value="' + esc(b.caption||"") + '">'
        + '<div class="blk-img-host">' + prev + '</div>';
    }
    return "";
  }
  function blockCard(b){
    var info = typeLabel(b.type);
    return '<div class="blk" data-id="' + b._id + '">'
      + '<div class="blk-head"><span class="bt"><span class="gi">' + info.gi + '</span>' + info.label + '</span><span class="sp"></span>'
        + '<button type="button" data-act="up" title="Monter">\u2191</button>'
        + '<button type="button" data-act="down" title="Descendre">\u2193</button>'
        + '<button type="button" data-act="del" class="del" title="Supprimer">\u2715</button>'
      + '</div><div class="blk-body">' + blockBody(b) + '</div></div>';
  }
  function renderBlocks(){
    if(!doc.blocks.length){
      listEl.innerHTML = '<div class="hint" style="padding:18px; text-align:center; border:1.5px dashed var(--line); border-radius:var(--r); background:var(--field)">Aucun bloc pour l\u2019instant. Ajoutez-en un ci-dessous.</div>';
      return;
    }
    listEl.innerHTML = doc.blocks.map(blockCard).join("");
  }
  function findBlock(id){ for(var i=0;i<doc.blocks.length;i++) if(doc.blocks[i]._id === id) return i; return -1; }

  function syncFromDom(){
    $all(".blk", listEl).forEach(function(card){
      var idx = findBlock(card.getAttribute("data-id"));
      if(idx < 0) return;
      var b = doc.blocks[idx];
      $all("[data-f]", card).forEach(function(inp){
        var f = inp.getAttribute("data-f");
        if(f === "file") return;
        if(f === "level"){ b.level = parseInt(inp.value, 10) || 2; }
        else if(f === "mode"){ b.mode = inp.value; }
        else { b[f] = inp.value; }
      });
    });
  }
  function addBlock(type){
    syncFromDom();
    var b = { type:type, _id:"b" + (uid++) };
    if(type === "heading"){ b.level = 2; b.text = ""; }
    else if(type === "text" || type === "quote"){ b.text = ""; }
    else if(type === "code"){ b.lang = ""; b.code = ""; }
    else if(type === "formula"){ b.mode = "block"; b.tex = ""; }
    else if(type === "image"){ b.url = ""; b.caption = ""; }
    doc.blocks.push(b);
    renderBlocks();
    var card = listEl.querySelector('.blk[data-id="' + b._id + '"]');
    if(card){ card.scrollIntoView({ block:"center", behavior:"smooth" }); var fi = card.querySelector("textarea,input[type=text]"); if(fi) fi.focus(); }
  }

  listEl.addEventListener("click", function(e){
    var pick = e.target.closest("[data-pick]");
    if(pick){ var c0 = pick.closest(".blk"); var fin = c0.querySelector('input[data-f="file"]'); if(fin) fin.click(); return; }
    var btn = e.target.closest("[data-act]");
    if(!btn) return;
    var card = btn.closest(".blk"), idx = findBlock(card.getAttribute("data-id"));
    if(idx < 0) return;
    syncFromDom();
    var act = btn.getAttribute("data-act");
    if(act === "del"){ doc.blocks.splice(idx, 1); renderBlocks(); }
    else if(act === "up" && idx > 0){ var t = doc.blocks[idx-1]; doc.blocks[idx-1] = doc.blocks[idx]; doc.blocks[idx] = t; renderBlocks(); }
    else if(act === "down" && idx < doc.blocks.length - 1){ var t2 = doc.blocks[idx+1]; doc.blocks[idx+1] = doc.blocks[idx]; doc.blocks[idx] = t2; renderBlocks(); }
  });
  listEl.addEventListener("change", function(e){
    var inp = e.target.closest('input[data-f="file"]');
    if(!inp || !inp.files || !inp.files[0]) return;
    var card = inp.closest(".blk"), idx = findBlock(card.getAttribute("data-id"));
    if(idx < 0) return;
    uploadFile(inp.files[0], function(url){
      doc.blocks[idx].url = url;
      var host = card.querySelector(".blk-img-host");
      if(host) host.innerHTML = '<div class="blk-img-prev"><img src="' + esc(url) + '" alt=""></div>';
      var pb = card.querySelector("[data-pick]"); if(pb) pb.textContent = "Remplacer l\u2019image";
      toast("Image ajoutée");
    });
  });
  $("#addGrid").addEventListener("click", function(e){ var b = e.target.closest("[data-add]"); if(b) addBlock(b.getAttribute("data-add")); });

  if(kind === "article"){
    var coverInner = $("#coverInner"), coverInput = $("#coverInput");
    function paintCover(){
      if(doc.cover){
        coverInner.innerHTML = '<img src="' + esc(doc.cover) + '" alt=""><button type="button" class="rm" id="coverRm">\u2715</button>';
        $("#coverRm").addEventListener("click", function(ev){ ev.stopPropagation(); doc.cover = ""; paintCover(); });
      } else { coverInner.innerHTML = '<div class="ph">\uD83D\uDDBC\uFE0F&nbsp; Ajouter une image de couverture</div>'; }
    }
    paintCover();
    $("#coverDrop").addEventListener("click", function(){ coverInput.click(); });
    coverInput.addEventListener("change", function(){ if(coverInput.files && coverInput.files[0]) uploadFile(coverInput.files[0], function(url){ doc.cover = url; paintCover(); toast("Couverture ajoutée"); }); });
  }

  $("#tabWrite").addEventListener("click", function(){ setTab(false); });
  $("#tabPrev").addEventListener("click", function(){ setTab(true); });
  function setTab(preview){
    $("#tabWrite").classList.toggle("on", !preview);
    $("#tabPrev").classList.toggle("on", preview);
    $("#writePane").classList.toggle("hidden", preview);
    $("#prevPane").classList.toggle("hidden", !preview);
    if(preview){
      syncFromDom();
      var pane = $("#prevPane");
      pane.innerHTML = renderDocHtml(doc.blocks) || '<p class="hint">Rien à prévisualiser pour l\u2019instant.</p>';
      renderMath(pane); highlightAll(pane);
    }
  }

  $("#saveBtn").addEventListener("click", function(){
    syncFromDom();
    var title = ($("#f-title").value||"").trim();
    if(!title){ toast("Donnez un titre."); $("#f-title").focus(); return; }
    var payload = { id: doc.id || null, title: title, blocks: cleanBlocks(doc.blocks), slug: ($("#f-slug").value||"").trim() };
    if(kind === "article"){
      payload.type = doc.type || "blog";
      payload.category = ($("#f-category").value||"").trim();
      payload.status = $("#f-status").value;
      payload.featured = parseInt($("#f-featured").value, 10) || 0;
      payload.cover = doc.cover || "";
      if(payload.type === "course"){
        payload.subtype = $("#f-subtype") ? $("#f-subtype").value : "external";
        payload.source_platform = $("#f-source-platform") ? ($("#f-source-platform").value||"").trim() : "";
        payload.source_url = $("#f-source-url") ? ($("#f-source-url").value||"").trim() : "";
        payload.progress = $("#f-progress") ? Math.max(0, Math.min(100, parseInt($("#f-progress").value, 10) || 0)) : 0;
      }
    } else {
      payload.in_nav = parseInt($("#f-nav").value, 10);
      payload.show_on_index = parseInt($("#f-index").value, 10);
    }
    var btn = $("#saveBtn"); btn.disabled = true; var prev = btn.textContent; btn.textContent = "Enregistrement\u2026";
    fetch(cfg.saveUrl, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) })
      .then(function(r){ return r.json(); })
      .then(function(d){ if(d && d.ok){ location.href = d.viewUrl || cfg.cancelUrl || "/admin"; } else { toast((d && d.error) || "Enregistrement impossible."); btn.disabled = false; btn.textContent = prev; } })
      .catch(function(){ toast("Erreur réseau."); btn.disabled = false; btn.textContent = prev; });
  });

  function cleanBlocks(blocks){
    return blocks.map(function(b){
      var o = { type:b.type };
      if(b.type === "heading"){ o.level = b.level === 3 ? 3 : 2; o.text = b.text||""; }
      else if(b.type === "text" || b.type === "quote"){ o.text = b.text||""; }
      else if(b.type === "code"){ o.lang = b.lang||""; o.code = b.code||""; }
      else if(b.type === "formula"){ o.mode = b.mode === "inline" ? "inline" : "block"; o.tex = b.tex||""; }
      else if(b.type === "image"){ o.url = b.url||""; o.caption = b.caption||""; }
      return o;
    }).filter(function(o){
      if(o.type === "image") return !!o.url;
      if(o.type === "heading" || o.type === "text" || o.type === "quote") return (o.text||"").trim().length > 0;
      if(o.type === "code") return (o.code||"").trim().length > 0;
      if(o.type === "formula") return (o.tex||"").trim().length > 0;
      return true;
    });
  }

  if(doc.id){
    $("#delBtn").addEventListener("click", function(){
      if(!confirm("Supprimer définitivement ?")) return;
      fetch(cfg.deleteUrl, { method:"POST", headers:{ "Content-Type":"application/json" }, body:"{}" })
        .then(function(r){ return r.json(); })
        .then(function(d){ if(d && d.ok){ location.href = cfg.cancelUrl || "/admin"; } else { toast("Suppression impossible."); } })
        .catch(function(){ toast("Erreur réseau."); });
    });
  }

  renderBlocks();
})();
