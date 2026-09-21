import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { gardeEtendue, type Guard, type PreHandler } from '../auth/middleware';
import { LabelSourceDejaPris, type SourceAppel } from '../agent/sources';
import type { RisqueOutil } from '../agent/catalog';
import type { SourceParam } from '../agent/llm/tool-schema';
import {
  outilDepuisAnnonce, planifierImport,
  type ChangementMcp, type OutilAImporter, type OutilExistantMcp,
} from '../agent/mcp/import';
import { enTetesAuthSource } from '../agent/http-cible';
import { ouvrirSessionMcp, type EchecMcp, type OutilAnnonce } from '../mcp/client';
import { resolutionPublique, type VerdictResolution } from '../lib/adresse-privee';
import { CHAMPS_CONTACT_AUTORISES, estChampContact } from '../agent/champs-contact';
// ⚠️ `hoteDe` EST IMPORTÉ, PAS RECOPIÉ : ce module prenait déjà deux fonctions de son jumeau, et une
// seconde copie d'une normalisation est exactement ce que le manuel interdit (« un fragment SQL, une classe
// Tailwind ou une normalisation de texte s'y importe, ne se recopie pas »).
import { adresseAcceptable, authCoherente, hoteDe } from './agent-sources';
import { scopeTenant, estUuid } from './scope';
import { makeJournal, type AuditSink } from '../audit/journal';

/**
 * Les CONNECTEURS MCP : éprouver un serveur, importer son catalogue, régler ce qu'on en expose.
 *
 * 🔴 CE QUE CES ROUTES ACCORDENT. Un serveur MCP est une adresse que notre serveur ira appeler, un secret,
 * et surtout un CATALOGUE D'OUTILS ÉCRIT PAR UN TIERS dont les descriptions arrivent dans le contexte du
 * modèle. Trois gardes vivent ici :
 *
 *  1. **L'adresse est vérifiée à l'ÉCRITURE comme à l'appel**, par la même fonction : la découvrir au
 *     moment de l'appel reviendrait à la découvrir en pleine conversation avec un contact.
 *  2. **L'import MONTRE avant d'écrire.** `apercu` rend le plan sans rien appliquer, suppressions comprises.
 *     C'est le patron de la publication chez Meta, et pour la même raison : écraser n'est acceptable que si
 *     l'on montre quoi.
 *  3. **Un clouage désigne un champ qui EXISTE.** La faute de frappe se voit à la configuration, pas en
 *     pleine conversation, et surtout on ne peut pas clouer un paramètre à une clé inventée.
 *
 * ⚠️ LA TRADUCTION D'UNE ANNONCE EN OUTIL N'EST PAS ICI, elle est dans `src/agent/mcp/import.ts`, pure.
 * L'écrire dans une route la rendrait intestable sans monter un serveur.
 */

/** Un serveur MCP tel que l'écran le voit. Le secret n'y est pas, et il ne doit jamais y entrer. */
export interface ServeurMcpVue {
  id: string;
  label: string;
  baseUrl: string;
  authKind: 'none' | 'bearer' | 'header';
  authHeaderName: string | null;
  status: string;
  lastOkAt: string | null;
  lastError: string | null;
}

/**
 * Un outil importé, tel que l'écran le montre.
 *
 * ⚠️ `annonce` PART AU CLIENT, et c'est voulu : c'est le schéma que le SERVEUR annonce, donc la seule chose
 * qu'il puisse montrer à son fournisseur quand un outil est refusé. Elle ne porte aucun secret, elle vient
 * d'en face.
 */
export interface OutilMcpVue {
  id: string;
  name: string;
  nomDistant: string;
  title: string;
  description: string;
  nePasUtiliser: string;
  params: Array<{ name: string; type: string; source: SourceParam; required?: boolean; description?: string; cle?: string; contactPath?: string; value?: string | number | boolean; cheminMcp?: string }>;
  risk: RisqueOutil;
  annonce: unknown;
  /** `null` = activable. Sinon la raison, affichée telle quelle. */
  nonActivable: string | null;
  indisponibleLe: string | null;
  consommateursActifs: number;
}

