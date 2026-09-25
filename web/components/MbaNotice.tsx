'use client';

/**
 * Bandeau de retour d'un panneau de configuration MBA : erreur, avertissement, succès.
 *
 * L'ambre existe pour un cas précis et fréquent ici : un import interrompu en chemin n'est PAS un échec, une
 * partie est écrite. Le peindre en rouge pousserait à tout relancer comme si rien n'était passé.
 */
export function MbaNotice({ kind, children, testid }: {
  kind: 'error' | 'warning' | 'success';
  children: React.ReactNode;
  testid?: string;
}) {
  const styles = {
    error: 'border-danger-200 bg-danger-50 text-danger-800',
    warning: 'border-alerte-300 bg-alerte-50 text-ink-900',
    success: 'border-succes-200 bg-succes-50 text-succes-800',
  }[kind];
  return (
    <p role={kind === 'error' ? 'alert' : undefined} {...(testid ? { 'data-testid': testid } : {})} className={`rounded-lg border px-3 py-2 text-sm leading-relaxed ${styles}`}>
      {children}
    </p>
  );
}
