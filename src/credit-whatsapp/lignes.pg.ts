import type { Pool } from 'pg';

/**
 * LES NUMÉROS SUR LA LIGNE DE CRÉDIT (migration 0264, `lignes_credit_whatsapp`). Une ligne en cours est active (le numéro
 * envoie, chaque message provisionné) ou arrêtée (l'option a pris fin mais la ligne paie encore chez Meta : la garde
 * refuse tout envoi) ; une ligne retirée ne compte plus. Lue avant CHAQUE envoi Meta : gardée cinq secondes par numéro,
 * comme les gardes du numéro délié et suspendu.
 */
const CACHE_MS = 5_000;

export interface LigneCredit {
  id: string;
  tenantId: string;
  phoneNumberId: string;
  wabaId: string | null;
  origine: 'ops' | 'option';
  depuis: string;
  /** L'option a pris fin : la garde refuse les envois du numéro. */
  arreteeLe: string | null;
}

/** Ce que la pose d'un numéro sur la ligne vérifie (`/ops`, puis l'option du lot 2). */
export interface NumeroPourLaLigne {
  wabaId: string | null;
  /** `waba_credentials.fournisseur` ; sans compte propre, le jeton de notre portefeuille : `meta`. */
  fournisseur: string;
  /** L'application WhatsApp Business envoie elle aussi depuis ce numéro, sans passer par nous. */
  coexistence: boolean;
  delie: boolean;
}

export class PgLignesCreditStore {
  private readonly cache = new Map<string, { lue: number; valeur: LigneCredit | null }>();

  constructor(private readonly pool: Pool, private readonly maintenant: () => number = () => Date.now()) {}

  /** La ligne en cours du numéro, active ou arrêtée ; `null` s'il n'est pas sur la ligne. */
  async ligneDuNumero(phoneNumberId: string): Promise<LigneCredit | null> {
    const t = this.maintenant();
    const c = this.cache.get(phoneNumberId);
    if (c !== undefined && t - c.lue < CACHE_MS) return c.valeur;
    const { rows } = await this.pool.query<{
      id: string; tenant_id: string; phone_number_id: string; waba_id: string | null; origine: 'ops' | 'option'; depuis: Date; arretee_le: Date | null;
    }>(
      `select id, tenant_id, phone_number_id, waba_id, origine, depuis, arretee_le
         from lignes_credit_whatsapp where phone_number_id = $1 and retiree_le is null`,
      [phoneNumberId],
    );
    const r = rows[0];
    const valeur: LigneCredit | null = r === undefined ? null : {
      id: r.id,
      tenantId: r.tenant_id,
      phoneNumberId: r.phone_number_id,
      wabaId: r.waba_id,
      origine: r.origine,
      depuis: r.depuis.toISOString(),
      arreteeLe: r.arretee_le?.toISOString() ?? null,
    };
    this.cache.set(phoneNumberId, { lue: t, valeur });
    return valeur;
  }

  /** Les lignes en cours d'un espace (la vue de `/ops`, l'achat permis). */
  async lignesDeLEspace(tenantId: string): Promise<LigneCredit[]> {
    const { rows } = await this.pool.query<{
      id: string; tenant_id: string; phone_number_id: string; waba_id: string | null; origine: 'ops' | 'option'; depuis: Date; arretee_le: Date | null;
    }>(
      `select id, tenant_id, phone_number_id, waba_id, origine, depuis, arretee_le
         from lignes_credit_whatsapp where tenant_id = $1 and retiree_le is null order by depuis`,
      [tenantId],
    );
    return rows.map((r) => ({
      id: r.id, tenantId: r.tenant_id, phoneNumberId: r.phone_number_id, wabaId: r.waba_id, origine: r.origine,
      depuis: r.depuis.toISOString(), arreteeLe: r.arretee_le?.toISOString() ?? null,
    }));
  }

  /** Un numéro de CET espace, `null` s'il n'en est pas (un numéro d'un autre espace ne se lit pas). */
  async numeroDeLEspace(tenantId: string, phoneNumberId: string): Promise<NumeroPourLaLigne | null> {
    const { rows } = await this.pool.query<{ waba_id: string | null; fournisseur: string; coexistence: boolean; delie: boolean }>(
      `select p.waba_id, coalesce(w.fournisseur, 'meta') as fournisseur, p.coexistence, p.delie_le is not null as delie
         from phone_numbers p left join waba_credentials w on w.waba_id = p.waba_id
        where p.tenant_id = $1 and p.id = $2`,
      [tenantId, phoneNumberId],
    );
    const r = rows[0];
    return r === undefined ? null : { wabaId: r.waba_id, fournisseur: r.fournisseur, coexistence: r.coexistence, delie: r.delie };
  }

  /**
   * Met un numéro sur la ligne. `false` s'il y est déjà (une ligne en cours par numéro, garanti par l'index unique).
   * L'appelant a vérifié que le numéro appartient à l'espace (`tenant_id = $1` côté route).
   */
  async poser(tenantId: string, phoneNumberId: string, wabaId: string | null, origine: 'ops' | 'option', note: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `insert into lignes_credit_whatsapp (tenant_id, phone_number_id, waba_id, origine, note) values ($1, $2, $3, $4, $5)
       on conflict (phone_number_id) where retiree_le is null do nothing`,
      [tenantId, phoneNumberId, wabaId, origine, note],
    );
    this.cache.delete(phoneNumberId);
    return (rowCount ?? 0) > 0;
  }

  /** L'option a pris fin : les envois du numéro s'arrêtent, la ligne reste en cours (elle paie encore chez Meta). */
  async arreter(tenantId: string, phoneNumberId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `update lignes_credit_whatsapp set arretee_le = now()
        where tenant_id = $1 and phone_number_id = $2 and retiree_le is null and arretee_le is null`,
      [tenantId, phoneNumberId],
    );
    this.cache.delete(phoneNumberId);
    return (rowCount ?? 0) > 0;
  }

  /** Le numéro a quitté la ligne pour de bon : la garde l'ignore. */
  async retirer(tenantId: string, phoneNumberId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `update lignes_credit_whatsapp set retiree_le = now(), arretee_le = coalesce(arretee_le, now())
        where tenant_id = $1 and phone_number_id = $2 and retiree_le is null`,
      [tenantId, phoneNumberId],
    );
    this.cache.delete(phoneNumberId);
    return (rowCount ?? 0) > 0;
  }
}
