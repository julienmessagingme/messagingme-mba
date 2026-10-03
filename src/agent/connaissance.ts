import { z } from 'zod';
import type { FicheAEcrire, FicheConnaissance, SourceFiche } from './knowledge';
import { MAX_CORPS, MAX_FICHES_PAR_PAGE, MAX_TITRE, pageEnFichesHorsBoucle, type FicheExtraite } from './scrape';
import {
  PAGES_MAX, dansLaPortee, liensDeLaPageHorsBoucle, normaliserUrl, porteeParDefaut, visiter, type PorteeImport,
} from './crawl';
import {
  TAILLE_DOCUMENT_MAX, lireDocumentHorsBoucle, normaliser, texteEnFichesHorsBoucle, type NaturePieceJointe,
} from './setup/piece-jointe';
import { urlRecuperable, type PageDistante } from '../lib/page-distante';
import { avecLecteur, type OptionsLecture } from '../lib/hors-boucle';
import { journaliser } from '../lib/journal';
import { refus, type Issue } from '../lib/issue';
import { octetsDepuisDataUrl } from '../rcs/image';
import { estUuid } from '../http/scope';

/**
 * LA BASE DE CONNAISSANCE D'UN AGENT IA : l'écrire à la main, la fabriquer depuis un site ou un document, en retirer
 * (lot 8a, `docs/superpowers/plans/2026-10-03-mcp-agent-ia.md`).
 *
 * 🔴 UNE SEULE VÉRITÉ, DEUX PORTES. La route de la console (`src/http/agent-knowledge.ts`) et les outils MCP de l'agent
 * appellent CES fonctions : un site lu pour Claude Code passe les mêmes gardes d'adresse, le même découpage et le même
 * remplacement par page qu'un site lu depuis l'onglet Connaissance. La route n'ajoute que la garde d'administrateur,
 * le plafond des opérations lourdes et la traduction des refus en statuts.
 *
 * Ce qui s'écrit ici entre dans le contexte du modèle à chaque réponse, seule source que l'agent a le droit
 * d'utiliser. 🔴 L'import va chercher une adresse fournie par un client depuis le serveur (réseau Docker du VPS) : la
 * garde SSRF de `src/lib/page-distante.ts` s'applique à l'adresse saisie et à chaque redirection.
 */

/** Ce que la gestion lit et écrit de la connaissance d'un agent. */
export interface ConnaissanceDep {
  lister(tenantId: string, agentId: string): Promise<FicheConnaissance[]>;
  creer(tenantId: string, agentId: string, fiche: FicheAEcrire): Promise<FicheConnaissance | null>;
  modifier(tenantId: string, agentId: string, ficheId: string, patch: { titre?: string; corps?: string }): Promise<FicheConnaissance | null>;
  supprimer(tenantId: string, agentId: string, ficheId: string): Promise<boolean>;
  remplacerSource(tenantId: string, agentId: string, source: SourceFiche, fiches: FicheAEcrire[]): Promise<{ retirees: number; ecrites: number } | null>;
}

/** Le câblage passe les MÊMES objets à la console et au MCP. */
export interface DepsConnaissance {
  connaissance: ConnaissanceDep;
  /**
   * Journalise une fiche effacée dans l'historique de l'agent. 🔴 Pas de corbeille : cette ligne est le seul
   * exemplaire d'une fiche supprimée. La route ne doit pas échouer parce qu'une écriture de journal échoue.
   */
  journaliserSuppression(tenantId: string, agentId: string, ligne: {
    cible: string;
    libelle: string;
    avant: unknown;
    acteurId: string | null;
  }): Promise<void>;
  /** Lecture d'une page distante. Injectée pour rester testable sans réseau ; absente, l'import et
  *  l'aperçu répondent 503. `signal` porte l'échéance de la requête : une lecture en cours s'arrête avec elle. */
  fetchUrl?(url: string, signal?: AbortSignal): Promise<PageDistante>;
  /** L'échéance du réseau d'un aperçu ou d'un import (`ECHEANCE_PARCOURS_MS` par défaut). Injectée pour les tests. */
  echeanceParcoursMs?: number;
}

