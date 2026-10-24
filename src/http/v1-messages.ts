import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Guard } from '../auth/middleware';
import {
  empreinte, minuteUtc, reponseDuPremier, repondreAvecUnMessage, repondreDansLaFenetre, telephoneDuWaId,
  type DepsRepondre, type HorsFenetre, type RefusReponse, type ResultatReponse,
} from '../inbox/repondre';
import { PHRASE_FORMAT_APPLICATION, phraseApplicationIndisponible, phrasePremierMessage } from '../application/envoi';
import type { DemandePremierMessage, RefusPremier } from '../application/premier-message';
import { apercuDuMessage, corpsPourMeta, schemaMessageMeta } from '../api/message-meta';
import { schemaMessageWhatsapp } from '../api/contrat-public';
import { compterOuRefuser, type ApiUsageGuard } from '../api/usage-guard';
import { STATUT_PAR_CODE, refuser, type CodeApi } from '../api/erreurs';
import { STATUT_REFUS_OFFRE, adresseOffre } from '../offres/refus';
import { NumeroBloqueError } from '../meta/numero-delie';
import { MetaApiError } from '../meta/errors';
import { MESSAGE_RESOLUTION, normaliserCles, type ClesFiche, type ModeCreation, type ResolutionFiche } from '../api/fiche';
import { messageDeForme } from '../api/forme';
import type { FilDuContact } from '../inbox/store.pg';
import type { EtatJournalSortant } from '../inbox/journal-sortant';

/**
 * API publique /v1 des messages dans la fenêtre de service de 24 h : `POST /v1/messages/whatsapp`, un texte, à une
 * fiche (`contactId`, `externalId`, `phone` ou `bsuid`), et `POST /v1/messages` (lot 13, domaine 2), le corps de Meta
 * tel quel (`src/api/message-meta.ts`). Les deux partagent leurs étapes. Le pendant RCS vit dans `v1-messages-rcs.ts`.
 * 🔴 Aucune logique d'envoi à elles : la fenêtre, le désabonnement, l'envoi et la trace dans l'Inbox vivent dans
 * `repondreAvec` (`src/inbox/repondre.ts`), partagé avec la console et le MCP.
 * La fiche bloquée est écartée par `filDuContact` (même fragment `CIBLE_DU_CONTACT_SQL` que le mini-CRM). Le fil
 * est cherché, jamais créé : sans fil, la fenêtre est fermée par construction (422 `window_closed`, rien d'écrit).
 * Elle ne crée jamais de fiche (`creer: 'jamais'`), mais rattache une clé neuve à la fiche trouvée même quand le
 * message est ensuite refusé (figé par `tests/v1-messages.test.ts`). Aucune clé d'idempotence, comme la barre de
 * réponse de l'Inbox.
 * 🔴 SUR LA FILIÈRE APPLICATION (numéro relié par QR code, plan 2026-10-23, tâche 4), une personne sans fil, ou hors des
 * 24 heures, passe par la porte « écrire en premier » (`enfilerPremierMessage`). Depuis le 2026-10-24, elle ne laisse
 * passer qu'une RÉPONSE différée à une personne qui nous a écrit (le fil a un message reçu), comptée dans les messages du
 * mois et espacée : 202, le message en file. Une personne sans fil, ou sans fiche, désignée par son numéro, n'a jamais
 * écrit : la porte refuse (`premier_contact`, 422 `window_closed` et sa phrase), et `consent` n'y change rien. La clé de la
 * porte est le numéro, le texte et la minute : le même appel rejoué dans la minute ne met qu'un message en file. La
 * filière API ne change pas.
 */
