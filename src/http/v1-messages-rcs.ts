import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { MESSAGE_RESOLUTION, normaliserCles, schemaClesFiche, type ClesFiche, type ModeCreation, type ResolutionFiche } from '../api/fiche';
import { STATUT_PAR_CODE, refuser } from '../api/erreurs';
import { messageDeForme } from '../api/forme';
import { compterOuRefuser, type ApiUsageGuard } from '../api/usage-guard';
import { waIdOf } from '../crm/identity';
import type { DepsRepondre } from '../inbox/repondre';
import { envoyerRcsLibre, type DepsRcsLibre, type RefusRcsLibre } from '../rcs/envoyer-libre';
import { RCS_TEXTE_MAX } from '../rcs/schema';
import { INCONNUE_POUR_UN_MESSAGE } from './v1-messages';

/**
 * `POST /v1/messages/rcs` : un TEXTE en RCS, à UNE personne qui a une fiche (spec 2026-09-24, § 4, lot 3).
 *
 * 🔴 ELLE N'A PRESQUE AUCUNE LOGIQUE À ELLE. Les gardes du RCS (désabonnement, consentement d'une machine, canal,
 * joignabilité) et l'envoi vivent dans `envoyerRcsLibre`, partagé avec le bouton RCS de l'Inbox. Cette route ne
 * fait que ce qu'elle seule sait faire : trouver la FICHE par les clés reçues, exiger un numéro, refuser un
 * contact bloqué, et traduire chaque refus en code.
 *
 * ⚠️ UN MODULE À PART DE `/v1/messages/whatsapp` : leurs règles n'ont presque rien en commun (pas de fenêtre de
 * 24 h ici, un consentement là), et la spec les veut en deux routes. Même garde, même limiteur, même droit
 * `sends:create`, même opération d'usage (`messages.send` : un message, une personne), et la même lecture du
 * corps (défauts de forme et de clé refusés AVANT le compteur, messages de la résolution partagée du lot 1).
 *
 * ⚠️ LE FIL S'OUVRE APRÈS L'ENVOI, JAMAIS AVANT. Un refus (pas de consentement, canal éteint) n'a rien à montrer
 * dans l'Inbox : ouvrir le fil d'abord y ferait apparaître une conversation vide en tête de liste pour une
 * personne à qui rien n'est parti.
 *
 * 🔴 ET IL S'OUVRE AVANT D'ÊTRE PRIS. `takeControl` est un `update` sur (espace, wa_id) qui ne crée rien : pris
 * avant l'ouverture, le fil d'une fiche qui n'a jamais écrit (le cas courant de l'API, une fiche créée par
 * `/v1/contacts`) naîtrait ensuite avec le détenteur par défaut, donc NON pris, à rebours du § 4 de la spec
 * (« Écrire PREND le fil »). `/v1/messages/whatsapp` ouvre, lui aussi, avant de prendre.
 *
 * ⚠️ AUCUNE CLÉ D'IDEMPOTENCE, comme la barre de réponse de l'Inbox et `/v1/messages/whatsapp`.
 */
export interface V1MessagesRcsRouteDeps {
  /**
   * La résolution de fiche du lot 1, liée par le câblage aux MÊMES dépendances que `/v1/contacts`, `/v1/sends`
   * et `/v1/messages/whatsapp`. La route l'appelle en `creer: 'jamais'` : un message simple ne fonde pas une
   * relation.
   */
  resoudreFiche(tenantId: string, cles: ClesFiche, opts: { creer: ModeCreation }): Promise<ResolutionFiche>;
  /** Le numéro et le blocage d'une fiche NON supprimée de cet espace. `null` = introuvable. */
  etatPourEnvoi(tenantId: string, contactId: string): Promise<{ phoneE164: string | null; bloque: boolean } | null>;
  /** Les dépendances d'`envoyerRcsLibre`, transmises d'un seul objet, jamais recopiées champ par champ. */
  rcs: DepsRcsLibre;
  /** Le fil du contact, créé s'il n'existe pas (la fonction du bouton « Ouvrir la conversation »). */
  ouvrirConversation(tenantId: string, contactId: string): Promise<string | null>;
  takeControl(tenantId: string, waId: string): Promise<void>;
  recordOutbound: DepsRepondre['recordOutbound'];
  /** Le garde d'usage, injecté par `buildServer`. OBLIGATOIRE, comme sur les autres routes /v1. */
  usage: ApiUsageGuard;
}

