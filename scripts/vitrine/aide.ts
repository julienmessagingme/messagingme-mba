// scripts/vitrine/aide.ts
// Le CENTRE D'AIDE de la vitrine (plan docs/superpowers/plans/2026-10-20-centre-d-aide.md, tâche 5), GÉNÉRÉ depuis les
// fiches publiques de `docs/aide/fiches/` et leur version anglaise : la fiche est la seule source, le bot d'aide de la
// console lit la même. Le gabarit est celui de la maquette validée par Julien le 2026-10-20 (fil d'Ariane, chapeau,
// boutons, menu à gauche, film, étapes avec leur capture et leur détail replié, encadrés, précédente et suivante).
//
// `npm run vitrine:aide` écrit l'accueil du centre et chaque page, dans les deux langues, les pages « Depuis Claude
// Code » de la doc développeurs (`aide-claude-textes.ts`), la section « ## Aide » de
// `llms.txt`, les adresses d'aide de `sitemap.xml`, et la correspondance écran vers page que la console importe
// (`web/lib/aide-pages.ts`). `tests/vitrine-aide.test.ts` exige chaque sortie égale à sa génération.
//
// 🔴 Une fiche publique retouchée se régénère ici, puis `aide:charger` en production pour le bot (`DEPLOY.md`).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CARTE_CONSOLE } from '../../src/aide/carte-console';
import { RUBRIQUES } from '../../src/aide/fiches';
import { structureFiche, type BlocFiche } from '../../src/aide/structure';
import { ESSAI_PRO_JOURS } from '../../src/offres/offres';
import { ACCUEIL, fichierDe, fil, page } from './cas';
import { insecables } from './guide-meta';
import { PAGES_CLAUDE, type PageClaude } from './aide-claude-textes';
import { ACCUEIL_AIDE, NOMS_RUBRIQUES, pagesDuCentre, type Langue, type PageAide } from './aide-pages';

const ORIGINE = 'https://app.messagingme.fr';
const CONSOLE = 'https://console.messagingme.app';
const SITE = (p: string) => fileURLToPath(new URL(`../../site/${p}`, import.meta.url));
const WEB = (p: string) => fileURLToPath(new URL(`../../web/${p}`, import.meta.url));
const ORGANISATION = { '@id': 'https://www.messagingme.fr/#organisation' };

/** Les textes de la page, par langue. Aucun ne cite un écran : ceux-là viennent de la carte de la console. */
const T = {
  fr: {
    aide: 'Aide',
    centre: 'Centre d’aide',
    recherche: 'Rechercher dans l’aide',
    detail: 'En détail',
    bonASavoir: 'Bon à savoir',
    offre: `Avec l’offre Pro, ou pendant l’essai Pro de ${ESSAI_PRO_JOURS} jours.`,
    ouvrir: (ecran: string) => `Ouvrir ${ecran} dans la console`,
    ouvrirConsole: 'Ouvrir la console',
    avant: 'D’abord :',
    precedent: 'Précédent :',
    suivant: 'Suivant :',
    question: 'Une question sans réponse ? Écrivez-nous',
    contact: '/contact/',
    legendeFilm: 'Vidéo sous-titrée, sans son.',
    etape: 'Étape',
    agrandir: 'Voir la capture en grand',
    titreSite: 'Aide Messaging Me',
    accueilChapeau: 'Les modes opératoires de la console Messaging Me, pas à pas : démarrer, puis parler à vos clients.',
    accueilOffre: `Les écrans de la console demandent l’offre Pro, essayable ${ESSAI_PRO_JOURS} jours.`,
    developpeurs: 'Depuis Claude Code',
    developpeursTexte: 'Une partie de ces gestes se fait aussi en le demandant à Claude, depuis Claude Code.',
    developpeursLien: 'Les pages développeurs',
    developpeursAdresse: '/developpeurs/',
  },
  en: {
    aide: 'Help',
    centre: 'Help center',
    recherche: 'Search the help',
    detail: 'In detail',
    bonASavoir: 'Good to know',
    offre: `With the Pro plan, or during the ${ESSAI_PRO_JOURS}-day Pro trial.`,
    ouvrir: (ecran: string) => `Open ${ecran} in the console`,
    ouvrirConsole: 'Open the console',
    avant: 'First:',
    precedent: 'Previous:',
    suivant: 'Next:',
    question: 'A question this page does not answer? Write to us',
    contact: '/en/contact/',
    legendeFilm: 'Subtitled video, no sound.',
    etape: 'Step',
    agrandir: 'View the screenshot full size',
    titreSite: 'Messaging Me Help',
    accueilChapeau: 'How-to guides for the Messaging Me console, step by step: get started, then talk to your customers.',
    accueilOffre: `The console screens require the Pro plan, with a ${ESSAI_PRO_JOURS}-day trial.`,
    developpeurs: 'From Claude Code',
    developpeursTexte: 'Some of these actions can also be done by asking Claude, from Claude Code.',
    developpeursLien: 'The developer pages',
    developpeursAdresse: '/en/developers/',
  },
} as const;

