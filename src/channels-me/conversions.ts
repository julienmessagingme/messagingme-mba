import { normalizeText } from '../automation/match';

/**
 * Combien de conversations un bouton de chaine a REELLEMENT demarrees.
 *
 * 🔴 « COMBIEN DE CLICS » N'EXISTE PAS, ET NE PEUT PAS EXISTER. Julien a demande le nombre de clics sur le
 * bouton d'une publication. Un appui sur un lien `wa.me` ouvre WhatsApp sur le telephone de l'abonne : ce
 * geste ne traverse jamais nos serveurs, aucun de nos systemes ne le voit, et le fournisseur ne le rapporte
 * pas non plus. Afficher un « nombre de clics » obligerait a inventer un chiffre. Ce qu'on VOIT, c'est le
 * message qui arrive ensuite, et c'est ce qu'on compte : des conversations demarrees.
 *
 * 🔴 ET C'EST PAR BOUTON, PAS PAR PUBLICATION. Le texte pre-rempli est la PHRASE du lien, identique pour
 * toutes les publications qui partagent ce lien : deux posts sur le meme bouton envoient exactement le meme
 * message, et rien dans ce qui nous parvient ne dit lequel des deux a ete vu. Le chiffre est donc « depuis
 * ce bouton, toutes publications confondues ». L'ecran doit le dire, faute de quoi un client attribuera a un
 * post les conversations d'un autre.
 *
 * 🔴 LA COMPARAISON EST CELLE QUI DECLENCHE VRAIMENT. On applique `normalizeText`, exactement la fonction
 * dont le moteur d'automations se sert pour decider si un message correspond, et en mode `contains` comme
 * elle. Compter en SQL aurait oblige a la reecrire (`lower()` n'enleve pas les accents, `unaccent` n'est ni
 * installe ni immuable sur cette base) : on aurait alors eu deux definitions de « la meme phrase », un
 * compteur qui affiche un nombre different de ce qui s'est passe, et personne pour s'en apercevoir.
 */

/**
 * Ce qu'un bouton a produit.
 *
 * ⚠️ LE NOM DIT « conversations », LE CHAMP DIT « contacts », ET C'EST LE CHAMP QUI EST EXACT. Le module
 * garde ce nom parce que c'est la question posee par l'ecran (« qu'a produit ce bouton ? »), mais ce qu'on
 * mesure est plus etroit : des personnes qui ont ENVOYE le message. Le mot « conversation demarree » a ete
 * retire de l'interface le 2026-09-07 pour cette raison exacte.
 */
export interface ConversationsDunLien {
  linkId: string;
  /**
   * Contacts DISTINCTS ayant envoye le message du bouton. Des contacts, pas des messages : un abonne qui
   * appuie trois fois est une personne, pas trois.
   */
  contacts: number;
}

/**
 * ⚠️ IL N'Y A PAS DE CHAMP « dernier ». Une premiere version en portait un (la date du message le plus
 * recent), calcule, requete, transporte et type des deux cotes du reseau, et lu par personne. Un champ mort
 * qui traverse toute la pile coute a chaque relecture et finit par etre cru utile. Il se rajoutera le jour
 * ou un ecran l'affichera.
 */

/** Un message entrant, reduit a ce que le comptage regarde. */
export interface MessageEntrant {
  waId: string;
  body: string;
}

/**
 * Compte, par lien, les contacts distincts dont un message contient la phrase.
 *
 * ⚠️ UN MEME MESSAGE PEUT COMPTER POUR PLUSIEURS LIENS, et ce n'est pas un defaut a corriger ici : c'est le
 * comportement du moteur, qui declenche toutes les automations dont le mot-cle correspond. La garde de
 * creation d'un lien refuse deja toute phrase incluse dans une autre ou incluant une autre, dans les deux
 * sens, donc ce cas ne peut naitre que de liens crees avant cette garde.
 */
export function compterParLien(
  liens: ReadonlyArray<{ id: string; phrase: string }>,
  messages: ReadonlyArray<MessageEntrant>,
): ConversationsDunLien[] {
  // Normalise UNE fois par message, pas une fois par couple message x lien.
  const corpus = messages.map((m) => ({ waId: m.waId, normalise: normalizeText(m.body) }));
  return liens.map((l) => {
    const cible = normalizeText(l.phrase);
    const contacts = new Set<string>();
    // Une phrase vide ne compte RIEN. Sans cette garde, `includes('')` est vrai partout et le bouton
    // afficherait l'integralite du trafic entrant du client comme etant le sien.
    if (cible !== '') {
      for (const m of corpus) if (m.normalise.includes(cible)) contacts.add(m.waId);
    }
    return { linkId: l.id, contacts: contacts.size };
  });
}
