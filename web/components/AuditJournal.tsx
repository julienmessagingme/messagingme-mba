'use client';

import { useEffect, useState } from 'react';
import { listAudit, type AuditEntry } from '@/lib/api';
import { useT, useLocale } from '@/lib/i18n';
import { formatDate, hourMin } from '@/lib/day';
import { cardCls } from '@/lib/ui';

/**
 * Historique des actions sensibles sur les contacts : qui a ajouté, supprimé, effacé, ou basculé un
 * consentement, et quand.
 *
 * ⚠️ Ce journal ne porte JAMAIS de donnée personnelle, seulement l'identifiant interne du contact. Ce n'est
 * pas une omission d'affichage : y écrire le numéro annulerait la purge, en réinscrivant la personne dans une
 * table faite pour ne jamais être modifiée. Un identifiant reste rapprochable d'une fiche VIVANTE ; après une
 * purge, il ne désigne plus personne, et c'est exactement ce qu'on veut.
 *
 * Lecture seule, et il n'existe aucun chemin d'écriture depuis l'écran : un journal qu'on peut retoucher ne
 * prouve rien.
 */
const LIBELLES: Record<string, [string, string]> = {
  'contact.created': ['Contact ajouté', 'Contact added'],
  'contact.imported': ['Import de contacts', 'Contact import'],
  'contact.deleted': ['Contacts supprimés', 'Contacts deleted'],
  'contact.restored': ['Contacts restaurés', 'Contacts restored'],
  'contact.purged': ['Contact effacé définitivement', 'Contact permanently erased'],
  'contact.optin': ['Passage en opt-in', 'Marked as opted in'],
  'contact.optout': ['Passage en opt-out', 'Marked as opted out'],
};

/** Rouge pour ce qui détruit, ambre pour ce qui coupe les envois, vert pour ce qui les ouvre. */
const TONS: Record<string, string> = {
  'contact.purged': 'bg-red-50 text-red-700',
  'contact.deleted': 'bg-red-50 text-red-700',
  'contact.optout': 'bg-amber-50 text-amber-800',
  'contact.optin': 'bg-emerald-50 text-emerald-800',
};

/** Détail compact : « created 2 · optIn oui ». Rien à interpréter, ce sont des compteurs et des drapeaux. */
function resumeDetail(detail: Record<string, unknown>, oui: string, non: string): string {
  return Object.entries(detail)
    .map(([k, v]) => `${k} ${typeof v === 'boolean' ? (v ? oui : non) : String(v)}`)
    .join(' · ');
}

export function AuditJournal({ tenantId }: { tenantId: string }) {
  const t = useT();
  const { locale } = useLocale();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listAudit(tenantId)
      .then((r) => { if (alive) setEntries(r.entries); })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : t('Journal illisible', 'Journal unreadable')); });
    return () => { alive = false; };
  }, [tenantId, t]);

  return (
    <section className={cardCls} data-testid="audit-journal">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-ink-900">{t('Journal des actions', 'Action log')}</h3>
        <p className="text-xs text-ink-500">
          {t(
            'Ajouts, suppressions, effacements et bascules de consentement. Les contacts y figurent par identifiant, jamais par numéro.',
            'Additions, deletions, erasures and consent changes. Contacts appear by identifier, never by phone number.',
          )}
        </p>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!error && entries === null && <p className="text-sm text-ink-400">{t('Chargement…', 'Loading…')}</p>}
      {!error && entries?.length === 0 && (
        <p className="text-sm text-ink-400">{t('Aucune action enregistrée pour le moment.', 'No action recorded yet.')}</p>
      )}

      {entries && entries.length > 0 && (
        <ul className="max-h-96 divide-y divide-ink-100 overflow-y-auto">
          {entries.map((e) => (
            <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm">
              <span className="w-36 shrink-0 text-xs tabular-nums text-ink-400">
                {formatDate(e.at, locale, { day: '2-digit', month: '2-digit', year: '2-digit' })} {hourMin(e.at, locale)}
              </span>
              <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${TONS[e.action] ?? 'bg-ink-100 text-ink-700'}`}>
                {LIBELLES[e.action] ? t(...LIBELLES[e.action]!) : e.action}
              </span>
              {/* Acteur absent = le système (webhook, balayage), pas un humain : le dire plutôt que laisser un blanc. */}
              <span className="text-ink-700">{e.actorEmail ?? t('Système', 'System')}</span>
              <span className="font-mono text-xs text-ink-400">{e.targetId}</span>
              {Object.keys(e.detail).length > 0 && (
                <span className="text-xs text-ink-500">{resumeDetail(e.detail, t('oui', 'yes'), t('non', 'no'))}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
