import type { Pool } from 'pg';
import { vautReponseDeLEquipe, type OrigineMessage } from '../inbox/origine';

/**
 * 🔴 DEUX AGENTS DE MESSAGING ME NE SE RÉPONDENT PAS EN BOUCLE (décision de Julien du 2026-10-30). Vécu ce soir-là : la
 * bulle de l'espace de démo touchée depuis un téléphone dont le WhatsApp est servi par un AUTRE espace, qui a son propre
 * agent. Chacun a répondu à l'autre, six fois par minute, jusqu'à ce qu'un « Stop » tapé sur le téléphone retire l'un
 * d'eux ; rien d'autre ne les aurait arrêtés avant le plafond de tours de chaque session, chaque tour payé sur le crédit
 * d'un client.
 *
 * La garde : un message qui vient d'un numéro servi par un autre espace, et que la MACHINE de cet espace vient d'écrire
 * (agent IA, scénario, campagne, agent de Meta, API), ne reçoit pas de réponse de notre agent. La boucle s'arrête donc
 * après une seule réponse. Un message tapé à la main depuis ce numéro (l'écho du téléphone, enregistré `humain`) a
 * toujours la sienne : c'est l'essai de la bulle, qu'on veut garder.
 *
 * On lit le DERNIER sortant de l'autre espace vers nous, et seulement s'il a moins de `FENETRE_NOS_MACHINES_SECONDES` :
 * une boucle se joue en secondes, et une vieille réponse d'agent ne doit pas faire taire, des heures plus tard, un
 * humain dont l'écho manquerait. Une origine absente (un chemin d'écriture qui l'oublierait) ne compte pas comme une
 * machine : taire un humain à tort coûte plus cher que quelques tours.
 *
 * ⚠️ LECTURE ENTRE ESPACES, délibérée et bornée : elle rend un booléen au tour de l'espace `tenantId`, jamais une ligne
 * de l'autre espace. ⚠️ Fenêtre de course connue : si l'agent d'en face n'a pas encore enregistré son envoi quand ce tour
 * démarre, la garde ne le voit pas et la boucle dure un échange de plus ; et si la machine de l'autre espace a écrit dans la
 * fenêtre juste avant qu'une personne y tape à la main, le tour peut lire la machine avant l'écho de la personne, et se
 * taire une fois à tort (le message suivant est servi). Un robot d'un autre éditeur n'est pas couvert, ni une boucle
 * entre deux scénarios. Une origine inconnue non vide compte comme une machine.
 */
export const FENETRE_NOS_MACHINES_SECONDES = 120;

/** Le dernier sortant de l'autre espace vers nous, tel que la garde le juge. */
export interface DernierSortant {
  origin: string | null;
  senderUserId: string | null;
  type: string | null;
}

/** Ce sortant a-t-il été écrit par une machine ? Une réponse qui vaut celle d'une personne (`humain`, Claude signé d'un
 *  collaborateur) n'en est pas une, une origine absente non plus. */
export function ecritParUneMachine(d: DernierSortant | null): boolean {
  if (!d || d.origin === null) return false;
  return !vautReponseDeLEquipe(d.origin as OrigineMessage, d.senderUserId, d.type ?? 'text');
}

const CHIFFRES_SQL = (colonne: string) => `regexp_replace(coalesce(${colonne}, ''), '[^0-9]', '', 'g')`;

/**
 * Deux lectures, et c'est voulu : chaque tour d'agent passe ici. La première dit les numéros de l'espace qui reçoit
 * (`nous`) et les AUTRES espaces que sert le numéro qui écrit (`eux`), sur les seuls numéros en service (un numéro API
 * délié, un compte de l'application retiré, banni ou déconnecté ne parlent plus pour nous, et un numéro recyclé ne doit
 * pas faire taire son nouveau titulaire). Le cas courant, un contact qui n'est le numéro d'aucun espace, s'arrête là. La
 * seconde lit le dernier sortant par égalités sur l'unique `(tenant_id, wa_id)` de `conversations` et l'index partiel
 * `conversation_messages_origin_idx` (`direction = 'out'`).
 */
export function creerEcritParNosMachines(pool: Pick<Pool, 'query'>): (tenantId: string, waId: string) => Promise<boolean> {
  return async (tenantId, waId) => {
    // Un identifiant masqué (`…@lid`) ou un BSUID n'est le numéro d'aucun espace.
    if (!/^[0-9]{8,15}$/.test(waId)) return false;
    const numeros = await pool.query<{ nous: string[]; eux: string[] }>(
      `select
         (select coalesce(array_agg(distinct x.chiffres) filter (where x.chiffres <> ''), '{}')
            from (select ${CHIFFRES_SQL('display_phone_number')} as chiffres from phone_numbers where tenant_id = $1 and delie_le is null
                  union select numero from comptes_application where tenant_id = $1 and statut in ('relie', 'sommeil')) x) as nous,
         (select coalesce(array_agg(distinct y.tenant_id::text), '{}')
            from (select tenant_id from phone_numbers where ${CHIFFRES_SQL('display_phone_number')} = $2 and delie_le is null
                  union select tenant_id from comptes_application where numero = $2 and statut in ('relie', 'sommeil')) y
           where y.tenant_id <> $1) as eux`,
      [tenantId, waId],
    );
    const { nous, eux } = numeros.rows[0] ?? { nous: [], eux: [] };
    if (nous.length === 0 || eux.length === 0) return false;
    const r = await pool.query<{ origin: string | null; sender_user_id: string | null; type: string | null }>(
      `select m.origin, m.sender_user_id, m.type
         from conversations c
         join conversation_messages m on m.conversation_id = c.id
        where c.tenant_id = any($1::uuid[]) and c.wa_id = any($2::text[])
          and m.direction = 'out' and m.type is distinct from 'reaction'
          and m.created_at > now() - make_interval(secs => $3)
        order by m.created_at desc
        limit 1`,
      [eux, nous, FENETRE_NOS_MACHINES_SECONDES],
    );
    const l = r.rows[0];
    return ecritParUneMachine(l ? { origin: l.origin, senderUserId: l.sender_user_id, type: l.type } : null);
  };
}
