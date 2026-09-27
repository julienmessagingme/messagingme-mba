import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { MESSAGE_RESOLUTION, normaliserCles, schemaClesFiche, type ClesFiche, type ModeCreation, type ResolutionFiche } from '../api/fiche';
import { STATUT_PAR_CODE, refuser } from '../api/erreurs';
import { messageDeForme } from '../api/forme';
import { compterOuRefuser, type ApiUsageGuard } from '../api/usage-guard';
import { waIdOf } from '../crm/identity';
import type { ConversationsRepondre } from '../inbox/repondre';
import { envoyerRcsLibre, type DepsRcsLibre, type RefusRcsLibre } from '../rcs/envoyer-libre';
import { RCS_TEXTE_MAX } from '../rcs/schema';
import { INCONNUE_POUR_UN_MESSAGE, type ReponseMessageSimple } from './v1-messages';
import { messageDe } from '../lib/erreur';

/**
 * `POST /v1/messages/rcs` : un texte en RCS, à une personne qui a une fiche.
 * 🔴 Les gardes du RCS (désabonnement, consentement d'une machine, canal, joignabilité) et l'envoi vivent dans
 * `envoyerRcsLibre`, partagé avec l'Inbox : la route trouve la fiche, exige un numéro, refuse un contact bloqué et
 * traduit chaque refus en code. Module à part de `/v1/messages/whatsapp` (règles différentes), avec la même garde,
 * le même droit `sends:create` et la même opération d'usage (`messages.send`).
 * Le fil s'ouvre après l'envoi (un refus n'a rien à montrer dans l'Inbox), et avant d'être pris : `takeControl` ne
 * crée rien, un fil neuf pris avant d'être ouvert naîtrait non pris. Aucune clé d'idempotence.
 */
export interface V1MessagesRcsRouteDeps {
  /**
   * La résolution de fiche partagée (mêmes dépendances que `/v1/contacts`, `/v1/sends` et `/v1/messages/whatsapp`),
   * appelée en `creer: 'jamais'` : un message simple ne fonde pas une relation.
   */
  resoudreFiche(tenantId: string, cles: ClesFiche, opts: { creer: ModeCreation }): Promise<ResolutionFiche>;
  contacts: {
    /** Le numéro et le blocage d'une fiche non supprimée de cet espace. `null` = introuvable. */
    etatPourEnvoi(tenantId: string, contactId: string): Promise<{ phoneE164: string | null; bloque: boolean } | null>;
  };
  /** Les dépendances d'`envoyerRcsLibre`, transmises d'un seul objet, jamais recopiées champ par champ. */
  rcs: DepsRcsLibre;
  inbox: Pick<ConversationsRepondre, 'recordOutbound'> & {
    /** Le fil du contact, créé s'il n'existe pas (la fonction du bouton « Ouvrir la conversation »). */
    ouvrirConversationDuContact(tenantId: string, contactId: string): Promise<string | null>;
  };
  takeControl(tenantId: string, waId: string): Promise<void>;
  /** Le garde d'usage, injecté par `buildServer`. Requis, comme sur les autres routes /v1. */
  usage: ApiUsageGuard;
}

/**
 * Les clés de fiche, plus le texte. `strictObject` : une clé inconnue (un `rcsMessageId` d'Inbox, une faute de
 * frappe) est un défaut de forme, pas un champ ignoré.
 */
export const schemaMessageRcs = z.strictObject({
  ...schemaClesFiche.shape,
  text: z.string().trim().min(1).max(RCS_TEXTE_MAX),
});

/** Les refus d'`envoyerRcsLibre`, en codes de l'API. Le statut vient de la table des codes (`STATUT_PAR_CODE`). */
const MESSAGE_RCS: Record<RefusRcsLibre, string> = {
  no_phone: 'cette fiche ne porte aucun numéro : le RCS s’adresse à un numéro de téléphone',
  opted_out: 'cette personne a demandé à ne plus recevoir de messages',
  no_consent: 'cette personne n’a ni consenti ni jamais écrit : un message simple ne peut pas ouvrir la relation, utilisez un envoi (POST /v1/sends)',
  rcs_not_enabled: 'le canal RCS n’est pas activé sur cet espace',
  rcs_unreachable: 'ce numéro n’est pas joignable en RCS (dernier rapport de livraison)',
  rcs_message_not_found: 'message RCS introuvable',
};

