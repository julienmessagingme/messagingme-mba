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

export type GroupeDoc = 'demarrer' | 'reference-api' | 'concepts' | 'plateforme';

/** Les groupes de la navigation, dans leur ordre d'affichage. */
export const GROUPES_DOC: ReadonlyArray<{ readonly cle: GroupeDoc; readonly titre: Bilingue }> = [
  { cle: 'demarrer', titre: ['Démarrer', 'Get started'] },
  { cle: 'reference-api', titre: ['Référence de l’API', 'API reference'] },
  { cle: 'concepts', titre: ['Concepts et guides', 'Concepts and guides'] },
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
    ancres: ['adresse', 'authentification', 'premier-appel'],
  },
  {
    cle: 'contacts', href: '/developers/api/contacts', fichier: 'web/app/developers/api/contacts/page.tsx', groupe: 'reference-api',
    nav: ['Contacts', 'Contacts'], titre: ['Contacts', 'Contacts'],
    ancres: ['creer', 'lot', 'lire', 'rechercher', 'modifier'],
  },
  {
    cle: 'messages', href: '/developers/api/messages', fichier: 'web/app/developers/api/messages/page.tsx', groupe: 'reference-api',
    nav: ['Messages et envois', 'Messages and sends'], titre: ['Messages et envois', 'Messages and sends'],
    ancres: ['messages-simples', 'message-whatsapp', 'message-rcs', 'envoi', 'ouverture', 'categorie', 'suivi'],
  },
  {
    cle: 'catalogs', href: '/developers/api/catalogs', fichier: 'web/app/developers/api/catalogs/page.tsx', groupe: 'reference-api',
    nav: ['Catalogues', 'Catalogs'], titre: ['Catalogues', 'Catalogs'],
    ancres: ['templates', 'scenarios', 'messages-rcs'],
  },
  {
    cle: 'concepts', href: '/developers/api/concepts', fichier: 'web/app/developers/api/concepts/page.tsx', groupe: 'concepts',
    nav: ['Concepts', 'Concepts'], titre: ['Concepts', 'Concepts'],
    ancres: ['identification', 'consentement', 'fenetre-24h', 'idempotence'],
  },
  {
    cle: 'per-contact', href: '/developers/api/guides/per-contact', fichier: 'web/app/developers/api/guides/per-contact/page.tsx', groupe: 'concepts',
    nav: ['Un appel par contact', 'One call per contact'], titre: ['Brancher un outil qui appelle par contact', 'Connecting a tool that calls per contact'],
    ancres: ['cle'],
  },
  {
    cle: 'events', href: '/developers/api/events', fichier: 'web/app/developers/api/events/page.tsx', groupe: 'plateforme',
    nav: ['Événements', 'Events'], titre: ['Événements', 'Events'],
    ancres: ['signaux'],
  },
  {
    cle: 'reference', href: '/developers/api/reference', fichier: 'web/app/developers/api/reference/page.tsx', groupe: 'plateforme',
    nav: ['Référence', 'Reference'], titre: ['Référence', 'Reference'],
    ancres: ['authentification', 'debit', 'erreurs'],
  },
  {
    // Même mise en page, contenu inchangé : son `h1` est écrit dans la page, et l'e2e le tient égal à ce titre.
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

/**
 * LES FICHIERS DE LA DOCUMENTATION, LISTE FERMÉE : chaque page, et les composants que seules ces pages montent.
 * Les gardes de source lisent CETTE liste, jamais tout `web/` : elles doivent pouvoir exiger qu'une chose y soit
 * trouvée (un exemple affiché, l'adresse dérivée, la section du risque) sans être noyées par le reste de la console.
 */
export const FICHIERS_DOC: readonly string[] = [
  ...PAGES_DOC.map((p) => p.fichier),
  'web/components/doc-api/CadreDoc.tsx',
  'web/components/doc-api/elements.tsx',
  'web/components/DocSignaux.tsx',
];
