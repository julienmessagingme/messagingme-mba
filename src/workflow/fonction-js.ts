import { getQuickJS } from 'quickjs-emscripten';

/**
 * EXÉCUTER DU JAVASCRIPT ÉCRIT PAR UN CLIENT, sur notre infrastructure.
 *
 * 🔴 `node:vm` N'EST PAS UN BAC À SABLE, et c'est la première chose à savoir ici : on s'en échappe en
 * remontant la chaîne des prototypes jusqu'au constructeur de fonction du contexte hôte, et la documentation
 * de Node le dit elle-même. Le code d'un client s'exécute donc dans **QuickJS compilé en WebAssembly** : un
 * autre moteur, dans un autre tas, sans aucune passerelle vers le nôtre.
 *
 * MESURÉ le 2026-09-11 avant d'écrire une ligne, pas supposé :
 *   - `require`, `process` et `fetch` valent `undefined` dans le bac à sable (il n'y a rien à atteindre) ;
 *   - une boucle infinie est COUPÉE par le gestionnaire d'interruption (201 ms mesurées pour un budget de
 *     200 ms), donc un client ne peut pas immobiliser le worker ;
 *   - le plafond de mémoire est posé sur le runtime, pas espéré.
 *
 * ⚠️ CE QUI RESTE VRAI MALGRÉ TOUT : le code d'un client consomme du CPU pendant sa durée d'exécution. Le
 * plafond de temps est donc la vraie protection, et il est court exprès.
 */

/** Plafond de temps d'une exécution. Court : un contact attend la suite de son parcours. */
export const DELAI_JS_MS = 200;

/** Plafond de mémoire du bac à sable. Au-delà, l'allocation échoue et l'exécution rend une erreur. */
export const MEMOIRE_JS_OCTETS = 8 * 1024 * 1024;

/** Plafond de taille du code, en caractères. Le graphe est stocké en JSONB : une fonction n'est pas un fichier. */
export const MAX_CODE_JS = 4000;

export interface ResultatJs {
  ok: boolean;
  /** La valeur produite, déjà mise en forme pour un champ de contact. Vide si `ok` est faux. */
  valeur: string;
  /** Lisible par le client, à afficher sous le bouton « Essayer ». Absente si tout va bien. */
  erreur?: string;
}

/**
 * La valeur rendue par la fonction, telle qu'elle se range dans un champ.
 *
 * ⚠️ MÊME RÈGLE QUE LE BLOC « APPEL API » (`valeurPourChamp`) : une valeur simple devient son texte, une
 * structure devient du JSON. Deux règles différentes pour deux blocs qui écrivent tous deux dans un champ
 * obligeraient le client à se souvenir de laquelle s'applique.
 */
function enTexte(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Exécute `code` avec `valeur` en entrée, et rend ce que la fonction retourne.
 *
 * Le code est le CORPS d'une fonction qui reçoit `valeur` : il doit faire `return`. C'est le contrat le plus
 * familier possible, et l'écran le montre en toutes lettres.
 *
 * ⚠️ ELLE NE LÈVE JAMAIS. Une faute de frappe du client, une exception de son code, un dépassement de temps :
 * tout ressort en `{ok: false, erreur}`. Un parcours de contact ne s'arrête pas parce qu'une transformation
 * a raté, et l'écran de mise au point a besoin du message, pas d'une pile.
 */
export async function executerFonctionJs(
  code: string,
  valeur: string,
  opts: { delaiMs?: number; memoireOctets?: number } = {},
): Promise<ResultatJs> {
  if (code.trim() === '') return { ok: false, valeur: '', erreur: 'aucun code' };
  if (code.length > MAX_CODE_JS) return { ok: false, valeur: '', erreur: `code trop long (${MAX_CODE_JS} caractères maximum)` };

  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  try {
    runtime.setMemoryLimit(opts.memoireOctets ?? MEMOIRE_JS_OCTETS);
    // 🔴 L'ÉCHÉANCE EST POSÉE AVANT LE CONTEXTE, et elle est absolue : le gestionnaire est rappelé pendant
    // l'exécution et coupe dès qu'elle est passée. C'est ce qui rend une boucle infinie inoffensive.
    const echeance = Date.now() + (opts.delaiMs ?? DELAI_JS_MS);
    runtime.setInterruptHandler(() => Date.now() > echeance);
    const ctx = runtime.newContext();
    try {
      // La valeur d'entrée voyage en JSON, donc sans aucune référence à un objet de NOTRE tas : c'est la
      // seule façon de passer une donnée sans ouvrir un pont entre les deux mondes.
      const entree = JSON.stringify(valeur);
      const res = ctx.evalCode(`(function(valeur){\n${code}\n})(${entree})`);
      if (res.error) {
        const details = ctx.dump(res.error) as unknown;
        res.error.dispose();
        const msg = details !== null && typeof details === 'object' && 'message' in details
          ? String((details as { message: unknown }).message)
          : String(details);
        // Le dépassement de temps ressort comme une erreur d'interruption : on le NOMME, sinon le client lit
        // un message interne qui ne lui dit pas quoi corriger.
        const clair = Date.now() > echeance ? `la fonction a dépassé ${opts.delaiMs ?? DELAI_JS_MS} ms` : msg;
        return { ok: false, valeur: '', erreur: clair };
      }
      const sortie = ctx.dump(res.value) as unknown;
      res.value.dispose();
      return { ok: true, valeur: enTexte(sortie) };
    } finally {
      ctx.dispose();
    }
  } catch (err) {
    return { ok: false, valeur: '', erreur: err instanceof Error ? err.message : 'exécution impossible' };
  } finally {
    runtime.dispose();
  }
}
