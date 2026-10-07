import type { StatutAbonnement } from './abonnements.pg';

/**
 * L'ÉTAT DE L'ABONNEMENT DU NUMÉRO FOURNI (lot 4, spec `docs/superpowers/specs/2026-10-06-numero-impaye-design.md`).
 *
 * Il se CALCULE à partir de dates gardées sur l'abonnement (migration 0215) ; aucun balayage n'écrit de statut.
 * « Suspendu » est donc vrai dès que la date passe, même si le worker tourne en retard : le balayage ne fait que les
 * gestes (alertes, e-mails, libération). Un seul calcul, ici, pour la garde d'envoi, l'état de la connexion, les outils
 * MCP, le bandeau et le balayage.
 */
export type EtatAbonnementNumero = 'actif' | 'fin_prevue' | 'en_retard' | 'suspendu' | 'libere';

/** Les envois sont coupés 7 jours après le PREMIER échec d'une série (décision de Julien du 2026-10-06). */
export const DELAI_COUPURE_IMPAYE_MS = 7 * 24 * 3_600_000;

/** Un numéro dont l'abonnement est fini est gardé 7 jours pour un réabonnement, puis libéré (même décision). */
export const DELAI_LIBERATION_MS = 7 * 24 * 3_600_000;

/** Ce que le calcul lit d'un abonnement. */
export interface LigneEtat {
  statut: StatutAbonnement;
  premierEchecLe: Date | null;
  finPrevueLe: Date | null;
  finiLe: Date | null;
  libereLe: Date | null;
}

/**
 * L'état à `maintenant`. `numeroAttribue` : l'espace a-t-il encore un numéro fourni attribué ? Un abonnement fini SANS
 * numéro (rendu par « Abandonner ») n'a rien à suspendre ; un impayé sans numéro reste dû, lui.
 *
 * `numeroApporte` (jaune 1 de la relecture de la livraison A) : l'espace envoie par un AUTRE numéro que le numéro
 * fourni, le sien. La garde ne coupe que le numéro fourni : « suspendu » serait alors faux partout où il s'affiche
 * (bandeau, rappel MCP, alerte), et ouvrirait un réabonnement inutile. Fini : « libéré » ; impayé : « en retard », dû
 * mais sans coupure.
 */
export function etatAbonnement(
  l: LigneEtat, o: { maintenant: Date; numeroAttribue: boolean; numeroApporte: boolean },
): EtatAbonnementNumero {
  if (l.libereLe !== null) return 'libere';
  // Fini : la fin compte, même sans date (une ligne `resilie` d'avant la reprise de 0215).
  if (l.finiLe !== null || l.statut === 'resilie') return o.numeroAttribue && !o.numeroApporte ? 'suspendu' : 'libere';
  if (l.premierEchecLe !== null) {
    const coupe = o.maintenant.getTime() - l.premierEchecLe.getTime() >= DELAI_COUPURE_IMPAYE_MS;
    return coupe && !o.numeroApporte ? 'suspendu' : 'en_retard';
  }
  // Un échec sans date (ligne d'avant le lot 4) : en retard, jamais suspendu sur une date inventée.
  if (l.statut === 'en_retard') return 'en_retard';
  return l.finPrevueLe !== null ? 'fin_prevue' : 'actif';
}

/** Le Pro de l'espace, tel que la couverture du numéro le lit (`abonnements_offre`, lot 6). */
export interface CouverturePro {
  /** Un abonnement Pro sans fin effective (en retard compris : Stripe relance jusqu'à la fin). */
  vivant: boolean;
  /** La fin effective du dernier Pro fini, `null` s'il n'y en a jamais eu. */
  dernierFini: Date | null;
}

/**
 * 🔴 LA COUVERTURE DU NUMÉRO PAR LE PRO (lot 6, livraison B1, vigilance 4) : un numéro fourni est couvert si son
 * abonnement est actif OU si le Pro de l'espace l'est. Appliquée à la ligne AVANT `etatAbonnement`, dans
 * `etatDeLEspace`, la seule lecture de l'état : sans elle, le balayage suspendrait puis libérerait le numéro d'un client
 * Pro dont l'abonnement du numéro seul est fini.
 *  - Pro vivant : la ligne se lit active, sans échec, sans fin prévue ni effective, donc ni coupure ni libération.
 *  - Pro fini APRÈS la fin du numéro : la fin effective est celle du Pro. Sinon un client qui a résilié le numéro seul
 *    pendant son Pro verrait son numéro libéré au balayage suivant la fin du Pro, sans les 7 jours de grâce.
 *  - Un numéro déjà libéré le reste.
 */
export function couvertureParLePro(l: LigneEtat, pro: CouverturePro): LigneEtat {
  if (l.libereLe !== null) return l;
  if (pro.vivant) return { ...l, statut: 'actif', premierEchecLe: null, finPrevueLe: null, finiLe: null };
  const fini = l.finiLe !== null || l.statut === 'resilie';
  if (fini && pro.dernierFini !== null && (l.finiLe === null || pro.dernierFini > l.finiLe)) return { ...l, finiLe: pro.dernierFini };
  return l;
}

/** La date de libération : 7 jours après la fin effective, `null` tant que l'abonnement n'est pas fini. */
export function liberationPrevue(l: Pick<LigneEtat, 'finiLe'>): Date | null {
  return l.finiLe === null ? null : new Date(l.finiLe.getTime() + DELAI_LIBERATION_MS);
}
