'use client';

import { useLocale, useT } from '@/lib/i18n';
import { pageCommentFaire } from '@/lib/comment-faire';
import { Icone } from '@/components/Icone';

/**
 * « Comment faire » : la page du centre d'aide public de l'écran courant, dans un nouvel onglet (plan du centre d'aide,
 * tâche 10). Posé UNE fois dans la barre du haut (`AppShell`), comme le bouton d'aide ; rien sur un écran sans page.
 * Sous 1024 px, l'icône seule : la barre y porte déjà les onglets et le menu de compte (relecture du lot 4). Son icône n'est
 * pas le point d'interrogation du bouton d'aide, qui lui est voisin sur l'Inbox ; son nom dit le nouvel onglet.
 */
export function LienCommentFaire({ ecran }: { ecran: string }) {
  const { locale } = useLocale();
  const t = useT();
  const adresse = pageCommentFaire(ecran, locale);
  if (adresse === null) return null;
  const nom = t('Comment faire', 'How-to guide');
  const nomComplet = t('Comment faire (nouvel onglet)', 'How-to guide (opens in a new tab)');
  return (
    <a
      href={adresse}
      target="_blank"
      rel="noopener"
      aria-label={nomComplet}
      title={nomComplet}
      className="flex h-9 shrink-0 items-center gap-1.5 rounded-controle px-2 text-sm font-medium text-ink-500 transition-colors duration-150 hover:bg-ink-100 hover:text-ink-900"
    >
      <Icone nom="connaissance" taille="nav" />
      <span className="hidden lg:inline">{nom}</span>
    </a>
  );
}
