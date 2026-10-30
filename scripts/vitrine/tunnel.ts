// scripts/vitrine/tunnel.ts
// Le tunnel du numéro WhatsApp (l'arbre de Julien du 2026-10-30), écrit une fois et posé sur chaque page qui le porte :
// la page « Démarrer » (`pagesDemarrer`, ici), Boutiques Shopify (`boutique.ts`) et SaaS et app builders (`cas.ts`).
// Textes dans `tunnel-textes.ts` ; `site.js` le rend interactif, et il reste lisible sans script (ses issues en liste).
// Plan `docs/superpowers/plans/2026-10-30-tunnel-numero-generique.md`.
import { DEPOT_PLUGIN } from '../../web/lib/demarrer';
import { ACCUEIL, fichierDe, fil, page } from './cas';
import type { Langue } from './cas-textes';
import { insecables } from './guide-meta';
import {
  TEXTES_TUNNEL, demandeDe, type Issue, type IssueBranchement, type Lien, type Mot, type OffreTunnel, type Origine, type Question, type Reponse, type Voie,
} from './tunnel-textes';

const CONSOLE = 'https://console.messagingme.app';
const PLUGIN: Readonly<Record<Langue, string>> = { fr: '/developpeurs/installer-le-plugin/', en: '/en/developers/install-the-plugin/' };
/** La page Contact : son formulaire pour la démo (`#formulaire`), la page elle-même pour nous écrire. */
const CONTACT: Readonly<Record<Langue, string>> = { fr: '/contact/', en: '/en/contact/' };
/** La page qui porte le tunnel seul ; `?offre=` (free, pro, business, entreprise) y répond à la première question (`site.js`). */
export const DEMARRER: Readonly<Record<Langue, string>> = { fr: '/demarrer/', en: '/en/get-started/' };
/**
 * L'inscription qui mène à la souscription du Pro (`?offre=pro`, `arriveeDUnNouvelEspace`, `web/lib/session.ts`), jamais
 * au tunnel de la Free, qui est le chemin d'une inscription sans ce drapeau.
 */
export const inscriptionPro = (langue: Langue): string => `${CONSOLE}/signup?offre=pro${langue === 'en' ? '&amp;lang=en' : ''}`;

const deux = (l: readonly [string, string]) => `${l[0]} <span class="sec-accent">${l[1]}</span>`;

/** Le plus long parcours de l'arbre, en questions : la jauge, « Question n sur … » et le chapeau le lisent ici. */
export function profondeurTunnel(questions: readonly Question[]): number {
  const profondeur = (id: string): number => {
    const q = questions.find((x) => x.id === id);
    return q ? 1 + Math.max(...q.reponses.map((r) => (r.vers ? profondeur(r.vers) : 0))) : 0;
  };
  return profondeur(questions[0]!.id);
}

/**
 * Le tunnel : une carte, la question en cours en grand et l'étape au-dessus, puis les mots qu'il emploie, repliés
 * dessous. Une question à cartes (`voies`) porte SOUS chaque carte la réponse de même rang. Sans script, les questions
 * restent cachées et les issues se lisent l'une sous l'autre, chacune précédée de sa situation et suivie des boutons de
 * chaque offre ; avec `site.js`, chaque réponse montre la question suivante (`data-vers`) ou une issue (`data-chemin`)
 * plus bas, la question répondue reste affichée, sa réponse en évidence (Julien, 2026-10-30 : « on garde le carré
 * sélectionné et on passe à la question suivante plus bas »), et une autre réponse cliquée change le chemin ; l'offre
 * choisie (`data-offre`) ne laisse que ses boutons, et un lien d'issue (`data-vers-chemin`) en montre une autre.
 */
