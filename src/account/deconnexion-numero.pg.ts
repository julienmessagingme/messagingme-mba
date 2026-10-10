import type { Pool } from 'pg';
import { enTransaction } from '../db/transaction';
import { consommateurMba } from '../agent/consommateur';
import { vuDeMeta } from '../numero/liberation.pg';
import { objetsMetaDeLEspace } from '../ops/suppression-espace.pg';
import type { BilanDeconnexion, ResultatDetachement } from './deconnexion-numero';

/** Les conversations effacées par passage : la purge par ancienneté borne les siens pour la même raison (verrous, WAL). */
export const CONVERSATIONS_PAR_LOT = 500;

/**
 * Les campagnes qu'un numéro détaché arrête : pas finies, et dont le canal PRINCIPAL est WhatsApp. Une campagne RCS à
 * repli WhatsApp continue : son étage WhatsApp devient inservable et le moteur le retire, alors qu'une campagne passée
 * `failed` pourrait être remise `running` par une relance ou une bascule d'étage (relecture du 2026-10-10).
 */
const CAMPAGNE_A_ARRETER_SQL = `c.tenant_id = $1 and c.status in ('running', 'scheduled', 'paused') and c.channel = 'whatsapp'`;

/**
 * LA LECTURE ET L'ÉCRITURE DE « DÉCONNECTER LE NUMÉRO ». L'ordre des étapes vit dans `deconnexion-numero.ts`.
 *
 * 🔴 ISOLATION : chaque requête porte `tenant_id = $1`, sauf l'effacement des webhooks bruts, qui n'ont pas de colonne
 * d'espace et se désignent par les numéros que l'espace porte, relus dans la transaction.
 * `tests/integration/deconnexion-numero.integration.test.ts` vérifie qu'un espace voisin sort intact.
 */
export class PgDeconnexionNumeroStore {
  constructor(private readonly pool: Pool) {}

  /** Le bilan, sans le jeton (le câblage le résout par le même résolveur que les appels). `null` = aucun numéro. */
  async bilan(tenantId: string): Promise<Omit<BilanDeconnexion, 'jeton'> | null> {
    const objets = await objetsMetaDeLEspace(this.pool, tenantId);
    const phoneNumberId = objets.phoneNumberIds[0];
    if (phoneNumberId === undefined) return null;
    const affiche = (await this.pool.query<{ display_phone_number: string | null }>(
      'select display_phone_number from phone_numbers where id = $1 and tenant_id = $2', [phoneNumberId, tenantId],
    )).rows[0]?.display_phone_number ?? null;

    // Le numéro fourni n'est concerné que s'il EST le numéro connecté, chiffres ÉGAUX. 🔴 Pas « ou des chiffres
    // inconnus » comme « Abandonner » : là, la règle REFUSE (sens sûr) ; ici elle résilierait chez DIDWW un numéro que
    // l'espace paie peut-être pour plus tard, alors qu'il a connecté le sien (relecture du 2026-10-10).
    const f = (await this.pool.query<{ id: string; numero: string }>(
      `select id, numero from numeros_fournis where tenant_id = $1 and statut = 'attribue'`, [tenantId],
    )).rows[0];
    const chiffres = (affiche ?? '').replace(/[^0-9]/g, '');
    const numeroFourni = f && chiffres !== '' && chiffres === f.numero
      ? { numero: f.numero, vuDeMeta: (await vuDeMeta(this.pool, tenantId, f)).vu }
      : null;

    const n = (await this.pool.query<{ conversations: number; campagnes: number; mba_allume: boolean; liste: number }>(
      `select (select count(*) from conversations where tenant_id = $1)::int as conversations,
              (select count(*) from campaigns c where ${CAMPAGNE_A_ARRETER_SQL})::int as campagnes,
              coalesce((select mba_enabled from tenant_settings where tenant_id = $1), false) as mba_allume,
              (select count(*) from mba_liste where tenant_id = $1)::int as liste`,
      [tenantId],
    )).rows[0]!;

    return {
      phoneNumberId,
      affiche,
      wabaId: objets.wabasPropres[0] ?? null,
      partage: objets.partage,
      numeroFourni,
      conversations: n.conversations,
      campagnesArretees: n.campagnes,
      mbaAllume: n.mba_allume,
      contactsSurLaListe: n.liste,
    };
  }