/** Ce que l'import ÉCRIT, en un seul objet, pour que le store le pose dans une transaction. */
export interface EcritureImportMcp {
  nouveaux: OutilAImporter[];
  /** Schéma changé : on remplace l'annonce et les paramètres, et le consentement TOMBE. */
  changes: Array<{ id: string; outil: OutilAImporter }>;
  /** Ids des outils disparus : marqués indisponibles, JAMAIS supprimés. */
  disparus: string[];
  /** Ids des outils revus, pour avancer `mcp_vu_le`. */
  vus: string[];
}

export interface AgentMcpRouteDeps {
  /**
   * Journal d'audit. Optionnel : absent -> aucune trace (câblages de test).
   *
   * 🔴 UN SERVEUR MCP EST UNE SORTIE DE L'ESPACE, AU MÊME TITRE QU'UN CONNECTEUR API. Le déclarer écrit une
   * adresse que notre serveur ira appeler et un secret ; le supprimer emporte par cascade ses outils
   * importés et TOUS les consentements qui allaient avec. Aucun de ces gestes ne laissait la moindre ligne
   * dans « Sécurité > Audit », alors que le module jumeau en écrit trois et que le commentaire de la route
   * de suppression annonce « exactement comme un connecteur API ». Relevé par la seconde relecture à froid
   * du 2026-09-17.
   *
   * 🔴 LE `detail` NE PORTE JAMAIS LE SECRET, NI L'ADRESSE COMPLÈTE : seulement le MODE d'authentification
   * et l'HÔTE. Même règle que son jumeau, et pour la même raison : l'hôte répond à « où partent les
   * données », le reste donnerait de quoi rejouer l'appel depuis une table qu'on ne purge jamais.
   */
  audit?: AuditSink;
  listerServeurs(tenantId: string): Promise<ServeurMcpVue[]>;
  /** L'adresse et le secret DÉCHIFFRÉ. Un seul appelant, comme pour les connecteurs HTTP. */
  pourAppel(tenantId: string, id: string): Promise<SourceAppel | null>;
  marquerEpreuve(tenantId: string, id: string, ok: boolean, erreur?: string): Promise<void>;
  /**
   * Déclare un serveur MCP. C'est le SEUL chemin qui écrit `kind = 'mcp'`.
   *
   * 🔴 IL N'EN EXISTAIT AUCUN JUSQU'AU 2026-09-17, et c'est la revue à froid qui l'a vu : la route des
   * connecteurs API code `kind: 'http'` en dur, donc `listerServeurs` rendait toujours zéro ligne et tout
   * ce module était du câblage sans producteur.
   */
  creerServeur(tenantId: string, input: {
    label: string; baseUrl: string;
    authKind: 'none' | 'bearer' | 'header'; authHeaderName?: string; authSecret?: string;
  }): Promise<ServeurMcpVue>;
  /**
   * Supprime un serveur MCP.
   *
   * 🔴 TROIS ÉTATS, PAS UN BOOLÉEN. Le booléen d'avant confondait « supprimé » et « introuvable », si bien
   * que le 409 « porte encore des outils actifs » ne sortait QUE sur un identifiant inexistant, pendant
   * qu'un serveur réellement utilisé se supprimait avec ses outils et ses consentements, en silence.
   */
  supprimerServeur(tenantId: string, id: string): Promise<'supprime' | 'introuvable' | 'outils_actifs'>;
  /** Les outils importés, pour l'ÉCRAN. Séparée de la lecture d'import, qui compare et rien de plus. */
  outilsPourEcran(tenantId: string, sourceId: string): Promise<OutilMcpVue[]>;
  /** Les outils MCP déjà importés de ce serveur, avec ce qu'un changement ferait tomber. */
  outilsDuServeur(tenantId: string, sourceId: string): Promise<OutilExistantMcp[]>;
  /** Les noms d'outils DÉJÀ pris dans l'espace : l'unicité est par espace depuis 0127. */
  nomsPris(tenantId: string): Promise<string[]>;
  /** La seule écriture de ce module. Tout ou rien. */
  appliquer(tenantId: string, sourceId: string, ecriture: EcritureImportMcp): Promise<void>;
  /** Les clés des champs personnalisés DÉCLARÉS par l'espace : un clouage doit en désigner une. */
  clesDeChamps(tenantId: string): Promise<string[]>;
  /** Le réglage d'un outil importé. Rend `false` si l'outil n'est pas de cet espace. */
  reglerOutil(tenantId: string, outilId: string, patch: {
    params?: Array<{ name: string; source: SourceParam; cle?: string; contactPath?: string; value?: string | number | boolean }>;
    risk?: RisqueOutil;
    nePasUtiliser?: string;
  }): Promise<boolean>;
  /** Injectées pour tester sans réseau ni DNS. */
  ouvrirSession?: typeof ouvrirSessionMcp;
  verifierResolution?: (url: string) => Promise<VerdictResolution>;
}

