import type { PositionWidget } from './store.pg';

/**
 * Le JavaScript de la bulle WhatsApp, servi par `GET /widget/<code>.js` (lot 2 de
 * docs/superpowers/plans/2026-10-02-widget-whatsapp.md). Module PUR : il reçoit ce qui est déjà résolu et rend
 * une chaîne, sans base, sans réseau, sans horloge.
 *
 * 🔴 IL REÇOIT UNE LISTE EXPLICITE DE CHAMPS, JAMAIS UN `WidgetRow`. La ligne de la base porte l'espace, l'agent,
 * le scénario et le plafond horaire : un spread les publierait dans un script que n'importe qui lit. La route
 * construit cette configuration champ par champ, et ce module construit ses données de la même façon.
 *
 * 🔴 LA PAGE QUI EXÉCUTE CE SCRIPT EST CELLE DU CLIENT. Toute valeur y entre comme une DONNÉE, sérialisée en JSON
 * (`enJson`), et se pose par une propriété du DOM (`textContent`, `src`, `href`, `style.backgroundColor`), jamais
 * par `innerHTML` ni par concaténation dans du HTML ou du CSS. Le CHECK `^https://` de l'avatar ferme
 * `javascript:` et `data:`, pas les guillemets ni les chevrons : c'est cette règle qui ferme le reste. La feuille
 * de style est une constante, sans aucune valeur venue de la base.
 */

/** Ce que la bulle propose quand le numéro répond. */
export interface ScriptServi {
  etat: 'servi';
  /** Le lien `wa.me` fabriqué par `lienWaMe` : jamais refabriqué ici, ni dans le navigateur. */
  lien: string;
  /** Le QR code du même lien, en SVG, généré côté serveur. null = le panneau ne montre que le lien. */
  svgQr: string | null;
  /** Six chiffres hexadécimaux, garantis par le CHECK `widgets_couleur_chk`. */
  couleur: string;
  position: PositionWidget;
  libelle: string | null;
  avatarUrl: string | null;
  badge: boolean;
}

/**
 * Le numéro ne répond plus (aucun numéro, ou numéro délié) : la bulle reste à sa place, grisée, sans clic. Elle ne
 * publie alors ni lien, ni phrase, ni libellé : un visiteur ne doit rien pouvoir envoyer à un numéro muet.
 */
export interface ScriptGrise {
  etat: 'grise';
  position: PositionWidget;
}

export type ConfigScript = ScriptServi | ScriptGrise;

/**
 * Ce que rend la route quand il n'y a RIEN à afficher : code inconnu, mal formé ou vide, widget éteint, lecture en
 * panne. Une seule réponse pour tous ces cas : un visiteur n'a pas à distinguer « ce widget n'existe pas » de « il
 * est éteint », et un code inventé n'apprend rien. Un commentaire, donc rien ne s'exécute. Court, et il le reste :
 * l'auto-attaque le compare octet pour octet, sur un corps qu'elle tronque à 300 caractères.
 */
export const SCRIPT_INERTE = '/* Messaging Me : aucune bulle à afficher pour ce code. */\n';

/** Le texte de la bulle grisée, en `title` et `aria-label` seulement : aucun texte visible au premier lot. */
export const TEXTE_INDISPONIBLE = 'Messagerie WhatsApp momentanément indisponible';

/**
 * Une valeur JSON, sûre à écrire dans un script. `<` s'écrit en séquence d'échappement Unicode (ni `</script>` ni
 * `<!--` ne survivent si quelqu'un colle ce script en ligne dans sa page), U+2028 et U+2029 aussi (des fins de
 * ligne pour les moteurs antérieurs à ES2019, qui couperaient la chaîne en deux).
 *
 * ⚠️ Les deux séparateurs sont désignés par leur code (`String.fromCharCode`), pas par un échappement dans une
 * expression régulière : un outil d'écriture qui convertit les échappements en caractères les rendrait invisibles,
 * et une fin de ligne au milieu d'une expression régulière ne compile plus.
 */
const SEPARATEUR_LIGNE = String.fromCharCode(0x2028);
const SEPARATEUR_PARAGRAPHE = String.fromCharCode(0x2029);