  /**
   * Efface les conversations de l'espace par lots de `parLot`, jusqu'à ce qu'il n'en reste plus ; rend le nombre effacé.
   * 🔴 Irréversible : les messages, l'analyse et les événements du fil partent par les cascades, comme à la purge par
   * ancienneté (`PgInboxStore.purgeConversationsOlderThan`). La fiche du contact reste.
   */
  async purgerConversations(tenantId: string, parLot: number = CONVERSATIONS_PAR_LOT): Promise<number> {
    const lot = Math.max(1, Math.floor(parLot));
    let total = 0;
    for (;;) {
      const r = await this.pool.query(
        `delete from conversations where id in (select id from conversations where tenant_id = $1 limit $2)`,
        [tenantId, lot],
      );
      const n = r.rowCount ?? 0;
      total += n;
      if (n < lot) return total;
    }
  }

  /**
   * Le détachement, en une transaction. `null` = l'espace n'a aucun numéro.
   *
   * - les campagnes WhatsApp pas finies passent `failed` : elles ne partiront plus jamais de ce numéro ; une campagne
   *   RCS, repli WhatsApp compris, ne bouge pas ;
   * - les conversations arrivées pendant le geste, effacées ;
   * - les webhooks bruts de ces numéros (ils portent le texte des messages) ;
   * - les consentements des outils de l'agent de Meta pour ces numéros, et sa liste (les contacts que Meta a refusé de
   *   retirer restent chez Meta, notre ligne ne désignerait plus rien) ;
   * - l'agent de Meta éteint dans les réglages, et le répondeur repassé de `mba` à `equipe` : un numéro connecté ensuite
   *   n'a pas son agent allumé chez Meta ; la pause HubSpot (`campaigns_paused`, « au moins un numéro en pause »)
   *   retombe, faute de numéro ;
   * - les numéros, puis les comptes WhatsApp de l'espace qui ne portent plus aucun numéro, dont le jeton part par la
   *   cascade. 🔴 Jamais un compte qui porte encore le numéro d'un AUTRE espace : la cascade de `phone_numbers.waba_id`
   *   l'emporterait (inatteignable aujourd'hui, `linkTenant` refuse le compte d'un autre espace, mais ce bouton est en
   *   libre-service).
   *
   * ⚠️ `credits_offerts` n'est pas touché : le crédit de bienvenue reste « une fois par numéro ».
   */
  async detacher(tenantId: string): Promise<ResultatDetachement | null> {
    return enTransaction(this.pool, async (client) => {
      const pns = (await client.query<{ id: string }>(
        'select id from phone_numbers where tenant_id = $1 for update', [tenantId],
      )).rows.map((r) => r.id);
      if (pns.length === 0) return null;
      const campagnes = await client.query(
        `update campaigns c set status = 'failed', pause_reason = null, paused_until = null where ${CAMPAGNE_A_ARRETER_SQL}`,
        [tenantId],
      );
      const conversations = await client.query('delete from conversations where tenant_id = $1', [tenantId]);
      await client.query('delete from webhook_events where phone_number_id = any($1::text[])', [pns]);
      await client.query(
        'delete from agent_tool_consommateurs where tenant_id = $1 and consommateur = any($2::text[])',
        [tenantId, pns.map(consommateurMba)],
      );
      await client.query('delete from mba_liste where tenant_id = $1', [tenantId]);
      await client.query(
        `update tenant_settings
            set mba_enabled = false,
                repondeur_mode = case when repondeur_mode = 'mba' then 'equipe' else repondeur_mode end,
                campaigns_paused = false
          where tenant_id = $1`,
        [tenantId],
      );
      await client.query('delete from phone_numbers where tenant_id = $1', [tenantId]);
      await client.query(
        `delete from waba w where w.tenant_id = $1 and not exists (select 1 from phone_numbers p where p.waba_id = w.id)`,
        [tenantId],
      );
      return { conversations: conversations.rowCount ?? 0, campagnesArretees: campagnes.rowCount ?? 0 };
    });
  }
}
