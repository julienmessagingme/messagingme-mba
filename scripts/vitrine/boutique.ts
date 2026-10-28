// scripts/vitrine/boutique.ts
// Les pages « boutique » de la rubrique Solutions (la première : Boutiques Shopify, 2026-10-24), dans les deux langues,
// depuis `boutique-textes.ts`, écrites par `npm run vitrine:cas` avec les autres pages de la rubrique. Plan
// `docs/superpowers/plans/2026-10-24-boutiques-shopify.md`. Une troisième nature de page : ni références clients ni cas
// de terrain, mais deux portes (Claude Code, la console) et le guide du numéro, que `site.js` rend interactif et qui
// reste lisible sans script (ses issues en liste). Son film (lot 3, 2026-10-28) suit le scénario et sert d'image de partage.
import { DEPOT_PLUGIN } from '../../web/lib/demarrer';
import { ENTREES, type EntreeVitrine } from '../../web/lib/registre-vitrine';
import { ACCUEIL, fichierDe, fil, page } from './cas';
import type { Langue } from './cas-textes';
import { insecables } from './guide-meta';
import { TEXTES_BOUTIQUES, type Carte, type Etape, type Issue, type Question, type Reponse, type TexteBoutique, type Voie } from './boutique-textes';

const ORIGINE = 'https://app.messagingme.fr';
const CONSOLE = 'https://console.messagingme.app';
const BAYMARD = 'https://baymard.com/lists/cart-abandonment-rate';
const PLUGIN: Readonly<Record<Langue, string>> = { fr: '/developpeurs/installer-le-plugin/', en: '/en/developers/install-the-plugin/' };
const AIDE: Readonly<Record<Langue, string>> = { fr: '/aide/brancher-ma-boutique-shopify/', en: '/en/help/connect-my-shopify-store/' };
const TARIFS: Readonly<Record<Langue, string>> = { fr: '/tarifs/', en: '/en/pricing/' };
const CONTACT: Readonly<Record<Langue, string>> = { fr: '/contact/#formulaire', en: '/en/contact/#formulaire' };
/**
 * L'inscription qui mène à la souscription du Pro (`?offre=pro`, `arriveeDUnNouvelEspace`, `web/lib/session.ts`), jamais
 * au tunnel de la Free, qui est le chemin d'une inscription sans ce drapeau : la console est celle du Pro, donc les
 * boutons qui y mènent (« Tout faire depuis la console », la fin Pro du guide du numéro) la prennent tous.
 */
const inscriptionPro = (langue: Langue): string => `${CONSOLE}/signup?offre=pro${langue === 'en' ? '&amp;lang=en' : ''}`;

/** Le texte brut d'un fragment : sans balises ni entités, pour une méta ou un JSON-LD. */
const brut = (h: string): string => h.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const fleche = '<svg class="ic" aria-hidden="true"><use href="#i-fleche"/></svg>';
const deux = (l: readonly [string, string]) => `${l[0]} <span class="sec-accent">${l[1]}</span>`;

function telephone(t: TexteBoutique['telephone']): string[] {
  const bulle = (b: TexteBoutique['telephone']['bulles'][number]) => `            <li class="bulle ${b.envoye ? 'envoye' : 'recu'}"><p>${b.texte}${b.pied ? `<span class="bt-pied">${b.pied}</span>` : ''}<span class="heure">${b.heure}${b.envoye ? ' <svg class="ic" aria-hidden="true"><use href="#i-coches"/></svg>' : ''}</span></p></li>`;
  return [
    `    <figure class="bt-tel" role="img" aria-label="${t.aria}">`,
    '      <div class="tel tel-wa">',
    '        <i class="btn b1"></i><i class="btn b2"></i><i class="btn b3"></i><i class="btn b4"></i>',
    '        <div class="ecran">',
    '          <div class="ios" aria-hidden="true"><span>18:14</span><span class="ilot"></span><span class="etat"><svg class="ic"><use href="#i-signal"/></svg><svg class="ic"><use href="#i-wifi"/></svg><svg class="ic pile"><use href="#i-pile"/></svg></span></div>',
    `          <div class="wa-tete" aria-hidden="true"><svg class="ic"><use href="#i-caret-left"/></svg><span class="avatar">VB</span><span class="qui"><strong>${t.boutique}</strong><small>${t.compte}</small></span></div>`,
    '          <ol class="wa-fil" aria-hidden="true">',
    `            <li class="jour">${t.jour}</li>`,
    ...t.bulles.map(bulle),
    '          </ol>',
    '          <div class="saisie" aria-hidden="true"><svg class="ic"><use href="#i-plus"/></svg><span class="champ"></span><svg class="ic"><use href="#i-camera"/></svg><svg class="ic"><use href="#i-micro"/></svg></div>',
    '        </div>',
    '      </div>',
    '    </figure>',
  ];
}

