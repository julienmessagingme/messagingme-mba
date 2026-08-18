'use client';

import { useLocale, useT } from '@/lib/i18n';
import { resumeApercu } from '@/lib/mba-faq';
import type { MbaFaqPreview } from '@/lib/api-mba';

/**
 * L'aperçu d'un import : ce qui sera créé, ce qui sera mis à jour, ce qui ne bougera pas.
 *
 * Sorti du panneau d'import parce que celui-ci dépassait le plafond de taille que le plan s'était donné. Bloc
 * purement présentationnel, il ne décide de rien.
 */

/** Au-delà, on annonce le reste en chiffre : une liste de 400 lignes n'aide personne à décider. */
const LIGNES = 15;

export function MbaFaqImportPreview({ apercu }: { apercu: MbaFaqPreview }) {
  const t = useT();
  const { locale } = useLocale();

  const liste = (titre: string, entrees: Array<{ question: string; answer: string }>, testid: string, cle: (i: number) => string) => (
    <div className="mt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">{titre}</p>
      <ul className="mt-1 space-y-1" data-testid={testid}>
        {entrees.slice(0, LIGNES).map((f, i) => (
          <li key={cle(i)} className="truncate text-xs text-ink-700">
            <span className="font-medium">{f.question}</span> <span className="text-ink-500">{f.answer}</span>
          </li>
        ))}
      </ul>
      {entrees.length > LIGNES && (
        <p className="mt-1 text-xs text-ink-500">
          {t(`et ${entrees.length - LIGNES} autre(s).`, `and ${entrees.length - LIGNES} more.`)}
        </p>
      )}
    </div>
  );

  return (
    <div className="rounded-xl border border-ink-200 p-4" data-testid="mba-import-preview">
      <p className="text-sm font-medium text-ink-900" data-testid="mba-import-summary">{resumeApercu(apercu, locale)}</p>
      <p className="mt-1 text-xs text-ink-500">
        {t(`Source détectée : ${apercu.source}. ${apercu.total} question(s) lue(s).`, `Detected source: ${apercu.source}. ${apercu.total} question(s) read.`)}
      </p>
      {apercu.aCreer.length > 0 && liste(t('À créer', 'To create'), apercu.aCreer, 'mba-import-tocreate', (i) => `c${i}`)}
      {apercu.aMettreAJour.length > 0 && liste(t('À mettre à jour', 'To update'), apercu.aMettreAJour, 'mba-import-toupdate', (i) => `m${i}`)}
    </div>
  );
}