/**
 * Budget d'une opération d'import, en millisecondes.
 *
 * 🔴 IL EXISTE PARCE QUE L'ÉCHÉANCE DE `fetch` EST PAR REQUÊTE. Un catalogue paginé sur vingt pages
 * tiendrait sinon vingt fois cette valeur, très au delà de ce qu'une passerelle laisse passer, et le client
 * verrait une page qui tourne sans fin plutôt qu'une erreur.
 */
const BUDGET_IMPORT_MS = 25_000;
const TIMEOUT_REQUETE_MS = 8_000;
/** Un catalogue entier peut être gros ; il ne traverse pas le modèle, il s'affiche. */
const MAX_OCTETS_CATALOGUE = 1_000_000;

const creationSchema = z.object({
  label: z.string().trim().min(1).max(80),
  /** L'adresse du POINT MCP : une adresse unique, pas une racine sous laquelle on compose des chemins. */
  baseUrl: z.string().trim().min(1).max(500),
  authKind: z.enum(['none', 'bearer', 'header']),
  authHeaderName: z.string().trim().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
  authSecret: z.string().trim().min(1).max(500).optional(),
});

const CLE_CHAMP = z.string().trim().min(1).max(64);
const reglageSchema = z.object({
  risk: z.enum(['read', 'write', 'irreversible']).optional(),
  nePasUtiliser: z.string().trim().max(2000).optional(),
  params: z.array(z.object({
    name: z.string().trim().min(1).max(64),
    source: z.enum(['modele', 'contact', 'champ', 'fixe']),
    cle: CLE_CHAMP.optional(),
    contactPath: z.string().trim().min(1).max(64).optional(),
    value: z.union([z.string().max(500), z.number(), z.boolean()]).optional(),
  })).max(100).optional(),
});

function direEchec(e: EchecMcp): string {
  switch (e.genre) {
    case 'transport_ancien':
      return 'ce serveur parle l’ancien transport HTTP+SSE de la révision 2024-11-05, qui n’est pas pris en charge';
    case 'refus':
      return `le serveur a refusé la connexion (${e.code})`;
    case 'reseau':
      return 'le serveur est injoignable';
    case 'redirection':
      return 'le serveur a redirigé l’appel, ce qui n’est pas accepté sur un connecteur';
    case 'adresse_interne':
      // Même phrase que la vérification préalable (`ouvrirPourSource`) : c'est la même cause, vue plus tard.
      return 'cette adresse ne résout pas vers une adresse publique';
    case 'budget':
      // ⚠️ NOTRE MINUTERIE, ET ON LE DIT. Ici c'est l'administrateur qui regarde l'écran : lui annoncer une
      // réponse « illisible » l'enverrait soupçonner son serveur pour un délai que nous avons fixé.
      return 'le serveur a mis trop de temps à répondre (délai de l’épreuve dépassé)';
    default:
      return e.message;
  }
}

