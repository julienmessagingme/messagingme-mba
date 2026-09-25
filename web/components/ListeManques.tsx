'use client';

import { useT } from '@/lib/i18n';

/**
 * « Voilà ce qui manque » : la raison pour laquelle un bouton de validation reste grisé, À L'ÉCRAN.
 *
 * 🔴 POURQUOI CE COMPOSANT EXISTE. Le 2026-09-07, Julien a saisi `htpps://` au lieu de `https://` dans
 * l'adresse d'un bouton de template et n'a eu qu'un bouton inerte. La raison EXISTAIT dans le code, mais
 * elle vivait dans un attribut `title` : une infobulle qu'il faut survoler à la souris, et qui n'existe pas
 * au doigt. Trois formulaires du produit avaient le même cul-de-sac (template, carrousel, formulaire de
 * collecte), et `FlowBuilder` en avait déjà écrit le remède pour lui seul.
 *
 * 🔴 IL NE DÉBLOQUE RIEN. Le bouton reste grisé tant que la liste n'est pas vide : c'est la RAISON qui
 * devient visible, jamais la garde qui s'affaiblit. Un formulaire qui se laisse valider incomplet fait
 * refuser la création par Meta avec un message qui désigne un chemin de tableau JSON, illisible.
 *
 * ⚠️ Ne rien rendre quand la liste est vide OU quand l'envoi est en cours : pendant l'envoi le bouton est
 * grisé pour une raison évidente, et l'annoncer ferait douter.
 */
export function ListeManques({ manques, testId, busy = false }: {
  /** Ce qui bloque, déjà rédigé et déjà traduit par l'appelant (lui seul sait nommer ses champs). */
  manques: string[];
  /** Le `data-testid` du bloc. Il diffère par écran, les specs existantes s'y accrochent. */
  testId: string;
  busy?: boolean;
}) {
  const t = useT();
  if (manques.length === 0 || busy) return null;
  return (
    <p className="mt-3 rounded-lg bg-alerte-50 px-3 py-2 text-sm text-ink-900" data-testid={testId}>
      {t('Il manque : ', 'Missing: ')}
      {manques.join(t(', ', ', '))}.
    </p>
  );
}
