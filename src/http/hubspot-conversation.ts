import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { verifyRequest } from '../lib/signature';
import { journaliser } from '../lib/journal';
import type { Fonction } from '../offres/offres';
import { corpsRefusFonction } from '../offres/refus';
import { peutEcrire, type ActeurConversation } from '../inbox/assignment';
import { empreinte, repondreDansLaFenetre, type DepsRepondre, type RefusReponse } from '../inbox/repondre';
import { refuserTropDeRequetes } from '../auth/rate-limit';
import type { PlafondPartage } from '../auth/plafond-partage';
import type { AuteurDuChangement } from '../inbox/evenements';
import { AgentDeMetaGardeLeFil, type ControleDuFil } from '../inbox/fil';
import type { ConversationMessage, ControlOwner } from '../inbox/store.pg';
import { decoderCurseur, encoderCurseur } from '../api/conversations-v1';
import { empreinteCorps } from '../api/idempotence';
import type { IdempotencyClaim } from '../api/idempotency-store.pg';
import { PHRASE_FORMAT_APPLICATION, phraseApplicationIndisponible, phrasePremierMessage } from '../application/envoi';
import { TEXTE_MAX_CARACTERES } from '../traduction/traduire';
import { envoyerModeleDansLeFil } from '../inbox/envoi-operateur';
import { VALEUR_ACCEPTEE } from '../api/modele-envoi';
import {
  PHRASE_SANS_CONSENTEMENT, VALEURS_MAX, VALEUR_MAX_CARACTERES, enteteBornee, modelesPourLeContact, refusAvantEnvoi, refusDuModele,
  type DepsModelesHubspot, type RefusModele,
} from './hubspot-modeles';
import type { PgATraiterHubspot } from '../inbox/a-traiter-hubspot.pg';
import type { PhoneNumberRecord } from '../account/types';

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
 * amendée par Julien le 2026-10-26, voir la route de réponse), ni à un contact bloqué (sous-lot « relancer », décision B).
 * Chaque route lit l'offre (`inbox`) et le réglage « Répondre depuis HubSpot » (lot 1bis) : l'étape d'offre du
 * registre ne s'applique pas à une route signée.
 *
 * DEUX ROUTES DE PLUS POUR LA FENÊTRE FERMÉE (sous-lot « relancer », plan
 * `~/mm-hubspot/docs/2026-10-26-sous-lot-relancer-modele-plan.md`, décisions A à H validées par Julien le 2026-10-26) :
 * les modèles proposés pour un contact, et l'envoi de l'un d'eux, par le chemin d'un modèle de l'Inbox
 * (`envoyerModeleDansLeFil`), sous un réglage à part (« Envoyer des modèles depuis HubSpot »).
 *
 * UNE ROUTE DE PLUS POUR LA PAGE « MESSAGING ME » DE HUBSPOT (lot 4, plan
 * `~/mm-hubspot/docs/2026-10-27-lot4-page-messaging-me-plan.md`, décisions A à G validées par Julien le 2026-10-27) : les
 * conversations de l'espace qui attendent un humain. Elle ne vise aucune conversation : l'offre et le réglage d'abord,
 * puis la ligne (la synchro HubSpot du numéro, décision C), puis la personne, qui ne refuse rien (décision G) et ne sert
 * qu'à dire ce qu'elle peut faire de chaque ligne.
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
  /**
   * Le contact est-il bloqué (`isBlockedByWaId`) ? Le STOP se lit par `repondre.estDesabonne`. Bloqué, rien ne part depuis
   * HubSpot, ni réponse ni modèle (décision B du sous-lot « relancer »), comme pour nos robots (`machineSeTaitParWaId`).
   */
  estBloque(tenantId: string, waId: string): Promise<boolean>;
  /** L'envoi d'un modèle quand la fenêtre est fermée (sous-lot « relancer »). */
  modeles: DepsModelesHubspot;
  /** L'idempotence de `/v1/sends` (`PgApiIdempotencyStore`) : pose atomique, bail, jeton de garde. */
  idempotence: {
    claim(tenantId: string, key: string, empreinte: string): Promise<IdempotencyClaim>;
    complete(tenantId: string, key: string, jeton: string, sendId: string, response: unknown): Promise<boolean>;
    release(tenantId: string, key: string, jeton: string): Promise<void>;
    /** La clé est-elle encore à ce jeton, sans réponse ? Relu juste avant d'envoyer un modèle (le motif de `/v1/sends`). */
    possede(tenantId: string, key: string, jeton: string): Promise<boolean>;
  };
  /**
   * « Rendre la main » d'un appelant qui n'est pas la console : un contact STOP ou bloqué n'est jamais confié à l'agent de
   * Meta. Rendu à nos robots, il ne reçoit rien : ils relisent STOP avant d'écrire (`machineSeTaitParWaId`). L'outil MCP,
   * lui, refuse en plus ce geste hors du mode « équipe » pour le dire à un agent : la carte ne le fait pas (écart du lot 2).
   */
  fil: Pick<ControleDuFil, 'rendreLaMainSousConsentement'>;
  /**
   * Le plafond des réponses par personne et par espace (`HUBSPOT_REPONSES_PAR_MINUTE`, lot 3) : ces routes signées n'ont
   * pas le plafond par utilisateur de la console. Compté au total des copies ; base muette : laisse passer.
   */
  plafondReponses: Pick<PlafondPartage, 'consommer'>;
  /**
   * L'adresse de la conversation dans l'Inbox (`lienConversation` du socle, celle de la tâche et de l'analyse) : le lien
   * « Ouvrir dans la console » de la carte (lot 3), fenêtre fermée comprise, même sans analyse.
   */
  lienConversation: (conversationId: string) => string;
  /** L'état de la synchro HubSpot du numéro de l'espace (`etatLigneHubspot` sur `getPhoneNumber`, lot 4, décision C). */
  ligneHubspot(tenantId: string): Promise<EtatLigneHubspot>;
  /** Les conversations qui attendent un humain (`PgATraiterHubspot`, lot 4, décisions A et B). */
  aTraiter: Pick<PgATraiterHubspot, 'lister'>;
  now?: () => number;
  windowMs?: number;
}

