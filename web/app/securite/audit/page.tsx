'use client';

import { AppShell } from '@/components/AppShell';
import { AuditJournal } from '@/components/AuditJournal';

/**
 * LES AUDIT TRAILS, déménagés de Paramètres le 2026-09-13.
 *
 * ⚠️ LE COMPOSANT NE CHANGE PAS, SEULEMENT SA PLACE. Le recopier en ferait un second journal, qui se
 * contredirait avec le premier le jour où l'un filtre autrement que l'autre.
 */
export default function SecuriteAuditPage() {
  return <AppShell active="securite-audit">{(session) => (
    <div className="mx-auto w-full max-w-liste space-y-4">
      <AuditJournal tenantId={session.tenantId} />
    </div>
  )}</AppShell>;
}
