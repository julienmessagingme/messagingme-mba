'use client';

import { AppShell } from '@/components/AppShell';
import { ErreursLivraison } from '@/components/ErreursLivraison';

/**
 * LE JOURNAL DES ERREURS DE LIVRAISON, déménagé de Paramètres le 2026-09-13.
 *
 * ⚠️ IL PORTE LES NUMÉROS DE TÉLÉPHONE, DÉLIBÉRÉMENT (« quel message n'est pas arrivé » sans dire « à
 * qui » ne répond à rien), et il est admin-only côté serveur. Le déplacer dans un centre de conformité ne
 * l'ouvre PAS plus largement : la garde est sur la route, pas sur le menu.
 */
export default function SecuriteErreursPage() {
  return <AppShell active="securite-erreurs">{(session) => (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-6">
      <ErreursLivraison tenantId={session.tenantId} />
    </div>
  )}</AppShell>;
}