const echapper = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attribut = (t: string): string => echapper(t).replace(/"/g, '&quot;');
/** Le texte brut d'une ligne de fiche : sans le gras, pour une méta, un JSON-LD ou une recherche. */
const brut = (t: string): string => t.replace(/\*\*/g, '');

/** Une ligne de fiche en HTML : échappée, le gras rendu, et en français les espaces insécables de la ponctuation. */
function enLigne(t: string, langue: Langue): string {
  const h = echapper(t).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return langue === 'fr' ? insecables(h) : h;
}

/**
 * Les mots qu'un visiteur peut taper pour trouver une page : minuscules, sans accents, sans ponctuation. Le filtre du menu
 * (`site.js`) normalise ce qu'on tape de la même façon : « modele » trouve « Faire approuver un modèle ».
 */
export function motsDeRecherche(texte: string): string {
  return brut(texte).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

const bloc = (b: BlocFiche, langue: Langue): string => (b.type === 'paragraphe'
  ? `<p>${enLigne(b.texte, langue)}</p>`
  : `<ul>${b.items.map((i) => `<li>${enLigne(i, langue)}</li>`).join('')}</ul>`);

/** La capture d'une étape, si elle existe : `site/img/aide/<clé>/etape-<n>.webp`, et `-en` pour l'anglais. */
export const adresseCapture = (cle: string, numero: number, langue: Langue): string =>
  `/img/aide/${cle}/etape-${numero}${langue === 'en' ? '-en' : ''}.webp`;
const captureExiste = (adresse: string): boolean => existsSync(SITE(adresse.slice(1)));
/**
 * L'adresse d'une image ou d'un film, suivie de l'empreinte de son contenu : la vitrine les garde un jour en cache chez
 * le visiteur (`site/vercel.json`), et une capture refaite par `npm run aide:captures` garde son nom. L'empreinte change
 * avec le fichier, sans `?v=` à incrémenter à la main ; un fichier pas encore livré garde `?v=1`.
 */
const versionnee = (adresse: string): string => {
  const fichier = SITE(adresse.slice(1));
  return `${adresse}?v=${existsSync(fichier) ? createHash('sha256').update(readFileSync(fichier)).digest('hex').slice(0, 8) : '1'}`;
};

/** Le film d'une page, livré dans `site/films/` (tâche 11) : `aide-<clé>` et `-en`. */
const adresseFilm = (cle: string, langue: Langue, extension: 'mp4' | 'webp'): string =>
  `/films/aide-${cle}${langue === 'en' ? '-en' : ''}.${extension}`;

function corps(p: PageAide, langue: Langue): string {
  const v = p[langue];
  return structureFiche(v.corps, langue).sections.map((s) => {
    if (s.type === 'etape') {
      const capture = adresseCapture(p.cle, s.numero, langue);
      // Dans la page, la capture fait un tiers de sa taille : un clic ouvre l'image entière, sans script.
      const image = p.publication.captures && captureExiste(capture)
        ? `<a class="aide-capture" href="${versionnee(capture)}" title="${T[langue].agrandir}"><img src="${versionnee(capture)}" alt="${attribut(`${T[langue].etape} ${s.numero} : ${brut(s.titre)}`)}" width="1280" height="800" loading="lazy"></a>`
        : '';
      const detail = s.detail.length > 0
        ? `<details class="aide-detail"><summary>${T[langue].detail}</summary>${s.detail.map((b) => bloc(b, langue)).join('')}</details>`
        : '';
      return `      <div class="aide-etape${image === '' ? ' sans-capture' : ''}" id="etape-${s.numero}"><div><h3>${s.numero}. ${enLigne(s.titre, langue)}</h3><p>${enLigne(s.tete, langue)}</p>${detail}</div>${image}</div>`;
    }
    if (s.type === 'encadre') return `      <div class="aide-encadre"><strong>${T[langue].bonASavoir}</strong> ${enLigne(s.texte, langue)}</div>`;
    return `      <div class="aide-prose">${s.titre === null ? '' : `<h2>${enLigne(s.titre, langue)}</h2>`}${s.blocs.map((b) => bloc(b, langue)).join('')}</div>`;
  }).join('\n');
}

/** Le menu du centre, à gauche de chaque page : la recherche, puis les rubriques et leurs pages. */
function menu(pages: PageAide[], courante: PageAide | null, langue: Langue): string {
  const lignes = [
    `    <nav class="aide-nav" aria-label="${T[langue].centre}">`,
    `      <input class="aide-recherche" type="search" placeholder="${T[langue].recherche}" aria-label="${T[langue].recherche}">`,
  ];
  for (const r of RUBRIQUES) {
    lignes.push(`      <div class="aide-rubrique"><h3>${NOMS_RUBRIQUES[r][langue]}</h3>`);
    for (const p of pages.filter((x) => x.publication.rubrique === r)) {
      const v = p[langue];
      const mots = motsDeRecherche(`${v.titre} ${structureFiche(v.corps, langue).chapeau}`);
      const actif = p === courante ? ' class="actif" aria-current="page"' : '';
      lignes.push(`        <a href="${v.adresse}" data-mots="${mots}"${actif}>${echapper(v.titre)}</a>`);
    }
    lignes.push('      </div>');
  }
  lignes.push('    </nav>');
  return lignes.join('\n');
}

function film(p: PageAide, langue: Langue): string {
  if (!p.publication.video) return '';
  return [
    '      <figure class="aide-video">',
    `        <video class="f-video" src="${versionnee(adresseFilm(p.cle, langue, 'mp4'))}" poster="${versionnee(adresseFilm(p.cle, langue, 'webp'))}" width="1280" height="720" controls muted playsinline preload="none" aria-label="${attribut(p[langue].titre)}"></video>`,
      `        <figcaption>${T[langue].legendeFilm}</figcaption>`,
    '      </figure>',
  ].join('\n');
}

function pageAide(pages: PageAide[], p: PageAide, langue: Langue): { chemin: string; contenu: string } {
  const v = p[langue];
  const autre = p[langue === 'fr' ? 'en' : 'fr'];
  const s = structureFiche(v.corps, langue);
  const i = pages.indexOf(p);
  const [avant, apres] = [pages[i - 1], pages[i + 1]];
  const rubrique = NOMS_RUBRIQUES[p.publication.rubrique][langue];
  const ecran = CARTE_CONSOLE.find((e) => e.cle === p.ecran);
  const suffixeConsole = langue === 'en' ? '?lang=en' : '';
  const prerequis = pages.find((x) => x.cle === p.publication.prerequis);
  const etapes = s.sections.filter((x) => x.type === 'etape');

  const main = [
    '<main>',
    '<section class="cadre f-une guide-une aide-une">',
    '  <div>',
    `    <p class="aide-fil"><a href="${ACCUEIL_AIDE[langue]}">${T[langue].aide}</a> › <a href="${ACCUEIL_AIDE[langue]}#${p.publication.rubrique}">${rubrique}</a> › ${echapper(v.titre)}</p>`,
    `    <h1><span class="f-surtitre"><svg class="ic" aria-hidden="true"><use href="#i-file-text"/></svg>${T[langue].aide}</span> ${echapper(v.titre)}</h1>`,
    `    <p class="chapeau">${enLigne(s.chapeau, langue)}</p>`,
    ...(p.publication.offre ? [`    <p class="aide-offre">${langue === 'fr' ? insecables(T.fr.offre) : T.en.offre}</p>`] : []),
    '    <div class="appels">',
    `      <a class="bouton bouton-plein" href="${CONSOLE}${ecran?.href ?? '/'}${suffixeConsole}">${ecran ? T[langue].ouvrir(ecran[langue]) : T[langue].ouvrirConsole}</a>`,
    ...(prerequis ? [`      <a class="bouton bouton-texte" href="${prerequis[langue].adresse}">${T[langue].avant} ${echapper(prerequis[langue].titre)} <svg class="ic" aria-hidden="true"><use href="#i-fleche"/></svg></a>`] : []),
    '    </div>',
    '  </div>',
    '</section>',
    '',
    '<section class="f-bloc bande-claire">',
    '  <div class="cadre aide-grille">',
    menu(pages, p, langue),
    '    <article class="aide-article">',
    film(p, langue),
    corps(p, langue),
    '      <div class="aide-pied-page">',
    ...(avant ? [`        <a class="aide-precedente" href="${avant[langue].adresse}">${T[langue].precedent} ${echapper(avant[langue].titre)}</a>`] : []),
    ...(apres ? [`        <a class="aide-suivante" href="${apres[langue].adresse}">${T[langue].suivant} ${echapper(apres[langue].titre)}</a>`] : []),
    `        <a class="aide-question" href="${T[langue].contact}?aide=${v.adresse.split("/").filter(Boolean).pop()}">${langue === 'fr' ? insecables(T.fr.question) : T.en.question}</a>`,
    '      </div>',
    '    </article>',
    '  </div>',
    '</section>',
    '</main>',
  ].filter((l) => l !== '').join('\n');

  const langueLd = langue === 'fr' ? 'fr-FR' : 'en-US';
  const description = brut(s.chapeau);
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      fil(langue, [ACCUEIL[langue], [T[langue].centre, ACCUEIL_AIDE[langue]], [v.titre, v.adresse]]),
      etapes.length > 0
        ? {
          '@type': 'HowTo', name: v.titre, description, inLanguage: langueLd, url: ORIGINE + v.adresse,
          step: etapes.map((e) => ({
            '@type': 'HowToStep', position: e.numero, name: brut(e.titre), text: brut(e.tete), url: `${ORIGINE}${v.adresse}#etape-${e.numero}`,
          })),
        }
        : { '@type': 'TechArticle', headline: v.titre, description, inLanguage: langueLd, url: ORIGINE + v.adresse, publisher: ORGANISATION },
      ...(p.publication.video ? [{
        '@type': 'VideoObject', name: v.titre, description,
        thumbnailUrl: ORIGINE + adresseFilm(p.cle, langue, 'webp'), contentUrl: ORIGINE + adresseFilm(p.cle, langue, 'mp4'),
        inLanguage: langueLd, publisher: ORGANISATION,
      }] : []),
    ],
  };
  const contenu = page(langue, {
    adresse: v.adresse, jumelle: autre.adresse, titre: `${v.titre} | ${T[langue].titreSite}`, description, ldJson: ld,
    ...(p.publication.video ? { affiche: versionnee(adresseFilm(p.cle, langue, 'webp')) } : {}),
  }, main, `Centre d’aide, « ${p.fr.titre} », GÉNÉRÉ par npm run vitrine:aide depuis docs/aide/fiches/ : ne pas modifier à la main.`);
  return { chemin: fichierDe(v.adresse), contenu };
}

