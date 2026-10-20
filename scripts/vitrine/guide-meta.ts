// scripts/vitrine/guide-meta.ts
// Le guide « Votre compte Meta Business, pas à pas » de la vitrine (Julien, 2026-10-19 : le seul prérequis, derrière
// la promesse « Il vous faut seulement un compte Meta Business » de la page Développeurs).
//
// Ses étapes ne s'écrivent PAS ici : elles viennent de `web/lib/partage/etapes-meta.ts`, que lisent déjà la console
// (« Connecter WhatsApp »), les outils MCP et la FAQ du plugin. `npm run vitrine:guide-meta` les écrit dans les deux
// pages, entre leurs marques ; `tests/vitrine-guide-meta.test.ts` exige chaque page égale à sa génération.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ETAPES_CARTE_META, PREREQUIS_META } from '../../web/lib/partage/etapes-meta';

type Langue = 'fr' | 'en';

export const MARQUE_DEBUT = '<!-- guide-meta:debut, généré par npm run vitrine:guide-meta depuis web/lib/partage/etapes-meta.ts : ne pas modifier à la main -->';
export const MARQUE_FIN = '<!-- guide-meta:fin -->';

/** Les deux pages du guide, et leur langue (chemins dans `site/`). */
export const PAGES_GUIDE: ReadonlyArray<{ chemin: string; langue: Langue; adresse: string }> = [
  { chemin: 'developpeurs/compte-meta-business/index.html', langue: 'fr', adresse: '/developpeurs/compte-meta-business/' },
  { chemin: 'en/developers/meta-business-account/index.html', langue: 'en', adresse: '/en/developers/meta-business-account/' },
];

const TITRES = {
  avant: { fr: 'Avant de connecter votre numéro', en: 'Before you connect your number' },
  apres: { fr: 'Après la connexion : la carte chez Meta', en: 'After connecting: your card at Meta' },
  apresTexte: {
    fr: 'Meta facture directement votre entreprise, selon sa grille. Sans carte valable chez Meta, seules les réponses dans la fenêtre de 24 heures partent.',
    en: 'Meta bills your business directly, according to its rate card. Without a valid card at Meta, only replies within the 24-hour window go out.',
  },
  howTo: { fr: 'Préparer son compte Meta Business pour WhatsApp', en: 'Prepare your Meta Business account for WhatsApp' },
} as const;

const echapper = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Une étape en HTML : l'adresse de Meta devient un lien (business.facebook.com) et, en français, la ponctuation haute et
 * les guillemets gardent leur espace insécable (sinon « : » part seul en début de ligne).
 */
const enHtml = (t: string, langue: Langue): string => {
  const h = echapper(t).replace(/business\.facebook\.com/g, '<a href="https://business.facebook.com/">business.facebook.com</a>');
  return langue === 'fr' ? h.replace(/ ([:;?!])/g, '&nbsp;$1').replace(/« /g, '«&nbsp;').replace(/ »/g, '&nbsp;»') : h;
};

function liste(etapes: ReadonlyArray<{ fr: string; en: string }>, langue: Langue): string[] {
  return [
    '    <ol class="guide-etapes">',
    ...etapes.map((e, i) => `      <li><span class="f-num">${i + 1}</span><p>${enHtml(e[langue], langue)}</p></li>`),
    '    </ol>',
  ];
}

/** Le bloc généré d'une page : les deux listes, puis leur balisage `HowTo` pour les moteurs. */
export function blocGuideMeta(langue: Langue): string {
  const etapes = [...PREREQUIS_META, ...ETAPES_CARTE_META];
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    inLanguage: langue === 'fr' ? 'fr-FR' : 'en-US',
    name: TITRES.howTo[langue],
    step: etapes.map((e, i) => ({ '@type': 'HowToStep', position: i + 1, text: e[langue] })),
  };
  return [
    MARQUE_DEBUT,
    '<section class="f-bloc guide-bloc bande-claire">',
    '  <div class="cadre">',
    `    <h2 class="f-titre">${enHtml(TITRES.avant[langue], langue)}</h2>`,
    ...liste(PREREQUIS_META, langue),
    '  </div>',
    '</section>',
    '<section class="f-bloc guide-bloc">',
    '  <div class="cadre">',
    `    <h2 class="f-titre">${enHtml(TITRES.apres[langue], langue)}</h2>`,
    `    <p class="f-texte">${enHtml(TITRES.apresTexte[langue], langue)}</p>`,
    ...liste(ETAPES_CARTE_META, langue),
    '  </div>',
    '</section>',
    `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`,
    MARQUE_FIN,
  ].join('\n');
}

/** La page avec son bloc à jour. Sans ses marques, c'est une erreur : le guide ne doit pas perdre ses étapes. */
export function pageAvecGuide(html: string, langue: Langue): string {
  const i = html.indexOf(MARQUE_DEBUT);
  const j = html.indexOf(MARQUE_FIN, i);
  if (i < 0 || j < 0) throw new Error('marques du guide Meta absentes');
  return html.slice(0, i) + blocGuideMeta(langue) + html.slice(j + MARQUE_FIN.length);
}

function main(): void {
  for (const { chemin, langue } of PAGES_GUIDE) {
    const f = fileURLToPath(new URL(`../../site/${chemin}`, import.meta.url));
    const avant = readFileSync(f, 'utf8');
    const apres = pageAvecGuide(avant, langue);
    if (apres !== avant) writeFileSync(f, apres);
  }
  console.log('le guide Meta réécrit dans ses deux pages');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
