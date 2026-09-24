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
import { ouvertureApi, type OuvertureApi } from '../workflow/ouverture-api';
import type { IdempotencyClaim } from '../api/idempotency-store.pg';
import { cleIdempotence, empreinteCorps } from '../api/idempotence';
import { compterOuRefuser, type ApiUsageGuard } from '../api/usage-guard';
import { refuser, type CodeApi } from '../api/erreurs';
import { schemaClesFiche, videEnAbsent, type ClesFiche, type ModeCreation, type ResolutionFiche } from '../api/fiche';
import type { IssueConsentement } from '../api/consentement';
import { MAX_OPT_IN_SOURCE } from '../api/contacts-upsert';
import { construireDestinataires, marquerDoublons, trierDestinataires, type DestinataireResolu, type Ecart } from '../api/sends-build';
import type { LectureModele } from '../api/modele-envoi';
import { messageDeForme } from '../api/forme';
import { formaterSuiviEnvoi } from '../api/suivi-envoi';

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
}

export interface V1SendsRouteDeps {
  /**
   * Le garde d'usage, injecté au bootstrap. OBLIGATOIRE, comme sur `/v1/contacts` : optionnel, il
   * manquerait un jour à une route et le compteur de cette route disparaîtrait sans bruit.
   */
  usage: ApiUsageGuard;
  /** Scénario par code `scn_` ou par nom, AVEC son graphe PUBLIÉ : c'est lui que `ouvertureApi` juge. */
  resolveScenario(tenantId: string, ref: string): Promise<ResolveResult<{ id: string; name: string; graph: WorkflowGraph }>>;
  /** Bloc par code `nod_`, dans les graphes PUBLIÉS, avec le graphe d'où juger ce qui part depuis lui. */
  resolveNode(tenantId: string, code: string): Promise<ResolveResult<{ workflowId: string; nodeId: string; label: string; graph: WorkflowGraph }>>;
  /** Le template lu chez Meta : sa catégorie, ou pourquoi il ne peut pas partir (`verdictModele`). */
  lireModele(tenantId: string, name: string, language: string): Promise<LectureModele>;
  /** Fenêtre de service 24 h par wa_id. Absent de la map = fermée. Lue pour une ouverture de session seulement. */
  getWindowOpenByWaIds(tenantId: string, waIds: string[]): Promise<Map<string, boolean>>;
  getTenantPhoneNumberId(tenantId: string): Promise<string | null>;
  phoneNumberBelongsToTenant(phoneNumberId: string, tenantId: string): Promise<boolean>;
  /** La résolution de fiche du lot 1 (`resoudreFiche`), liée à ses dépendances par le câblage. */
  resoudreFiche(tenantId: string, cles: ClesFiche, opts: { creer: ModeCreation }): Promise<ResolutionFiche>;
  /**
   * L'écriture du consentement du lot 1 (`appliquerConsentement`), liée à ses dépendances par le câblage.
   * Son issue n'a PAS à être lue ici : un `opted_in` sur une fiche désabonnée est `refuse` (un STOP ne se lève
   * pas par machine), la fiche reste `opted_out` et le tri l'écarte ; une fiche purgée entre-temps (`absente`)
   * n'est plus lue, et le tri la dit `unknown_contact`.
   */
  appliquerConsentement(tenantId: string, contactId: string, consent: 'opted_in' | 'opted_out', source: string): Promise<IssueConsentement>;
  /** Les fiches désignées, BLOQUÉES COMPRISES (`listContactsPourEnvoiApi`). */
  listContactsPourEnvoi(tenantId: string, ids: string[]): Promise<ContactEnvoi[]>;
  createSend(input: V1SendCreateInput, recipients: BuiltRecipient[]): Promise<{ campaignId: string; recipientCount: number }>;
  /** `tenantId` porte le GROUPE de la file (lot 5) : la concurrence des runs est plafonnée par espace. */
  enqueue(campaignId: string, tenantId: string, pendingCount: number, ratePerMinute: number | null): Promise<void>;
  /** `empreinte` = `empreinteCorps(corps)` : la même clé avec un autre corps rend `reused`. */
  idempotencyClaim(tenantId: string, key: string, empreinte: string): Promise<IdempotencyClaim>;
  idempotencyComplete(tenantId: string, key: string, sendId: string, response: unknown): Promise<void>;
  idempotencyRelease(tenantId: string, key: string): Promise<void>;
  /** L'envoi tel que `GET /v1/sends/{sendId}` le décrit, avant mise en forme (`lireEnvoiApi`). */
  lireEnvoi(sendId: string, tenantId: string): Promise<EnvoiApiBrut | null>;
  /** Attente entre deux tentatives d'enqueue. Injectable pour tester le retry sans temporisation réelle. */
  sleep?(ms: number): Promise<void>;
}

