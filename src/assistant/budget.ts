import type { Pool } from 'pg';

/**
 * Ce que nous acceptons de dépenser pour les assistants de configuration.
 *
 * 🔴 C'est notre argent, pas le crédit du client : les assistants passent par la clé maison, comme le bot d'aide
 * (facturer l'apprentissage du produit se retournerait contre nous). D'où un plafond par espace. Le plafond d'équipe
 * Vercel n'est pas ce garde-fou : il couperait tous les projets du Gateway, bots clients en production compris.
 * Règle pure, IO seulement dans le store.
 */

/** Le premier jour du mois, en UTC, au format que la colonne `date` accepte. */
export function moisDe(maintenant: Date): string {
  const a = maintenant.getUTCFullYear();
  const m = String(maintenant.getUTCMonth() + 1).padStart(2, '0');
  return `${a}-${m}-01`;
}

/**
 * Ce qui reste, en micro-euros. `Infinity` quand le plafond est désactivé : 0 désactive, levier d'urgence si un
 * mauvais calibrage coupait l'assistant de tous les clients.
 */
export function resteDuBudget(depenseMicroEur: number, plafondEuros: number): number {
  if (!Number.isFinite(plafondEuros) || plafondEuros <= 0) return Infinity;
  return Math.max(0, Math.round(plafondEuros * 1_000_000) - Math.max(0, depenseMicroEur));
}

export interface DepenseStore {
  lire(tenantId: string, mois: string): Promise<number>;
  ajouter(tenantId: string, mois: string, microEuros: number): Promise<void>;
}

export class PgDepenseStore implements DepenseStore {
  constructor(private readonly pool: Pool) {}

  async lire(tenantId: string, mois: string): Promise<number> {
    const r = await this.pool.query<{ micro_euros: string }>(
      `select micro_euros from assistant_depense_mois where tenant_id = $1 and mois = $2::date`,
      [tenantId, mois],
    );
    return r.rows[0] ? Number(r.rows[0].micro_euros) : 0;
  }

  async ajouter(tenantId: string, mois: string, microEuros: number): Promise<void> {
    if (microEuros <= 0) return;
    // L'upsert rend l'incrément sûr sans verrou applicatif : deux tours simultanés s'additionnent sous le verrou de
    // ligne, là où « lire puis écrire » en perdrait un.
    await this.pool.query(
      `insert into assistant_depense_mois (tenant_id, mois, micro_euros) values ($1, $2::date, $3)
       on conflict (tenant_id, mois) do update
         set micro_euros = assistant_depense_mois.micro_euros + excluded.micro_euros`,
      [tenantId, mois, Math.round(microEuros)],
    );
  }
}

/**
 * Le message rendu quand le plafond est atteint : il dit la vérité (une limite voulue, pas une panne) puis rassure
 * (les onglets restent utilisables).
 */
export const MESSAGE_PLAFOND = 'Je ne peux plus vous répondre jusqu’au mois prochain. '
  + 'Tout reste modifiable dans les onglets, comme d’habitude.';