export interface V1MessagesRouteDeps {
  /**
   * 🔴 Les dépendances de `repondreDansLaFenetre`, transmises d'un seul objet, jamais recopiées champ par champ :
   * un `Pick<>` recopié pour être retransmis dérive, et la capacité perdue serait `estDesabonne`.
   */
  repondre: DepsRepondre;
  /** La résolution de fiche partagée, liée à ses dépendances par le câblage. */
  resoudreFiche(tenantId: string, cles: ClesFiche, opts: { creer: ModeCreation }): Promise<ResolutionFiche>;
  inbox: {
    /**
     * Le fil de cette fiche, cherché sans être créé. `injoignable` = fiche supprimée, bloquée, ou sans identité
     * joignable ; `sans_fil` = elle n'a jamais écrit.
     */
    filDuContact(tenantId: string, contactId: string): Promise<FilDuContact>;
  };
  /** Le garde d'usage, injecté au bootstrap. Requis, comme sur les autres modules /v1. */
  usage: ApiUsageGuard;
  /**
   * L'espace est-il en mode « mon application répond » (lot 12, B) ? Ses réponses WhatsApp sortent alors du quota du
   * jour (décision de Julien du 2026-10-08) : cette route ne fait que répondre dans la fenêtre de 24 h, jamais un envoi.
   */
  enModeApplication(tenantId: string): Promise<boolean>;
  /**
   * L'envoi d'un message au format de Meta (`POST /v1/messages`, lot 13, domaine 2) : le client Meta de l'espace
   * (`MetaClient.sendMessage`), le contenu déjà validé. Requis : la route n'a pas de sens sans lui.
   */
  envoyerMessage(tenantId: string, phoneNumberId: string, to: string, corps: Record<string, unknown>): Promise<string>;
}

/** Le refus d'une fenêtre fermée : un fil sans entrant récent, ou pas de fil du tout (le même cas pour Meta). */
const FENETRE_FERMEE = 'fenêtre de 24 h fermée : cette personne n’a pas écrit récemment. Utilisez un template (POST /v1/sends).';

export const INCONNUE_POUR_UN_MESSAGE = 'aucune fiche pour cette personne : un message simple ne crée pas de fiche, un envoi (POST /v1/sends) le fait';

/**
 * La réponse 200 des deux routes de message simple, typée pour que la documentation la suive
 * (`tests/api-exemples.test.ts`). `conversationId` vaut `null` dans un seul cas, en RCS : le message est parti
 * mais le fil n'a pas pu être ouvert ensuite. La route WhatsApp trouve le fil avant d'envoyer.
 */
export interface ReponseMessageSimple {
  messageId: string;
  conversationId: string | null;
  channel: 'whatsapp' | 'rcs';
  journal: EtatJournalSortant;
}

/**
 * La réponse 202 de `POST /v1/messages/whatsapp` sur un numéro relié par QR code (plan 2026-10-23, tâche 4) : la réponse
 * hors des 24 heures est EN FILE, rien n'est encore parti. `id` : celui du message en file, jamais celui de WhatsApp ;
 * `scheduledAt` : son départ prévu ; `conversationId` : le fil. `null` reste dans le contrat publié, mais n'est plus
 * rendu depuis le 2026-10-24 : sans fil, la personne n'a jamais écrit, et la porte refuse.
 */
export interface ReponseMessageEnFile {
  status: 'queued';
  id: string;
  scheduledAt: string;
  conversationId: string | null;
  channel: 'whatsapp';
}

/** Où écrire : le fil trouvé, ou, sur la filière application, un premier message vers ce numéro (`null` : aucun connu). */
type Destination = { etat: 'fil'; conversationId: string; waId: string } | { etat: 'premier'; telephone: string | null };

/**
 * 🔴 L'espace vient de `req.auth` (posé par `makeRequireApiKey`), jamais de l'URL ni du corps.
 * Garde attendue : `[makeRequireApiKey, requireScope('sends:create')]`. Pas de droit neuf (les droits d'une clé
 * se fixent à sa création) : une clé qui déclenche un template peut écrire un texte libre, borné par la fenêtre
 * de 24 h et par le désabonnement.
 */
