import { describe, it, expect } from 'vitest';
import { creerTravauxEnVol } from '../src/lib/en-vol';
import { arreterApi } from '../src/shutdown';

/**
 * L'ARRÊT D'UNE COPIE DE L'API ATTEND LES GESTES LAISSÉS EN ROUTE (`src/lib/en-vol.ts`, `arreterApi`).
 *
 * 🔴 Ce que ce fichier protège : un envoi du relais de l'agent de Meta continue une quinzaine de secondes après sa
 * réponse. L'arrêt fermait la file et le pool sans l'attendre : l'agent avait lu « c'est parti », et rien ne partait.
 * Avec un autoscaler, une copie s'arrête à chaque réduction, donc ce n'est plus un cas de déploiement.
 */
const pendant = (ms: number) => new Promise((r) => { setTimeout(r, ms); });

describe('les travaux en vol', () => {
  it('🔴 attendre rend quand le dernier travail finit, et dit qu’il n’en reste aucun', async () => {
    const enVol = creerTravauxEnVol();
    let finir: () => void = () => {};
    void enVol.suivre(new Promise<void>((r) => { finir = r; }));
    let rendu: number | null = null;
    const attente = enVol.attendre(5_000).then((n) => { rendu = n; });
    await pendant(30);
    expect(rendu).toBeNull();
    finir();
    await attente;
    expect(rendu).toBe(0);
  });

  it('🔴 l’attente est BORNÉE : un travail qui ne finit jamais ne retient pas l’arrêt', async () => {
    const enVol = creerTravauxEnVol();
    void enVol.suivre(new Promise<void>(() => {}));
    const debut = Date.now();
    expect(await enVol.attendre(40)).toBe(1);
    expect(Date.now() - debut).toBeLessThan(1_000);
  });

  it('un travail en ÉCHEC est fini, et l’erreur reste à celui qui le tient', async () => {
    const enVol = creerTravauxEnVol();
    const travail = Promise.reject(new Error('panne'));
    await expect(enVol.suivre(travail)).rejects.toThrow('panne');
    expect(await enVol.attendre(1_000)).toBe(0);
  });

  it('un travail ajouté PENDANT l’attente est attendu aussi', async () => {
    const enVol = creerTravauxEnVol();
    void enVol.suivre(pendant(20));
    let finir: () => void = () => {};
    setTimeout(() => { void enVol.suivre(new Promise<void>((r) => { finir = r; })); }, 10);
    let rendu: number | null = null;
    const attente = enVol.attendre(5_000).then((n) => { rendu = n; });
    await pendant(60);
    expect(rendu).toBeNull();
    finir();
    await attente;
    expect(rendu).toBe(0);
  });
});

describe('l’ordre de l’arrêt', () => {
  function banc() {
    const ordre: string[] = [];
    const journal: string[] = [];
    const enVol = creerTravauxEnVol();
    const arreter = (borneMs: number) => arreterApi({
      fermerServeur: async () => { ordre.push('serveur'); },
      travaux: enVol,
      borneMs,
      fermerFile: async () => { ordre.push('file'); },
      fermerPool: async () => { ordre.push('pool'); },
      journal: (l) => { journal.push(l); },
    });
    return { ordre, journal, enVol, arreter };
  }

  it('🔴 le pool ne se ferme qu’APRÈS le geste en cours', async () => {
    const b = banc();
    let finir: () => void = () => {};
    void b.enVol.suivre(new Promise<void>((r) => { finir = () => { b.ordre.push('geste fini'); r(); }; }));
    const arret = b.arreter(5_000);
    await pendant(30);
    expect(b.ordre, 'la file ou le pool fermés sous un envoi en route').toEqual(['serveur']);
    finir();
    await arret;
    expect(b.ordre).toEqual(['serveur', 'geste fini', 'file', 'pool']);
    expect(b.journal).toEqual([]);
  });

  it('🔴 au-delà de la borne, l’arrêt continue et le DIT', async () => {
    const b = banc();
    void b.enVol.suivre(new Promise<void>(() => {}));
    await b.arreter(40);
    expect(b.ordre).toEqual(['serveur', 'file', 'pool']);
    expect(b.journal).toEqual([expect.stringContaining('1 geste(s) encore en cours')]);
  });

  it('sans geste en cours, rien n’est attendu', async () => {
    const b = banc();
    const debut = Date.now();
    await b.arreter(5_000);
    expect(Date.now() - debut).toBeLessThan(1_000);
    expect(b.ordre).toEqual(['serveur', 'file', 'pool']);
  });
});
