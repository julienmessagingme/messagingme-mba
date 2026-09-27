import { getQuickJS } from 'quickjs-emscripten';

/**
 * Exécuter du JavaScript écrit par un client, sur notre infrastructure.
 *
 * 🔴 `node:vm` n'est pas un bac à sable (on s'en échappe par la chaîne des prototypes, la doc de Node le dit).
 * Le code d'un client s'exécute donc dans QuickJS compilé en WebAssembly : un autre moteur, dans un autre tas,
 * sans passerelle vers le nôtre. `require`, `process` et `fetch` y valent `undefined`, une boucle infinie est
 * coupée par le gestionnaire d'interruption, et le plafond de mémoire est posé sur le runtime.
 *
 * Le code consomme quand même du CPU pendant son exécution : le plafond de temps est la vraie protection, et
 * il est court exprès.
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
 * La valeur rendue par la fonction, telle qu'elle se range dans un champ. Même règle que le bloc « Appel API »
 * (`valeurPourChamp`) : une valeur simple devient son texte, une structure du JSON.
 */
function enTexte(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Exécute `code` avec `valeur` en entrée, et rend ce que la fonction retourne. Le code est le corps d'une
 * fonction qui reçoit `valeur` : il doit faire `return`.
 *
 * Ne lève jamais : faute de frappe, exception, dépassement de temps ressortent en `{ok: false, erreur}`. Un
 * parcours ne s'arrête pas parce qu'une transformation a raté, et l'écran de mise au point veut le message.
 */
/**
 * La source « maintenant ». `now` est la clé déjà utilisée ailleurs (`ParamSource` dans `src/crm/template.ts`,
 * le sélecteur de variables `web/lib/variables-template.ts`) : pas de seconde notion sous un autre nom.
 *
 * La mise en forme diffère exprès : `formatNow` rend « 12/04/2026 » pour un message, que `new Date` ne relit
 * pas ; le bloc JS reçoit l'ISO UTC, la seule forme qu'un script relit sans ambiguïté.
 *
 * Un champ personnalisé nommé « now » serait masqué par celui-ci : le système gagne.
 */
export const CHAMP_MAINTENANT = 'now';

/**
 * Un nom de paramètre JavaScript sûr, ou `null`. Le nom vient d'une clé de champ créée par le client
 * (« mail pro », « date-naissance », « class ») : l'injecter tel quel produirait une erreur de syntaxe sur un
 * code pourtant correct.
 */
export function nomDeParametreSur(cle: string | undefined): string | null {
  if (!cle || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(cle)) return null;
  // Les mots réservés, plus `valeur` qui est déjà pris : un doublon de paramètre est une erreur de syntaxe.
  const RESERVES = new Set(['valeur', 'arguments', 'await', 'break', 'case', 'catch', 'class', 'const',
    'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'eval', 'export', 'extends', 'false',
    'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let',
    'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'static', 'super', 'switch',
    'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield']);
  return RESERVES.has(cle) ? null : cle;
}

export async function executerFonctionJs(
  code: string,
  valeur: string,
  opts: { delaiMs?: number; memoireOctets?: number; nomParametre?: string } = {},
): Promise<ResultatJs> {
  if (code.trim() === '') return { ok: false, valeur: '', erreur: 'aucun code' };
  if (code.length > MAX_CODE_JS) return { ok: false, valeur: '', erreur: `code trop long (${MAX_CODE_JS} caractères maximum)` };

  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  try {
    runtime.setMemoryLimit(opts.memoireOctets ?? MEMOIRE_JS_OCTETS);
    // Le gestionnaire d'interruption est posé avant tout code (il rend une boucle infinie inoffensive), mais le
    // budget ne démarre qu'au lancement du code du client : sinon, sur un worker saturé, la création du contexte
    // mange les 200 ms et un code correct échoue avec un message qui l'accuse. `POSITIVE_INFINITY` d'ici là :
    // aucune interruption ne peut partir avant que le budget ne soit armé.
    let echeance = Number.POSITIVE_INFINITY;
    runtime.setInterruptHandler(() => Date.now() > echeance);
    const ctx = runtime.newContext();
    try {
      // La valeur d'entrée voyage en JSON, sans référence à un objet de notre tas : aucun pont entre les deux
      // mondes.
      const entree = JSON.stringify(valeur);
      /**
       * La valeur arrive sous deux noms : le nom du champ (ce que l'écran montre) et `valeur`, que des blocs
       * existants emploient et qu'on ne peut donc pas retirer sans les casser en silence.
       */
      const alias = nomDeParametreSur(opts.nomParametre);
      // Le budget du client commence ici et couvre la compilation de son code comme son exécution (`evalCode`
      // fait les deux).
      echeance = Date.now() + (opts.delaiMs ?? DELAI_JS_MS);
      const res = ctx.evalCode(alias
        ? `(function(valeur, ${alias}){
${code}
})(${entree}, ${entree})`
        : `(function(valeur){
${code}
})(${entree})`);
      if (res.error) {
        const details = ctx.dump(res.error) as unknown;
        res.error.dispose();
        const msg = details !== null && typeof details === 'object' && 'message' in details
          ? String((details as { message: unknown }).message)
          : String(details);
        // Le dépassement de temps ressort comme une erreur d'interruption : on le nomme, sinon le client lit un
        // message interne qui ne lui dit pas quoi corriger.
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