/** Titre et corps sont bornés aux mêmes valeurs que ce qu'un import produit (`src/agent/scrape.ts`) : deux
*  plafonds différents feraient qu'une fiche importée ne serait plus modifiable telle quelle. */
const TITRE = z.string().trim().min(1).max(MAX_TITRE);
const CORPS = z.string().trim().min(1).max(MAX_CORPS);
/**
 * Les saisies, exportées pour UNE raison : les outils MCP annoncent chaque borne qu'ils appliquent, et la lisent ici.
 */
export const saisieDeFiche = z.object({ titre: TITRE, corps: CORPS });
export const saisieDePatchDeFiche = z.object({ titre: TITRE.optional(), corps: CORPS.optional() });
export const saisieDeDocument = z.object({
  nom: z.string().trim().min(1).max(MAX_TITRE),
  /** Le fichier, en data URL base64. Même transport que le téléversement d'image, déjà éprouvé. */
  dataUrl: z.string().min(1),
});
/**
 * Le TEXTE d'un document, extrait sur le poste de qui l'envoie (un outil MCP) : aucun binaire ne traverse, donc ni
 * base64 ni plafond de corps à contourner. Le plafond est celui d'un document déposé, compté en octets.
 */
export const saisieDeTexteDocument = z.object({
  nom: z.string().trim().min(1).max(MAX_TITRE),
  texte: z.string().refine((t) => t.trim() !== ''),
});

/** Plusieurs fiches tapées d'un coup : 50 au plus, un geste qu'on relit encore (outil `add_knowledge`). */
export const MAX_FICHES_PAR_AJOUT = 50;

/**
 * Une suppression en masse, bornée : sans plafond, une liste arbitraire ferait une requête arbitrairement longue.
 * 200 couvre « je coche tout et je supprime », et le client peut recommencer.
 */
export const saisieDeSuppression = z.object({ ids: z.array(z.string().trim()).min(1).max(200) });

const PORTEE = z.enum(['page', 'sous-arbre', 'site']);
export const saisieDeSite = z.object({
  url: z.string().trim().min(1).max(2000),
  portee: PORTEE.optional(),
  /**
   * Les pages à importer, telles que l'aperçu les a rendues. Chacune est revalidée ici (garde SSRF, même origine
   * que `url`) : la liste vient du client. Absente, on importe la seule adresse fournie.
   */
  pages: z.array(z.string().trim().min(1).max(2000)).max(PAGES_MAX).optional(),
});

/**
 * La lecture des pages d'un aperçu ou d'un import, dans un worker, sous une échéance CUMULÉE sur toutes ses pages. Une
 * page ordinaire (500 Ko) coûte 20 ms par lecture sur le poste, liens comme fiches, une page au plafond de lecture
 * (2 Mo) 50 à 80 ms, et le VPS en met deux à trois fois plus : cinquante pages ordinaires y tiennent en 6 s, cinquante
 * pages au plafond frôleraient l'échéance, et le refus dit alors d'importer une partie du site. Une page hostile y est
 * coupée, en 400. Plus haut, un seul espace tiendrait les quatre places du plafond de lecture (`todo.md`).
 */
export const LECTURE_PAGES: OptionsLecture = { nature: 'pages', delaiMs: 20_000 };

/**
 * Le temps de réseau d'un aperçu ou d'un import de site. 🔴 NPM coupe à 60 s sans réponse : il ne pose aucun
 * `proxy_read_timeout` (configuration de `api.` et de `mba.` lue sur le VPS le 2026-10-01), c'est donc le défaut de
 * nginx, et il coupe avant Cloudflare (100 s). Au-delà, le client a déjà reçu une erreur pendant que le serveur
 * continuait, des heures parfois : une page écartée ne compte pas dans les cinquante. 30 s de réseau, 3 s de
 * résolution DNS qui ne se laisse pas interrompre (`DELAI_RESOLUTION_MS`), les 20 s de lecture (`LECTURE_PAGES`), et
 * pour l'import les écritures qui suivent ses lectures (une transaction par page) tiennent sous les 60 s : la somme est
 * tenue par un test (`tests/http-agent-knowledge.test.ts`), aucune des trois ne se change seule.
 */
