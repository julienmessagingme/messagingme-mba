import { z } from 'zod';
import type { Pool } from 'pg';

/**
 * Le fil de l'assistant du MBA, en base (`mba_assistant_conversations`). Il perdure : ce qu'on conserve n'est pas
 * ce qu'on envoie au modèle, la borne se pose à la construction du prompt, jamais à l'écriture.
 * 🔴 `tenant_id = $1` sur chaque requête : la RLS est contournée par le pooler, ce filtrage est le contrôle
 * d'accès, et il doit se lire dans la requête même quand il est aussi la clé primaire.
 */

export interface TourMba { role: 'user' | 'assistant'; content: string }

export interface EntretienMba {
  messages: TourMba[];
  /** L'identifiant du membre qui a écrit chaque message, `null` pour l'assistant. */
  auteurs: Array<string | null>;
  reponses: Array<{ point: string; valeur: string }>;
  /** Les points déjà posés dans ce fil, pour ne pas les reposer en boucle. */
  poses: string[];
}

export const ENTRETIEN_MBA_VIERGE: EntretienMba = { messages: [], auteurs: [], reponses: [], poses: [] };

/** Cf. `MAX_CARACTERES_MESSAGE` de l'assistant d'agent IA : même plafond, même raison. */
export const MAX_CARACTERES_MESSAGE_MBA = 4000;
/** Ce que le fil conserve : garde contre un jsonb sans fin, pas une politique de contexte. */
export const MAX_TOURS_CONSERVES_MBA = 4000;
/** Ce qu'on envoie au modèle : un historique sans fin pousserait l'inventaire hors de la fenêtre. */
export const MAX_TOURS_MODELE_MBA = 20;

const tourSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(MAX_CARACTERES_MESSAGE_MBA),
});

const etatSchema = z.object({
  messages: z.array(tourSchema).max(MAX_TOURS_CONSERVES_MBA).default([]),
  auteurs: z.array(z.string().max(320).nullable()).max(MAX_TOURS_CONSERVES_MBA).default([]),
  reponses: z.array(z.object({
    point: z.string().max(64),
    valeur: z.string().max(2000),
  })).max(64).default([]),
  poses: z.array(z.string().max(64)).max(64).default([]),
});

/**
 * Relit un état stocké ; illisible -> entretien vierge, jamais une exception : un fil écrit par une autre version
 * ne doit pas rendre l'onglet inutilisable.
 */
export function lireEtatMba(brut: unknown): EntretienMba {
  const parse = etatSchema.safeParse(brut ?? {});
  return parse.success ? parse.data : ENTRETIEN_MBA_VIERGE;
}

/** Ce qui part au modèle : les derniers tours, jamais tout le fil. */
export function bornerPourModeleMba(messages: readonly TourMba[]): TourMba[] {
  return messages
    .slice(-MAX_TOURS_MODELE_MBA * 2)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CARACTERES_MESSAGE_MBA) }));
}

export interface EntretienMbaStore {
  lire(tenantId: string): Promise<EntretienMba | null>;
  ecrire(tenantId: string, etat: EntretienMba): Promise<void>;
  effacer(tenantId: string): Promise<void>;
}

export class PgEntretienMbaStore implements EntretienMbaStore {
  constructor(private readonly pool: Pool) {}

  async lire(tenantId: string): Promise<EntretienMba | null> {
    const r = await this.pool.query<{ messages: unknown; auteurs: unknown; reponses: unknown; poses: unknown }>(
      `select messages, auteurs, reponses, poses from mba_assistant_conversations where tenant_id = $1`,
      [tenantId],
    );
    return r.rows[0] ? lireEtatMba(r.rows[0]) : null;
  }

  async ecrire(tenantId: string, etat: EntretienMba): Promise<void> {
    // Aucune troncature ici : le fil perdure (une borne à l'écriture détruirait les tours anciens).
    await this.pool.query(
      `insert into mba_assistant_conversations (tenant_id, messages, auteurs, reponses, poses, updated_at)
       values ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, now())
       on conflict (tenant_id) do update
         set messages = excluded.messages, auteurs = excluded.auteurs,
             reponses = excluded.reponses, poses = excluded.poses, updated_at = now()`,
      [
        tenantId,
        JSON.stringify(etat.messages),
        JSON.stringify(etat.auteurs),
        JSON.stringify(etat.reponses),
        JSON.stringify(etat.poses),
      ],
    );
  }

  async effacer(tenantId: string): Promise<void> {
    await this.pool.query(`delete from mba_assistant_conversations where tenant_id = $1`, [tenantId]);
  }
}
