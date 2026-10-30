// Commun aux pages de la vitrine : l'en-tête collant et le menu « Fonctionnalités ». Puis, page par page, ce qui ne
// sert qu'à une page (chaque bloc ne fait rien si la page n'a pas l'élément qu'il vise).
(function () {
  // L'en-tête prend son fond dès que la sentinelle du haut de page sort de l'écran (jamais d'écouteur de défilement).
  var barre = document.querySelector('.barre'), sentinelle = document.querySelector('.sentinelle');
  if (barre && sentinelle) {
    if (!('IntersectionObserver' in window)) barre.classList.add('defile');
    else new IntersectionObserver(function (e) { barre.classList.toggle('defile', !e[0].isIntersecting); }).observe(sentinelle);
  }
  // Le menu est un <details> : il s'ouvre et se ferme sans script, au clavier compris. Ceci le referme seulement
  // au clic hors du menu, et à Échap en rendant le focus à son bouton.
  var menus = [].slice.call(document.querySelectorAll('details.menu, details.burger'));
  document.addEventListener('click', function (e) {
    var lien = e.target.closest && e.target.closest('a[href]');
    menus.forEach(function (m) { if (m.open && (!m.contains(e.target) || lien)) m.open = false; });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    menus.forEach(function (m) { if (m.open) { m.open = false; m.querySelector('summary').focus(); } });
  });
})();

// La 404 sert toutes les adresses : sous /en/, elle montre son texte anglais (qui porte son propre lang="en" : l'en-tête
// et le pied, eux, restent français) et son titre anglais.
(function () {
  var en = document.querySelector('[data-langue="en"]'), fr = document.querySelector('[data-langue="fr"]');
  if (!en || !fr || location.pathname.indexOf('/en/') !== 0) return;
  fr.hidden = true; en.hidden = false;
  document.title = 'Page not found · Messaging Me';
})();

// Pages fonctionnalités. Chaque bloc ne fait rien si la page n'a pas l'élément qu'il vise.
(function () {
  // Au téléphone, un film qui a une version verticale (data-vertical) la prend, avec son affiche. Même seuil que
  // la règle « .js .f-video[data-vertical] » de site.css, qui donne au cadre sa forme dès le premier affichage.
  if (matchMedia('(max-width: 640px)').matches) {
    document.querySelectorAll('.f-video[data-vertical]').forEach(function (v) {
      v.src = v.dataset.vertical; v.poster = v.dataset.afficheVerticale;
    });
  }

  if (!('IntersectionObserver' in window)) return;
  var calme = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Le film part, muet, quand il est à moitié à l'écran, et s'arrête quand il en sort. Pour qui a demandé moins
  // de mouvement, rien ne démarre seul : les commandes restent là. Sauf un film du centre d'aide (`.aide-film`) : une
  // page qu'on rouvre souvent ne recharge pas quatre ou cinq mégaoctets à chaque visite, on le lance soi-même.
  document.querySelectorAll('.f-video:not(.aide-film)').forEach(function (v) {
    if (calme) return;
    new IntersectionObserver(function (e) {
      if (e[0].isIntersecting) { v.muted = true; var p = v.play(); if (p && p.catch) p.catch(function () {}); }
      else if (!v.paused) v.pause();
    }, { threshold: 0.5 }).observe(v);
  });

  // Les vignettes de la page chapeau : le film du cas joue au survol, s'arrête à la sortie.
  document.querySelectorAll('.hub-carte').forEach(function (a) {
    var v = a.querySelector('.hub-mini');
    if (!v || calme) return;
    a.addEventListener('mouseenter', function () { var p = v.play(); if (p && p.catch) p.catch(function () {}); });
    a.addEventListener('mouseleave', function () { v.pause(); });
  });

  // L'écran collant suit l'étape la plus proche du milieu de la fenêtre. On la RECALCULE à chaque signal plutôt
  // que de suivre le franchissement d'une ligne : un saut (ancre, retour en haut) ne laisse pas d'état périmé.
  document.querySelectorAll('.f-pas').forEach(function (bloc) {
    var etapes = [].slice.call(bloc.querySelectorAll('.f-etape')), images = [].slice.call(bloc.querySelectorAll('.f-ecran img'));
    var courant = 0;
    var choisir = function () {
      var milieu = window.innerHeight / 2, meilleur = 0, ecart = Infinity;
      etapes.forEach(function (li, k) {
        var r = li.getBoundingClientRect(), d = Math.abs((r.top + r.bottom) / 2 - milieu);
        if (d < ecart) { ecart = d; meilleur = k; }
      });
      if (meilleur === courant) return;
      courant = meilleur;
      etapes.forEach(function (li, k) { li.classList.toggle('actif', k === courant); });
      images.forEach(function (img, k) { img.classList.toggle('actif', k === courant); });
    };
    var seuils = [];
    for (var s = 0; s <= 20; s++) seuils.push(s / 20);
    var io = new IntersectionObserver(choisir, { threshold: seuils });
    etapes.forEach(function (li) { io.observe(li); });
  });

  // Les marches de l'entonnoir et le nombre de la page Chaînes s'animent une fois, à leur arrivée.
  var revele = new IntersectionObserver(function (entrees) {
    entrees.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('vu'); revele.unobserve(e.target); } });
  }, { threshold: 0.35 });
  document.querySelectorAll('.f-revele').forEach(function (el) { revele.observe(el); });
})();