export const ECHEANCE_PARCOURS_MS = 30_000;

/** Ce qu'on dit d'une page que l'échéance a coupée : elle n'est pas injoignable, elle n'a pas été attendue. */
const TEMPS_ECOULE = 'temps de lecture du site écoulé';
const AGENT_INTROUVABLE = 'agent introuvable';
const ADRESSE_REFUSEE = 'adresse invalide ou non autorisée (http(s) et hôte public attendus)';
const IMPORT_INDISPONIBLE = 'import depuis une URL indisponible';

/** Ce qu'un aperçu rend : ce que l'import ramènerait, page par page, et ce qu'il n'a pas pris. */
export interface ApercuSite {
  url: string;
  portee: PorteeImport;
  plafondAtteint: boolean;
  tempsAtteint: boolean;
  ecartees: Array<{ url: string; raison: string }>;
  pages: Array<{ url: string; fiches: number; caracteres: number }>;
}

/** Ce qu'un import de site rend. `restantes` : les pages que l'échéance n'a pas laissé lire, à réimporter. */
export interface ImportSite {
  url: string;
  ecrites: number;
  retirees: number;
  importees: string[];
  ecartees: Array<{ url: string; raison: string }>;
  restantes: string[];
  tronquees: string[];
  plafond: number;
}

/** Ce qu'un import de document rend, qu'il vienne d'un fichier ou de son texte. */
export interface ImportDocument {
  nom: string;
  nature: NaturePieceJointe;
  retirees: number;
  ecrites: number;
  plafond: number;
}

/**
 * Lit une page avec toutes ses gardes, et rend son HTML ou la raison de l'écart.
 * 🔴 La garde SSRF s'applique à chaque adresse, y compris celles découvertes dans le HTML : un lien trouvé sur un
 * site tiers ne vaut pas mieux qu'une saisie, et pourrait viser les métadonnées du fournisseur ou le réseau Docker.
 */
async function lireUnePage(
  fetchUrl: NonNullable<DepsConnaissance['fetchUrl']>, url: string, signal: AbortSignal,
): Promise<{ html: string } | { erreur: string }> {
  if (!urlRecuperable(url)) return { erreur: 'adresse non autorisée' };
  let page: PageDistante;
  try {
    page = await fetchUrl(url, signal);
  } catch (err) {
    if (signal.aborted) return { erreur: TEMPS_ECOULE };
    return { erreur: `injoignable : ${err instanceof Error ? err.message : 'erreur réseau'}` };
  }
  if (page.status >= 400) return { erreur: `HTTP ${page.status}` };
  const type = page.contentType.toLowerCase();
  if (type !== '' && !type.includes('html') && !type.includes('plain')) return { erreur: 'pas une page web' };
  return { html: page.body };
}

/**
 * Ajoute des fiches tapées : une depuis l'onglet, jusqu'à `MAX_FICHES_PAR_AJOUT` depuis le MCP. Chacune est bornée
 * comme une fiche importée. 🔴 `null` du store : l'agent n'existe pas ou appartient à un autre espace, même refus,
 * sinon la réponse dirait quels identifiants existent ailleurs.
 */
export async function ajouterFiches(
  deps: DepsConnaissance, tenantId: string, agentId: string, fiches: unknown,
): Promise<Issue<FicheConnaissance[]>> {
  // Identifiant mal formé : 404, sinon Postgres lèverait sur la colonne `uuid` (donc un 500).
  if (!estUuid(agentId)) return refus(404, AGENT_INTROUVABLE);
  const liste = z.array(z.unknown()).min(1).max(MAX_FICHES_PAR_AJOUT).safeParse(fiches);
  if (!liste.success) return refus(400, `1 à ${MAX_FICHES_PAR_AJOUT} fiches par ajout`);
  const lues: FicheAEcrire[] = [];
  for (const brute of liste.data) {
    const lu = saisieDeFiche.safeParse(brute ?? {});
    if (!lu.success) return refus(400, `titre et corps requis (corps : ${MAX_CORPS} caractères au plus)`);
    lues.push(lu.data);
  }
  const ecrites: FicheConnaissance[] = [];
  for (const fiche of lues) {
    const ecrite = await deps.connaissance.creer(tenantId, agentId, fiche);
    if (!ecrite) return refus(404, AGENT_INTROUVABLE);
    ecrites.push(ecrite);
  }
  return { ok: true, valeur: ecrites };
}

