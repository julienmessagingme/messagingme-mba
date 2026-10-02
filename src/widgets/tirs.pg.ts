import type { Pool } from 'pg';

/**
 * Les tirs des widgets d'UN espace (migration 0201), sous la forme exacte que le runner des automations lit et
 * écrit (`AutomationRunnerDeps['automations']`, moins `listEnabled`) : c'est ce qui permet de démarrer le scénario
 * d'un widget par `runAutomations`, avec son anti-rebond et son plafond horaire, sans recopier ces gardes.
 *
 * L'« identifiant d'automation » que le runner passe est celui du widget : l'automation équivalente n'existe qu'en
 * mémoire (`automationDuWidget`, `./arrivee.ts`), et elle porte l'`id` du widget.
 *
 * `firedSince` est REQUIS ici, alors qu'il est optionnel dans le contrat du runner : absent, le runner n'applique
 * AUCUN plafond, et `max_par_heure` deviendrait un réglage offert et inerte.
 */
export interface TirsDuWidget {
  lastFiredAt(widgetId: string, waId: string): Promise<Date | null>;
  markFired(widgetId: string, waId: string): Promise<boolean>;
  clearFired(widgetId: string, waId: string): Promise<void>;
  firedSince(widgetId: string, since: Date): Promise<number>;
}

/**
 * 🔴 `tenant_id = $1` SUR CHAQUE REQUÊTE : la connexion du pooler est superuser, la RLS est contournée, ce filtre
 * est le seul contrôle d'isolation. Les méthodes sont des fermetures sur l'espace : le contrat du runner ne passe
 * pas l'espace, et c'est l'appelant qui le fixe une fois, celui du message reçu.
 */
export class PgWidgetTirsStore {
  constructor(private readonly pool: Pool) {}

  pour(tenantId: string): TirsDuWidget {
    return {
      lastFiredAt: async (widgetId, waId) => {
        const res = await this.pool.query<{ tire_le: Date }>(
          'select tire_le from widget_tirs where tenant_id = $1 and widget_id = $2 and wa_id = $3',
          [tenantId, widgetId, waId],
        );
        return res.rows[0]?.tire_le ?? null;
      },
      /**
       * L'écriture passe par le widget, filtré sur l'espace : un identifiant d'un autre espace n'écrit rien, au
       * lieu d'écrire une ligne au nom de celui-ci. Sans marqueur, comme pour une automation ordinaire : l'écriture
       * est inconditionnelle (une ligne par contact, écrasée). `false` = le widget n'existe plus dans cet espace
       * (supprimé entre la lecture et le tir) : le runner ne démarre alors rien, ce qui est le bon résultat.
       */
      markFired: async (widgetId, waId) => {
        const res = await this.pool.query(
          `insert into widget_tirs (widget_id, tenant_id, wa_id, tire_le)
           select w.id, w.tenant_id, $3, now() from widgets w where w.tenant_id = $1 and w.id = $2
           on conflict (widget_id, wa_id) do update set tire_le = now()`,
          [tenantId, widgetId, waId],
        );
        return (res.rowCount ?? 0) > 0;
      },
      clearFired: async (widgetId, waId) => {
        await this.pool.query(
          'delete from widget_tirs where tenant_id = $1 and widget_id = $2 and wa_id = $3',
          [tenantId, widgetId, waId],
        );
      },
      firedSince: async (widgetId, since) => {
        const res = await this.pool.query<{ n: number }>(
          'select count(*)::int as n from widget_tirs where tenant_id = $1 and widget_id = $2 and tire_le >= $3',
          [tenantId, widgetId, since],
        );
        return Number(res.rows[0]?.n ?? 0);
      },
    };
  }
}
