// scripts/vitrine/cas.ts
// Les pages de cas d'usage de la vitrine et leur carrefour (lots 6 et 6 bis, plan
// docs/superpowers/plans/2026-10-16-cas-d-usage-solutions-depot.md, tâche 7), GÉNÉRÉES depuis leurs textes
// (`scripts/vitrine/cas-textes.ts`), le registre (`web/lib/registre-vitrine.ts`) et le code compilé des cas
// (`EXEMPLES_CAS`). La structure est celle de la spec du lot 6 (« L'anatomie d'une page de cas ») : le film, le schéma,
// le pas à pas avec les vrais noms, ce que l'on paie, une FAQ, les liens, le guide.
//
// `npm run vitrine:cas` écrit chaque page EN LIGNE au registre et le carrefour ; l'en-tête et le pied de page sont ceux
// de `entete.ts`. `tests/vitrine-cas.test.ts` exige chaque page égale à sa génération.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { adresseDuScript, baliseDuScript } from '../../src/widgets/adresses';
import { EXEMPLES_CAS, type ExempleCode } from '../../web/lib/exemples-code';
import { ENTREES, type EntreeVitrine } from '../../web/lib/registre-vitrine';
import { TEXTES_CAS, TEXTES_CARREFOUR, type Langue, type TexteCas } from './cas-textes';
import { TEXTES_ATTENTE, TEXTES_SECTEURS, type LogoClient, type TexteSecteur, type UsageSecteur } from './secteurs-textes';
import { pageAvecEntete } from './entete';
import { LOGOS_ASSISTANTS, type LogoAssistant } from './logos-assistants';
import { pagesBoutiques } from './boutique';
import { TEXTES_BOUTIQUES } from './boutique-textes';

const ORIGINE = 'https://app.messagingme.fr';
const CONSOLE = 'https://console.messagingme.app';
const SITE = (p: string) => fileURLToPath(new URL(`../../site/${p}`, import.meta.url));

