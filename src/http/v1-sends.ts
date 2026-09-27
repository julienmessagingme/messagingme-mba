import { setTimeout as dormir } from 'node:timers/promises';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { waIdOf } from '../crm/identity';
import type { BuiltRecipient, ContactEnvoi } from '../campaign/build';
import type { CampaignCategory } from '../campaign/types';
import type { EnvoiApiBrut } from '../campaign/store.pg';
import { validateParamMapping, type TemplateParam } from '../crm/template';
import type { ResolveResult } from '../ids/resolve';
import type { WorkflowGraph } from '../workflow/graph';
import { modeleDOuverture, ouvertureApi, type OuvertureApi } from '../workflow/ouverture-api';
import type { IdempotencyClaim } from '../api/idempotency-store.pg';
import { cleIdempotence, DUREE_CLE_IDEMPOTENCE_MS, empreinteCorps } from '../api/idempotence';
import { compterOuRefuser, type ApiUsageGuard } from '../api/usage-guard';
import { refuser, type CodeApi } from '../api/erreurs';
import { schemaClesFiche, videEnAbsent, type ClesFiche, type ModeCreation, type ResolutionFiche } from '../api/fiche';
import type { IssueConsentement } from '../api/consentement';
import { MAX_OPT_IN_SOURCE } from '../api/contacts-upsert';
import { construireDestinataires, marquerDoublons, trierDestinataires, type DestinataireResolu, type Ecart } from '../api/sends-build';
import type { LectureModele } from '../api/modele-envoi';
import { messageDeForme } from '../api/forme';
import { formaterSuiviEnvoi } from '../api/suivi-envoi';
import type { RcsOutbound } from '../rcs/types';
import { PREFIXE_ENVOI_API, resoudreCibleRcs, schemaCibleRcs, type DepsCibleRcs } from '../api/cible-rcs';
import { destinataireAvecVariablesInterdites, schemaVariables } from '../api/variables';
import { MESSAGE_NUMERO_DELIE } from '../meta/numero-delie';
import { messageDe } from '../lib/erreur';

