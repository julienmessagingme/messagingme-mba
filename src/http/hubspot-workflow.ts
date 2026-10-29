import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifyRequest } from '../lib/signature';
import { journaliser } from '../lib/journal';
import { e164DepuisSaisie, estUnFixe } from '../crm/phone';
import { waIdOf } from '../crm/identity';
import { modeleDOuverture, ouvertureApi } from '../workflow/ouverture-api';
import { actionOf } from '../workflow/engine';
import type { ScenarioPublie } from '../workflow/store.pg';
import { modeleLuDe, verdictModele } from '../api/modele-envoi';
import type { Fonction } from '../offres/offres';
import { corpsRefusFonction } from '../offres/refus';
import type { Filiere } from '../application/comptes';
import type { TemplateSummary } from '../meta/templates';
import type { EnvoyerPublic } from '../shopify/envoi';
import { envoyerPourWorkflow, valeursDuWorkflow, type IssueWorkflow, type PlafondRefuse } from '../hubspot-workflow/envoi';
import type { VerdictPlafonds } from '../hubspot-workflow/plafonds';
import type { EtatLigneHubspot } from './hubspot-conversation';

/**
 * L'ACTION DE WORKFLOW HUBSPOT « ENVOYER UN MODÈLE WHATSAPP », côté Messaging Me (cadrage
 * `~/mm-hubspot/docs/2026-10-27-action-workflow-modele-cadrage.md`, décisions 1 à 11 validées par Julien le 2026-10-27 ;
 * plan du même jour, lot 1). Deux routes que seul le connecteur appelle, signées comme `/hubspot/deal-stage` (même secret,
 * même format) : les modèles qu'un workflow peut envoyer, et l'envoi lui-même. Le connecteur porte HubSpot (le portail,
 * l'exécution, le numéro lu dans la propriété choisie par le client) ; ici, on décide.
 *
 * Les gardes de l'ESPACE répondent en erreur définitive (le connecteur en fait « non branché ») : l'offre qui relie
 * HubSpot (`crm`, 402), le réglage « Workflows HubSpot » (403), la ligne reliée et la filière (409). Celles de l'ENVOI
 * répondent 200 avec une `issue` d'un jeu fermé, que le connecteur montre dans l'historique du workflow. Ce qui doit être
 * RELANCÉ par HubSpot (décision 6) rend 429 ou 503 avec `Retry-After`, jamais 409 : le plafond par minute, une clé en vol,
 * une lecture chez Meta en panne.
 *
 * L'ACTION « LANCER UN SCÉNARIO MESSAGING ME » (cadrage `~/mm-hubspot/docs/2026-10-29-action-workflow-scenario-cadrage.md`,
 * décisions 1 à 10 validées par Julien le 2026-10-29) ajoute deux routes jumelles, sur les mêmes gardes et le même
 * adaptateur : les scénarios qu'un workflow peut lancer, et le lancement. Un scénario se juge sur son modèle d'ouverture,
 * par le même `jugerPourWorkflow` (décision 2), et ne part jamais vers une conversation qu'un opérateur tient (décision 3).
 */
