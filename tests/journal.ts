import { vi } from 'vitest';

/**
 * Les lignes que `journaliser` (`src/lib/journal.ts`) écrit pendant `f`, relues en JSON.
 *
 * 🔴 Un appel au journal qui ne part pas ne lève rien : seul un test qui LIT la sortie distingue une trace d'un
 * appel muet. Remplacer une ligne de journal par `void 0` laissait toute la suite verte, faute de ce test.
 */
export async function capturerJournal<T>(f: () => Promise<T>): Promise<{ resultat: T; lignes: Array<Record<string, unknown>> }> {
  const brut: string[] = [];
  const espions = (['log', 'warn', 'error'] as const)
    .map((niveau) => vi.spyOn(console, niveau).mockImplementation((...args: unknown[]) => { brut.push(String(args[0])); }));
  try {
    const resultat = await f();
    const lignes = brut.flatMap((l) => {
      try {
        const o = JSON.parse(l) as unknown;
        return typeof o === 'object' && o !== null ? [o as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    });
    return { resultat, lignes };
  } finally {
    for (const e of espions) e.mockRestore();
  }
}
