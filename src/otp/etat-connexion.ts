import { createHash } from 'node:crypto';
import type { PgNumerosFournisStore } from './store.pg';
import type { PgAbonnementsNumeroStore, StatutAbonnement } from '../stripe/abonnements.pg';

/**
 * OÙ EN EST LA CONNEXION DU NUMÉRO D'UN ESPACE (lot 3c, livraison A). Une seule lecture, pour la page `/brancher`
 * (`GET /tenants/:tenantId/connexion-numero`) et pour l'outil d'attente de Claude Code (`watch_whatsapp_connection`) :
 * l'écran et le terminal ne peuvent pas dire deux choses différentes.
 */
export interface EtatConnexion {
  /** Le numéro de la réserve attribué à l'espace, au format que le client tape dans la fenêtre de Meta (`+44...`). */
  fourni: string | null;
  /** Le dernier code capté pour ce numéro depuis son attribution, dans la fenêtre de `codeDeLEspace` (15 minutes). */
  code: { code: string; recuLe: string } | null;
  /**
   * Le numéro WhatsApp relié à l'espace, en chiffres (`''` si son affichage est inconnu). `aActiver` : relié, mais Meta
   * ne l'a pas encore activé (`status` lu et différent de `CONNECTED`, la règle de l'Accueil) ; il n'est pas « connecté ».
   */
  connecte: { chiffres: string; aActiver: boolean } | null;
  /** L'abonnement du numéro fourni (livraison B) : son statut et la fin de la période payée, `null` sans abonnement. */
  abonnement: { statut: StatutAbonnement; periodeFin: string | null } | null;
}

export interface DepsEtatConnexion {
  numeros: Pick<PgNumerosFournisStore, 'numeroDeLEspace' | 'codeDeLEspace'>;
  numeroConnecte(tenantId: string): Promise<{ chiffres: string; aActiver: boolean } | null>;
  abonnements: Pick<PgAbonnementsNumeroStore, 'deLEspace'>;
}

export async function lireEtatConnexion(deps: DepsEtatConnexion, tenantId: string): Promise<EtatConnexion> {
  const [n, connecte, a] = await Promise.all([
    deps.numeros.numeroDeLEspace(tenantId), deps.numeroConnecte(tenantId), deps.abonnements.deLEspace(tenantId),
  ]);
  // Le code ne se lit que pour un numéro attribué : `codeDeLEspace` le borne à l'attribution.
  const c = n ? await deps.numeros.codeDeLEspace(tenantId) : null;
  return {
    fourni: n ? `+${n.numero}` : null,
    code: c ? { code: c.code, recuLe: c.recuLe.toISOString() } : null,
    connecte,
    abonnement: a ? { statut: a.statut, periodeFin: a.periodeFin ? a.periodeFin.toISOString() : null } : null,
  };
}

/**
 * L'empreinte d'un état : elle change à chaque étape (numéro attribué, code reçu, un second code, numéro connecté), et
 * reste la même pour le même état. Claude la rend à l'appel suivant pour attendre le prochain changement. Opaque : elle
 * ne laisse pas lire le code.
 */
export function empreinteEtat(e: EtatConnexion): string {
  const forme = JSON.stringify([
    e.fourni, e.code?.recuLe ?? null, e.code?.code ?? null, e.connecte?.chiffres ?? null, e.connecte?.aActiver ?? null,
    e.abonnement?.statut ?? null,
  ]);
  return createHash('sha256').update(forme).digest('hex').slice(0, 16);
}
