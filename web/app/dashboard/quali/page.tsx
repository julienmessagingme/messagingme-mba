'use client';

import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { RangeBar } from '@/components/RangeBar';
import { ConversationAnalysisCard } from '@/components/ConversationAnalysisCard';
import type { Session } from '@/lib/session';
import type { StatsRange } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { presetRange } from '@/lib/range';

/**
 * Analytics qualitatif : ce que les conversations DISENT, la ou l'ecran quantitatif compte ce qui a ete envoye.
 *
 * La page ne fait aucun appel elle-meme : `ConversationAnalysisCard` porte deja ses deux chargements (le resume
 * et la table des conversations analysees) et ne dependait d'aucun etat du tableau de bord. Le deplacer ici
 * n'a donc rien casse, et cette page se resume a la periode plus la carte.
 *
 * Elle garde son propre compteur de sentiments et d'intentions : c'est du quantitatif D'ANALYSE, qui commente
 * les memes conversations que la table juste en dessous. Le sortir d'ici le priverait de son contexte.
 */
export default function AnalyticsQualiPage() {
  return <AppShell active="dashboard-quali">{(session) => <QualiInner session={session} />}</AppShell>;
}

function QualiInner({ session }: { session: Session }) {
  const t = useT();
  // Meme periode par defaut que l'ecran quantitatif : passer de l'un a l'autre ne doit pas changer la fenetre
  // sous les pieds de l'utilisateur.
  const [range, setRange] = useState<StatsRange>(() => presetRange(30));

  return (
    <div className="space-y-4">
      <RangeBar title={t('Analytics qualitatif', 'Qualitative analytics')} range={range} onChange={setRange} />
      <ConversationAnalysisCard tenantId={session.tenantId} range={range} />
    </div>
  );
}
