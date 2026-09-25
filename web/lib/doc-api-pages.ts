// web/lib/doc-api-pages.ts
import type { Bilingue } from './api-exemples';

/**
 * LA CARTE DE LA DOCUMENTATION PUBLIQUE : ses pages, leur place dans la navigation, leurs ancres, et la liste
 * FERMÉE des fichiers qui la composent (refonte du 2026-09-25, `docs/superpowers/plans/2026-09-25-refonte-doc-api.md`).
 *
 * 🔴 DÉCLARÉE ICI, UNE SEULE FOIS, ET LUE PAR TROIS FAMILLES DE CONSOMMATEURS : la navigation de la doc
 * (`components/doc-api/CadreDoc.tsx`), les gardes de source (`tests/api-exemples.test.ts`,
 * `tests/web-signaux-parite.test.ts`, `tests/web-risque-parite.test.ts`, `web/lib/api-base.test.ts`), et l'e2e
 * (`web/e2e/developers-api.spec.ts`), qui ouvre chaque page, et vérifie chaque ancre. Une page listée ici est
 * donc gardée partout ; une page posée dans `web/app/developers/api/` sans être listée ici fait tomber
 * `tests/api-exemples.test.ts`, qui compare cette liste au dossier.
 *
 * ⚠️ `/developers/api` et `/developers/mcp` sont publiées sur la vitrine (`site/index.html`) : elles restent
 * l'accueil de la doc et la page MCP, sans redirection.
 *
 * ⚠️ AUCUN IMPORT DE VALEUR : ce fichier est lu par le build de la console ET par la suite racine (la même
 * contrainte que `api-exemples.ts`, dont il ne tire qu'un type, effacé à la compilation).
 */

export type GroupeDoc = 'demarrer' | 'reference-api' | 'guides' | 'plateforme';

/** Les groupes de la navigation, dans leur ordre d'affichage. « Référence » ne désigne plus que les ressources. */
export const GROUPES_DOC: ReadonlyArray<{ readonly cle: GroupeDoc; readonly titre: Bilingue }> = [
  { cle: 'demarrer', titre: ['Démarrer', 'Get started'] },
  { cle: 'reference-api', titre: ['Référence API', 'API reference'] },
  { cle: 'guides', titre: ['Guides', 'Guides'] },
  { cle: 'plateforme', titre: ['Plateforme', 'Platform'] },
];

export interface PageDoc {
  readonly cle: string;
  readonly href: string;
  /** Le fichier qui rend la page, depuis la racine du dépôt. */
  readonly fichier: string;
  readonly groupe: GroupeDoc;
  /** Le libellé dans la navigation. */
  readonly nav: Bilingue;
  /** Le `h1` de la page, le seul. */
  readonly titre: Bilingue;
  /** Les ancres que les autres pages visent (`id` d'une section). L'e2e vérifie que chacune existe. */
  readonly ancres: readonly string[];
}

export const PAGES_DOC = [
  {
    cle: 'accueil', href: '/developers/api', fichier: 'web/app/developers/api/page.tsx', groupe: 'demarrer',
    nav: ['Accueil', 'Overview'], titre: ['API Engage Me', 'Engage Me API'],
    ancres: ['premier-appel', 'endpoints', 'adresse', 'authentification'],
  },
  {
    cle: 'contacts', href: '/developers/api/contacts', fichier: 'web/app/developers/api/contacts/page.tsx', groupe: 'reference-api',
    nav: ['Contacts', 'Contacts'], titre: ['Contacts', 'Contacts'],
    ancres: ['creer', 'lot', 'lire', 'rechercher', 'modifier'],
  },
  {
    cle: 'messages', href: '/developers/api/messages', fichier: 'web/app/developers/api/messages/page.tsx', groupe: 'reference-api',
    nav: ['Messages', 'Messages'], titre: ['Messages', 'Messages'],
    ancres: ['messages-simples', 'message-whatsapp', 'message-rcs'],
  },
  {
    cle: 'sends', href: '/developers/api/sends', fichier: 'web/app/developers/api/sends/page.tsx', groupe: 'reference-api',
    nav: ['Envois', 'Sends'], titre: ['Envois', 'Sends'],
    ancres: ['envoi', 'cibles', 'destinataires', 'parametres', 'ouverture', 'categorie', 'suivi'],
  },
  {
    cle: 'catalogs', href: '/developers/api/catalogs', fichier: 'web/app/developers/api/catalogs/page.tsx', groupe: 'reference-api',
    nav: ['Catalogues', 'Catalogs'], titre: ['Catalogues', 'Catalogs'],
    ancres: ['templates', 'scenarios', 'messages-rcs'],
  },
  {
    cle: 'concepts', href: '/developers/api/concepts', fichier: 'web/app/developers/api/concepts/page.tsx', groupe: 'guides',
    nav: ['Concepts', 'Concepts'], titre: ['Concepts', 'Concepts'],
    ancres: ['identification', 'consentement', 'fenetre-24h', 'idempotence'],
  },
  {
    cle: 'per-contact', href: '/developers/api/guides/per-contact', fichier: 'web/app/developers/api/guides/per-contact/page.tsx', groupe: 'guides',
    nav: ['Un appel par contact', 'One call per contact'], titre: ['Brancher un outil qui appelle par contact', 'Connecting a tool that calls per contact'],
    ancres: ['cle'],
  },
  {
    cle: 'events', href: '/developers/api/events', fichier: 'web/app/developers/api/events/page.tsx', groupe: 'plateforme',
    nav: ['Événements', 'Events'], titre: ['Événements', 'Events'],
    ancres: ['signaux'],
  },
  {
    // L'adresse garde « reference » : publiée le 2026-09-25 (lot 1), elle peut déjà être en favori. Seul le titre change.
    cle: 'reference', href: '/developers/api/reference', fichier: 'web/app/developers/api/reference/page.tsx', groupe: 'plateforme',
    nav: ['Authentification, limites et erreurs', 'Authentication, limits and errors'],
    titre: ['Authentification, limites et erreurs', 'Authentication, limits and errors'],
    ancres: ['authentification', 'debit', 'erreurs'],
  },
  {
    cle: 'mcp', href: '/developers/mcp', fichier: 'web/app/developers/mcp/page.tsx', groupe: 'plateforme',
    nav: ['Serveur MCP', 'MCP server'], titre: ['Serveur MCP', 'MCP server'],
    ancres: [],
  },
] as const satisfies readonly PageDoc[];