/**
 * Journalise une fiche effacée, APRÈS la suppression : journaliser un geste qui n'a pas eu lieu ferait chercher une
 * cause inexistante. Le contenu est lu avant (`avant`) : c'est le seul exemplaire qui en restera ; s'il manque, on
 * journalise l'identifiant seul.
 */
export async function journaliserFicheSupprimee(
  deps: DepsConnaissance, tenantId: string, agentId: string, ficheId: string,
  avant: FicheConnaissance | undefined, acteurId: string | null,
): Promise<void> {
  await deps.journaliserSuppression(tenantId, agentId, {
    cible: ficheId,
    libelle: `Fiche de connaissance : ${avant?.titre ?? ficheId}`,
    avant: avant ?? { id: ficheId },
    acteurId,
  });
}

/**
 * Supprime plusieurs fiches en une seule requête : boucler côté appelant laisserait, au premier échec, une sélection à
 * moitié supprimée. Les identifiants mal formés sont écartés : un uuid invalide ferait lever la requête entière.
 * Chaque fiche effacée se journalise (c'est cette suppression-là qui peut en effacer deux cents), avec une seule
 * lecture pour toute la fournée. Le compte rendu est le compte RÉEL : une fiche déjà supprimée par un collègue n'est
 * pas annoncée comme supprimée par ce geste.
 */
export async function supprimerFiches(
  deps: DepsConnaissance, tenantId: string, agentId: string, corps: unknown, acteurId: string | null,
): Promise<Issue<{ supprimees: number; demandees: number }>> {
  if (!estUuid(agentId)) return refus(404, AGENT_INTROUVABLE);
  const lu = saisieDeSuppression.safeParse(corps ?? {});
  if (!lu.success) return refus(400, 'ids requis (1 à 200 identifiants)');
  const ids = lu.data.ids.filter((id) => estUuid(id));
  if (ids.length === 0) return refus(400, 'aucun identifiant valide');
  const avantParId = new Map(
    (await deps.connaissance.lister(tenantId, agentId).catch(() => [])).map((f) => [f.id, f] as const),
  );
  let supprimees = 0;
  for (const id of ids) {
    if (!(await deps.connaissance.supprimer(tenantId, agentId, id))) continue;
    supprimees += 1;
    await journaliserFicheSupprimee(deps, tenantId, agentId, id, avantParId.get(id), acteurId);
  }
  return { ok: true, valeur: { supprimees, demandees: ids.length } };
}

/**
 * Écrit les fiches d'un document en REMPLAÇANT celles du même nom, comme une page relue : redéposer le même fichier
 * retire ses fiches d'avant (sinon deux dépôts doubleraient la base, et la recherche remonterait deux fois la même
 * réponse). Le point de passage commun du fichier et de son texte.
 */
async function ecrireDocument(
  deps: DepsConnaissance, tenantId: string, agentId: string,
  nom: string, nature: NaturePieceJointe, fiches: FicheExtraite[], tropCourt: string,
): Promise<Issue<ImportDocument>> {
  if (fiches.length === 0) return refus(422, tropCourt);
  const bilan = await deps.connaissance.remplacerSource(tenantId, agentId, { type: 'document', nom }, fiches);
  if (!bilan) return refus(404, AGENT_INTROUVABLE);
  return { ok: true, valeur: { nom, nature, ...bilan, plafond: MAX_FICHES_PAR_PAGE } };
}

const DOCUMENT_TROP_LOURD = `fichier trop lourd (${Math.round(TAILLE_DOCUMENT_MAX / 1024 / 1024)} Mo maximum)`;

