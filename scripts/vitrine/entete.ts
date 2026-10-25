// scripts/vitrine/entete.ts
// L'en-tête et le pied de page de la vitrine, écrits UNE fois (lots 6 et 6 bis, plan
// docs/superpowers/plans/2026-10-16-cas-d-usage-solutions-depot.md, tâche 4).
//
// Les gabarits sont à côté de ce fichier (`entete.<langue>.html`, `pied.<langue>.html`) : un menu se change là, puis
// `npm run vitrine:entete` réécrit chaque page de `site/`. `tests/vitrine-entete.test.ts` exige que chaque page soit
// égale à sa génération. Ce qui varie d'une page à l'autre est calculé ici : le lien actif (`aria-current`), le groupe
// du burger qui le contient (ouvert), et le drapeau vers la page jumelle, lue dans son `<link rel="alternate">`.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ENTREES } from '../../web/lib/registre-vitrine';
import { TEXTES_CAS, TEXTES_CARREFOUR } from './cas-textes';
import { TEXTES_ATTENTE, TEXTES_SECTEURS } from './secteurs-textes';
import { TEXTES_BOUTIQUES } from './boutique-textes';

export type Langue = 'fr' | 'en';

const ORIGINE = 'https://app.messagingme.fr';
const ENTETE = /<header class="cadre entete">[\s\S]*?<\/header>/;
const PIED = /<footer class="pied">[\s\S]*?<\/footer>/;

/** Un gabarit tel qu'il s'insère : en LF même si le dépôt l'a extrait en CRLF, sans son saut de ligne final. */
export const normaliserGabarit = (texte: string): string => texte.replace(/\r\n/g, '\n').replace(/\n$/, '');

const gabarit = (nom: string): string => normaliserGabarit(readFileSync(fileURLToPath(new URL(nom, import.meta.url)), 'utf8'));
const ENTETES: Record<Langue, string> = { fr: gabarit('entete.fr.html'), en: gabarit('entete.en.html') };
const PIEDS: Record<Langue, string> = { fr: gabarit('pied.fr.html'), en: gabarit('pied.en.html') };

/** L'en-tête d'une page : `adresse` est la sienne (`/developpeurs/`), `jumelle` celle de sa page dans l'autre langue. */
export function enteteVitrine(langue: Langue, adresse: string, jumelle: string): string {
  return ENTETES[langue]
    .replaceAll('{{jumelle}}', () => jumelle)
    .replace('{{solutions}}', () => liensSolutions(langue, '        ', false))
    .replace('{{solutions-burger}}', () => liensSolutions(langue, '          ', true))
    // Le logo et le drapeau ne sont jamais « la page actuelle », même quand ils y mènent.
    .replace(/<a ([^>]*?)href="([^"]+)"/g, (tout: string, attributs: string, href: string) =>
      href === adresse && !/class="(marque|langue)"/.test(attributs) ? `${tout} aria-current="page"` : tout)
    .replace(/<details class="burger-groupe">([\s\S]*?)<\/details>/g, (tout: string, dedans: string) =>
      dedans.includes('aria-current="page"') ? `<details class="burger-groupe" open>${dedans}</details>` : tout);
}

export const piedVitrine = (langue: Langue): string => PIEDS[langue];

/**
 * Le menu « Solutions » (décisions de Julien du 2026-10-20) : les secteurs EN LIGNE au registre en tête, puis la page
 * chapeau « SaaS et app builders ». Ses cas ne s'affichent pas avec le menu : sur le bureau, ils s'ouvrent au survol
 * (ou au focus) de la page chapeau, dans un panneau à côté ; dans le burger, sans survol, ils restent listés dessous,
 * plus serrés (une icône et un titre).
 */
