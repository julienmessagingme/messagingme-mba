'use client';

import { useEffect, useState } from 'react';
import { listAudit, type AuditEntry } from '@/lib/api';
import { useT, useLocale } from '@/lib/i18n';
import { formatDate, hourMin } from '@/lib/day';
import { cardCls } from '@/lib/ui';
import { toCsv, downloadCsv } from '@/lib/csv';
import { ACTIONS_JOURNAL, resumeDetail, lignesJournalCsv } from '@/lib/journal';

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
/** Rouge pour ce qui détruit, ambre pour ce qui coupe les envois, vert pour ce qui les ouvre. */
const TONS: Record<string, string> = {
  'contact.purged': 'bg-red-50 text-red-700',
  'contact.optout': 'bg-amber-50 text-amber-800',
  'contact.optin': 'bg-emerald-50 text-emerald-800',
};

/** Ce que l'export va chercher, indépendamment des 100 dernières lignes affichées. Plafond serveur. */
const LIMITE_EXPORT = 1000;

export function AuditJournal({ tenantId }: { tenantId: string }) {
  const t = useT();
  const { locale } = useLocale();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportEnCours, setExportEnCours] = useState(false);

  const libelleAction = (action: string): string => (ACTIONS_JOURNAL[action] ? t(...ACTIONS_JOURNAL[action]!) : action);

  useEffect(() => {
    let alive = true;
    listAudit(tenantId)
      .then((r) => { if (alive) setEntries(r.entries); })
      .catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : t('Journal illisible', 'Journal unreadable')); });
    return () => { alive = false; };
  }, [tenantId, t]);

  /**
   * Export CSV. Il RELIT le journal jusqu'au plafond serveur au lieu de reprendre les lignes affichées :
   * l'écran n'en montre que les dernières, et un export tronqué à ce qu'on avait sous les yeux se présenterait
   * comme le journal complet.
   */
  async function exporter(): Promise<void> {
    setExportEnCours(true);
    setError(null);
    try {
      const { entries: toutes } = await listAudit(tenantId, LIMITE_EXPORT);
      const entetes = [
        t('Date (ISO)', 'Date (ISO)'), t('Action', 'Action'), t('Auteur', 'Author'),
        t('Type de cible', 'Target type'), t('Cible', 'Target'), t('Détail', 'Detail'),
      ];
      const lignes = lignesJournalCsv(toutes, {
        action: libelleAction, oui: t('oui', 'yes'), non: t('non', 'no'), systeme: t('Système', 'System'),
      });
      downloadCsv(t('journal-des-actions.csv', 'action-log.csv'), toCsv(entetes, lignes));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('Export impossible', 'Export failed'));
    } finally {
      setExportEnCours(false);
    }
  }

  return (
    <section className={cardCls} data-testid="audit-journal">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink-900">{t('Journal des actions', 'Action log')}</h3>
          <p className="text-xs text-ink-500">
            {t(
              'Ajouts, suppressions, effacements et bascules de consentement. Les contacts y figurent par identifiant, jamais par numéro.',
              'Additions, deletions, erasures and consent changes. Contacts appear by identifier, never by phone number.',
            )}
          </p>
        </div>
        {/* `!entries` et non `entries === null` : une réponse sans `entries` (instance sans journal, coupure en
            vol) laisse `undefined`, et lire `.length` dessus fait tomber TOUTE la page Paramètres. */}
        <button
          type="button"
          onClick={() => void exporter()}
          disabled={exportEnCours || !entries || entries.length === 0}
          data-testid="journal-export-csv"
          className="shrink-0 rounded-lg border border-ink-200 px-2.5 py-1 text-xs font-medium text-ink-600 transition hover:bg-ink-50 disabled:opacity-40"
        >
          {exportEnCours ? t('Export…', 'Exporting…') : t('Exporter en CSV', 'Export to CSV')}
        </button>
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
                {libelleAction(e.action)}
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