export type CleDePage = (typeof PAGES_DOC)[number]['cle'];
/** Les ancres déclarées d'une page : un lien vers une ancre qui n'y est pas déclarée ne compile pas. */
export type AncreDe<C extends CleDePage> = Extract<(typeof PAGES_DOC)[number], { cle: C }>['ancres'][number];

export function pageDoc(cle: CleDePage): PageDoc {
  // `find` ne peut pas échouer : `cle` est typée sur la liste elle-même.
  return PAGES_DOC.find((p) => p.cle === cle)!;
}

/** Une destination dans la doc : une page, et au besoin une de ses ancres DÉCLARÉES (une autre ne compile pas). */
export type LienVers = { [P in CleDePage]: { readonly page: P; readonly ancre?: AncreDe<P> } }[CleDePage];

export function hrefDe(lien: LienVers): string {
  const { href } = pageDoc(lien.page);
  return lien.ancre ? `${href}#${lien.ancre}` : href;
}

/**
 * LES ANCRES QUI ONT DÉMÉNAGÉ, page par page, et leur nouvelle adresse. Un favori ou un lien externe vers une
 * ancre partie mènerait sinon en haut de la page : `CadreDoc` lit l'ancre au montage et renvoie vers sa nouvelle
 * adresse. `web/e2e/developers-api.spec.ts` ouvre chacune.
 * - L'accueil porte celles de l'ancienne page unique (avant le 2026-09-25). `#authentification` n'y figure pas :
 *   l'accueil la porte encore.
 * - Messages porte celles des envois, partis sur leur propre page (lot 2 de la refonte).
 */
export const ANCRES_DEPLACEES: Partial<Record<CleDePage, Readonly<Record<string, LienVers>>>> = {
  accueil: {
    debit: { page: 'reference', ancre: 'debit' },
    identite: { page: 'concepts', ancre: 'identification' },
    contacts: { page: 'contacts' },
    'message-simple': { page: 'messages', ancre: 'messages-simples' },
    envoi: { page: 'sends', ancre: 'envoi' },
    catalogues: { page: 'catalogs' },
    outil: { page: 'per-contact' },
    erreurs: { page: 'reference', ancre: 'erreurs' },
    exemples: { page: 'messages' },
    signaux: { page: 'events', ancre: 'signaux' },
  },
  messages: {
    envoi: { page: 'sends', ancre: 'envoi' },
    ouverture: { page: 'sends', ancre: 'ouverture' },
    categorie: { page: 'sends', ancre: 'categorie' },
    suivi: { page: 'sends', ancre: 'suivi' },
  },
};

/** La nouvelle adresse d'une ancre qui a quitté cette page, ou `null`. `hasOwn` : `#constructor` n'est pas une ancre. */
export function ancreDeplacee(page: CleDePage, ancre: string): string | null {
  const table = ANCRES_DEPLACEES[page];
  return table && Object.hasOwn(table, ancre) ? hrefDe(table[ancre]!) : null;
}

/**
 * LES ENTRÉES DE LA NAVIGATION QUI NE SONT PAS DES PAGES : l'index des endpoints vit sur l'accueil, et la
 * navigation y mène directement. Chacune se place juste après la page qu'elle nomme.
 */
export const LIENS_NAV: ReadonlyArray<{ readonly apres: CleDePage; readonly libelle: Bilingue; readonly lien: LienVers }> = [
  { apres: 'accueil', libelle: ['Endpoints', 'Endpoints'], lien: { page: 'accueil', ancre: 'endpoints' } },
];

/**
 * LES FICHIERS DE LA DOCUMENTATION, LISTE FERMÉE : chaque page, les composants que seules ces pages montent, et
 * les modules dont elles affichent le texte. Les gardes de source lisent CETTE liste, jamais tout `web/` : elles
 * doivent pouvoir exiger qu'une chose y soit trouvée (un exemple affiché, l'adresse dérivée, la section du risque)
 * sans être noyées par le reste de la console. `tests/api-exemples.test.ts` compare aussi la liste au dossier
 * `web/components/doc-api/` : un composant posé là sans y être ajouté échapperait aux gardes.
 *
 * ⚠️ `web/lib/api-exemples.ts` n'y est pas : il a ses propres gardes, et la règle « chaque exemple est affiché »
 * doit se lire dans les pages, pas dans le module qui les définit.
 */
export const FICHIERS_DOC: readonly string[] = [
  ...PAGES_DOC.map((p) => p.fichier),
  'web/components/doc-api/CadreDoc.tsx',
  'web/components/doc-api/elements.tsx',
  'web/components/DocSignaux.tsx',
  'web/lib/doc-api-pages.ts',
  'web/lib/api-champs.ts',
  'web/lib/api-doc-endpoints.ts',
  'web/lib/signaux-dictionnaire.ts',
  'web/lib/mcp-outils.ts',
];