/** La synchro HubSpot du numéro de l'espace : reliée, en pause, coupée, ou aucun numéro Cloud (filière application, espace neuf). */
export type EtatLigneHubspot = 'reliee' | 'pause' | 'coupee' | 'sans_numero';

/**
 * L'état de la ligne lu sur le numéro principal de l'espace, celui que la tâche du lot 1 lit (`getHubspotGateStatus`) :
 * une pause écrit `connected = false` ET pose sa date, une coupure ne pose rien.
 */
export function etatLigneHubspot(numero: Pick<PhoneNumberRecord, 'hubspotConnected' | 'hubspotPausedAt'> | null): EtatLigneHubspot {
  if (numero === null) return 'sans_numero';
  if (numero.hubspotConnected) return 'reliee';
  return numero.hubspotPausedAt !== null ? 'pause' : 'coupee';
}

/** Ce que la page dit d'une ligne qui n'est pas reliée : jamais une liste vide, qui se lirait « rien à traiter ». */
const PHRASES_LIGNE: Record<Exclude<EtatLigneHubspot, 'reliee'>, string> = {
  pause: 'La synchronisation HubSpot du numéro de cet espace est en pause (Tools > Intégrations > HubSpot).',
  coupee: 'Le numéro de cet espace n’est pas relié à HubSpot (Tools > Intégrations > HubSpot).',
  sans_numero: 'Cet espace n’a pas de numéro WhatsApp relié à HubSpot : la liste des conversations à traiter ne s’y affiche pas.',
};

/** Au plus autant de conversations par liste (décision B) : au-delà, la page renvoie à la console. */
export const A_TRAITER_MAX = 200;

/** Le préfixe des routes de la carte : l'audit de latence les range avec l'Inbox (`groupeDeRoute`). */
export const PREFIXE_CONVERSATION_HUBSPOT = '/hubspot/conversation/';

/** Les messages d'une page de la carte : assez pour lire un échange, peu pour une carte. */
export const MESSAGES_PAR_PAGE = 20;

/**
 * Les clés d'idempotence de la carte vivent dans la table de `/v1/sends` sous ce préfixe, pour ne pas se mêler à celles
 * de l'API. Le préfixe n'est pas réservé (`cleIdempotence` accepte `hubspot:…`) : une collision ne pourrait venir que du
 * même espace, contre une clé de carte tirée au hasard, et ne ferait que refuser ou rejouer, jamais envoyer deux fois.
 */