function accueilAide(pages: PageAide[], langue: Langue): { chemin: string; contenu: string } {
  const adresse = ACCUEIL_AIDE[langue];
  const lignes = [
    '<main>',
    '<section class="cadre f-une guide-une aide-une">',
    '  <div>',
    `    <h1><span class="f-surtitre"><svg class="ic" aria-hidden="true"><use href="#i-file-text"/></svg>${T[langue].aide}</span> ${T[langue].centre}</h1>`,
    `    <p class="chapeau">${langue === 'fr' ? insecables(T.fr.accueilChapeau) : T.en.accueilChapeau}</p>`,
    `    <p class="aide-offre">${langue === 'fr' ? insecables(T.fr.accueilOffre) : T.en.accueilOffre}</p>`,
    '  </div>',
    '</section>',
    '',
    '<section class="f-bloc bande-claire">',
    '  <div class="cadre aide-accueil">',
  ];
  for (const r of RUBRIQUES) {
    lignes.push(`    <h2 id="${r}">${NOMS_RUBRIQUES[r][langue]}</h2>`, '    <ul class="aide-cartes">');
    for (const p of pages.filter((x) => x.publication.rubrique === r)) {
      const v = p[langue];
      lignes.push(`      <li><a href="${v.adresse}"><strong>${echapper(v.titre)}</strong><small>${enLigne(structureFiche(v.corps, langue).chapeau, langue)}</small></a></li>`);
    }
    lignes.push('    </ul>');
  }
  lignes.push(
    `    <h2 id="claude-code">${T[langue].developpeurs}</h2>`,
    `    <p>${langue === 'fr' ? insecables(T.fr.developpeursTexte) : T.en.developpeursTexte}</p>`,
    // Chaque page Claude Code, et l'offre quand ses outils la demandent (relecture du lot 3 : l'accueil promettait
    // « tout en Free » alors que les outils de campagne sont fermés en Free ; `tests/vitrine-aide.test.ts` tient les deux).
    '    <ul class="aide-cartes">',
    ...PAGES_CLAUDE.map((p) => `      <li><a href="${p.adresse[langue]}"><strong>${echapper(p.titre[langue])}</strong><small>${enLigne(p.chapeau[langue], langue)}</small>${p.offrePro ? `<small class="aide-carte-offre">${langue === 'fr' ? insecables(T.fr.offre) : T.en.offre}</small>` : ''}</a></li>`),
    '    </ul>',
    `    <p><a href="${T[langue].developpeursAdresse}">${T[langue].developpeursLien}</a></p>`,
    '  </div>',
    '</section>',
    '</main>',
  );
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      fil(langue, [ACCUEIL[langue], [T[langue].centre, adresse]]),
      {
        '@type': 'CollectionPage', name: T[langue].centre, description: T[langue].accueilChapeau, url: ORIGINE + adresse,
        inLanguage: langue === 'fr' ? 'fr-FR' : 'en-US', publisher: ORGANISATION,
        hasPart: pages.map((p) => ({ '@type': 'WebPage', name: p[langue].titre, url: ORIGINE + p[langue].adresse })),
      },
    ],
  };
  const contenu = page(langue, {
    adresse, jumelle: ACCUEIL_AIDE[langue === 'fr' ? 'en' : 'fr'], titre: `${T[langue].centre} | Messaging Me`,
    description: T[langue].accueilChapeau, ldJson: ld,
  }, lignes.join('\n'), 'Accueil du centre d’aide, GÉNÉRÉ par npm run vitrine:aide depuis docs/aide/fiches/ : ne pas modifier à la main.');
  return { chemin: fichierDe(adresse), contenu };
}