export function tunnel(langue: Langue, origine: Origine): string[] {
  const n = TEXTES_TUNNEL[langue];
  const a = n.appels;
  const max = profondeurTunnel(n.questions);
  const progression = n.progression.replace('{max}', String(max));
  const bouton = (q: Question, r: Reponse, k: number) => (r.vers
    ? `<button type="button" class="bouton bouton-trait" data-vers="${r.vers}"${r.offre ? ` data-offre="${r.offre}"` : ''}${r.note ? ` data-note="note-${q.id}-${k}"` : ''} aria-pressed="false">${r.libelle}</button>`
    : `<button type="button" class="bouton bouton-texte" data-aide aria-expanded="false">${r.libelle}</button>`);
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
  // Une question à cartes : sous chaque carte, la réponse de même rang ; ce qui reste (« Je ne sais pas ») vient dessous.
  const reponses = (q: Question): string[] => {
    const toutes = q.reponses.map((r, k) => ({ r, k }));
    if (!q.voies) return [`            <div class="bt-reponses">${toutes.map(({ r, k }) => bouton(q, r, k)).join('')}</div>`];
    const menent = toutes.filter(({ r }) => r.vers);
    const autres = toutes.filter(({ r }) => !r.vers);
    if (menent.length !== q.voies.length) throw new Error(`tunnel : ${q.id} a ${q.voies.length} cartes et ${menent.length} réponses qui mènent quelque part`);
    // Plus de deux cartes : un carrousel sur le bureau (Julien, 2026-10-30 : « un carousel sur ordi, pas 2 rangées »), ses
    // flèches (`data-defiler`), et les cartes l'une sous l'autre au téléphone.
    const carrousel = q.voies.length > 2;
    const fleche = (sens: -1 | 1, libelle: string) =>
      `<button type="button" class="bt-fleche" data-defiler="${sens}" aria-label="${libelle}"><svg class="ic" aria-hidden="true"><use href="#i-caret-left"/></svg></button>`;
    return [
      `            <div class="bt-voies${carrousel ? ' bt-carrousel' : ''}" id="voies-${q.id}">`,
      ...q.voies.flatMap((v, i) => ['              <div class="bt-voie-choix">', ...voie(v), `                ${bouton(q, menent[i]!.r, menent[i]!.k)}`, '              </div>']),
      '            </div>',
      ...(carrousel ? [`            <div class="bt-fleches">${fleche(-1, n.defiler.precedente)}${fleche(1, n.defiler.suivante)}</div>`] : []),
      ...(autres.length > 0 ? [`            <div class="bt-reponses">${autres.map(({ r, k }) => bouton(q, r, k)).join('')}</div>`] : []),
    ];
  };
  const question = (q: Question, i: number) => [
    `          <fieldset class="bt-question" data-question="${q.id}"${q.voies ? ` aria-describedby="voies-${q.id}"` : ''}${i > 0 ? ' hidden' : ''}>`,
    `            <legend${q.logo ? ' class="bt-avec-logo"' : ''}>${q.logo ? `<img class="bt-logo" src="${q.logo}" alt="" width="40" height="40">` : ''}${q.texte}${q.precision ? `<span class="bt-precision">${q.precision}</span>` : ''}</legend>`,
    ...reponses(q),
    ...(q.aide ? [`            <p class="bt-aide" hidden>${q.aide}</p>`] : []),
    ...q.reponses.flatMap((r, k) => (r.note ? [`            <p class="bt-note-reponse" id="note-${q.id}-${k}" role="status" hidden>${r.note}</p>`] : [])),
    '          </fieldset>',
  ];
  // Le bout du tunnel, par offre : en Free, le plugin, son dépôt et la demande ; en Pro, l'espace, le pas-à-pas et la
  // même demande, à coller dans Claude Code ou Codex. La demande reprend les réponses et parle de la page d'origine.
  const demande = (x: IssueBranchement, offre: OffreTunnel, titre: string) => [
    `            <p class="bt-demande-titre">${titre}</p>`,
    `            <div class="bt-demande"><p id="demande-${x.id}-${offre}">${demandeDe(n, x, offre, origine)}</p><button type="button" class="bouton bouton-trait" data-copier="demande-${x.id}-${offre}" data-copie="${a.copie}" hidden>${a.copier}</button></div>`,
  ];
  const liens = (l: readonly Lien[], retrait: string) =>
    [`${retrait}<p class="bt-liens">${l.map((x) => `<a class="bouton bouton-trait" href="${x.href}" rel="noopener">${x.libelle}</a>`).join('')}</p>`];
  // Business et Entreprise : la démo et le contact, sans demande à coller (Julien, 2026-10-30) ; les autres issues, les
  // boutons de Free et de Pro.
  const fin = (x: Issue): string[] => (x.contact
    ? [
      '          <div class="bt-appels">',
      `            <p class="bt-appels-titre">${a.equipe}</p>`,
      `            <div class="bt-appels-boutons"><a class="bouton bouton-plein" href="${CONTACT[langue]}#formulaire">${a.demo}</a><a class="bouton bouton-trait" href="${CONTACT[langue]}">${a.contacter}</a></div>`,
      '          </div>',
    ]
    : [
      '          <div class="bt-appels" data-offre="free">',
      `            <p class="bt-appels-titre">${a.free}</p>`,
      `            <div class="bt-appels-boutons"><a class="bouton bouton-plein" href="${PLUGIN[langue]}">${a.plugin}</a><a class="bouton bouton-trait" href="${DEPOT_PLUGIN}" rel="noopener"><svg class="ic" aria-hidden="true"><use href="#i-github"/></svg>${a.github}</a></div>`,
      ...demande(x, 'free', a.demandeFree),
      '          </div>',
      '          <div class="bt-appels" data-offre="pro">',
      `            <p class="bt-appels-titre">${a.pro}</p>`,
      `            <div class="bt-appels-boutons"><a class="bouton bouton-plein" href="${inscriptionPro(langue)}">${a.compte}</a><a class="bouton bouton-trait" href="${x.pasAPas}">${a.pasAPas}</a></div>`,
      ...demande(x, 'pro', a.demandePro),
      '          </div>',
    ]);
  const issue = (x: Issue) => [
    `        <article class="bt-chemin" data-chemin="${x.id}" id="numero-${x.id}">`,
    `          <p class="bt-situation">${x.situation}</p>`,
    `          <h3>${x.titre}</h3>`,
    ...x.textes.map((p) => `          <p>${p}</p>`),
    ...(x.liens ? liens(x.liens, '          ') : []),
    ...(x.autre ? [`          <p class="bt-autre">${x.autre.question} <a href="#numero-${x.autre.vers}" data-vers-chemin="${x.autre.vers}">${x.autre.lien}</a></p>`] : []),
    ...fin(x),
    '        </article>',
  ];
  // Un mot par ligne : le mot et sa phrase courte se lisent sans ouvrir, le détail et ses liens au clic.
  const mot = (x: Mot) => [
    '            <li><details class="bt-mot">',
    `              <summary><strong>${x.terme}</strong><span>${x.court}</span><svg class="ic" aria-hidden="true"><use href="#i-caret-down"/></svg></summary>`,
    `              <p>${x.detail}</p>`,
    ...(x.liens ? liens(x.liens, '              ') : []),
    '            </details></li>',
  ];
  const html = [
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
    '          <ul class="bt-mots">',
    ...n.lexique.termes.flatMap(mot),
    '          </ul>',
    '        </details>',
    '      </div>',
  ];
  // En français, la ponctuation haute et les guillemets gardent leur espace insécable (sans effet sur une page qui le
  // fait déjà pour tout son `<main>`).
  return langue === 'fr' ? html.map(insecables) : html;
}

