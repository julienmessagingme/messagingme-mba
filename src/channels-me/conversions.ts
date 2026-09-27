import { normalizeText } from '../automation/match';

/**
 * Combien de contacts un bouton de chaîne a réellement fait écrire.
 *
 * Un « nombre de clics » n'existe pas : un appui sur un lien `wa.me` ouvre WhatsApp sur le téléphone de
 * l'abonné sans traverser nos serveurs, et le fournisseur ne le rapporte pas. Ce qu'on voit, c'est le
 * message qui arrive ensuite, et c'est ce qu'on compte.
 *
 * Par bouton, pas par publication : le texte pré-rempli est la phrase du lien, identique pour toutes les
 * publications qui le partagent. L'écran doit le dire.
 *
 * La comparaison est celle qui déclenche : `normalizeText` en mode `contains`, comme le moteur
 * d'automations. En SQL il aurait fallu la réécrire (`lower()` n'enlève pas les accents, `unaccent` n'est pas
 * installé), donc deux définitions de « la même phrase ».
 */

/**
 * Ce qu'un bouton a produit. Le nom dit « conversations », le champ dit « contacts », et c'est le champ qui
 * est exact : on mesure des personnes qui ont envoyé le message.
 */
export interface ConversationsDunLien {
  linkId: string;
  /** Contacts distincts ayant envoyé le message du bouton : un abonné qui appuie trois fois compte pour un. */
  contacts: number;
}

/** Un message entrant, reduit a ce que le comptage regarde. */
export interface MessageEntrant {
  waId: string;
  body: string;
}

/**
 * Compte, par lien, les contacts distincts dont un message contient la phrase. Un même message peut compter
 * pour plusieurs liens, comme le moteur déclenche toutes les automations dont le mot-clé correspond ; la
 * création d'un lien refuse déjà une phrase incluse dans une autre.
 */
export function compterParLien(
  liens: ReadonlyArray<{ id: string; phrase: string }>,
  messages: ReadonlyArray<MessageEntrant>,
): ConversationsDunLien[] {
  // Normalisé une fois par message, pas une fois par couple message x lien.
  const corpus = messages.map((m) => ({ waId: m.waId, normalise: normalizeText(m.body) }));
  return liens.map((l) => {
    const cible = normalizeText(l.phrase);
    const contacts = new Set<string>();
    // Une phrase vide ne compte rien : `includes('')` est vrai partout, et le bouton s'attribuerait tout le
    // trafic entrant.
    if (cible !== '') {
      for (const m of corpus) if (m.normalise.includes(cible)) contacts.add(m.waId);
    }
    return { linkId: l.id, contacts: contacts.size };
  });
}
