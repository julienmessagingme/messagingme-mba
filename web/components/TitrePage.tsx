import type { ComponentPropsWithoutRef } from 'react';

/**
 * LE TITRE D'UNE PAGE DE LA CONSOLE : un seul `h1` par page, à la même taille partout. Il existait en quatre
 * tailles (`text-base` sur 17 pages, `text-lg`, `text-xl`, `text-2xl`), en `h1` ici et en `h2` là : rien ne
 * disait au lecteur, ni à un lecteur d'écran, où commençait la page.
 *
 * `className` n'accueille que la mise en page (marges, troncature) : la taille, la graisse et la couleur
 * sont celles de toutes les pages.
 */
export function TitrePage({ className = '', ...props }: ComponentPropsWithoutRef<'h1'>) {
  return <h1 {...props} className={`text-xl font-semibold tracking-tight text-ink-900${className ? ` ${className}` : ''}`} />;
}

/** La phrase sous le titre : une ligne utile, bornée à une largeur de lecture. */
export function IntroPage({ className = '', ...props }: ComponentPropsWithoutRef<'p'>) {
  return <p {...props} className={`mt-1 max-w-prose text-sm text-ink-500${className ? ` ${className}` : ''}`} />;
}