export function enJson(valeur: unknown): string {
  return JSON.stringify(valeur)
    .replaceAll('<', '\\u003c')
    .replaceAll(SEPARATEUR_LIGNE, '\\u2028')
    .replaceAll(SEPARATEUR_PARAGRAPHE, '\\u2029');
}

export function construireScript(config: ConfigScript): string {
  // Champ par champ, jamais `{ ...config }` : la liste de ce qui sort est écrite ici, et nulle part ailleurs.
  const donnees = config.etat === 'servi'
    ? {
      etat: config.etat,
      position: config.position,
      lien: config.lien,
      qr: config.svgQr,
      couleur: config.couleur,
      libelle: config.libelle,
      avatar: config.avatarUrl,
      badge: config.badge,
    }
    : { etat: config.etat, position: config.position };
  return `(function () {\n'use strict';\nvar D = ${enJson(donnees)};\nvar INDISPONIBLE = ${enJson(TEXTE_INDISPONIBLE)};\n${CORPS}})();\n`;
}

/**
 * La bulle. Un dessin de bulle de dialogue, pas le logo de WhatsApp : la forme suffit sur le vert, et le tracé est
 * une constante.
 */
const ICONE = 'M12 2C6.48 2 2 6.03 2 11c0 2.4 1.05 4.58 2.77 6.2L4 22l4.98-1.77C9.94 20.73 10.95 21 12 21c5.52 0 10-4.03 10-9S17.52 2 12 2z';

/**
 * La feuille de style, CONSTANTE. La couleur du client se pose par `style.backgroundColor`, que le navigateur
 * refuse si la valeur n'est pas une couleur ; le coin, par une table fermée.
 */
const CSS = [
  ':host{all:initial}',
  '.boite{display:flex;flex-direction:column;align-items:flex-end;gap:8px;font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1f2937}',
  '.boite.gauche{align-items:flex-start}',
  '.boite.haut{flex-direction:column-reverse}',
  '.ligne{display:flex;align-items:center;gap:10px;text-decoration:none;color:inherit;cursor:pointer}',
  '.gauche .ligne{flex-direction:row-reverse}',
  '.etiquette{display:flex;align-items:center;gap:8px;max-width:240px;padding:6px 12px;border-radius:999px;background:#fff;box-shadow:0 2px 10px rgba(0,0,0,.15)}',
  '.avatar{width:28px;height:28px;border-radius:50%;object-fit:cover}',
  '.bulle{display:flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;background:#25d366;box-shadow:0 4px 14px rgba(0,0,0,.2)}',
  '.bulle svg{width:30px;height:30px;fill:#fff}',
  '.bulle.grise{background:#9ca3af;opacity:.6;cursor:not-allowed}',
  '.panneau{width:220px;padding:16px;border-radius:12px;background:#fff;box-shadow:0 8px 30px rgba(0,0,0,.2);text-align:center}',
  '.panneau[hidden]{display:none}',
  '.titre{margin:0}',
  '.qr{display:block;width:180px;height:180px;margin:8px auto}',
  '.web{color:#128c7e;font-weight:600}',
  '.badge{margin:0;font-size:11px;color:#6b7280}',
].join('');

/**
 * Le corps du script, une constante : aucune valeur n'y est concaténée, tout ce qui varie est lu dans `D`.
 *
 * - Il attend `DOMContentLoaded` si la page se charge encore : la balise est posée en `async`, elle peut
 *   s'exécuter avant que `body` existe.
 * - Shadow DOM FERMÉ : le style du site ne casse pas la bulle, celui de la bulle ne fuit pas sur le site, et le
 *   site ne peut pas atteindre ses nœuds par `shadowRoot`.
 * - Tactile (`pointer: coarse`) : le clic suit le lien, WhatsApp s'ouvre sur le téléphone. Ordinateur : le clic
 *   ouvre un panneau avec le QR code et le lien, ouvert dans un nouvel onglet.
 * - Grisée : un `span` sans lien ni gestionnaire de clic, avec `title` et `aria-label`.
 */