// Page développeurs (lot 18) : le bouton « Copier » de la commande, et le terminal qui rejoue sa séance en boucle,
// SEULEMENT quand il est à l'écran. Le minutage des lignes est dans leur `--t`. Rien ne tourne pour qui a demandé
// moins de mouvement : la séance y reste affichée, finie.
(function () {
  // Le bouton ne se montre que si le navigateur sait copier ; le résultat, réussi ou non, est dit au bouton et à la
  // zone de statut qui le suit, pour un lecteur d'écran.
  document.querySelectorAll('.dev-copier').forEach(function (b) {
    var cible = document.getElementById(b.getAttribute('aria-controls')), libelle = b.textContent;
    var statut = b.nextElementSibling && b.nextElementSibling.classList.contains('dev-statut') ? b.nextElementSibling : null;
    if (!cible || !navigator.clipboard) return;
    b.classList.add('pret');
    var dire = function (texte) {
      b.textContent = texte;
      if (statut) statut.textContent = texte;
      setTimeout(function () { b.textContent = libelle; if (statut) statut.textContent = ''; }, 2000);
    };
    b.addEventListener('click', function () {
      navigator.clipboard.writeText(cible.textContent.trim()).then(function () { dire(b.dataset.copie); }, function () { dire(b.dataset.echec); });
    });
  });

  // Le terminal défile comme un vrai : chaque entrée apparaît à son `--t`, et la fenêtre suit la dernière ligne.
  // Sans IntersectionObserver, ou pour qui a demandé moins de mouvement, la séance est affichée finie, la fenêtre
  // descendue sur sa fin (la balise de la bulle).
  var t = document.querySelector('.dev-terminal');
  if (!t) return;
  var fil = t.querySelector('.cc-fil'), entrees = [].slice.call(t.querySelectorAll('.dev-seance > li'));
  var enBas = function (doux) { if (fil) fil.scrollTo({ top: fil.scrollHeight, behavior: doux ? 'smooth' : 'auto' }); };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
    t.classList.add('statique'); enBas(false); return;
  }
  var quand = function (li) { return (parseFloat(li.style.getPropertyValue('--t')) || 0) * 1000; };
  var fin = Math.max.apply(null, entrees.map(quand));
  var minuteries = [], actif = false;
  function arreter() { minuteries.forEach(clearTimeout); minuteries = []; }
  function tour() {
    arreter();
    t.classList.remove('sortie', 'fini');
    entrees.forEach(function (li) { li.classList.remove('vu'); });
    t.classList.add('joue');
    enBas(false);
    entrees.forEach(function (li) {
      minuteries.push(setTimeout(function () { li.classList.add('vu'); enBas(true); }, quand(li)));
    });
    minuteries.push(setTimeout(function () { t.classList.add('fini'); }, fin + 400));
    minuteries.push(setTimeout(function () { t.classList.add('sortie'); }, fin + 4600));
    minuteries.push(setTimeout(tour, fin + 5200));
  }
  new IntersectionObserver(function (e) {
    if (e[0].isIntersecting && !actif) { actif = true; tour(); }
    else if (!e[0].isIntersecting && actif) { actif = false; arreter(); }
  }, { threshold: 0.25 }).observe(t);
})();