export interface V1SendCreateInput {
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

export interface V1SendsRouteDeps {
  /**
   * Le garde d'usage. Requis : optionnel, il manquerait un jour à une route et son compteur disparaîtrait sans bruit.
   */
  usage: ApiUsageGuard;
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
    createWithRecipients(input: V1SendCreateInput, recipients: BuiltRecipient[]): Promise<{ campaignId: string; recipientCount: number }>;
    /** L'envoi tel que `GET /v1/sends/{sendId}` le décrit, avant mise en forme. */
    lireEnvoiApi(sendId: string, tenantId: string): Promise<EnvoiApiBrut | null>;
  };
  /**
   * Le numéro est-il délié de son espace ? La garde du point de passage des envois, dont « Délier » et « Relier »
   * vident le cache. Requise : sans elle, un envoi sur un numéro délié serait accepté en 201 et partirait au
   * premier « Relier », parfois des jours plus tard.
   */
  numerosDelies: { estDelie(phoneNumberId: string): Promise<boolean> };
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
  /** Le magasin d'idempotence. */
  idempotence: {
    /** `empreinte` = `empreinteCorps(corps)` : la même clé avec un autre corps rend `reused`. */
    claim(tenantId: string, key: string, empreinte: string): Promise<IdempotencyClaim>;
    complete(tenantId: string, key: string, sendId: string, response: unknown): Promise<void>;
    release(tenantId: string, key: string): Promise<void>;
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
type Refus = { refus: { statut: 400 | 404 | 409 | 422; code: CodeApi; message: string } };

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
 * Un template qui va partir, lu chez Meta : sa catégorie, ce qui l'empêcherait de partir, et le nombre de
 * variables de son corps. Sert la cible `template` et le template d'ouverture d'un scénario ou d'un bloc.
 * Le nombre de variables se vérifie avant l'envoi : sinon Meta refuserait chaque destinataire après un 201.
 * `params` à `null` = un bloc, dont le template résout ses variables par les sources de la console : rien à
 * comparer. `non_envoyable` est jugé par la fonction du catalogue (`raisonNonEnvoyable`). `illisible` n'est
 * jamais ramené à « utility ».
 */
async function modeleEnvoyable(
  deps: V1SendsRouteDeps, tenantId: string, name: string, language: string, params: TemplateParam[] | null, quoi: string,
): Promise<{ categorie: CampaignCategory } | Refus> {
  const lu = await deps.lireModele(tenantId, name, language);
  if (lu.statut === 'absent') {
    return { refus: { statut: 404, code: 'template_not_found', message: `${quoi} introuvable, non approuvé ou d’une autre langue : ${name} (${language})` } };
  }
  if (lu.statut === 'illisible') {
    return { refus: { statut: 422, code: 'template_category_unknown', message: `la catégorie de ce ${quoi} n’a pas pu être lue chez Meta : l’envoi est refusé par prudence, réessayez dans un instant` } };
  }
  if (lu.statut === 'categorie_non_admise') {
    // Lue, et définitive : réessayer n'y changera rien, le message ne doit pas le suggérer.
    return { refus: { statut: 422, code: 'template_category_unknown', message: `catégorie ${lu.categorie.slice(0, 40)} non envoyable par l’API : un template marketing ou utility est attendu` } };
  }
  if (lu.statut === 'non_envoyable') {
    return { refus: { statut: 422, code: 'unsendable_target', message: `le ${quoi} ${name} ne peut partir par aucun envoi : ${lu.raison}. Il n’apparaît pas dans GET /v1/templates` } };
  }
  if (params !== null && params.length !== lu.variables) {
    return { refus: { statut: 422, code: 'unsendable_target', message: `le ${quoi} ${name} attend ${lu.variables} variable(s) dans son corps et params en décrit ${params.length} : Meta refuserait chaque message` } };
  }
  return { categorie: lu.categorie };
}

/**
 * 🔴 La catégorie ne se relâche jamais : celle que Meta donne au template qui part l'emporte sur une déclaration
 * plus permissive (un marketing annoncé « utility » partirait sinon aux contacts sans consentement). Une
 * déclaration plus stricte est gardée.
 */
function categoriePlusStricte(lue: CampaignCategory, declaree: CampaignCategory): CampaignCategory {
  return lue === 'marketing' || declaree === 'marketing' ? 'marketing' : 'utility';
}

async function numeroDEnvoi(deps: V1SendsRouteDeps, tenantId: string, demande: string | undefined): Promise<{ phoneNumberId: string } | Refus> {
  if (demande !== undefined) {
    return await deps.repo.phoneNumberBelongsToTenant(demande, tenantId)
      ? { phoneNumberId: demande }
      : { refus: { statut: 400, code: 'invalid_body', message: 'phoneNumberId : numéro inconnu de cet espace' } };
  }
  const defaut = await deps.repo.getTenantPhoneNumberId(tenantId);
  return defaut
    ? { phoneNumberId: defaut }
    : { refus: { statut: 409, code: 'no_whatsapp_number', message: 'aucun numéro WhatsApp connecté sur cet espace' } };
}

/**
 * La cible résolue, avec ce qu'elle fait partir en premier. Les gardes de la console s'appliquent (scénario
 * refusé à la création de campagne, template inconnu ou non approuvé) ; une cible `node` est jugée sur ce qui
 * part en premier depuis elle, et le template qu'elle fait partir est lu chez Meta.
 */
async function resoudreCible(deps: V1SendsRouteDeps, tenantId: string, c: CibleDemandee, params: TemplateParam[]): Promise<CibleResolue | Refus> {
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
  deps: V1SendsRouteDeps, tenantId: string, bruts: unknown[], creer: ModeCreation,
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
async function fenetresParContact(deps: V1SendsRouteDeps, tenantId: string, contacts: ContactEnvoi[]): Promise<Map<string, boolean>> {
  const waIdParContact = new Map<string, string>();
  for (const c of contacts) {
    const w = waIdOf(c.phone_e164, c.bsuid);
    if (w) waIdParContact.set(c.id, w);
  }
  const parWaId = await deps.inbox.getWindowOpenByWaIds(tenantId, [...new Set(waIdParContact.values())]);
  return new Map([...waIdParContact].map(([id, w]) => [id, parWaId.get(w) === true]));
}

const FORME_ID_ENVOI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const schemaIdEnvoi = z.object({ sendId: z.string().regex(FORME_ID_ENVOI) });


/**
 * API publique /v1 des envois. L'espace vient de la clé (`req.auth`), jamais du corps. Garde attendue :
 * `[makeRequireApiKey, requireScope('sends:create')]`.
 * 🔴 L'ordre compte : la forme, le compteur d'usage, le claim d'idempotence, puis le numéro et la cible (des
 * lectures), et seulement alors ce qui écrit (fiches, consentements, campagne). Le claim passe avant les
 * lectures : un rejeu rend le rapport scellé même si le template a changé depuis. Un refus ou une erreur après
 * le claim libère la clé.
 */
export function registerV1Sends(app: FastifyInstance, deps: V1SendsRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.post('/v1/sends', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    const tenantId = req.auth.tenantId;

    const lu = schemaCorps.safeParse(req.body);
    if (!lu.success) return refuser(reply, 400, 'invalid_body', messageDeForme(lu.error, PRECISIONS));
    const corps = lu.data;
    // La clé se donne en en-tête ou dans le corps (`idempotencyKey`) : un outil qui appelle une adresse par
    // contact remplit son corps avec les données du contact, pas toujours ses en-têtes.
    const idem = cleIdempotence(req.headers['idempotency-key'], corps);
    if (!idem.ok) return refuser(reply, 400, idem.code, idem.message);
    // Même validation que la route console : une source malformée casserait sinon en 500 au lieu d'un 400.
    // La source « variable » est admise ici, et nulle part dans la console.
    const params = validateParamMapping(corps.params ?? [], { accepterVariables: true });
    if (params === null) return refuser(reply, 400, 'invalid_body', 'params : positions 1..N contiguës et sources valides attendues');
    const demandee = lireCible(corps, params);
    if ('message' in demandee) return refuser(reply, 400, 'invalid_body', demandee.message);
    // Un scénario ou un bloc n'a aucun endroit où ranger des variables par destinataire : refusé avant le
    // compteur d'usage et le claim d'idempotence, sur les destinataires tels que reçus.
    const fautif = destinataireAvecVariablesInterdites(demandee.kind, corps.recipients);
    if (fautif !== null) {
      return refuser(reply, 400, 'invalid_body', `recipients.${fautif}.variables : un scénario ou un bloc n’a aucun endroit où ranger des variables par destinataire`);
    }

    /**
     * Compté avant la résolution de la cible, qui fait déjà des lectures (scénario, bloc, template chez Meta,
     * numéro) : compter après laisserait ce travail hors des compteurs.
     */
    if (!await compterOuRefuser(deps.usage, req, reply, 'sends.create', corps.recipients.length)) return reply;

    // Idempotence : claim atomique avec l'empreinte du corps, avant toute lecture qui peut changer d'un appel à
    // l'autre (numéro, cible, template chez Meta). Autre corps -> 422 ; concurrent -> 409 ; déjà scellé ->
    // rejeu du rapport, tel quel.
    const claim = await deps.idempotence.claim(tenantId, idem.cle, empreinteCorps(req.body));
    if (!claim.claimed && 'reused' in claim) {
      return refuser(reply, 422, 'idempotency_key_reused', `cette clé d’idempotence a déjà servi pour un autre corps : une clé désigne un seul envoi, et elle vit ${DUREE_CLE_IDEMPOTENCE_MS / 3_600_000} h`);
    }
    if (!claim.claimed && 'pending' in claim) {
      return refuser(reply, 409, 'idempotency_in_progress', 'un envoi avec cette clé d’idempotence est en cours : réessayez dans un instant');
    }
    if (!claim.claimed) return reply.code(201).send(claim.response);

    /** Un refus après le claim n'a rien créé : la clé est libérée, le même appel repartira une fois corrigé. */
    const libererEtRefuser = async (r: Refus['refus']) => {
      await deps.idempotence.release(tenantId, idem.cle);
      return refuser(reply, r.statut, r.code, r.message);
    };

    // Rempli + scellé dans le try ; l'enqueue (hors try) le lit après scellement (definite assignment).
    let report!: RapportEnvoi;
    try {
      // Un message RCS part de l'agent RCS de l'espace : aucun numéro WhatsApp n'est exigé, et un `phoneNumberId`
      // fourni est ignoré (`numeroDEnvoi` rendrait sinon 409 `no_whatsapp_number` à un espace qui n'a que le RCS).
      const numero = demandee.kind === 'rcsMessage' ? { phoneNumberId: '' } : await numeroDEnvoi(deps, tenantId, corps.phoneNumberId);
      if ('refus' in numero) return await libererEtRefuser(numero.refus);
      const cible = await resoudreCible(deps, tenantId, demandee, params);
      if ('refus' in cible) return await libererEtRefuser(cible.refus);
      /**
       * Numéro délié : refusé ici en 409 `number_unlinked`, comme `POST /v1/messages/whatsapp` ; sinon l'envoi serait
       * accepté en 201 et ses messages partiraient au premier « Relier ». Seulement quand ce qui part en premier est
       * WhatsApp : une cible qui ouvre en RCS ne demande rien au numéro, et son repli WhatsApp bute plus tard sur la
       * garde.
       */
      if (cible.ouverture !== 'rcs' && await deps.numerosDelies.estDelie(numero.phoneNumberId)) {
        return await libererEtRefuser({ statut: 409, code: 'number_unlinked', message: MESSAGE_NUMERO_DELIE });
      }
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
      report = {
        sendId: '',
        opening: cible.ouverture,
        recipientCount: recipients.length,
        created,
        matched,
        skipped: ecarts.slice(0, MAX_SKIPPED_REPORT),
        skippedTotal: ecarts.length,
      };
      const send = await deps.repo.createWithRecipients(
        {
          // Le préfixe est `PREFIXE_ENVOI_API`, que le suivi relit (`nomDuMessageRcs`). Le nom d'un envoi RCS n'est pas
          // coupé : le suivi y relit le nom du message (jusqu'à 120 caractères). Les autres cibles gardent leur coupe.
          tenantId, phoneNumberId: numero.phoneNumberId, category: cible.category,
          name: cible.rcs ? `${PREFIXE_ENVOI_API}${cible.label}` : `${PREFIXE_ENVOI_API}${cible.label}`.slice(0, 120),
          templateName: cible.templateName, templateLanguage: cible.templateLanguage, paramMapping: params,
          ...(cible.workflowId ? { workflowId: cible.workflowId } : {}),
          ...(cible.startNodeId ? { startNodeId: cible.startNodeId } : {}),
          ...(cible.rcs ? { channel: 'rcs' as const, rcsAgentId: cible.rcs.agentId, rcsMessage: cible.rcs.contenu } : {}),
        },
        recipients,
      );
      report.sendId = send.campaignId;
      // 🔴 Scelle l'idempotence avant l'enqueue : sinon un échec de `complete` après un enqueue réussi libérerait la
      // clé, et un retry recréerait une campagne, donc renverrait les messages en double. Échec avant scellement ->
      // release + throw (retry propre).
      await deps.idempotence.complete(tenantId, idem.cle, send.campaignId, report);
    } catch (err) {
      await deps.idempotence.release(tenantId, idem.cle);
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
            ? `v1/sends: enqueue échoué ${ENQUEUE_MAX_ATTEMPTS} fois après scellement idempotence (campagne NON lancée, à ré-enfiler à la main):`
            : `v1/sends: enqueue échoué (tentative ${attempt + 1}/${ENQUEUE_MAX_ATTEMPTS}), nouvelle tentative:`,
          report.sendId,
          messageDe(err),
        );
        if (last) break;
        await sleep(ENQUEUE_RETRY_DELAYS_MS[attempt] ?? 300);
      }
    }
    return reply.code(201).send(report);
  });

  app.get('/v1/sends/:sendId', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    // Une lecture compte aussi, pour une unité, et avant le contrôle de forme : un intégrateur qui sonde
    // l'avancement toutes les secondes est exactement l'usage qu'on veut voir.
    if (!await compterOuRefuser(deps.usage, req, reply, 'sends.read')) return reply;
    // Un identifiant qui n'est pas un uuid ferait lever Postgres (22P02), donc un 500 : il est inconnu, 404.
    const p = schemaIdEnvoi.safeParse(req.params);
    if (!p.success) return refuser(reply, 404, 'send_not_found', 'envoi inconnu');
    const brut = await deps.repo.lireEnvoiApi(p.data.sendId, req.auth.tenantId);
    if (!brut) return refuser(reply, 404, 'send_not_found', 'envoi inconnu');
    return reply.code(200).send(formaterSuiviEnvoi(brut));
  });
}