const MAX_RECIPIENTS = 50;
const MAX_SKIPPED_REPORT = 200;
/** Retry borné de l'enqueue : 3 tentatives, backoff court entre chacune. Cf. la note au call site sur ce qui
 *  rend ce retry sûr (ce n'est PAS une déduplication de file). */
const ENQUEUE_MAX_ATTEMPTS = 3;
const ENQUEUE_RETRY_DELAYS_MS = [100, 300];

/**
 * LES TROIS CIBLES DE CE LOT. Strictes : un objet qui porterait deux cibles, ou une clé mal orthographiée, est
 * refusé plutôt que lu à moitié. Le lot 3 ajoute `rcsMessage` à cette union.
 */
const schemaCible = z.union([
  z.strictObject({ template: z.strictObject({ name: z.string().trim().min(1).max(512), language: z.string().trim().min(1).max(20) }) }),
  z.strictObject({ scenario: z.string().trim().min(1).max(200) }),
  z.strictObject({ node: z.string().trim().min(1).max(200) }),
]);

/**
 * LE CORPS. STRICT au premier niveau : c'est une enveloppe que NOUS définissons, une clé mal orthographiée
 * (`ratePerMinutes`) ne doit pas changer le comportement en silence, et une clé disparue (`createMissing`)
 * doit se voir. `recipients` reste en `unknown[]` : un destinataire mal formé est ÉCARTÉ, il ne fait pas
 * tomber l'envoi.
 */
const schemaCorps = z.strictObject({
  idempotencyKey: z.string().optional(),
  target: schemaCible,
  recipients: z.array(z.unknown()).min(1).max(MAX_RECIPIENTS),
  params: z.array(z.unknown()).optional(),
  // Vide = absence, comme pour les destinataires (`videEnAbsent`) : un outil qui remplit son corps avec des
  // variables envoie `""` pour celles qu'il n'a pas. Un `phoneNumberId` vide prend le numéro par défaut, comme
  // l'ancienne route ; une `category` vide est absente (ignorée sur un template, « requise » ailleurs).
  category: z.preprocess(videEnAbsent, z.enum(['marketing', 'utility']).optional()),
  ratePerMinute: z.number().int().min(1).max(80).optional(),
  phoneNumberId: z.preprocess(videEnAbsent, z.string().trim().min(1).max(64).optional()),
});

/**
 * UN DESTINATAIRE : les clés de fiche du lot 1, plus son consentement. Ses clés inconnues sont ÉCARTÉES, pas
 * refusées, comme sur `/v1/contacts` : l'outil de l'appelant peut y laisser des données de son propre profil.
 *
 * ⚠️ Un `consent` ou un `consentSource` VIDE vaut absence, comme sur `/v1/contacts` (`videEnAbsent`) : un outil
 * qui remplit son corps avec les variables d'un profil envoie `""` pour une variable que le profil n'a pas.
 * Une valeur fausse (« oui ») reste refusée, donc le destinataire est écarté `invalid_recipient`.
 */
const schemaDestinataire = schemaClesFiche.extend({
  consent: z.preprocess(videEnAbsent, z.enum(['opted_in', 'opted_out']).optional()),
  consentSource: z.preprocess(videEnAbsent, z.string().trim().min(1).max(MAX_OPT_IN_SOURCE).optional()),
});