/**
 * Les clés de fiche du lot 1, plus le texte. `strictObject` : une clé inconnue (un `rcsMessageId` d'Inbox, une
 * faute de frappe) est un défaut de forme, pas un champ ignoré.
 */
const schemaMessageRcs = z.strictObject({
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
 * Le tenant vient à 100 % de `req.auth` (posé par `makeRequireApiKey`), jamais de l'URL ni du corps.
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
    // Les défauts de CLÉ (aucune clé, numéro illisible) sont des défauts de forme : refusés avant le compteur,
    // par la même normalisation que la résolution partagée.
    const n = normaliserCles(cles);
    if (!n.ok) return refuser(reply, STATUT_PAR_CODE[n.code], n.code, MESSAGE_RESOLUTION[n.code]);

    // Compté APRÈS la validation, comme sur les autres routes : un corps malformé n'a demandé aucun travail.
    if (!await compterOuRefuser(deps.usage, req, reply, 'messages.send')) return reply;

    const fiche = await deps.resoudreFiche(tenantId, cles, { creer: 'jamais' });
    if (!fiche.ok) {
      const message = fiche.code === 'unknown_contact' ? INCONNUE_POUR_UN_MESSAGE : MESSAGE_RESOLUTION[fiche.code];
      return refuser(reply, STATUT_PAR_CODE[fiche.code], fiche.code, message);
    }

    // L'ordre du § 4 : la fiche existe, porte un numéro, n'est pas bloquée. Le reste est dans `envoyerRcsLibre`.
    const etat = await deps.etatPourEnvoi(tenantId, fiche.contactId);
    if (!etat) return refuser(reply, 404, 'unknown_contact', INCONNUE_POUR_UN_MESSAGE);
    const waId = waIdOf(etat.phoneE164, null);
    if (!waId) return refuser(reply, 422, 'no_phone', MESSAGE_RCS.no_phone);
    if (etat.bloque) return refuser(reply, 409, 'blocked_contact', 'cette fiche est bloquée');

    const issue = await envoyerRcsLibre(deps.rcs, tenantId, waId, { text }, 'api');
    if ('refus' in issue) return refuser(reply, STATUT_PAR_CODE[issue.refus], issue.refus, MESSAGE_RCS[issue.refus]);

    /**
     * APRÈS l'envoi réussi, et dans CET ordre : le fil est OUVERT (créé s'il n'existe pas), puis PRIS, puis le
     * message y est INSCRIT (cf. le docblock : pris avant d'être ouvert, un fil neuf ne serait pas pris).
     * Best-effort : le message est parti, un 5xx ferait réessayer l'intégrateur, donc envoyer deux fois.
     * Origine `api` (0166), auteur `null` : personne ne signe ce message.
     * ⚠️ Un rapport d'échec smsmode peut arriver avant l'inscription : `traiterRapportRcs` l'écrit quand même
     * (`noterSansMessage`), rien à faire ici.
     */
    const conversationId = await deps.ouvrirConversation(tenantId, fiche.contactId).catch(() => null);
    if (conversationId) {
      await deps.takeControl(tenantId, waId).catch(() => {});
      await deps.recordOutbound(conversationId, issue.apercu, issue.messageId, 'api', 'rcs', null, null, null, 'rcs').catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`v1/messages/rcs: RCS parti mais non inscrit dans l'Inbox (${tenantId}):`, err instanceof Error ? err.message : err);
      });
    } else {
      // eslint-disable-next-line no-console
      console.error(`v1/messages/rcs: RCS parti, fil introuvable pour ${fiche.contactId} (${tenantId}), bloqué ou supprimé entre-temps`);
    }
    return reply.code(200).send({ messageId: issue.messageId, conversationId, channel: 'rcs' });
  });
}
