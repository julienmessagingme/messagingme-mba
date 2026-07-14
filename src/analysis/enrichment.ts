import type { Pool } from 'pg';
import { classifyWaId } from '../crm/identity';

/**
 * Faits d'identité/canal nécessaires au connecteur CRM, PAR conversation (le connecteur ne lit jamais la DB de mba).
 * `analyzedAt` sert de version pour l'eventId (une réanalyse -> analyzedAt différent -> le connecteur retraite).
 * Timestamps en TEXTE (précision µs préservée, cf. le round-trip Date/ms de la Pièce 1).
 */
export interface Enrichment {
  contactE164: string; // wa_id : numéro client (ou BSUID à terme)
  profileName: string | null;
  whatsappLine: string; // numéro d'affichage de la ligne du tenant (routage HubSpot plus tard)
  lastInboundAt: string | null; // dernier message ENTRANT : pilote la fenêtre 24h Meta
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
 * Construit l'enrichissement d'une conversation. `whatsappLine` = 1er numéro du tenant (OK pilote mono-numéro ;
 * migration `conversations.phone_number_id` quand un tenant devient multi-numéros). null si la conversation n'existe plus.
 */
export async function getEnrichment(pool: Pool, conversationId: string): Promise<Enrichment | null> {
  const res = await pool.query<Row>(
    `select
       c.wa_id as contact_e164,
       ct.profile_name as profile_name,
       c.analyzed_at::text as analyzed_at,
       (select max(m.created_at)::text from conversation_messages m
          where m.conversation_id = c.id and m.direction = 'in') as last_inbound_at,
       (select pn.display_phone_number from phone_numbers pn
          where pn.tenant_id = c.tenant_id order by pn.created_at asc limit 1) as whatsapp_line
     from conversations c
     left join contacts ct on ct.id = c.contact_id
     where c.id = $1`,
    [conversationId],
  );
  if ((res.rowCount ?? 0) === 0) return null;
  const r = res.rows[0]!;
  // wa_id brut = chiffres SANS `+` (Meta) -> normaliser en E.164 comme le reste du repo (classifyWaId). Un BSUID
  // (non numérique) passe tel quel (le connecteur le distinguera au Lot C ; zéro trafic BSUID aujourd'hui).
  const contactE164 = classifyWaId(r.contact_e164).phoneE164 ?? r.contact_e164;
  return {
    contactE164,
    profileName: r.profile_name ?? null,
    whatsappLine: r.whatsapp_line ?? 'unknown', // ligne inconnue : valeur non vide (le connecteur exige un canal)
    lastInboundAt: r.last_inbound_at ?? null,
    analyzedAt: r.analyzed_at ?? null,
  };
}