/** La section qui porte le tunnel sur une page (`#numero`), son titre au-dessus. */
export function sectionTunnel(langue: Langue, origine: Origine, classe = 'f-bloc bt-numero'): string[] {
  const n = TEXTES_TUNNEL[langue];
  const tete = [
    `      <p class="f-surtitre">${n.surtitre}</p>`,
    `      <h2 class="f-titre">${deux(n.titre)}</h2>`,
    `      <p class="f-texte">${n.chapeau}</p>`,
  ];
  return [
    `  <section class="${classe}" id="numero">`,
    '    <div class="cadre">',
    ...(langue === 'fr' ? tete.map(insecables) : tete),
    ...tunnel(langue, origine),
    '    </div>',
    '  </section>',
  ];
}

/**
 * La page « Démarrer » (placement choisi par Julien le 2026-10-30) : le tunnel seul, sous son titre, pour le bouton de
 * l'en-tête, les offres de la page Tarifs (`?offre=`) et l'Accueil. Ses deux langues viennent d'ici, pas de l'outil
 * anglais (`hors`, `anglais.ts`).
 */
export const TEXTES_DEMARRER = {
  fr: {
    titre: 'Démarrer : votre numéro WhatsApp en trois questions · Messaging Me',
    description: 'Free ou Pro, compte Meta Business, application WhatsApp Business : trois questions, puis la demande à coller dans Claude Code ou Codex.',
    fil: 'Démarrer',
    h1: ['Branchez votre WhatsApp,', 'en trois questions.'],
    chapeau: 'Votre offre, votre compte Meta Business, votre application WhatsApp Business : à la fin, vous savez quoi faire, et vous avez la demande à coller dans Claude Code ou Codex.',
    appel: { titre: 'Vous préférez qu’on en parle ?', texte: 'Une démo sur votre cas : vos clients, vos conversations, votre numéro.', bouton: 'Demander une démo', contact: '/contact/#formulaire' },
  },
  en: {
    titre: 'Get started: your WhatsApp number in three questions · Messaging Me',
    description: 'Free or Pro, Meta Business account, WhatsApp Business app: three questions, then the request to paste into Claude Code or Codex.',
    fil: 'Get started',
    h1: ['Connect your WhatsApp,', 'in three questions.'],
    chapeau: 'Your plan, your Meta Business account, your WhatsApp Business app: at the end, you know what to do, and you have the request to paste into Claude Code or Codex.',
    appel: { titre: 'Would you rather talk it through?', texte: 'A demo on your case: your customers, your conversations, your number.', bouton: 'Request a demo', contact: '/en/contact/#formulaire' },
  },
} as const;

