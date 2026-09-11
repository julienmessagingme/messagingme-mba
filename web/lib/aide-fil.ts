import type { ReponseAide } from './api-aide';

/**
 * LE FIL DE LA CONVERSATION D'AIDE, gardé tant que la personne est connectée.
 *
 * 🔴 POURQUOI `sessionStorage` ET PAS L'ÉTAT DU COMPOSANT. Le bouton d'aide vit dans la coquille, qui est
 * REMONTÉE à chaque changement d'écran : un fil gardé en mémoire disparaîtrait dès que la personne suit le
 * lien que le bot vient de lui donner, c'est-à-dire exactement au moment où elle voudrait poser sa question
 * suivante. `sessionStorage` survit à la navigation et au rechargement, et meurt avec l'onglet.
 *
 * 🔴 ET PAS `localStorage` : le fil parle de ce que cette personne cherchait à faire. Le garder après une
 * déconnexion le laisserait à la disposition du suivant sur le même poste. Il est en plus EFFACÉ à la
 * déconnexion (`clearSession`), parce qu'un onglet resté ouvert survit à un changement de compte.
 *
 * ⚠️ CLÉ PAR ESPACE : observer un autre espace ne doit pas faire apparaître le fil du précédent.
 */
export interface EchangeAide {
  question: string;
  reponse: ReponseAide;
}

const PREFIXE = 'mba.aide.fil.';

/**
 * Combien d'échanges sont gardés.
 *
 * ⚠️ Le même chiffre que ce que le serveur accepte. Plus haut ici ne servirait qu'à afficher un historique
 * dont la moitié ne partirait jamais au modèle, donc à laisser croire qu'il s'en souvient.
 */
export const MAX_ECHANGES_GARDES = 4;

export function lireFil(tenantId: string): EchangeAide[] {
  try {
    const brut = sessionStorage.getItem(PREFIXE + tenantId);
    if (!brut) return [];
    const lu: unknown = JSON.parse(brut);
    // Une forme inattendue (version précédente, écriture concurrente) rend un fil VIDE plutôt que de jeter :
    // un historique illisible ne doit pas empêcher de poser une question.
    return Array.isArray(lu)
      ? lu.filter((e): e is EchangeAide => typeof e === 'object' && e !== null
        && typeof (e as { question?: unknown }).question === 'string'
        && typeof (e as { reponse?: unknown }).reponse === 'object')
      : [];
  } catch {
    return [];
  }
}

export function ecrireFil(tenantId: string, fil: EchangeAide[]): void {
  try {
    sessionStorage.setItem(PREFIXE + tenantId, JSON.stringify(fil.slice(-MAX_ECHANGES_GARDES)));
  } catch {
    // Stockage plein ou refusé (navigation privée) : le fil vit alors le temps de l'écran. On ne casse pas
    // l'aide pour ça.
  }
}

/**
 * Efface TOUS les fils de ce navigateur.
 *
 * Appelée à la déconnexion. Elle balaie toutes les clés du préfixe plutôt qu'une seule : un compte a pu
 * observer plusieurs espaces dans le même onglet, et n'en effacer qu'un laisserait les autres au suivant.
 */
export function effacerFils(): void {
  try {
    const aRetirer: string[] = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const cle = sessionStorage.key(i);
      if (cle && cle.startsWith(PREFIXE)) aRetirer.push(cle);
    }
    for (const cle of aRetirer) sessionStorage.removeItem(cle);
  } catch {
    /* rien à faire de plus */
  }
}
