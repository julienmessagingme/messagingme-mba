import { setTimeout as dormir } from 'node:timers/promises';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { waIdOf } from '../crm/identity';
import type { BuiltRecipient, ChampsFiche, ContactEnvoi } from '../campaign/build';
import type { CampaignCategory } from '../campaign/types';
import type { EnvoiApiBrut } from '../campaign/store.pg';
import { validateParamMapping, type TemplateParam } from '../crm/template';
import type { ResolveResult } from '../ids/resolve';
import type { WorkflowGraph } from '../workflow/graph';
import { modeleDOuverture, ouvertureApi, type OuvertureApi } from '../workflow/ouverture-api';
import type { IdempotencyClaim } from './idempotency-store.pg';
import { cleIdempotence, DUREE_CLE_IDEMPOTENCE_MS, empreinteCorps } from './idempotence';
import type { CodeApi } from './erreurs';
import { schemaClesFiche, videEnAbsent, type ClesFiche, type ModeCreation, type ResolutionFiche } from './fiche';
import type { IssueConsentement } from './consentement';
import { MAX_OPT_IN_SOURCE } from './contacts-upsert';
import { construireDestinataires, marquerDoublons, trierDestinataires, type DestinataireResolu, type Ecart } from './sends-build';
import { categoriePlusStricte, modeleEnvoyable, numeroDEnvoi, type LectureModele, type RefusEnvoi } from './modele-envoi';
import { messageDeForme } from './forme';
import type { RcsOutbound } from '../rcs/types';
import { PREFIXE_ENVOI_API, resoudreCibleRcs, schemaCibleRcs, type DepsCibleRcs } from './cible-rcs';
import { destinataireAvecVariablesInterdites, schemaVariables } from './variables';
import { MESSAGE_NUMERO_DELIE, MESSAGE_NUMERO_SUSPENDU } from '../meta/numero-delie';
import { messageDe } from '../lib/erreur';
import { LimiteOffreError, STATUT_REFUS_OFFRE, corpsRefusFonction, corpsRefusLimite } from '../offres/refus';
import type { SourceOffres } from '../offres/offre.pg';

