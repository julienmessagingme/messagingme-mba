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

/**
 * Le numéro du contact tel que le connecteur le reçoit partout (`contactE164` de l'analyse, `e164` du passage à
 * l'équipe) : le wa_id brut (chiffres sans `+`) normalisé en E.164 par `classifyWaId`, un BSUID tel quel. Une seule
 * fonction, sinon les deux envois pourraient désigner deux contacts HubSpot différents pour la même personne.
 */
export function e164DuWaId(waId: string): string {
  return classifyWaId(waId).phoneE164 ?? waId;
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
  return {
    contactE164: e164DuWaId(r.contact_e164),
    profileName: r.profile_name ?? null,
    whatsappLine: r.whatsapp_line ?? 'unknown', // ligne inconnue : valeur non vide (le connecteur exige un canal)
    lastInboundAt: r.last_inbound_at ?? null,
    analyzedAt: r.analyzed_at ?? null,
  };
}

/**
 * L'état d'une conversation passée à l'équipe, relu par le job `push-handoff` au moment de pousser (le payload ne
 * porte que l'espace et le wa_id). `escaladeeLe` nul : plus personne n'attend (escalade close, ou passage sans
 * drapeau d'escalade). `dernierEntrantLe` : le dernier entrant WHATSAPP, qui ouvre la fenêtre de 24 h de Meta.
 */
export interface EtatPassage {
  conversationId: string;
  contactE164: string;
  nom: string | null;
  whatsappLine: string;
  dernierEntrantLe: Date | null;
  escaladeeLe: Date | null;
  /** Lot 2b (la relance) : qui tient le fil, et de quel côté est le dernier message. */
  controlOwner: string;
  dernierSens: 'in' | 'out' | null;
}

/**
 * Lit l'état du passage, `null` si la conversation n'existe pas DANS CET ESPACE (`tenant_id = $1`, le seul contrôle
 * d'isolation : la connexion contourne la RLS). Même ligne WhatsApp que `getEnrichment` (le premier numéro de
 * l'espace), donc la même porte HubSpot que la poussée de l'analyse.
 */
export async function getEtatPassage(pool: Pool, tenantId: string, waId: string): Promise<EtatPassage | null> {
  const res = await pool.query<{
    id: string; wa_id: string; profile_name: string | null; whatsapp_line: string | null; dernier_in: Date | null; escaladee_le: Date | null;
    control_owner: string; last_direction: 'in' | 'out' | null;
  }>(
    `select c.id, c.wa_id, ct.profile_name, c.escaladee_le, c.control_owner, c.last_direction,
            (select max(m.created_at) from conversation_messages m
              where m.conversation_id = c.id and m.direction = 'in' and m.channel = 'whatsapp') as dernier_in,
            (select pn.display_phone_number from phone_numbers pn
              where pn.tenant_id = c.tenant_id order by pn.created_at asc limit 1) as whatsapp_line
       from conversations c
       left join contacts ct on ct.id = c.contact_id and ct.tenant_id = c.tenant_id
      where c.tenant_id = $1 and c.wa_id = $2`,
    [tenantId, waId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    conversationId: r.id,
    contactE164: e164DuWaId(r.wa_id),
    nom: r.profile_name,
    whatsappLine: r.whatsapp_line ?? 'unknown', // comme `getEnrichment` : aucune ligne ne passe la porte HubSpot
    dernierEntrantLe: r.dernier_in,
    escaladeeLe: r.escaladee_le,
    controlOwner: r.control_owner,
    dernierSens: r.last_direction,
  };
}
