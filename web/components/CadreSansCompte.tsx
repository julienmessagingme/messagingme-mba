'use client';

import { Logo } from '@/components/Logo';
import { LocaleToggle } from '@/components/LocaleToggle';
import { TitrePage } from '@/components/TitrePage';

/**
 * Le cadre des pages de la console ouvertes SANS session (audit de simplicité du 2026-10-25, lot D du plan
 * `docs/superpowers/plans/2026-10-26-audits-simplicite-structure.md`) : le choix de la langue en haut à droite, la
 * marque, le titre et son sous-titre, puis le contenu. Deux largeurs : `etroite` pour un formulaire d'accès (inscription,
 * mot de passe, invitation), centré dans la hauteur ; `formulaire` pour un guide pas à pas (HubSpot, Salesforce), qui
 * part du haut. ⚠️ À ne pas confondre avec `CadrePublic`, celui des documentations publiques (API, MCP).
 */
export function CadreSansCompte({
  titre,
  sousTitre,
  largeur = 'etroite',
  children,
}: {
  titre: React.ReactNode;
  sousTitre?: React.ReactNode;
  largeur?: 'etroite' | 'formulaire';
  children: React.ReactNode;
}) {
  const guide = largeur === 'formulaire';
  return (
    <main className={guide ? 'relative flex min-h-screen justify-center px-4 py-10' : 'relative flex min-h-screen items-center justify-center px-4 py-8'}>
      <div className="absolute right-4 top-4">
        <LocaleToggle />
      </div>
      <div className={guide ? 'w-full max-w-formulaire' : 'w-full max-w-sm'}>
        <div className="mb-8 text-center">
          <Logo className={guide ? 'mx-auto mb-4 h-9 w-auto' : 'mx-auto mb-4 h-10 w-auto'} />
          <TitrePage>{titre}</TitrePage>
          {sousTitre !== undefined && <p className="mt-1 text-sm text-ink-500">{sousTitre}</p>}
        </div>
        {children}
      </div>
    </main>
  );
}