// Page contact. Le formulaire part SANS script (formulaire HTML natif, l'API répond par une redirection) ; ceci
// ajoute seulement le message d'erreur au retour, le brouillon gardé le temps de l'onglet, et le bouton désactivé
// pendant l'envoi. Le stockage peut être refusé (navigation privée) : tout est dans des try.
(function () {
  // Un brouillon PAR formulaire : le contact et le livre blanc ont des champs du même nom (`nom`, `email`) qui ne
  // veulent pas dire la même chose (« Nom et prénom » d'un côté, le nom de famille de l'autre).
  var CLES = ['engageme-contact', 'engageme-livre-blanc'];
  if (document.querySelector('.c-merci')) { try { CLES.forEach(function (k) { sessionStorage.removeItem(k); }); } catch (e) {} return; }
  var form = document.querySelector('form.c-form');
  if (!form) return;
  var CLE = /\/vitrine\/livre-blanc$/.test(form.getAttribute('action') || '') ? CLES[1] : CLES[0];
  var champs = [].slice.call(form.querySelectorAll('input[name]:not([name="site"]), textarea[name]'));
  // Une case se garde par `checked`, jamais par sa valeur (toujours « oui ») : sinon un retour en erreur la décoche,
  // et le visiteur qui avait accepté WhatsApp repart sans, sans le voir.
  try {
    var brouillon = JSON.parse(sessionStorage.getItem(CLE) || '{}');
    champs.forEach(function (c) {
      if (c.type === 'checkbox') { if (typeof brouillon[c.name] === 'boolean') c.checked = brouillon[c.name]; }
      else if (typeof brouillon[c.name] === 'string' && !c.value) c.value = brouillon[c.name];
    });
  } catch (e) {}
  // Venu d'un bouton « Demander une démo » : le message est pré-rempli avec la fonctionnalité, si rien n'est déjà
  // écrit. Seules les quatre pages connues : aucun texte n'est recopié de l'adresse. La page anglaise
  // (`<html lang="en">`) a ses phrases ; les clés restent les adresses françaises, que ses liens gardent.
  var EN = document.documentElement.lang === 'en';
  var DEMOS = EN ? {
    'campagnes-et-scenarios': 'Campaigns and scenarios',
    'publicites-click-to-whatsapp': 'Click-to-WhatsApp ads',
    'chaines-whatsapp': 'WhatsApp Channels',
    'conversations-en-actions': 'Conversation analysis',
    'whatsapp-et-rcs': 'WhatsApp and RCS',
    'pilotage-des-couts': 'Cost control'
  } : {
    'campagnes-et-scenarios': 'Campagnes et scénarios',
    'publicites-click-to-whatsapp': 'Publicités Click-to-WhatsApp',
    'chaines-whatsapp': 'Chaînes WhatsApp',
    'conversations-en-actions': 'Analyse de conversations',
    'whatsapp-et-rcs': 'WhatsApp et RCS',
    'pilotage-des-couts': 'Pilotage des coûts'
  };
  var demo = DEMOS[new URLSearchParams(location.search).get('demo')];
  var message = form.querySelector('textarea[name="message"]');
  if (demo && message && !message.value) message.value = EN ? 'Hello, I would like a demo of Messaging Me: ' + demo + '.' : 'Bonjour, je souhaite une démo de Messaging Me : ' + demo + '.';
  // Venu du centre d'aide (« Une question sans réponse ? ») : le message cite l'adresse de la page. Seul un NOM de page
  // passe (lettres, chiffres, tirets), jamais un texte libre recopié de l'adresse, comme pour les démos.
  var aide = new URLSearchParams(location.search).get('aide');
  if (aide && /^[a-z0-9-]{1,80}$/.test(aide) && message && !message.value) {
    message.value = EN
      ? 'Hello, I have a question about the help page ' + location.origin + '/en/help/' + aide + '/: '
      : 'Bonjour, j’ai une question sur la page d’aide ' + location.origin + '/aide/' + aide + '/ : ';
  }
  form.addEventListener('input', function () {
    var b = {};
    champs.forEach(function (c) { b[c.name] = c.type === 'checkbox' ? c.checked : c.value; });
    try { sessionStorage.setItem(CLE, JSON.stringify(b)); } catch (e) {}
  });

  var MESSAGES = EN ? {
    champs: 'A field is missing or invalid. Check the form, then send it again.',
    trop: 'Lots of messages right now: try again in a few minutes, or write to us at ',
    envoi: 'Your message could not be sent. Try again, or write to us at '
  } : {
    champs: 'Un champ manque ou n’est pas valide. Vérifiez le formulaire, puis renvoyez-le.',
    trop: 'Beaucoup de messages en ce moment : réessayez dans quelques minutes, ou écrivez-nous à ',
    envoi: 'Votre message n’a pas pu partir. Réessayez, ou écrivez-nous à '
  };
  var code = new URLSearchParams(location.search).get('erreur');
  var zone = form.querySelector('.c-erreur');
  if (zone && MESSAGES[code]) {
    zone.textContent = MESSAGES[code];
    if (code !== 'champs') {
      var a = document.createElement('a');
      a.href = 'mailto:contact@messagingme.fr';
      a.textContent = 'contact@messagingme.fr';
      zone.appendChild(a);
      zone.appendChild(document.createTextNode('.'));
    }
    zone.hidden = false;
  }

  // Un seul envoi par clic ; le bouton revient si la page est rouverte par le bouton « Retour » du navigateur.
  var bouton = form.querySelector('button[type="submit"]');
  form.addEventListener('submit', function () { setTimeout(function () { bouton.disabled = true; }, 0); });
  window.addEventListener('pageshow', function () { bouton.disabled = false; });
})();

