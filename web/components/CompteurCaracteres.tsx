'use client';

import { useT } from '@/lib/i18n';

/**
 * « N caractères restants » sous un champ borné, « N caractères de trop » en rouge au-delà. `reste` à `null` : rien à
 * dire (le composeur de chaîne ne parle qu'à l'approche de sa borne, `resteAAfficher`). Un seul dessin pour tous les
 * champs bornés de la console (demande de Julien du 2026-10-13, sur les templates).
 */
export function CompteurCaracteres({ reste, testId }: { reste: number | null; testId?: string }) {
  const t = useT();
  if (reste === null) return null;
  return (
    <span
      className={`mt-1 block text-xs tabular-nums ${reste < 0 ? 'text-danger' : 'text-ink-500'}`}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      {reste < 0
        ? t(`${-reste} caractère${reste < -1 ? 's' : ''} de trop`, `${-reste} character${reste < -1 ? 's' : ''} too many`)
        // Zéro prend le singulier en français (« 0 caractère restant »), le pluriel en anglais (« 0 characters left »).
        : t(
          reste <= 1 ? `${reste} caractère restant` : `${reste} caractères restants`,
          reste === 1 ? '1 character left' : `${reste} characters left`,
        )}
    </span>
  );
}
