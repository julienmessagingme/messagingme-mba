'use client';

import { useT } from '@/lib/i18n';
import { imprimerZone } from '@/lib/impression';
import { Bouton } from '@/components/Bouton';

/**
 * Export PDF d'UNE carte. `zone` est l'id porté par la carte à sortir : le reste de la page est masqué le
 * temps de l'impression (cf. `lib/impression.ts` et la section `@media print` de `globals.css`).
 *
 * Le bouton porte lui-même `sans-impression` : il ne doit pas figurer sur la feuille qu'il vient de produire.
 */
export function BoutonPdf({ zone }: { zone: string }) {
  const t = useT();
  return (
    <Bouton variante="secondaire" taille="petite"
      type="button"
      onClick={() => imprimerZone(zone)}
      data-testid={`pdf-${zone}`}
      title={t('Ouvre la boîte d’impression : choisis « Enregistrer au format PDF ».', 'Opens the print dialog: pick "Save as PDF".')}
      aria-label={t('Exporter en PDF', 'Export to PDF')}
      className="sans-impression shrink-0"
    >
      PDF
    </Bouton>
  );
}