/**
 * Importe un document (texte, CSV, PDF, Word) en fiches, avec le moteur de `src/agent/setup/piece-jointe.ts` : un PDF
 * joint en conversation donne exactement les mêmes fiches. 🔴 Le type est décidé par la signature du fichier, jamais
 * par son extension : ce texte finit dans le prompt d'un agent qui parle à de vrais contacts. Les images ne passent
 * pas ici : il faudrait un modèle de vision.
 */
export async function importerDocument(
  deps: DepsConnaissance, tenantId: string, agentId: string, corps: unknown,
): Promise<Issue<ImportDocument>> {
  if (!estUuid(agentId)) return refus(404, AGENT_INTROUVABLE);
  const lu = saisieDeDocument.safeParse(corps ?? {});
  if (!lu.success) return refus(400, 'nom et dataUrl requis');
  const bytes = octetsDepuisDataUrl(lu.data.dataUrl);
  if (!bytes) return refus(400, 'fichier illisible (data URL base64 attendu)');
  // Nature, texte et fiches en UN seul worker : seules les fiches reviennent, jamais le texte.
  const document = await lireDocumentHorsBoucle(bytes, lu.data.nom, TAILLE_DOCUMENT_MAX);
  const reconnu = document.reconnu;
  // 415 et pas 400 : le corps est bien formé, c'est le type du contenu qu'on refuse.
  if (!reconnu) return refus(415, 'format non accepté (texte en UTF-8, CSV, PDF ou Word)');
  if (reconnu.nature === 'image') {
    return refus(415, 'une image se dépose dans la conversation de construction, qui sait la lire ; ici on attend un document texte, CSV, PDF ou Word');
  }
  if (bytes.length > TAILLE_DOCUMENT_MAX) return refus(413, DOCUMENT_TROP_LOURD);
  // 422 : le type est accepté mais le fichier ne porte aucun texte. Le dire vaut mieux qu'un succès à zéro fiche,
  // que le client lirait comme un import réussi.
  if (!document.fiches) return refus(422, 'aucun texte lisible dans ce fichier (un PDF scanné, par exemple, n’en contient pas)');
  return ecrireDocument(deps, tenantId, agentId, lu.data.nom, reconnu.nature, document.fiches, 'ce fichier est trop court pour faire une fiche');
}

/**
 * Importe le TEXTE d'un document sous son nom (outil `import_document_text`) : traité exactement comme un fichier texte
 * déposé, même normalisation (`normaliser`, celle de `extraireTexte`), même découpage (`texteEnFichesHorsBoucle`,
 * hors de la boucle d'événements), même provenance `document` et même remplacement. Un CSV collé se découpe donc par
 * rangées, comme le même CSV déposé. `tests/agent-connaissance-texte.test.ts` compare les deux chemins.
 */
export async function importerTexteDocument(
  deps: DepsConnaissance, tenantId: string, agentId: string, corps: unknown,
): Promise<Issue<ImportDocument>> {
  if (!estUuid(agentId)) return refus(404, AGENT_INTROUVABLE);
  const lu = saisieDeTexteDocument.safeParse(corps ?? {});
  if (!lu.success) return refus(400, 'nom et texte requis');
  if (Buffer.byteLength(lu.data.texte, 'utf8') > TAILLE_DOCUMENT_MAX) return refus(413, DOCUMENT_TROP_LOURD);
  const fiches = await texteEnFichesHorsBoucle(normaliser(lu.data.texte), lu.data.nom, 'texte');
  return ecrireDocument(deps, tenantId, agentId, lu.data.nom, 'texte', fiches, 'ce texte est trop court pour faire une fiche');
}

