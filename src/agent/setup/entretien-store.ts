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
  /**
   * QUI A ÉCRIT CHAQUE MESSAGE : l'IDENTIFIANT du membre, dans le même ordre que `messages`
   * (migration 0147). `null` pour les réponses de l'assistant, et pour les tours d'avant cette migration.
   *
   * 🔴 UN TABLEAU PARALLÈLE, PAS UNE CLÉ DANS `messages`, et ce n'est pas un détour : `tourSchema` est
   * strict, donc y ajouter une clé obligatoire ferait échouer la relecture de TOUS les entretiens existants,
   * qui retomberaient sur l'entretien vierge. Le client perdrait sa conversation, en silence.
   *
   * ⚠️ PLUS COURT QUE `messages` EST NORMAL : les tours d'avant le 2026-09-14 n'ont pas d'auteur connu, et
   * leur en inventer un serait pire que de n'en afficher aucun. `auteurDuTour` rend `null` pour ceux-là.
   *
   * ⚠️ UN IDENTIFIANT, PAS UN E-MAIL, contrairement à `audit_log.actor_email` qui le DÉNORMALISE. L'écart est
   * voulu : ce journal-là doit PROUVER qui a agi, même après la suppression du compte ; ici, un fil de
   * conversation dont l'auteur a quitté l'espace affiche « auteur inconnu », ce qui est suffisant et évite
   * de recopier une adresse dans un jsonb que personne ne purge.
   */
  auteurs: Array<string | null>;
}

/** Un entretien vierge. C'est aussi ce qu'on rend d'un état illisible : on ne bloque jamais l'écran. */
export const ENTRETIEN_VIERGE: EntretienComplet = { messages: [], reponses: [], poses: [], bascules: [], auteurs: [] };

const tourSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(MAX_CARACTERES_MESSAGE),
});

/** Plafond du nombre de moments de bascule. Chacun engendre DEUX questions : au-delà, l'entretien cesserait
 *  d'être un entretien. Un client qui en a davantage les regroupe, ou les ajoute ensuite à la main. */
export const MAX_BASCULES = 12;

/**
 * Plafond de ce que le FIL conserve. Sans rapport avec `MAX_TOURS_HISTORIQUE`, qui borne ce qu'on ENVOIE.
 *
 * ⚠️ Il existe pour qu'un jsonb ne grossisse pas sans fin, pas pour décider d'un contexte : à 4 000 tours,
 * une conversation d'assistant a largement de quoi couvrir des années, et la mémoire longue des décisions
 * vit de toute façon dans l'onglet Historique.
 */
export const MAX_TOURS_CONSERVES = 4000;

const etatSchema = z.object({
  /**
   * 🔴 PLAFONNÉ LARGE, PLUS À LA TAILLE DU CONTEXTE (2026-09-14). Il valait `MAX_TOURS_HISTORIQUE * 2`,
   * c'est-à-dire que la RELECTURE elle-même rejetait un fil plus long que ce qu'on envoie au modèle : un fil
   * conservé au-delà serait retombé sur l'entretien vierge, donc perdu. Le plafond qui reste est une garde
   * contre un jsonb qui grossirait sans fin, pas une politique de contexte.
   */
  messages: z.array(tourSchema).max(MAX_TOURS_CONSERVES).default([]),
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
  auteurs: z.array(z.string().max(320).nullable()).max(MAX_TOURS_CONSERVES).default([]),
});


/** Relit un état stocké. Illisible -> entretien vierge, jamais une exception. */
export function lireEtat(brut: unknown): EntretienComplet {
  const parse = etatSchema.safeParse(brut ?? {});
  return parse.success ? parse.data : ENTRETIEN_VIERGE;
}

/**
 * Borne l'historique ENVOYÉ AU MODÈLE. Ce qui est CONSERVÉ ne l'est pas.
 *
 * 🔴 ELLE ÉTAIT APPELÉE À L'ÉCRITURE JUSQU'AU 2026-09-14, ET ELLE DÉTRUISAIT. Sa documentation affirmait
 * qu'« un entretien long ne perd rien de ce qui compte, seulement sa transcription ancienne » : c'était vrai
 * pour un entretien de CONSTRUCTION, qui se termine. Ça cesse de l'être pour un fil qui PERDURE (décision de
 * Julien : « toute la conversation avec l'assistant doit perdurer »), où la transcription ancienne EST ce
 * qu'on vient relire des semaines plus tard.
 *
 * ⚠️ CONSERVER N'EST PAS ENVOYER, et l'écart est délibéré : le fil garde tout, le prompt reste borné. Un
 * historique sans fin dans le contexte finirait par pousser la fiche courante hors de la fenêtre du modèle,
 * donc par dégrader ce qu'on cherche à améliorer. La mémoire longue des DÉCISIONS vit dans l'onglet
 * Historique (migration 0146), qui est fait pour ça et se lit d'un coup d'œil.
 *
 * On garde les DERNIERS tours, pas les premiers : c'est la fin du fil qui porte le contexte utile.
 */
export function bornerPourModele(messages: readonly TourEntretien[]): TourEntretien[] {
  return messages
    .slice(-MAX_TOURS_HISTORIQUE * 2)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CARACTERES_MESSAGE) }));
}

/**
 * L'AUTEUR DU TOUR `i`, ou `null` quand on ne le sait pas.
 *
 * ⚠️ ELLE TOLÈRE UN TABLEAU PLUS COURT, et c'est le cas NORMAL : un fil commencé avant la migration 0147
 * porte des tours sans auteur. Rendre `undefined` ferait afficher « undefined » à l'écran ; rendre le
 * premier auteur venu attribuerait à quelqu'un des phrases qu'il n'a pas écrites.
 */
export function auteurDuTour(etat: Pick<EntretienComplet, 'auteurs'>, i: number): string | null {
  return etat.auteurs[i] ?? null;
}

export interface EntretienStore {
  /** L'entretien en cours, ou `null` s'il n'y en a jamais eu. Scopé tenant. */
  lire(tenantId: string, agentId: string): Promise<EntretienComplet | null>;
  ecrire(tenantId: string, agentId: string, etat: EntretienComplet): Promise<void>;
  /** Repart de zéro. Le client doit pouvoir jeter un entretien qui a mal tourné sans supprimer son agent. */
  effacer(tenantId: string, agentId: string): Promise<void>;
}