export interface CreationEnvoiPublic {
  tenantId: string;
  phoneNumberId: string;
  name: string;
  category: CampaignCategory;
  templateName: string;
  templateLanguage: string;
  paramMapping: TemplateParam[];
  workflowId?: string;
  /** Cible node : le run démarre à ce bloc du scénario (au lieu de son entrée). */
  startNodeId?: string;
  /** Cible `rcsMessage` : une campagne RCS, partie de l'agent de l'espace. Absent = WhatsApp. */
  channel?: 'rcs';
  rcsAgentId?: string;
  rcsMessage?: RcsOutbound;
}
export interface DepsEnvoiPublic {
  /** Scénario par code `scn_` ou par nom, avec son graphe publié : c'est lui que `ouvertureApi` juge. */
  resolveScenario(tenantId: string, ref: string): Promise<ResolveResult<{ id: string; name: string; graph: WorkflowGraph }>>;
  /** Bloc par code `nod_`, dans les graphes publiés, avec le graphe d'où juger ce qui part depuis lui. */
  resolveNode(tenantId: string, code: string): Promise<ResolveResult<{ workflowId: string; nodeId: string; label: string; graph: WorkflowGraph }>>;
  /** Le template lu chez Meta : sa catégorie, ou pourquoi il ne peut pas partir (`verdictModele`). */
  lireModele(tenantId: string, name: string, language: string): Promise<LectureModele>;
  /** Fenêtre de service 24 h par wa_id. Absent de la map = fermée. Lue pour une ouverture de session seulement. */
  inbox: { getWindowOpenByWaIds(tenantId: string, waIds: string[]): Promise<Map<string, boolean>> };
  /** Le dépôt des campagnes : un envoi de l'API en est une. */
  repo: {
    getTenantPhoneNumberId(tenantId: string): Promise<string | null>;
    phoneNumberBelongsToTenant(phoneNumberId: string, tenantId: string): Promise<boolean>;
    /** Les fiches désignées, bloquées comprises. */
    listContactsPourEnvoiApi(tenantId: string, ids: string[]): Promise<ContactEnvoi[]>;
    /**
     * Crée la campagne si `confirmer` le dit, dans la même transaction (`null` = rien n'a été créé). La route y
     * scelle la clé d'idempotence : jamais de campagne sans la clé qui la désigne.
     */
    createWithRecipientsSiConfirme(
      input: CreationEnvoiPublic,
      recipients: BuiltRecipient[],
      confirmer: (tx: PoolClient, campaignId: string) => Promise<boolean>,
    ): Promise<{ campaignId: string; recipientCount: number } | null>;
    /** Pose et retire des champs sur UNE fiche, par le `tx` de la création (l'option `champsFiche`). */
    ecrireChampsFiche(tx: PoolClient, tenantId: string, contactId: string, champs: ChampsFiche): Promise<void>;
    /** L'envoi tel que `GET /v1/sends/{sendId}` le décrit, avant mise en forme. */
    lireEnvoiApi(sendId: string, tenantId: string): Promise<EnvoiApiBrut | null>;
  };
  /**
   * Le numéro est-il délié de son espace ? La garde du point de passage des envois, dont « Délier » et « Relier »
   * vident le cache. Requise : sans elle, un envoi sur un numéro délié serait accepté en 201 et partirait au
   * premier « Relier », parfois des jours plus tard.
   */
  numerosDelies: { estDelie(phoneNumberId: string): Promise<boolean> };
  /** Le numéro est-il suspendu (lot 4, l'abonnement du numéro fourni) ? La garde du point d'envoi. Requise aussi. */
  numerosSuspendus: { estSuspendu(phoneNumberId: string): Promise<boolean> };
  /**
   * Les modèles du mois de l'offre (lot 6, `QuotaModeles`) : un envoi qui ouvre par un modèle et ne tient pas dans ce
   * qu'il reste est refusé en entier (402). Une ESTIMATION pour refuser tôt : la fabrique décide à l'envoi. Requise : les
   * fixtures disent leur hypothèse (sans limite).
   */
  modelesDuMois: { etatDuMois(tenantId: string): Promise<{ max: number; reste: number } | null> };
  /**
   * L'offre de l'espace (lot 6, B2a) : sans `scenarios`, une cible scénario ou bloc démarrerait un parcours que le gel
   * refuse ensuite destinataire par destinataire ; elle est refusée tout de suite (402 `plan_feature_unavailable`).
   */
  offres: SourceOffres;
  /** La résolution de fiche partagée (`resoudreFiche`), liée à ses dépendances par le câblage. */
  resoudreFiche(tenantId: string, cles: ClesFiche, opts: { creer: ModeCreation }): Promise<ResolutionFiche>;
  /**
   * L'écriture du consentement partagée (`appliquerConsentement`). Son issue n'est pas lue ici : un `opted_in` sur
   * une fiche désabonnée est refusé (🔴 un STOP ne se lève pas par machine), la fiche reste `opted_out` et le tri
   * l'écarte ; une fiche purgée entre-temps est dite `unknown_contact`.
   */
  appliquerConsentement(tenantId: string, contactId: string, consent: 'opted_in' | 'opted_out', source: string): Promise<IssueConsentement>;
  /** `tenantId` porte le groupe de la file : la concurrence des runs est plafonnée par espace. */
  enqueue(campaignId: string, tenantId: string, pendingCount: number, ratePerMinute: number | null): Promise<void>;
  /**
   * Le magasin d'idempotence. Le `jeton` rendu par `claim` est REQUIS partout ensuite : une clé abandonnée
   * puis reprise par un autre appel n'appartient plus à celui-ci, qui ne doit ni la sceller, ni la libérer.
   */
  idempotence: {
    /** `empreinte` = `empreinteCorps(corps)` : la même clé avec un autre corps rend `reused`. */
    claim(tenantId: string, key: string, empreinte: string): Promise<IdempotencyClaim>;
    /** La clé est-elle encore à ce porteur, et encore en cours ? */
    possede(tenantId: string, key: string, jeton: string): Promise<boolean>;
    /**
     * `false` = la clé a été reprise, l'autre appel enverra. `tx` : la transaction qui crée la campagne, pour
     * que la clé et la campagne naissent ensemble ou pas du tout.
     */
    complete(tenantId: string, key: string, jeton: string, sendId: string, response: unknown, tx: PoolClient): Promise<boolean>;
    release(tenantId: string, key: string, jeton: string): Promise<void>;
  };
  /** La cible `rcsMessage` : un message de la bibliothèque par son nom, et l'agent RCS de l'espace. */
  rcs: DepsCibleRcs;
  /** Attente entre deux tentatives d'enqueue. Injectable pour tester le retry sans temporisation réelle. */
  sleep?(ms: number): Promise<void>;
}

export const MAX_RECIPIENTS = 50;
export const MAX_SKIPPED_REPORT = 200;
/** Retry borné de l'enqueue : 3 tentatives, backoff court entre chacune. Cf. la note au call site sur ce qui
*  rend ce retry sûr (ce n'est pas une déduplication de file). */
const ENQUEUE_MAX_ATTEMPTS = 3;
const ENQUEUE_RETRY_DELAYS_MS = [100, 300];

/**
 * Les quatre cibles, strictes : un objet qui porterait deux cibles, ou une clé mal orthographiée, est refusé
 * plutôt que lu à moitié.
 */
const schemaCible = z.union([
  z.strictObject({ template: z.strictObject({ name: z.string().trim().min(1).max(512), language: z.string().trim().min(1).max(20) }) }),
  z.strictObject({ scenario: z.string().trim().min(1).max(200) }),
  z.strictObject({ node: z.string().trim().min(1).max(200) }),
  // Un message de Contenu > Messages RCS, par son nom (`src/api/cible-rcs.ts`).
  schemaCibleRcs,
]);

/**
 * Le corps, strict au premier niveau : une clé mal orthographiée (`ratePerMinutes`) ne doit pas changer le
 * comportement en silence. `recipients` reste en `unknown[]` : un destinataire mal formé est écarté, il ne fait
 * pas tomber l'envoi.
 */