const CORPS = `var CSS = ${JSON.stringify(CSS)};
var ICONE = ${JSON.stringify(ICONE)};
var COINS = { bas_droite: ['bottom', 'right'], bas_gauche: ['bottom', 'left'], haut_droite: ['top', 'right'], haut_gauche: ['top', 'left'] };
function icone() {
  var ns = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  var trace = document.createElementNS(ns, 'path');
  trace.setAttribute('d', ICONE);
  svg.appendChild(trace);
  return svg;
}
function versOnglet(a, lien) {
  a.href = lien;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
}
function tactile() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}
function monter() {
  if (!document.body || typeof document.body.attachShadow !== 'function') return;
  var coin = Object.prototype.hasOwnProperty.call(COINS, D.position) ? COINS[D.position] : COINS.bas_droite;
  var hote = document.createElement('div');
  hote.style.position = 'fixed';
  hote.style.zIndex = '2147483000';
  hote.style.setProperty(coin[0], '20px');
  hote.style.setProperty(coin[1], '20px');
  var racine = hote.attachShadow({ mode: 'closed' });
  var style = document.createElement('style');
  style.textContent = CSS;
  racine.appendChild(style);
  var boite = document.createElement('div');
  boite.className = 'boite' + (coin[0] === 'top' ? ' haut' : '') + (coin[1] === 'left' ? ' gauche' : '');
  racine.appendChild(boite);
  if (D.etat !== 'servi') {
    var grise = document.createElement('span');
    grise.className = 'bulle grise';
    grise.setAttribute('role', 'img');
    grise.title = INDISPONIBLE;
    grise.setAttribute('aria-label', INDISPONIBLE);
    grise.appendChild(icone());
    boite.appendChild(grise);
    document.body.appendChild(hote);
    return;
  }
  var panneau = document.createElement('div');
  panneau.className = 'panneau';
  panneau.hidden = true;
  if (D.qr !== null) {
    var titre = document.createElement('p');
    titre.className = 'titre';
    titre.textContent = 'Scannez ce code avec votre téléphone pour ouvrir WhatsApp';
    panneau.appendChild(titre);
    var qr = document.createElement('img');
    qr.className = 'qr';
    qr.alt = 'QR code WhatsApp';
    qr.src = 'data:image/svg+xml,' + encodeURIComponent(D.qr);
    panneau.appendChild(qr);
  }
  var web = document.createElement('a');
  web.className = 'web';
  versOnglet(web, D.lien);
  web.textContent = 'Ouvrir WhatsApp sur cet ordinateur';
  panneau.appendChild(web);
  boite.appendChild(panneau);
  var ligne = document.createElement('a');
  ligne.className = 'ligne';
  versOnglet(ligne, D.lien);
  ligne.setAttribute('aria-label', 'Discuter sur WhatsApp');
  ligne.setAttribute('aria-expanded', 'false');
  if (D.libelle !== null || D.avatar !== null) {
    var etiquette = document.createElement('span');
    etiquette.className = 'etiquette';
    if (D.avatar !== null) {
      var avatar = document.createElement('img');
      avatar.className = 'avatar';
      avatar.alt = '';
      avatar.src = D.avatar;
      etiquette.appendChild(avatar);
    }
    if (D.libelle !== null) {
      var texte = document.createElement('span');
      texte.textContent = D.libelle;
      etiquette.appendChild(texte);
    }
    ligne.appendChild(etiquette);
  }
  var bulle = document.createElement('span');
  bulle.className = 'bulle';
  bulle.style.backgroundColor = D.couleur;
  bulle.appendChild(icone());
  ligne.appendChild(bulle);
  ligne.addEventListener('click', function (evenement) {
    if (tactile()) return;
    evenement.preventDefault();
    panneau.hidden = !panneau.hidden;
    ligne.setAttribute('aria-expanded', panneau.hidden ? 'false' : 'true');
  });
  boite.appendChild(ligne);
  if (D.badge) {
    var badge = document.createElement('p');
    badge.className = 'badge';
    badge.textContent = 'Propulsé par Messaging Me';
    boite.appendChild(badge);
  }
  document.body.appendChild(hote);
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', monter);
else monter();
`;
