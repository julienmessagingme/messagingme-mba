// Recopié de wagroups, commit 526d3cc, `src/transport/connectionState.ts` (règle de Julien : un moteur partagé entre
// deux produits se recopie avec la référence de son commit, on n'en extrait un paquet commun qu'au troisième).
// Changé : la mise en forme du dépôt. Rien du comportement.
import { DisconnectReason } from '@whiskeysockets/baileys';

export type SessionStatus = 'pairing' | 'connected' | 'reconnecting' | 'dead' | 'banned';

export type Transition = {
  statut: SessionStatus;
  reconnecter: boolean;
  delaiMs: number;
  raison: string;
};

const DELAI_BASE_MS = 1000;
const DELAI_MAX_MS = 300_000;

export function delaiBackoff(tentative: number): number {
  // Garde de domaine locale a la fonction : un NaN ou un negatif ne doit jamais produire un delai nul ou
  // sub-seconde, sinon le backoff redevient une boucle chaude. Math.max(0, NaN) vaut NaN en JavaScript (pas 0),
  // donc le cas NaN est ecarte explicitement avant le clamp.
  const tentativeSure = Number.isFinite(tentative) ? Math.max(0, Math.floor(tentative)) : 0;
  return Math.min(DELAI_BASE_MS * 2 ** tentativeSure, DELAI_MAX_MS);
}

export function surOuverture(): Transition {
  return { statut: 'connected', reconnecter: false, delaiMs: 0, raison: 'connexion ouverte' };
}

/** Un statut terminal ne connait plus aucune reconnexion automatique : seul un humain en sort un compte. */
export function estStatutTerminal(statut: SessionStatus): boolean {
  return statut === 'banned' || statut === 'dead';
}

/**
 * Code HTTP porte par une erreur de deconnexion Baileys, lu par la FORME de l'objet et non par `instanceof Boom`.
 *
 * 🔴 Ce nombre est la SEULE chose qui distingue un compte banni (403) d'une coupure reseau ordinaire : s'il revient
 * undefined, la deconnexion passe pour banale et le compte banni serait relie en boucle, ce qui rendrait le
 * bannissement definitif. `instanceof Boom` lierait ce constat a l'identite d'un constructeur, donc a la resolution
 * npm (une seconde copie de @hapi/boom et l'instanceof devient faux EN SILENCE). La forme ne depend d'aucune copie.
 */
export function codeDeconnexion(err: unknown): number | undefined {
  const code = (err as { output?: { statusCode?: unknown } } | undefined)?.output?.statusCode;
  return typeof code === 'number' ? code : undefined;
}

/**
 * Decide ce qu'on fait d'une deconnexion. loggedOut (401) : la session a ete detruite depuis le telephone, un nouvel
 * appairage est un geste humain. forbidden (403) : le compte est banni, ne JAMAIS relier. Tout code inconnu est une
 * coupure reseau : on ne suppose jamais un ban a partir d'un code qu'on ne connait pas.
 * Ordre des gardes : deja banned ; 403 (domine dead) ; deja dead ; 401 ; 515 (reprise bornee) ; par defaut.
 */
export function surDeconnexion(statutActuel: SessionStatus, statusCode: number | undefined, tentative: number): Transition {
  if (statutActuel === 'banned') return { statut: 'banned', reconnecter: false, delaiMs: 0, raison: 'compte banni' };
  if (statusCode === DisconnectReason.forbidden) {
    return { statut: 'banned', reconnecter: false, delaiMs: 0, raison: 'compte banni (403)' };
  }
  if (statutActuel === 'dead') return { statut: 'dead', reconnecter: false, delaiMs: 0, raison: 'session detruite' };
  if (statusCode === DisconnectReason.loggedOut) {
    return { statut: 'dead', reconnecter: false, delaiMs: 0, raison: 'session detruite (401)' };
  }
  if (statusCode === DisconnectReason.restartRequired) {
    // Baileys emet toujours ce code juste apres un appairage reussi : delai nul la premiere fois, backoff ensuite.
    return { statut: 'reconnecting', reconnecter: true, delaiMs: tentative === 0 ? 0 : delaiBackoff(tentative), raison: 'redemarrage requis (515)' };
  }
  return { statut: 'reconnecting', reconnecter: true, delaiMs: delaiBackoff(tentative), raison: `deconnexion (code ${statusCode ?? 'absent'})` };
}
