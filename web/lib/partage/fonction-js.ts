/**
 * Le bloc « Fonction JS » d'un scénario : ce que le moteur injecte dans la fonction du client, et ce que l'écran lui
 * annonce. L'écran qui promettrait un autre nom de paramètre que celui que le moteur injecte ferait écrire `valeur` à
 * quelqu'un qui aurait pu écrire `now`, ou l'inverse.
 */

/**
 * La source « maintenant ». `now` est la clé déjà utilisée ailleurs (`ParamSource` dans `src/crm/template.ts`, le
 * sélecteur de variables `web/lib/variables-template.ts`) : pas de seconde notion sous un autre nom. Le bloc JS reçoit
 * l'ISO UTC, la seule forme qu'un script relit sans ambiguïté. Un champ personnalisé nommé « now » serait masqué par
 * celui-ci : le système gagne.
 */
export const CHAMP_MAINTENANT = 'now';

/**
 * Un nom de paramètre JavaScript sûr, ou `null`. Le nom vient d'une clé de champ créée par le client (« mail pro »,
 * « date-naissance », « class ») : l'injecter tel quel produirait une erreur de syntaxe sur un code pourtant correct.
 * ⚠️ `now` n'est PAS une exception : le moteur l'injecte comme n'importe quelle clé sûre.
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
