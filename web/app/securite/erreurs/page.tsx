'use client';

import { AppShell } from '@/components/AppShell';
import { ErreursLivraison, ErreursSysteme } from '@/components/ErreursLivraison';

/**
 * LE JOURNAL DES ERREURS, ET IL EN A DEUX MOITIÉS (tranché par Julien le 2026-09-13 : « on a déjà un log
 * d'erreurs [...] donc il faut les 2 »).
 *
 * 🔴 DEUX MOITIÉS DE NATURE DIFFÉRENTE, DISTINGUÉES ET NON MÉLANGÉES.
 *  - CLIENT : ce que META a répondu quand un message vers un CONTACT n'est pas parti ou pas arrivé. Quelqu'un
 *    attend au bout d'un téléphone.
 *  - SYSTÈME : ce que LES SYSTÈMES DU CLIENT (CRM, ERP, back-office) ont répondu aux appels que nous leur
 *    passons. Personne n'attend, et la correction est chez lui.
 * Les fondre obligerait chaque ligne à porter les colonnes vides de l'autre, et ferait chercher un numéro de
 * téléphone là où il n'y en a jamais eu.
 *
 * ⚠️ LA MOITIÉ CLIENT PORTE LES NUMÉROS, DÉLIBÉRÉMENT (« quel message n'est pas arrivé » sans dire « à
 * qui » ne répond à rien), et les deux sont admin-only côté serveur. Le déplacer dans un centre de
 * conformité ne l'ouvre PAS plus largement : la garde est sur la route, pas sur le menu.
 */
export default function SecuriteErreursPage() {
  return <AppShell active="securite-erreurs">{(session) => (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-6">
      <ErreursLivraison tenantId={session.tenantId} />
      <ErreursSysteme tenantId={session.tenantId} />
    </div>
  )}</AppShell>;
}
