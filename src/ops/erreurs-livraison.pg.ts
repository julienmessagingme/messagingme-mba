import type { Pool } from 'pg';

/**
 * LE JOURNAL DES ERREURS DE LIVRAISON : ce que Meta nous a répondu quand un message n'est pas parti, ou n'est
 * pas arrivé.
 *
 * Julien, le 2026-09-02 : « n'est-il pas nécessaire d'avoir un log des erreurs qui nous sont retournées ?
 * genre le log de retour de l'api meta avec le code erreur... utile quand on a des campagnes et qu'on a des
 * messages d'erreur car tel ou tel message n'est pas délivré ». La donnée existait déjà, par destinataire,
 * mais il fallait ouvrir chaque campagne une par une pour la voir : personne ne le fait, donc personne ne
 * voyait rien.
 *
 * 🔴 CE JOURNAL PORTE LES NUMÉROS, CONTRAIREMENT AU JOURNAL DES ACTIONS, et ce n'est pas une inconséquence.
 * Les deux répondent à des questions opposées :
 *  - le journal des ACTIONS est une preuve immuable de qui a fait quoi. Y écrire un numéro annulerait la purge
 *    d'un contact, en le réinscrivant dans une table faite pour ne jamais être modifiée (migration 0061) ;
 *  - celui-ci est de l'EXPLOITATION : « quel message n'est pas arrivé, et à qui ». Sans le numéro, il ne
 *    répond à rien. Il n'a rien d'immuable, il se lit depuis `campaign_recipients`, et il DISPARAÎT avec le
 *    contact quand on le purge, ce qui est exactement le comportement voulu.
 *
 * Store de LECTURE seule : rien n'est écrit ici, les erreurs sont déjà posées par l'envoi et par le webhook de
 * statut. Une table de plus qui recopierait ces lignes serait une seconde vérité à tenir à jour.
 */

export interface ErreurLivraison {
  recipientId: string;
  campaignId: string;
  campaignName: string;
  /** Le numéro tel qu'il a été appelé. Figé à la construction de la campagne, comme `to_e164`. */
  telephone: string;
  contactId: string | null;
  contactNom: string | null;
  /** Code numérique de Meta (131049, 131026, 130429...). `null` quand l'échec n'en portait pas. */
  code: number | null;
  /** Message d'erreur tel qu'il nous est revenu, borné à l'affichage. */
  message: string | null;
  /**
   * D'où vient l'échec, et la distinction compte pour diagnostiquer :
   *  - `envoi` : Meta a refusé l'appel lui-même (`status = 'failed'`), donc le message n'est jamais parti ;
   *  - `livraison` : l'appel a réussi, et c'est le webhook de statut qui a ensuite signalé l'échec.
   */
  origine: 'envoi' | 'livraison';
  at: string | null;
}

export interface FiltreErreurs {
  limit?: number;
  /** Cherche dans le message, le code, le nom de la campagne et le numéro. */
  q?: string;
  telephone?: string;
  code?: number;
}

interface Ligne {
  recipient_id: string; campaign_id: string; campaign_name: string; to_e164: string;
  contact_id: string | null; contact_nom: string | null;
  error_code: number | null; error: string | null; status: string;
  delivery_status: string | null; at: Date | null;
}

export class PgErreursLivraisonStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Les échecs d'un espace, du plus récent au plus ancien.
   *
   * ⚠️ « En échec » a DEUX définitions en base, et n'en prendre qu'une en cacherait la moitié : `status =
   * 'failed'` est le refus SYNCHRONE à l'envoi, `delivery_status = 'failed'` est l'échec ASYNCHRONE signalé
   * par le webhook (le `status` reste alors `sent`). C'est la même définition que celle de l'auto-relance et
   * des statistiques : trois lectures qui divergeraient donneraient trois chiffres différents du même fait.
   */
  async lister(tenantId: string, filtre: FiltreErreurs = {}): Promise<ErreurLivraison[]> {
    const limit = Math.min(Math.max(filtre.limit ?? 200, 1), 1000);
    const where = [
      'c.tenant_id = $1',
      "(r.status = 'failed' or r.delivery_status = 'failed')",
    ];
    const params: unknown[] = [tenantId];
    const ajouter = (fragment: (n: number) => string, valeur: unknown): void => {
      params.push(valeur);
      where.push(fragment(params.length));
    };
    if (filtre.telephone) ajouter((n) => `r.to_e164 ilike '%' || $${n} || '%'`, filtre.telephone);
    if (filtre.code !== undefined) ajouter((n) => `r.error_code = $${n}`, filtre.code);
    if (filtre.q) {
      ajouter(
        (n) => `(r.error ilike '%' || $${n} || '%' or r.error_code::text ilike '%' || $${n} || '%'
                 or c.name ilike '%' || $${n} || '%' or r.to_e164 ilike '%' || $${n} || '%')`,
        filtre.q,
      );
    }
    params.push(limit);

    const res = await this.pool.query<Ligne>(
      // `ct.tenant_id = c.tenant_id` sur la jointure du contact : sans lui, un identifiant de contact d'un
      // autre espace remonterait son nom ici. Le pooler est superuser, la RLS ne joue pas.
      `select r.id as recipient_id, c.id as campaign_id, c.name as campaign_name, r.to_e164,
              ct.id as contact_id, ct.profile_name as contact_nom,
              r.error_code, r.error, r.status, r.delivery_status,
              coalesce(r.delivery_updated_at, r.sent_at) as at
         from campaign_recipients r
           join campaigns c on c.id = r.campaign_id
           left join contacts ct on ct.id = r.contact_id and ct.tenant_id = c.tenant_id
        where ${where.join(' and ')}
        order by coalesce(r.delivery_updated_at, r.sent_at) desc nulls last
        limit $${params.length}`,
      params,
    );

    return res.rows.map((r) => ({
      recipientId: r.recipient_id,
      campaignId: r.campaign_id,
      campaignName: r.campaign_name,
      telephone: r.to_e164,
      contactId: r.contact_id,
      contactNom: r.contact_nom,
      code: r.error_code,
      // Borné : un message d'erreur de Meta peut embarquer une trace, et l'écran n'en a pas besoin pour
      // diagnostiquer. La ligne complète reste dans la campagne.
      message: r.error === null ? null : r.error.slice(0, 500),
      origine: r.status === 'failed' ? 'envoi' : 'livraison',
      at: r.at ? r.at.toISOString() : null,
    }));
  }
}
