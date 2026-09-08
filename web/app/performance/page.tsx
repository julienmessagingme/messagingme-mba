'use client';

import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { RangeBar } from '@/components/RangeBar';
import { CoutParCampagneCard } from '@/components/CoutParCampagneCard';
import { NuageQualitatifCard } from '@/components/NuageQualitatifCard';
import type { Session } from '@/lib/session';
import type { StatsRange } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { presetRange } from '@/lib/range';

/**
 * La page de synthèse du Performance Lab.
 *
 * Elle répond à DEUX questions, et c'est tout ce qu'elle fait : où en sont les conversations (urgence et
 * satisfaction, lot F), et ce que coûte un engagement (lot E). Le détail Analytics reste dans les
 * sous-onglets : cette page n'en est pas un résumé, elle porte ce que les autres écrans ne montrent nulle
 * part.
 *
 * ⚠️ ADRESSE NEUVE, `/performance`, et c'est la SEULE de toute la refonte des menus. Le lot A avait
 * explicitement refusé de la créer tant qu'elle n'aurait rien à montrer : une page d'aiguillage vide aurait
 * ajouté un clic à tout le monde. Elle arrive avec son premier contenu, pas avant.
 */
export default function PerformanceSynthesePage() {
  return <AppShell active="perf-synthese">{(session) => <SyntheseInner session={session} />}</AppShell>;
}

function SyntheseInner({ session }: { session: Session }) {
  const t = useT();
  // Même période par défaut que les écrans Analytics : passer de l'un à l'autre ne doit pas changer la
  // fenêtre sous les pieds de l'utilisateur.
  const [range, setRange] = useState<StatsRange>(() => presetRange(30));

  return (
    <div className="space-y-4">
      <RangeBar title={t('Synthèse', 'Summary')} range={range} onChange={setRange} />
      {/* Le coût d'abord : c'est la question qu'on se pose en arrivant (« combien ça me coûte »), et elle
          se lit sur toute la période dès le premier jour. Le nuage, lui, se remplit avec le temps. */}
      <CoutParCampagneCard tenantId={session.tenantId} range={range} />
      <NuageQualitatifCard tenantId={session.tenantId} range={range} />
    </div>
  );
}