const PRECISIONS = {
  target: 'une cible parmi { "template": { "name", "language" } }, { "scenario": "scn_…" ou un nom } et { "node": "nod_…" }',
} as const;

type Corps = z.infer<typeof schemaCorps>;
type Refus = { refus: { statut: 400 | 404 | 409 | 422; code: CodeApi; message: string } };

/** La cible demandée, après les règles de forme qui dépendent d'elle. Pure : aucune lecture. */
type CibleDemandee =
  | { kind: 'template'; name: string; language: string }
  | { kind: 'scenario'; ref: string; category: CampaignCategory }
  | { kind: 'node'; code: string; category: CampaignCategory };

/** La cible résolue : ce qui part en premier, la catégorie qui décide du consentement, ce qu'on écrit. */
interface CibleResolue {
  ouverture: OuvertureApi;
  category: CampaignCategory;
  label: string;
  templateName: string;
  templateLanguage: string;
  workflowId?: string;
  startNodeId?: string;
}

interface RapportEnvoi {
  sendId: string;
  opening: OuvertureApi;
  recipientCount: number;
  created: number;
  matched: number;
  skipped: Ecart[];
  skippedTotal: number;
}

function lireCible(corps: Corps, params: TemplateParam[]): CibleDemandee | { message: string } {
  const t = corps.target;
  if ('template' in t) {
    // La catégorie d'un template est LUE CHEZ META : l'accepter du corps laisserait un appelant la déclarer.
    if (corps.category !== undefined) return { message: 'category : refusé sur un template, sa catégorie est lue chez Meta' };
    return { kind: 'template', name: t.template.name, language: t.template.language };
  }
  if (corps.category === undefined) return { message: 'category : requise sur un scénario ou un bloc (marketing | utility)' };
  if (params.length > 0) return { message: 'params : n’a de sens que sur un template (aucune variable n’est envoyée à un scénario ou à un bloc)' };
  return 'scenario' in t
    ? { kind: 'scenario', ref: t.scenario, category: corps.category }
    : { kind: 'node', code: t.node, category: corps.category };
}

async function numeroDEnvoi(deps: V1SendsRouteDeps, tenantId: string, demande: string | undefined): Promise<{ phoneNumberId: string } | Refus> {
  if (demande !== undefined) {
    return await deps.phoneNumberBelongsToTenant(demande, tenantId)
      ? { phoneNumberId: demande }
      : { refus: { statut: 400, code: 'invalid_body', message: 'phoneNumberId : numéro inconnu de cet espace' } };
  }
  const defaut = await deps.getTenantPhoneNumberId(tenantId);
  return defaut
    ? { phoneNumberId: defaut }
    : { refus: { statut: 409, code: 'no_whatsapp_number', message: 'aucun numéro WhatsApp connecté sur cet espace' } };
}

/**
 * LA CIBLE RÉSOLUE, avec ce qu'elle fait partir en premier (spec 2026-09-24, § 3).
 *
 * 🔴 LES GARDES DE LA CONSOLE, ALIGNÉES (défaut 2) : l'API répondait 201 à un scénario que la création de
 * campagne refuse, à un template inconnu ou non approuvé, et chaque destinataire échouait ensuite chez Meta.
 *
 * 🔴 UNE CIBLE `node` EST JUGÉE SUR CE QUI PART EN PREMIER DEPUIS ELLE (défaut 3), plus sur le type du bloc.
 */