export interface HubspotWorkflowDeps {
  /** Secret partagé avec le connecteur (== SERVICE_SECRET de mm-hubspot). Vide -> module non monté. */
  secret: string;
  fonctions(tenantId: string): Promise<ReadonlySet<Fonction>>;
  /** Le réglage « Workflows HubSpot : envoyer des modèles et lancer des scénarios » de l'espace, relu à chaque appel. */
  workflowsBranches(tenantId: string): Promise<boolean>;
  /** La synchro HubSpot du numéro de l'espace (`etatLigneHubspot`). */
  ligneHubspot(tenantId: string): Promise<EtatLigneHubspot>;
  /** La filière de l'espace : l'application WhatsApp Business n'envoie pas de modèle. */
  filiere(tenantId: string): Promise<Filiere | null>;
  /** Le cœur d'envoi public (`lancerEnvoiPublic`, câblé comme pour Shopify). */
  envoyer: EnvoyerPublic;
  /** Les plafonds des workflows, minute et jour comptés ensemble (`plafondsDesWorkflows`, décision 9). */
  plafonds(tenantId: string): Promise<VerdictPlafonds>;
  /** Les modèles de l'espace (le catalogue de `GET /v1/templates`, en cache une minute). */
  catalogue(tenantId: string): Promise<TemplateSummary[]>;
  /** Le nom de l'espace : la liste « Espace » de l'action le montre (le connecteur ne connaît que des identifiants). */
  nomEspace(tenantId: string): Promise<string | null>;
  /** Les scénarios en ligne de l'espace (`workflowStore.listPublies`) : la liste ET le lancement les lisent là. */
  scenariosPublies(tenantId: string): Promise<ScenarioPublie[]>;
  /** Un opérateur tient-il la conversation de ce contact (`getControlOwner(...) === 'app_human'`) ? Décision 3. */
  conseillerEnMain(tenantId: string, waId: string): Promise<boolean>;
  now?: () => number;
  windowMs?: number;
}

/** Au plus autant de valeurs : l'action a dix champs « Variable » fixes (décision 5). */
export const VARIABLES_WORKFLOW_MAX = 10;
/** Ce que le connecteur fait attendre à HubSpot avant de relancer une clé en vol, ou une lecture chez Meta en panne. */
export const RELANCE_EN_COURS_SEC = 5;
export const RELANCE_META_SEC = 30;

// L'espace en minuscules : la clé des plafonds est un texte, une casse différente y ouvrirait un compteur neuf.
const UUID = z.string().uuid().transform((s) => s.toLowerCase());
const corpsModele = z.object({
  tenantId: UUID,
  // Vide ou illisible n'est pas une faute du corps : c'est l'issue `sans_numero`, que l'historique doit montrer.
  telephone: z.string().trim().max(1024),
  modele: z.string().min(1).max(512),
  langue: z.string().min(1).max(20),
  // La borne d'une propriété HubSpot : la règle de Meta (1 024) se juge dans `valeursDuWorkflow`, qui rend une issue.
  valeurs: z.array(z.string().max(65_536)).max(VARIABLES_WORKFLOW_MAX),
  workflowId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
}).strict();
const corpsModeles = z.object({ tenantId: UUID }).strict();
const corpsScenario = z.object({
  tenantId: UUID,
  telephone: z.string().trim().max(1024),
  // Le code `scn_` que la liste a donné : un nom serait ambigu dès que deux scénarios le portent.
  scenario: z.string().regex(/^scn_[A-Za-z0-9_-]{1,64}$/),
  valeurs: z.array(z.string().max(65_536)).max(VARIABLES_WORKFLOW_MAX),
  workflowId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
}).strict();

type WithRawBody = FastifyRequest & { rawBody?: Buffer };

/**
 * Un modèle pour l'action : le jugement de `GET /v1/templates` (`verdictModele(modeleLuDe(t))`, jamais une règle
 * voisine), puis Service seulement (décision 3), sans carrousel, dix variables au plus (décision 5). Sert la liste ET
 * l'envoi : un modèle que la liste propose passe ce tri à l'envoi, et inversement.
 */
export function jugerPourWorkflow(t: TemplateSummary): { ok: true; variables: number } | { ok: false; issue: IssueWorkflow } {
  const v = verdictModele(modeleLuDe(t), t.language);
  if (v.statut === 'illisible') return { ok: false, issue: 'meta_indisponible' };
  if (v.statut !== 'approuve' || t.isCarousel || v.variables > VARIABLES_WORKFLOW_MAX) return { ok: false, issue: 'modele_refuse' };
  if (v.categorie !== 'utility') return { ok: false, issue: 'marketing_refuse' };
  return { ok: true, variables: v.variables };
}

/** Un scénario qu'un workflow peut lancer : son code, et le modèle qui l'ouvre, jugé comme l'action modèle le juge. */
export interface ScenarioLancable { code: string; nom: string; modele: TemplateSummary; variables: number }

