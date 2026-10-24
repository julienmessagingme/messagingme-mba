import { createHash } from 'node:crypto';
import type { PgNumerosFournisStore } from './store.pg';
import type { PgAbonnementsNumeroStore, StatutAbonnement } from '../stripe/abonnements.pg';
import type { ComptesApplication, StatutCompte } from '../application/comptes';
import type { PhoneNumberRecord } from '../account/types';

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
   * `paiementBloque` : Meta bloque le compte pour son moyen de paiement (migration 0231, relevé du balayage des statuts).
   * `coexistence` : relié en coexistence, le numéro restant dans l'application WhatsApp Business (migration 0253).
   */
  connecte: { chiffres: string; aActiver: boolean; paiementBloque?: boolean; coexistence?: true } | null;
  /** L'abonnement du numéro fourni (livraison B) : son statut et la fin de la période payée, `null` sans abonnement. */
  abonnement: { statut: StatutAbonnement; periodeFin: string | null } | null;
  /** Un Pro vivant couvre l'espace (lot 6, B2b) : le numéro fourni y est inclus, la page l'obtient sans payer. */
  inclusDansLePro: boolean;
  /**
   * Le compte de l'application WhatsApp Business de l'espace (filière application, 2026-10-22) ; absent sans compte, et
   * l'état est alors celui de la filière API. Relié, il vaut « connecté », sous son numéro.
   */
  application?: { statut: StatutCompte; numero: string };
}

export interface DepsEtatConnexion {
  numeros: Pick<PgNumerosFournisStore, 'numeroDeLEspace' | 'codeDeLEspace'>;
  /** Le numéro de Meta de l'espace (`numeroConnecteDe`). */
  numeroConnecte(tenantId: string): Promise<{ chiffres: string; aActiver: boolean; paiementBloque?: boolean; coexistence?: true } | null>;
  abonnements: Pick<PgAbonnementsNumeroStore, 'deLEspace'>;
  /** Le Pro de l'espace (lot 6, B2b, `PgAbonnementsOffreStore.vivant`). */
  pro: { vivant(tenantId: string): Promise<boolean> };
  /** Le compte de la filière application. Requis : sans lui, un compte relié ne serait jamais dit connecté. */
  application: { comptes: Pick<ComptesApplication, 'parEspace'> };
}

/**
 * Le numéro de Meta d'un espace tel que la page du lien, sa garde (qui meurt à la connexion) et Claude le lisent, depuis
 * sa ligne (`PgPhoneStatusStore.getPhoneNumber`) : ses chiffres, « à activer » (un statut lu et différent de
 * `CONNECTED`, la règle de l'Accueil), sa carte bloquée chez Meta (migration 0231) et la coexistence (migration 0253),
 * dite seulement quand elle est vraie. 🔴 Un numéro en coexistence n'est jamais « à activer » : rien ne doit pousser vers
 * un `/register`, que les gestes d'activation refusent d'ailleurs (`NUMERO_EN_COEXISTENCE`). `null` sans numéro.
 */
export function numeroConnecteDe(
  pn: Pick<PhoneNumberRecord, 'displayPhoneNumber' | 'status' | 'wabaPaiementBloque' | 'coexistence'> | null,
): { chiffres: string; aActiver: boolean; paiementBloque: boolean; coexistence?: true } | null {
  if (!pn) return null;
  return {
    chiffres: (pn.displayPhoneNumber ?? '').replace(/[^0-9]/g, ''),
    aActiver: pn.coexistence !== true && pn.status != null && pn.status !== 'CONNECTED',
    paiementBloque: pn.wabaPaiementBloque === true,
    ...(pn.coexistence === true ? { coexistence: true as const } : {}),
  };
}

export async function lireEtatConnexion(deps: DepsEtatConnexion, tenantId: string): Promise<EtatConnexion> {
  const [n, connecteMeta, a, pro, compte] = await Promise.all([
    deps.numeros.numeroDeLEspace(tenantId), deps.numeroConnecte(tenantId), deps.abonnements.deLEspace(tenantId),
    deps.pro.vivant(tenantId), deps.application.comptes.parEspace(tenantId),
  ]);
  const connecte = connecteMeta ?? (compte?.statut === 'relie' ? { chiffres: compte.numero, aActiver: false } : null);
  // Un numéro de Meta relié prime sur un vieux compte de l'application (`filiereDe`) : l'état est alors celui de l'API.
  const application = connecteMeta === null && compte ? { statut: compte.statut, numero: compte.numero } : null;
  // Le code ne se lit que pour un numéro attribué : `codeDeLEspace` le borne à l'attribution.
  const c = n ? await deps.numeros.codeDeLEspace(tenantId) : null;
  return {
    fourni: n ? `+${n.numero}` : null,
    code: c ? { code: c.code, recuLe: c.recuLe.toISOString() } : null,
    connecte,
    abonnement: a ? { statut: a.statut, periodeFin: a.periodeFin ? a.periodeFin.toISOString() : null } : null,
    inclusDansLePro: pro,
    ...(application ? { application } : {}),
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
    e.abonnement?.statut ?? null, e.application?.statut ?? null,
    // La coexistence (migration 0253), ajoutée seulement quand elle est vraie : l'empreinte de tout autre état ne bouge pas.
    ...(e.connecte?.coexistence === true ? ['coexistence'] : []),
  ]);
  return createHash('sha256').update(forme).digest('hex').slice(0, 16);
}
