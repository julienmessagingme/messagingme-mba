'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { RangeBar } from '@/components/RangeBar';
import { ErrorBreakdownCard } from '@/components/analytics/cartes';
import type { Session } from '@/lib/session';
import { getErrorBreakdown, type ErrorBreakdownRow, type StatsRange } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { presetRange } from '@/lib/range';

/**
 * Analytics > Quantitatif > **Erreurs** : ce que Meta a refusé, et sur quel template.
 *
 * ⚠️ Le décompte ne couvre que les CAMPAGNES, et c'est MESURÉ, pas supposé (2026-09-07) : `error_code`
 * n'existe que sur `campaign_recipients` (migration 0020), `conversation_messages` n'a aucune colonne
 * d'erreur, et le chemin d'envoi d'un scénario ne journalise que le succès. Le seul journal d'échec hors
 * campagne, `workflow_advance_failures`, enregistre une panne d'AVANCE, pas un refus de livraison. La carte
 * le dit elle-même, plutôt que de laisser conclure « aucune erreur » d'un écran vide.
 */
export default function ErreursPage() {
  return <AppShell active="quanti-erreurs">{(session) => <ErreursInner session={session} />}</AppShell>;
}

function ErreursInner({ session }: { session: Session }) {
  const t = useT();
  const [range, setRange] = useState<StatsRange>(() => presetRange(30));
  const [errors, setErrors] = useState<ErrorBreakdownRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const eb = await getErrorBreakdown(session.tenantId, range);
      setErrors(Array.isArray(eb?.errors) ? eb.errors : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Chargement impossible', 'Unable to load'));
    } finally {
      setLoading(false);
    }
  }, [session.tenantId, range, t]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4">
      <RangeBar title={t('Erreurs de livraison', 'Delivery errors')} range={range} onChange={setRange} />
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {loading ? (
        <p className="text-sm text-ink-500">{t('Chargement des statistiques...', 'Loading statistics...')}</p>
      ) : (
        <ErrorBreakdownCard errors={errors} tenantId={session.tenantId} range={range} />
      )}
    </div>
  );
}