// Centre d'aide : le filtre du menu. La saisie passe par la même normalisation que les mots de chaque entrée
// (`motsDeRecherche`, scripts/vitrine/aide.ts) : minuscules, sans accents, sans ponctuation. Une rubrique vide se masque.
// Sur l'accueil, la même recherche filtre les cartes : le carrousel s'efface pendant qu'on cherche, et une phrase dit
// quand plus rien ne correspond.
(function () {
  var champ = document.querySelector('.aide-recherche');
  if (!champ) return;
  var normaliser = function (t) {
    // Les accents décomposés par NFD (U+0300 à U+036F), sans `\p{M}` : un navigateur sans échappement de propriété
    // Unicode refuserait d'analyser TOUT site.js, et chaque page perdrait ses scripts (relecture du lot 3).
    return t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  };
  var rubriques = [].slice.call(document.querySelectorAll('.aide-rubrique'));
  var videos = document.querySelector('.aide-videos');
  var aucun = document.querySelector('.aide-aucun');
  champ.addEventListener('input', function () {
    var mots = normaliser(champ.value).split(' ').filter(Boolean);
    var total = 0;
    rubriques.forEach(function (r) {
      var visibles = 0;
      [].slice.call(r.querySelectorAll('[data-mots]')).forEach(function (a) {
        var dedans = a.getAttribute('data-mots');
        var garde = mots.every(function (m) { return dedans.indexOf(m) >= 0; });
        a.hidden = !garde;
        if (garde) visibles++;
      });
      r.hidden = visibles === 0;
      total += visibles;
    });
    if (videos) videos.hidden = mots.length > 0;
    if (aucun) aucun.hidden = total > 0;
  });
})();

// Accueil du centre d'aide : le carrousel des films. Les boutons avancent d'un film, s'éteignent aux deux bouts ; un
// seul film joue à la fois, et celui qui sort de l'écran s'arrête.
(function () {
  var piste = document.querySelector('.aide-carrousel');
  if (!piste) return;
  var boutons = [].slice.call(document.querySelectorAll('.aide-carrousel-bouton'));
  var pas = function () {
    var diapo = piste.querySelector('.aide-diapo');
    return diapo ? diapo.getBoundingClientRect().width + (parseFloat(getComputedStyle(piste).columnGap) || 0) : piste.clientWidth;
  };
  var bornes = function () {
    boutons.forEach(function (b) {
      b.disabled = b.getAttribute('data-sens') === '-1'
        ? piste.scrollLeft <= 1
        : piste.scrollLeft + piste.clientWidth >= piste.scrollWidth - 1;
    });
  };
  boutons.forEach(function (b) {
    b.addEventListener('click', function () {
      piste.scrollBy({ left: Number(b.getAttribute('data-sens')) * pas(), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    });
  });
  piste.addEventListener('scroll', bornes, { passive: true });
  window.addEventListener('resize', bornes);
  bornes();
  var films = [].slice.call(piste.querySelectorAll('video'));
  films.forEach(function (v) {
    v.addEventListener('play', function () { films.forEach(function (f) { if (f !== v && !f.paused) f.pause(); }); });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (e) { if (!e[0].isIntersecting && !v.paused) v.pause(); }, { threshold: 0.3 }).observe(v);
    }
  });
})();