/** Les textes propres aux pages « Depuis Claude Code ». */
const TC = {
  fr: {
    surtitre: 'Depuis Claude Code',
    developpeurs: 'Développeurs',
    guideMeta: 'Votre compte Meta Business',
    vous: 'Vous',
    appelle: 'Claude appelle',
    claude: 'Claude',
    plugin: 'Voir le plugin sur GitHub',
    titreSite: 'Développeurs Messaging Me',
  },
  en: {
    surtitre: 'From Claude Code',
    developpeurs: 'Developers',
    guideMeta: 'Your Meta Business account',
    vous: 'You',
    appelle: 'Claude calls',
    claude: 'Claude',
    plugin: 'See the plugin on GitHub',
    titreSite: 'Messaging Me Developers',
  },
} as const;
const DEPOT_PLUGIN = 'https://github.com/julienmessagingme/messagingme-plugin';
const DEVELOPPEURS: Readonly<Record<Langue, string>> = { fr: '/developpeurs/', en: '/en/developers/' };
const GUIDE_META: Readonly<Record<Langue, string>> = { fr: '/developpeurs/compte-meta-business/', en: '/en/developers/meta-business-account/' };

/** Ce que la personne dit ou tape : un texte entre accents graves est une commande, rendue telle quelle. */
function dire(t: string, langue: Langue): string {
  return t.split('`').map((morceau, i) => (i % 2 === 1 ? `<code>${echapper(morceau)}</code>` : enLigne(morceau, langue))).join('');
}