export function liensSolutions(langue: Langue, retrait: string, burger: boolean): string {
  const c = TEXTES_CARREFOUR[langue];
  const secteurs = ENTREES.filter((e) => e.enLigne && e.nature === 'secteur').map((e) => {
    const t = e.attente ? TEXTES_ATTENTE[e.cle]?.[langue] : TEXTES_SECTEURS[e.cle]?.[langue];
    if (!t) throw new Error(`${e.cle} : secteur en ligne sans ses textes (scripts/vitrine/secteurs-textes.ts)`);
    const p = langue === 'fr' ? e.fr : e.en;
    return `${retrait}<a class="menu-secteur" href="${p.adresse}"><span class="menu-ic"><svg class="ic" aria-hidden="true"><use href="#${t.icone}"/></svg></span><span><strong>${p.titre}</strong><small>${t.menu}</small></span></a>`;
  });
  // Les pages boutique (Boutiques Shopify, 2026-10-24) suivent les secteurs, sous la même forme.
  for (const e of ENTREES.filter((x) => x.enLigne && x.nature === 'boutique')) {
    const t = TEXTES_BOUTIQUES[e.cle]?.[langue];
    if (!t) throw new Error(`${e.cle} : boutique en ligne sans ses textes (scripts/vitrine/boutique-textes.ts)`);
    const p = langue === 'fr' ? e.fr : e.en;
    secteurs.push(`${retrait}<a class="menu-secteur" href="${p.adresse}"><span class="menu-ic"><svg class="ic" aria-hidden="true"><use href="#${t.icone}"/></svg></span><span><strong>${p.titre}</strong><small>${t.menu}</small></span></a>`);
  }
  const suite = burger ? '' : '<svg class="ic menu-suite" aria-hidden="true"><use href="#i-caret-left"/></svg>';
  const chapeau = `<a class="menu-chapeau" href="${c.adresse}"><span class="menu-ic"><svg class="ic" aria-hidden="true"><use href="#i-code"/></svg></span><span><strong>${c.fil}</strong><small>${c.menu}</small></span>${suite}</a>`;
  const cas = ENTREES.filter((e) => e.enLigne && e.nature === 'cas').map((e) => {
    const t = TEXTES_CAS[e.cle]?.[langue];
    if (!t) throw new Error(`${e.cle} : en ligne sans ses textes (scripts/vitrine/cas-textes.ts)`);
    const p = langue === 'fr' ? e.fr : e.en;
    return `<a class="menu-sous" href="${p.adresse}"><span class="menu-ic"><svg class="ic" aria-hidden="true"><use href="#${t.icone}"/></svg></span><span><strong>${p.titre}</strong></span></a>`;
  });
  if (burger) return [...secteurs, retrait + chapeau, ...cas.map((x) => retrait + x)].join('\n');
  return [
    ...secteurs,
    `${retrait}<div class="menu-groupe">`,
    `${retrait}  ${chapeau}`,
    `${retrait}  <div class="menu-sous-panneau">`,
    ...cas.map((x) => `${retrait}    ${x}`),
    `${retrait}  </div>`,
    `${retrait}</div>`,
  ].join('\n');
}

/** L'adresse publique d'une page, depuis son chemin dans `site/` : `contact/index.html` -> `/contact/`. */
export const adressePage = (chemin: string): string =>
  chemin.endsWith('index.html') ? `/${chemin.slice(0, -'index.html'.length)}` : `/${chemin}`;

const langueDe = (chemin: string): Langue => (chemin.startsWith('en/') ? 'en' : 'fr');

/**
 * La page jumelle que la page déclare dans son `<link rel="alternate">`. Seule la page 404, qui n'en a pas, renvoie à
 * l'accueil de l'autre langue : toute autre page sans jumelle déclarée est refusée, sinon son drapeau partirait vers
 * l'accueil en silence.
 */
export function jumelleDe(html: string, chemin: string): string {
  const autre: Langue = langueDe(chemin) === 'fr' ? 'en' : 'fr';
  const declaree = html.match(new RegExp(`<link rel="alternate" hreflang="${autre}" href="${ORIGINE.replace(/\./g, '\\.')}(/[^"]*)"`));
  if (declaree) return declaree[1]!;
  if (chemin === '404.html') return autre === 'en' ? '/en/' : '/';
  throw new Error(`${chemin} : aucune jumelle déclarée (<link rel="alternate" hreflang="${autre}">), à poser avant la génération`);
}

/** La page avec son en-tête et son pied de page régénérés ; `chemin` est relatif à `site/`. */
export function pageAvecEntete(html: string, chemin: string): string {
  if (!ENTETE.test(html) || !PIED.test(html)) throw new Error(`${chemin} : en-tête ou pied de page introuvable`);
  const langue = langueDe(chemin);
  return html
    .replace(ENTETE, () => enteteVitrine(langue, adressePage(chemin), jumelleDe(html, chemin)))
    .replace(PIED, () => piedVitrine(langue));
}

function main(): void {
  const site = fileURLToPath(new URL('../../site/', import.meta.url));
  const pages = readdirSync(site, { recursive: true, encoding: 'utf8' })
    .map((p) => p.split('\\').join('/'))
    .filter((p) => p.endsWith('.html'));
  let reecrites = 0;
  for (const chemin of pages) {
    const avant = readFileSync(site + chemin, 'utf8');
    const apres = pageAvecEntete(avant, chemin);
    if (apres !== avant) { writeFileSync(site + chemin, apres); reecrites++; }
  }
  console.log(`${pages.length} pages lues, ${reecrites} réécrites`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
