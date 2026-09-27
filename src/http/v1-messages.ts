import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Guard } from '../auth/middleware';
import { repondreDansLaFenetre, type DepsRepondre } from '../inbox/repondre';
import { TEXTE_MAX_CARACTERES } from '../traduction/traduire';
import { compterOuRefuser, type ApiUsageGuard } from '../api/usage-guard';
import { STATUT_PAR_CODE, refuser } from '../api/erreurs';
import { NumeroDelieError, MESSAGE_NUMERO_DELIE } from '../meta/numero-delie';
import { MESSAGE_RESOLUTION, normaliserCles, schemaClesFiche, type ClesFiche, type ModeCreation, type ResolutionFiche } from '../api/fiche';
import { messageDeForme } from '../api/forme';
import type { FilDuContact } from '../inbox/store.pg';

/**
 * API publique /v1 des messages simples : `POST /v1/messages/whatsapp`, un texte, à une fiche (`contactId`,
 * `externalId`, `phone` ou `bsuid`), dans la fenêtre de service de 24 h. Son pendant RCS vit dans
 * `v1-messages-rcs.ts`.
 * 🔴 Aucune logique d'envoi à elle : la fenêtre, le désabonnement, l'envoi et la trace dans l'Inbox vivent dans
 * `repondreDansLaFenetre`, partagé avec la console et le MCP.
 * La fiche bloquée est écartée par `filDuContact` (même fragment `CIBLE_DU_CONTACT_SQL` que le mini-CRM). Le fil
 * est cherché, jamais créé : sans fil, la fenêtre est fermée par construction (422 `window_closed`, rien d'écrit).
 * Elle ne crée jamais de fiche (`creer: 'jamais'`), mais rattache une clé neuve à la fiche trouvée même quand le
 * message est ensuite refusé (figé par `tests/v1-messages.test.ts`). Aucune clé d'idempotence, comme la barre de
 * réponse de l'Inbox.
 */
export interface V1MessagesRouteDeps {
  /**
   * 🔴 Les dépendances de `repondreDansLaFenetre`, transmises d'un seul objet, jamais recopiées champ par champ :
   * un `Pick<>` recopié pour être retransmis dérive, et la capacité perdue serait `estDesabonne`.
   */
  repondre: DepsRepondre;
  /** La résolution de fiche partagée, liée à ses dépendances par le câblage. */
  resoudreFiche(tenantId: string, cles: ClesFiche, opts: { creer: ModeCreation }): Promise<ResolutionFiche>;
  /**
   * Le fil de cette fiche, cherché sans être créé (`PgInboxStore.filDuContact`). `injoignable` = fiche
   * supprimée, bloquée, ou sans identité joignable ; `sans_fil` = elle n'a jamais écrit.
   */
  filDuContact(tenantId: string, contactId: string): Promise<FilDuContact>;
  /** Le garde d'usage, injecté au bootstrap. Requis, comme sur les autres modules /v1. */
  usage: ApiUsageGuard;
}

/**
 * Strict : l'ancienne forme `{ to, text }` est refusée en nommant `to`, et un `tenantId` glissé dans le corps
 * aussi (l'espace vient de la clé).
 */
const schemaMessage = z.strictObject({
  ...schemaClesFiche.shape,
  text: z.string().min(1).max(TEXTE_MAX_CARACTERES),
});

/** Le refus d'une fenêtre fermée : un fil sans entrant récent, ou pas de fil du tout (le même cas pour Meta). */
const FENETRE_FERMEE = 'fenêtre de 24 h fermée : cette personne n’a pas écrit récemment. Utilisez un template (POST /v1/sends).';

export const INCONNUE_POUR_UN_MESSAGE = 'aucune fiche pour cette personne : un message simple ne crée pas de fiche, un envoi (POST /v1/sends) le fait';

/** Le validateur de cette route, sous le nom que la documentation de l'API éprouve (`tests/api-exemples.test.ts`). */
export const schemaMessageWhatsapp = schemaMessage;