export function registerV1Messages(app: FastifyInstance, deps: V1MessagesRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  /**
   * Les étapes communes aux deux routes, dans leur ordre : les clés (défaut de forme avant le compteur), le compte (un
   * corps malformé n'a demandé aucun travail ; en mode « mon application répond », au plafond d'appels mais jamais au
   * quota du jour), la fiche (jamais créée), puis le fil (cherché, jamais créé). `null` : la réponse est déjà partie.
   * `ecrirePremier` (le texte seulement) : sur la filière application, une personne sans fil, ou sans fiche mais désignée
   * par son numéro, va à la porte, qui la refuse (elle n'a jamais écrit) ; la filière n'est lue que dans ces deux cas,
   * jamais sur le chemin d'un fil.
   */
  const surApplication = async (tenantId: string): Promise<boolean> => (await deps.repondre.application.filiere(tenantId)) === 'application';
  const jusquAuFil = async (
    req: FastifyRequest, reply: FastifyReply, tenantId: string, cles: ClesFiche, ecrirePremier: boolean,
  ): Promise<Destination | null> => {
    const n = normaliserCles(cles);
    if (!n.ok) { refuser(reply, STATUT_PAR_CODE[n.code], n.code, MESSAGE_RESOLUTION[n.code]); return null; }
    const operation = (await deps.enModeApplication(tenantId)) ? 'messages.reponse_application' : 'messages.send';
    if (!await compterOuRefuser(deps.usage, req, reply, operation)) return null;
    const fiche = await deps.resoudreFiche(tenantId, cles, { creer: 'jamais' });
    if (!fiche.ok) {
      // Une personne sans fiche, nommée par son numéro et sans `contactId` (un identifiant inconnu reste inconnu) : la
      // porte la juge, et dit pourquoi elle refuse, avec la phrase de ce numéro.
      const numero = n.cles.contactId === undefined ? n.cles.phoneE164 : undefined;
      if (ecrirePremier && fiche.code === 'unknown_contact' && numero !== undefined && await surApplication(tenantId)) {
        return { etat: 'premier', telephone: numero.replace(/[^0-9]/g, '') };
      }
      const message = fiche.code === 'unknown_contact' ? INCONNUE_POUR_UN_MESSAGE : MESSAGE_RESOLUTION[fiche.code];
      refuser(reply, STATUT_PAR_CODE[fiche.code], fiche.code, message);
      return null;
    }
    const fil = await deps.inbox.filDuContact(tenantId, fiche.contactId);
    if (fil.etat === 'injoignable') { refuser(reply, 409, 'blocked_contact', 'cette fiche est bloquée, supprimée, ou sans adresse WhatsApp'); return null; }
    if (fil.etat === 'sans_fil') {
      if (ecrirePremier && await surApplication(tenantId)) return { etat: 'premier', telephone: telephoneDuWaId(fil.waId) };
      refuser(reply, 422, 'window_closed', FENETRE_FERMEE);
      return null;
    }
    return { etat: 'fil', conversationId: fil.conversationId, waId: fil.waId };
  };

  /**
   * L'envoi, puis la réponse. `auteur` à `null` : personne ne signe ce message dans l'Inbox ; `origine` à `'api'`. Le
   * numéro délié sort du point de passage des envois en exception : on l'attrape ici pour lui donner sa phrase (le
   * gestionnaire commun de `/v1` le traduirait aussi, depuis le lot 17).
   */
  const envoyerEtRepondre = async (reply: FastifyReply, conversationId: string | null, envoi: () => Promise<ResultatReponse>): Promise<FastifyReply> => {
    let res: ResultatReponse;
    try {
      res = await envoi();
    } catch (err) {
      if (err instanceof NumeroBloqueError) {
        return refuser(reply, 409, err.motif === 'numero_delie' ? 'number_unlinked' : 'number_suspended', err.message);
      }
      // Meta refuse le message lui-même (un contenu qu'il n'accepte pas) : 422 avec SON motif, son code et le numéro de
      // Meta. Le reste (jeton refusé, limite ou panne passagère) est classé par le gestionnaire commun de `/v1`, comme
      // partout (`src/api/refus-meta.ts`).
      if (err instanceof MetaApiError && err.httpStatus >= 400 && err.httpStatus < 500 && !err.retryable && err.httpStatus !== 401 && err.code !== 190) {
        return refuser(reply, 422, 'meta_rejected', `Meta a refusé le message : ${(err.userMessage ?? err.message).slice(0, 300)}`, { metaCode: err.code ?? null });
      }
      throw err;
    }
    if ('refus' in res) return refuserLaReponse(reply, res.refus);
    // En file (filière application, hors des 24 heures) : rien n'est parti, le job l'enverra à `scheduledAt`.
    if ('differe' in res) {
      return reply.code(202).send({
        status: 'queued', id: res.differe.id, scheduledAt: res.differe.prevuLe, conversationId, channel: 'whatsapp',
      } satisfies ReponseMessageEnFile);
    }
    return reply.code(200).send({ messageId: res.messageId, conversationId, channel: 'whatsapp', journal: res.journal } satisfies ReponseMessageSimple);
  };

  app.post('/v1/messages/whatsapp', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    const tenantId = req.auth.tenantId;
    const lu = schemaMessageWhatsapp.safeParse(req.body);
    if (!lu.success) return refuser(reply, 400, 'invalid_body', messageDeForme(lu.error));
    const { text, consent, consentSource, ...cles } = lu.data;
    const destination = await jusquAuFil(req, reply, tenantId, cles, true);
    if (destination === null) return reply;
    /**
     * Ce qui part à la porte (filière application) : l'origine `api`, le consentement déclaré dans l'appel (source
     * absente : `api`, comme `POST /v1/sends`), et la clé du numéro, du texte et de la minute, la même avec ou sans fil.
     * Depuis le 2026-10-24, la porte refuse toute demande qui écrirait en premier, déclarée ou non ; une réponse à une
     * personne qui a écrit y passe en mode `conversation` (`repondreAvec`), sans que le consentement déclaré compte.
     */
    const consentement: DemandePremierMessage['consentement'] = consent === 'opted_in'
      ? { mode: 'declare', source: consentSource ?? 'api' }
      : { mode: 'exige_opt_in' };
    const cle = (telephone: string): string => `api:${empreinte(`${telephone}\n${text}`)}:${minuteUtc(new Date())}`;
    if (destination.etat === 'premier') {
      const { telephone } = destination;
      return envoyerEtRepondre(reply, null, async () => (telephone === null
        ? { refus: { motif: 'premier_message', refus: 'sans_telephone' } }
        : reponseDuPremier(await deps.repondre.ecrirePremier({
          tenantId, cle: cle(telephone), telephone, texte: text, origine: 'api', reference: null, consentement,
        }))));
    }
    const { conversationId } = destination;
    // Hors des 24 heures sur la filière application, `repondreDansLaFenetre` passe par la porte avec ceci ; sinon, ignoré.
    const horsFenetre: HorsFenetre = { origine: 'api', consentement, cle: cle(destination.waId) };
    return envoyerEtRepondre(reply, conversationId, () => repondreDansLaFenetre(deps.repondre, tenantId, conversationId, text, null, 'api', null, horsFenetre));
  });

  /**
   * `POST /v1/messages` (lot 13, domaine 2) : le corps de Meta tel quel, pour les types courants, dans la fenêtre de 24 h.
   * `to` est le numéro, retrouvé sur sa fiche ; `contactId` ou `externalId` peuvent le remplacer. Mêmes étapes, mêmes
   * gardes et mêmes refus que le texte : seul le contenu change. Le corps validé part TEL QUEL (`corpsPourMeta`).
   */
  app.post('/v1/messages', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    const tenantId = req.auth.tenantId;
    const lu = schemaMessageMeta.safeParse(req.body);
    if (!lu.success) return refuser(reply, 400, 'invalid_body', messageDeForme(lu.error));
    const { to, contactId, externalId, messaging_product: _p, recipient_type: _r, ...contenu } = lu.data;
    // `to` est international (indicatif compris, comme chez Meta) : le « + » le dit à la résolution, qui lirait sinon un
    // numéro sans « + » comme un numéro français.
    const cles: ClesFiche = {
      ...(to !== undefined ? { phone: to.startsWith('+') ? to : `+${to}` } : {}),
      ...(contactId !== undefined ? { contactId } : {}), ...(externalId !== undefined ? { externalId } : {}),
    };
    const destination = await jusquAuFil(req, reply, tenantId, cles, false);
    if (destination === null) return reply;
    // Sans `ecrirePremier`, seul un fil est rendu : le refus d'une personne sans fil, par construction.
    if (destination.etat !== 'fil') return refuser(reply, 422, 'window_closed', FENETRE_FERMEE);
    const { conversationId } = destination;
    const message = { corps: corpsPourMeta(contenu), trace: apercuDuMessage(contenu), type: contenu.type };
    return envoyerEtRepondre(reply, conversationId, () => repondreAvecUnMessage(deps.repondre, deps.envoyerMessage, tenantId, conversationId, message, null, 'api'));
  });
}