function menuDeveloppeurs(courante: PageClaude, langue: Langue): string {
  return [
    `    <nav class="aide-nav" aria-label="${TC[langue].developpeurs}">`,
    `      <div class="aide-rubrique"><h3>${TC[langue].developpeurs}</h3>`,
    `        <a href="${DEVELOPPEURS[langue]}">${TC[langue].developpeurs}</a>`,
    `        <a href="${GUIDE_META[langue]}">${TC[langue].guideMeta}</a>`,
    '      </div>',
    `      <div class="aide-rubrique"><h3>${TC[langue].surtitre}</h3>`,
    ...PAGES_CLAUDE.map((p) => `        <a href="${p.adresse[langue]}"${p === courante ? ' class="actif" aria-current="page"' : ''}>${echapper(p.titre[langue])}</a>`),
    '      </div>',
    '    </nav>',
  ].join('\n');
}

function pageClaude(p: PageClaude, langue: Langue): { chemin: string; contenu: string } {
  const i = PAGES_CLAUDE.indexOf(p);
  const [avant, apres] = [PAGES_CLAUDE[i - 1], PAGES_CLAUDE[i + 1]];
  const suffixe = langue === 'en' ? '-en' : '';
  const etapes = p.etapes.map((e, n) => {
    const outils = e.outils.length === 0 ? ''
      : `<p class="aide-outils"><span>${TC[langue].appelle}</span> ${e.outils.map((o) => `<code data-outil="${o}">${o}</code>`).join(', ')}</p>`;
    return `      <div class="aide-etape sans-capture" id="etape-${n + 1}"><div><h3>${n + 1}. ${enLigne(e.titre[langue], langue)}</h3>`
      + `<div class="aide-echange"><p class="aide-vous"><span>${TC[langue].vous}</span> ${dire(e.dire[langue], langue)}</p>${outils}`
      + `<p class="aide-claude"><span>${TC[langue].claude}</span> ${enLigne(e.reponse[langue], langue)}</p></div></div></div>`;
  });
  const main = [
    '<main>',
    '<section class="cadre f-une guide-une aide-une">',
    '  <div>',
    `    <p class="aide-fil"><a href="${DEVELOPPEURS[langue]}">${TC[langue].developpeurs}</a> › ${echapper(p.titre[langue])}</p>`,
    `    <h1><span class="f-surtitre"><svg class="ic" aria-hidden="true"><use href="#i-code"/></svg>${TC[langue].surtitre}</span> ${echapper(p.titre[langue])}</h1>`,
    `    <p class="chapeau">${enLigne(p.chapeau[langue], langue)}</p>`,
    ...(p.offrePro ? [`    <p class="aide-offre">${langue === 'fr' ? insecables(T.fr.offre) : T.en.offre}</p>`] : []),
    '    <div class="appels">',
    `      <a class="bouton bouton-plein" href="${DEPOT_PLUGIN}">${TC[langue].plugin}</a>`,
    '    </div>',
    '  </div>',
    '</section>',
    '',
    '<section class="f-bloc bande-claire">',
    '  <div class="cadre aide-grille">',
    menuDeveloppeurs(p, langue),
    '    <article class="aide-article">',
    ...(p.film ? [
      '      <figure class="aide-video">',
      `        <video class="f-video" src="${versionnee(`/films/${p.film}${suffixe}.mp4`)}" poster="${versionnee(`/films/${p.film}${suffixe}.webp`)}" width="1280" height="720" controls muted playsinline preload="none" aria-label="${attribut(p.titre[langue])}"></video>`,
      '      </figure>',
    ] : []),
    ...etapes,
    ...(p.bonASavoir ? [`      <div class="aide-encadre"><strong>${T[langue].bonASavoir}</strong> ${enLigne(p.bonASavoir[langue], langue)}</div>`] : []),
    '      <div class="aide-pied-page">',
    ...(avant ? [`        <a class="aide-precedente" href="${avant.adresse[langue]}">${T[langue].precedent} ${echapper(avant.titre[langue])}</a>`] : []),
    ...(apres ? [`        <a class="aide-suivante" href="${apres.adresse[langue]}">${T[langue].suivant} ${echapper(apres.titre[langue])}</a>`] : []),
    `        <a class="aide-question" href="${T[langue].contact}">${langue === 'fr' ? insecables(T.fr.question) : T.en.question}</a>`,
    '      </div>',
    '    </article>',
    '  </div>',
    '</section>',
    '</main>',
  ].join('\n');
  const langueLd = langue === 'fr' ? 'fr-FR' : 'en-US';
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      fil(langue, [ACCUEIL[langue], [TC[langue].developpeurs, DEVELOPPEURS[langue]], [p.titre[langue], p.adresse[langue]]]),
      {
        '@type': 'HowTo', name: p.titre[langue], description: p.chapeau[langue], inLanguage: langueLd, url: ORIGINE + p.adresse[langue],
        step: p.etapes.map((e, n) => ({
          '@type': 'HowToStep', position: n + 1, name: e.titre[langue], text: e.reponse[langue], url: `${ORIGINE}${p.adresse[langue]}#etape-${n + 1}`,
        })),
      },
    ],
  };
  const contenu = page(langue, {
    adresse: p.adresse[langue], jumelle: p.adresse[langue === 'fr' ? 'en' : 'fr'], titre: `${p.titre[langue]} | ${TC[langue].titreSite}`,
    description: p.chapeau[langue], ldJson: ld, ...(p.film ? { affiche: versionnee(`/films/${p.film}${suffixe}.webp`) } : {}),
  }, main, `Page « ${p.titre.fr} », GÉNÉRÉE par npm run vitrine:aide depuis scripts/vitrine/aide-claude-textes.ts : ne pas modifier à la main.`);
  return { chemin: fichierDe(p.adresse[langue]), contenu };
}

