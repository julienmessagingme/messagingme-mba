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
/**
 * LA SOURCE « MAINTENANT », ET C'EST CELLE QUI EXISTE DÉJÀ.
 *
 * 🔴 PAS DE DOUBLON : `now` EST LA CLÉ DU DÉPÔT, relevée par Julien le 2026-09-14 (« je crois qu'on avait
 * dev un champ système qui donne l'heure et la date actuelle, pas de doublon hein ! »). Elle vit dans
 * `ParamSource` (`src/crm/template.ts`, `{ type: 'now' }`) et dans le sélecteur de variables du front
 * (`web/lib/variables-template.ts`, `sel === 'now'`). En créer une seconde sous un autre nom aurait été le
 * pire cas : deux notions pour la même chose, avec deux orthographes.
 *
 * ⚠️ LA MISE EN FORME, ELLE, DIFFÈRE, ET C'EST VOULU. `formatNow` rend « 12/04/2026 », un affichage
 * français destiné à un message ; `new Date('12/04/2026')` ne le relit pas. Le bloc JS reçoit donc l'ISO
 * UTC, la seule forme qu'un script relit sans ambiguïté. Mettre en forme est justement le travail que ce
 * bloc existe pour faire.
 *
 * ⚠️ UN CHAMP PERSONNALISÉ NOMMÉ « now » SERAIT MASQUÉ par celui-ci. Le cas est théorique (aucun espace
 * n'en a, vérifié) et l'écran range la source système dans un groupe à part, mais la précédence est ici :
 * le système gagne.
 */
export const CHAMP_MAINTENANT = 'now';

/**
 * Un nom de paramètre JavaScript sûr, ou `null`.
 *
 * 🔴 IL SE VÉRIFIE, IL NE SE SUPPOSE PAS. Le nom vient d'une CLÉ DE CHAMP que le client a créée lui-même :
 * « mail pro », « date-naissance », « prénom » ou « class » sont des clés parfaitement valides côté contact
 * et des paramètres illégaux côté JavaScript. Injecter l'un d'eux produirait une erreur de syntaxe sur un
 * code que le client a pourtant bien écrit, ce qui est le pire message possible.
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
    // 🔴 L'ÉCHÉANCE EST POSÉE AVANT LE CONTEXTE, et elle est absolue : le gestionnaire est rappelé pendant
    // l'exécution et coupe dès qu'elle est passée. C'est ce qui rend une boucle infinie inoffensive.
    const echeance = Date.now() + (opts.delaiMs ?? DELAI_JS_MS);
    runtime.setInterruptHandler(() => Date.now() > echeance);
    const ctx = runtime.newContext();
    try {
      // La valeur d'entrée voyage en JSON, donc sans aucune référence à un objet de NOTRE tas : c'est la
      // seule façon de passer une donnée sans ouvrir un pont entre les deux mondes.
      const entree = JSON.stringify(valeur);
      /**
       * 🔴 LA VALEUR ARRIVE SOUS DEUX NOMS, ET `valeur` RESTE TOUJOURS VALIDE. Julien, le 2026-09-14,
       * après avoir écrit `function (valeur) {return new Date(adresse).getFullYear();}` : « j’ai
       * l’impression que ce n’est pas dynamique ; il faut que ta function soit plutôt comme ça
       * function (adresse) ». Il a raison sur l’intention, et l’écran montre désormais le nom du champ.
       *
       * ⚠️ MAIS `valeur` NE PEUT PAS DISPARAÎTRE : des blocs écrits avant aujourd’hui l’emploient et
       * tournent en production. Renommer le paramètre les casserait TOUS, en silence, sur un chemin qu’on
       * n’emprunte qu’au passage d’un contact. Les deux noms désignent la même donnée.
       */
      const alias = nomDeParametreSur(opts.nomParametre);
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