/**
 * LA SOURCE DE CETTE ROUTE, ET ELLE EST BIEN UN SERVEUR MCP.
 *
 * 🔴 SANS CE FILTRE, CES ROUTES PARLENT MCP À L'API MÉTIER D'UN CLIENT. `pourAppel` ne filtre pas le
 * `kind` (un seul appelant à l'origine, le résolveur HTTP), donc un administrateur qui passait
 * l'identifiant d'un connecteur API à `/eprouver`, `/apercu` ou `/importer` faisait POSTer une enveloppe
 * JSON-RPC `initialize` sur son propre système, AVEC SON SECRET dans l'en-tête, puis écrivait
 * `last_error` sur la ligne de ce connecteur. Sur `/importer`, l'`insert` garde `and kind = 'mcp'` :
 * zéro ligne écrite, AUCUNE erreur, et la route rendait `200` en annonçant N outils créés.
 *
 * 🔴 UN POINT DE PASSAGE, PAS TROIS CONTRÔLES. Les deux résolveurs d'exécution portent déjà cette garde
 * (`resolvers/mcp.ts`, `resolvers/http.ts`) ; les routes étaient le TROISIÈME consommateur de
 * `pourAppel` et ne l'avaient pas. C'est le motif « une capacité câblée sur deux consommateurs sur
 * trois », que ce dépôt paie en boucle. Le poser ici, entre les routes et la source, est ce qui évite que
 * la quatrième route ajoutée demain l'oublie.
 *
 * ⚠️ `404`, PAS `403` : pour cet écran, un connecteur API n'est pas un serveur MCP interdit, c'est un
 * serveur MCP qui n'existe pas. Répondre `403` confirmerait au passage l'existence de la ligne.
 */
async function serveurMcp(
  deps: AgentMcpRouteDeps,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ tenant: string; sourceId: string; source: SourceAppel } | null> {
  const tenant = scopeTenant(req);
  if (tenant === null) { await reply.code(403).send({ error: 'tenant interdit' }); return null; }
  const { sourceId } = req.params as { sourceId: string };
  if (!estUuid(sourceId)) { await reply.code(400).send({ error: 'identifiant invalide' }); return null; }
  const source = await deps.pourAppel(tenant, sourceId);
  if (!source || source.kind !== 'mcp') {
    await reply.code(404).send({ error: 'serveur introuvable' });
    return null;
  }
  return { tenant, sourceId, source };
}

/** Ouvre une session vers un serveur, après avoir vérifié vers quoi son adresse RÉSOUT. */
async function connecter(
  deps: AgentMcpRouteDeps,
  source: SourceAppel,
): Promise<{ echec: string } | Awaited<ReturnType<typeof ouvrirSessionMcp>>> {
  const verifier = deps.verifierResolution ?? resolutionPublique;
  // 🔴 AVANT TOUTE CONNEXION. Une vérification posée après serait décorative : la connexion aurait déjà eu
  // lieu, donc le dégât aussi.
  const verdict = await verifier(source.baseUrl);
  if (!verdict.ok) return { echec: verdict.raison ?? 'cette adresse ne résout pas vers une adresse publique' };
  const ouvrir = deps.ouvrirSession ?? ouvrirSessionMcp;
  return ouvrir({
    url: source.baseUrl,
    enTetes: enTetesAuthSource(source),
    timeoutMs: TIMEOUT_REQUETE_MS,
    budgetTotalMs: BUDGET_IMPORT_MS,
    maxOctets: MAX_OCTETS_CATALOGUE,
  });
}

/**
 * Le plan d'un rafraîchissement, et ce qu'il faudrait écrire pour l'appliquer.
 *
 * Les deux sont calculés ENSEMBLE et par la même fonction : c'est ce qui garantit que l'aperçu montre
 * exactement ce que l'application fera. Deux calculs séparés finiraient par diverger, et le client
 * validerait alors un plan qui n'est pas celui qui s'exécute.
 */
