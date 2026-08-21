'use client';

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { useT } from '@/lib/i18n';
import { getSettings, setTimezone as apiSetTimezone, setBusinessHours as apiSetBusinessHours, type BusinessHours } from '@/lib/api';
import { TIMEZONES, timezoneLabel, DEFAULT_TIMEZONE } from '@/lib/timezones';
import { inputClsAuto } from '@/lib/ui';
import { BlockedContacts } from '@/components/BlockedContacts';
import { AuditJournal } from '@/components/AuditJournal';

export default function ParametresPage() {
  return <AppShell active="parametres">{(session) => <Parametres tenantId={session.tenantId} />}</AppShell>;
}

// Ordre d'AFFICHAGE Lun -> Dim ; les clés restent '0'..'6' (0 = dimanche), alignées sur le serveur.
const DAY_ORDER = ['1', '2', '3', '4', '5', '6', '0'] as const;
const DAY_LABELS: Record<string, [string, string]> = {
  '1': ['Lundi', 'Monday'], '2': ['Mardi', 'Tuesday'], '3': ['Mercredi', 'Wednesday'],
  '4': ['Jeudi', 'Thursday'], '5': ['Vendredi', 'Friday'], '6': ['Samedi', 'Saturday'], '0': ['Dimanche', 'Sunday'],
};

/** Complète une semaine partielle : 7 jours garantis, un jour manquant -> fermé. */
function normalize(hours: BusinessHours | undefined): BusinessHours {
  const out: BusinessHours = {};
  for (const d of ['0', '1', '2', '3', '4', '5', '6']) {
    const day = hours?.[d];
    out[d] = day ? { closed: !!day.closed, open: day.open ?? '', close: day.close ?? '' } : { closed: true, open: '', close: '' };
  }
  return out;
}

/** Un jour est valide s'il est fermé, ou ouvert avec open < close (les inputs type=time garantissent HH:MM). */
function dayValid(d: { closed: boolean; open: string; close: string }): boolean {
  return d.closed || (d.open !== '' && d.close !== '' && d.close > d.open);
}

