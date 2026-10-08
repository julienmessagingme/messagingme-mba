import type { Pool, PoolClient } from 'pg';
import { enTransaction } from '../db/transaction';
import { texteDe } from '../lib/erreur';
import { VERROU_NUMERO_PRO_SQL } from './verrou-numero-pro';

/**
 * LA LIBÉRATION D'UN NUMÉRO FOURNI (lot 4, livraison B, spec `docs/superpowers/specs/2026-10-06-numero-impaye-design.md`
 * § 4.1). Sept jours après la fin d'un abonnement, le numéro fourni quitte l'espace :
 *  - vu de Meta (connecté, ou un code de Meta capté pour lui) : retiré de l'espace, résilié chez DIDWW, puis `resilie`
 *    dans la réserve. Meta met un numéro retiré en quarantaine : il ne servira plus à personne ;
 *  - jamais vu de Meta : `libre` dans la réserve, sans rien chez DIDWW ;
 *  - aucun numéro attribué (rendu par « Abandonner ») : seule la date de libération se pose.
 *
 * 🔴 RETIRÉ, ET NON DÉLIÉ (rouge 1 de la relecture de la livraison B). La ligne `phone_numbers` du numéro quitte l'espace :
 * un espace n'a droit qu'à UN numéro (`linkTenant`, `lierCompteSansNumero`, et la route du paiement qui lit le numéro
 * connecté), et une ligne déliée gardée lui interdisait pour toujours d'en connecter un autre. Aucune clé étrangère ne
 * la référence ; l'espace redevient sans numéro, comme un nouveau client.
 *
 * 🔴 UNE SEULE TRANSACTION, APPEL DIDWW COMPRIS. Un échec chez DIDWW annule le retrait et la réserve : rien n'est à moitié
 * fait, le numéro reste suspendu (la garde coupe toujours ses envois), et le balayage suivant rejoue. Les verrous tiennent
 * au plus le délai du client DIDWW (15 s).
 *
 * 🔴 LA LIBÉRATION PART DE L'ABONNEMENT COURANT : un espace réabonné (un abonnement vivant) ne se libère pas, même si sa
 * vieille ligne résiliée remplit les conditions. Et le retrait ne touche QUE le numéro aux chiffres du numéro fourni (ou
 * aux chiffres inconnus) : un numéro que le client a apporté ne quitte jamais l'espace par la libération.
 *
 * ⚠️ La preuve « un code de Meta capté » tient parce que la purge des codes épargne ceux d'un numéro ATTRIBUÉ (rouge 2 de
 * la même relecture) : sans quoi, purgés à 7 jours, ils manquaient toujours à la libération.
 */

export type IssueLiberation =
  | { fait: 'rien' }
  | { fait: 'sans_numero' }
  | { fait: 'libre'; numero: string }
  | { fait: 'resilie'; numero: string; retire: boolean };

/**
 * Ce qu'est devenu le numéro fourni d'un espace SUPPRIMÉ (RC8, `src/ops/suppression-espace.ts`) :
 *  - `aucun` : l'espace n'avait aucun numéro attribué ;
 *  - `libre` : jamais vu de Meta, rendu à la réserve ;
 *  - `resilie` : vu de Meta, résilié chez DIDWW ;
 *  - `bloque` : vu de Meta, mais DIDWW n'a pas pu le résilier (pas configuré, ou refus) : il sort de la réserve sans être
 *    résilié, pour que Julien décide (`cause`), comme un numéro que Meta refuse.
 */
export type IssueSortieNumero =
  | { fait: 'aucun' }
  | { fait: 'libre'; numero: string }
  | { fait: 'resilie'; numero: string }
  | { fait: 'bloque'; numero: string; cause: string };

/**
 * Le numéro fourni de l'espace a-t-il été vu de Meta : relié à l'espace (ses chiffres, ou des chiffres inconnus), ou un
 * code de Meta capté pour lui ? Une seule définition pour la libération et pour la suppression d'un espace : vu de Meta,
 * il est en quarantaine chez Meta et ne resservira à personne ; jamais vu, il retourne à la réserve. Rend aussi les
 * lignes `phone_numbers` qui le portent, que la libération retire de l'espace.
 */
