'use client';

import { AppShell } from '@/components/AppShell';
import { BibliothequeOutils } from '@/components/BibliothequeOutils';

export default function OutilsPage() {
  return (
    <AppShell active="outils-espace">
      {(session) => <BibliothequeOutils tenantId={session.tenantId} isAdmin={session.role === 'admin'} />}
    </AppShell>
  );
}
