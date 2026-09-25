import type { Pool } from 'pg';

/**
 * CE QUE NOUS ACCEPTONS DE DÉPENSER POUR LES ASSISTANTS DE CONFIGURATION.
 *
 * 🔴 C'EST NOTRE ARGENT, PAS LE CRÉDIT DU CLIENT (tranché par Julien le 2026-09-14). Les deux assistants
 * passent par la clé maison, comme le bot d'aide de la console, et pour la même raison déjà écrite dans le
 * dépôt : facturer quelqu'un pour apprendre à se servir du produit se retourne contre nous.
 *
 * 🔴 ET C'EST POURQUOI IL FAUT UN PLAFOND. Sur le crédit du client, un bavardage se payait tout seul ; sur
 * le nôtre, rien ne le borne. ⚠️ Le plafond d'équipe Vercel n'est PAS ce garde-fou : il couperait TOUS les
 * projets du Gateway d'un coup, bots clients en production compris (Odalys, Hyundai, Gan Prévoyance, les
 * deux Leadgen). Celui-ci ne coupe qu'une conversation d'assistant, sur un seul espace.
 *
 * PUR pour la règle, IO seulement dans le store : c'est ce qui permet d'éprouver « le mois calendaire » et
 * « 0 désactive » sans base ni horloge.
 */

/** Le premier jour du mois, en UTC, au format que la colonne `date` accepte. */
export function moisDe(maintenant: Date): string {
  const a = maintenant.getUTCFullYear();
  const m = String(maintenant.getUTCMonth() + 1).padStart(2, '0');
  return `${a}-${m}-01`;
}

/**
 * Ce qui reste, en micro-euros. `Infinity` quand le plafond est désactivé.
 *
 * ⚠️ 0 DÉSACTIVE, comme les limiteurs de débit de ce dépôt, et c'est le levier d'urgence : un mauvais
 * calibrage couperait l'assistant de tous les clients, et un `--force-recreate` va plus vite qu'un
 * déploiement de code.
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
    /**
     * ⚠️ L'UPSERT REND L'INCRÉMENT SÛR SANS VERROU APPLICATIF : deux tours simultanés du même espace
     * s'additionnent sous le verrou de ligne de Postgres. Un « lire puis écrire » en perdrait un, de temps
     * en temps, exactement quand deux admins parlent à l'assistant en même temps.
     */
    await this.pool.query(
      `insert into assistant_depense_mois (tenant_id, mois, micro_euros) values ($1, $2::date, $3)
       on conflict (tenant_id, mois) do update
         set micro_euros = assistant_depense_mois.micro_euros + excluded.micro_euros`,
      [tenantId, mois, Math.round(microEuros)],
    );
  }
}

/**
 * LE MESSAGE QU'ON REND QUAND LE PLAFOND EST ATTEINT.
 *
 * 🔴 IL DIT LA VÉRITÉ ET IL RASSURE, dans cet ordre (tranché par Julien le 2026-09-14). Un message
 * d'indisponibilité générique ferait passer une limite VOLONTAIRE pour une panne, ce qu'on nous reprocherait
 * le jour où ça se sait ; et taire que les onglets restent utilisables laisserait croire que tout est bloqué.
 */
export const MESSAGE_PLAFOND = 'Je ne peux plus vous répondre jusqu’au mois prochain. '
  + 'Tout reste modifiable dans les onglets, comme d’habitude.';
