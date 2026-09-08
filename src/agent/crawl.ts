/**
 * QUELLES PAGES D'UN SITE ON IMPORTE, et jusqu'où on va.
 *
 * 🔴 POURQUOI CE MODULE EXISTE. L'import ne prenait qu'UNE page. Julien a donné `ganprevoyance.fr`, on a
 * importé la page d'accueil, et une page d'accueil est une vitrine : des slogans, des témoignages, des
 * chiffres clés, et pas une ligne sur un contrat. Son agent ne pouvait répondre à rien, et aucune
 * vectorisation ne rattrape ce qui n'est pas dans la base.
 *
 * 🔴 LA PORTÉE SE DÉDUIT DE L'ADRESSE DONNÉE, et c'est la règle que Julien a posée : la RACINE d'un domaine
 * veut dire « ce site », une adresse avec un chemin veut dire « cette page ». Deviner l'inverse coûte cher
 * des deux côtés : crawler quand on demandait une page importe cinquante pages non voulues, et importer une
 * page quand on demandait le site laisse un agent muet sans que rien ne le dise.
 *
 * Le troisième cas est un CHOIX, jamais une déduction : « seulement cette partie du site » se dit, et ne se
 * devine pas d'une adresse.
 *
 * Module PUR : aucune IO. La lecture des pages est injectée, ce qui rend le parcours testable sans réseau et
 * garde la garde anti-SSRF chez son propriétaire (`urlRecuperable`, appelée par l'appelant sur CHAQUE
 * adresse, y compris celles découvertes dans le HTML : un lien d'une page tierce n'est pas plus digne de
 * confiance que ce qu'un client saisit).
 */

/** Ce qu'on accepte de visiter à partir de l'adresse donnée. */
export type PorteeImport = 'page' | 'sous-arbre' | 'site';

/**
 * Profondeur maximale, en nombre de sauts depuis l'adresse de départ.
 *
 * 2, décidé par Julien : la page d'accueil, ce qu'elle référence, et ce que celles-là référencent. Au-delà on
 * ramasse les mentions légales et les archives d'actualités, qui font du bruit dans une recherche sans jamais
 * répondre à une question de client.
 */
export const PROFONDEUR_MAX = 2;

/** Plafond de pages visitées, décidé par Julien. Il borne le temps d'attente autant que le coût. */
export const PAGES_MAX = 50;

/**
 * Extensions qu'on ne suit pas : ce ne sont pas des pages.
 *
 * ⚠️ La lecture refuse déjà ce qui n'est pas du HTML, mais elle le fait APRÈS avoir téléchargé. Écarter ici
 * évite de payer un aller-retour par PDF d'un site qui en publie deux cents.
 */
const EXTENSIONS_IGNOREES = /\.(pdf|jpe?g|png|gif|webp|svg|ico|css|js|zip|docx?|xlsx?|pptx?|mp[34]|avi|mov)$/i;

/**
 * La portée que l'adresse implique, quand personne n'en a choisi une.
 *
 * Racine du domaine (`/` ou vide) -> le SITE. Un chemin -> cette PAGE.
 */
export function porteeParDefaut(url: string): PorteeImport {
  try {
    const chemin = new URL(url).pathname.replace(/\/+$/, '');
    return chemin === '' ? 'site' : 'page';
  } catch {
    return 'page';
  }
}

/**
 * Forme canonique d'une adresse, pour ne pas visiter deux fois la même page.
 *
 * Le fragment part (`#section` désigne un endroit DANS la page, pas une autre page). La barre finale part
 * aussi : sans ça, `/tarifs` et `/tarifs/` seraient deux pages, donc deux jeux de fiches jumelles.
 *
 * ⚠️ La query est CONSERVÉE : sur beaucoup de sites elle porte la page réelle (`?p=12`), et la retirer
 * ramènerait tout le site à une seule adresse.
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
  // 🔴 MÊME ORIGINE, TOUJOURS. Suivre un lien sortant importerait le contenu d'un tiers dans la base de
  // connaissance d'un client, donc dans les réponses faites à ses contacts en son nom.
  if (c.origin !== d.origin) return false;
  if (portee === 'site') return true;
  if (portee === 'page') return normaliserUrl(candidat) === normaliserUrl(depart);
  // Sous-arbre : le chemin de départ est un PRÉFIXE DE SEGMENTS, jamais de caractères. Sans ça, `/pro`
  // laisserait entrer `/professionnels-autre-chose`, qui n'est pas dessous.
  const base = d.pathname.replace(/\/+$/, '');
  return c.pathname === base || c.pathname.startsWith(`${base}/`);
}

/**
 * Les adresses vers lesquelles cette page pointe, dans la portée, sous forme canonique et dédoublonnées.
 *
 * Volontairement bête : une expression régulière sur `href`, pas d'arbre DOM, comme le reste de l'extracteur.
 * Un lien manqué coûte une page non importée, jamais une erreur.
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

/** Une page lue, telle que le parcours a besoin de la voir. */
export interface PageLue {
  url: string;
  html: string;
}

/** Ce que le parcours rend, page par page, dans l'ordre de visite. */
export interface VisiteResultat {
  pages: PageLue[];
  /** Adresses écartées, avec la raison, pour que l'écran puisse le DIRE au lieu de les perdre en silence. */
  ecartees: Array<{ url: string; raison: string }>;
  /** Le plafond a-t-il coupé ? L'écran doit le dire : « 50 pages » n'est pas « tout le site ». */
  plafondAtteint: boolean;
}

/**
 * Parcourt le site en largeur, à partir de `depart`.
 *
 * 🔴 EN LARGEUR, PAS EN PROFONDEUR, et ce n'est pas un détail : avec un plafond de pages, un parcours en
 * profondeur dépenserait ses cinquante pages dans une seule branche (les archives d'actualités, typiquement)
 * et n'atteindrait jamais la page « nos contrats » liée depuis l'accueil. En largeur, les pages les plus
 * proches de l'accueil passent en premier, et ce sont celles qui portent le contenu.
 *
 * `lire` rend `null` quand la page est injoignable ou n'est pas du HTML : une page ratée n'arrête jamais le
 * parcours, elle est écartée et dite.
 */
export async function visiter(
  depart: string,
  portee: PorteeImport,
  lire: (url: string) => Promise<{ html: string } | { erreur: string }>,
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

    // Une page à la profondeur maximale est LUE, mais ses liens ne sont pas suivis.
    if (portee === 'page' || courant.profondeur >= profondeurMax) continue;
    for (const lien of liensDeLaPage(res.html, racine, portee)) {
      if (vues.has(lien)) continue;
      vues.add(lien);
      file.push({ url: lien, profondeur: courant.profondeur + 1 });
    }
  }
  return { pages, ecartees, plafondAtteint };
}