export const schemaCorps = z.strictObject({
  idempotencyKey: z.string().optional(),
  target: schemaCible,
  recipients: z.array(z.unknown()).min(1).max(MAX_RECIPIENTS),
  params: z.array(z.unknown()).optional(),
  // Vide = absence, comme pour les destinataires (`videEnAbsent`) : un outil qui remplit son corps de variables
  // envoie `""` pour celles qu'il n'a pas. Un `phoneNumberId` vide prend le numéro par défaut ; une `category`
  // vide est absente (ignorée sur un template, « requise » ailleurs).
  category: z.preprocess(videEnAbsent, z.enum(['marketing', 'utility']).optional()),
  ratePerMinute: z.number().int().min(1).max(80).optional(),
  phoneNumberId: z.preprocess(videEnAbsent, z.string().trim().min(1).max(64).optional()),
});

/**
 * Un destinataire : les clés de fiche plus son consentement. Ses clés inconnues sont écartées, pas refusées
 * (l'outil de l'appelant peut y laisser des données de son profil). Un `consent` ou `consentSource` vide vaut
 * absence ; une valeur fausse (« oui ») écarte le destinataire (`invalid_recipient`).
 */
export const schemaDestinataire = schemaClesFiche.extend({
  consent: z.preprocess(videEnAbsent, z.enum(['opted_in', 'opted_out']).optional()),
  consentSource: z.preprocess(videEnAbsent, z.string().trim().min(1).max(MAX_OPT_IN_SOURCE).optional()),
  // Des valeurs propres à ce destinataire, jamais écrites sur sa fiche. Mal formées, elles écartent le
  // destinataire (`invalid_recipient`), comme toute autre clé fautive.
  variables: schemaVariables.optional(),
});

const PRECISIONS = {
  target: 'une cible parmi { "template": { "name", "language" } }, { "scenario": "scn_…" ou un nom }, { "node": "nod_…" } et { "rcsMessage": "<nom d’un message RCS>" }',
} as const;

type Corps = z.infer<typeof schemaCorps>;
type Refus = RefusEnvoi;

/** La cible demandée, après les règles de forme qui dépendent d'elle. Pure : aucune lecture. */
type CibleDemandee =
  | { kind: 'template'; name: string; language: string }
  | { kind: 'scenario'; ref: string; category: CampaignCategory }
  | { kind: 'node'; code: string; category: CampaignCategory }
  | { kind: 'rcsMessage'; nom: string; category: CampaignCategory };

/** La cible résolue : ce qui part en premier, la catégorie qui décide du consentement, ce qu'on écrit. */
interface CibleResolue {
  ouverture: OuvertureApi;
  category: CampaignCategory;
  label: string;
  templateName: string;
  templateLanguage: string;
  workflowId?: string;
  startNodeId?: string;
  /** Cible `rcsMessage` : l'agent qui envoie et le contenu, qui partent dans la campagne RCS. */
  rcs?: { agentId: string; contenu: RcsOutbound };
}

export interface RapportEnvoi {
  sendId: string;
  opening: OuvertureApi;
  recipientCount: number;
  created: number;
  matched: number;
  skipped: Ecart[];
  skippedTotal: number;
}

export function lireCible(corps: Corps, params: TemplateParam[]): CibleDemandee | { message: string } {
  const t = corps.target;
  if ('template' in t) {
    // La catégorie d'un template est lue chez Meta : l'accepter du corps laisserait un appelant la déclarer.
    if (corps.category !== undefined) return { message: 'category : refusé sur un template, sa catégorie est lue chez Meta' };
    return { kind: 'template', name: t.template.name, language: t.template.language };
  }
  if (corps.category === undefined) return { message: 'category : requise sur un scénario, un bloc ou un message RCS (marketing | utility)' };
  if ('scenario' in t) {
    // Un scénario qui ouvre par un template accepte `params`, transmis à son template d'ouverture (`startWorkflow`),
    // comme dans la console ; ouverture et nombre de variables se jugent dans `resoudreCible`. La source « variable »
    // n'y a aucun sens : un scénario ne reçoit pas de variables par destinataire.
    if (params.some((p) => p.source.type === 'variable')) {
      return { message: 'params : la source « variable » n’a de sens que sur un template (un scénario ne reçoit pas de variables par destinataire)' };
    }
    return { kind: 'scenario', ref: t.scenario, category: corps.category };
  }
  // Un bloc démarre sans variables transmises (`startWorkflowFromNode`) : son template les résout par les
  // sources enregistrées dans la console. Des `params` y seraient ignorés en silence, donc refusés.
  if (params.length > 0) {
    return { message: 'params : n’a de sens que sur un template ou un scénario qui ouvre par un template (un bloc résout son template par les sources enregistrées dans la console ; les {{variables}} d’un message RCS viennent de recipients[].variables)' };
  }
  if ('rcsMessage' in t) return { kind: 'rcsMessage', nom: t.rcsMessage, category: corps.category };
  return { kind: 'node', code: t.node, category: corps.category };
}

/**
 * La cible résolue, avec ce qu'elle fait partir en premier. Les gardes de la console s'appliquent (scénario
 * refusé à la création de campagne, template inconnu ou non approuvé) ; une cible `node` est jugée sur ce qui
 * part en premier depuis elle, et le template qu'elle fait partir est lu chez Meta.
 */