/**
 * Toutes les pages générées ici, dans les deux langues : l'accueil du centre d'aide, une page par fiche publique, et les
 * pages « Depuis Claude Code » de la doc développeurs.
 */
export function pagesAide(): Array<{ chemin: string; contenu: string }> {
  const pages = pagesDuCentre();
  return (['fr', 'en'] as const).flatMap((langue) => [
    accueilAide(pages, langue),
    ...pages.map((p) => pageAide(pages, p, langue)),
    ...PAGES_CLAUDE.map((p) => pageClaude(p, langue)),
  ]);
}

/** Les adresses absolues des pages générées ici, telles que le plan du site et `llms.txt` les citent. */
export function adressesAide(): string[] {
  const pages = pagesDuCentre();
  return (['fr', 'en'] as const)
    .flatMap((l) => [ACCUEIL_AIDE[l], ...pages.map((p) => p[l].adresse), ...PAGES_CLAUDE.map((p) => p.adresse[l])])
    .map((a) => ORIGINE + a);
}

/** Le plan du site avec les adresses du centre d'aide à jour : les anciennes retirées, les actuelles avant la fin. */
export function sitemapAvecAide(xml: string): string {
  const nos = adressesAide();
  const sans = xml.split('\n').filter((l) => !/<loc>https:\/\/app\.messagingme\.fr\/(aide|en\/help)\//.test(l)
    && !nos.some((a) => l.includes(`<loc>${a}</loc>`)));
  const fin = sans.findIndex((l) => l.trim() === '</urlset>');
  if (fin < 0) throw new Error('sitemap.xml : </urlset> introuvable');
  return [...sans.slice(0, fin), ...adressesAide().map((a) => `  <url><loc>${a}</loc></url>`), ...sans.slice(fin)].join('\n');
}

