import type { Pool } from 'pg';
import { A_TRAITER_SQL } from './store.pg';
import { FENETRE_SERVICE_MS } from '../workflow/engine';

/**
 * LES CONVERSATIONS QUI ATTENDENT UN HUMAIN, POUR LA PAGE « MESSAGING ME » DE HUBSPOT (lot 4 de la reprise humaine, plan
 * `~/mm-hubspot/docs/2026-10-27-lot4-page-messaging-me-plan.md`, décisions A et B validées par Julien le 2026-10-27).
 * Lecture seule, à part du magasin de l'Inbox, comme celui de l'API (`src/api/conversations-v1.pg.ts`) : la liste de la
 * console est sur le chemin chaud de l'écran, ces champs ne la concernent pas.
 *
 * Décision A : le dossier « À traiter » de la console (`A_TRAITER_SQL`, le même texte), restreint aux fils que tient
 * l'équipe (`app_human` : ceux de l'agent de Meta ont un robot qui répond), ni archivés, sans fin de parcours en attente
 * (`release_mba_apres_message`), d'un contact ni bloqué ni STOP. STOP et bloqué se lisent sur la fiche de la conversation,
 * comme la console, et non par le numéro comme les routes d'envoi : `matchWaIdPredicat` ne passe par aucun index, le lire
 * pour chaque ligne balaierait les contacts de l'espace autant de fois. Un écart entre les deux lectures ne peut qu'afficher
 * une ligne : l'envoi relit par le numéro et refuse. `is distinct from` et non `<>` : une conversation sans fiche
 * (`contact_id` nul) attend aussi, et un prédicat NULL l'exclurait en silence.
 *
 * Décision B : les urgentes d'abord, puis l'attente la plus ancienne. L'attente part de l'escalade, sinon du PREMIER
 * message du client resté sans réponse (un client qui insiste ne recule pas), sinon du dernier message. Par l'index
 * `(conversation_id, created_at)` des messages, pour les seules conversations retenues.
 *
 * 🔴 ISOLATION : `c.tenant_id = $1` dans la requête même. Les messages n'ont pas d'espace : la jointure sur la
 * conversation EST le contrôle. Le nom d'un affectataire ne se lit pas ici (une jointure `users` ne filtre pas l'espace) :
 * la route le trouve parmi les membres de l'espace.
 */

/** Une conversation qui attend, telle que la base la rend. */
export interface LigneATraiter {
  conversationId: string;
  nom: string | null;
  /** Le numéro du client : celui de sa fiche, sinon le `wa_id` quand c'en est un (un BSUID n'en est pas). */
  numero: string | null;
  apercu: string | null;
  attendDepuis: string;
  motif: 'escalade' | 'message';
  fenetreOuverte: boolean;
  finFenetre: string | null;
  affecteA: string | null;
  urgente: boolean;
}

/** L'aperçu d'une ligne : une phrase, pas un message entier. */
export const APERCU_MAX = 140;

/** Le premier message du client depuis notre dernier sortant, pour la conversation `id`. */
const premierSansReponse = (id: string) => `(select min(m.created_at) from conversation_messages m
   where m.conversation_id = ${id} and m.direction = 'in'
     and m.created_at > coalesce((select max(o.created_at) from conversation_messages o
                                   where o.conversation_id = ${id} and o.direction = 'out'), '-infinity'::timestamptz))`;

/** Le dernier message WhatsApp du contact : la fenêtre de 24 h en part (la règle de `getConversationContext`). */
const dernierEntrant = (id: string) => `(select max(m.created_at) from conversation_messages m
   where m.conversation_id = ${id} and m.direction = 'in' and m.channel = 'whatsapp')`;

export class PgATraiterHubspot {
  constructor(private readonly pool: Pool, private readonly now: () => number = () => Date.now()) {}

  /** Les `limite` premières dans l'ordre de la décision B, et le total de celles qui attendent. */
  async lister(tenantId: string, limite: number): Promise<{ total: number; lignes: LigneATraiter[] }> {
    const res = await this.pool.query<{
      id: string; wa_id: string; profile_name: string | null; phone_e164: string | null; last_preview: string | null;
      attend_depuis: Date; escaladee: boolean; dernier_entrant: Date | null; assigned_to: string | null; urgente: boolean;
      total: string;
    }>(
      `with retenues as (
         select c.id, c.wa_id, c.last_preview, c.assigned_to, c.escaladee_le, c.last_message_at,
                (c.urgente_le is not null) as urgente, ct.profile_name, ct.phone_e164
           from conversations c
           left join contacts ct on ct.id = c.contact_id
          where c.tenant_id = $1
            and c.control_owner = 'app_human'
            and ${A_TRAITER_SQL}
            and c.archived_at is null
            and c.release_mba_apres_message is null
            and ct.blocked_at is null
            and ct.opt_in_status is distinct from 'opted_out'
       ), datees as (
         select r.*, coalesce(r.escaladee_le, ${premierSansReponse('r.id')}, r.last_message_at) as attend_depuis
           from retenues r
       )
       select d.id, d.wa_id, d.profile_name, d.phone_e164, d.last_preview, d.attend_depuis, (d.escaladee_le is not null) as escaladee,
              ${dernierEntrant('d.id')} as dernier_entrant,
              d.assigned_to, d.urgente, count(*) over () as total
         from datees d
        order by d.urgente desc, d.attend_depuis asc, d.id asc
        limit $2`,
      [tenantId, limite],
    );
    const maintenant = this.now();
    return {
      total: res.rows.length > 0 ? Number(res.rows[0]!.total) : 0,
      lignes: res.rows.map((r) => {
        const fin = r.dernier_entrant ? new Date(r.dernier_entrant.getTime() + FENETRE_SERVICE_MS) : null;
        return {
          conversationId: r.id,
          nom: r.profile_name,
          numero: r.phone_e164 ?? (/^\d{6,15}$/.test(r.wa_id) ? `+${r.wa_id}` : null),
          apercu: r.last_preview === null ? null : r.last_preview.slice(0, APERCU_MAX),
          attendDepuis: r.attend_depuis.toISOString(),
          motif: r.escaladee ? 'escalade' : 'message',
          fenetreOuverte: fin !== null && fin.getTime() > maintenant,
          finFenetre: fin ? fin.toISOString() : null,
          affecteA: r.assigned_to,
          urgente: r.urgente === true,
        };
      }),
    };
  }
}