const cartes = (liste: readonly Carte[], offre: string) => [
  '      <ul class="bt-cartes">',
  ...liste.map((c) => `        <li>${c.icone ? `<span class="bt-ic"><svg class="ic" aria-hidden="true"><use href="#${c.icone}"/></svg></span>` : ''}<h3>${c.titre}${c.offre ? ` <span class="bt-offre">${offre} ${c.offre}</span>` : ''}</h3><p>${c.texte}</p></li>`),
  '      </ul>',
];

const etapes = (liste: readonly Etape[]) => [
  '      <ol class="bt-etapes">',
  ...liste.map((e, i) => `        <li><span class="bt-num">${i + 1}</span><div><h3>${e.titre}</h3><p>${e.texte}</p></div></li>`),
  '      </ol>',
];

/**
 * Le guide du numéro : l'arbre de Julien, en tunnel depuis le 2026-10-27 (« c'est le début de l'onboarding ») : une
 * carte, la question en cours en grand et l'étape au-dessus (`{n}` sur le plus long parcours de l'arbre), puis les mots
 * qu'il emploie, repliés dessous. L'offre ouvre le tunnel ; une question à cartes (`voies`) porte SOUS chaque carte la
 * réponse de même rang. Sans script, les questions restent cachées et ses issues se lisent l'une sous l'autre, chacune
 * précédée de la situation qu'elle sert et suivie des boutons de chaque offre ; avec `site.js`, chaque réponse montre la
 * question suivante (`data-vers`) ou une issue (`data-chemin`), la question répondue se replie en une ligne (sa réponse
 * dans `data-resume`) que « Modifier » rouvre, l'offre choisie (`data-offre`) ne laisse que ses boutons, et une réponse
 * sans `data-vers` (« Je ne sais pas ») déplie l'aide de sa question.
 */
