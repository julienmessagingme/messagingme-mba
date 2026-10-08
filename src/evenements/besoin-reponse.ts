import { createHash, randomUUID } from 'node:crypto';
import type { ContactDuSignal } from '../signaux/types';
import type { LigneEnvoi } from './distribution';
import type { JobEnvoi } from './envoi';
import { PRIORITE_BESOIN_REPONSE, TYPE_BESOIN_REPONSE, enveloppe, idEvenement, type MessageRecu } from './types';

export { PRIORITE_BESOIN_REPONSE };

/**
 * « MON APPLICATION RÉPOND » (lot 12, livraison B) : la remise d'un message entrant que personne ne tient, en mode
 * `application`, le confie à l'application du client par l'événement `conversation.needs_reply`, envoyé à l'adresse
 * DÉSIGNÉE (elle n'a pas à s'y abonner). L'application répond par `POST /v1/messages/whatsapp`, sans prendre le fil.
 *
 * Aucun repli (décision de Julien du 2026-10-08) : si l'application ne répond pas, rien ne se passe, et les réessais de
 * l'envoi se lisent au journal. Seule une adresse qui ne PEUT pas recevoir (supprimée, en pause, gelée par l'offre)
 * rend la main à l'équipe. Supprimée, `modeEffectif` lit « équipe » (clé étrangère en `set null`) ; en pause ou gelée,
 * le mode reste `application` et c'est cette demande qui la juge indisponible, message par message.
 */


export interface DepsDemandeALApplication {
  /** 🔴 Filtré sur l'espace. `rang` : place parmi les adresses actives, la plus ancienne d'abord (le gel par l'offre). */
  adresse(tenantId: string, adresseId: string): Promise<{ active: boolean; rang: number } | null>;
  limiteAdresses(tenantId: string): Promise<number | null>;
  /** La fiche du contact, relue au moment de la demande : elle part avec l'événement. */
  fiche(tenantId: string, waId: string): Promise<Omit<ContactDuSignal, 'derniereAnalyse'> | null>;
  /** La conversation à laquelle l'application répond (`POST /v1/messages/whatsapp` la retrouve par la fiche). */
  conversationId(tenantId: string, waId: string): Promise<string | null>;
  /**
   * Le message déclencheur tel qu'il a été enregistré : son type, son texte et sa transcription (un vocal). La fin de
   * parcours ne passe aucun texte, et un `[audio]` seul ne dit rien à l'application.
   */
  messageRecu(tenantId: string, messageId: string): Promise<MessageRecu | null>;
  /**
   * 🔴 Écrit la ligne et rend son identifiant, ou `null` si elle existait déjà (même événement, même adresse) : la même
   * demande peut arriver deux fois pour un message (le lead d'une publicité passe par deux chemins de remise), et une
   * ligne déjà là ne doit pas être enfilée une seconde fois. Jamais la relance d'orphelin d'`envois.creer`.
   */
  creerEnvoiNeuf(ligne: LigneEnvoi): Promise<string | null>;
  enfiler(job: JobEnvoi, priorite: number): Promise<void>;
  maintenant?: () => Date;
}

export interface DemandeALApplication {
  demander(
    tenantId: string, waId: string, o: { adresseId: string; messageDeclencheur: string | null; contenu: string },
  ): Promise<'demande' | 'indisponible'>;
}

/** L'identifiant de l'événement : stable sur l'identifiant du message (Meta le redélivre), opaque (il encode le numéro). */
function idDeLaDemande(messageDeclencheur: string | null): string {
  if (messageDeclencheur === null) return idEvenement(randomUUID());
  return idEvenement(createHash('sha256').update(`${TYPE_BESOIN_REPONSE}:${messageDeclencheur}`).digest('hex').slice(0, 32));
}

export function creerDemandeALApplication(deps: DepsDemandeALApplication): DemandeALApplication {
  return {
    async demander(tenantId, waId, o) {
      const a = await deps.adresse(tenantId, o.adresseId);
      if (a === null || !a.active) return 'indisponible';
      const limite = await deps.limiteAdresses(tenantId);
      if (limite !== null && a.rang > limite) return 'indisponible';

      const [fiche, conversationId, message] = await Promise.all([
        deps.fiche(tenantId, waId), deps.conversationId(tenantId, waId),
        o.messageDeclencheur === null ? Promise.resolve(null) : deps.messageRecu(tenantId, o.messageDeclencheur),
      ]);
      const id = idDeLaDemande(o.messageDeclencheur);
      // Le texte enregistré d'abord : la fin de parcours passe un contenu vide, et le message, lui, en a un.
      const texte = message?.text ?? (o.contenu.trim() === '' ? null : o.contenu);
      const corps = JSON.stringify(enveloppe({
        id, type: TYPE_BESOIN_REPONSE, le: (deps.maintenant?.() ?? new Date()).toISOString(), tenantId,
        data: {
          contact: fiche === null ? null : {
            id: fiche.contactId, phone: fiche.telephone, name: fiche.nom, external_id: fiche.externalId,
            opted_out: { whatsapp: fiche.optOutWhatsapp, rcs: fiche.optOutRcs },
          },
          conversation_id: conversationId,
          channel: 'whatsapp',
          message_id: o.messageDeclencheur,
          message_type: message?.type ?? null,
          text: texte,
          transcription: message?.transcription ?? null,
          reply_with: { method: 'POST', path: '/v1/messages/whatsapp' },
        },
      }));
      const envoiId = await deps.creerEnvoiNeuf({
        tenantId, adresseId: o.adresseId, evenementId: id, type: TYPE_BESOIN_REPONSE, contactId: fiche?.contactId ?? null, corps,
      });
      // Déjà demandée (même message) : la première demande suit son cours, rien n'est enfilé une seconde fois.
      if (envoiId !== null) await deps.enfiler({ tenantId, envoiId, tentative: 0 }, PRIORITE_BESOIN_REPONSE);
      return 'demande';
    },
  };
}
