/**
 * Quelles pages d'un site on importe, et jusqu'où on va : une page d'accueil seule est une vitrine, sans une
 * ligne sur un contrat.
 *
 * La portée se déduit de l'adresse donnée : la racine d'un domaine veut dire « ce site », un chemin « cette
 * page ». Deviner l'inverse importerait cinquante pages non voulues, ou laisserait un agent muet. « Seulement
 * cette partie du site » se choisit, ne se devine pas.
 *
 * 🔴 Module pur : la lecture est injectée, et la garde anti-SSRF (`urlRecuperable`) est appelée par
 * l'appelant sur chaque adresse, y compris celles découvertes dans le HTML. L'extraction des liens l'est aussi : la
 * route la fait tourner hors de la boucle d'événements (`liensDeLaPageHorsBoucle`).
 */

import type { Lecteur } from '../lib/hors-boucle';

/** Ce qu'on accepte de visiter à partir de l'adresse donnée. */
export type PorteeImport = 'page' | 'sous-arbre' | 'site';

/**
 * Profondeur maximale, en sauts depuis l'adresse de départ : l'accueil, ce qu'il référence, et ce que
 * celles-là référencent. Au-delà viennent les mentions légales et les archives, du bruit pour la recherche.
 */
export const PROFONDEUR_MAX = 2;

/** Plafond de pages visitées. Il borne le temps d'attente autant que le coût. */
export const PAGES_MAX = 50;

/**
 * Extensions qu'on ne suit pas : ce ne sont pas des pages. La lecture refuse déjà ce qui n'est pas du HTML,
 * mais après l'avoir téléchargé.
 */
const EXTENSIONS_IGNOREES = /\.(pdf|jpe?g|png|gif|webp|svg|ico|css|js|zip|docx?|xlsx?|pptx?|mp[34]|avi|mov)$/i;

/** La portée implicite de l'adresse : la racine du domaine (`/` ou vide) vaut le site, un chemin la page. */
export function porteeParDefaut(url: string): PorteeImport {
  try {
    const chemin = new URL(url).pathname.replace(/\/+$/, '');
    return chemin === '' ? 'site' : 'page';
  } catch {
    return 'page';
  }
}

/**
 * Forme canonique d'une adresse, pour ne pas visiter deux fois la même page : le fragment part, la barre
 * finale aussi (`/tarifs` et `/tarifs/` feraient des fiches jumelles). La query reste : elle porte souvent
 * la page réelle (`?p=12`).
 */
export function normaliserUrl(url: string): string {
  const u = new URL(url);
  u.hash = '';
  if (u.pathname !== '/') u.pathname = u.pathname.replace(/\/+$/, '');
  return u.toString();
}

/** Ce candidat entre-t-il dans la portée choisie, à partir de l'adresse de départ ? */
export function dansLaPortee(candidat: string, depart: string, portee: PorteeImport): boolean {
  let c: URL;
  let d: URL;
  try {
    c = new URL(candidat);
    d = new URL(depart);
  } catch {
    return false;
  }
  // 🔴 Même origine, toujours : un lien sortant importerait le contenu d'un tiers dans la base d'un client,
  // donc dans les réponses faites en son nom.
  if (c.origin !== d.origin) return false;
  if (portee === 'site') return true;
  if (portee === 'page') return normaliserUrl(candidat) === normaliserUrl(depart);
  // Sous-arbre : préfixe de segments, jamais de caractères, sinon `/pro` laisserait entrer
  // `/professionnels-autre-chose`.
  const base = d.pathname.replace(/\/+$/, '');
  return c.pathname === base || c.pathname.startsWith(`${base}/`);
}

/**
 * Les adresses vers lesquelles cette page pointe, dans la portée, canoniques et dédoublonnées. Une
 * expression régulière sur `href`, pas de DOM : un lien manqué coûte une page non importée, jamais une erreur.
 * 🔴 Quadratique sur une page hostile : l'expression repart de chaque `<a` jusqu'au bout d'une page où aucun `>` ne
 * le ferme (1,2 s pour 90 Ko sur le poste, et une page peut en faire 2 Mo). La route la lit donc hors de la boucle.
 */