async function resoudreCible(deps: V1SendsRouteDeps, tenantId: string, c: CibleDemandee): Promise<CibleResolue | Refus> {
  if (c.kind === 'template') {
    const lu = await deps.lireModele(tenantId, c.name, c.language);
    if (lu.statut === 'absent') {
      return { refus: { statut: 404, code: 'template_not_found', message: `template introuvable, non approuvé ou d’une autre langue : ${c.name} (${c.language})` } };
    }
    if (lu.statut === 'illisible') {
      return { refus: { statut: 422, code: 'template_category_unknown', message: 'la catégorie de ce template n’a pas pu être lue chez Meta : l’envoi est refusé par prudence, réessayez dans un instant' } };
    }
    if (lu.statut === 'categorie_non_admise') {
      // LUE, et définitive : réessayer n'y changera rien, le message ne doit pas le suggérer.
      return { refus: { statut: 422, code: 'template_category_unknown', message: `catégorie ${lu.categorie.slice(0, 40)} non envoyable par l’API : un template marketing ou utility est attendu` } };
    }
    return { ouverture: 'whatsapp_template', category: lu.categorie, label: c.name, templateName: c.name, templateLanguage: c.language };
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
    return { ouverture: v.ouverture, category: c.category, label: r.value.name, templateName: '', templateLanguage: '', workflowId: r.value.id };
  }
  const r = await deps.resolveNode(tenantId, c.code);
  if (!r.ok) return { refus: { statut: 404, code: 'node_not_found', message: 'bloc introuvable dans les scénarios publiés' } };
  const v = ouvertureApi(r.value.graph, r.value.nodeId);
  if (v.ouverture === null) return { refus: { statut: 422, code: 'unsendable_target', message: `ce bloc ne peut pas partir : ${v.raison}` } };
  return { ouverture: v.ouverture, category: c.category, label: r.value.label, templateName: '', templateLanguage: '', workflowId: r.value.workflowId, startNodeId: r.value.nodeId };
}

/**
 * Chaque destinataire résolu en fiche par la fonction PARTAGÉE du lot 1, ou écarté avec son motif.
 *
 * ⚠️ `creer` vient de l'ouverture : un template ou un RCS part vers quelqu'un qui n'a pas écrit, donc un
 * `phone` inconnu fonde une fiche ; une ouverture de session n'a par construction aucune fenêtre chez un
 * inconnu, donc `jamais`. Un inconnu qui ne porte qu'un `bsuid` n'est jamais créé ici (`phone`).
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
    const { consent, consentSource, ...cles } = d.data;
    const r = await deps.resoudreFiche(tenantId, cles, { creer });
    if (!r.ok) { resolus.push({ index, ecart: r.code }); continue; }
    if (r.cree) created += 1; else matched += 1;
    resolus.push(consent ? { index, contactId: r.contactId, consent, consentSource: consentSource ?? 'api' } : { index, contactId: r.contactId });
  }
  return { resolus, created, matched };
}

/** La fenêtre de 24 h par contact, en UNE requête pour tout le lot, interrogée avec le wa_id (chiffres nus). */
async function fenetresParContact(deps: V1SendsRouteDeps, tenantId: string, contacts: ContactEnvoi[]): Promise<Map<string, boolean>> {
  const waIdParContact = new Map<string, string>();
  for (const c of contacts) {
    const w = waIdOf(c.phone_e164, c.bsuid);
    if (w) waIdParContact.set(c.id, w);
  }
  const parWaId = await deps.getWindowOpenByWaIds(tenantId, [...new Set(waIdParContact.values())]);
  return new Map([...waIdParContact].map(([id, w]) => [id, parWaId.get(w) === true]));
}

const FORME_ID_ENVOI = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const schemaIdEnvoi = z.object({ sendId: z.string().regex(FORME_ID_ENVOI) });

/**
 * API publique /v1 des envois (spec 2026-09-24, § 3). Tenant issu de la clé (`req.auth`), jamais du corps.
 * Garde attendue : `[makeRequireApiKey, requireScope('sends:create')]`.
 *
 * 🔴 L'ORDRE COMPTE : la forme (gratuite), le compteur d'usage, le claim d'idempotence, PUIS le numéro et la
 * cible (des lectures), et SEULEMENT ALORS ce qui écrit (fiches, consentements, campagne). Le claim passe
 * AVANT les lectures : un rejeu légitime rend le rapport SCELLÉ même si, depuis, le template est repassé en
 * attente, le scénario dépublié ou le numéro retiré (sinon 404, 409 ou 422 feraient croire à l'intégrateur
 * que rien n'est parti). Un refus après le claim LIBÈRE la clé, une erreur aussi.
 */
