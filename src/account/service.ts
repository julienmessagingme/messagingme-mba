/**
 * Composition du statut de compte (pastille de l'Accueil), pure.
 * Jamais de faux vert : le vert exige des signaux positifs réels (numéro connecté et qualité verte confirmée par
 * Meta), tout inconnu tombe en gris. Ambre = fonctionne mais à surveiller, rouge = problème franc.
 */
export type AccountDot = 'green' | 'amber' | 'red' | 'grey';
export type QualityRating = 'GREEN' | 'YELLOW' | 'RED' | 'UNKNOWN';

export interface AccountSignals {
  /** true = le GET Graph a réussi (Meta joignable, token valide). */
  reachable: boolean;
  /** true = échec d'authentification Meta (token invalide ou expiré) : rouge franc, pas gris. */
  authError?: boolean;
  /** `status` Graph du numéro (CONNECTED, PENDING, RESTRICTED...). undefined = inconnu. */
  numberStatus?: string | undefined;
  quality: QualityRating;
}

export interface AccountStatus {
  dot: AccountDot;
  /** Libellé court affiché à côté de la pastille. */
  label: string;
  /** Phrase explicative (tooltip / sous-texte). */
  reason: string;
}

const CONNECTED = 'CONNECTED';
/** États Graph explicitement bloquants : rouge. */
const BAD_STATUSES = new Set(['RESTRICTED', 'BANNED', 'DISABLED', 'FLAGGED', 'RATE_LIMITED']);

/** Normalise une qualité brute (Graph, base) vers l'union fermée ; inconnu : 'UNKNOWN'. */
export function normalizeQuality(raw: string | null | undefined): QualityRating {
  const up = (raw ?? '').toUpperCase();
  return up === 'GREEN' || up === 'YELLOW' || up === 'RED' ? up : 'UNKNOWN';
}

export function computeAccountStatus(s: AccountSignals): AccountStatus {
  // 1. Token invalide : signal négatif franc, rouge.
  if (s.authError) return { dot: 'red', label: 'Connexion Meta impossible', reason: "Le jeton d'accès Meta est invalide ou expiré." };
  // 2. Appel Graph échoué sans erreur d'auth : on ne sait pas, gris.
  if (!s.reachable) return { dot: 'grey', label: 'Statut indisponible', reason: 'Impossible de joindre Meta pour vérifier le numéro en ce moment.' };
  // 3. Numéro dans un état Meta explicitement bloquant -> rouge.
  const st = s.numberStatus;
  if (st && BAD_STATUSES.has(st.toUpperCase())) return { dot: 'red', label: 'Numéro bloqué', reason: `Meta signale le numéro en état « ${st} ».` };
  // 4. Qualité rouge -> rouge (risque imminent de restriction).
  if (s.quality === 'RED') return { dot: 'red', label: 'Qualité dégradée', reason: 'La qualité du numéro est au rouge : risque de restriction Meta.' };
  // 5. Numéro pas encore connecté : pas une panne, mais pas opérationnel.
  if (!st || st.toUpperCase() !== CONNECTED) {
    return { dot: 'grey', label: 'Numéro non connecté', reason: st ? `Le numéro est en état « ${st} », pas encore connecté.` : 'Statut du numéro inconnu.' };
  }
  // 6. Connecté + qualité jaune -> ambre (fonctionne, à surveiller).
  if (s.quality === 'YELLOW') return { dot: 'amber', label: 'Compte à surveiller', reason: 'Numéro connecté, qualité moyenne (jaune).' };
  // 7. Qualité verte confirmée : vert. Qualité inconnue : gris, jamais un faux vert.
  if (s.quality === 'GREEN') return { dot: 'green', label: 'Compte opérationnel', reason: 'Numéro connecté, qualité verte.' };
  return { dot: 'grey', label: 'Compte connecté', reason: 'Numéro connecté, qualité pas encore évaluée par Meta.' };
}