const PREFIXE_CLE = 'hubspot:';
/** Les clés de « rendre la main » (lot 3) : un autre préfixe, une réponse et un geste ne partagent jamais une clé. */
const PREFIXE_CLE_RENDRE = 'hubspot-rendre:';
/** Les clés d'un modèle (sous-lot « relancer ») : un troisième préfixe, pour la même raison. */
const PREFIXE_CLE_MODELE = 'hubspot-modele:';
/** Le scellement d'une clé, essayé trois fois, à 100 puis 200 ms : moins d'une seconde de plus, bien sous les 8 s du connecteur. */
const ESSAIS_SCELLEMENT = 3;
const PAUSE_SCELLEMENT_MS = 100;

/** Une clé fabriquée par la carte pour UN geste ; ses caractères deviennent une clé de base. */
const cleDeCarte = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);

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
  cle: cleDeCarte,
}).strict();

const corpsRendre = z.object({
  tenantId: UUID,
  conversationId: UUID,
  auteurEmail: adresse,
  // Une par clic (lot 3) : un rejeu après un 504 de la carte rend la réponse du premier geste au lieu de le refaire.
  cle: cleDeCarte,
}).strict();

const corpsModeles = z.object({
  tenantId: UUID,
  conversationId: UUID,
  auteurEmail: adresse,
}).strict();

/** La liste du lot 4 : un espace, la personne ; aucune conversation, aucun numéro. */
const corpsATraiter = z.object({
  tenantId: UUID,
  auteurEmail: adresse,
}).strict();

/**
 * Un modèle : son nom, sa langue et ses valeurs, rien d'autre. Sa catégorie, son nombre de variables et son en-tête se
 * relisent chez Meta (décision F) : la carte ne peut pas déclarer un marketing « Service ».
 */