export function registerV1Sends(app: FastifyInstance, deps: V1SendsRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.post('/v1/sends', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    const tenantId = req.auth.tenantId;

    const lu = schemaCorps.safeParse(req.body);
    if (!lu.success) return refuser(reply, 400, 'invalid_body', messageDeForme(lu.error, PRECISIONS));
    const corps = lu.data;
    // La clé se donne en en-tête OU dans le corps (`idempotencyKey`) : un outil qui appelle une adresse par
    // contact remplit son corps avec les données du contact, pas toujours ses en-têtes.
    const idem = cleIdempotence(req.headers['idempotency-key'], corps);
    if (!idem.ok) return refuser(reply, 400, idem.code, idem.message);
    // Même validation que la route console : une source malformée casserait sinon au moment de résoudre les
    // variables, en 500 sur un endpoint public au lieu d'un 400 déterministe.
    const params = validateParamMapping(corps.params ?? []);
    if (params === null) return refuser(reply, 400, 'invalid_body', 'params : positions 1..N contiguës et sources valides attendues');
    const demandee = lireCible(corps, params);
    if ('message' in demandee) return refuser(reply, 400, 'invalid_body', demandee.message);

    /**
     * ⚠️ COMPTÉ AVANT LA RÉSOLUTION DE LA CIBLE, qui fait déjà des lectures (scénario, bloc, template chez
     * Meta, numéro). Compter après laisserait ce travail-là hors des compteurs.
     */
    if (!await compterOuRefuser(deps.usage, req, reply, 'sends.create', corps.recipients.length)) return reply;

    // Idempotence : claim atomique AVEC l'empreinte du corps, AVANT toute lecture qui peut changer d'un appel à
    // l'autre (numéro, cible, template chez Meta). Autre corps -> 422 ; concurrent -> 409 ; déjà scellé ->
    // rejeu du rapport, tel quel.
    const claim = await deps.idempotencyClaim(tenantId, idem.cle, empreinteCorps(req.body));
    if (!claim.claimed && 'reused' in claim) {
      return refuser(reply, 422, 'idempotency_key_reused', 'cette clé d’idempotence a déjà servi pour un autre corps : une clé désigne un seul envoi, et elle vit 24 h');
    }
    if (!claim.claimed && 'pending' in claim) {
      return refuser(reply, 409, 'idempotency_in_progress', 'un envoi avec cette clé d’idempotence est en cours : réessayez dans un instant');
    }
    if (!claim.claimed) return reply.code(201).send(claim.response);

    /** Un refus après le claim n'a rien créé : la clé est LIBÉRÉE, le même appel repartira une fois corrigé. */
    const libererEtRefuser = async (r: Refus['refus']) => {
      await deps.idempotencyRelease(tenantId, idem.cle);
      return refuser(reply, r.statut, r.code, r.message);
    };

    // Rempli + scellé dans le try ; l'enqueue (hors try) le lit après scellement (definite assignment).
    let report!: RapportEnvoi;
    try {
      const numero = await numeroDEnvoi(deps, tenantId, corps.phoneNumberId);
      if ('refus' in numero) return await libererEtRefuser(numero.refus);
      const cible = await resoudreCible(deps, tenantId, demandee);
      if ('refus' in cible) return await libererEtRefuser(cible.refus);
      const { resolus, created, matched } = await resoudreDestinataires(
        deps, tenantId, corps.recipients, cible.ouverture === 'whatsapp_session' ? 'jamais' : 'phone',
      );
      const uniques = marquerDoublons(resolus);
      /**
       * 🔴 LE CONSENTEMENT S'ÉCRIT AVANT LA LECTURE DES FICHES, donc avant le tri marketing (spec § 3) : un
       * outil où vit le consentement envoie sans pousser chaque fiche au préalable. Son issue n'est pas lue :
       * la fiche RELUE dit ce qui a été enregistré.
       *
       * 🔴 IL SE LIT SUR TOUTES LES OCCURRENCES, DOUBLONS COMPRIS, et s'écrit UNE fois par fiche. Lu sur les
       * seules premières occurrences, un `opted_out` porté par un doublon était jeté : la personne recevait le
       * message ET restait abonnée pour les envois suivants. Un refus l'emporte sur un accord, avec sa source.
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
      const contacts = await deps.listContactsPourEnvoi(tenantId, uniques.flatMap((r) => ('contactId' in r ? [r.contactId] : [])));
      const fenetre = cible.ouverture === 'whatsapp_session' ? await fenetresParContact(deps, tenantId, contacts) : undefined;
      const tri = trierDestinataires({
        category: cible.category, ouverture: cible.ouverture, resolus: uniques, contacts,
        ...(fenetre ? { fenetreOuverteParContact: fenetre } : {}),
      });
      const { recipients, ecarts } = construireDestinataires(cible.category, params, tri, new Date());
      report = {
        sendId: '',
        opening: cible.ouverture,
        recipientCount: recipients.length,
        created,
        matched,
        skipped: ecarts.slice(0, MAX_SKIPPED_REPORT),
        skippedTotal: ecarts.length,
      };
      const send = await deps.createSend(
        {
          tenantId, phoneNumberId: numero.phoneNumberId, name: `[API] ${cible.label}`.slice(0, 120), category: cible.category,
          templateName: cible.templateName, templateLanguage: cible.templateLanguage, paramMapping: params,
          ...(cible.workflowId ? { workflowId: cible.workflowId } : {}),
          ...(cible.startNodeId ? { startNodeId: cible.startNodeId } : {}),
        },
        recipients,
      );
      report.sendId = send.campaignId;
      // SCELLE l'idempotence AVANT l'enqueue : sans ça, un échec de complete APRÈS un enqueue réussi ferait
      // release, et un retry recréerait une 2e campagne, donc renverrait les messages EN DOUBLE. Échec avant
      // scellement -> release + throw (retry propre).
      await deps.idempotencyComplete(tenantId, idem.cle, send.campaignId, report);
    } catch (err) {
      await deps.idempotencyRelease(tenantId, idem.cle);
      throw err;
    }

    // Idempotence scellée, DÉFINITIVEMENT : aucun chemin ci-dessous ne release. On RETENTE l'enfilement pour
    // couvrir le hoquet transitoire de la file au lieu de laisser une campagne draft jamais lancée. Échec
    // persistant -> 201 + log fort : sous-envoi assumé, jamais de sur-envoi.
    //
    // ⚠️ Ce qui rend le retry sûr, c'est le claim atomique par destinataire, PAS une déduplication de file :
    // il n'y en a aucune. Si un enfilement avait commité avant de lever, la tentative suivante empilerait un
    // SECOND run de la même campagne : aucun contact ne recevrait deux fois, mais les deux runs
    // additionneraient leurs débits. Borné à 3 tentatives, sur un chemin d'échec rare.
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
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
          err instanceof Error ? err.message : err,
        );
        if (last) break;
        await sleep(ENQUEUE_RETRY_DELAYS_MS[attempt] ?? 300);
      }
    }
    return reply.code(201).send(report);
  });

  app.get('/v1/sends/:sendId', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    // ⚠️ UNE LECTURE COMPTE AUSSI, POUR UNE UNITÉ, et AVANT le contrôle de forme : un intégrateur qui sonde
    // l'avancement toutes les secondes est exactement l'usage qu'on veut VOIR.
    if (!await compterOuRefuser(deps.usage, req, reply, 'sends.read')) return reply;
    // Un identifiant qui n'est pas un uuid ferait lever Postgres (22P02), donc un 500 : il est inconnu, 404.
    const p = schemaIdEnvoi.safeParse(req.params);
    if (!p.success) return refuser(reply, 404, 'send_not_found', 'envoi inconnu');
    const brut = await deps.lireEnvoi(p.data.sendId, req.auth.tenantId);
    if (!brut) return refuser(reply, 404, 'send_not_found', 'envoi inconnu');
    return reply.code(200).send(formaterSuiviEnvoi(brut));
  });
}
