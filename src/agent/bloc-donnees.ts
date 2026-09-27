/**
 * Le bloc délimité, et la neutralisation qui le rend étanche.
 *
 * 🔴 Une entrée non fiable entre dans un prompt par un bloc délimité, et le bloc ne protège que si son
 * délimiteur ne peut pas être recréé par le contenu. Un seul passage de remplacement ne suffit pas quand le
 * remplacement est un préfixe du délimiteur :
 *
 *     'FIN_RESULTAT_OUTILFIN_RESULTAT_OUTIL>>>'
 *      -> split sur 'FIN_RESULTAT_OUTIL>>>' puis join('>>>') -> 'FIN_RESULTAT_OUTIL>>>'   (reformé)
 *
 * On boucle donc jusqu'au point fixe, qui termine parce que le remplacement est strictement plus court
 * (`assertPlusCourt`).
 */

/** Le remplacement doit être strictement plus court que ce qu'il remplace, sinon la boucle ne termine pas. */
function assertPlusCourt(delimiteur: string, remplacement: string): void {
  if (remplacement.length >= delimiteur.length) {
    throw new Error(`délimiteur « ${delimiteur} » : le remplacement doit être strictement plus court`);
  }
}

/** Retire toute occurrence de `delimiteur`, y compris celles que le retrait précédent aurait reformées. */
function retirer(texte: string, delimiteur: string, remplacement: string): string {
  assertPlusCourt(delimiteur, remplacement);
  let sortie = texte;
  while (sortie.includes(delimiteur)) sortie = sortie.split(delimiteur).join(remplacement);
  return sortie;
}

/**
 * Neutralise les deux délimiteurs d'un bloc dans un contenu non fiable.
 *
 * À utiliser aussi quand on ne construit pas de bloc tout de suite : la conversation de construction
 * neutralise chaque message de l'historique un par un avant de les renvoyer au modèle.
 */
export function neutraliserDelimiteurs(texte: string, debut: string, fin: string): string {
  return retirer(retirer(texte, debut, '<<<'), fin, '>>>');
}

/** Encadre un contenu non fiable. Le seul chemin qui garantit que la neutralisation n'a pas été oubliée. */
export function blocDelimite(debut: string, fin: string, contenu: string): string {
  return `${debut}\n${neutraliserDelimiteurs(contenu, debut, fin)}\n${fin}`;
}