/** La section « ## Aide » de `llms.txt`, posée avant « ## Tarifs ». */
export function llmsAvecAide(contenu: string): string {
  const pages = pagesDuCentre();
  const section = [
    '## Aide',
    '',
    `- [Centre d’aide](${ORIGINE}${ACCUEIL_AIDE.fr}) : les modes opératoires de la console, pas à pas.`,
    `- [Help center](${ORIGINE}${ACCUEIL_AIDE.en}) : the same pages in English.`,
    ...pages.flatMap((p) => (['fr', 'en'] as const).map((l) =>
      `- [${p[l].titre}](${ORIGINE}${p[l].adresse}) : ${brut(structureFiche(p[l].corps, l).chapeau)}`)),
    ...PAGES_CLAUDE.flatMap((p) => (['fr', 'en'] as const).map((l) => `- [${p.titre[l]}](${ORIGINE}${p.adresse[l]}) : ${p.chapeau[l]}`)),
    '',
  ].join('\n');
  const debut = contenu.indexOf('## Aide\n');
  if (debut >= 0) {
    const fin = contenu.indexOf('\n## ', debut + 3);
    if (fin < 0) throw new Error('llms.txt : la section Aide doit être suivie d’une autre');
    return contenu.slice(0, debut) + section + '\n' + contenu.slice(fin + 1);
  }
  const tarifs = contenu.indexOf('## Tarifs');
  if (tarifs < 0) throw new Error('llms.txt : section Tarifs introuvable');
  return contenu.slice(0, tarifs) + section + '\n' + contenu.slice(tarifs);
}

