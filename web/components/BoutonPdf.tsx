'use client';

import { useT } from '@/lib/i18n';
import { imprimerZone } from '@/lib/impression';

/**
 * Export PDF d'UNE carte. `zone` est l'id porté par la carte à sortir : le reste de la page est masqué le
 * temps de l'impression (cf. `lib/impression.ts` et la section `@media print` de `globals.css`).
 *
 * Le bouton porte lui-même `sans-impression` : il ne doit pas figurer sur la feuille qu'il vient de produire.
 */
export function BoutonPdf({ zone }: { zone: string }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={() => imprimerZone(zone)}
      data-testid={`pdf-${zone}`}
      title={t('Ouvre la boîte d’impression : choisis « Enregistrer au format PDF ».', 'Opens the print dialog: pick "Save as PDF".')}
      aria-label={t('Exporter en PDF', 'Export to PDF')}
      className="sans-impression shrink-0 rounded-md border border-ink-200 px-2 py-0.5 text-[11px] font-semibold tracking-wide text-ink-400 transition hover:border-ink-300 hover:bg-ink-50 hover:text-ink-700"
    >
      PDF
    </button>
  );
}
