import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifyRequest } from '../lib/signature';
import { journaliser } from '../lib/journal';
import { e164DepuisSaisie, estUnFixe } from '../crm/phone';
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
 */
export interface HubspotWorkflowDeps {
  /** Secret partagé avec le connecteur (== SERVICE_SECRET de mm-hubspot). Vide -> module non monté. */
  secret: string;
  fonctions(tenantId: string): Promise<ReadonlySet<Fonction>>;
  /** Le réglage « Workflows HubSpot : envoyer des modèles WhatsApp » de l'espace, relu à chaque appel. */
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
    const r = await envoyerPourWorkflow(deps.envoyer, { tenantId, telephone: e164, modele, langue, valeurs, workflowId }, compter);
    if (r.issue === 'plafond_minute') {
      return relancer(reply, 429, Math.max(1, Math.ceil(attenteMs / 1000)), 'rate_limited', 'Trop d’envois depuis les workflows HubSpot : réessayez plus tard.');
    }
    if (r.issue === 'en_cours') return relancer(reply, 429, RELANCE_EN_COURS_SEC, 'en_cours', 'Cet envoi est en cours : réessayez dans un instant.');
    if (r.issue === 'meta_indisponible') return relancer(reply, 503, RELANCE_META_SEC, 'meta_indisponible', 'Le modèle n’a pas pu être lu chez Meta : réessayez dans un instant.');
    return reply.code(200).send(r);
  });
}