const corpsModele = z.object({
  tenantId: UUID,
  conversationId: UUID,
  auteurEmail: adresse,
  name: z.string().min(1).max(512),
  language: z.string().min(1).max(20),
  // La forme ici, la règle de Meta (`VALEUR_ACCEPTEE`) dans la route : une valeur pré-remplie de la fiche qui la viole
  // doit rendre un refus codé que la carte montre, jamais un 400 nu que le connecteur ferait passer pour une panne.
  // La longueur de Meta aussi se juge dans la route (au-delà, un refus codé) ; ici une borne large, contre un corps démesuré.
  valeurs: z.array(z.string().min(1).max(4 * VALEUR_MAX_CARACTERES)).max(VALEURS_MAX),
  cle: cleDeCarte,
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
    case 'fenetre_fermee': return { statut: 422, corps: { error: 'Fenêtre de 24 h fermée : seul un modèle approuvé peut partir.', code: 'window_closed' } };
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
   * Les gardes de l'espace, communes à toutes les routes : l'offre, puis le réglage. `false` : la réponse est déjà partie.
   * Sorties de `gardes` pour la liste du lot 4, qui ne vise aucune conversation ; l'ordre et les refus n'ont pas changé.
   */
  async function gardesEspace(reply: FastifyReply, tenantId: string): Promise<boolean> {
    if (!(await deps.fonctions(tenantId)).has('inbox')) {
      reply.code(402).send(corpsRefusFonction('inbox'));
      return false;
    }
    if (!(await deps.reponseBranchee(tenantId))) {
      reply.code(403).send({ error: 'La réponse depuis HubSpot n’est pas branchée pour cet espace (Tools > Intégrations > HubSpot).', code: 'reponse_hubspot_eteinte' });
      return false;
    }
    return true;
  }

  /**
   * Les gardes communes aux routes d'une conversation, dans l'ordre : celles de l'espace, la conversation DANS l'espace
   * (le seul contrôle d'isolation : la connexion contourne la RLS), puis la personne. `null` : la réponse est déjà partie.
   */
  async function gardes(reply: FastifyReply, tenantId: string, conversationId: string, auteurEmail: string | null) {
    if (!(await gardesEspace(reply, tenantId))) return null;
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

  /**
   * L'affectataire tel que HubSpot le voit : son nom, sinon la partie locale de son adresse (la convention de
   * `senderName`). L'adresse entière d'un membre ne part pas chez HubSpot, où le portail peut compter des personnes sans
   * compte Messaging Me.
   */
  function affectataire(membres: Awaited<ReturnType<HubspotConversationDeps['membres']>>, id: string | null): { id: string; nom: string | null } | null {
    if (id === null) return null;
    const m = membres.find((u) => u.id === id);
    return { id, nom: m ? (m.name ?? m.email.split('@')[0] ?? null) : null };
  }

  const refusAffectation = { error: 'Cette conversation est affectée à un autre membre de l’équipe.', code: 'assigned_to_other' };

  /**
   * 🔴 STOP OU BLOQUÉ : RIEN NE PART DEPUIS HUBSPOT, ni réponse ni modèle (STOP : décision de Julien du 2026-10-26 ;
   * bloqué : décision B du sous-lot « relancer », la lecture de nos robots). Posée avant le plafond et la clé : rien n'est
   * réservé. `null` : le contact peut recevoir.
   */
  async function contactMuet(tenantId: string, waId: string): Promise<{ error: string; code: string } | null> {
    if (await deps.repondre.estDesabonne(tenantId, waId)) {
      return { error: 'Ce contact a demandé à ne plus recevoir de messages : on ne lui écrit pas depuis HubSpot.', code: 'contact_desabonne' };
    }
    if (await deps.estBloque(tenantId, waId)) return { error: 'Ce contact est bloqué : on ne lui écrit pas depuis HubSpot.', code: 'contact_bloque' };
    return null;
  }

  /**
   * Les gardes propres aux modèles, communes à la liste et à l'envoi, après les gardes communes : le réglage (décision E),
   * l'affectation, STOP ou bloqué, et la filière (l'application WhatsApp Business n'envoie pas de modèle). `null` : la
   * réponse est déjà partie.
   */
  async function gardesModele(reply: FastifyReply, tenantId: string, g: NonNullable<Awaited<ReturnType<typeof gardes>>>) {
    if (!(await deps.modeles.branches(tenantId))) {
      reply.code(403).send({ error: 'L’envoi de modèles depuis HubSpot n’est pas branché pour cet espace (Tools > Intégrations > HubSpot).', code: 'modeles_hubspot_eteints' });
      return null;
    }
    if (!peutEcrire(g.personne.acteur, g.assignee)) {
      reply.code(403).send(refusAffectation);
      return null;
    }
    const muet = await contactMuet(tenantId, g.ctx.waId);
    if (muet) {
      reply.code(409).send(muet);
      return null;
    }
    if ((await deps.repondre.application.filiere(tenantId)) === 'application') {
      reply.code(409).send({ error: 'Cet espace envoie par l’application WhatsApp Business, qui n’envoie pas de modèle : écrivez depuis la console.', code: 'whatsapp_app_no_template' });
      return null;
    }
    return g;
  }

  const refuser = (reply: FastifyReply, r: RefusModele) => reply.code(r.statut).send(r.corps);

  /**
   * Scelle la clé d'un geste FAIT (le message, le modèle est parti ; la main est rendue), avec trois essais. 🔴 Une clé
   * non scellée reste « en cours » jusqu'à son bail, puis se reprend : un nouvel essai de la carte, plus de cinq minutes
   * après un 504, referait le geste (relecture du sous-lot « relancer »). Les essais couvrent une base qui hoquette ; un
   * échec durable se trace, et ne change pas la réponse : le geste est fait.
   */
  async function sceller(tenantId: string, key: string, jeton: string, corps: unknown, conversationId: string, geste: string): Promise<void> {
    for (let essai = 1; ; essai += 1) {
      try {
        await deps.idempotence.complete(tenantId, key, jeton, randomUUID(), corps);
        return;
      } catch (err) {
        if (essai >= ESSAIS_SCELLEMENT) {
          journaliser('error', 'hubspot_cle_non_scellee', { err, tenantId, conversationId, geste, essais: essai });
          return;
        }
        await new Promise((resolve) => { setTimeout(resolve, PAUSE_SCELLEMENT_MS * essai); });
      }
    }
  }

  /** Rend la clé. Un échec ne lève pas (la réponse part déjà), il se trace : sans lui, « en cours » durerait le bail sans raison dite. */
  const liberer = (tenantId: string, key: string, jeton: string, conversationId: string): Promise<void> =>
    deps.idempotence.release(tenantId, key, jeton).catch((err: unknown) => {
      journaliser('error', 'hubspot_cle_non_liberee', { err, tenantId, conversationId, cle: key.split(':')[0] });
    });

  /**
   * Les conversations de l'espace qui attendent un humain (lot 4). Lecture seule, sans plafond, comme `fil` : le
   * connecteur la relit toutes les 30 s par page ouverte. 🔴 La personne ne refuse rien (décision G, la règle du lot 2 :
   * toute personne du portail lit), elle ne sert qu'à `peutRepondre` ; l'envoi rejuge tout.
   */
  app.post(`${PREFIXE_CONVERSATION_HUBSPOT}a-traiter`, async (req, reply) => {
    if (!signee(req)) return reply.code(401).send({ error: 'invalid signature' });
    const lu = corpsATraiter.safeParse(req.body);
    if (!lu.success) return reply.code(400).send({ error: 'payload invalide' });
    const { tenantId, auteurEmail } = lu.data;

    if (!(await gardesEspace(reply, tenantId))) return reply;
    const ligne = await deps.ligneHubspot(tenantId);
    if (ligne !== 'reliee') return reply.code(409).send({ error: PHRASES_LIGNE[ligne], code: 'ligne_non_reliee', raison: ligne });

    const { total, lignes } = await deps.aTraiter.lister(tenantId, A_TRAITER_MAX);
    // Lus une fois, et seulement s'il y a une adresse à reconnaître ou un affectataire à nommer.
    const membres = auteurEmail !== null || lignes.some((l) => l.affecteA !== null) ? await deps.membres(tenantId) : [];
    const { acteur } = personneDe(membres, auteurEmail);
    return reply.code(200).send({
      total,
      conversations: lignes.map((l) => ({
        ...l,
        affecteA: affectataire(membres, l.affecteA),
        // Ce que la page propose à CETTE personne ; STOP et bloqué sont déjà hors de la liste, l'envoi les relit.
        peutRepondre: peutEcrire(acteur, l.affecteA),
      })),
    });
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
    const [lus, tenuPar, escaladeeLe, desabonne, bloque] = await Promise.all([
      // Un de plus que rendu : c'est lui qui dit s'il en reste avant, sans compter le fil entier.
      deps.inbox.getDerniersMessages(conversationId, MESSAGES_PAR_PAGE + 1, avant ?? undefined),
      deps.inbox.getControlOwner(tenantId, g.ctx.waId),
      deps.escaladeeLe(tenantId, g.ctx.waId),
      deps.repondre.estDesabonne(tenantId, g.ctx.waId),
      deps.estBloque(tenantId, g.ctx.waId),
    ]);
    const rendus = lus.slice(-MESSAGES_PAR_PAGE);
    const premier = rendus[0];
    const lien = deps.lienConversation(conversationId);
    return reply.code(200).send({
      conversationId,
      fenetreOuverte: g.ctx.windowOpen,
      dernierEntrantLe: g.ctx.lastInboundAt,
      tenuPar,
      escaladeeLe: escaladeeLe ? escaladeeLe.toISOString() : null,
      affecteA: affectataire(g.membres, g.assignee),
      contactDesabonne: desabonne,
      contactBloque: bloque,
      // Ce que la carte propose à CETTE personne : les mêmes règles que la réponse et le modèle, posées à nouveau à l'envoi.
      peutRepondre: !desabonne && !bloque && peutEcrire(g.personne.acteur, g.assignee),
      // Comme l'analyse poussée (`buildEvent`) : seulement une adresse https, celle qu'une carte peut ouvrir.
      lien: lien.startsWith('https://') ? lien : null,
      messages: rendus.map((m) => ({
        id: m.id, direction: m.direction, type: m.type, texte: m.body, le: m.createdAt, auteur: m.senderName ?? null,
        // Le statut de Meta (`failed` : la carte dit un modèle non délivré au lieu de « Modèle envoyé », sous-lot « relancer »).
        statut: m.statut ?? null,
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
    const muet = await contactMuet(tenantId, g.ctx.waId);
    if (muet) return reply.code(409).send(muet);
    // Le plafond par personne (lot 3), avant la clé : une réponse refusée pour le débit ne réserve rien. La personne est
    // désignée par l'EMPREINTE de son adresse, jamais l'adresse en clair (la clé du compteur vit en base).
    const debit = await deps.plafondReponses.consommer(`${tenantId}:${empreinte(auteurEmail ?? 'personne')}`);
    if (!debit.accepte) {
      await refuserTropDeRequetes(reply, debit.attenteMs, 'Trop de réponses envoyées depuis HubSpot : patientez une minute.', 'rate_limited');
      return reply;
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
       * 🔴 Un refus EXPLICITE de Meta (`MetaApiError`), ou un numéro délié ou suspendu (levé AVANT Meta par la fabrique),
       * n'a rien envoyé : la clé est rendue, un nouvel essai peut partir (`refusAvantEnvoi`, sous-lot « relancer »).
       * Toute autre erreur (délai, réseau, service de connexions) laisse un doute : Meta a peut-être pris le message. La
       * clé reste alors « en cours » jusqu'à son bail (`DUREE_CLE_EN_COURS_MAX_MS`), et un nouvel essai attend : mieux
       * vaut faire patienter quelques minutes qu'écrire deux fois au client (relecture du lot 2).
       */
      const refus = refusAvantEnvoi(err);
      if (!refus) throw err;
      await liberer(tenantId, key, pose.jeton, conversationId);
      return reply.code(refus.statut).send(refus.corps);
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
    await sceller(tenantId, key, pose.jeton, corps, conversationId, 'repondre');
    return reply.code(200).send(corps);
  });

  app.post(`${PREFIXE_CONVERSATION_HUBSPOT}rendre`, async (req, reply) => {
    if (!signee(req)) return reply.code(401).send({ error: 'invalid signature' });
    const lu = corpsRendre.safeParse(req.body);
    if (!lu.success) return reply.code(400).send({ error: 'payload invalide' });
    const { tenantId, conversationId, auteurEmail, cle } = lu.data;

    const g = await gardes(reply, tenantId, conversationId, auteurEmail);
    if (!g) return reply;
    // Rendre la main à un robot une conversation qu'un collègue tient, c'est la lui retirer : la règle de la réponse.
    if (!peutEcrire(g.personne.acteur, g.assignee)) return reply.code(403).send(refusAffectation);

    /**
     * 🔴 UNE CLÉ, UN GESTE (lot 3, relecture du lot 2). Au-delà de 8 s, le connecteur rend 504 et `hubspot.fetch` rejoue :
     * le second appel trouvait l'agent de Meta et réécrivait le fil. Même clé : la réponse du premier geste. Un geste
     * qui n'a rien changé (refusé par Meta, contact muet, aucun numéro) rend la clé.
     */
    const key = `${PREFIXE_CLE_RENDRE}${cle}`;
    const pose = await deps.idempotence.claim(tenantId, key, empreinteCorps({ conversationId, auteurEmail }));
    if (!pose.claimed) {
      if ('reused' in pose) return reply.code(422).send({ error: 'cette clé a déjà servi pour une autre conversation', code: 'idempotency_key_reused' });
      if ('pending' in pose) return reply.code(409).send({ error: 'ce geste est en cours : réessayez dans un instant', code: 'idempotency_key_in_progress' });
      return reply.code(200).send(pose.response);
    }

    // Comme la réponse : le membre, sinon personne, que la frise dit « par un accès sans compte collaborateur »
    // (`colonnesAuteur`). Jamais une cause « automatique » : c'est le geste d'une personne.
    const par: AuteurDuChangement = { collaborateur: g.personne.auteur };
    let detenteur: Awaited<ReturnType<ControleDuFil['rendreLaMainSousConsentement']>>;
    try {
      detenteur = await deps.fil.rendreLaMainSousConsentement(tenantId, g.ctx.waId, par);
    } catch (err) {
      // Comme la console : Meta a refusé le geste, et notre état n'a pas bougé.
      journaliser('error', 'hubspot_rendre_refuse_par_meta', { err, tenantId, conversationId });
      await liberer(tenantId, key, pose.jeton, conversationId);
      return reply.code(409).send(err instanceof AgentDeMetaGardeLeFil
        ? { error: 'L’agent de Meta garde la conversation : Meta a refusé de la lui reprendre. Réessayez dans un instant.', code: 'meta_refused' }
        : { error: 'Meta n’a pas repris la conversation. Elle reste à l’équipe, réessayez dans un instant.', code: 'meta_refused' });
    }
    if (detenteur === 'contact_muet') {
      await liberer(tenantId, key, pose.jeton, conversationId);
      return reply.code(409).send({ error: 'Ce contact a dit STOP ou est bloqué : la conversation n’est confiée à aucun robot.', code: 'contact_muet' });
    }
    if (detenteur === 'aucun_numero') {
      await liberer(tenantId, key, pose.jeton, conversationId);
      return reply.code(409).send({ error: 'Aucun numéro WhatsApp n’est connecté : la conversation reste à l’équipe.', code: 'no_number' });
    }
    const corps = { tenuPar: detenteur };
    await sceller(tenantId, key, pose.jeton, corps, conversationId, 'rendre');
    return reply.code(200).send(corps);
  });

  /**
   * Les modèles que la carte propose pour CE contact (décisions C et F) : le catalogue de `GET /v1/templates` sans
   * carrousel, le marketing grisé pour un contact sans accord, les valeurs pré-remplies depuis la fiche. La fiche et les
   * indices sont lus une fois pour toute la liste.
   */
  app.post(`${PREFIXE_CONVERSATION_HUBSPOT}modeles`, async (req, reply) => {
    if (!signee(req)) return reply.code(401).send({ error: 'invalid signature' });
    const lu = corpsModeles.safeParse(req.body);
    if (!lu.success) return reply.code(400).send({ error: 'payload invalide' });
    const { tenantId, conversationId, auteurEmail } = lu.data;

    const g0 = await gardes(reply, tenantId, conversationId, auteurEmail);
    if (!g0) return reply;
    const g = await gardesModele(reply, tenantId, g0);
    if (!g) return reply;
    const [templates, indices, fiche] = await Promise.all([
      deps.modeles.catalogue(tenantId),
      deps.modeles.indices(tenantId),
      deps.modeles.fiche(tenantId, g.ctx.waId),
    ]);
    // Un contact hors base (fiche effacée depuis l'arrivée de la conversation) : consentement inconnu, rien à pré-remplir.
    const contact = fiche ?? { optIn: 'unknown', fiche: {} };
    return reply.code(200).send({ modeles: modelesPourLeContact(templates, indices, contact, new Date(now())) });
  });

  /**
   * 🔴 ENVOYER UN MODÈLE DEPUIS HUBSPOT (décisions A à H). Dans cet ordre : les gardes, le modèle relu chez Meta (jamais
   * reçu de la carte), le consentement, le plafond, l'en-tête préparé et BORNÉ, puis seulement la clé, relue juste avant
   * l'envoi. Tout ce qui peut traîner se fait avant la clé : passé son bail, une clé « en cours » se reprend, et une
   * préparation lente aurait fait partir deux modèles (relecture du plan, le rouge).
   */
  app.post(`${PREFIXE_CONVERSATION_HUBSPOT}modele`, async (req, reply) => {
    if (!signee(req)) return reply.code(401).send({ error: 'invalid signature' });
    const lu = corpsModele.safeParse(req.body);
    if (!lu.success) return reply.code(400).send({ error: 'payload invalide' });
    const { tenantId, conversationId, auteurEmail, name, language, valeurs, cle } = lu.data;

    const g0 = await gardes(reply, tenantId, conversationId, auteurEmail);
    if (!g0) return reply;
    const g = await gardesModele(reply, tenantId, g0);
    if (!g) return reply;

    const modele = await deps.modeles.lire(tenantId, name, language);
    const juge = refusDuModele(modele, valeurs.length);
    if ('statut' in juge) return refuser(reply, juge);
    const trop = valeurs.findIndex((v) => v.length > VALEUR_MAX_CARACTERES);
    if (trop >= 0) {
      return reply.code(422).send({
        error: `La valeur de la variable {{${trop + 1}}} dépasse ${VALEUR_MAX_CARACTERES} caractères : Meta la refuserait.`,
        code: 'invalid_value',
      });
    }
    const interdite = valeurs.findIndex((v) => !VALEUR_ACCEPTEE.test(v));
    if (interdite >= 0) {
      return reply.code(422).send({
        error: `La valeur de la variable {{${interdite + 1}}} contient un retour à la ligne, une tabulation ou plus de quatre espaces de suite : Meta la refuserait.`,
        code: 'invalid_value',
      });
    }
    if (juge.categorie === 'marketing') {
      // Décision C : un marketing ne part qu'à un contact qui a donné son accord, la règle des campagnes et de l'API.
      const fiche = await deps.modeles.fiche(tenantId, g.ctx.waId);
      if (fiche?.optIn !== 'opted_in') return reply.code(409).send({ error: PHRASE_SANS_CONSENTEMENT, code: 'no_consent' });
    }

    let enteteId: string | undefined;
    if (modele.entete) {
      const prepare = await enteteBornee(deps.modeles, tenantId, modele.entete);
      if ('statut' in prepare) return refuser(reply, prepare);
      enteteId = prepare.mediaId;
    }

    const key = `${PREFIXE_CLE_MODELE}${cle}`;
    const pose = await deps.idempotence.claim(tenantId, key, empreinteCorps({ conversationId, name, language, valeurs, auteurEmail }));
    if (!pose.claimed) {
      if ('reused' in pose) return reply.code(422).send({ error: 'cette clé a déjà servi pour un autre envoi', code: 'idempotency_key_reused' });
      if ('pending' in pose) return reply.code(409).send({ error: 'ce modèle est en cours d’envoi : réessayez dans un instant', code: 'idempotency_key_in_progress' });
      return reply.code(200).send(pose.response);
    }
    // Le plafond APRÈS la pose (relecture du lot) : le rejeu d'un envoi déjà fait rend sa réponse ci-dessus sans compter,
    // et un refus pour le débit rend la clé, rien n'est parti.
    const debit = await deps.modeles.plafond.consommer(`${tenantId}:${empreinte(auteurEmail ?? 'personne')}`);
    if (!debit.accepte) {
      await liberer(tenantId, key, pose.jeton, conversationId);
      await refuserTropDeRequetes(reply, debit.attenteMs, 'Trop de modèles envoyés depuis HubSpot : patientez une minute.', 'rate_limited');
      return reply;
    }
    // Un filet, pas la garde principale (elle est d'avoir tout ce qui traîne avant la pose) : une clé reprise entre la pose
    // et ici, si le processus s'était figé plus que son bail, ne fait rien partir.
    if (!(await deps.idempotence.possede(tenantId, key, pose.jeton))) {
      return reply.code(409).send({ error: 'ce modèle est en cours d’envoi : réessayez dans un instant', code: 'idempotency_key_in_progress' });
    }
    /**
     * 🔴 STOP OU BLOQUÉ, RELU AU DERNIER MOMENT (décision B, relecture du lot). La lecture des gardes précède la relecture
     * du modèle, le plafond et l'en-tête (quelques secondes) ; `envoyerModeleDansLeFil` ne relit que le STOP, et laisse
     * partir un Service (la règle de la console). Un STOP ou un blocage arrivé entre-temps rend la clé : rien ne part.
     */
    const muetMaintenant = await contactMuet(tenantId, g.ctx.waId);
    if (muetMaintenant) {
      await liberer(tenantId, key, pose.jeton, conversationId);
      return reply.code(409).send(muetMaintenant);
    }

    let res: Awaited<ReturnType<typeof envoyerModeleDansLeFil>>;
    try {
      // « humain » par le chemin de l'Inbox : il prend le fil, signé du membre, et clôt l'escalade (décision A).
      res = await envoyerModeleDansLeFil(deps.modeles.envoi, tenantId, { conversationId, waId: g.ctx.waId }, {
        name, language, bodyParams: valeurs, templateCategory: juge.categorie,
        ...(enteteId && modele.entete ? { headerMediaId: enteteId, headerFormat: modele.entete.format } : {}),
      }, g.personne.auteur);
    } catch (err) {
      // Le même partage que la réponse : un refus qui n'a rien envoyé rend la clé, un doute la garde.
      const refus = refusAvantEnvoi(err);
      if (!refus) throw err;
      await liberer(tenantId, key, pose.jeton, conversationId);
      return refuser(reply, refus);
    }
    if (!res.ok) {
      await liberer(tenantId, key, pose.jeton, conversationId);
      // Chaque refus porte un code, que le connecteur transmet tel quel (sans code, il deviendrait un 502 « réessayez »).
      if (res.statut === 400) return reply.code(409).send({ error: 'Aucun numéro WhatsApp n’est connecté à cet espace.', code: 'no_number' });
      return reply.code(res.statut).send({ error: res.error, code: res.code ?? 'template_refused' });
    }
    const corps = { messageId: res.messageId, journal: res.journal };
    await sceller(tenantId, key, pose.jeton, corps, conversationId, 'modele');
    return reply.code(200).send(corps);
  });
}