/**
 * Un scénario pour l'action (décision 2) : désigné par un code, ouvert par un modèle WhatsApp (ni message de session, qui
 * exige la fenêtre, ni RCS, dont la catégorie ne serait que déclarée), ce modèle au catalogue et accepté par
 * `jugerPourWorkflow` (Service, sans carrousel, dix variables au plus). Sert la liste ET le lancement.
 *
 * 🔴 ET AUCUN AUTRE MODÈLE DU SCÉNARIO N'EST MARKETING (relecture du 2026-10-29) : le cœur et l'exécuteur ne jugent que
 * l'ouverture, et un modèle sans bouton ne fait pas attendre le parcours ; « Service, puis Marketing » enverrait un
 * Marketing à un contact inscrit par un workflow, sans accord. Tous les blocs « Modèle » nommés du graphe sont lus au
 * catalogue : Marketing (ou inconnu de Meta) refuse le scénario entier, qu'il soit atteint tout de suite ou après un clic.
 */
export function jugerScenarioPourWorkflow(
  s: ScenarioPublie, catalogue: readonly TemplateSummary[],
): { ok: true; scenario: ScenarioLancable } | { ok: false; issue: IssueWorkflow } {
  if (s.code === null || ouvertureApi(s.graph).ouverture !== 'whatsapp_template') return { ok: false, issue: 'scenario_refuse' };
  const ouvre = modeleDOuverture(s.graph);
  const t = ouvre ? catalogue.find((m) => m.name === ouvre.templateName && m.language === ouvre.language) : undefined;
  if (!t) return { ok: false, issue: 'scenario_refuse' };
  const j = jugerPourWorkflow(t);
  if (!j.ok) return { ok: false, issue: j.issue === 'modele_refuse' ? 'scenario_refuse' : j.issue };
  for (const n of s.graph.nodes) {
    const a = n.type === 'template' ? actionOf(n) : null;
    if (a?.kind !== 'sendTemplate' || a.templateName.trim() === '') continue;
    const autre = catalogue.find((m) => m.name === a.templateName && m.language === a.language);
    if (!autre) return { ok: false, issue: 'scenario_refuse' };
    const v = verdictModele(modeleLuDe(autre), autre.language);
    if (v.statut === 'illisible') return { ok: false, issue: 'meta_indisponible' };
    if (v.categorie !== 'utility') return { ok: false, issue: 'marketing_refuse' };
  }
  return { ok: true, scenario: { code: s.code, nom: s.name, modele: t, variables: j.variables } };
}

