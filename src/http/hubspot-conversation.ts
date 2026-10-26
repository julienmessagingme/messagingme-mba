import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifyRequest } from '../lib/signature';
import { journaliser } from '../lib/journal';
import type { Fonction } from '../offres/offres';
import { corpsRefusFonction } from '../offres/refus';
import { peutEcrire, type ActeurConversation } from '../inbox/assignment';
import { repondreDansLaFenetre, type DepsRepondre, type RefusReponse } from '../inbox/repondre';
import type { AuteurDuChangement } from '../inbox/evenements';
import { MetaApiError } from '../meta/errors';
import { AgentDeMetaGardeLeFil, type ControleDuFil } from '../inbox/fil';
import type { ConversationMessage, ControlOwner } from '../inbox/store.pg';
import { decoderCurseur, encoderCurseur } from '../api/conversations-v1';
import { empreinteCorps } from '../api/idempotence';
import type { IdempotencyClaim } from '../api/idempotency-store.pg';
import { PHRASE_FORMAT_APPLICATION, phraseApplicationIndisponible, phrasePremierMessage } from '../application/envoi';
import { TEXTE_MAX_CARACTERES } from '../traduction/traduire';

/**
 * LA CONVERSATION LUE ET RÉPONDUE DEPUIS HUBSPOT (lot 2 de la reprise humaine, plan
 * `~/mm-hubspot/docs/2026-10-23-lot2-lire-repondre-plan.md`, décisions 5 à 8 validées par Julien le 2026-10-23). Trois
 * routes que seul le connecteur appelle, signées comme `POST /hubspot/deal-stage` (même secret, même format) : lire le
 * fil, répondre, rendre la main. Le connecteur porte l'identité HubSpot (le portail et l'adresse de la personne, signés
 * par HubSpot dans la carte) ; ici, on décide.
 *
 * 🔴 UNE RÉPONSE PASSE PAR LE CHEMIN D'ENVOI DE LA CONSOLE (`repondreDansLaFenetre`), en origine `humain` : la même
 * fenêtre, la même isolation, la même prise du fil, la même clôture d'escalade. L'affectation est celle de la console
 * (décision 6, `peutEcrire` sur l'identité signée). STOP non : HubSpot ne répond jamais à un contact désabonné (décision 5
 * amendée par Julien le 2026-10-26, voir la route de réponse).
 * Chaque route lit l'offre (`inbox`) et le réglage « Répondre depuis HubSpot » (lot 1bis) : l'étape d'offre du
 * registre ne s'applique pas à une route signée.
 */
export interface HubspotConversationDeps {
  /** Secret partagé avec le connecteur (== SERVICE_SECRET de mm-hubspot). Vide -> module non monté. */
  secret: string;
  /** Les fonctions de l'offre de l'espace. */
  fonctions(tenantId: string): Promise<ReadonlySet<Fonction>>;
  /** Le réglage « Répondre depuis HubSpot » de l'espace (`lireChoixHubspot`, lot 1bis). */
  reponseBranchee(tenantId: string): Promise<boolean>;
  inbox: {
    getConversationContext(conversationId: string, tenantId: string): Promise<{ waId: string; lastInboundAt: string | null; windowOpen: boolean } | null>;
    /** Les `n` plus récents, dans l'ordre chronologique (`PgInboxStore`). Ne filtre pas l'espace : le contexte passe avant. */
    getDerniersMessages(conversationId: string, n: number, avant?: { at: string; id: string }): Promise<ConversationMessage[]>;
    getControlOwner(tenantId: string, waId: string): Promise<ControlOwner>;
    /** `undefined` : conversation inconnue de l'espace. */
    getAssignee(tenantId: string, conversationId: string): Promise<string | null | undefined>;
  };
  /** Depuis quand la conversation attend une personne (`getEtatPassage`), `null` si personne n'attend. */
  escaladeeLe(tenantId: string, waId: string): Promise<Date | null>;
  /** Les membres de l'espace (`PgUserStore.list`) : l'adresse signée par HubSpot y désigne l'auteur. */
  membres(tenantId: string): Promise<Array<{ id: string; name: string | null; email: string; role: string; disabled: boolean; pending: boolean }>>;
  /** Le chemin d'envoi de la console, tel quel (`depsRepondre` de `src/index.ts`). */
  repondre: DepsRepondre;
  /** L'idempotence de `/v1/sends` (`PgApiIdempotencyStore`) : pose atomique, bail, jeton de garde. */
  idempotence: {
    claim(tenantId: string, key: string, empreinte: string): Promise<IdempotencyClaim>;
    complete(tenantId: string, key: string, jeton: string, sendId: string, response: unknown): Promise<boolean>;
    release(tenantId: string, key: string, jeton: string): Promise<void>;
  };
  /**
   * « Rendre la main » d'un appelant qui n'est pas la console : un contact STOP ou bloqué n'est jamais confié à l'agent de
   * Meta. Rendu à nos robots, il ne reçoit rien : ils relisent STOP avant d'écrire (`machineSeTaitParWaId`). L'outil MCP,
   * lui, refuse en plus ce geste hors du mode « équipe » pour le dire à un agent : la carte ne le fait pas (écart du lot 2).
   */
  fil: Pick<ControleDuFil, 'rendreLaMainSousConsentement'>;
  now?: () => number;
  windowMs?: number;
}