/**
 * La réponse 200 des deux routes de message simple, typée pour que la documentation la suive
 * (`tests/api-exemples.test.ts`). `conversationId` vaut `null` dans un seul cas, en RCS : le message est parti
 * mais le fil n'a pas pu être ouvert ensuite. La route WhatsApp trouve le fil avant d'envoyer.
 */
export interface ReponseMessageSimple {
  messageId: string;
  conversationId: string | null;
  channel: 'whatsapp' | 'rcs';
}

/**
 * 🔴 L'espace vient de `req.auth` (posé par `makeRequireApiKey`), jamais de l'URL ni du corps.
 * Garde attendue : `[makeRequireApiKey, requireScope('sends:create')]`. Pas de droit neuf (les droits d'une clé
 * se fixent à sa création) : une clé qui déclenche un template peut écrire un texte libre, borné par la fenêtre
 * de 24 h et par le désabonnement.
 */
export function registerV1Messages(app: FastifyInstance, deps: V1MessagesRouteDeps, garde: Guard): void {
  const opts = { preHandler: garde };

  app.post('/v1/messages/whatsapp', opts, async (req, reply) => {
    if (!req.auth) return refuser(reply, 401, 'unauthorized', 'clé d’API requise');
    const tenantId = req.auth.tenantId;

    const lu = schemaMessage.safeParse(req.body);
    if (!lu.success) return refuser(reply, 400, 'invalid_body', messageDeForme(lu.error));

    const { text, ...cles } = lu.data;
    // Les défauts de clé (aucune clé, numéro illisible) sont des défauts de forme : refusés avant le compteur,
    // par la même normalisation que la résolution partagée.
    const n = normaliserCles(cles);
    if (!n.ok) return refuser(reply, STATUT_PAR_CODE[n.code], n.code, MESSAGE_RESOLUTION[n.code]);

    // Compté après la validation, comme sur `/v1/contacts` : un corps malformé n'a demandé aucun travail.
    if (!await compterOuRefuser(deps.usage, req, reply, 'messages.send')) return reply;

    const fiche = await deps.resoudreFiche(tenantId, cles, { creer: 'jamais' });
    if (!fiche.ok) {
      const message = fiche.code === 'unknown_contact' ? INCONNUE_POUR_UN_MESSAGE : MESSAGE_RESOLUTION[fiche.code];
      return refuser(reply, STATUT_PAR_CODE[fiche.code], fiche.code, message);
    }

    const fil = await deps.filDuContact(tenantId, fiche.contactId);
    if (fil.etat === 'injoignable') return refuser(reply, 409, 'blocked_contact', 'cette fiche est bloquée, supprimée, ou sans adresse WhatsApp');
    if (fil.etat === 'sans_fil') return refuser(reply, 422, 'window_closed', FENETRE_FERMEE);
    const { conversationId } = fil;

    /**
     * `auteur` à `null` : personne ne signe ce message dans l'Inbox ; `origine` à `'api'`. Le numéro délié sort du
     * point de passage des envois en exception, que le gestionnaire du serveur rend sans `code` : on l'attrape ici,
     * et seulement lui, pour rendre l'enveloppe `{ error, code }` de l'API publique.
     */
    let res: Awaited<ReturnType<typeof repondreDansLaFenetre>>;
    try {
      res = await repondreDansLaFenetre(deps.repondre, tenantId, conversationId, text, null, 'api');
    } catch (err) {
      if (err instanceof NumeroDelieError) return refuser(reply, 409, 'number_unlinked', MESSAGE_NUMERO_DELIE);
      throw err;
    }
    if (!('refus' in res)) return reply.code(200).send({ messageId: res.messageId, conversationId, channel: 'whatsapp' } satisfies ReponseMessageSimple);
    const motif = res.refus.motif;
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
      default: {
        // Exhaustif : un motif ajouté demain à `RefusReponse` ne compile pas ici, au lieu de sortir sous une raison
        // fausse.
        const inconnu: never = motif;
        throw new Error(`motif de refus inconnu : ${String(inconnu)}`);
      }
    }
  });
}
