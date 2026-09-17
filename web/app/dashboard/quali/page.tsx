'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AppShell } from '@/components/AppShell';
import { RangeBar } from '@/components/RangeBar';
import { ConversationAnalysisCard } from '@/components/ConversationAnalysisCard';
import type { Session } from '@/lib/session';
import type { StatsRange } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { presetRange } from '@/lib/range';

/**
 * ANALYSE DES CONVERSATIONS : ce que les conversations DISENT, la ou l'ecran quantitatif compte ce qui a
 * ete envoye.
 *
 * ⚠️ L'ECRAN S'APPELAIT « Qualitatif » JUSQU'AU 2026-09-17. Seul le libelle a change : l'adresse reste
 * `/dashboard/quali` et la cle de nav reste `dashboard-quali`, parce que trois specs Playwright et
 * d'eventuels signets y pointent, et que personne ne lit jamais une adresse.
 *
 * La page ne fait aucun appel elle-meme : `ConversationAnalysisCard` porte deja ses deux chargements (le
 * resume et la table des conversations analysees). Elle se resume donc a la periode plus la carte.
 */
export default function AnalyseConversationsPage() {
  return <AppShell active="dashboard-quali">{(session) => (
    /**
     * ⚠️ `Suspense` PARCE QUE `useSearchParams` L'EXIGE dans l'App Router : sans lui, la page entiere
     * bascule en rendu client au build et Next le signale. Le repli est l'ecran sans filtre, donc
     * exactement ce qu'on avait avant l'adresse filtree. Meme montage que `/dashboard/funnel`.
     */
    <Suspense fallback={null}>
      <AnalyseInner session={session} />
    </Suspense>
  )}</AppShell>;
}

function AnalyseInner({ session }: { session: Session }) {
  const t = useT();
  const params = useSearchParams();

  /**
   * LA PERIODE VIENT DE L'ADRESSE QUAND ELLE Y EST (2026-09-17).
   *
   * 🔴 ELLE VOYAGE AVEC L'INTENTION, ET SEPARER LES DEUX FERAIT MENTIR L'ECRAN. On arrive ici en cliquant
   * une barre de la synthese, qui affiche un compte sur SA fenetre. Retomber sur les 30 jours par defaut
   * rendrait un nombre de lignes different de celui qu'on vient de cliquer, et le chiffre de la synthese
   * passerait pour faux alors que les deux ecrans regarderaient simplement deux periodes.
   *
   * ⚠️ Un couple de dates absent ou mal forme retombe sur le defaut plutot que de casser : l'adresse peut
   * etre recopiee a la main, et un ecran vide serait une punition pour une faute de frappe.
   */
  const [range, setRange] = useState<StatsRange>(() => {
    const from = params.get('from');
    const to = params.get('to');
    const bonneForme = (v: string | null): v is string => v !== null && /^\d{4}-\d{2}-\d{2}$/.test(v);
    return bonneForme(from) && bonneForme(to) ? { from, to } : presetRange(30);
  });

  return (
    <div className="space-y-4">
      {/* ⚠️ « Analyse des conversations » depuis le 2026-09-17, comme l'entree de menu. Le titre a l'ecran
          et le libelle de la nav doivent dire le MEME mot : deux noms pour une page, c'est une page qu'on
          cherche deux fois. L'adresse, elle, reste `/dashboard/quali`. */}
      <RangeBar title={t('Analyse des conversations', 'Conversation analysis')} range={range} onChange={setRange} />
      <ConversationAnalysisCard
        tenantId={session.tenantId}
        range={range}
        intentionInitiale={params.get('intention') ?? undefined}
      />
    </div>
  );
}
