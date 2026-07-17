'use client';

import { useCallback, useEffect, useState } from 'react';
import { useT } from '@/lib/i18n';
import { listHubspotLists, importHubspotList, type ImportReport, type HubspotList } from '@/lib/api';

/**
 * Source de campagne « HubSpot » : liste les listes du portail (via le connecteur), en sélectionne une, importe
 * ses contacts (opt-in JAMAIS activé côté serveur, tag « HubSpot: <nom> »). `onImported` reçoit `{report, tags}`
 * comme CsvImport : l'appelant campagne pivote alors la source vers la liste de contacts filtrée par ce tag.
 * Gère les états : chargement, re-consentement requis (scope pas accordé), liste vide.
 */
export function HubspotListImport({ tenantId, onImported, onBusyChange }: {
  tenantId: string;
  onImported: (result: { report: ImportReport; tags: string[] }) => void;
  onBusyChange?: (busy: boolean) => void;
}): React.JSX.Element {
  const t = useT();
  const [lists, setLists] = useState<HubspotList[] | null>(null);
  const [reconsentUrl, setReconsentUrl] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<(ImportReport & { truncated: boolean; skippedNoPhone: number }) | null>(null);

  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setReconsentUrl(null);
    try {
      const res = await listHubspotLists(tenantId);
      if (!res.available) { setLists([]); return; } // toggle OFF (ne devrait pas arriver ici, défensif)
      if (res.reason === 'reconsent_required') { setReconsentUrl(res.reconsentUrl ?? null); setLists([]); return; }
      setLists(res.lists ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Chargement des listes impossible', 'Failed to load lists'));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => { void load(); }, [load]);

  async function submit() {
    const list = lists?.find((l) => l.listId === selected);
    if (!list) return;
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const r = await importHubspotList(tenantId, list.listId, list.name);
      setReport(r);
      // tags = ceux réellement posés par le serveur (pas reconstruits ici) -> le filtre retrouve à coup sûr les contacts.
      onImported({ report: r, tags: r.tags });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Import impossible', 'Import failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-ink-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold tracking-tight text-ink-900">{t('Importer une liste HubSpot', 'Import a HubSpot list')}</h2>
        {!loading && <button onClick={() => void load()} className="text-xs text-brand-600 hover:underline">{t('Rafraîchir', 'Refresh')}</button>}
      </div>
      <p className="mt-1 text-xs text-ink-500">{t("Les contacts de la liste choisie sont importés dans ton mini-CRM (import ponctuel), taggés, puis ciblables comme destinataires. L'opt-in n'est jamais présumé.", 'The chosen list contacts are imported into your mini-CRM (one-off), tagged, then targetable as recipients. Opt-in is never assumed.')}</p>

      {loading ? (
        <p className="mt-4 text-sm text-ink-500">{t('Chargement des listes…', 'Loading lists…')}</p>
      ) : reconsentUrl ? (
        <div className="mt-4 rounded-lg bg-amber-50 px-3 py-3 text-sm text-amber-800">
          <p>{t("L'accès aux listes HubSpot n'est pas encore autorisé pour ce portail.", 'Access to HubSpot lists is not yet authorized for this portal.')}</p>
          <a href={reconsentUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600">
            {t("Autoriser l'accès →", 'Authorize access →')}
          </a>
        </div>
      ) : (lists?.length ?? 0) === 0 ? (
        <p className="mt-4 text-sm text-ink-500">{t('Aucune liste HubSpot trouvée sur ce portail.', 'No HubSpot list found on this portal.')}</p>
      ) : (
        <>
          <div className="mt-4 space-y-1.5">
            {lists!.map((l) => (
              <label key={l.listId} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-2.5 text-sm ${selected === l.listId ? 'border-brand-500 bg-brand-50' : 'border-ink-200 hover:bg-ink-50'}`}>
                <input type="radio" name="hs-list" checked={selected === l.listId} onChange={() => setSelected(l.listId)} className="h-4 w-4 accent-brand-500" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-ink-900">{l.name}</div>
                  <div className="text-xs text-ink-400">
                    {l.size !== null ? `${l.size} ${t('contacts', 'contacts')} · ` : ''}
                    {l.processingType === 'DYNAMIC' ? t('liste active (instantané)', 'active list (snapshot)') : t('liste statique', 'static list')}
                  </div>
                </div>
              </label>
            ))}
          </div>

          {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          {report && (
            <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
              <b>{report.created}</b> {t('créés,', 'created,')} <b>{report.updated}</b> {t('mis à jour,', 'updated,')} <b>{report.skipped}</b> {t('ignorés.', 'skipped.')}
              {report.skippedNoPhone > 0 && <> {report.skippedNoPhone} {t('sans numéro (écartés).', 'without a phone (skipped).')}</>}
              {report.truncated && <div className="mt-1 text-xs text-amber-700">{t('Liste tronquée (import limité aux 5000 premiers).', 'List truncated (import limited to the first 5000).')}</div>}
            </div>
          )}

          <button
            onClick={submit}
            disabled={busy || selected === ''}
            className="mt-4 w-full rounded-lg bg-brand-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
          >
            {busy ? t('Import en cours…', 'Importing…') : t('Importer cette liste', 'Import this list')}
          </button>
        </>
      )}
    </section>
  );
}