/** Le refus d'une réponse dans la fenêtre, en code de l'API publique. Exhaustif : un motif ajouté demain ne compile pas. */
function refuserLaReponse(reply: FastifyReply, refus: RefusReponse): FastifyReply {
  {
    const { motif } = refus;
    switch (motif) {
      case 'contact_desabonne':
        return refuser(reply, 409, 'opted_out', 'cette personne a demandé à ne plus recevoir de messages');
      case 'aucun_numero':
        return refuser(reply, 409, 'no_whatsapp_number', 'aucun numéro WhatsApp sur cet espace');
      case 'conversation_inconnue':
        // Inatteignable : le fil vient d'être trouvé, avec le même espace. Traité quand même, jamais rangé
        // sous « fenêtre fermée », qui enverrait l'intégrateur faire approuver un template pour rien.
        return refuser(reply, 404, 'unknown_contact', 'conversation introuvable pour cette fiche');
      case 'fenetre_fermee':
        return refuser(reply, 422, 'window_closed', FENETRE_FERMEE);
      // La filière application : des codes existants, pour ne pas changer le contrat publié (SDK, OpenAPI). Le service de
      // connexions en panne n'est pas un refus : une erreur, que l'intégrateur rejoue.
      case 'application_indisponible':
        if (refus.raison === 'service_injoignable') throw new Error(phraseApplicationIndisponible(refus.raison));
        if (refus.raison === 'refuse') return refuser(reply, 422, 'meta_rejected', phraseApplicationIndisponible(refus.raison));
        return refuser(reply, 409, 'number_unlinked', phraseApplicationIndisponible(refus.raison));
      case 'format_non_pris_en_charge':
        return refuser(reply, 400, 'invalid_body', `type : ${PHRASE_FORMAT_APPLICATION} (POST /v1/messages/whatsapp)`);
      case 'premier_message':
        return refuserLePremier(reply, refus.refus);
      default: {
        // Exhaustif : un motif ajouté demain à `RefusReponse` ne compile pas ici, au lieu de sortir sous une raison
        // fausse.
        const inconnu: never = motif;
        throw new Error(`motif de refus inconnu : ${String(inconnu)}`);
      }
    }
  }
}

