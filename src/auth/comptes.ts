import type { OrigineEspace } from '../user/store.pg';

/** Un compte rattaché à une adresse, actif ou révoqué. */
export interface CompteParAdresse {
  id: string;
  tenantId: string;
  tenantName: string;
  role: string;
  disabled: boolean;
}

/** Ce que l'authentification lit et écrit des comptes. Chaque méthode absente rend sa route 503. */
export interface ComptesAuthDep {
  /** Inscription libre : crée un espace et son admin. `passwordHash` null = compte Google seul. */
  createTenantWithAdmin?(
    workspaceName: string,
    admin: { email: string; name: string | null; passwordHash: string | null },
    origine: OrigineEspace,
  ): Promise<{ tenantId: string; userId: string }>;
  /** Pose (écrase) le hash de mot de passe d'un compte (reset / changement). */
  setPassword?(userId: string, hash: string): Promise<boolean>;
  /** Hash de mot de passe courant d'un compte (vérification au changement). null si absent/sans mdp. */
  getPasswordHash?(userId: string): Promise<string | null>;
  /** Le mot de passe de l'identité d'une adresse : `undefined` = inconnue, `null` = sans mot de passe. */
  motDePasseDeLAdresse?(email: string): Promise<string | null | undefined>;
  /** Compte par id : sert à émettre une session après invitation ou à retrouver l'adresse de la session. */
  getSessionUser?(userId: string): Promise<{ tenantId: string; role: string; email: string } | null>;
  /** Tous les comptes d'une adresse, tout statut. Vide = adresse inconnue. */
  getByEmail?(email: string): Promise<CompteParAdresse[]>;
  /** Horodate la dernière connexion réussie (page Équipe). */
  touchLastLogin?(userId: string): Promise<void>;
}

/**
 * Marque une connexion réussie sans bloquer sa réponse. Une écriture de suivi ne doit pas transformer une
 * connexion valide en refus quand la base est momentanément saturée.
 */
export function marquerConnexion(comptes: Pick<ComptesAuthDep, 'touchLastLogin'> | undefined, userId: string): void {
  void comptes?.touchLastLogin?.(userId)?.catch(() => {});
}