function guide(t: TexteBoutique, langue: Langue): string[] {
  const n = t.numero;
  const a = n.appels;
  // Le plus long parcours, en questions : la jauge et « Question n sur … » le lisent dans l'arbre, jamais écrit à la main.
  const profondeur = (id: string): number => {
    const q = n.questions.find((x) => x.id === id);
    return q ? 1 + Math.max(...q.reponses.map((r) => (r.vers ? profondeur(r.vers) : 0))) : 0;
  };
  const max = profondeur(n.questions[0]!.id);
  const progression = n.progression.replace('{max}', String(max));
  const bouton = (q: Question, r: Reponse, k: number) => (r.vers
    ? `<button type="button" class="bouton bouton-trait" data-vers="${r.vers}"${r.offre ? ` data-offre="${r.offre}"` : ''}${r.note ? ` data-note="note-${q.id}-${k}"` : ''} aria-pressed="false">${r.libelle}</button>`
    : `<button type="button" class="bouton bouton-texte" data-aide aria-expanded="false">${r.libelle}</button>`);
  // Une question à cartes : sous chaque carte, la réponse de même rang ; ce qui reste (« Je ne sais pas ») vient dessous.
  const reponses = (q: Question): string[] => {
    const toutes = q.reponses.map((r, k) => ({ r, k }));
    if (!q.voies) return [`            <div class="bt-reponses">${toutes.map(({ r, k }) => bouton(q, r, k)).join('')}</div>`];
    const menent = toutes.filter(({ r }) => r.vers);
    const autres = toutes.filter(({ r }) => !r.vers);
    if (menent.length !== q.voies.length) throw new Error(`boutique : ${q.id} a ${q.voies.length} cartes et ${menent.length} réponses qui mènent quelque part`);
    return [
      `            <div class="bt-voies" id="voies-${q.id}">`,
      ...q.voies.flatMap((v, i) => ['              <div class="bt-voie-choix">', ...voie(v), `                ${bouton(q, menent[i]!.r, menent[i]!.k)}`, '              </div>']),
      '            </div>',
      ...(autres.length > 0 ? [`            <div class="bt-reponses">${autres.map(({ r, k }) => bouton(q, r, k)).join('')}</div>`] : []),
    ];
  };
  const question = (q: Question, i: number) => [
    `          <fieldset class="bt-question" data-question="${q.id}"${q.voies ? ` aria-describedby="voies-${q.id}"` : ''}${i > 0 ? ' hidden' : ''}>`,
    `            <legend${q.logo ? ' class="bt-avec-logo"' : ''}>${q.logo ? `<img class="bt-logo" src="${q.logo}" alt="" width="40" height="40">` : ''}${q.texte}${q.precision ? `<span class="bt-precision">${q.precision}</span>` : ''}</legend>`,
    // Repliée, la question montre ici la réponse donnée, puis « Modifier ».
    '            <span class="bt-resume" data-resume></span>',
    ...reponses(q),
    `            <button type="button" class="bt-modifier" data-modifier>${n.modifier}</button>`,
    ...(q.aide ? [`            <p class="bt-aide" hidden>${q.aide}</p>`] : []),
    ...q.reponses.flatMap((r, k) => (r.note ? [`            <p class="bt-note-reponse" id="note-${q.id}-${k}" role="status" hidden>${r.note}</p>`] : [])),
    '          </fieldset>',
  ];
  const ligne = (classe: string, icone: string, sr: string) => (x: string) =>
    `                    <li class="${classe}"><svg class="ic" aria-hidden="true"><use href="#${icone}"/></svg><span class="bt-sr">${sr} </span>${x}</li>`;
  const voie = (v: Voie) => [
    '                <section class="bt-voie">',
    `                  <h4>${v.titre}</h4>`,
    '                  <ul>',
    ...v.plus.map(ligne('bt-plus', 'i-check', n.plus)),
    ...v.moins.map(ligne('bt-moins', 'i-x', n.moins)),
    '                  </ul>',
    '                </section>',
  ];
  const inscription = inscriptionPro(langue);
  // Le bout du tunnel, par offre (Julien, 2026-10-27) : en Free, le plugin, son dépôt et la demande à coller dans Claude
  // Code ; en Pro, la console et le pas-à-pas de ce chemin. Une issue sans pas-à-pas n'existe pas en Pro.
  const issue = (x: Issue) => [
    `        <article class="bt-chemin" data-chemin="${x.id}" id="numero-${x.id}">`,
    `          <p class="bt-situation">${x.situation}</p>`,
    `          <h3>${x.titre}</h3>`,
    ...x.textes.map((p) => `          <p>${p}</p>`),
    ...(x.voies ? ['          <div class="bt-voies">', ...x.voies.flatMap(voie), '          </div>'] : []),
    '          <div class="bt-appels" data-offre="free">',
    `            <p class="bt-appels-titre">${a.free}</p>`,
    `            <div class="bt-appels-boutons"><a class="bouton bouton-plein" href="${PLUGIN[langue]}">${a.plugin}</a><a class="bouton bouton-trait" href="${DEPOT_PLUGIN}" rel="noopener"><svg class="ic" aria-hidden="true"><use href="#i-github"/></svg>${a.github}</a></div>`,
    `            <p class="bt-demande-titre">${a.demande}</p>`,
    `            <div class="bt-demande"><p id="demande-${x.id}">${x.demande}</p><button type="button" class="bouton bouton-trait" data-copier="demande-${x.id}" data-copie="${a.copie}" hidden>${a.copier}</button></div>`,
    '          </div>',
    ...(x.pasAPas ? [
      '          <div class="bt-appels" data-offre="pro">',
      `            <p class="bt-appels-titre">${a.pro}</p>`,
      `            <div class="bt-appels-boutons"><a class="bouton bouton-plein" href="${inscription}">${a.compte}</a><a class="bouton bouton-trait" href="${x.pasAPas}">${a.pasAPas}</a></div>`,
      '          </div>',
    ] : []),
    '        </article>',
  ];
  return [
    '      <div class="bt-guide" data-guide-numero>',
    '        <div class="bt-tunnel">',
    `          <div class="bt-progression" data-progression="${progression}" data-max="${max}" data-fin="${n.fin}" hidden>`,
    `            <p class="bt-etape" data-etape>${progression.replace('{n}', '1')}</p>`,
    '            <div class="bt-piste" aria-hidden="true"><span class="bt-jauge" data-jauge></span></div>',
    '          </div>',
    '          <div class="bt-questions" hidden>',
    ...n.questions.flatMap(question),
    `            <button type="button" class="bt-recommencer" data-recommencer hidden>${n.recommencer}</button>`,
    '          </div>',
    '          <div class="bt-chemins" aria-live="polite">',
    ...n.issues.flatMap(issue),
    '          </div>',
    '        </div>',
    '        <details class="bt-lexique">',
    `          <summary>${n.lexique.titre}<svg class="ic" aria-hidden="true"><use href="#i-caret-down"/></svg></summary>`,
    '          <dl>',
    ...n.lexique.termes.map((x) => `            <div><dt>${x.terme}</dt><dd>${x.definition}</dd></div>`),
    '          </dl>',
    '        </details>',
    '      </div>',
  ];
}