/**
 * Le refus de la porte « écrire en premier » (filière application), sous des codes existants du contrat, chacun avec la
 * phrase de la porte. Le gel suit un refus de WhatsApp, comme le refus d'un envoi de cette filière (`meta_rejected`).
 * Exhaustif : un refus ajouté demain ne compile pas.
 */
function refuserLePremier(reply: FastifyReply, refus: RefusPremier): FastifyReply {
  const phrase = phrasePremierMessage(refus, 'api');
  switch (refus) {
    // L'espace est passé à l'API de Meta entre la lecture de la route et la porte : la fenêtre de l'API.
    case 'filiere_api':
      return refuser(reply, 422, 'window_closed', FENETRE_FERMEE);
    case 'numero_coupe':
    case 'numero_indisponible':
      return refuser(reply, 409, 'number_unlinked', phrase);
    // Écrire à quelqu'un qui ne nous a pas écrit : le refus de l'API dans le même cas, une fenêtre fermée, avec la phrase
    // de ce numéro, qui ne fait que répondre (2026-10-24) et n'a pas de modèle à proposer.
    case 'premier_contact':
      return refuser(reply, 422, 'window_closed', phrase);
    case 'gele':
      return refuser(reply, 422, 'meta_rejected', phrase);
    case 'desabonne':
      return refuser(reply, 409, 'opted_out', phrase);
    case 'bloque':
      return refuser(reply, 409, 'blocked_contact', phrase);
    case 'sans_telephone':
      return refuser(reply, 422, 'no_phone', phrase);
    // Le corps d'un 402 de l'offre porte la page de l'offre, comme les autres refus d'offre de `/v1`.
    case 'limite_modeles':
      return reply.code(STATUT_REFUS_OFFRE).send({ error: phrase, code: 'plan_limit_reached' satisfies CodeApi, upgradeUrl: adresseOffre() });
    default: {
      const inconnu: never = refus;
      throw new Error(`refus de premier message inconnu : ${String(inconnu)}`);
    }
  }
}
