import { Fragment, createElement, type ReactNode } from 'react';
import { segmentsMisEnForme, type StyleTexte } from '@/lib/chaine-mise-en-forme';

/**
 * Le texte d'un post de chaîne, RENDU : `*promo*` s'affiche en gras, pas avec ses étoiles.
 *
 * 🔴 UN SEUL RENDU POUR TOUT L'ÉCRAN « CHAÎNE ». L'aperçu rendait le balisage pendant que la liste des
 * publications, juste en dessous, montrait les mêmes textes avec leurs marqueurs bruts : deux moitiés du
 * même écran qui ne montraient pas la même chose du même post. Un composant partagé rend la divergence
 * impossible plutôt que rattrapable.
 *
 * Le découpage vit dans un module PUR et testé (`lib/chaine-mise-en-forme.ts`) : ce texte part dans un post
 * irrattrapable, donc ce qui le transforme se teste avant. Ici il ne reste que les balises.
 */
const BALISE: Record<StyleTexte, 'strong' | 'em' | 's'> = { gras: 'strong', italique: 'em', barre: 's' };

export function TexteMisEnForme({ texte }: { texte: string }) {
  return (
    <>
      {segmentsMisEnForme(texte).map((seg, i) => (
        // `styles` va du plus EXTÉRIEUR au plus intérieur, donc on emboîte depuis la fin : le style le plus
        // proche du texte est posé en premier, et le premier du tableau finit à l'extérieur.
        <Fragment key={i}>
          {seg.styles.reduceRight<ReactNode>(
            (noeud, style) => createElement(BALISE[style], null, noeud),
            seg.contenu,
          )}
        </Fragment>
      ))}
    </>
  );
}