async function resoudreCible(deps: DepsEnvoiPublic, tenantId: string, c: CibleDemandee, params: TemplateParam[]): Promise<CibleResolue | Refus> {
  if (c.kind === 'template') {
    const m = await modeleEnvoyable(deps, tenantId, c.name, c.language, params, 'template');
    if ('refus' in m) return m;
    return { ouverture: 'whatsapp_template', category: m.categorie, label: c.name, templateName: c.name, templateLanguage: c.language };
  }
  if (c.kind === 'rcsMessage') {
    const r = await resoudreCibleRcs(deps.rcs, tenantId, c.nom);
    if (!r.ok) return { refus: { statut: r.statut, code: r.code, message: r.message } };
    return {
      ouverture: 'rcs', category: c.category, label: r.nom, templateName: '', templateLanguage: '',
      rcs: { agentId: r.agentId, contenu: r.contenu },
    };
  }
  if (c.kind === 'scenario') {
    const r = await deps.resolveScenario(tenantId, c.ref);
    if (!r.ok && r.reason === 'ambiguous') {
      return { refus: { statut: 409, code: 'scenario_ambiguous', message: 'plusieurs scénarios portent ce nom : désignez-le par son code scn_' } };
    }
    if (!r.ok) return { refus: { statut: 404, code: 'scenario_not_found', message: 'scénario introuvable' } };
    const v = ouvertureApi(r.value.graph);
    if (v.ouverture === null) return { refus: { statut: 422, code: 'unsendable_target', message: `ce scénario ne peut pas partir : ${v.raison}` } };
    if (v.ouverture === 'whatsapp_session') {
      return { refus: { statut: 422, code: 'unsendable_target', message: 'ce scénario ouvre par un message de session (message rapide, question, formulaire ou agent), qui exige que le contact ait écrit dans les 24 h : visez le bloc (cible node) pour écrire à quelqu’un dans sa fenêtre' } };
    }
    if (v.ouverture === 'rcs') {
      if (params.length > 0) {
        return { refus: { statut: 400, code: 'invalid_body', message: 'params : ce scénario ouvre en RCS, il n’a aucun template d’ouverture à paramétrer' } };
      }
      return { ouverture: 'rcs', category: c.category, label: r.value.name, templateName: '', templateLanguage: '', workflowId: r.value.id };
    }
    // Il ouvre par un template : c'est lui que `params` paramètre, lu chez Meta comme la cible template.
    const ouvre = modeleDOuverture(r.value.graph);
    if (!ouvre) return { refus: { statut: 422, code: 'unsendable_target', message: 'le template d’ouverture de ce scénario n’a pas pu être identifié' } };
    const m = await modeleEnvoyable(deps, tenantId, ouvre.templateName, ouvre.language, params, 'template d’ouverture du scénario');
    if ('refus' in m) return m;
    return {
      ouverture: 'whatsapp_template', category: categoriePlusStricte(m.categorie, c.category), label: r.value.name,
      templateName: '', templateLanguage: '', workflowId: r.value.id,
    };
  }
  const r = await deps.resolveNode(tenantId, c.code);
  if (!r.ok) return { refus: { statut: 404, code: 'node_not_found', message: 'bloc introuvable dans les scénarios publiés' } };
  const v = ouvertureApi(r.value.graph, r.value.nodeId);
  if (v.ouverture === null) return { refus: { statut: 422, code: 'unsendable_target', message: `ce bloc ne peut pas partir : ${v.raison}` } };
  /**
   * Un bloc qui fait partir un template est lu chez Meta, comme un scénario : sinon le bloc d'entrée d'un scénario
   * marketing visé en « utility » partirait aux contacts sans consentement. La plus stricte des deux catégories,
   * illisible = refus.
   */
  let category = c.category;
  if (v.ouverture === 'whatsapp_template') {
    const part = modeleDOuverture(r.value.graph, r.value.nodeId);
    if (!part) return { refus: { statut: 422, code: 'unsendable_target', message: 'le template qui part de ce bloc n’a pas pu être identifié' } };
    const m = await modeleEnvoyable(deps, tenantId, part.templateName, part.language, null, 'template du bloc');
    if ('refus' in m) return m;
    category = categoriePlusStricte(m.categorie, c.category);
  }
  return { ouverture: v.ouverture, category, label: r.value.label, templateName: '', templateLanguage: '', workflowId: r.value.workflowId, startNodeId: r.value.nodeId };
}

/**
 * Chaque destinataire résolu en fiche par la fonction partagée, ou écarté avec son motif. `creer` vient de
 * l'ouverture : un template ou un RCS fonde la fiche d'un `phone` inconnu ; une ouverture de session n'a aucune
 * fenêtre chez un inconnu, donc `jamais`. Un inconnu qui ne porte qu'un `bsuid` n'est jamais créé ici.
 */
async function resoudreDestinataires(
  deps: DepsEnvoiPublic, tenantId: string, bruts: unknown[], creer: ModeCreation,
): Promise<{ resolus: DestinataireResolu[]; created: number; matched: number }> {
  const resolus: DestinataireResolu[] = [];
  let created = 0;
  let matched = 0;
  for (const [index, brut] of bruts.entries()) {
    const d = schemaDestinataire.safeParse(brut);
    if (!d.success) { resolus.push({ index, ecart: 'invalid_recipient' }); continue; }
    // `variables` est retiré des clés : `resoudreFiche` ne les voit pas, et elles ne touchent jamais la fiche.
    const { consent, consentSource, variables, ...cles } = d.data;
    const r = await deps.resoudreFiche(tenantId, cles, { creer });
    if (!r.ok) { resolus.push({ index, ecart: r.code }); continue; }
    if (r.cree) created += 1; else matched += 1;
    resolus.push({
      index, contactId: r.contactId,
      ...(consent ? { consent, consentSource: consentSource ?? 'api' } : {}),
      ...(variables ? { variables } : {}),
    });
  }
  return { resolus, created, matched };
}