const echapper = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Une valeur d'attribut entre guillemets droits : un `"` d'un titre de fiche le fermerait (relecture du lot 3). */
const attribut = (t: string): string => echapper(t).replace(/"/g, '&quot;');

/** Le chemin d'une page dans `site/` depuis son adresse : `/cas-d-usage/x/` -> `cas-d-usage/x/index.html`. */
export const fichierDe = (adresse: string): string => `${adresse.slice(1)}index.html`;

/** La page Développeurs de la langue : sa tête, ses icônes, son en-tête et son pied servent de gabarit. */
function gabarit(langue: Langue): string {
  return readFileSync(SITE(langue === 'fr' ? 'developpeurs/index.html' : 'en/developers/index.html'), 'utf8');
}

/** La tête d’une page générée (exportée pour le centre d’aide, `aide.ts`). */
export interface Tete {
  readonly adresse: string;
  readonly jumelle: string;
  readonly titre: string;
  readonly description: string;
  readonly ldJson: object;
  readonly affiche?: string;
  /** Une page d'attente : hors des moteurs. */
  readonly noindex?: boolean;
}

/** Une page complète : la tête de la page Développeurs réécrite, et son `<main>` remplacé. */
export function page(langue: Langue, tete: Tete, main: string, commentaire: string): string {
  const fr = langue === 'fr';
  const [aFr, aEn] = fr ? [tete.adresse, tete.jumelle] : [tete.jumelle, tete.adresse];
  let s = gabarit(langue);
  const rempl = (re: RegExp, par: string, quoi: string) => {
    if (!re.test(s)) throw new Error(`gabarit : ${quoi} introuvable`);
    s = s.replace(re, () => par);
  };
  rempl(/<!doctype html>\n<!--[\s\S]*?-->\n/, `<!doctype html>\n<!-- ${commentaire} -->\n`, 'commentaire');
  rempl(/<title>[^<]*<\/title>/, `<title>${echapper(tete.titre)}</title>`, 'title');
  rempl(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${attribut(tete.description)}">${tete.noindex ? '\n<meta name="robots" content="noindex">' : ''}`, 'description');
  rempl(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${ORIGINE}${tete.adresse}">`, 'canonical');
  rempl(/<link rel="alternate" hreflang="fr" href="[^"]*">/, `<link rel="alternate" hreflang="fr" href="${ORIGINE}${aFr}">`, 'hreflang fr');
  rempl(/<link rel="alternate" hreflang="en" href="[^"]*">/, `<link rel="alternate" hreflang="en" href="${ORIGINE}${aEn}">`, 'hreflang en');
  rempl(/<link rel="alternate" hreflang="x-default" href="[^"]*">/, `<link rel="alternate" hreflang="x-default" href="${ORIGINE}${aFr}">`, 'x-default');
  rempl(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${ORIGINE}${tete.adresse}">`, 'og:url');
  rempl(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${attribut(tete.titre)}">`, 'og:title');
  rempl(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${attribut(tete.description)}">`, 'og:description');
  if (tete.affiche) rempl(/<meta property="og:image" content="[^"]*">/, `<meta property="og:image" content="${ORIGINE}${tete.affiche}">`, 'og:image');
  rempl(/<script type="application\/ld\+json">\n\{[\s\S]*?\n\}\n<\/script>\n<\/head>/,
    `<script type="application/ld+json">\n${JSON.stringify(tete.ldJson, null, 1)}\n</script>\n</head>`, 'JSON-LD');
  rempl(/<main>[\s\S]*?<\/main>/, main, 'main');
  return pageAvecEntete(s, fichierDe(tete.adresse));
}

export const fil = (langue: Langue, elements: ReadonlyArray<[string, string]>) => ({
  '@type': 'BreadcrumbList',
  itemListElement: elements.map(([nom, adresse], i) => ({ '@type': 'ListItem', position: i + 1, name: nom, item: ORIGINE + adresse })),
});
export const ACCUEIL: Record<Langue, [string, string]> = { fr: ['Accueil', '/'], en: ['Home', '/en/'] };

/** Le guide de la doc d'un cas, dans la langue de la page (`?lang=en` sur la page anglaise). */
export const adresseGuide = (e: EntreeVitrine, langue: Langue): string | null =>
  e.guide ? `${CONSOLE}/developers/api/guides/${e.guide}${langue === 'en' ? '?lang=en' : ''}` : null;

/**
 * Les extraits des cas qui passent par la console, sans code applicatif : la balise du widget, fabriquée par les
 * fonctions mêmes qui la donnent au client (`src/widgets/adresses.ts`), avec le code du widget du film.
 */
const EXTRAITS_CONSOLE: Readonly<Record<string, Readonly<Record<string, ExempleCode>>>> = {
  'bulle-lovable': {
    balise: { fichier: 'index.html', code: baliseDuScript(adresseDuScript('https://api.messagingme.app', 'h4x9k2m7q3vb')) },
  },
  // Le support (cas #3) : le fichier de la doc que l'agent du film a vraiment appris (import_document_text, espace de
  // démonstration, 2026-10-21), et sa version anglaise pour la page anglaise
  support: {
    doc: { fichier: 'docs/garanties.md', code: [
      '# Garanties Vélo Rapide',
      '',
      '## Batterie',
      'La batterie est garantie 2 ans, à compter de la date de livraison. La garantie couvre un défaut de charge ou une',
      'perte de capacité supérieure à 30 % dans ce délai, en usage normal.',
      '',
      '## Faire jouer la garantie',
      '1. Écrivez-nous avec votre numéro de commande et une photo de l\'étiquette de la batterie (sous le support).',
      '2. Nous vous envoyons une étiquette de retour prépayée sous 24 h ouvrées.',
      '3. Nous remplaçons la batterie sous 5 jours ouvrés après réception, sans frais pendant la garantie.',
    ].join('\n') },
    docEn: { fichier: 'docs/warranty.md', code: [
      '# Vélo Rapide warranty',
      '',
      '## Battery',
      'The battery is guaranteed for 2 years from the delivery date. The warranty covers a charging fault or a',
      'capacity loss of more than 30% within that period, under normal use.',
      '',
      '## Making a warranty claim',
      '1. Write to us with your order number and a photo of the battery label (under the bracket).',
      '2. We send you a prepaid return label within 24 working hours.',
      '3. We replace the battery within 5 working days of receiving it, free of charge under warranty.',
    ].join('\n') },
  },
};

/** L'extrait de code d'une page : une partie de `EXEMPLES_CAS` (compilée), ou d'`EXTRAITS_CONSOLE`, telle quelle. */
export function extraitDe(cle: string, partie: string): ExempleCode {
  const cas = (EXEMPLES_CAS as Record<string, Record<string, ExempleCode>>)[cle] ?? EXTRAITS_CONSOLE[cle];
  const ex = cas?.[partie];
  if (!ex) throw new Error(`extrait absent : cas.${cle}.${partie}`);
  return ex;
}

/**
 * La une de chaque page de cas, à droite du titre (Julien, 2026-10-26 : « le logo Messaging Me avec les logos de Claude
 * Code, Codex et Lovable qui tournent autour », puis « un logo WhatsApp qui tourne autour aussi ») : la marque sur une
 * tuile épaisse au centre, les trois assistants et WhatsApp en orbite sur une ellipse. Chaque tuile se place par
 * `cos()` et `sin()` d'un angle animé (`@property --t`, site.css) : devant, elle grossit et passe devant la marque ;
 * derrière, elle rapetisse et passe dessous. Sans animation (prefers-reduced-motion, ou un navigateur sans
 * `@property`), les tuiles restent à leur angle de départ.
 *
 * Puis (Julien, 2026-10-26 : « des logos plus épais, avec des effets de couleur qui varient selon la rotation ») : chaque
 * tuile est un bloc extrudé (une pile de calques), qui tourne sur lui-même pour montrer sa tranche du côté de la marque,
 * éclairé par elle d'une teinte entre le vert et le bleu qui suit l'angle, avec un reflet qui glisse sur sa face.
 */
function orbite(langue: Langue): string {
  const svg = (l: LogoAssistant, classe: string) => `<svg class="${classe}" viewBox="${l.viewBox}" aria-hidden="true">${l.corps}</svg>`;
  const epaisseur = (n: number) => Array.from({ length: n }, (_, k) => `<i style="--z:${k + 1}"></i>`).join('');
  const satellite = (cle: string, nom: string, logo: LogoAssistant, angle: number) =>
    `      <div class="or-sat or-${cle}" style="--a:${angle}deg"><div class="or-bloc">${epaisseur(14)}<span class="or-face">${svg(logo, 'or-logo')}</span></div><span class="or-nom">${nom}</span></div>`;
  // L'ellipse en deux moitiés : l'arrière passe sous la marque, l'avant par-dessus
  const arc = (classe: string, d: string) => `<svg class="or-arc ${classe}" viewBox="0 0 100 86" preserveAspectRatio="none" aria-hidden="true"><path d="${d}"/></svg>`;
  const fr = langue === 'fr';
  return [
    `    <figure class="orbite" role="img" aria-label="${fr ? 'Le logo de Messaging Me, avec ceux de Claude Code, de Codex, de Lovable et de WhatsApp qui tournent autour' : 'The Messaging Me logo, with the Claude Code, Codex, Lovable and WhatsApp logos orbiting around it'}">`,
    '      <span class="or-halo"></span>',
    `      ${arc('or-arriere', 'M8 43 A42 19 0 0 1 92 43')}`,
    `      ${arc('or-avant', 'M8 43 A42 19 0 0 0 92 43')}`,
    `      <div class="or-centre"><div class="or-bloc">${epaisseur(20)}<span class="or-face">${svg(LOGOS_ASSISTANTS.messagingme, 'or-marque')}</span></div></div>`,
    satellite('claude', 'Claude Code', LOGOS_ASSISTANTS.claude, 90),
    satellite('lovable', 'Lovable', LOGOS_ASSISTANTS.lovable, 180),
    satellite('codex', 'Codex', LOGOS_ASSISTANTS.codex, 270),
    satellite('whatsapp', 'WhatsApp', LOGOS_ASSISTANTS.whatsapp, 0),
    // Deux messages qui filent sur l'orbite, deux fois plus vite que les tuiles
    '      <span class="or-point" style="--a:45deg"></span><span class="or-point" style="--a:225deg"></span>',
    '    </figure>',
  ].join('\n');
}

function mainCas(e: EntreeVitrine, t: TexteCas, langue: Langue): string {
  const p = langue === 'fr' ? e.fr : e.en;
  const film = e.film;
  if (!film) throw new Error(`${e.cle} : un cas en ligne a son film`);
  const suffixe = langue === 'fr' ? '' : '-en';
  const guide = adresseGuide(e, langue);
  const ex = extraitDe(e.cle, t.extrait.partie);
  const demarrer = langue === 'fr' ? '/developpeurs/#demarrer' : '/en/developers/#demarrer';
  const lignes = [
    '<main>',
    '  <section class="cadre f-une cas-une">',
    '    <div>',
    `      <h1><span class="f-surtitre"><svg class="ic" aria-hidden="true"><use href="#${t.icone}"/></svg>${echapper(langue === 'fr' ? 'Cas d’usage' : 'Use case')}</span> ${t.h1}</h1>`,
    `      <p class="chapeau">${t.chapeau}</p>`,
    '      <div class="appels">',
    `        <a class="bouton bouton-plein" href="${demarrer}">${langue === 'fr' ? 'Installer le plugin' : 'Install the plugin'}</a>`,
    `        <a class="bouton bouton-texte" href="#film">${langue === 'fr' ? 'Voir le film' : 'Watch the film'} <svg class="ic" aria-hidden="true"><use href="#i-fleche"/></svg></a>`,
    '      </div>',
    '    </div>',
    orbite(langue),
    '  </section>',
    '',
    '  <section class="f-bloc f-film" id="film">',
    '    <div class="cadre">',
    `      <h2 class="f-titre">${t.film.titre}</h2>`,
    `      <p class="f-texte">${t.film.texte}</p>`,
    `      <video class="f-video" src="/films/${film}${suffixe}.mp4?v=1" poster="/films/${film}${suffixe}.webp?v=1" data-vertical="/films/${film}${suffixe}-9x16.mp4?v=1" data-affiche-verticale="/films/${film}${suffixe}-9x16.webp?v=1" width="1280" height="720" controls muted playsinline preload="none" aria-label="${echapper(t.film.aria)}"></video>`,
    '    </div>',
    '  </section>',
    '',
    '  <section class="f-bloc cas-schema">',
    '    <div class="cadre">',
    `      <h2 class="f-titre">${t.schema.titre}</h2>`,
    `      <figure class="dessin">${t.schema.horizontal}${t.schema.vertical}<figcaption class="masque">${t.schema.legende}</figcaption></figure>`,
    '    </div>',
    '  </section>',
    '',
    '  <section class="f-bloc cas-pas bande-claire">',
    '    <div class="cadre">',
    `      <h2 class="f-titre">${langue === 'fr' ? 'La mise en place, étape par étape.' : 'The setup, step by step.'}</h2>`,
    '      <ol class="guide-etapes">',
    ...t.etapes.map((x, i) => `        <li><span class="f-num">${i + 1}</span><div><h3>${x.titre}</h3><p>${x.texte}</p></div></li>`),
    '      </ol>',
    `      <h3 class="cas-sous-titre">${t.invite.titre}</h3>`,
    `      <p class="f-texte">${t.invite.texte}</p>`,
    `      <pre class="code" data-invite="${e.cle}"><code>${echapper(t.invite.phrase)}</code></pre>`,
    `      <h3 class="cas-sous-titre">${t.extrait.titre}</h3>`,
    `      <pre class="code" data-exemple="cas.${e.cle}.${t.extrait.partie}"><code>${echapper(ex.code)}</code></pre>`,
    `      <p class="f-note">${echapper(ex.fichier)}${guide ? ` · <a href="${guide}" data-guide="${e.guide}">${langue === 'fr' ? 'tout le code dans le guide' : 'all the code in the guide'}</a>` : ''}</p>`,
    '    </div>',
    '  </section>',
    '',
    '  <section class="f-bloc cas-paie">',
    '    <div class="cadre">',
    `      <h2 class="f-titre">${t.titres.paie}</h2>`,
    '      <ul class="tarif-liste cas-liste">',
    ...t.paie.map((x) => `        <li>${x}</li>`),
    '      </ul>',
    '    </div>',
    '  </section>',
    '',
    '  <section class="f-bloc cas-faq" id="faq">',
    '    <div class="cadre">',
    `      <h2 class="f-titre">${t.titres.faq}</h2>`,
    '      <div class="dev-faq">',
    ...t.faq.map((q) => `        <details><summary>${q.question}</summary><p>${q.reponse}</p></details>`),
    '      </div>',
    '    </div>',
    '  </section>',
    '',
    '  <section class="f-appel">',
    '    <div class="cadre">',
    `      <h2 class="f-titre">${t.appel.titre}</h2>`,
    `      <p class="f-texte">${t.appel.texte}</p>`,
    '      <div class="appels">',
    `        <a class="bouton bouton-plein" href="${demarrer}">${langue === 'fr' ? 'Installer le plugin' : 'Install the plugin'}</a>`,
    guide ? `        <a class="bouton bouton-texte" href="${guide}">${langue === 'fr' ? 'Lire le guide' : 'Read the guide'} <svg class="ic" aria-hidden="true"><use href="#i-fleche"/></svg></a>` : '',
    '      </div>',
    `      <p class="cas-voisins">${t.liens.map(([href, texte]) => `<a href="${href}">${texte}</a>`).join(' · ')}</p>`,
    '    </div>',
    '  </section>',
    '</main>',
  ];
  // Les lignes vides du tableau aèrent ce fichier, pas la page ; celles du code (dans une même chaîne) restent.
  return lignes.filter((l) => l !== '').join('\n');
}

function ldCas(e: EntreeVitrine, t: TexteCas, langue: Langue): object {
  const p = langue === 'fr' ? e.fr : e.en;
  const carrefour = langue === 'fr' ? TEXTES_CARREFOUR.fr : TEXTES_CARREFOUR.en;
  const suffixe = langue === 'fr' ? '' : '-en';
  const texte = (h: string) => h.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  return {
    '@context': 'https://schema.org',
    '@graph': [
      fil(langue, [ACCUEIL[langue], [carrefour.fil, carrefour.adresse], [p.titre, p.adresse]]),
      {
        '@type': 'TechArticle', headline: texte(t.h1), description: t.description, inLanguage: langue === 'fr' ? 'fr-FR' : 'en-US',
        url: ORIGINE + p.adresse, publisher: { '@id': 'https://www.messagingme.fr/#organisation' },
      },
      {
        '@type': 'VideoObject', name: t.film.aria, description: texte(t.film.texte),
        thumbnailUrl: `${ORIGINE}/films/${e.film}${suffixe}.webp`, contentUrl: `${ORIGINE}/films/${e.film}${suffixe}.mp4`,
        uploadDate: t.film.publie, duration: t.film.duree, inLanguage: langue === 'fr' ? 'fr-FR' : 'en-US',
        publisher: { '@id': 'https://www.messagingme.fr/#organisation' },
      },
      {
        '@type': 'FAQPage', mainEntity: t.faq.map((q) => ({ '@type': 'Question', name: texte(q.question), acceptedAnswer: { '@type': 'Answer', text: texte(q.reponse) } })),
      },
    ],
  };
}

/** Les pages d'un cas en ligne, dans les deux langues. */
export function pagesCas(e: EntreeVitrine): Array<{ chemin: string; contenu: string }> {
  const textes = TEXTES_CAS[e.cle];
  if (!textes) throw new Error(`${e.cle} : en ligne sans ses textes (scripts/vitrine/cas-textes.ts)`);
  return (['fr', 'en'] as const).map((langue) => {
    const p = langue === 'fr' ? e.fr : e.en;
    const autre = langue === 'fr' ? e.en : e.fr;
    const t = textes[langue];
    const suffixe = langue === 'fr' ? '' : '-en';
    const contenu = page(langue, {
      adresse: p.adresse, jumelle: autre.adresse, titre: t.titre, description: t.description, ldJson: ldCas(e, t, langue),
      affiche: `/films/${e.film}${suffixe}.webp?v=1`,
    }, mainCas(e, t, langue),
    `Cas d’usage « ${p.titre} », GÉNÉRÉ par npm run vitrine:cas depuis scripts/vitrine/cas-textes.ts, le registre et EXEMPLES_CAS : ne pas modifier à la main.`);
    return { chemin: fichierDe(p.adresse), contenu };
  });
}

/** Le carrefour « Tous les cas d'usage », dans les deux langues : une carte par cas EN LIGNE. */
/**
 * La une de la page chapeau, à droite du titre (Julien, 2026-10-20 : « il faut tout de suite comprendre qu'ici on gère ça
 * avec les assistants IA ») : Claude Code, Codex et GitHub en tuiles épaisses, en légère 3D, reliés à WhatsApp par des
 * fils où passe un message. L'épaisseur est une pile de calques (CSS 3D, sans bibliothèque) ; tout ce qui bouge s'arrête
 * avec prefers-reduced-motion.
 */
function assistants(langue: Langue): string {
  const svg = (l: LogoAssistant, classe: string) => `<svg class="${classe}" viewBox="${l.viewBox}" aria-hidden="true">${l.corps}</svg>`;
  const epaisseur = Array.from({ length: 12 }, (_, k) => `<i style="--z:${k + 1}"></i>`).join('');
  const tuile = (cle: string, nom: string, logo: LogoAssistant, d: string) =>
    `      <div class="as-tuile as-${cle}" style="--d:${d}"><div class="as-porte"><div class="as-bloc">${epaisseur}<span class="as-face">${svg(logo, 'as-logo')}</span></div></div><span class="as-ombre"></span><span class="as-nom">${nom}</span></div>`;
  const fil = (d: string, retard: string) => `<path d="${d}"/><path class="as-flux" d="${d}" pathLength="100" style="--d:${retard}"/>`;
  const fr = langue === 'fr';
  return [
    `    <figure class="assistants" role="img" aria-label="${fr ? 'Claude Code, Codex et GitHub, reliés à WhatsApp : tout se fait depuis votre assistant IA' : 'Claude Code, Codex and GitHub, connected to WhatsApp: everything happens from your AI assistant'}">`,
    `      <svg class="as-fils" viewBox="0 0 560 470" aria-hidden="true">${fil('M280 216 L280 312', '0s')}${fil('M120 300 C150 356 196 371 228 371', '.9s')}${fil('M440 300 C410 356 364 371 332 371', '1.8s')}</svg>`,
    tuile('claude', 'Claude Code', LOGOS_ASSISTANTS.claude, '0s'),
    tuile('codex', 'Codex', LOGOS_ASSISTANTS.codex, '-2.3s'),
    tuile('github', 'GitHub', LOGOS_ASSISTANTS.github, '-4.6s'),
    `      <div class="as-wa">${svg(LOGOS_ASSISTANTS.whatsapp, 'as-wa-logo')}</div>`,
    `      <figcaption>${fr ? 'Tout se fait depuis votre assistant IA.' : 'Everything happens from your AI assistant.'}</figcaption>`,
    '    </figure>',
  ].join('\n');
}

export function pagesCarrefour(): Array<{ chemin: string; contenu: string }> {
  const enLigne = ENTREES.filter((e) => e.enLigne && e.nature === 'cas');
  return (['fr', 'en'] as const).map((langue) => {
    const c = TEXTES_CARREFOUR[langue];
    const autre = TEXTES_CARREFOUR[langue === 'fr' ? 'en' : 'fr'];
    const suffixe = langue === 'fr' ? '' : '-en';
    const demarrer = langue === 'fr' ? '/developpeurs/#demarrer' : '/en/developers/#demarrer';
    // Chaque cas avec la vignette de son film : l'affiche, et le film qui ne se charge qu'au survol (site.js).
    const cartes = enLigne.map((e) => {
      const p = langue === 'fr' ? e.fr : e.en;
      const t = TEXTES_CAS[e.cle]![langue];
      return `        <li><a class="hub-carte" href="${p.adresse}"><video class="hub-mini" src="/films/${e.film}${suffixe}.mp4?v=1" poster="/films/${e.film}${suffixe}.webp?v=1" width="1280" height="720" muted loop playsinline preload="none" aria-hidden="true" tabindex="-1"></video><span class="hub-texte"><strong>${echapper(p.titre)}</strong><small>${t.resume}</small></span><svg class="ic hub-fleche" aria-hidden="true"><use href="#i-fleche"/></svg></a></li>`;
    });
    const main = [
      '<main>',
      '  <section class="cadre f-une cas-une">',
      '    <div>',
      `      <h1><span class="f-surtitre"><svg class="ic" aria-hidden="true"><use href="#i-code"/></svg>${c.fil}</span> ${c.h1}</h1>`,
      `      <p class="chapeau">${c.chapeau}</p>`,
      '      <div class="appels">',
      `        <a class="bouton bouton-plein" href="${demarrer}">${langue === 'fr' ? 'Installer le plugin' : 'Install the plugin'}</a>`,
      `        <a class="bouton bouton-texte" href="#cas">${langue === 'fr' ? 'Voir les cas' : 'See the use cases'} <svg class="ic" aria-hidden="true"><use href="#i-fleche"/></svg></a>`,
      '      </div>',
      '    </div>',
      assistants(langue),
      '  </section>',
      '',
      '  <section class="f-bloc hub" id="cas">',
      '    <div class="cadre hub-split">',
      '      <div class="hub-cas">',
      `        <h2 class="f-titre">${c.cas.titre}</h2>`,
      `        <p class="f-texte">${c.cas.texte}</p>`,
      '        <ul class="hub-liste">',
      ...cartes.map((l) => `  ${l}`),
      '        </ul>',
      '      </div>',
      '      <div class="hub-film">',
      `        <h2 class="f-titre">${c.film.titre}</h2>`,
      `        <p class="f-texte">${c.film.texte}</p>`,
      `        <video class="f-video" src="/films/${c.film.nom}${suffixe}.mp4?v=1" poster="/films/${c.film.nom}${suffixe}.webp?v=1" data-vertical="/films/${c.film.nom}${suffixe}-9x16.mp4?v=1" data-affiche-verticale="/films/${c.film.nom}${suffixe}-9x16.webp?v=1" width="1280" height="720" controls muted playsinline preload="none" aria-label="${echapper(c.film.aria)}"></video>`,
      '      </div>',
      '    </div>',
      '  </section>',
      '',
      '  <section class="f-bloc cas-pas bande-claire">',
      '    <div class="cadre">',
      `      <h2 class="f-titre">${c.etapes.titre}</h2>`,
      '      <ol class="guide-etapes">',
      ...c.etapes.liste.map((x, i) => `        <li><span class="f-num">${i + 1}</span><div><h3>${x.titre}</h3><p>${x.texte}</p></div></li>`),
      '      </ol>',
      `      <p class="cas-voisins"><a href="${demarrer}">${c.etapes.lien}</a></p>`,
      '    </div>',
      '  </section>',
      '</main>',
    ].join('\n');
    const texte = (h: string) => h.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');
    const ld = {
      '@context': 'https://schema.org',
      '@graph': [
        fil(langue, [ACCUEIL[langue], [c.fil, c.adresse]]),
        {
          '@type': 'VideoObject', name: c.film.aria, description: texte(c.film.texte),
          thumbnailUrl: `${ORIGINE}/films/${c.film.nom}${suffixe}.webp`, contentUrl: `${ORIGINE}/films/${c.film.nom}${suffixe}.mp4`,
          uploadDate: c.film.publie, duration: c.film.duree, inLanguage: langue === 'fr' ? 'fr-FR' : 'en-US',
          publisher: { '@id': 'https://www.messagingme.fr/#organisation' },
        },
      ],
    };
    return {
      chemin: fichierDe(c.adresse),
      contenu: page(langue, { adresse: c.adresse, jumelle: autre.adresse, titre: c.titre, description: c.description, ldJson: ld, affiche: `/films/${c.film.nom}${suffixe}.webp` }, main,
        'La page « SaaS et app builders », chapeau des cas d’usage, GÉNÉRÉE par npm run vitrine:cas depuis le registre : ne pas modifier à la main.'),
    };
  });
}

/** Tout ce que `npm run vitrine:cas` écrit. */
export function pagesGenerees(): Array<{ chemin: string; contenu: string }> {
  return [...pagesCarrefour(), ...ENTREES.filter((e) => e.enLigne && e.nature === 'cas').flatMap(pagesCas), ...pagesSecteurs(), ...pagesBoutiques()];
}

/**
 * Les pages de secteur EN LIGNE au registre (rubrique Solutions), dans les deux langues, depuis
 * `secteurs-textes.ts`. La première : Transport et mobilités (maquette de Julien du 2026-10-20). Ses captures sont des
 * iPhone en 3D, comme sur les pages Fonctionnalités, et ses appels mènent au formulaire de la page Contact : pas de
 * formulaire dans la page (Julien, 2026-10-20).
 */
export function pagesSecteurs(): Array<{ chemin: string; contenu: string }> {
  return ENTREES.filter((e) => e.enLigne && e.nature === 'secteur').flatMap((e) => (['fr', 'en'] as const).map((langue) => {
    if (e.attente) return pageAttente(e, langue);
    const t = TEXTES_SECTEURS[e.cle]?.[langue];
    if (!t) throw new Error(`${e.cle} : secteur en ligne sans ses textes (scripts/vitrine/secteurs-textes.ts)`);
    const p = langue === 'fr' ? e.fr : e.en;
    const autre = langue === 'fr' ? e.en : e.fr;
    const deux = (l: readonly [string, string]) => `${l[0]}<br>${l[1]}`;
    const contact = langue === 'fr' ? '/contact/#formulaire' : '/en/contact/#formulaire';
    const f = t.terrain.film;
    // Le film existe dans les deux langues (`<nom>-en`) et en 9:16 pour le téléphone (`-9x16`)
    const sf = langue === 'fr' ? '' : '-en';
    const logo = (l: LogoClient) => `<span class="sec-logo"><img src="${l.src}" alt="${attribut(l.alt)}" width="${l.largeur}" height="${l.hauteur}"></span>`;
    const chiffres = (liste: TexteSecteur['terrain']['chiffres'], retrait: string) => [
      `${retrait}<ul class="sec-chiffres">`,
      ...liste.map((c) => `${retrait}  <li><strong>${c.valeur}</strong><span>${c.texte}</span></li>`),
      `${retrait}</ul>`,
    ];
    const cas = t.terrain.cas;
    const autres = t.terrain.autres ?? [];
    // Un exemple de conversation : l'entreprise à gauche, son contact à droite, comme sur le téléphone du contact
    const echange = (u: UsageSecteur) => u.echange?.length
      ? `<div class="sec-echange">${u.echange.map((m) => `<p class="sec-bulle${m.contact ? ' sec-bulle-contact' : ''}"><span class="sec-qui">${m.qui}</span>${m.texte}</p>`).join('')}</div>`
      : '';
    const u = t.usages;
    const d = t.distinction;
    const distinction = d ? `<p class="sec-distinction"><span class="sec-logo"><img src="${d.src}" alt="${attribut(d.alt)}" width="${d.largeur}" height="${d.hauteur}"></span><span>${d.texte}</span></p>` : '';
    const main = [
      '<main>',
      '  <section class="cadre f-une sec-une">',
      '    <div>',
      `      <h1><span class="f-surtitre"><svg class="ic" aria-hidden="true"><use href="#${t.icone}"/></svg>${t.surtitre}</span> ${t.h1[0]} <span class="sec-accent">${t.h1[1]}</span></h1>`,
      `      <p class="chapeau">${t.chapeau}</p>`,
      `      <p class="sec-sous">${t.sous}</p>`,
      '      <div class="appels">',
      `        <a class="bouton bouton-plein" href="${contact}">${t.appel}</a>`,
      '      </div>',
      `      <p class="sec-refs"><span>${t.references.titre}</span>${t.references.logos.map(logo).join('')}</p>`,
      ...(distinction ? [`      ${distinction}`] : []),
      '    </div>',
      `    <figure class="f-duo">${t.captures.map((c, i) => `<img src="${c.src}" alt="${echapper(c.alt)}" width="560" height="1182"${i === 0 ? ' fetchpriority="high"' : ' loading="lazy"'}>`).join('')}</figure>`,
      '  </section>',
      '',
      '  <section class="f-bloc sec-enjeux bande-claire">',
      '    <div class="cadre">',
      `      <p class="f-surtitre">${t.enjeux.surtitre}</p>`,
      `      <h2 class="f-titre">${deux(t.enjeux.titre)}</h2>`,
      '      <ul class="sec-trois">',
      ...t.enjeux.liste.map((x) => `        <li><p class="sec-num">${x.num}</p><h3>${deux(x.titre)}</h3><p>${x.texte}</p></li>`),
      '      </ul>',
      `      <div class="sec-encart"><p class="sec-encart-titre">${deux(t.enjeux.encart.titre)}</p><p>${t.enjeux.encart.texte}</p></div>`,
      '    </div>',
      '  </section>',
      '',
      '  <section class="f-bloc sec-terrain">',
      '    <div class="cadre">',
      `      <p class="f-surtitre">${t.terrain.surtitre}</p>`,
      `      <h2 class="f-titre">${deux(t.terrain.titre)}</h2>`,
      '      <div class="sec-terrain-grille">',
      `        <div><video class="f-video" src="/films/${f.nom}${sf}.mp4?v=1" poster="/films/${f.nom}${sf}.webp?v=1" data-vertical="/films/${f.nom}${sf}-9x16.mp4?v=1" data-affiche-verticale="/films/${f.nom}${sf}-9x16.webp?v=1" width="1280" height="720" controls muted playsinline preload="none" aria-label="${echapper(f.aria)}"></video>${f.note ? `<p class="f-note">${f.note}</p>` : ''}</div>`,
      ...(cas
        ? ['        <div class="sec-cas">', `          ${logo(cas.logo)}`, `          <h3>${cas.titre}</h3>`, `          <p>${cas.texte}</p>`, ...chiffres(t.terrain.chiffres, '          '), '        </div>']
        : chiffres(t.terrain.chiffres, '        ')),
      '      </div>',
      ...(autres.length ? [
        '      <ul class="sec-autres">',
        ...autres.map((a) => [
          `        <li${a.visuel ? ' class="sec-avec-visuel"' : ''}>`,
          // Le texte, les chiffres et les objectifs en une colonne, le visuel dans l'autre
          '          <div class="sec-autre">',
          `            <div>${logo(a.logo)}<h3>${a.titre}</h3><p>${a.texte}</p>${a.resultat ? `<p class="sec-resultat">${a.resultat}</p>` : ''}</div>`,
          ...(a.chiffres ? chiffres(a.chiffres, '            ') : []),
          ...(a.objectifs ? [`            <div class="sec-objectifs"><p>${a.objectifs.titre}</p>`, ...chiffres(a.objectifs.liste, '              '), '            </div>'] : []),
          '          </div>',
          ...(a.visuel ? [`          <img class="sec-visuel" src="${a.visuel.src}" alt="${attribut(a.visuel.alt)}" width="${a.visuel.largeur}" height="${a.visuel.hauteur}" loading="lazy">`] : []),
          '        </li>',
        ].join('\n')),
        '      </ul>',
      ] : []),
      `      <p class="f-note">${t.terrain.source}</p>`,
      '    </div>',
      '  </section>',
      '',
      '  <section class="f-bloc sec-usages">',
      '    <div class="cadre">',
      `      <p class="f-surtitre">${t.usages.surtitre}</p>`,
      `      <h2 class="f-titre">${deux(t.usages.titre)}</h2>`,
      '      <ul class="sec-trois sec-cartes">',
      ...u.liste.map((x) => `        <li><h3>${x.titre}</h3>${x.accroche ? `<p class="sec-accroche">${x.accroche}</p>` : ''}<p>${x.texte}</p>${x.mots ? `<p class="sec-mots">${x.mots}</p>` : ''}${echange(x)}</li>`),
      '      </ul>',
      ...(u.parcours ? [`      <p class="sec-parcours">${u.parcours}</p>`] : []),
      ...(u.note ? [`      <p class="f-note">${u.note}</p>`] : []),
      ...(u.encart ? [`      <div class="sec-encart"><p class="sec-encart-titre">${deux(u.encart.titre)}</p><p>${u.encart.texte}</p></div>`] : []),
      ...(u.appel ? [`      <div class="appels sec-usages-appel"><a class="bouton bouton-texte" href="${contact}">${u.appel} <svg class="ic" aria-hidden="true"><use href="#i-fleche"/></svg></a></div>`] : []),
      '    </div>',
      '  </section>',
      '',
      '  <section class="f-bloc sec-partenaire">',
      '    <div class="cadre">',
      `      <p class="f-surtitre">${t.partenaire.surtitre}</p>`,
      `      <h2 class="f-titre">${deux(t.partenaire.titre)}</h2>`,
      '      <ul class="sec-trois">',
      ...t.partenaire.liste.map((x) => `        <li><h3>${x.titre}</h3><p>${x.texte}</p></li>`),
      '      </ul>',
      `      <p class="f-note">${t.partenaire.pilotage}</p>`,
      ...(distinction ? [`      ${distinction}`] : []),
      '    </div>',
      '  </section>',
      '',
      ...(t.faq ? [
        '  <section class="f-bloc cas-faq" id="faq">',
        '    <div class="cadre">',
        `      <h2 class="f-titre">${langue === 'fr' ? 'Questions fréquentes.' : 'Frequently asked questions.'}</h2>`,
        '      <div class="dev-faq">',
        ...t.faq.map((q) => `        <details><summary>${q.question}</summary><p>${q.reponse}</p></details>`),
        '      </div>',
        '    </div>',
        '  </section>',
        '',
      ] : []),
      '  <section class="f-appel">',
      '    <div class="cadre">',
      `      <h2 class="f-titre">${t.projet.titre}</h2>`,
      `      <p class="f-texte">${t.projet.texte}</p>`,
      '      <div class="appels">',
      `        <a class="bouton bouton-plein" href="${contact}">${t.projet.bouton} <svg class="ic" aria-hidden="true"><use href="#i-fleche"/></svg></a>`,
      '      </div>',
      '    </div>',
      '  </section>',
      '</main>',
    ].join('\n');
    const texte = (h: string) => h.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');
    const ld = {
      '@context': 'https://schema.org',
      '@graph': [
        fil(langue, [ACCUEIL[langue], [p.titre, p.adresse]]),
        {
          '@type': 'VideoObject', name: f.aria, description: texte(t.terrain.titre.join(' ')),
          thumbnailUrl: `${ORIGINE}/films/${f.nom}${sf}.webp`, contentUrl: `${ORIGINE}/films/${f.nom}${sf}.mp4`,
          uploadDate: f.publie, duration: f.duree, inLanguage: langue === 'fr' ? 'fr-FR' : 'en-US',
          publisher: { '@id': 'https://www.messagingme.fr/#organisation' },
        },
        ...(t.faq ? [{
          '@type': 'FAQPage', inLanguage: langue === 'fr' ? 'fr-FR' : 'en-US',
          mainEntity: t.faq.map((q) => ({ '@type': 'Question', name: texte(q.question), acceptedAnswer: { '@type': 'Answer', text: texte(q.reponse) } })),
        }] : []),
      ],
    };
    return {
      chemin: fichierDe(p.adresse),
      contenu: page(langue, { adresse: p.adresse, jumelle: autre.adresse, titre: t.titre, description: t.description, ldJson: ld, affiche: `/films/${f.nom}${sf}.webp` }, main,
        'Une page de secteur, GÉNÉRÉE par npm run vitrine:cas depuis scripts/vitrine/secteurs-textes.ts : ne pas modifier à la main.'),
    };
  }));
}

/** La page d'attente d'un secteur (`attente` au registre) : une une, un appel vers le formulaire de contact, en noindex. */
function pageAttente(e: EntreeVitrine, langue: Langue): { chemin: string; contenu: string } {
  const t = TEXTES_ATTENTE[e.cle]?.[langue];
  if (!t) throw new Error(`${e.cle} : secteur en attente sans ses textes (TEXTES_ATTENTE, scripts/vitrine/secteurs-textes.ts)`);
  const p = langue === 'fr' ? e.fr : e.en;
  const autre = langue === 'fr' ? e.en : e.fr;
  const transport = ENTREES.find((x) => x.cle === 'transport-mobilites')!;
  const main = [
    '<main>',
    '  <section class="cadre f-une-large chantier">',
    '    <div>',
    `      <h1><span class="f-surtitre"><svg class="ic" aria-hidden="true"><use href="#${t.icone}"/></svg>${p.titre}</span>${t.h1}</h1>`,
    `      <p class="chapeau">${t.chapeau}</p>`,
    '      <div class="appels">',
    `        <a class="bouton bouton-plein" href="${langue === 'fr' ? '/contact/#formulaire' : '/en/contact/#formulaire'}">${t.appel}</a>`,
    `        <a class="bouton bouton-texte" href="${langue === 'fr' ? transport.fr.adresse : transport.en.adresse}">${t.voir} <svg class="ic" aria-hidden="true"><use href="#i-fleche"/></svg></a>`,
    '      </div>',
    '    </div>',
    '  </section>',
    '</main>',
  ].join('\n');
  const ld = { '@context': 'https://schema.org', '@graph': [fil(langue, [ACCUEIL[langue], [p.titre, p.adresse]])] };
  return {
    chemin: fichierDe(p.adresse),
    contenu: page(langue, { adresse: p.adresse, jumelle: autre.adresse, titre: t.titre, description: t.description, ldJson: ld, noindex: true }, main,
      'Une page d\'attente de secteur, GÉNÉRÉE par npm run vitrine:cas depuis scripts/vitrine/secteurs-textes.ts : ne pas modifier à la main.'),
  };
}

/** La section « Cas d'usage » de `llms.txt` : le carrefour, puis chaque cas en ligne, en français puis en anglais. */
export function sectionLlms(): string {
  const enLigne = ENTREES.filter((e) => e.enLigne && e.nature === 'cas');
  const texte = (h: string) => h.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');
  return [
    '## Cas d’usage',
    '',
    `- [SaaS et app builders](${ORIGINE}${TEXTES_CARREFOUR.fr.adresse}) : ${TEXTES_CARREFOUR.fr.description}`,
    `- [SaaS and app builders](${ORIGINE}${TEXTES_CARREFOUR.en.adresse}) : the same page in English, with every use case below.`,
    ...enLigne.flatMap((e) => [
      `- [${e.fr.titre}](${ORIGINE}${e.fr.adresse}) : ${texte(TEXTES_CAS[e.cle]!.fr.resume)}`,
      `- [${e.en.titre}](${ORIGINE}${e.en.adresse}) : ${texte(TEXTES_CAS[e.cle]!.en.resume)}`,
    ]),
    ...ENTREES.filter((e) => e.enLigne && e.nature === 'secteur' && !e.attente).flatMap((e) => [
      `- [${e.fr.titre}](${ORIGINE}${e.fr.adresse}) : ${texte(TEXTES_SECTEURS[e.cle]!.fr.description)}`,
      `- [${e.en.titre}](${ORIGINE}${e.en.adresse}) : ${texte(TEXTES_SECTEURS[e.cle]!.en.description)}`,
    ]),
    ...ENTREES.filter((e) => e.enLigne && e.nature === 'boutique').flatMap((e) => [
      `- [${e.fr.titre}](${ORIGINE}${e.fr.adresse}) : ${texte(TEXTES_BOUTIQUES[e.cle]!.fr.description)}`,
      `- [${e.en.titre}](${ORIGINE}${e.en.adresse}) : ${texte(TEXTES_BOUTIQUES[e.cle]!.en.description)}`,
    ]),
    '',
  ].join('\n');
}

/** `llms.txt` avec sa section des cas à jour, posée avant « Tarifs » la première fois. */
export function llmsAvecCas(contenu: string): string {
  const debut = contenu.indexOf('## Cas d’usage');
  if (debut >= 0) {
    const fin = contenu.indexOf('\n## ', debut + 3);
    if (fin < 0) throw new Error('llms.txt : la section des cas doit être suivie d’une autre');
    return contenu.slice(0, debut) + sectionLlms() + '\n' + contenu.slice(fin + 1);
  }
  const tarifs = contenu.indexOf('## Tarifs');
  if (tarifs < 0) throw new Error('llms.txt : section Tarifs introuvable');
  return contenu.slice(0, tarifs) + sectionLlms() + '\n' + contenu.slice(tarifs);
}

function main(): void {
  for (const { chemin, contenu } of pagesGenerees()) {
    mkdirSync(dirname(SITE(chemin)), { recursive: true });
    writeFileSync(SITE(chemin), contenu);
  }
  const llms = readFileSync(SITE('llms.txt'), 'utf8');
  writeFileSync(SITE('llms.txt'), llmsAvecCas(llms));
  console.log(`${pagesGenerees().length} pages de cas écrites, et la section des cas de llms.txt`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