export function liensDeLaPage(html: string, base: string, portee: PorteeImport): string[] {
  const vus = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*\shref\s*=\s*["']([^"'#][^"']*)["']/gi)) {
    const brut = (m[1] ?? '').trim();
    // `mailto:`, `tel:`, `javascript:` : ce ne sont pas des pages.
    if (brut === '' || /^(mailto|tel|javascript|data):/i.test(brut)) continue;
    let absolu: string;
    try {
      absolu = normaliserUrl(new URL(brut, base).toString());
    } catch {
      continue;
    }
    if (!/^https?:$/.test(new URL(absolu).protocol)) continue;
    if (EXTENSIONS_IGNOREES.test(new URL(absolu).pathname)) continue;
    if (!dansLaPortee(absolu, base, portee)) continue;
    vus.add(absolu);
  }
  return [...vus];
}

/** `liensDeLaPage` sur un lecteur (`src/lib/hors-boucle.ts`), hors de la boucle d'événements. */
export function liensDeLaPageHorsBoucle(lecteur: Lecteur, html: string, base: string, portee: PorteeImport): Promise<string[]> {
  return lecteur.lire<string[]>(new URL(import.meta.url), 'liensDeLaPage', [html, base, portee]);
}

/** Une page lue, telle que le parcours a besoin de la voir. */
export interface PageLue {
  url: string;
  html: string;
}

/** Ce que le parcours rend, page par page, dans l'ordre de visite. */
export interface VisiteResultat {
  pages: PageLue[];
  /** Adresses écartées, avec la raison, pour que l'écran le dise au lieu de les perdre en silence. */
  ecartees: Array<{ url: string; raison: string }>;
  /** Le plafond a-t-il coupé ? L'écran doit le dire : « 50 pages » n'est pas « tout le site ». */
  plafondAtteint: boolean;
}

/**
 * Parcourt le site en largeur, à partir de `depart` : avec un plafond de pages, un parcours en profondeur
 * les dépenserait dans une seule branche (les archives) au lieu des pages proches de l'accueil, qui portent
 * le contenu. `lire` rend une erreur pour une page injoignable ou non HTML : elle est écartée et dite, le
 * parcours continue.
 */
export async function visiter(
  depart: string,
  portee: PorteeImport,
  lire: (url: string) => Promise<{ html: string } | { erreur: string }>,
  /**
   * Les liens d'une page, sans valeur par défaut : la route les fait extraire hors de la boucle, et un appelant qui
   * l'oublierait retomberait dans le fil principal sans que rien ne le dise.
   */
  liens: (html: string, base: string, portee: PorteeImport) => string[] | Promise<string[]>,
  bornes: { profondeurMax?: number; pagesMax?: number } = {},
): Promise<VisiteResultat> {
  const profondeurMax = bornes.profondeurMax ?? PROFONDEUR_MAX;
  const pagesMax = bornes.pagesMax ?? PAGES_MAX;

  const racine = normaliserUrl(depart);
  const file: Array<{ url: string; profondeur: number }> = [{ url: racine, profondeur: 0 }];
  const vues = new Set<string>([racine]);
  const pages: PageLue[] = [];
  const ecartees: Array<{ url: string; raison: string }> = [];
  let plafondAtteint = false;

  while (file.length > 0) {
    if (pages.length >= pagesMax) {
      plafondAtteint = true;
      break;
    }
    const courant = file.shift()!;
    const res = await lire(courant.url);
    if ('erreur' in res) {
      ecartees.push({ url: courant.url, raison: res.erreur });
      continue;
    }
    pages.push({ url: courant.url, html: res.html });

    // Une page à la profondeur maximale est lue, mais ses liens ne sont pas suivis.
    if (portee === 'page' || courant.profondeur >= profondeurMax) continue;
    for (const lien of await liens(res.html, racine, portee)) {
      if (vues.has(lien)) continue;
      vues.add(lien);
      file.push({ url: lien, profondeur: courant.profondeur + 1 });
    }
  }
  return { pages, ecartees, plafondAtteint };
}