/** L'adresse de départ d'un aperçu ou d'un import, contrôlée, sous sa forme canonique, ou le refus. */
function adresseDeDepart(
  deps: DepsConnaissance, tenantId: string, agentId: string, corps: unknown,
): Issue<{ fetchUrl: NonNullable<DepsConnaissance['fetchUrl']>; saisie: z.infer<typeof saisieDeSite>; url: string }> {
  if (!estUuid(agentId)) return refus(404, AGENT_INTROUVABLE);
  if (!deps.fetchUrl) return refus(503, IMPORT_INDISPONIBLE);
  const lu = saisieDeSite.safeParse(corps ?? {});
  if (!lu.success) return refus(400, 'url requise');
  if (!urlRecuperable(lu.data.url)) return refus(400, ADRESSE_REFUSEE);
  // Forme canonique, par `normaliserUrl` et rien d'autre (l'aperçu et l'import l'emploient) : sans elle, la même page
  // avec et sans barre finale ferait deux sources, donc deux jeux de fiches jumelles.
  return { ok: true, valeur: { fetchUrl: deps.fetchUrl, saisie: lu.data, url: normaliserUrl(lu.data.url.trim()) } };
}

/**
 * L'aperçu : ce que l'import ramènerait, sans rien écrire (un import de cinquante pages est difficile à défaire). Il
 * dit aussi ce qu'il n'a pas pris : les pages écartées avec leur raison, le plafond quand il a coupé, et l'échéance
 * quand elle a coupé (`tempsAtteint`).
 */
export async function apercuSite(
  deps: DepsConnaissance, tenantId: string, agentId: string, corps: unknown,
): Promise<Issue<ApercuSite>> {
  const depart = adresseDeDepart(deps, tenantId, agentId, corps);
  if (!depart.ok) return depart;
  const { fetchUrl, saisie, url } = depart.valeur;
  // La portée se déduit de l'adresse quand personne n'en a choisi une : racine -> le site, chemin -> la page.
  const portee = saisie.portee ?? porteeParDefaut(url);

  // Liens et fiches se lisent sur un même lecteur : un worker pour tout l'aperçu, et une échéance pour toutes ses pages.
  const signal = AbortSignal.timeout(deps.echeanceParcoursMs ?? ECHEANCE_PARCOURS_MS);
  return avecLecteur(LECTURE_PAGES, async (lecteur): Promise<Issue<ApercuSite>> => {
    const visite = await visiter(url, portee, (u) => lireUnePage(fetchUrl, u, signal),
      (html, racine, p) => liensDeLaPageHorsBoucle(lecteur, html, racine, p), { signal });
    // Journalisé : c'est ce qui dira si de vrais sites sont trop lents pour l'échéance (`todo.md`).
    if (visite.tempsAtteint) {
      journaliser('warn', 'parcours_coupe', { tenantId, route: 'apercu', lues: visite.pages.length, ecartees: visite.ecartees.length });
    }
    if (visite.pages.length === 0) {
      const pourquoi = visite.ecartees[0]?.raison ?? 'aucune page lisible';
      return refus(422, `rien à importer : ${pourquoi}`);
    }
    // On rend le compte de fiches par page, jamais leur contenu : l'aperçu sert à décider d'une portée, pas à relire
    // cinquante pages dans une réponse.
    const pages: ApercuSite['pages'] = [];
    for (const p of visite.pages) {
      const fiches = await pageEnFichesHorsBoucle(lecteur, p.html, p.url);
      if (fiches.length > 0) pages.push({ url: p.url, fiches: fiches.length, caracteres: fiches.reduce((n, f) => n + f.corps.length, 0) });
    }
    return {
      ok: true,
      valeur: { url, portee, plafondAtteint: visite.plafondAtteint, tempsAtteint: visite.tempsAtteint, ecartees: visite.ecartees, pages },
    };
  });
}

/**
 * Lit des pages et en fait des fiches, en remplaçant celles que la même adresse avait produites. Toutes les issues
 * d'échec sont des refus : un site injoignable ou une page vide sont à lire et corriger par le client.
 */
