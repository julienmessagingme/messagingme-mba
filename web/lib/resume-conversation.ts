/**
 * LE RESUME D'UNE CONVERSATION, ET CE QU'ON AFFICHE QUAND IL N'Y EN A PAS.
 *
 * 🔴 CE MODULE EXISTE PARCE QUE L'ABSENCE DE RESUME A QUATRE CAUSES, ET QU'ELLES NE SE DISENT PAS PAREIL.
 * Un ecran qui les confondrait en un vide unique ferait passer pour une panne trois situations parfaitement
 * normales, et pour une normalite la seule qui merite une explication :
 *
 *  - `aucune-conversation` : la personne n'a jamais rien echange. Le champ ne s'affiche meme pas, c'est la
 *    demande de Julien mot pour mot (« un champ de base A PARTIR DU MOMENT OU il y a une conversation »).
 *  - `pas-analysee` : la conversation existe, l'analyse n'est pas passee (ou a echoue). C'est temporaire,
 *    l'ecran le dit au present.
 *  - `sans-resume` : la conversation A ete analysee, mais avant la migration 0100, qui a cree la colonne.
 *    Ces analyses n'auront JAMAIS de resume (le reconstruire voudrait dire rappeler le modele sur chaque
 *    conversation deja analysee, donc payer une seconde fois pour du confort). C'est definitif, et la phrase
 *    le dit au passe.
 *  - `resume` : il y en a un.
 *
 * 🔴 ET LA PHRASE DU CAS `sans-resume` VIT ICI PARCE QU'ELLE EXISTAIT DEJA AILLEURS. La fiche d'analyse
 * (`ConversationAnalysisCard`) la portait en dur ; la fiche du mini-CRM en aurait fait une seconde copie, et
 * deux endroits qui affirment la meme chose finissent par ne plus l'affirmer pareil. Une seule ecriture,
 * deux lecteurs.
 *
 * Module PUR : aucun appel, aucun etat, aucune dependance React.
 */

/** Ce qu'il y a a montrer, et pourquoi. L'ordre est celui de la decision, du plus vide au plus rempli. */
export type EtatResume = 'aucune-conversation' | 'pas-analysee' | 'sans-resume' | 'resume';

/** La forme que le serveur rend (`ResumeContact`, src/crm/contact-history.pg.ts), reduite a ce qui decide. */
export interface SourceResume {
  texte: string | null;
  conversations: number;
  analysee: boolean;
}

/**
 * L'etat a afficher.
 *
 * ⚠️ `conversations` D'ABORD, ET L'ORDRE DES TROIS TESTS EST LE SUJET. Commencer par `texte` rendrait
 * `pas-analysee` sur un contact qui n'a jamais ouvert la moindre conversation : on lui promettrait une
 * analyse qui ne viendra pas, faute d'avoir quoi que ce soit a analyser.
 *
 * ⚠️ Une chaine VIDE vaut absence, comme partout ailleurs sur ce champ (a l'ecriture dans
 * `src/analysis/store.pg.ts`, et a la lecture dans `listConversations`) : le modele peut rendre le champ
 * vide plutot que de l'omettre, et la laisser passer afficherait un resume blanc.
 */
export function etatResume(r: SourceResume | null): EtatResume {
  // 🔴 `!(x > 0)` ET NON `x <= 0`, ET LA DIFFERENCE N'EST PAS COSMETIQUE. Une reponse TRONQUEE (une instance
  // en retard, un proxy qui rend un objet vide) laisse `conversations` a `undefined` : `undefined <= 0` vaut
  // `false`, donc la premiere forme tombait dans la branche suivante et affichait « pas encore analysee » a
  // un contact dont on ne sait rien. La seconde refuse tout ce qui n'est pas un nombre strictement positif.
  if (!r || !(r.conversations > 0)) return 'aucune-conversation';
  if (!r.analysee) return 'pas-analysee';
  return typeof r.texte === 'string' && r.texte.trim() !== '' ? 'resume' : 'sans-resume';
}

/**
 * La phrase qui remplace le resume quand il n'y en a pas. `null` pour `resume` (il y a un texte a montrer)
 * et pour `aucune-conversation` (il n'y a rien a montrer, pas meme une explication : le champ est absent).
 *
 * 🔴 CELLE DE `sans-resume` EST REPRISE MOT POUR MOT de la fiche d'analyse, y compris son apostrophe
 * typographique. La changer ici la change aux deux endroits, et c'est exactement ce qu'on veut.
 */
export function phraseResumeAbsent(e: EtatResume, t: (fr: string, en?: string) => string): string | null {
  switch (e) {
    case 'aucune-conversation':
    case 'resume':
      return null;
    case 'pas-analysee':
      return t(
        'Cette conversation n’est pas encore analysée.',
        'This conversation has not been analyzed yet.',
      );
    case 'sans-resume':
      return t(
        'Pas de résumé : cette conversation a été analysée avant que le résumé n’existe.',
        'No summary: this conversation was analyzed before summaries existed.',
      );
  }
}
