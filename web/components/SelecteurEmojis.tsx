'use client';

import { EMOJIS_MESSAGE } from '@/lib/emojis';
import { Flottant } from '@/components/Flottant';

/**
 * LE sélecteur d'emojis des composeurs de message.
 *
 * 🔴 POURQUOI IL EXISTE, alors que la LISTE était déjà partagée. `lib/emojis.ts` avait mis fin à la
 * divergence des listes ; la grille, elle, était recopiée dans `TemplateBodyField` et dans
 * `ChampCorpsVariables`, et les deux copies avaient DÉJÀ divergé sur un point que l'une documente contre
 * l'autre : le panneau se ferme après un choix chez l'une, reste ouvert chez l'autre. Le composeur de chaîne
 * en aurait été la troisième. C'est exactement le motif que `lib/emojis.ts` décrit dans son propre
 * en-tête : « deux listes que l'utilisateur voit dans deux écrans du même produit finissent par diverger
 * sans que personne ne le décide ».
 *
 * 🔴 LE PANNEAU SE FERME APRÈS UN CHOIX, et c'est le comportement de `ChampCorpsVariables`, retenu parce que
 * son commentaire dit pourquoi l'autre est fautif : le voile qui capte le clic extérieur avale le clic
 * suivant, et l'utilisateur croit que le bouton d'à côté ne répond pas.
 *
 * ⚠️ Pour en poser plusieurs à la suite, on rouvre : un clic de plus, contre un clic mort à chaque fois.
 */
export function SelecteurEmojis({ onPick, onClose, ancrage = 'bas', alignement = 'droite' }: {
  /** Reçoit l'emoji choisi. L'appelant décide où l'insérer : au curseur, jamais en fin de texte. */
  onPick: (emoji: string) => void;
  onClose: () => void;
  ancrage?: 'bas' | 'haut';
  /** `gauche` quand le bouton déclencheur n'est pas au bord droit de son conteneur (barre d'outils). */
  alignement?: 'droite' | 'gauche';
}) {
  return (
    // `hauteur="haute"` : la grille fait dix rangées, le plafond par défaut la coupait et obligeait à
    // défiler à chaque réouverture.
    <Flottant onClose={onClose} large ancrage={ancrage} alignement={alignement} hauteur="haute">
      <div className="grid grid-cols-8 gap-0.5" data-testid="selecteur-emojis">
        {EMOJIS_MESSAGE.map((e) => (
          <button
            type="button"
            key={e}
            onClick={() => { onPick(e); onClose(); }}
            className="rounded-controle p-1 text-lg leading-none hover:bg-ink-100"
            aria-label={e}
          >
            {e}
          </button>
        ))}
      </div>
    </Flottant>
  );
}
