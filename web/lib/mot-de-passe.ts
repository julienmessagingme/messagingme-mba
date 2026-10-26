/**
 * La longueur minimale d'un mot de passe, côté navigateur.
 *
 * 🔴 CE MODULE EXISTE PARCE QUE LA VALEUR ÉTAIT ÉCRITE QUATRE FOIS, ET HUIT FOIS EN COMPTANT LES TEXTES.
 * Le 2026-09-10, le serveur est passé de 8 à 12 et les quatre écrans qui posent un mot de passe (création
 * de compte, invitation, réinitialisation, changement) annonçaient toujours « 8 caractères minimum », avec
 * un `minLength={8}` qui laissait le navigateur accepter avant que le serveur ne refuse. Le défaut n'est
 * pas la duplication en soi, c'est qu'elle est INVISIBLE : rien ne relie ces quatre écrans à la constante
 * du serveur, et le compilateur ne voit pas un nombre écrit dans un attribut.
 *
 * La valeur vit dans `web/lib/partage/mot-de-passe.ts`, que le serveur lit aussi : le jour où le minimum bougera encore,
 * les écrans suivront sans copie à tenir.
 */
import { MIN_MOT_DE_PASSE } from './partage/mot-de-passe';

/**
 * Le texte d'aide du champ, dans les deux langues.
 *
 * ⚠️ Il ne dit AUCUNE règle de composition, parce qu'il n'y en a pas : ni majuscule, ni chiffre, ni
 * symbole. En annoncer une seule ferait chercher `Password1!` là où la longueur seule invite à une phrase.
 */
export function aideMotDePasse(): { fr: string; en: string } {
  return {
    fr: `${MIN_MOT_DE_PASSE} caractères minimum`,
    en: `At least ${MIN_MOT_DE_PASSE} characters`,
  };
}
