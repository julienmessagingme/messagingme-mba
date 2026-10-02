import { normalizeText } from '../automation/match';
import type { PgWidgetStore, WidgetRow } from './store.pg';

/**
 * Par quel widget ce message est-il arrivé ? La PHRASE du widget, pré-remplie dans WhatsApp par la bulle, est la
 * seule trace que le visiteur laisse : un message qui la CONTIENT vient de ce widget.
 *
 * La comparaison est celle des mots-clés en mode `contains` (`matchesTrigger`, `src/automation/match.ts`) :
 * `normalizeText` des deux côtés (casse, accents, espaces), puis inclusion. Ce n'est pas un choix de confort : le
 * scénario d'un widget part par ce même `matchesTrigger`, et deux comparaisons différentes feraient reconnaître un
 * widget dont le scénario ne correspond pas.
 *
 * Coût : AUCUNE lecture pour un message sans texte, UNE pour les autres, `lister` (`tenant_id = $1`, que l'index
 * `widgets_phrase_key` sert par son préfixe). Un espace sans widget paie cette seule requête. Aucun cache : un
 * widget créé ou éteint prend effet au message suivant.
 */
export type WidgetDuMessage = (tenantId: string, texte: string | null) => Promise<WidgetRow | null>;

export function reconnaissanceDesWidgets(store: Pick<PgWidgetStore, 'lister'>): WidgetDuMessage {
  return async (tenantId, texte) => {
    const corps = normalizeText(texte ?? '');
    if (corps === '') return null;
    let retenu: WidgetRow | null = null;
    let longueur = 0;
    for (const w of await store.lister(tenantId)) {
      // Un widget éteint ne reconnaît rien : le client l'a éteint SANS retirer la balise, et l'éteindre veut dire
      // « plus rien de ce widget ».
      if (!w.actif) continue;
      const phrase = normalizeText(w.phrase);
      // 🔴 UNE PHRASE QUE LA NORMALISATION RÉDUIT À RIEN SERAIT CONTENUE DANS TOUS LES MESSAGES, et ferait appliquer
      // son devenir à chaque conversation de l'espace. Le CHECK `widgets_phrase_non_vide_chk` ne voit que le cas
      // flagrant (aucun caractère visible) : une phrase faite de seuls accents combinants le passe.
      if (phrase === '' || !corps.includes(phrase)) continue;
      // Deux phrases contenues (l'une contient l'autre, ce que la route du lot 4 refusera) : la plus longue est la
      // plus précise. À longueur égale, la première de `lister`, donc la plus récente : un ordre stable.
      // `retenu === null` plutôt qu'un départ à 0 : la garde de la phrase vide, plus haut, reste la SEULE à l'écarter,
      // et son test le vérifie. Un départ à 0 l'écartait aussi, par accident, et rendait ce test vert sans la garde.
      if (retenu === null || phrase.length > longueur) {
        retenu = w;
        longueur = phrase.length;
      }
    }
    return retenu;
  };
}