function planEtEcriture(
  annonces: readonly OutilAnnonce[],
  existants: readonly OutilExistantMcp[],
  tronque: boolean,
  libelleSource: string,
  nomsPris: readonly string[],
): { plan: ChangementMcp[]; ecriture: EcritureImportMcp } {
  const plan = planifierImport(annonces, existants, { tronque });
  const parNom = new Map(existants.map((e) => [e.nomDistant, e]));
  const annoncesParNom = new Map(annonces.map((a) => [a.name, a]));
  /**
   * Les noms déjà pris dans l'espace. Ils le restent TOUS.
   *
   * 🔴 CE RETRAIT ÉTAIT UN 500 QUI ATTENDAIT SON JOUR. Il enlevait les noms de TOUS les outils de ce
   * serveur, `inchange` compris, alors que seuls `nouveau` et `schema_change` les remettent. Un outil
   * distant NEUF qui se normalise vers le nom local d'un outil INCHANGÉ (`get-contact` à côté de
   * `get_contact` : `normaliserNom` rend le même) produisait alors un `insert` en violation de l'index
   * unique par espace de 0127, donc un `rollback` de TOUTE la transaction, donc un import entier perdu
   * sur un 500 dont Cloudflare remplace le corps.
   *
   * ⚠️ ET IL NE SERVAIT À RIEN : le `_2` qu'il prétendait éviter ne peut pas arriver, parce qu'un
   * `schema_change` ÉCRASE le nom calculé par celui d'avant (`name: avant.name`, juste en dessous).
   */
  const pris = new Set(nomsPris);

  const ecriture: EcritureImportMcp = { nouveaux: [], changes: [], disparus: [], vus: [] };
  for (const c of plan) {
    const annonce = annoncesParNom.get(c.nom);
    const avant = parNom.get(c.nom);
    if (c.type === 'nouveau' && annonce) {
      const outil = outilDepuisAnnonce(annonce, libelleSource, pris);
      pris.add(outil.name);
      ecriture.nouveaux.push(outil);
    } else if (c.type === 'schema_change' && annonce && avant) {
      // Le nom LOCAL ne bouge pas : il est peut-être déjà écrit dans une consigne d'agent, et le changer
      // casserait ce que le client a rédigé. Seuls l'annonce, les paramètres et l'activabilité changent.
      // 🔴 `avant.params` EST CE QUI SAUVE LA GARDE D'IDENTITÉ. Sans lui, un changement de schéma remet
      // tout en « rempli par le modèle », donc influençable par le contact, pendant que le consentement
      // tombe et que le client le redonne depuis un autre écran.
      const outil = { ...outilDepuisAnnonce(annonce, libelleSource, pris, avant.params), name: avant.name };
      pris.add(outil.name);
      ecriture.changes.push({ id: avant.id, outil });
    } else if (c.type === 'disparu' && avant) {
      ecriture.disparus.push(avant.id);
    } else if (c.type === 'inchange' && avant) {
      ecriture.vus.push(avant.id);
    }
  }
  return { plan, ecriture };
}