/** La correspondance écran vers page « Comment faire », pour la console (`web/lib/aide-pages.ts`). */
export function fichierCommentFaire(): string {
  const entrees = pagesDuCentre().filter((p) => p.publication.commentFaire && p.ecran !== null)
    .map((p) => `  ${JSON.stringify(p.ecran)}: { fr: ${JSON.stringify(ORIGINE + p.fr.adresse)}, en: ${JSON.stringify(ORIGINE + p.en.adresse)} },`);
  return [
    '/**',
    ' * LES PAGES « COMMENT FAIRE » DE LA CONSOLE, ÉMISES par `npm run vitrine:aide` depuis les fiches publiques',
    ' * (`docs/aide/fiches/`, champ `comment_faire`). Ne pas éditer à la main : `tests/vitrine-aide.test.ts` compare ce',
    ' * fichier à sa génération. La clé est l’écran de la console (`web/lib/nav.ts`), la valeur la page du centre d’aide.',
    ' */',
    'export const PAGES_COMMENT_FAIRE: Readonly<Record<string, { fr: string; en: string }>> = {',
    ...entrees,
    '};',
    '',
  ].join('\n');
}

function main(): void {
  const pages = pagesAide();
  for (const { chemin, contenu } of pages) {
    mkdirSync(dirname(SITE(chemin)), { recursive: true });
    writeFileSync(SITE(chemin), contenu);
  }
  writeFileSync(SITE('sitemap.xml'), sitemapAvecAide(readFileSync(SITE('sitemap.xml'), 'utf8')));
  writeFileSync(SITE('llms.txt'), llmsAvecAide(readFileSync(SITE('llms.txt'), 'utf8')));
  writeFileSync(WEB('lib/aide-pages.ts'), fichierCommentFaire());
  console.log(`${pages.length} pages du centre d’aide écrites, le plan du site, llms.txt et web/lib/aide-pages.ts`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