function Parametres({ tenantId }: { tenantId: string }) {
  const t = useT();
  const [timezone, setTz] = useState(DEFAULT_TIMEZONE);
  const [hours, setHours] = useState<BusinessHours>(() => normalize(undefined));
  const [loading, setLoading] = useState(true);
  const [tzStatus, setTzStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [bhStatus, setBhStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    let alive = true;
    getSettings(tenantId)
      .then((s) => { if (!alive) return; setTz(s.timezone ?? DEFAULT_TIMEZONE); setHours(normalize(s.businessHours)); })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [tenantId]);

  const onTimezone = useCallback((iana: string) => {
    setTz(iana);
    setTzStatus('saving');
    apiSetTimezone(tenantId, iana).then(() => setTzStatus('saved')).catch(() => setTzStatus('error'));
  }, [tenantId]);

  const patchDay = (d: string, patch: Partial<{ closed: boolean; open: string; close: string }>) => {
    setBhStatus('idle');
    setHours((h) => ({ ...h, [d]: { ...h[d]!, ...patch } }));
  };

  const allValid = DAY_ORDER.every((d) => dayValid(hours[d]!));
  const saveHours = () => {
    if (!allValid) return;
    setBhStatus('saving');
    apiSetBusinessHours(tenantId, hours).then(() => setBhStatus('saved')).catch(() => setBhStatus('error'));
  };

  const cardCls = 'rounded-2xl border border-ink-200 bg-white p-5 shadow-sm';
  const kicker = 'text-xs font-semibold uppercase tracking-wide text-brand-600';

  const statusText = (s: typeof tzStatus) =>
    s === 'saving' ? t('enregistrement…', 'saving…') : s === 'saved' ? t('enregistré', 'saved') : s === 'error' ? t('erreur', 'error') : '';

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header className="space-y-1">
        <span className={kicker}>{t('Paramètres', 'Settings')}</span>
        <h2 className="text-xl font-semibold tracking-tight text-ink-900">{t('Fuseau & heures d’ouverture', 'Time zone & business hours')}</h2>
        <p className="text-sm text-ink-600">{t('Base des conditions temporelles de vos scénarios (maintenant, jour de semaine, heures d’ouverture).', 'The basis for the time conditions in your scenarios (now, weekday, business hours).')}</p>
      </header>

      {loading ? (
        <p className="text-sm text-ink-400">{t('Chargement…', 'Loading…')}</p>
      ) : (
        <>
          {/* Fuseau horaire */}
          <section className={cardCls}>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-ink-900">{t('Fuseau horaire', 'Time zone')}</h3>
                <p className="text-xs text-ink-500">{t('Toutes les conditions de temps sont évaluées dans ce fuseau.', 'All time conditions are evaluated in this zone.')}</p>
              </div>
              <span className={`text-xs ${tzStatus === 'error' ? 'text-coral' : 'text-ink-400'}`}>{statusText(tzStatus)}</span>
            </div>
            <select data-testid="param-timezone" value={timezone} onChange={(e) => onTimezone(e.target.value)} className={`${inputClsAuto} w-full bg-white sm:w-96`}>
              {TIMEZONES.map((o) => <option key={o.iana} value={o.iana}>{timezoneLabel(o)}</option>)}
            </select>
          </section>

          {/* Heures d'ouverture */}
          <section className={cardCls}>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-ink-900">{t('Heures d’ouverture', 'Business hours')}</h3>
                <p className="text-xs text-ink-500">{t('Par jour : heure de début et de fin, ou fermé.', 'Per day: opening and closing time, or closed.')}</p>
              </div>
              <span className={`text-xs ${bhStatus === 'error' ? 'text-coral' : 'text-ink-400'}`}>{statusText(bhStatus)}</span>
            </div>
            <div className="space-y-2">
              {DAY_ORDER.map((d) => {
                const day = hours[d]!;
                const invalid = !dayValid(day);
                return (
                  <div key={d} className="flex flex-wrap items-center gap-3 rounded-xl border border-ink-100 px-3 py-2">
                    <span className="w-24 shrink-0 text-sm font-medium text-ink-800">{t(...DAY_LABELS[d]!)}</span>
                    <label className="flex items-center gap-1.5 text-sm text-ink-600">
                      <input type="checkbox" checked={day.closed} onChange={(e) => patchDay(d, { closed: e.target.checked })} className="h-4 w-4 rounded border-ink-300" />
                      {t('Fermé', 'Closed')}
                    </label>
                    {!day.closed && (
                      <div className="flex items-center gap-2">
                        <input type="time" value={day.open} onChange={(e) => patchDay(d, { open: e.target.value })} className={`${inputClsAuto} bg-white`} />
                        <span className="text-sm text-ink-400">{t('à', 'to')}</span>
                        <input type="time" value={day.close} onChange={(e) => patchDay(d, { close: e.target.value })} className={`${inputClsAuto} bg-white`} />
                        {invalid && <span className="text-xs text-coral">{t('l’heure de fin doit suivre le début', 'end time must be after start')}</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-4 flex items-center gap-3">
              <button
                data-testid="param-save-hours"
                onClick={saveHours}
                disabled={!allValid || bhStatus === 'saving'}
                className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:bg-ink-200"
              >
                {t('Enregistrer les horaires', 'Save hours')}
              </button>
              {!allValid && <span className="text-xs text-coral">{t('Corrigez les jours en rouge avant d’enregistrer.', 'Fix the days in red before saving.')}</span>}
            </div>
          </section>

          {/* Contacts bloqués : SEULE porte de sortie d'un blocage. Un contact bloqué n'apparaît nulle part
              ailleurs, donc sans cet écran il serait introuvable. La section se masque quand la liste est vide. */}
          <BlockedContacts tenantId={tenantId} />

          {/* Journal d'audit : lecture seule, alimenté par les actions sur les contacts. */}
          <AuditJournal tenantId={tenantId} />
        </>
      )}
    </div>
  );
}
