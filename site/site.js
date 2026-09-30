// Commun aux pages de la vitrine : l'en-tête collant et le menu « Fonctionnalités ».
(function () {
  // L'en-tête prend son fond dès que la sentinelle du haut de page sort de l'écran (jamais d'écouteur de défilement).
  var barre = document.querySelector('.barre'), sentinelle = document.querySelector('.sentinelle');
  if (barre && sentinelle) {
    if (!('IntersectionObserver' in window)) barre.classList.add('defile');
    else new IntersectionObserver(function (e) { barre.classList.toggle('defile', !e[0].isIntersecting); }).observe(sentinelle);
  }
  // Le menu est un <details> : il s'ouvre et se ferme sans script, au clavier compris. Ceci le referme seulement
  // au clic hors du menu, et à Échap en rendant le focus à son bouton.
  var menus = [].slice.call(document.querySelectorAll('details.menu'));
  document.addEventListener('click', function (e) {
    menus.forEach(function (m) { if (m.open && !m.contains(e.target)) m.open = false; });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    menus.forEach(function (m) { if (m.open) { m.open = false; m.querySelector('summary').focus(); } });
  });
})();

// Pages fonctionnalités. Chaque bloc ne fait rien si la page n'a pas l'élément qu'il vise.
(function () {
  if (!('IntersectionObserver' in window)) return;
  var calme = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Le film part, muet, quand il est à moitié à l'écran, et s'arrête quand il en sort. Pour qui a demandé moins
  // de mouvement, rien ne démarre seul : les commandes restent là.
  document.querySelectorAll('.f-video').forEach(function (v) {
    if (calme) return;
    new IntersectionObserver(function (e) {
      if (e[0].isIntersecting) { v.muted = true; var p = v.play(); if (p && p.catch) p.catch(function () {}); }
      else if (!v.paused) v.pause();
    }, { threshold: 0.5 }).observe(v);
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

// Page contact. Le formulaire part SANS script (formulaire HTML natif, l'API répond par une redirection) ; ceci
// ajoute seulement le message d'erreur au retour, le brouillon gardé le temps de l'onglet, et le bouton désactivé
// pendant l'envoi. Le stockage peut être refusé (navigation privée) : tout est dans des try.
(function () {
  var CLE = 'engageme-contact';
  if (document.querySelector('.c-merci')) { try { sessionStorage.removeItem(CLE); } catch (e) {} return; }
  var form = document.querySelector('form.c-form');
  if (!form) return;
  var champs = [].slice.call(form.querySelectorAll('input[name]:not([name="site"]), textarea[name]'));
  try {
    var brouillon = JSON.parse(sessionStorage.getItem(CLE) || '{}');
    champs.forEach(function (c) { if (typeof brouillon[c.name] === 'string' && !c.value) c.value = brouillon[c.name]; });
  } catch (e) {}
  // Venu d'un bouton « Demander une démo » : le message est pré-rempli avec la fonctionnalité, si rien n'est déjà
  // écrit. Seules les quatre pages connues : aucun texte n'est recopié de l'adresse.
  var DEMOS = {
    'publicites-click-to-whatsapp': 'Publicités Click-to-WhatsApp',
    'chaines-whatsapp': 'Chaînes WhatsApp',
    'conversations-en-actions': 'Analyse de conversations',
    'whatsapp-et-rcs': 'WhatsApp et RCS'
  };
  var demo = DEMOS[new URLSearchParams(location.search).get('demo')];
  var message = form.querySelector('textarea[name="message"]');
  if (demo && message && !message.value) message.value = 'Bonjour, je souhaite une démo d’Engage Me : ' + demo + '.';
  form.addEventListener('input', function () {
    var b = {};
    champs.forEach(function (c) { b[c.name] = c.value; });
    try { sessionStorage.setItem(CLE, JSON.stringify(b)); } catch (e) {}
  });

  var MESSAGES = {
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