export async function vuDeMeta(db: Pool | PoolClient, tenantId: string, fourni: { id: string; numero: string }): Promise<{ connectes: string[]; vu: boolean }> {
  const connectes = await db.query<{ id: string }>(
    `select id from phone_numbers
      where tenant_id = $1 and regexp_replace(coalesce(display_phone_number, ''), '[^0-9]', '', 'g') in ('', $2)`,
    [tenantId, fourni.numero],
  );
  const code = await db.query(`select 1 from codes_verification where numero_id = $1 limit 1`, [fourni.id]);
  return { connectes: connectes.rows.map((r) => r.id), vu: (connectes.rowCount ?? 0) > 0 || (code.rowCount ?? 0) > 0 };
}

/** La libération demande DIDWW et la clé n'est pas posée dans ce processus : une panne d'exploitation, à signaler. */
export class DidwwNonConfigure extends Error {
  constructor() {
    super('DIDWW n’est pas configuré dans ce processus (DIDWW_API_KEY) : la libération ne peut pas résilier le numéro');
    this.name = 'DidwwNonConfigure';
  }
}

export class PgLiberationStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Libère l'abonnement `abonnementId` de l'espace s'il est fini depuis 7 jours et pas encore libéré. `resilier` : le
   * geste DIDWW (`null` = non configuré, ce qui lève `DidwwNonConfigure` si le numéro doit être résilié). Toute erreur
   * remonte et annule la transaction.
   */
  async liberer(
    tenantId: string, abonnementId: string, resilier: ((didId: string) => Promise<void>) | null, maintenant: Date = new Date(),
  ): Promise<IssueLiberation> {
    return enTransaction(this.pool, async (client) => {
      // J2 (lot 6, B2b) : le verrou d'espace commun avec l'enregistrement d'un Pro, AVANT toute lecture.
      await client.query(VERROU_NUMERO_PRO_SQL, [tenantId]);
      const due = await client.query(
        `select 1 from abonnements_numero
          where stripe_subscription_id = $1 and tenant_id = $2 and libere_le is null
            and fini_le is not null and fini_le <= $3::timestamptz - interval '7 days'
          for update skip locked`,
        [abonnementId, tenantId, maintenant],
      );
      if ((due.rowCount ?? 0) === 0) return { fait: 'rien' } as const;
      // Réabonné entre-temps : l'espace garde son numéro.
      const vivant = await client.query(
        `select 1 from abonnements_numero where tenant_id = $1 and statut <> 'resilie' limit 1`, [tenantId],
      );
      if ((vivant.rowCount ?? 0) > 0) return { fait: 'rien' } as const;
      // 🔴 Un Pro payé entre-temps couvre le numéro (lot 6, B1, vigilance 4), avec la même grâce de 7 jours après sa fin
      // que `couvertureParLePro` : le balayage a lu l'état AVANT cette transaction, et la résiliation chez DIDWW est
      // irréversible.
      const pro = await client.query(
        `select 1 from abonnements_offre
          where tenant_id = $1 and (fini_le is null or fini_le > $2::timestamptz - interval '7 days') limit 1`,
        [tenantId, maintenant],
      );
      if ((pro.rowCount ?? 0) > 0) return { fait: 'rien' } as const;
      const poserLaDate = () => client.query(
        `update abonnements_numero set libere_le = now(), maj_le = now() where stripe_subscription_id = $1 and tenant_id = $2`,
        [abonnementId, tenantId],
      );
      const f = await client.query<{ id: string; numero: string; didww_did_id: string }>(
        `select id, numero, didww_did_id from numeros_fournis where tenant_id = $1 and statut = 'attribue' for update`,
        [tenantId],
      );
      const fourni = f.rows[0];
      if (!fourni) {
        await poserLaDate();
        return { fait: 'sans_numero' } as const;
      }
      const { connectes, vu } = await vuDeMeta(client, tenantId, fourni);
      if (!vu) {
        await client.query(
          `update numeros_fournis set statut = 'libre', tenant_id = null, attribue_le = null where id = $1`, [fourni.id],
        );
        await poserLaDate();
        return { fait: 'libre', numero: fourni.numero } as const;
      }
      const retire = connectes.length > 0;
      if (retire) {
        // Les campagnes WhatsApp vivantes passent en pause `numero_delie`, comme à un « Délier », et celles que la
        // suspension avait arrêtées changent de motif : sans quoi le balayage, voyant l'espace libéré et non plus
        // suspendu, lèverait leur pause. Elles attendent un numéro que l'espace n'a plus.
        await client.query(
          `update campaigns c set status = 'paused', pause_reason = 'numero_delie', paused_until = null
            where c.tenant_id = $1
              and (c.status in ('running', 'scheduled') or (c.status = 'paused' and c.pause_reason = 'numero_suspendu'))
              and (c.channel = 'whatsapp'
                   or exists (select 1 from campaign_etages e where e.campaign_id = c.id and e.canal = 'whatsapp'))`,
          [tenantId],
        );
        await client.query(
          `delete from phone_numbers where tenant_id = $1 and id = any($2::text[])`,
          [tenantId, connectes],
        );
      }
      if (resilier === null) throw new DidwwNonConfigure();
      await resilier(fourni.didww_did_id);
      await client.query(
        `update numeros_fournis set statut = 'resilie', tenant_id = null, attribue_le = null where id = $1`, [fourni.id],
      );
      await poserLaDate();
      return { fait: 'resilie', numero: fourni.numero, retire } as const;
    });
  }

  /**
   * Fait sortir le numéro fourni d'un espace qu'on va SUPPRIMER (RC8), avant la purge : la même décision que la
   * libération (`vuDeMeta`), sans ses conditions d'abonnement (un espace supprimé n'attend pas sept jours) ni le retrait
   * de ses lignes et la pause de ses campagnes (la purge emporte tout). Jamais vu de Meta : `libre`. Vu de Meta : résilié
   * chez DIDWW, puis `resilie` ; si DIDWW n'est pas configuré ou refuse, `bloque`, et la cause est rendue (Julien
   * résilie à la main). Ne lève que sur une panne de base : un refus de DIDWW est une issue, pas une erreur.
   */
  async sortirDeLEspaceSupprime(tenantId: string, resilier: ((didId: string) => Promise<void>) | null): Promise<IssueSortieNumero> {
    return enTransaction(this.pool, async (client) => {
      const f = await client.query<{ id: string; numero: string; didww_did_id: string }>(
        `select id, numero, didww_did_id from numeros_fournis where tenant_id = $1 and statut = 'attribue' for update`,
        [tenantId],
      );
      const fourni = f.rows[0];
      if (!fourni) return { fait: 'aucun' } as const;
      const sortir = (statut: 'libre' | 'resilie' | 'bloque') => client.query(
        `update numeros_fournis set statut = $2, tenant_id = null, attribue_le = null where id = $1 and tenant_id = $3`,
        [fourni.id, statut, tenantId],
      );
      if (!(await vuDeMeta(client, tenantId, fourni)).vu) {
        await sortir('libre');
        return { fait: 'libre', numero: fourni.numero } as const;
      }
      let cause: string | null = resilier === null ? new DidwwNonConfigure().message : null;
      if (resilier !== null) {
        try {
          await resilier(fourni.didww_did_id);
        } catch (err) {
          cause = texteDe(err);
        }
      }
      if (cause !== null) {
        await sortir('bloque');
        return { fait: 'bloque', numero: fourni.numero, cause } as const;
      }
      await sortir('resilie');
      return { fait: 'resilie', numero: fourni.numero } as const;
    });
  }
}