export function pagesDemarrer(): Array<{ chemin: string; contenu: string }> {
  return (['fr', 'en'] as const).map((langue) => {
    const t = TEXTES_DEMARRER[langue];
    const autre = langue === 'fr' ? 'en' : 'fr';
    const tete = [
      `      <h1><span class="f-surtitre"><svg class="ic" aria-hidden="true"><use href="#i-whatsapp"/></svg>${t.fil}</span> ${t.h1[0]} <span class="sec-accent">${t.h1[1]}</span></h1>`,
      `      <p class="chapeau">${t.chapeau}</p>`,
    ];
    const main = [
      '<main>',
      '  <section class="cadre f-une-large demarrer-une" id="numero">',
      '    <div>',
      ...(langue === 'fr' ? tete.map(insecables) : tete),
      '    </div>',
      ...tunnel(langue, 'generique'),
      '  </section>',
      '',
      '  <section class="f-appel">',
      '    <div class="cadre">',
      `      <h2 class="f-titre">${langue === 'fr' ? insecables(t.appel.titre) : t.appel.titre}</h2>`,
      `      <p class="f-texte">${langue === 'fr' ? insecables(t.appel.texte) : t.appel.texte}</p>`,
      '      <div class="appels">',
      `        <a class="bouton bouton-plein" href="${t.appel.contact}">${t.appel.bouton} <svg class="ic" aria-hidden="true"><use href="#i-fleche"/></svg></a>`,
      '      </div>',
      '    </div>',
      '  </section>',
      '</main>',
    ].join('\n');
    const ld = { '@context': 'https://schema.org', '@graph': [fil(langue, [ACCUEIL[langue], [t.fil, DEMARRER[langue]]])] };
    return {
      chemin: fichierDe(DEMARRER[langue]),
      contenu: page(langue, { adresse: DEMARRER[langue], jumelle: DEMARRER[autre], titre: t.titre, description: t.description, ldJson: ld }, main,
        'La page « Démarrer », le tunnel du numéro WhatsApp, GÉNÉRÉE par npm run vitrine:cas depuis scripts/vitrine/tunnel-textes.ts : ne pas modifier à la main.'),
    };
  });
}