/** Le préfixe des trois routes : l'audit de latence les range avec l'Inbox (`groupeDeRoute`). */
export const PREFIXE_CONVERSATION_HUBSPOT = '/hubspot/conversation/';

/** Les messages d'une page de la carte : assez pour lire un échange, peu pour une carte. */
export const MESSAGES_PAR_PAGE = 20;

/**
 * Les clés d'idempotence de la carte vivent dans la table de `/v1/sends` sous ce préfixe, pour ne pas se mêler à celles
 * de l'API. Le préfixe n'est pas réservé (`cleIdempotence` accepte `hubspot:…`) : une collision ne pourrait venir que du
 * même espace, contre une clé de carte tirée au hasard, et ne ferait que refuser ou rejouer, jamais envoyer deux fois.
 */
const PREFIXE_CLE = 'hubspot:';

const UUID = z.string().uuid();
const adresse = z.string().trim().toLowerCase().email().max(320).nullable().default(null);

const corpsFil = z.object({
  tenantId: UUID,
  conversationId: UUID,
  auteurEmail: adresse,
  avant: z.string().min(1).max(200).nullable().default(null),
}).strict();

const corpsReponse = z.object({
  tenantId: UUID,
  conversationId: UUID,
  auteurEmail: adresse,
  texte: z.string().trim().min(1).max(TEXTE_MAX_CARACTERES),
  // Fabriquée par la carte pour CE message ; ses caractères deviennent une clé de base.
  cle: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
}).strict();

const corpsRendre = z.object({
  tenantId: UUID,
  conversationId: UUID,
  auteurEmail: adresse,
}).strict();

type WithRawBody = FastifyRequest & { rawBody?: Buffer };

/** La personne qui agit : le membre ACTIF de l'espace dont HubSpot a signé l'adresse, sinon personne (décision 6). */
interface Personne { acteur: ActeurConversation; auteur: string | null }

/**
 * Un refus du chemin d'envoi, traduit comme la route de la console (`POST .../reply`) : mêmes codes, mêmes phrases.
 * Les motifs qu'une réponse humaine n'atteint pas (STOP, porte « écrire en premier », format) sont écrits quand même :
 * sans branche explicite, un motif futur sortirait sous une raison fausse.
 */
function refusDeReponse(r: RefusReponse): { statut: number; corps: { error: string; code: string } } {
  switch (r.motif) {
    case 'conversation_inconnue': return { statut: 404, corps: { error: 'conversation inconnue', code: 'conversation_not_found' } };
    case 'fenetre_fermee': return { statut: 422, corps: { error: 'Fenêtre de 24 h fermée : seul un modèle peut partir, depuis la console Messaging Me.', code: 'window_closed' } };
    case 'aucun_numero': return { statut: 409, corps: { error: 'Aucun numéro WhatsApp n’est connecté à cet espace.', code: 'no_number' } };
    case 'contact_desabonne': return { statut: 409, corps: { error: 'Ce contact a demandé à ne plus recevoir de messages.', code: 'contact_desabonne' } };
    case 'application_indisponible': return { statut: 409, corps: { error: phraseApplicationIndisponible(r.raison), code: 'whatsapp_app_unavailable' } };
    case 'format_non_pris_en_charge': return { statut: 422, corps: { error: PHRASE_FORMAT_APPLICATION, code: 'unsupported_on_whatsapp_app' } };
    case 'premier_message': return { statut: 409, corps: { error: phrasePremierMessage(r.refus, 'api'), code: 'first_message_refused' } };
  }
}