export function registerAgentMcp(
  app: FastifyInstance,
  deps: AgentMcpRouteDeps,
  garde: Guard,
  limiteCouteuse?: PreHandler,
): void {
  const opts = { preHandler: garde };
  const journal = makeJournal(deps.audit);
  // ⚠️ L'ÉPREUVE, L'APERÇU ET L'IMPORT SONT LOURDS : ils ouvrent une session vers un serveur tiers et
  // paginent son catalogue. Ils portent donc `RATE_LIMIT_COUTEUX_PAR_MINUTE`, comme l'import CSV et
  // l'aperçu d'un site, et pour la même raison : ce sont des gestes qu'un client peut déclencher en
  // rafale sans s'en rendre compte.
  const lourd = gardeEtendue(garde, limiteCouteuse);

  app.get('/tenants/:tenantId/mcp', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    return reply.code(200).send({ serveurs: await deps.listerServeurs(tenant) });
  });

  /**
   * Déclarer un serveur MCP.
   *
   * 🔴 L'ADRESSE EST VALIDÉE À L'ÉCRITURE, par la MÊME fonction que les connecteurs API. La refuser au
   * moment de l'appel reviendrait à la découvrir en pleine conversation avec un contact, et deux
   * définitions de « adresse acceptable » finiraient par accepter ici ce que l'appel refuse là-bas.
   *
   * ⚠️ Le secret est chiffré par le store, jamais ici : la couche HTTP ne manipule pas de forme chiffrée.
   */
  app.post('/tenants/:tenantId/mcp', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const parse = creationSchema.safeParse(req.body ?? {});
    if (!parse.success) return reply.code(400).send({ error: 'libellé, adresse et mode d’authentification requis' });
    const { label, baseUrl, authKind, authHeaderName, authSecret } = parse.data;
    if (!adresseAcceptable(baseUrl)) {
      return reply.code(400).send({ error: 'adresse refusée : elle doit être publique et en HTTPS' });
    }
    const pb = authCoherente(authKind, authSecret, authHeaderName);
    if (pb) return reply.code(400).send({ error: pb });
    /**
     * ⚠️ UN LIBELLÉ DÉJÀ PRIS REND 409, PAS 500. L'index unique de 0088 porte sur
     * `(tenant_id, lower(label))` TOUS `kind` CONFONDUS : déclarer un serveur MCP qui porte le nom d'un
     * connecteur API existant levait `LabelSourceDejaPris`, donc un 500, donc une page Cloudflare sans
     * explication sur un geste parfaitement ordinaire. La route jumelle traduit déjà cette exception.
     */
    let serveur: ServeurMcpVue;
    try {
      serveur = await deps.creerServeur(tenant, {
        label, baseUrl, authKind,
        ...(authHeaderName ? { authHeaderName } : {}),
        ...(authSecret ? { authSecret } : {}),
      });
    } catch (err) {
      if (err instanceof LabelSourceDejaPris) {
        return reply.code(409).send({ error: `le nom « ${label} » est déjà pris par un autre connecteur` });
      }
      throw err;
    }
    await journal(tenant, req, 'connecteur.cree', { kind: 'connecteur', id: serveur.id }, {
      mcp: true, authKind: parse.data.authKind, hote: hoteDe(parse.data.baseUrl),
    });
    return reply.code(201).send({ serveur });
  });

  /**
   * Supprimer un serveur.
   *
   * ⚠️ REFUSÉ TANT QU'UN OUTIL ACTIF EN DÉPEND (409), exactement comme un connecteur API. La cascade ferait
   * disparaître les outils sans bruit, et l'agent deviendrait muet sur ces gestes-là, en production, sans
   * que personne ne l'ait décidé.
   *
   * 🔴 CE COMMENTAIRE A ÉTÉ FAUX DU PREMIER JOUR AU 2026-09-17, et c'est la revue à froid qui l'a vu. La
   * dépendance était câblée sur un `delete` nu : le refus ne se déclenchait jamais sur le cas qu'il
   * nomme, et se déclenchait sur un identifiant inexistant. Une justification fausse est pire qu'aucune,
   * parce qu'elle est crue. Le verdict est désormais à trois états et la garde vit dans la même
   * transaction que la suppression.
   */
  app.delete('/tenants/:tenantId/mcp/:sourceId', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { sourceId } = req.params as { sourceId: string };
    if (!estUuid(sourceId)) return reply.code(400).send({ error: 'identifiant invalide' });
    const verdict = await deps.supprimerServeur(tenant, sourceId);
    if (verdict === 'introuvable') return reply.code(404).send({ error: 'serveur introuvable' });
    if (verdict === 'outils_actifs') {
      return reply.code(409).send({ error: 'ce serveur porte encore des outils actifs : désactivez-les d’abord' });
    }
    await journal(tenant, req, 'connecteur.supprime', { kind: 'connecteur', id: sourceId }, { mcp: true });
    return reply.code(204).send();
  });

  /**
   * Les outils importés d'un serveur.
   *
   * 🔴 SANS ELLE, L'ÉCRAN NE PEUT RIEN RÉGLER, et c'est le manque que la tâche 8 a révélé : l'import
   * écrivait des outils que personne ne pouvait ni voir ni clouer. Une capacité écrite sans son lecteur
   * est exactement le motif « offert-et-inerte » que ce produit s'interdit.
   */
  app.get('/tenants/:tenantId/mcp/:sourceId/outils', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { sourceId } = req.params as { sourceId: string };
    if (!estUuid(sourceId)) return reply.code(400).send({ error: 'identifiant invalide' });
    /**
     * 🔴 LES DEUX LISTES DE CLOUAGE PARTENT AVEC, ET C'EST CE QUI EMPÊCHE UNE SECONDE VÉRITÉ. L'écran doit
     * proposer un CHOIX, pas un champ libre : `CHAMPS_CONTACT_AUTORISES` est fermée exprès, et les clés du
     * mini-CRM sont celles que le client a créées. Les recopier côté navigateur ferait diverger la liste
     * proposée de la liste acceptée, et le client verrait un refus sur une valeur qu'on lui a suggérée.
     */
    const [outils, champs] = await Promise.all([
      deps.outilsPourEcran(tenant, sourceId),
      deps.clesDeChamps(tenant),
    ]);
    return reply.code(200).send({ outils, champs, champsContact: [...CHAMPS_CONTACT_AUTORISES] });
  });

  /**
   * Éprouver un serveur : `initialize` SEUL, pas d'import.
   *
   * ⚠️ C'est le seul moyen de voir un jeton mort ou un transport non pris en charge AVANT qu'un contact ne
   * le découvre. Un serveur inatteignable ne produit aucune erreur applicative côté client : l'agent
   * dégraderait en silence, au milieu d'une conversation.
   */
  app.post('/tenants/:tenantId/mcp/:sourceId/eprouver', lourd, async (req, reply) => {
    const ciblee = await serveurMcp(deps, req, reply);
    if (ciblee === null) return reply;
    const { tenant, sourceId, source } = ciblee;

    const ouverte = await connecter(deps, source);
    if ('echec' in ouverte) {
      const raison = typeof ouverte.echec === 'string' ? ouverte.echec : direEchec(ouverte.echec);
      await deps.marquerEpreuve(tenant, sourceId, false, raison);
      return reply.code(200).send({ ok: false, erreur: raison });
    }
    await ouverte.fermer();
    await deps.marquerEpreuve(tenant, sourceId, true);
    return reply.code(200).send({ ok: true });
  });

  /**
   * L'aperçu : le plan, SANS rien écrire DANS LE CATALOGUE.
   *
   * 🔴 EN `POST`, ET CE N'EST PAS UNE COQUETTERIE REST. Ce chemin OUVRE UNE CONNEXION SORTANTE vers le
   * serveur du client et ÉCRIT `marquerEpreuve` : en `GET`, un préchargement de navigateur, un
   * aperçu de lien, une nouvelle tentative automatique ou un robot d'indexation suffisaient à faire
   * appeler le serveur d'un client et à changer son état affiché, sans que personne ait cliqué. « Sans
   * rien écrire » ne parlait que du catalogue, et c'est ce raccourci qui a fait choisir le verbe.
   */
  app.post('/tenants/:tenantId/mcp/:sourceId/apercu', lourd, async (req, reply) => {
    const r = await calculer(deps, req, reply);
    if (r === null) return reply;
    return reply.code(200).send({ plan: r.plan, tronque: r.tronque });
  });

  /** L'import : le même plan, appliqué. */
  app.post('/tenants/:tenantId/mcp/:sourceId/importer', lourd, async (req, reply) => {
    const r = await calculer(deps, req, reply);
    if (r === null) return reply;
    await deps.appliquer(r.tenant, r.sourceId, r.ecriture);
    return reply.code(200).send({ plan: r.plan, tronque: r.tronque });
  });

  /**
   * Le réglage d'un outil importé : la source de chaque paramètre, le risque, et quand ne pas l'appeler.
   *
   * 🔴 UN CLOUAGE DÉSIGNE UN CHAMP QUI EXISTE, et c'est vérifié ICI, à l'écriture. La faute de frappe se
   * voit alors à la configuration plutôt qu'en pleine conversation, et surtout un paramètre ne peut pas
   * être cloué à une clé que personne n'a créée : il partirait vide à chaque appel, en silence.
   */
  app.patch('/tenants/:tenantId/mcp/outils/:outilId', opts, async (req, reply) => {
    const tenant = scopeTenant(req);
    if (tenant === null) return reply.code(403).send({ error: 'tenant interdit' });
    const { outilId } = req.params as { outilId: string };
    if (!estUuid(outilId)) return reply.code(400).send({ error: 'identifiant invalide' });

    const parse = reglageSchema.safeParse(req.body);
    if (!parse.success) return reply.code(400).send({ error: 'réglage invalide' });
    const d = parse.data;

    if (d.params) {
      const cles = await deps.clesDeChamps(tenant);
      for (const p of d.params) {
        if (p.source === 'champ') {
          if (!p.cle) return reply.code(400).send({ error: `le paramètre « ${p.name} » doit désigner un champ` });
          if (!cles.includes(p.cle)) return reply.code(400).send({ error: `le champ « ${p.cle} » n’existe pas dans cet espace` });
        }
        /**
         * 🔴 UN CLOUAGE `contact` DÉSIGNE UN ATTRIBUT DE LA LISTE FERMÉE, ET RIEN D'AUTRE. Cette route est
         * le PREMIER écrivain de `source: 'contact'` du dépôt (les outils HTTP dérivent leurs paramètres
         * côté serveur), donc la fermeture de `champs-contact.ts` n'était gardée par personne ici : un
         * `contactPath: 'champs'` aurait fait partir TOUT le jsonb des champs personnalisés du contact
         * vers le serveur tiers, et `'tags'` le tableau de tags.
         *
         * ⚠️ ET SANS `contactPath`, L'OPTION EST INERTE. L'exécuteur calcule `p.contactPath ?? p.name` :
         * pour un paramètre distant nommé `client_id`, il chercherait `ctx.contact['client_id']`, qui
         * n'existe pas, et enverrait `null`. Le client croirait avoir cloué l'identifiant.
         */
        if (p.source === 'contact') {
          if (!p.contactPath) return reply.code(400).send({ error: `le paramètre « ${p.name} » doit désigner un attribut de la fiche` });
          if (!estChampContact(p.contactPath)) {
            return reply.code(400).send({ error: `« ${p.contactPath} » n’est pas un attribut de fiche autorisé` });
          }
        }
        // ⚠️ `fixe` SANS VALEUR est refusé pour la même raison qu'un `champ` sans clé : le paramètre
        // partirait vide chez le serveur du client, à chaque appel, sans que rien ne le signale.
        if (p.source === 'fixe' && p.value === undefined) {
          return reply.code(400).send({ error: `le paramètre « ${p.name} » doit porter une valeur` });
        }
      }
    }

    const ok = await deps.reglerOutil(tenant, outilId, d);
    return ok ? reply.code(200).send({ ok: true }) : reply.code(404).send({ error: 'outil introuvable' });
  });
}