function mainBoutique(t: TexteBoutique, langue: Langue): string {
  const p = t.prix;
  const f = `/films/${t.film.nom}${langue === 'fr' ? '' : '-en'}`;
  return [
    '<main>',
    '  <section class="cadre f-une bt-une">',
    '    <div>',
    `      <h1><span class="f-surtitre"><svg class="ic" aria-hidden="true"><use href="#${t.icone}"/></svg>${t.surtitre}</span> ${t.h1[0]} <span class="sec-accent">${t.h1[1]}</span></h1>`,
    `      <p class="chapeau">${t.chapeau}</p>`,
    '      <div class="appels">',
    `        <a class="bouton bouton-plein" href="#commencer">${t.boutonClaude}</a>`,
    `        <a class="bouton bouton-trait" href="${inscriptionPro(langue)}">${t.boutonConsole}</a>`,
    '      </div>',
    // La phrase d'abord, le logo ensuite : « se branche à votre boutique [Shopify] », jamais un logo en sujet, qui ferait badge.
    `      <p class="bt-compat"><span>${t.compat}</span><span class="bt-compat-logo"><img class="logo-shopify" src="/img/logos/shopify-noir.svg" width="105" height="30" alt="Shopify"></span></p>`,
    '    </div>',
    ...telephone(t.telephone),
    '  </section>',
    '',
    '  <section class="f-bloc bt-probleme">',
    '    <div class="cadre">',
    `      <p class="f-surtitre">${t.probleme.surtitre}</p>`,
    `      <h2 class="f-titre">${deux(t.probleme.titre)}</h2>`,
    `      <p class="f-texte">${t.probleme.texte}</p>`,
    `      <p class="bt-source"><a href="${BAYMARD}" rel="noopener">${t.probleme.source}</a></p>`,
    '    </div>',
    '  </section>',
    '',
    '  <section class="f-bloc bande-claire bt-scenario">',
    '    <div class="cadre">',
    `      <p class="f-surtitre">${t.scenario.surtitre}</p>`,
    `      <h2 class="f-titre">${deux(t.scenario.titre)}</h2>`,
    ...etapes(t.scenario.etapes),
    '    </div>',
    '  </section>',
    '',
    '  <section class="f-bloc f-film" id="film">',
    '    <div class="cadre">',
    `      <p class="f-surtitre">${t.film.surtitre}</p>`,
    `      <h2 class="f-titre">${deux(t.film.titre)}</h2>`,
    `      <p class="f-texte">${t.film.texte}</p>`,
    `      <video class="f-video" src="${f}.mp4?v=1" poster="${f}.webp?v=1" data-vertical="${f}-9x16.mp4?v=1" data-affiche-verticale="${f}-9x16.webp?v=1" width="1280" height="720" controls muted playsinline preload="none" aria-label="${t.film.aria}"></video>`,
    '    </div>',
    '  </section>',
    '',
    '  <section class="f-bloc">',
    '    <div class="cadre">',
    `      <p class="f-surtitre">${t.branchez.surtitre}</p>`,
    `      <h2 class="f-titre">${deux(t.branchez.titre)}</h2>`,
    ...cartes(t.branchez.cartes, t.ensuite.offre),
    `      <p class="bt-note"><a href="${AIDE[langue]}">${t.commencer.aide}</a> ${fleche}</p>`,
    '    </div>',
    '  </section>',
    '',
    '  <section class="f-bloc">',
    '    <div class="cadre">',
    `      <p class="f-surtitre">${t.ensuite.surtitre}</p>`,
    `      <h2 class="f-titre">${deux(t.ensuite.titre)}</h2>`,
    ...cartes(t.ensuite.cartes, t.ensuite.offre),
    '    </div>',
    '  </section>',
    '',
    '  <section class="f-bloc bt-numero" id="numero">',
    '    <div class="cadre">',
    `      <p class="f-surtitre">${t.numero.surtitre}</p>`,
    `      <h2 class="f-titre">${deux(t.numero.titre)}</h2>`,
    `      <p class="f-texte">${t.numero.chapeau}</p>`,
    ...guide(t, langue),
    '    </div>',
    '  </section>',
    '',
    '  <section class="f-bloc" id="commencer">',
    '    <div class="cadre">',
    `      <p class="f-surtitre">${t.commencer.surtitre}</p>`,
    `      <h2 class="f-titre">${deux(t.commencer.titre)}</h2>`,
    ...etapes(t.commencer.etapes),
    '      <div class="appels">',
    `        <a class="bouton bouton-plein" href="${PLUGIN[langue]}">${t.commencer.bouton}</a>`,
    `        <a class="bouton bouton-texte" href="${AIDE[langue]}">${t.commencer.aide} ${fleche}</a>`,
    '      </div>',
    '    </div>',
    '  </section>',
    '',
    '  <section class="f-bloc" id="prix">',
    '    <div class="cadre">',
    `      <p class="f-surtitre">${p.surtitre}</p>`,
    `      <h2 class="f-titre">${deux(p.titre)}</h2>`,
    '      <ul class="bt-prix">',
    ...p.offres.map((o) => `        <li><h3>${o.nom}</h3><p class="bt-montant"><strong>${o.prix}</strong><span>${o.detail}</span></p><ul>${o.liste.map((x) => `<li>${x}</li>`).join('')}</ul></li>`),
    '      </ul>',
    `      <p class="bt-note">${p.note} <a href="${TARIFS[langue]}">${p.tarifs}</a></p>`,
    '    </div>',
    '  </section>',
    '',
    '  <section class="f-bloc tarifs-faq-bloc" id="faq">',
    '    <div class="cadre">',
    `      <h2 class="f-titre">${t.faq.titre}.</h2>`,
    '      <div class="dev-faq">',
    ...t.faq.questions.map((q) => `        <details id="${q.id}"><summary>${q.q}</summary><p>${q.r}</p></details>`),
    '      </div>',
    '    </div>',
    '  </section>',
    '',
    '  <section class="f-appel">',
    '    <div class="cadre">',
    `      <h2 class="f-titre">${t.appel.titre}</h2>`,
    `      <p class="f-texte">${t.appel.texte}</p>`,
    '      <div class="appels">',
    `        <a class="bouton bouton-plein" href="#commencer">${t.boutonClaude}</a>`,
    `        <a class="bouton bouton-trait" href="${inscriptionPro(langue)}">${t.boutonConsole}</a>`,
    `        <a class="bouton bouton-texte" href="${CONTACT[langue]}">${t.appel.contact} ${fleche}</a>`,
    '      </div>',
    '    </div>',
    '  </section>',
    '</main>',
  ].join('\n');
}