export function registerHubspotWorkflow(app: FastifyInstance, deps: HubspotWorkflowDeps): void {
  const now = deps.now ?? (() => Date.now());
  const windowMs = deps.windowMs ?? 5 * 60 * 1000;

  /** Signature d'abord, avant de lire quoi que ce soit (comme `POST /hubspot/deal-stage`). */
  const signee = (req: FastifyRequest): boolean => {
    const raw = (req as WithRawBody).rawBody;
    const sig = req.headers['x-mm-service-signature'];
    const header = Array.isArray(sig) ? sig[0] : sig;
    const path = req.url.split('?')[0] ?? req.url;
    return !!raw && verifyRequest(raw, header, deps.secret, { method: req.method, path, now: now(), windowMs });
  };

  /** Les gardes de l'espace, dans l'ordre : l'offre, le réglage. `false` : la réponse est déjà partie. */
  async function gardesEspace(reply: FastifyReply, tenantId: string): Promise<boolean> {
    if (!(await deps.fonctions(tenantId)).has('crm')) {
      reply.code(402).send(corpsRefusFonction('crm'));
      return false;
    }
    if (!(await deps.workflowsBranches(tenantId))) {
      reply.code(403).send({ error: 'Les workflows HubSpot ne sont pas branchés pour cet espace (Tools > Intégrations > HubSpot).', code: 'workflows_hubspot_eteints' });
      return false;
    }
    return true;
  }

  /** Une relance demandée à HubSpot (décision 6) : 429 ou 503, avec l'attente en en-tête et dans le corps. */
  const relancer = (reply: FastifyReply, statut: 429 | 503, retryAfterSec: number, code: string, error: string) =>
    reply.code(statut).header('retry-after', String(retryAfterSec)).send({ error, code, retryAfterSec });

  /** Le catalogue de l'espace, ou `null` si Meta n'a pas répondu : une panne se relance, elle ne refuse rien. */
  async function lireCatalogue(tenantId: string): Promise<TemplateSummary[] | null> {
    try {
      return await deps.catalogue(tenantId);
    } catch (err) {
      journaliser('error', 'hubspot_workflow_catalogue_illisible', { tenantId, err });
      return null;
    }
  }

  app.post('/hubspot/workflow/modeles', async (req, reply) => {
    if (!signee(req)) return reply.code(401).send({ error: 'invalid signature' });
    const lu = corpsModeles.safeParse(req.body);
    if (!lu.success) return reply.code(400).send({ error: 'payload invalide' });
    const { tenantId } = lu.data;
    if (!(await gardesEspace(reply, tenantId))) return reply;
    const catalogue = await lireCatalogue(tenantId);
    if (catalogue === null) return relancer(reply, 503, RELANCE_META_SEC, 'meta_indisponible', 'Les modèles n’ont pas pu être lus chez Meta : réessayez dans un instant.');
    const modeles = catalogue.flatMap((t) => {
      const j = jugerPourWorkflow(t);
      return j.ok ? [{ name: t.name, language: t.language, texte: t.body, variables: j.variables }] : [];
    });
    return reply.code(200).send({ espace: await deps.nomEspace(tenantId), modeles });
  });

  app.post('/hubspot/workflow/modele', async (req, reply) => {
    if (!signee(req)) return reply.code(401).send({ error: 'invalid signature' });
    const lu = corpsModele.safeParse(req.body);
    if (!lu.success) return reply.code(400).send({ error: 'payload invalide' });
    const { tenantId, telephone, modele, langue, workflowId } = lu.data;

    if (!(await gardesEspace(reply, tenantId))) return reply;
    const ligne = await deps.ligneHubspot(tenantId);
    if (ligne !== 'reliee') return reply.code(409).send({ error: 'Le numéro de cet espace n’est pas relié à HubSpot.', code: 'ligne_non_reliee', raison: ligne });
    if ((await deps.filiere(tenantId)) === 'application') {
      return reply.code(409).send({ error: 'Cet espace envoie par l’application WhatsApp Business, qui n’envoie pas de modèle.', code: 'whatsapp_app_no_template' });
    }

    // Les refus d'un envoi : une issue, en 200 (le workflow continue et l'historique dit pourquoi). Le numéro tel qu'un
    // outil le range (`447911123456`, sans « + ») est lu comme `/v1/sends` le lit.
    const e164 = e164DepuisSaisie(telephone, 'FR');
    if (!e164) return reply.code(200).send({ issue: 'sans_numero' });
    if (estUnFixe(e164)) return reply.code(200).send({ issue: 'fixe' });
    const valeurs = valeursDuWorkflow(lu.data.valeurs);
    if (valeurs === null) return reply.code(200).send({ issue: 'valeur_invalide' });

    // Le modèle jugé comme la liste le juge, AVANT la clé et les plafonds : un modèle devenu Marketing ou supprimé, ou
    // une variable vide (dont le champ, en fin de liste, a été retiré), ne compte rien. Le cœur relit la catégorie chez
    // Meta et reste l'autorité.
    const catalogue = await lireCatalogue(tenantId);
    if (catalogue === null) return relancer(reply, 503, RELANCE_META_SEC, 'meta_indisponible', 'Le modèle n’a pas pu être lu chez Meta : réessayez dans un instant.');
    const t = catalogue.find((m) => m.name === modele && m.language === langue);
    const juge = t ? jugerPourWorkflow(t) : { ok: false as const, issue: 'modele_refuse' as const };
    if (!juge.ok) {
      if (juge.issue === 'meta_indisponible') return relancer(reply, 503, RELANCE_META_SEC, 'meta_indisponible', 'Le modèle n’a pas pu être lu chez Meta : réessayez dans un instant.');
      return reply.code(200).send({ issue: juge.issue });
    }
    if (valeurs.length !== juge.variables) return reply.code(200).send({ issue: 'valeur_invalide' });

    // Les deux plafonds, comptés ensemble par le cœur juste après la clé. L'attente de la minute part dans le 429.
    let attenteMs = 0;
    const compter = async (): Promise<PlafondRefuse | null> => {
      const v = await deps.plafonds(tenantId);
      if (v.accepte) return null;
      attenteMs = v.attenteMs;
      return v.fenetre;
    };
    const r = await envoyerPourWorkflow(deps.envoyer, { tenantId, telephone: e164, cible: { modele, langue }, valeurs, workflowId }, compter);
    if (r.issue === 'plafond_minute') {
      return relancer(reply, 429, Math.max(1, Math.ceil(attenteMs / 1000)), 'rate_limited', 'Trop d’envois depuis les workflows HubSpot : réessayez plus tard.');
    }
    if (r.issue === 'en_cours') return relancer(reply, 429, RELANCE_EN_COURS_SEC, 'en_cours', 'Cet envoi est en cours : réessayez dans un instant.');
    if (r.issue === 'meta_indisponible') return relancer(reply, 503, RELANCE_META_SEC, 'meta_indisponible', 'Le modèle n’a pas pu être lu chez Meta : réessayez dans un instant.');
    return reply.code(200).send(r);
  });

  /** Les scénarios lançables, jugés sur le catalogue lu une fois. `null` : Meta n'a pas répondu (une panne se relance). */
  async function scenariosLancables(tenantId: string): Promise<ScenarioLancable[] | null> {
    const catalogue = await lireCatalogue(tenantId);
    if (catalogue === null) return null;
    return (await deps.scenariosPublies(tenantId)).flatMap((s) => {
      const j = jugerScenarioPourWorkflow(s, catalogue);
      return j.ok ? [j.scenario] : [];
    });
  }

  app.post('/hubspot/workflow/scenarios', async (req, reply) => {
    if (!signee(req)) return reply.code(401).send({ error: 'invalid signature' });
    const lu = corpsModeles.safeParse(req.body);
    if (!lu.success) return reply.code(400).send({ error: 'payload invalide' });
    const { tenantId } = lu.data;
    if (!(await gardesEspace(reply, tenantId))) return reply;
    // Une offre sans scénarios : l'espace reste branché (ses modèles partent), sa liste de scénarios est vide.
    if (!(await deps.fonctions(tenantId)).has('scenarios')) return reply.code(200).send({ espace: await deps.nomEspace(tenantId), scenarios: [] });
    const lancables = await scenariosLancables(tenantId);
    if (lancables === null) return relancer(reply, 503, RELANCE_META_SEC, 'meta_indisponible', 'Les modèles n’ont pas pu être lus chez Meta : réessayez dans un instant.');
    const scenarios = lancables.map((s) => ({
      code: s.code, nom: s.nom, modele: s.modele.name, langue: s.modele.language, texte: s.modele.body, variables: s.variables,
    }));
    return reply.code(200).send({ espace: await deps.nomEspace(tenantId), scenarios });
  });

  app.post('/hubspot/workflow/scenario', async (req, reply) => {
    if (!signee(req)) return reply.code(401).send({ error: 'invalid signature' });
    const lu = corpsScenario.safeParse(req.body);
    if (!lu.success) return reply.code(400).send({ error: 'payload invalide' });
    const { tenantId, telephone, scenario, workflowId } = lu.data;

    // Les mêmes gardes que l'envoi d'un modèle, dans le même ordre.
    if (!(await gardesEspace(reply, tenantId))) return reply;
    const ligne = await deps.ligneHubspot(tenantId);
    if (ligne !== 'reliee') return reply.code(409).send({ error: 'Le numéro de cet espace n’est pas relié à HubSpot.', code: 'ligne_non_reliee', raison: ligne });
    if ((await deps.filiere(tenantId)) === 'application') {
      return reply.code(409).send({ error: 'Cet espace envoie par l’application WhatsApp Business, qui n’envoie pas de modèle.', code: 'whatsapp_app_no_template' });
    }
    const e164 = e164DepuisSaisie(telephone, 'FR');
    if (!e164) return reply.code(200).send({ issue: 'sans_numero' });
    if (estUnFixe(e164)) return reply.code(200).send({ issue: 'fixe' });
    const valeurs = valeursDuWorkflow(lu.data.valeurs);
    if (valeurs === null) return reply.code(200).send({ issue: 'valeur_invalide' });
    if (!(await deps.fonctions(tenantId)).has('scenarios')) return reply.code(200).send({ issue: 'hors_offre' });

    // 🔴 Décision 3 : jamais vers une conversation qu'un opérateur tient, jugé AVANT la clé et les plafonds pour que
    // l'historique du workflow le dise. Le moteur le revérifie au démarrage (`workflow_hubspot`, `sauf_operateur`).
    const waId = waIdOf(e164, null);
    if (waId !== null && (await deps.conseillerEnMain(tenantId, waId))) return reply.code(200).send({ issue: 'conseiller_en_main' });

    // Le scénario jugé comme la liste le juge, avant la clé : un scénario dépublié, ou dont l'ouverture est devenue une
    // question, un RCS ou un Marketing, ne compte rien. Le cœur relit le modèle d'ouverture chez Meta et reste l'autorité.
    const publie = (await deps.scenariosPublies(tenantId)).find((s) => s.code === scenario);
    if (!publie) return reply.code(200).send({ issue: 'scenario_refuse' });
    const catalogue = await lireCatalogue(tenantId);
    if (catalogue === null) return relancer(reply, 503, RELANCE_META_SEC, 'meta_indisponible', 'Le modèle d’ouverture n’a pas pu être lu chez Meta : réessayez dans un instant.');
    const juge = jugerScenarioPourWorkflow(publie, catalogue);
    if (!juge.ok) {
      if (juge.issue === 'meta_indisponible') return relancer(reply, 503, RELANCE_META_SEC, 'meta_indisponible', 'Le modèle d’ouverture n’a pas pu être lu chez Meta : réessayez dans un instant.');
      return reply.code(200).send({ issue: juge.issue });
    }
    if (valeurs.length !== juge.scenario.variables) return reply.code(200).send({ issue: 'valeur_invalide' });

    let attenteMs = 0;
    const compter = async (): Promise<PlafondRefuse | null> => {
      const v = await deps.plafonds(tenantId);
      if (v.accepte) return null;
      attenteMs = v.attenteMs;
      return v.fenetre;
    };
    const r = await envoyerPourWorkflow(deps.envoyer, { tenantId, telephone: e164, cible: { scenario }, valeurs, workflowId }, compter);
    if (r.issue === 'plafond_minute') {
      return relancer(reply, 429, Math.max(1, Math.ceil(attenteMs / 1000)), 'rate_limited', 'Trop d’envois depuis les workflows HubSpot : réessayez plus tard.');
    }
    if (r.issue === 'en_cours') return relancer(reply, 429, RELANCE_EN_COURS_SEC, 'en_cours', 'Ce lancement est en cours : réessayez dans un instant.');
    if (r.issue === 'meta_indisponible') return relancer(reply, 503, RELANCE_META_SEC, 'meta_indisponible', 'Le modèle d’ouverture n’a pas pu être lu chez Meta : réessayez dans un instant.');
    return reply.code(200).send(r);
  });
}