/**
 * 🔴 L'espace vient de `req.auth` (posé par `makeRequireApiKey`), jamais de l'URL ni du corps.
 * Garde attendue : `[makeRequireApiKey, requireScope('sends:create')]`, comme `/v1/messages/whatsapp`.
 */
export function registerV1MessagesRcs(app: FastifyInstance, deps: V1MessagesRcsRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.post('/v1/messages/rcs', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    const tenantId = req.auth.tenantId;

    const corps = schemaMessageRcs.safeParse(req.body);
    if (!corps.success) return refuser(reply, 400, 'invalid_body', messageDeForme(corps.error));

    const { text, ...cles } = corps.data;
    // Les défauts de clé (aucune clé, numéro illisible) sont des défauts de forme : refusés avant le compteur,
    // par la même normalisation que la résolution partagée.
    const n = normaliserCles(cles);
    if (!n.ok) return refuser(reply, STATUT_PAR_CODE[n.code], n.code, MESSAGE_RESOLUTION[n.code]);

    // Compté après la validation, comme sur les autres routes : un corps malformé n'a demandé aucun travail.
    if (!await compterOuRefuser(deps.usage, req, reply, 'messages.send')) return reply;

    const fiche = await deps.resoudreFiche(tenantId, cles, { creer: 'jamais' });
    if (!fiche.ok) {
      const message = fiche.code === 'unknown_contact' ? INCONNUE_POUR_UN_MESSAGE : MESSAGE_RESOLUTION[fiche.code];
      return refuser(reply, STATUT_PAR_CODE[fiche.code], fiche.code, message);
    }

    // L'ordre : la fiche existe, porte un numéro, n'est pas bloquée. Le reste est dans `envoyerRcsLibre`.
    const etat = await deps.contacts.etatPourEnvoi(tenantId, fiche.contactId);
    if (!etat) return refuser(reply, 404, 'unknown_contact', INCONNUE_POUR_UN_MESSAGE);
    const waId = waIdOf(etat.phoneE164, null);
    if (!waId) return refuser(reply, 422, 'no_phone', MESSAGE_RCS.no_phone);
    if (etat.bloque) return refuser(reply, 409, 'blocked_contact', 'cette fiche est bloquée');

    const issue = await envoyerRcsLibre(deps.rcs, tenantId, waId, { text }, 'api');
    if ('refus' in issue) return refuser(reply, STATUT_PAR_CODE[issue.refus], issue.refus, MESSAGE_RCS[issue.refus]);

    /**
     * Après l'envoi réussi, dans cet ordre : le fil est ouvert, pris, puis le message y est inscrit (origine `api`,
     * auteur `null`). Au mieux : le message est parti, un 5xx ferait réessayer l'intégrateur, donc envoyer deux fois.
     * Un rapport d'échec smsmode arrivé avant l'inscription est écrit quand même par `traiterRapportRcs`.
     */
    const conversationId = await deps.inbox.ouvrirConversationDuContact(tenantId, fiche.contactId).catch(() => null);
    if (conversationId) {
      await deps.takeControl(tenantId, waId).catch(() => {});
      await deps.inbox.recordOutbound(conversationId, issue.apercu, issue.messageId, 'api', 'rcs', null, null, null, 'rcs').catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`v1/messages/rcs: RCS parti mais non inscrit dans l'Inbox (${tenantId}):`, messageDe(err));
      });
    } else {
      // eslint-disable-next-line no-console
      console.error(`v1/messages/rcs: RCS parti, fil introuvable pour ${fiche.contactId} (${tenantId}), bloqué ou supprimé entre-temps`);
    }
    // `conversationId` peut valoir `null` : 200 quand même, le message est parti (un 5xx ferait envoyer deux fois).
    return reply.code(200).send({ messageId: issue.messageId, conversationId, channel: 'rcs' } satisfies ReponseMessageSimple);
  });
}