export function registerHubspotConversation(app: FastifyInstance, deps: HubspotConversationDeps): void {
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

  /**
   * Les gardes communes aux trois routes, dans l'ordre : l'offre, le réglage, la conversation DANS l'espace (le seul
   * contrôle d'isolation : la connexion contourne la RLS), puis la personne. `null` : la réponse est déjà partie.
   */
  async function gardes(reply: FastifyReply, tenantId: string, conversationId: string, auteurEmail: string | null) {
    if (!(await deps.fonctions(tenantId)).has('inbox')) {
      reply.code(402).send(corpsRefusFonction('inbox'));
      return null;
    }
    if (!(await deps.reponseBranchee(tenantId))) {
      reply.code(403).send({ error: 'La réponse depuis HubSpot n’est pas branchée pour cet espace (Paramètres > Intégrations > HubSpot).', code: 'reponse_hubspot_eteinte' });
      return null;
    }
    const ctx = await deps.inbox.getConversationContext(conversationId, tenantId);
    const assignee = ctx ? await deps.inbox.getAssignee(tenantId, conversationId) : undefined;
    if (!ctx || assignee === undefined) {
      reply.code(404).send({ error: 'conversation inconnue', code: 'conversation_not_found' });
      return null;
    }
    // Lus une fois, et seulement s'il y a une adresse à reconnaître ou un affectataire à nommer.
    const membres = auteurEmail !== null || assignee !== null ? await deps.membres(tenantId) : [];
    return { ctx, assignee, membres, personne: personneDe(membres, auteurEmail) };
  }

  function personneDe(membres: Awaited<ReturnType<HubspotConversationDeps['membres']>>, auteurEmail: string | null): Personne {
    // Un membre désactivé ou qui n'a jamais accepté son invitation n'est personne : il ne signe rien, ne passe aucune affectation.
    const m = auteurEmail === null ? undefined : membres.find((u) => !u.disabled && !u.pending && u.email.toLowerCase() === auteurEmail);
    return m ? { acteur: { userId: m.id, role: m.role }, auteur: m.id } : { acteur: { userId: null, role: null }, auteur: null };
  }

  const refusAffectation = { error: 'Cette conversation est affectée à un autre membre de l’équipe.', code: 'assigned_to_other' };

  /** Rend la clé. Un échec ne lève pas (la réponse part déjà), il se trace : sans lui, « en cours » durerait le bail sans raison dite. */
  const liberer = (tenantId: string, key: string, jeton: string, conversationId: string): Promise<void> =>
    deps.idempotence.release(tenantId, key, jeton).catch((err: unknown) => {
      journaliser('error', 'hubspot_reponse_cle_non_liberee', { err, tenantId, conversationId });
    });

  app.post(`${PREFIXE_CONVERSATION_HUBSPOT}fil`, async (req, reply) => {
    if (!signee(req)) return reply.code(401).send({ error: 'invalid signature' });
    const lu = corpsFil.safeParse(req.body);
    if (!lu.success) return reply.code(400).send({ error: 'payload invalide' });
    const { tenantId, conversationId, auteurEmail, avant: brut } = lu.data;
    const avant = brut === null ? null : decoderCurseur(brut);
    if (brut !== null && avant === null) return reply.code(400).send({ error: 'avant illisible : repassez tel quel celui de la page précédente' });

    const g = await gardes(reply, tenantId, conversationId, auteurEmail);
    if (!g) return reply;
    const [lus, tenuPar, escaladeeLe, desabonne] = await Promise.all([
      // Un de plus que rendu : c'est lui qui dit s'il en reste avant, sans compter le fil entier.
      deps.inbox.getDerniersMessages(conversationId, MESSAGES_PAR_PAGE + 1, avant ?? undefined),
      deps.inbox.getControlOwner(tenantId, g.ctx.waId),
      deps.escaladeeLe(tenantId, g.ctx.waId),
      deps.repondre.estDesabonne(tenantId, g.ctx.waId),
    ]);
    const rendus = lus.slice(-MESSAGES_PAR_PAGE);
    const premier = rendus[0];
    const affecte = g.assignee === null ? null : g.membres.find((m) => m.id === g.assignee);
    return reply.code(200).send({
      conversationId,
      fenetreOuverte: g.ctx.windowOpen,
      dernierEntrantLe: g.ctx.lastInboundAt,
      tenuPar,
      escaladeeLe: escaladeeLe ? escaladeeLe.toISOString() : null,
      // Le nom, sinon la partie locale de l'adresse (la convention de `senderName`) : l'adresse entière d'un membre ne part
      // pas chez HubSpot, où le portail peut compter des personnes sans compte Messaging Me.
      affecteA: g.assignee === null ? null : { id: g.assignee, nom: affecte ? (affecte.name ?? affecte.email.split('@')[0] ?? null) : null },
      contactDesabonne: desabonne,
      // Ce que la carte propose à CETTE personne : les mêmes règles que la réponse, posées à nouveau à l'envoi.
      peutRepondre: !desabonne && peutEcrire(g.personne.acteur, g.assignee),
      messages: rendus.map((m) => ({
        id: m.id, direction: m.direction, type: m.type, texte: m.body, le: m.createdAt, auteur: m.senderName ?? null,
      })),
      // Le point d'où remonter : le plus ancien message rendu, à la microseconde (`curseur`, jamais `createdAt`).
      avant: lus.length > MESSAGES_PAR_PAGE && premier?.curseur ? encoderCurseur({ at: premier.curseur, id: premier.id }) : null,
    });
  });

  app.post(`${PREFIXE_CONVERSATION_HUBSPOT}repondre`, async (req, reply) => {
    if (!signee(req)) return reply.code(401).send({ error: 'invalid signature' });
    const lu = corpsReponse.safeParse(req.body);
    if (!lu.success) return reply.code(400).send({ error: 'payload invalide' });
    const { tenantId, conversationId, auteurEmail, texte, cle } = lu.data;

    const g = await gardes(reply, tenantId, conversationId, auteurEmail);
    if (!g) return reply;
    if (!peutEcrire(g.personne.acteur, g.assignee)) return reply.code(403).send(refusAffectation);
    /**
     * 🔴 HUBSPOT NE RÉPOND JAMAIS À UN CONTACT QUI A DIT STOP (décision de Julien, 2026-10-26, qui amende la décision 5
     * pour HubSpot seul). La console, elle, laisse un membre accuser réception d'un désabonnement ; ici, l'auteur peut
     * être une personne du portail sans compte, et sur la filière application rien d'autre (ni fenêtre de 24 h, ni porte
     * « écrire en premier ») n'arrêterait une réponse des semaines plus tard. Posée avant la clé : rien n'est réservé.
     */
    if (await deps.repondre.estDesabonne(tenantId, g.ctx.waId)) {
      return reply.code(409).send({ error: 'Ce contact a demandé à ne plus recevoir de messages : on ne lui répond pas depuis HubSpot.', code: 'contact_desabonne' });
    }

    /**
     * 🔴 UNE CLÉ, UN MESSAGE. La signature du connecteur se rejoue cinq minutes, et `hubspot.fetch` rejoue une fois sur
     * un 5xx : sans la clé, un rejeu enverrait deux fois au client. La même clé avec un autre texte est refusée ; la
     * même clé avec le même texte rend la réponse du premier envoi.
     */
    const key = `${PREFIXE_CLE}${cle}`;
    const pose = await deps.idempotence.claim(tenantId, key, empreinteCorps({ conversationId, texte, auteurEmail }));
    if (!pose.claimed) {
      if ('reused' in pose) return reply.code(422).send({ error: 'cette clé a déjà servi pour un autre message', code: 'idempotency_key_reused' });
      if ('pending' in pose) return reply.code(409).send({ error: 'ce message est en cours d’envoi : réessayez dans un instant', code: 'idempotency_key_in_progress' });
      return reply.code(200).send(pose.response);
    }
    let res: Awaited<ReturnType<typeof repondreDansLaFenetre>>;
    try {
      // « humain » : une personne écrit depuis HubSpot. Son identifiant signe le message quand elle est membre (décision 7).
      res = await repondreDansLaFenetre(deps.repondre, tenantId, conversationId, texte, g.personne.auteur, 'humain');
    } catch (err) {
      /**
       * 🔴 Un refus EXPLICITE de Meta (`MetaApiError`) n'a rien envoyé : la clé est rendue, un nouvel essai peut partir.
       * Toute autre erreur (délai, réseau, service de connexions) laisse un doute : Meta a peut-être pris le message. La
       * clé reste alors « en cours » jusqu'à son bail (`DUREE_CLE_EN_COURS_MAX_MS`), et un nouvel essai attend : mieux
       * vaut faire patienter quelques minutes qu'écrire deux fois au client (relecture du lot 2).
       */
      if (!(err instanceof MetaApiError)) throw err;
      await liberer(tenantId, key, pose.jeton, conversationId);
      // La phrase de Meta pour la personne (comme le gestionnaire commun), avec un code : la carte la montre telle quelle.
      const detail = (err.userMessage ?? err.message).replace(/\s+/g, ' ').trim().slice(0, 200);
      return reply.code(422).send({ error: `Meta a refusé le message : ${detail}`, code: 'meta_rejected' });
    }
    if ('refus' in res) {
      await liberer(tenantId, key, pose.jeton, conversationId);
      const r = refusDeReponse(res.refus);
      return reply.code(r.statut).send(r.corps);
    }
    // Inatteignable pour une réponse humaine (elle part toujours tout de suite), écrit pour qu'aucun résultat ne passe sans clé scellée.
    // `journal` : comme la console, `unrecorded` dit un message parti mais absent du fil de l'Inbox.
    const corps = 'differe' in res
      ? { differe: true, prevuLe: res.differe.prevuLe }
      : { messageId: res.messageId, journal: res.journal };
    await deps.idempotence.complete(tenantId, key, pose.jeton, randomUUID(), corps).catch((err: unknown) => {
      // Le message est parti : un scellement raté ne doit pas faire croire l'inverse. Le bail de la clé la libérera.
      journaliser('error', 'hubspot_reponse_cle_non_scellee', { err, tenantId, conversationId });
    });
    return reply.code(200).send(corps);
  });

  app.post(`${PREFIXE_CONVERSATION_HUBSPOT}rendre`, async (req, reply) => {
    if (!signee(req)) return reply.code(401).send({ error: 'invalid signature' });
    const lu = corpsRendre.safeParse(req.body);
    if (!lu.success) return reply.code(400).send({ error: 'payload invalide' });
    const { tenantId, conversationId, auteurEmail } = lu.data;

    const g = await gardes(reply, tenantId, conversationId, auteurEmail);
    if (!g) return reply;
    // Rendre la main à un robot une conversation qu'un collègue tient, c'est la lui retirer : la règle de la réponse.
    if (!peutEcrire(g.personne.acteur, g.assignee)) return reply.code(403).send(refusAffectation);

    // Comme la réponse : le membre, sinon personne, que la frise dit « par un accès sans compte collaborateur »
    // (`colonnesAuteur`). Jamais une cause « automatique » : c'est le geste d'une personne.
    const par: AuteurDuChangement = { collaborateur: g.personne.auteur };
    let detenteur: Awaited<ReturnType<ControleDuFil['rendreLaMainSousConsentement']>>;
    try {
      detenteur = await deps.fil.rendreLaMainSousConsentement(tenantId, g.ctx.waId, par);
    } catch (err) {
      // Comme la console : Meta a refusé le geste, et notre état n'a pas bougé.
      journaliser('error', 'hubspot_rendre_refuse_par_meta', { err, tenantId, conversationId });
      return reply.code(409).send(err instanceof AgentDeMetaGardeLeFil
        ? { error: 'L’agent de Meta garde la conversation : Meta a refusé de la lui reprendre. Réessayez dans un instant.', code: 'meta_refused' }
        : { error: 'Meta n’a pas repris la conversation. Elle reste à l’équipe, réessayez dans un instant.', code: 'meta_refused' });
    }
    if (detenteur === 'contact_muet') {
      return reply.code(409).send({ error: 'Ce contact a dit STOP ou est bloqué : la conversation n’est confiée à aucun robot.', code: 'contact_muet' });
    }
    if (detenteur === 'aucun_numero') {
      return reply.code(409).send({ error: 'Aucun numéro WhatsApp n’est connecté : la conversation reste à l’équipe.', code: 'no_number' });
    }
    return reply.code(200).send({ tenuPar: detenteur });
  });
}
