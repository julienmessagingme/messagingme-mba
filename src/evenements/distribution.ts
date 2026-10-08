import { schemaJobSignaux, type NomEvenement, type Signal, type SignalComplet } from '../signaux/types';
import { PRIORITE_SIGNAL } from '../signaux/emetteur';
import { TYPE_DU_SIGNAL, donneesDuSignal, enveloppe, idEvenement, type MessageRecu, type TypeAbonnable } from './types';
import type { JobEnvoi } from './envoi';

/**
 * LA DISTRIBUTION DES WEBHOOKS SORTANTS (lot 12, livraison A) : le premier étage. Elle reçoit les signaux d'un espace
 * par le bus existant (`creerEmetteur`, une destination de plus), relit les adresses actives, complète et FIGE chaque
 * événement, écrit une ligne d'envoi par couple (événement, adresse) et enfile l'envoi de chacune.
 *
 * - Le contenu est figé ici : un réessai renvoie le même corps, octet pour octet, pas l'état de la fiche plus tard.
 * - Une ligne par (adresse, événement), unique en base : un message que Meta redélivre (même identifiant) ou une
 *   distribution rejouée n'envoie pas deux fois (`creerEnvois` ne rend que les lignes neuves).
 * - Au-delà de l'offre, les adresses les plus récentes sont gelées ici, sans rien écrire en base (retour en Base).
 * - Un type que personne ne veut n'est même pas complété : aucune lecture pour rien.
 */
export const FILE_EVENEMENTS_DISTRIBUTION = 'evenements-distribution';

export interface AdresseDestinataire {
  id: string;
  types: readonly string[];
}

export interface LigneEnvoi {
  tenantId: string;
  adresseId: string;
  evenementId: string;
  type: TypeAbonnable;
  contactId: string | null;
  corps: string;
}

export interface DepsDistribution {
  /** 🔴 Filtré sur l'espace : les adresses ACTIVES, la plus ancienne d'abord (c'est l'ordre du gel par l'offre). */
  adresses(tenantId: string): Promise<AdresseDestinataire[]>;
  limiteAdresses(tenantId: string): Promise<number | null>;
  espaceVerrouille(tenantId: string): Promise<boolean>;
  completer(tenantId: string, s: Signal): Promise<SignalComplet | null>;
  /** Le message d'un contact, pour `message.received`. `null` = introuvable (purgé) : l'événement part sans le texte. */
  messageRecu(tenantId: string, messageId: string): Promise<MessageRecu | null>;
  /** Insère les lignes et rend celles qui sont NEUVES (les autres existaient déjà : rien à renvoyer). */
  creerEnvois(lignes: readonly LigneEnvoi[]): Promise<Array<{ id: string; type: string }>>;
  enfiler(job: JobEnvoi, priorite: number): Promise<void>;
}

/** La priorité d'un envoi : celle du signal qui l'a fait naître (les accusés d'une campagne passent derrière les gestes). */
function prioriteDuType(type: string): number {
  const nom = (Object.keys(TYPE_DU_SIGNAL) as NomEvenement[]).find((n) => TYPE_DU_SIGNAL[n] === type);
  return nom === undefined ? 1 : PRIORITE_SIGNAL[nom];
}

export function creerTravailDistribution(deps: DepsDistribution): (data: unknown) => Promise<void> {
  return async (data) => {
    const lu = schemaJobSignaux.safeParse(data);
    if (!lu.success) {
      const i = lu.error.issues[0];
      throw new Error(`evenements-distribution : payload invalide (${i ? `${i.path.join('.')} ${i.message}` : 'forme'})`);
    }
    const { tenantId, signaux } = lu.data;
    if (await deps.espaceVerrouille(tenantId)) return;

    const toutes = await deps.adresses(tenantId);
    if (toutes.length === 0) return;
    const limite = await deps.limiteAdresses(tenantId);
    const adresses = limite === null ? toutes : toutes.slice(0, limite);

    const lignes: LigneEnvoi[] = [];
    for (const s of signaux) {
      const type = TYPE_DU_SIGNAL[s.nom];
      const destinataires = adresses.filter((a) => a.types.includes(type));
      if (destinataires.length === 0) continue;
      const complet = await deps.completer(tenantId, s);
      if (complet === null) continue;
      const message = s.nom === 'em_replied' && s.messageId !== undefined ? await deps.messageRecu(tenantId, s.messageId) : null;
      const id = idEvenement(s.id);
      const corps = JSON.stringify(enveloppe({ id, type, le: s.le, tenantId, data: donneesDuSignal(s, complet, message) }));
      for (const a of destinataires) {
        lignes.push({ tenantId, adresseId: a.id, evenementId: id, type, contactId: complet.contact.contactId, corps });
      }
    }
    if (lignes.length === 0) return;

    for (const neuf of await deps.creerEnvois(lignes)) {
      await deps.enfiler({ tenantId, envoiId: neuf.id, tentative: 0 }, prioriteDuType(neuf.type));
    }
  };
}