// Le tunnel du numéro WhatsApp (la page « Démarrer », Boutiques Shopify, SaaS) : l'arbre de Julien (2026-10-30). Sans script,
// les questions restent cachées et toutes les issues se lisent en liste, chacune avec la situation qu'elle sert et les
// boutons de chaque offre. Avec lui, la question en cours s'affiche en grand sous l'étape et sa jauge ; chaque réponse
// (`data-vers`) replie sa question en une ligne (sa réponse dans `data-resume`) et montre la suivante ou une issue ; la
// réponse qui choisit l'offre (`data-offre`) ne laisse aux issues que les boutons de cette offre ; « Modifier » rouvre une
// question et efface tout ce qui la suivait ; une réponse sans `data-vers` (« Je ne sais pas ») déplie l'aide de sa
// question ; « Copier » met la demande à coller dans Claude Code dans le presse-papiers ; un lien d'issue
// (`data-vers-chemin`) montre une autre issue ; `?offre=free` ou `?offre=pro` dans l'adresse (les offres de la page Tarifs)
// répond à la première question à l'ouverture, sans prendre le focus.
(function () {
  [].slice.call(document.querySelectorAll('[data-guide-numero]')).forEach(function (g) {
    var questions = g.querySelector('.bt-questions');
    var recommencer = g.querySelector('[data-recommencer]');
    var premiere = g.querySelector('[data-question]');
    var chemins = [].slice.call(g.querySelectorAll('.bt-chemin'));
    var progression = g.querySelector('[data-progression]');
    if (!questions || !recommencer || !premiere) return;
    var parcours = [premiere];
    // Le tunnel : « Question n », sa jauge sur le plus long parcours (`data-max`, calculé depuis l'arbre), l'issue en
    // dernière étape ; puis « Votre chemin » et la jauge pleine.
    var avancer = function (fin) {
      if (!progression) return;
      var max = Number(progression.getAttribute('data-max')) || 1;
      progression.hidden = false;
      progression.querySelector('[data-etape]').textContent = fin
        ? progression.getAttribute('data-fin')
        : progression.getAttribute('data-progression').replace('{n}', String(parcours.length));
      progression.querySelector('[data-jauge]').style.width = (fin ? 100 : Math.min(parcours.length, max) / (max + 1) * 100) + '%';
    };
    var montrer = function (cle) {
      chemins.forEach(function (c) { c.classList.toggle('actif', c.getAttribute('data-chemin') === cle); });
    };
    var effacer = function (q) {
      q.classList.remove('repondue');
      var resume = q.querySelector('[data-resume]');
      if (resume) resume.textContent = '';
      // La question de l'offre rouverte : plus d'offre choisie, les issues retrouvent les boutons des deux.
      if (q.querySelector('[data-offre]')) g.removeAttribute('data-offre');
      [].slice.call(q.querySelectorAll('[data-vers]')).forEach(function (b) { b.setAttribute('aria-pressed', 'false'); });
      var aide = q.querySelector('.bt-aide');
      var bouton = q.querySelector('[data-aide]');
      if (aide) aide.hidden = true;
      if (bouton) bouton.setAttribute('aria-expanded', 'false');
      [].slice.call(q.querySelectorAll('.bt-note-reponse')).forEach(function (n) { n.hidden = true; });
    };
    // Retire du parcours tout ce qui suit la question `q` : une réponse changée plus haut ouvre une autre branche.
    var couper = function (q) {
      parcours.splice(parcours.indexOf(q) + 1).forEach(function (x) { x.hidden = true; effacer(x); });
      montrer(null);
    };
    questions.hidden = false;
    g.setAttribute('data-pret', '');
    avancer(false);
    // « Copier » n'a de sens qu'avec le script : sans lui, la demande se sélectionne à la main.
    [].slice.call(g.querySelectorAll('[data-copier]')).forEach(function (b) { b.hidden = false; });
    var selectionner = function (cible) {
      var plage = document.createRange();
      plage.selectNodeContents(cible);
      var choix = window.getSelection();
      choix.removeAllRanges();
      choix.addRange(plage);
    };
    // Une réponse donnée : sa question se replie, la suivante (ou l'issue) s'affiche. `focus` vaut faux à l'ouverture de la
    // page, quand l'adresse choisit l'offre : le focus et le défilement restent au visiteur.
    var repondre = function (b, q, focus) {
      var vers = b.getAttribute('data-vers');
      couper(q);
      [].slice.call(q.querySelectorAll('[data-vers]')).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      // Une réponse peut porter une note (où vérifier son compte Meta Business) : seule la sienne s'affiche.
      [].slice.call(q.querySelectorAll('.bt-note-reponse')).forEach(function (n) { n.hidden = n.id !== b.getAttribute('data-note'); });
      if (b.hasAttribute('data-offre')) g.setAttribute('data-offre', b.getAttribute('data-offre'));
      // La question répondue se replie en une ligne (la question, la réponse, « Modifier ») : la suivante prend la place.
      q.classList.add('repondue');
      var resume = q.querySelector('[data-resume]');
      if (resume) resume.textContent = b.textContent;
      var aideOuverte = q.querySelector('.bt-aide');
      if (aideOuverte) aideOuverte.hidden = true;
      recommencer.hidden = false;
      var suivante = g.querySelector('[data-question="' + vers + '"]');
      if (suivante) {
        // Une question partagée par deux branches suit celle qui y mène : on l'affiche à la suite du parcours, avant
        // « Recommencer », quel que soit son rang dans la page.
        questions.insertBefore(suivante, recommencer);
        suivante.hidden = false;
        parcours.push(suivante);
        avancer(false);
        // La question suivante apparaît : le focus va à sa première réponse, qu'un lecteur d'écran l'entende.
        if (focus) suivante.querySelector('[data-vers]').focus();
      } else {
        montrer(vers);
        avancer(true);
        if (!focus) return;
        // L'issue est la fin du tunnel : le focus va au premier bouton de l'offre choisie, et elle se montre en entier.
        var issue = g.querySelector('[data-chemin="' + vers + '"]');
        var bouton = issue && issue.querySelector('.bt-appels[data-offre="' + g.getAttribute('data-offre') + '"] a');
        if (bouton) bouton.focus({ preventScroll: true });
        var doux = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        if (issue) issue.scrollIntoView({ block: 'nearest', behavior: doux ? 'smooth' : 'auto' });
      }
    };
    g.addEventListener('click', function (e) {
      var copier = e.target.closest && e.target.closest('[data-copier]');
      if (copier) {
        var demande = document.getElementById(copier.getAttribute('data-copier'));
        if (!demande) return;
        var copie = function () { copier.textContent = copier.getAttribute('data-copie'); };
        // Sans presse-papiers (page non sécurisée, refus du navigateur), la demande se sélectionne : un Ctrl+C suffit.
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(demande.textContent).then(copie, function () { selectionner(demande); });
        } else {
          selectionner(demande);
        }
        return;
      }
      // « Modifier » rouvre une réponse donnée : tout ce qui la suivait s'efface, le tunnel revient à cette question.
      var modifier = e.target.closest && e.target.closest('[data-modifier]');
      if (modifier) {
        var rouverte = modifier.closest('[data-question]');
        couper(rouverte);
        effacer(rouverte);
        if (rouverte === premiere) recommencer.hidden = true;
        avancer(false);
        rouverte.querySelector('[data-vers]').focus();
        return;
      }
      var aide = e.target.closest && e.target.closest('[data-aide]');
      if (aide) {
        var texte = aide.closest('[data-question]').querySelector('.bt-aide');
        if (texte) texte.hidden = !texte.hidden;
        aide.setAttribute('aria-expanded', String(Boolean(texte) && !texte.hidden));
        return;
      }
      var b = e.target.closest && e.target.closest('[data-vers]');
      if (b) {
        var q = b.closest('[data-question]');
        // Une question répondue ne se rouvre que par « Modifier » : sa réponse repliée est inerte, au clavier aussi.
        if (!q.classList.contains('repondue')) repondre(b, q, true);
        return;
      }
      // Un lien d'issue vers une autre (« Vous pouvez la garder ») : l'autre issue prend sa place, son premier bouton le focus.
      var lien = e.target.closest && e.target.closest('[data-vers-chemin]');
      if (lien) {
        e.preventDefault();
        var cle = lien.getAttribute('data-vers-chemin');
        montrer(cle);
        var autre = g.querySelector('[data-chemin="' + cle + '"]');
        var premier = autre && autre.querySelector('.bt-appels[data-offre="' + g.getAttribute('data-offre') + '"] a');
        if (premier) premier.focus({ preventScroll: true });
        if (autre) autre.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (e.target.closest && e.target.closest('[data-recommencer]')) {
        couper(premiere);
        effacer(premiere);
        recommencer.hidden = true;
        avancer(false);
        // « Recommencer » se cache : le focus revient à la première question plutôt que de se perdre.
        premiere.querySelector('[data-vers]').focus();
      }
    });
    var offre = (location.search.match(/[?&]offre=(free|pro)(?:&|$)/) || [])[1];
    var choisie = offre && premiere.querySelector('[data-vers][data-offre="' + offre + '"]');
    if (choisie) repondre(choisie, premiere, false);
  });
})();