function pageBoutique(e: EntreeVitrine, langue: Langue): { chemin: string; contenu: string } {
  const brute = TEXTES_BOUTIQUES[e.cle]?.[langue];
  if (!brute) throw new Error(`${e.cle} : boutique en ligne sans ses textes (scripts/vitrine/boutique-textes.ts)`);
  const p = langue === 'fr' ? e.fr : e.en;
  const autre = langue === 'fr' ? e.en : e.fr;
  // En français, la ponctuation haute et les guillemets gardent leur espace insécable.
  const html = mainBoutique(brute, langue);
  const main = langue === 'fr' ? insecables(html) : html;
  const film = `/films/${brute.film.nom}${langue === 'fr' ? '' : '-en'}`;
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      fil(langue, [ACCUEIL[langue], [p.titre, p.adresse]]),
      {
        '@type': 'VideoObject', name: brute.film.aria, description: brut(brute.film.texte),
        thumbnailUrl: `${ORIGINE}${film}.webp`, contentUrl: `${ORIGINE}${film}.mp4`, uploadDate: brute.film.publie, duration: brute.film.duree,
        inLanguage: langue === 'fr' ? 'fr-FR' : 'en-US', publisher: { '@id': 'https://www.messagingme.fr/#organisation' },
      },
      {
        '@type': 'FAQPage', inLanguage: langue === 'fr' ? 'fr-FR' : 'en-US',
        mainEntity: brute.faq.questions.map((q) => ({ '@type': 'Question', name: brut(q.q), acceptedAnswer: { '@type': 'Answer', text: brut(q.r) } })),
      },
    ],
  };
  return {
    chemin: fichierDe(p.adresse),
    contenu: page(langue, {
      adresse: p.adresse, jumelle: autre.adresse, titre: brute.titre, description: brut(brute.description), ldJson: ld,
      affiche: `${film}.webp?v=1`,
    }, main,
      `Page « ${e.fr.titre} », GÉNÉRÉE par npm run vitrine:cas depuis scripts/vitrine/boutique-textes.ts : ne pas modifier à la main.`),
  };
}

/** Les pages boutique EN LIGNE au registre, dans les deux langues. */
export function pagesBoutiques(): Array<{ chemin: string; contenu: string }> {
  return ENTREES.filter((e) => e.enLigne && e.nature === 'boutique').flatMap((e) => (['fr', 'en'] as const).map((l) => pageBoutique(e, l)));
}