/**
 * Le tronc commun de l'aperçu et de l'import : lire le catalogue et calculer le plan.
 *
 * 🔴 UNE SEULE FONCTION POUR LES DEUX, et c'est ce qui garantit que ce que le client valide est ce qui
 * s'exécute. Deux calculs séparés finiraient par diverger, et l'aperçu deviendrait une promesse.
 *
 * Rend `null` quand la réponse a déjà été envoyée (refus, 404, échec de connexion).
 */
async function calculer(
  deps: AgentMcpRouteDeps,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ tenant: string; sourceId: string; plan: ChangementMcp[]; ecriture: EcritureImportMcp; tronque: boolean } | null> {
  const ciblee = await serveurMcp(deps, req, reply);
  if (ciblee === null) return null;
  const { tenant, sourceId, source } = ciblee;

  const ouverte = await connecter(deps, source);
  if ('echec' in ouverte) {
    const raison = typeof ouverte.echec === 'string' ? ouverte.echec : direEchec(ouverte.echec);
    await deps.marquerEpreuve(tenant, sourceId, false, raison);
    await reply.code(502).send({ error: raison });
    return null;
  }

  try {
    const catalogue = await ouverte.lister();
    if ('echec' in catalogue) {
      const raison = direEchec(catalogue.echec);
      await deps.marquerEpreuve(tenant, sourceId, false, raison);
      await reply.code(502).send({ error: raison });
      return null;
    }
    await deps.marquerEpreuve(tenant, sourceId, true);
    const [existants, nomsPris] = await Promise.all([
      deps.outilsDuServeur(tenant, sourceId),
      deps.nomsPris(tenant),
    ]);
    const serveurs = await deps.listerServeurs(tenant);
    const libelle = serveurs.find((s) => s.id === sourceId)?.label ?? 'mcp';
    const { plan, ecriture } = planEtEcriture(catalogue.outils, existants, catalogue.tronque, libelle, nomsPris);
    return { tenant, sourceId, plan, ecriture, tronque: catalogue.tronque };
  } finally {
    await ouverte.fermer();
  }
}