/** La fenêtre de 24 h par contact, en une requête pour tout le lot, interrogée avec le wa_id (chiffres nus). */
async function fenetresParContact(deps: DepsEnvoiPublic, tenantId: string, contacts: ContactEnvoi[]): Promise<Map<string, boolean>> {
  const waIdParContact = new Map<string, string>();
  for (const c of contacts) {
    const w = waIdOf(c.phone_e164, c.bsuid);
    if (w) waIdParContact.set(c.id, w);
  }
  const parWaId = await deps.inbox.getWindowOpenByWaIds(tenantId, [...new Set(waIdParContact.values())]);
  return new Map([...waIdParContact].map(([id, w]) => [id, parWaId.get(w) === true]));
}

/** Une clé abandonnée (traitement trop long) puis reprise : réessayer rend le rapport de l'appel qui a repris. */
const MESSAGE_CLE_REPRISE = 'un autre appel a repris cette clé d’idempotence et traite l’envoi : réessayez dans un instant pour lire son rapport';

/** Une réponse de l'envoi : son statut et son corps, que la route envoie et que l'outil de Claude traduit. */
export interface ReponseEnvoi { statut: number; corps: unknown }

/** Le compteur de l'adaptateur a refusé l'opération et a déjà produit sa propre réponse. */
export interface CompteurEnvoiRefuse { type: 'compteur_envoi_refuse' }

export type ResultatEnvoiPublic = ReponseEnvoi | CompteurEnvoiRefuse;

export const COMPTEUR_ENVOI_REFUSE: CompteurEnvoiRefuse = { type: 'compteur_envoi_refuse' };

export const compteurEnvoiRefuse = (resultat: ResultatEnvoiPublic): resultat is CompteurEnvoiRefuse =>
  'type' in resultat && resultat.type === 'compteur_envoi_refuse';

/**
 * Ce qu'un adaptateur peut régler sans toucher aux gardes (connecteur Shopify, 2026-10-21). Absentes, le comportement de
 * `POST /v1/sends` et de `send_template_to_contact` est inchangé.
 */
export interface OptionsEnvoiPublic {
  /** Le nom de la ligne dans Campagnes, à la place de `[API] <cible>` (coupé à 120 caractères). */
  nom?: string;
  /**
   * Personne d'envoyable (STOP, sans consentement, limite de contacts) : aucune campagne n'est créée, la clé est libérée
   * et le rapport rendu en 200, `sendId` vide. Sans elle, l'envoi vide est scellé : une campagne à zéro destinataire.
   */
  sansCampagneVide?: true;
  /**
   * Seuls les modèles Service (Utility) partent (les workflows HubSpot, cadrage du 2026-10-27, décision 3) : jugé sur la
   * catégorie que Meta vient de rendre, jamais sur celle de l'appelant. Un autre modèle est refusé en 422
   * `template_rejected` avec sa `categorie`, la clé libérée, rien de créé.
   */
  serviceSeulement?: true;
  /**
   * Des champs à écrire sur la fiche de l'UNIQUE destinataire (l'action de workflow HubSpot depuis une transaction,
   * cadrage `~/mm-hubspot/docs/2026-10-29-action-workflow-transaction-cadrage.md`, décision 7). 🔴 Écrits DANS la
   * transaction qui crée la campagne et scelle la clé : seulement pour un envoi neuf qui garde son destinataire. Un rejeu,
   * un tri vide ou un refus n'écrit rien, sinon la fiche d'un parcours en cours prendrait les valeurs d'un autre appel.
   * Plus d'un destinataire avec cette option : refusé en 400.
   */
  champsFiche?: ChampsFiche;
}

/** La même enveloppe que `refuser` (`{ error, code }`), rendue au lieu d'être envoyée. */
const repondre = (statut: number, code: CodeApi, message: string): ReponseEnvoi => ({ statut, corps: { error: message, code } });

/**
 * Le cycle complet d'un envoi public, partagé par ses quatre adaptateurs (`POST /v1/sends`, l'outil MCP, Shopify et
 * l'action de workflow HubSpot) : validation, compteur,
 * idempotence, cible, gardes du numéro, modèles du mois, destinataires, consentement, campagne scellée avec sa
 * clé et enfilement. Une garde ajoutée ici vaut pour tous les appelants.
 * `compter` est le compteur de l'appelant (le garde d'usage pour la route, le plafond coûteux pour Claude), appelé
 * juste après le claim : `false` = il a déjà répondu, rien n'est créé et la clé est libérée.
 */
