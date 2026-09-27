import type { Pool } from 'pg';
import { classifyWaId } from '../crm/identity';

/**
 * Faits d'identité et de canal nécessaires au connecteur CRM, par conversation (il ne lit jamais notre base).
 * `analyzedAt` versionne l'eventId. Horodatages en texte, pour garder la précision à la µs.
 */
export interface Enrichment {
  contactE164: string; // wa_id : numéro du client (ou BSUID)
  profileName: string | null;
  whatsappLine: string; // numéro d'affichage de la ligne de l'espace
  lastInboundAt: string | null; // dernier entrant WhatsApp : pilote la fenêtre de 24 h de Meta (voir la requête)
  analyzedAt: string | null;
}

interface Row {
  contact_e164: string;
  profile_name: string | null;
  whatsapp_line: string | null;
  last_inbound_at: string | null;
  analyzed_at: string | null;
}

/**
 * Construit l'enrichissement d'une conversation, `null` si elle n'existe plus. `whatsappLine` = premier numéro de
 * l'espace (suffisant tant qu'un espace n'a qu'un numéro).
 * `last_inbound_at` est restreint au canal WhatsApp : il pilote la fenêtre de 24 h, et un tap RCS laisserait croire
 * au commercial qu'il peut répondre en texte libre (refus 131047). Un autre canal aurait son propre champ.
 */
export async function getEnrichment(pool: Pool, conversationId: string): Promise<Enrichment | null> {
  const res = await pool.query<Row>(
    `select
       c.wa_id as contact_e164,
       ct.profile_name as profile_name,
       c.analyzed_at::text as analyzed_at,
       (select max(m.created_at)::text from conversation_messages m
          where m.conversation_id = c.id and m.direction = 'in' and m.channel = 'whatsapp') as last_inbound_at,
       (select pn.display_phone_number from phone_numbers pn
          where pn.tenant_id = c.tenant_id order by pn.created_at asc limit 1) as whatsapp_line
     from conversations c
     left join contacts ct on ct.id = c.contact_id
     where c.id = $1`,
    [conversationId],
  );
  if ((res.rowCount ?? 0) === 0) return null;
  const r = res.rows[0]!;
  // wa_id brut = chiffres sans `+` : normalisé en E.164 (classifyWaId). Un BSUID passe tel quel.
  const contactE164 = classifyWaId(r.contact_e164).phoneE164 ?? r.contact_e164;
  return {
    contactE164,
    profileName: r.profile_name ?? null,
    whatsappLine: r.whatsapp_line ?? 'unknown', // ligne inconnue : valeur non vide (le connecteur exige un canal)
    lastInboundAt: r.last_inbound_at ?? null,
    analyzedAt: r.analyzed_at ?? null,
  };
}
