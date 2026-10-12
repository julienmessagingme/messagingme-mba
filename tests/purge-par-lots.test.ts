import { describe, it, expect } from 'vitest';
import { purgerJusquAEpuisement } from '../src/lib/purge-par-lots';

/**
 * 🔴 LA PURGE DES CONVERSATIONS N'A PLUS DE PLAFOND JOURNALIER (lot 14, A). Un lot de 500 toutes les 6 heures plafonnait
 * l'effacement à 2 000 conversations par jour : au-delà, le retard grossissait sans fin et la conservation de 30 jours
 * de la Base n'était plus tenue. Le balayage enchaîne désormais les lots tant que le précédent était plein, dans un
 * budget de temps par passe : chaque lot reste une instruction courte (verrou, WAL), et le passage suivant reprend.
 */
function lots(tailles: number[]) {
  const appels: number[] = [];
  const passe = async () => {
    const n = tailles[appels.length] ?? 0;
    appels.push(n);
    return n;
  };
  return { passe, appels };
}

describe('purgerJusquAEpuisement', () => {
  it('enchaîne les lots tant qu’ils sont pleins, s’arrête au premier lot incomplet, et rend le total', async () => {
    const { passe, appels } = lots([500, 500, 500, 120, 500]);
    expect(await purgerJusquAEpuisement(passe, { taille: 500, budgetMs: 60_000 })).toBe(1620);
    expect(appels).toEqual([500, 500, 500, 120]);
  });

  it('un premier lot vide : un seul appel', async () => {
    const { passe, appels } = lots([0]);
    expect(await purgerJusquAEpuisement(passe, { taille: 500, budgetMs: 60_000 })).toBe(0);
    expect(appels).toEqual([0]);
  });

  it('🔴 s’arrête au budget de temps même si les lots restent pleins : le passage suivant reprend', async () => {
    let t = 0;
    const appels: number[] = [];
    const passe = async () => { t += 25_000; appels.push(500); return 500; };
    expect(await purgerJusquAEpuisement(passe, { taille: 500, budgetMs: 60_000, maintenant: () => t })).toBe(1500);
    // 25 s, 50 s : sous le budget, on continue ; 75 s : au-delà, on s'arrête après ce lot.
    expect(appels).toHaveLength(3);
  });

  it('un lot qui échoue remonte l’échec (le balayage alerte), sans rien masquer', async () => {
    let n = 0;
    const passe = async () => { n += 1; if (n === 2) throw new Error('verrou'); return 500; };
    await expect(purgerJusquAEpuisement(passe, { taille: 500, budgetMs: 60_000 })).rejects.toThrow('verrou');
  });
});
