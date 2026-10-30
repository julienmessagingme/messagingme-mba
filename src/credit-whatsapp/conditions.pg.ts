import type { Pool } from 'pg';
import type { ConditionsCredit } from './garde';

/** Cinq secondes, comme la ligne d'un numéro : un réglage de `/ops` s'applique vite partout, sans invalidation à câbler. */
const CACHE_MS = 5_000;

/**
 * LES CONDITIONS D'UN ESPACE SUR LA LIGNE (plan du Crédit WhatsApp, tâche 8), lues par la garde, l'ajustement et les écrans.
 * L'open bar et la commission négociée ne valent que pour une Entreprise, lue par la seule définition de l'offre
 * (`offre_de_l_espace`) : un espace sorti de l'Entreprise les perd à la lecture, quoi que gardent ses colonnes. Partout
 * ailleurs, et pour une Entreprise sans commission négociée, la commission globale de `/ops`.
 */
export class PgConditionsCreditStore {
  private readonly cache = new Map<string, { lue: number; valeur: ConditionsCredit }>();

  constructor(
    private readonly pool: Pool,
    private readonly reglages: { commission(): Promise<number> },
    private readonly maintenant: () => number = () => Date.now(),
  ) {}

  async conditions(tenantId: string): Promise<ConditionsCredit> {
    const t = this.maintenant();
    const c = this.cache.get(tenantId);
    if (c !== undefined && t - c.lue < CACHE_MS) return c.valeur;
    const { rows } = await this.pool.query<{ entreprise: boolean; open_bar: boolean | null; commission: number | null }>(
      `select offre_de_l_espace($1::uuid) = 'entreprise' as entreprise,
              (select t.entreprise_open_bar_whatsapp from tenants t where t.id = $1::uuid) as open_bar,
              (select t.entreprise_commission_messages_pct from tenants t where t.id = $1::uuid) as commission`,
      [tenantId],
    );
    const l = rows[0];
    const entreprise = l?.entreprise === true;
    const valeur: ConditionsCredit = {
      openBar: entreprise && l?.open_bar === true,
      commissionPct: entreprise && l?.commission != null ? l.commission : await this.reglages.commission(),
    };
    this.cache.set(tenantId, { lue: t, valeur });
    return valeur;
  }

  /** La commission des messages d'un espace : la négociée de l'Entreprise, sinon la globale. */
  async commissionMessagesPour(tenantId: string): Promise<number> {
    return (await this.conditions(tenantId)).commissionPct;
  }
}