export async function importerSite(
  deps: DepsConnaissance, tenantId: string, agentId: string, corps: unknown,
): Promise<Issue<ImportSite>> {
  const depart = adresseDeDepart(deps, tenantId, agentId, corps);
  if (!depart.ok) return depart;
  const { fetchUrl, saisie, url } = depart.valeur;

  /**
   * Les adresses à importer ; sans liste, l'adresse fournie seule.
   * 🔴 Chaque adresse est revalidée, même venant de notre aperçu (la liste arrive par le réseau), et son origine
   * doit être celle de `url` : sinon un client importerait le site d'un tiers sous son nom.
   */
  const demandees = saisie.pages ?? [url];
  const aImporter = demandees
    .map((u) => { try { return normaliserUrl(u); } catch { return ''; } })
    .filter((u) => u !== '' && urlRecuperable(u) && dansLaPortee(u, url, 'site'));
  if (aImporter.length === 0) return refus(400, 'aucune adresse importable dans la demande');

  // 🔴 Toutes les pages sont lues et découpées AVANT la première écriture : le worker peut refuser une lecture en
  // cours de route (échéance, mémoire, trop de lectures à la fois), et écrire page par page laisserait alors les
  // premières importées derrière une réponse d'erreur.
  // L'échéance de la requête, elle, n'est pas un refus : ce qui a été lu s'écrit, et les pages qu'elle n'a pas
  // laissé lire reviennent à l'appelant (`restantes`), qui les importe d'un nouveau geste.
  const signal = AbortSignal.timeout(deps.echeanceParcoursMs ?? ECHEANCE_PARCOURS_MS);
  const ecartees: Array<{ url: string; raison: string }> = [];
  const restantes: string[] = [];
  const decoupees = await avecLecteur(LECTURE_PAGES, async (lecteur) => {
    const faites: Array<{ cible: string; fiches: FicheExtraite[] }> = [];
    for (const [i, cible] of aImporter.entries()) {
      if (signal.aborted) { restantes.push(...aImporter.slice(i)); break; }
      const lu = await lireUnePage(fetchUrl, cible, signal);
      // Coupée par l'échéance : elle reste à importer, elle n'est pas en faute.
      if ('erreur' in lu && lu.erreur === TEMPS_ECOULE) { restantes.push(...aImporter.slice(i)); break; }
      if ('erreur' in lu) { ecartees.push({ url: cible, raison: lu.erreur }); continue; }
      const fiches = await pageEnFichesHorsBoucle(lecteur, lu.html, cible);
      if (fiches.length === 0) { ecartees.push({ url: cible, raison: 'aucun contenu exploitable' }); continue; }
      faites.push({ cible, fiches });
    }
    return faites;
  });
  if (restantes.length > 0) {
    journaliser('warn', 'parcours_coupe', { tenantId, route: 'import', lues: decoupees.length, restantes: restantes.length });
  }

  let ecrites = 0;
  let retirees = 0;
  const importees: string[] = [];
  /**
   * Les pages dont la suite n'a pas été lue (plafond de fiches atteint). L'écran comparait le TOTAL écrit au plafond
   * PAR PAGE : quarante fiches réparties sur un site annonçaient une page tronquée qui ne l'était pas.
   */
  const tronquees: string[] = [];
  for (const { cible, fiches } of decoupees) {
    const bilan = await deps.connaissance.remplacerSource(tenantId, agentId, { type: 'page', url: cible }, fiches);
    // `null` = l'agent n'existe pas : inutile d'écrire les pages suivantes.
    if (!bilan) return refus(404, AGENT_INTROUVABLE);
    ecrites += bilan.ecrites;
    retirees += bilan.retirees;
    importees.push(cible);
    if (fiches.length >= MAX_FICHES_PAR_PAGE) tronquees.push(cible);
  }
  // Aucune page retenue : refus portant la raison de la première (un succès à zéro fiche se lirait comme un import
  // réussi). Si l'échéance n'en a laissé lire aucune, c'est le temps qui a manqué : le dire, plutôt qu'une page vide.
  if (importees.length === 0) {
    const pourquoi = restantes.length > 0 ? `${TEMPS_ECOULE}, le site répond trop lentement` : ecartees[0]?.raison ?? 'page vide';
    return refus(422, `aucun contenu importé : ${pourquoi}`);
  }
  return { ok: true, valeur: { url, ecrites, retirees, importees, ecartees, restantes, tronquees, plafond: MAX_FICHES_PAR_PAGE } };
}
