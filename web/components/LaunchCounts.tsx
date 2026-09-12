'use client';

import { useT } from '@/lib/i18n';
import type { RecipientCounts } from '@/lib/api';

/**
 * Compteurs sent/failed/pending/skipped d'une campagne.
 *
 * ⚠️ IL VIVAIT DANS `CampaignCreateForm.tsx`, ET C'EST POUR ÇA QU'IL A DÛ DÉMÉNAGER. Ce fichier a été
 * supprimé avec le retrait de l'ancien formulaire (2026-09-12) ; la liste des campagnes, elle, importe
 * toujours ce composant. Un export utile enfoui dans un module qu'on retire est exactement ce qu'une
 * recherche sur le nom du COMPOSANT PRINCIPAL ne montre pas : le grep de contrôle rendait zéro résultat
 * pour `CampaignCreateForm` alors que `LaunchCounts` avait encore un lecteur.
 *
 * `className` absorbe le seul écart entre ses deux appelants historiques (marge et nuance de gris).
 */
export function LaunchCounts({ counts, className = 'mt-2 text-xs text-ink-600' }: { counts: RecipientCounts; className?: string }) {
  const t = useT();
  return (
    <p className={className}>
      <b className="text-emerald-700">{counts.sent}</b> {t('envoyés', 'sent')}
      {counts.failed > 0 && <> · <b className="text-red-700">{counts.failed}</b> {t('échecs', 'failures')}</>}
      {counts.pending > 0 && <> · {counts.pending} {t('en attente', 'pending')}</>}
      {counts.skipped > 0 && <> · {counts.skipped} {t('ignorés', 'skipped')}</>}
    </p>
  );
}
