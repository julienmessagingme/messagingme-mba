import { cacheCourt, type CacheCourt } from '../lib/cache-court';
import { journaliser as journaliserParDefaut } from '../lib/journal';
import { DROITS } from './offres';
import type { OffreEspace, SourceOffres } from './offre.pg';

/**
 * L'offre d'un espace, lue au plus une fois par 30 s et par process (lot 6, tâche 2). Le webhook du Pro et l'exploitation
 * invalident l'entrée de la copie qui les reçoit : l'espace qui vient de payer y est en Pro tout de suite, et en moins de
 * 30 s sur les autres copies et dans le worker. Un échec de lecture ne se met jamais en cache (`cacheCourt`).
 */
export const VIE_OFFRE_MS = 30_000;

/**
 * 🔴 CE QUE REND UNE OFFRE ILLISIBLE : tout ouvert, sans limite (relecture finale du lot 6). L'offre est un levier
 * commercial, pas une garde de sécurité : une panne de la lecture ne doit couper ni l'Inbox d'un client ni ses envois.
 * Sans ce repli, l'étape d'offre et les limites des magasins rendaient 500 partout. L'incident est journalisé.
 */
const OFFRE_ILLISIBLE: OffreEspace = { offre: 'entreprise', droits: DROITS.entreprise, retourEnBaseLe: null };

export class OffresEnCache implements SourceOffres {
  private readonly cache: CacheCourt<OffreEspace>;

  constructor(
    private readonly source: SourceOffres,
    maintenant: () => number = Date.now,
    private readonly journaliser: (message: string, champs: Record<string, unknown>) => void = (m, c) => journaliserParDefaut('error', m, c),
  ) {
    this.cache = cacheCourt<OffreEspace>(VIE_OFFRE_MS, maintenant);
  }

  async offreDe(tenantId: string): Promise<OffreEspace> {
    try {
      return await this.cache.lire(tenantId, () => this.source.offreDe(tenantId));
    } catch (err) {
      this.journaliser('offre_illisible', { tenantId, err });
      return OFFRE_ILLISIBLE;
    }
  }

  invalider(tenantId: string): void {
    this.cache.invalider(tenantId);
  }
}
