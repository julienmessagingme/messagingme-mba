import { z } from 'zod';
import { ACTIONS, type Bascule, type Reponse } from './couverture';
import { MAX_CARACTERES_MESSAGE, MAX_TOURS_HISTORIQUE } from './conversation';

/**
 * L'entretien de construction, tel que le serveur le tient (migration 0090).
 *
 * 🔴 IL EST RELU, DONC IL EST VALIDÉ. Ce jsonb a été écrit par un tour antérieur, à partir d'une sortie de
 * modèle : le relire sans le valider reviendrait à faire confiance à ce que le modèle avait rendu il y a une
 * semaine, sur la seule foi qu'il a transité par notre base. Même règle que pour tout payload externe du
 * dépôt, `safeParse` et jamais `parse` : un état corrompu redémarre un entretien vierge plutôt que de faire
 * échouer l'écran.
 */

export interface TourEntretien {
  role: 'user' | 'assistant';
  content: string;
}

export interface EntretienComplet {
  messages: TourEntretien[];
  reponses: Reponse[];
  poses: string[];
  /** Les moments de bascule et leur traitement. À part des `reponses` parce que c'est une LISTE : il y a
   *  autant de moments que le client en cite, chacun avec sa propre action et son propre moyen. */
  bascules: Bascule[];
}

/** Un entretien vierge. C'est aussi ce qu'on rend d'un état illisible : on ne bloque jamais l'écran. */
export const ENTRETIEN_VIERGE: EntretienComplet = { messages: [], reponses: [], poses: [], bascules: [] };

const tourSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(MAX_CARACTERES_MESSAGE),
});

/** Plafond du nombre de moments de bascule. Chacun engendre DEUX questions : au-delà, l'entretien cesserait
 *  d'être un entretien. Un client qui en a davantage les regroupe, ou les ajoute ensuite à la main. */
export const MAX_BASCULES = 12;

const etatSchema = z.object({
  messages: z.array(tourSchema).max(MAX_TOURS_HISTORIQUE * 2).default([]),
  reponses: z.array(z.object({
    point: z.string().max(64),
    valeur: z.string().max(2000),
  })).max(64).default([]),
  poses: z.array(z.string().max(64)).max(64).default([]),
  bascules: z.array(z.object({
    moment: z.string().max(400),
    action: z.enum(ACTIONS).optional(),
    moyen: z.string().max(2000).optional(),
  })).max(MAX_BASCULES).default([]),
});


/** Relit un état stocké. Illisible -> entretien vierge, jamais une exception. */
export function lireEtat(brut: unknown): EntretienComplet {
  const parse = etatSchema.safeParse(brut ?? {});
  return parse.success ? parse.data : ENTRETIEN_VIERGE;
}

/**
 * Borne l'historique AVANT écriture.
 *
 * On garde les derniers tours, pas les premiers : c'est la fin de l'entretien qui porte le contexte utile, et
 * les réponses déjà obtenues sont de toute façon conservées à part, dans `reponses`. Un entretien long ne perd
 * donc rien de ce qui compte, seulement sa transcription ancienne.
 */
export function bornerMessages(messages: readonly TourEntretien[]): TourEntretien[] {
  return messages
    .slice(-MAX_TOURS_HISTORIQUE * 2)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CARACTERES_MESSAGE) }));
}

export interface EntretienStore {
  /** L'entretien en cours, ou `null` s'il n'y en a jamais eu. Scopé tenant. */
  lire(tenantId: string, agentId: string): Promise<EntretienComplet | null>;
  ecrire(tenantId: string, agentId: string, etat: EntretienComplet): Promise<void>;
  /** Repart de zéro. Le client doit pouvoir jeter un entretien qui a mal tourné sans supprimer son agent. */
  effacer(tenantId: string, agentId: string): Promise<void>;
}
