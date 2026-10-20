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
import { pageAvecEntete } from './entete';

const ORIGINE = 'https://app.messagingme.fr';
const CONSOLE = 'https://console.messagingme.app';
const SITE = (p: string) => fileURLToPath(new URL(`../../site/${p}`, import.meta.url));

const echapper = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Le chemin d'une page dans `site/` depuis son adresse : `/cas-d-usage/x/` -> `cas-d-usage/x/index.html`. */
export const fichierDe = (adresse: string): string => `${adresse.slice(1)}index.html`;

/** La page Développeurs de la langue : sa tête, ses icônes, son en-tête et son pied servent de gabarit. */
function gabarit(langue: Langue): string {
  return readFileSync(SITE(langue === 'fr' ? 'developpeurs/index.html' : 'en/developers/index.html'), 'utf8');
}

interface Tete {
  readonly adresse: string;
  readonly jumelle: string;
  readonly titre: string;
  readonly description: string;
  readonly ldJson: object;
  readonly affiche?: string;
}

/** Une page complète : la tête de la page Développeurs réécrite, et son `<main>` remplacé. */
function page(langue: Langue, tete: Tete, main: string, commentaire: string): string {
  const fr = langue === 'fr';
  const [aFr, aEn] = fr ? [tete.adresse, tete.jumelle] : [tete.jumelle, tete.adresse];
  let s = gabarit(langue);
  const rempl = (re: RegExp, par: string, quoi: string) => {
    if (!re.test(s)) throw new Error(`gabarit : ${quoi} introuvable`);
    s = s.replace(re, () => par);
  };
  rempl(/<!doctype html>\n<!--[\s\S]*?-->\n/, `<!doctype html>\n<!-- ${commentaire} -->\n`, 'commentaire');
  rempl(/<title>[^<]*<\/title>/, `<title>${echapper(tete.titre)}</title>`, 'title');
  rempl(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${echapper(tete.description)}">`, 'description');
  rempl(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${ORIGINE}${tete.adresse}">`, 'canonical');
  rempl(/<link rel="alternate" hreflang="fr" href="[^"]*">/, `<link rel="alternate" hreflang="fr" href="${ORIGINE}${aFr}">`, 'hreflang fr');
  rempl(/<link rel="alternate" hreflang="en" href="[^"]*">/, `<link rel="alternate" hreflang="en" href="${ORIGINE}${aEn}">`, 'hreflang en');
  rempl(/<link rel="alternate" hreflang="x-default" href="[^"]*">/, `<link rel="alternate" hreflang="x-default" href="${ORIGINE}${aFr}">`, 'x-default');
  rempl(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${ORIGINE}${tete.adresse}">`, 'og:url');
  rempl(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${echapper(tete.titre)}">`, 'og:title');
  rempl(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${echapper(tete.description)}">`, 'og:description');
  if (tete.affiche) rempl(/<meta property="og:image" content="[^"]*">/, `<meta property="og:image" content="${ORIGINE}${tete.affiche}">`, 'og:image');
  rempl(/<script type="application\/ld\+json">\n\{[\s\S]*?\n\}\n<\/script>\n<\/head>/,
    `<script type="application/ld+json">\n${JSON.stringify(tete.ldJson, null, 1)}\n</script>\n</head>`, 'JSON-LD');
  rempl(/<main>[\s\S]*?<\/main>/, main, 'main');
  return pageAvecEntete(s, fichierDe(tete.adresse));
}

const fil = (langue: Langue, elements: ReadonlyArray<[string, string]>) => ({
  '@type': 'BreadcrumbList',
  itemListElement: elements.map(([nom, adresse], i) => ({ '@type': 'ListItem', position: i + 1, name: nom, item: ORIGINE + adresse })),
});
const ACCUEIL: Record<Langue, [string, string]> = { fr: ['Accueil', '/'], en: ['Home', '/en/'] };

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
};

/** L'extrait de code d'une page : une partie de `EXEMPLES_CAS` (compilée), ou d'`EXTRAITS_CONSOLE`, telle quelle. */
export function extraitDe(cle: string, partie: string): ExempleCode {
  const cas = (EXEMPLES_CAS as Record<string, Record<string, ExempleCode>>)[cle] ?? EXTRAITS_CONSOLE[cle];
  const ex = cas?.[partie];
  if (!ex) throw new Error(`extrait absent : cas.${cle}.${partie}`);
  return ex;
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
    `      <h1><span class="f-surtitre"><svg class="ic" aria-hidden="true"><use href="#${t.icone}"/></svg>${echapper(langue === 'fr' ? 'Cas d’usage' : 'Use case')}</span>${t.h1}</h1>`,
    `      <p class="chapeau">${t.chapeau}</p>`,
    '      <div class="appels">',
    `        <a class="bouton bouton-plein" href="${demarrer}">${langue === 'fr' ? 'Installer le plugin' : 'Install the plugin'}</a>`,
    `        <a class="bouton bouton-texte" href="#film">${langue === 'fr' ? 'Voir le film' : 'Watch the film'} <svg class="ic" aria-hidden="true"><use href="#i-fleche"/></svg></a>`,
    '      </div>',
    '    </div>',
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
    '  <section class="f-bloc cas-pas">',
    '    <div class="cadre">',
    `      <h2 class="f-titre">${langue === 'fr' ? 'Pas à pas, avec le vrai.' : 'Step by step, for real.'}</h2>`,
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
    `      <h2 class="f-titre">${langue === 'fr' ? 'Ce que vous payez.' : 'What you pay.'}</h2>`,
    '      <ul class="tarif-liste cas-liste">',
    ...t.paie.map((x) => `        <li>${x}</li>`),
    '      </ul>',
    '    </div>',
    '  </section>',
    '',
    '  <section class="f-bloc cas-faq" id="faq">',
    '    <div class="cadre">',
    `      <h2 class="f-titre">${langue === 'fr' ? 'Questions fréquentes.' : 'Frequently asked questions.'}</h2>`,
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
export function pagesCarrefour(): Array<{ chemin: string; contenu: string }> {
  const enLigne = ENTREES.filter((e) => e.enLigne && e.nature === 'cas');
  return (['fr', 'en'] as const).map((langue) => {
    const c = TEXTES_CARREFOUR[langue];
    const autre = TEXTES_CARREFOUR[langue === 'fr' ? 'en' : 'fr'];
    const cartes = enLigne.map((e) => {
      const p = langue === 'fr' ? e.fr : e.en;
      const resume = TEXTES_CAS[e.cle]![langue].resume;
      return `        <li><a class="cas-carte" href="${p.adresse}"><strong>${echapper(p.titre)}</strong><span>${resume}</span><span class="cas-lien">${langue === 'fr' ? 'Voir le cas' : 'See the use case'} <svg class="ic" aria-hidden="true"><use href="#i-fleche"/></svg></span></a></li>`;
    });
    const main = [
      '<main>',
      '  <section class="cadre f-une cas-une">',
      '    <div>',
      `      <h1><span class="f-surtitre"><svg class="ic" aria-hidden="true"><use href="#i-list-checks"/></svg>${c.fil}</span>${c.h1}</h1>`,
      `      <p class="chapeau">${c.chapeau}</p>`,
      '    </div>',
      '  </section>',
      '  <section class="f-bloc cas-carrefour">',
      '    <div class="cadre">',
      '      <ul class="cas-cartes">',
      ...cartes,
      '      </ul>',
      '    </div>',
      '  </section>',
      '</main>',
    ].join('\n');
    const ld = { '@context': 'https://schema.org', '@graph': [fil(langue, [ACCUEIL[langue], [c.fil, c.adresse]])] };
    return {
      chemin: fichierDe(c.adresse),
      contenu: page(langue, { adresse: c.adresse, jumelle: autre.adresse, titre: c.titre, description: c.description, ldJson: ld }, main,
        'Le carrefour des cas d’usage, GÉNÉRÉ par npm run vitrine:cas depuis le registre : ne pas modifier à la main.'),
    };
  });
}

/** Tout ce que `npm run vitrine:cas` écrit. */
export function pagesGenerees(): Array<{ chemin: string; contenu: string }> {
  return [...pagesCarrefour(), ...ENTREES.filter((e) => e.enLigne && e.nature === 'cas').flatMap(pagesCas)];
}

/** La section « Cas d'usage » de `llms.txt` : le carrefour, puis chaque cas en ligne, en français puis en anglais. */
export function sectionLlms(): string {
  const enLigne = ENTREES.filter((e) => e.enLigne && e.nature === 'cas');
  const texte = (h: string) => h.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');
  return [
    '## Cas d’usage',
    '',
    `- [Tous les cas d’usage](${ORIGINE}${TEXTES_CARREFOUR.fr.adresse}) : ${TEXTES_CARREFOUR.fr.description}`,
    `- [All use cases](${ORIGINE}${TEXTES_CARREFOUR.en.adresse}) : the same page in English.`,
    ...enLigne.flatMap((e) => [
      `- [${e.fr.titre}](${ORIGINE}${e.fr.adresse}) : ${texte(TEXTES_CAS[e.cle]!.fr.resume)}`,
      `- [${e.en.titre}](${ORIGINE}${e.en.adresse}) : ${texte(TEXTES_CAS[e.cle]!.en.resume)}`,
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
