/**
 * LES COMPTES DE LA FILIÈRE « APPLICATION WHATSAPP BUSINESS » (spec `docs/superpowers/specs/2026-10-22-filiere-
 * application-whatsapp-design.md`, migration 0247). Un espace sans compte Meta Business relie le compte de
 * l'application WhatsApp Business de son téléphone comme un appareil lié ; le service de connexions tient la session.
 *
 * 🔴 Les statuts sont ceux du CHECK de la migration, et `tests/application-comptes.test.ts` compare les deux listes.
 */

export const STATUTS_COMPTE = ['en_attente', 'relie', 'sommeil', 'banni', 'deconnecte', 'retire'] as const;
export type StatutCompte = (typeof STATUTS_COMPTE)[number];

export interface CompteApplication {
  id: string;
  tenantId: string;
  /** Chiffres seuls, indicatif compris. */
  numero: string;
  /** L'identité WhatsApp du compte relié, connue une fois le QR code scanné. */
  jid: string | null;
  statut: StatutCompte;
  /** Le numéro de la réserve, pour un numéro fourni. */
  fourniId: string | null;
  relieLe: Date | null;
  dernierMessageLe: Date | null;
  statutChangeLe: Date;
}

export type Filiere = 'api' | 'application';

/** Pourquoi un compte ne peut pas être préparé. */
export type RefusPreparation =
  | 'numero_pris' // relié dans un autre espace
  | 'deja_relie' // cet espace a déjà un compte relié
  | 'filiere_api' // cet espace a déjà un numéro sur l'API
  | 'numero_invalide';

export interface ComptesApplication {
  /**
   * Prépare le compte de l'espace pour un nouvel appairage (statut `en_attente`, session effacée). Remplace un compte
   * qui ne tient plus son numéro (banni, retiré, déconnecté, en sommeil) ; refuse si l'espace est déjà relié.
   */
  preparer(tenantId: string, entree: { numero: string; fourniId: string | null }): Promise<{ ok: true; compte: CompteApplication } | { ok: false; raison: RefusPreparation }>;
  parEspace(tenantId: string): Promise<CompteApplication | null>;
  parId(id: string): Promise<CompteApplication | null>;
  /** Les comptes dont la session reprend au démarrage du service. */
  relies(): Promise<CompteApplication[]>;
  /** Change le statut ; `jid` se pose à la liaison. */
  marquer(id: string, statut: StatutCompte, extra?: { jid?: string }): Promise<void>;
  /** Un message reçu ou envoyé : la mise en sommeil compte à partir de là. */
  toucher(id: string, quand: Date): Promise<void>;
  /** La filière de l'espace : un compte de l'application non retiré, sinon un numéro de l'API, sinon aucune. */
  filiereDe(tenantId: string): Promise<Filiere | null>;
}

/** Banni ou retiré, le numéro se libère pour un autre espace (index unique partiel de la migration). */
export function tientLeNumero(statut: StatutCompte): boolean {
  return statut !== 'banni' && statut !== 'retire';
}

/**
 * 🔴 Seul un compte relié rouvre sa session au démarrage. Un banni ne se relie JAMAIS tout seul (un bannissement n'est
 * réversible qu'une fois, un relien automatique le rend définitif) ; un déconnecté a été retiré depuis le téléphone.
 */
export function reprendAuDemarrage(statut: StatutCompte): boolean {
  return statut === 'relie';
}

/** Les chiffres du numéro, indicatif compris (8 à 15), ou `null`. */
export function numeroNormalise(brut: string): string | null {
  const chiffres = brut.replace(/\D/g, '');
  return /^[0-9]{8,15}$/.test(chiffres) ? chiffres : null;
}