export async function lancerEnvoiPublic(
  deps: DepsEnvoiPublic,
  tenantId: string,
  brut: unknown,
  cleEnTete: string | string[] | undefined,
  compter: (unites: number) => Promise<boolean>,
  options: OptionsEnvoiPublic = {},
): Promise<ResultatEnvoiPublic> {

  const lu = schemaCorps.safeParse(brut);
  if (!lu.success) return repondre(400, 'invalid_body', messageDeForme(lu.error, PRECISIONS));
  const corps = lu.data;
  if (options.champsFiche && corps.recipients.length !== 1) {
    return repondre(400, 'invalid_body', 'champsFiche : un seul destinataire attendu');
  }
  // La clé se donne en en-tête ou dans le corps (`idempotencyKey`) : un outil qui appelle une adresse par
  // contact remplit son corps avec les données du contact, pas toujours ses en-têtes.
  const idem = cleIdempotence(cleEnTete, corps);
  if (!idem.ok) return repondre(400, idem.code, idem.message);
  // Même validation que la route console : une source malformée casserait sinon en 500 au lieu d'un 400.
  // La source « variable » est admise ici, et nulle part dans la console.
  const params = validateParamMapping(corps.params ?? [], { accepterVariables: true });
  if (params === null) return repondre(400, 'invalid_body', 'params : positions 1..N contiguës et sources valides attendues');
  const demandee = lireCible(corps, params);
  if ('message' in demandee) return repondre(400, 'invalid_body', demandee.message);
  // Un scénario ou un bloc n'a aucun endroit où ranger des variables par destinataire : refusé avant le
  // compteur d'usage et le claim d'idempotence, sur les destinataires tels que reçus.
  const fautif = destinataireAvecVariablesInterdites(demandee.kind, corps.recipients);
  if (fautif !== null) {
    return repondre(400, 'invalid_body', `recipients.${fautif}.variables : un scénario ou un bloc n’a aucun endroit où ranger des variables par destinataire`);
  }
  // Hors offre (lot 6, B2a) : un scénario ou un bloc ne démarre plus de parcours. Refusé avant le compteur et la clé,
  // comme les variables : sinon l'envoi serait accepté (202), puis chaque destinataire finirait « non démarré ».
  if ((demandee.kind === 'scenario' || demandee.kind === 'node') && !(await deps.offres.offreDe(tenantId)).droits.fonctions.has('scenarios')) {
    return { statut: STATUT_REFUS_OFFRE, corps: corpsRefusFonction('scenarios') };
  }

  // Idempotence : claim atomique avec l'empreinte du corps, avant toute lecture qui peut changer d'un appel à
  // l'autre (numéro, cible, template chez Meta). Autre corps -> 422 ; concurrent -> 409 ; déjà scellé ->
  // rejeu du rapport, tel quel.
  const claim = await deps.idempotence.claim(tenantId, idem.cle, empreinteCorps(brut));
  if (!claim.claimed && 'reused' in claim) {
    return repondre(422, 'idempotency_key_reused', `cette clé d’idempotence a déjà servi pour un autre corps : une clé désigne un seul envoi, et elle vit ${DUREE_CLE_IDEMPOTENCE_MS / 3_600_000} h`);
  }
  if (!claim.claimed && 'pending' in claim) {
    return repondre(409, 'idempotency_in_progress', 'un envoi avec cette clé d’idempotence est en cours : réessayez dans un instant');
  }
  if (!claim.claimed) return { statut: 201, corps: claim.response };
  const { jeton } = claim;
  const poseeLe = Date.now();
  /**
   * Une clé reprise par un autre appel est une ANOMALIE à surveiller : un envoi légitime prend quelques secondes,
   * et il a fallu dépasser le bail pour la perdre. On trace l'espace et le délai, jamais la clé, qu'un outil
   * compose parfois avec les données d'un contact.
   */
  const cleReprise = () => {
    // eslint-disable-next-line no-console
    console.warn(`envoi-public: clé d'idempotence reprise par un autre appel, espace ${tenantId}, ${Math.round((Date.now() - poseeLe) / 1000)} s après sa pose : rien n'est créé`);
    return repondre(409, 'idempotency_in_progress', MESSAGE_CLE_REPRISE);
  };

  /** Un refus après le claim n'a rien créé : la clé est libérée, le même appel repartira une fois corrigé. */
  const libererEtRefuser = async (r: Refus['refus']) => {
    await deps.idempotence.release(tenantId, idem.cle, jeton);
    return repondre(r.statut, r.code, r.message);
  };

  // Rempli + scellé dans le try ; l'enqueue (hors try) le lit après scellement (definite assignment).
  let report!: RapportEnvoi;
  try {
    /**
     * Compté APRÈS le claim : un rejeu (201), un envoi en cours (409) ou une clé déjà servie (422) n'envoie rien, donc
     * ne consomme rien du quota. Et AVANT la résolution de la cible, qui fait déjà des lectures (scénario, bloc,
     * template chez Meta, numéro) : compter après laisserait ce travail hors des compteurs. Le plafond d'appels de
     * l'espace, lui, s'est appliqué à l'authentification. Refusé, rien n'est créé et la clé est libérée.
     * 🔴 DANS LE `try` : le compteur de l'outil MCP ne rend pas `false`, il LÈVE (`RefusOutil`, plafond coûteux ou
     * quota). Hors du `try`, l'exception partait sans libérer, et la même clé restait en 409 pendant tout le bail.
     */
    if (!await compter(corps.recipients.length)) {
      // La réponse (429) est déjà partie : un échec de libération ne lève pas, il se trace (la clé échoira avec son bail).
      await deps.idempotence.release(tenantId, idem.cle, jeton).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`envoi-public: clé d'idempotence non libérée après un refus du compteur, espace ${tenantId}:`, err);
      });
      return COMPTEUR_ENVOI_REFUSE;
    }
    // Un message RCS part de l'agent RCS de l'espace : aucun numéro WhatsApp n'est exigé, et un `phoneNumberId`
    // fourni est ignoré (`numeroDEnvoi` rendrait sinon 409 `no_whatsapp_number` à un espace qui n'a que le RCS).
    const numero = demandee.kind === 'rcsMessage' ? { phoneNumberId: '' } : await numeroDEnvoi(deps, tenantId, corps.phoneNumberId);
    if ('refus' in numero) return await libererEtRefuser(numero.refus);
    const cible = await resoudreCible(deps, tenantId, demandee, params);
    if ('refus' in cible) return await libererEtRefuser(cible.refus);
    if (options.serviceSeulement && cible.category !== 'utility') {
      await deps.idempotence.release(tenantId, idem.cle, jeton);
      return {
        statut: 422,
        corps: { error: 'seuls les modèles Service (Utility) partent par ce chemin', code: 'template_rejected', categorie: cible.category },
      };
    }
    /**
     * Numéro délié : refusé ici en 409 `number_unlinked`, comme `POST /v1/messages/whatsapp` ; sinon l'envoi serait
     * accepté en 201 et ses messages partiraient au premier « Relier ». Seulement quand ce qui part en premier est
     * WhatsApp : une cible qui ouvre en RCS ne demande rien au numéro, et son repli WhatsApp bute plus tard sur la
     * garde.
     */
    if (cible.ouverture !== 'rcs' && await deps.numerosDelies.estDelie(numero.phoneNumberId)) {
      return await libererEtRefuser({ statut: 409, code: 'number_unlinked', message: MESSAGE_NUMERO_DELIE });
    }
    if (cible.ouverture !== 'rcs' && await deps.numerosSuspendus.estSuspendu(numero.phoneNumberId)) {
      return await libererEtRefuser({ statut: 409, code: 'number_suspended', message: MESSAGE_NUMERO_SUSPENDU });
    }
    /**
     * Les modèles du mois (lot 6), lus UNE fois, seulement quand l'envoi ouvre par un modèle WhatsApp (un template, ou un
     * scénario qui commence par un template). 🔴 Épuisés : refusé AVANT de résoudre les destinataires, qui créerait les
     * fiches inconnues (et entamerait la limite de contacts) pour un envoi qui ne partira pas (relecture finale du lot 6).
     */
    const etatDuMois = cible.ouverture === 'whatsapp_template' ? await deps.modelesDuMois.etatDuMois(tenantId) : null;
    const refuserLeMois = async (etat: { max: number; reste: number }, demandes: number) => {
      await deps.idempotence.release(tenantId, idem.cle, jeton);
      const refus = corpsRefusLimite(new LimiteOffreError(tenantId, 'envoisModelesMois', etat.max));
      return { statut: STATUT_REFUS_OFFRE, corps: { ...refus, reste: etat.reste, demandes } };
    };
    if (etatDuMois !== null && etatDuMois.reste === 0) return await refuserLeMois(etatDuMois, corps.recipients.length);
    const { resolus, created, matched } = await resoudreDestinataires(
      deps, tenantId, corps.recipients, cible.ouverture === 'whatsapp_session' ? 'jamais' : 'phone',
    );
    const uniques = marquerDoublons(resolus);
    /**
     * 🔴 Le consentement s'écrit avant la lecture des fiches, donc avant le tri marketing : un outil où vit le
     * consentement envoie sans pousser chaque fiche au préalable ; la fiche relue dit ce qui a été enregistré. Il
     * se lit sur toutes les occurrences, doublons compris, et s'écrit une fois par fiche : un refus l'emporte sur un
     * accord (sinon un `opted_out` porté par un doublon serait perdu et la personne recevrait le message).
     */
    const consentements = new Map<string, { consent: 'opted_in' | 'opted_out'; source: string }>();
    for (const r of resolus) {
      if (!('contactId' in r) || !r.consent) continue;
      const deja = consentements.get(r.contactId);
      if (!deja || (deja.consent === 'opted_in' && r.consent === 'opted_out')) {
        consentements.set(r.contactId, { consent: r.consent, source: r.consentSource ?? 'api' });
      }
    }
    for (const [contactId, c] of consentements) await deps.appliquerConsentement(tenantId, contactId, c.consent, c.source);
    const contacts = await deps.repo.listContactsPourEnvoiApi(tenantId, uniques.flatMap((r) => ('contactId' in r ? [r.contactId] : [])));
    const fenetre = cible.ouverture === 'whatsapp_session' ? await fenetresParContact(deps, tenantId, contacts) : undefined;
    const tri = trierDestinataires({
      category: cible.category, ouverture: cible.ouverture, resolus: uniques, contacts,
      ...(fenetre ? { fenetreOuverteParContact: fenetre } : {}),
    });
    const { recipients, ecarts } = construireDestinataires(cible.category, params, tri, new Date(), cible.rcs ? 'rcs' : 'whatsapp');
    // Le refus exact, sur les destinataires réels (doublons et écarts retirés) : refusé en entier, avant toute campagne,
    // et la clé rendue : le même appel repartira le mois prochain ou après le passage en Pro.
    if (etatDuMois !== null && recipients.length > etatDuMois.reste) return await refuserLeMois(etatDuMois, recipients.length);
    report = {
      sendId: '',
      opening: cible.ouverture,
      recipientCount: recipients.length,
      created,
      matched,
      skipped: ecarts.slice(0, MAX_SKIPPED_REPORT),
      skippedTotal: ecarts.length,
    };
    if (options.sansCampagneVide && recipients.length === 0) {
      await deps.idempotence.release(tenantId, idem.cle, jeton);
      return { statut: 200, corps: report };
    }
    /**
     * 🔴 Juste avant le geste irréversible : la clé est-elle encore à nous ? Un traitement qui a dépassé
     * `DUREE_CLE_EN_COURS_MAX_MS` a pu la voir abandonnée et reprise par un autre appel, qui enverra : on
     * s'arrête sans créer de campagne, et sans libérer la clé, qui n'est plus la nôtre.
     */
    if (!await deps.idempotence.possede(tenantId, idem.cle, jeton)) return cleReprise();
    /**
     * 🔴 Créée ET scellée dans la MÊME transaction. Scellée avant l'enqueue : sinon un échec de `complete` après
     * un enqueue réussi libérerait la clé, et un retry recréerait une campagne, donc renverrait les messages en
     * double. Et scellée DANS la création : en deux temps, une copie tuée entre les deux laissait une campagne
     * sans clé qui la désigne, un brouillon lançable depuis la console. Clé reprise entre la garde et ici
     * (`complete` rend faux) -> la création est annulée, rien n'existe, l'appel qui a repris la clé enverra.
     * Échec en cours de route -> rollback, release + throw (retry propre).
     */
    const send = await deps.repo.createWithRecipientsSiConfirme(
      {
        // Le préfixe est `PREFIXE_ENVOI_API`, que le suivi relit (`nomDuMessageRcs`). Le nom d'un envoi RCS n'est pas
        // coupé : le suivi y relit le nom du message (jusqu'à 120 caractères). Les autres cibles gardent leur coupe.
        tenantId, phoneNumberId: numero.phoneNumberId, category: cible.category,
        name: options.nom !== undefined ? options.nom.slice(0, 120)
          : cible.rcs ? `${PREFIXE_ENVOI_API}${cible.label}` : `${PREFIXE_ENVOI_API}${cible.label}`.slice(0, 120),
        templateName: cible.templateName, templateLanguage: cible.templateLanguage, paramMapping: params,
        ...(cible.workflowId ? { workflowId: cible.workflowId } : {}),
        ...(cible.startNodeId ? { startNodeId: cible.startNodeId } : {}),
        ...(cible.rcs ? { channel: 'rcs' as const, rcsAgentId: cible.rcs.agentId, rcsMessage: cible.rcs.contenu } : {}),
      },
      recipients,
      async (tx, campaignId) => {
        report.sendId = campaignId;
        // Par le même `tx` : annulés avec la campagne si la clé n'est plus à nous (`complete` rend faux).
        const seul = recipients.length === 1 ? recipients[0] : undefined;
        if (options.champsFiche && seul) await deps.repo.ecrireChampsFiche(tx, tenantId, seul.contactId, options.champsFiche);
        return deps.idempotence.complete(tenantId, idem.cle, jeton, campaignId, report, tx);
      },
    );
    // La clé a été reprise : rien n'a été créé, et elle n'est plus la nôtre, donc rien à libérer.
    if (send === null) return cleReprise();
  } catch (err) {
    await deps.idempotence.release(tenantId, idem.cle, jeton);
    throw err;
  }

  // Idempotence scellée, définitivement : plus aucun release ci-dessous. On retente l'enfilement (hoquet
  // transitoire de la file) ; échec persistant -> 201 et log fort : sous-envoi assumé, jamais de sur-envoi. Le
  // retry est sûr grâce au claim atomique par destinataire, pas à la file (qui ne déduplique rien) : un second
  // run n'enverrait rien deux fois, mais additionnerait son débit. Borné à 3 tentatives.
  const sleep = deps.sleep ?? ((ms: number) => dormir(ms));
  for (let attempt = 0; attempt < ENQUEUE_MAX_ATTEMPTS; attempt += 1) {
    try {
      await deps.enqueue(report.sendId, tenantId, report.recipientCount, corps.ratePerMinute ?? null);
      break;
    } catch (err) {
      const last = attempt === ENQUEUE_MAX_ATTEMPTS - 1;
      // eslint-disable-next-line no-console
      console.error(
        last
          ? `envoi-public: enqueue échoué ${ENQUEUE_MAX_ATTEMPTS} fois après scellement idempotence (campagne NON lancée, à ré-enfiler à la main):`
          : `envoi-public: enqueue échoué (tentative ${attempt + 1}/${ENQUEUE_MAX_ATTEMPTS}), nouvelle tentative:`,
        report.sendId,
        messageDe(err),
      );
      if (last) break;
      await sleep(ENQUEUE_RETRY_DELAYS_MS[attempt] ?? 300);
    }
  }
  return { statut: 201, corps: report };
}
