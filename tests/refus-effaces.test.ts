import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { empreinteRefus, empreintesDeLaFiche } from '../src/crm/refus-effaces';

/**
 * LA LISTE DE REFUS DES FICHES EFFACÉES (`src/crm/refus-effaces.ts`) : ce qui se vérifie sans base. Le comportement
 * contre une vraie base est dans `tests/integration/refus-effaces.integration.test.ts`.
 */
describe('l’empreinte d’un identifiant', () => {
  it('est stable, propre à l’espace et au type de clé, et ne contient pas le numéro', () => {
    const a = empreinteRefus('t1', { tel: '+33612345678' });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(empreinteRefus('t1', { tel: '+33612345678' })).toBe(a);
    expect(empreinteRefus('t2', { tel: '+33612345678' })).not.toBe(a);
    expect(empreinteRefus('t1', { bsuid: '+33612345678' })).not.toBe(a);
    expect(a).not.toContain('612345678');
  });

  it('une fiche rend une empreinte par identifiant présent, aucune pour un numéro anonymisé', () => {
    expect(empreintesDeLaFiche('t1', { phoneE164: '+33612345678', bsuid: 'FR.123' })).toHaveLength(2);
    expect(empreintesDeLaFiche('t1', { phoneE164: 'anon:3f2c', bsuid: null })).toEqual([]);
    expect(empreintesDeLaFiche('t1', { phoneE164: null, bsuid: 'FR.123' })).toEqual([empreinteRefus('t1', { bsuid: 'FR.123' })]);
  });
});

/**
 * 🔴 L'INVENTAIRE DES CRÉATIONS DE FICHES. La liste de refus ne protège que les insertions qui la lisent : une cinquième
 * `insert into contacts` qui l'ignorerait recréerait sans son STOP la fiche d'une personne effacée, en silence. Ce test
 * compte les insertions de `src/` et exige que chacune consomme la liste (`refus_lus`) dans la même requête.
 */
describe('chaque création de fiche lit la liste de refus', () => {
  function fichiers(dossier: string): string[] {
    return readdirSync(dossier).flatMap((n) => {
      const p = join(dossier, n);
      return statSync(p).isDirectory() ? fichiers(p) : p.endsWith('.ts') ? [p] : [];
    });
  }

  it('les quatre insertions de `src/` sont toutes dans le store, et chacune consomme la liste', () => {
    const trouvees: Array<{ fichier: string; avant: string }> = [];
    for (const f of fichiers('src')) {
      const texte = readFileSync(f, 'utf8');
      const re = /insert\s+into\s+contacts\s*\(/gi;
      for (let m = re.exec(texte); m; m = re.exec(texte)) {
        // La requête qui porte l'insertion : depuis son ouverture (`query`) jusqu'à l'insertion.
        const debut = texte.lastIndexOf('.query', m.index);
        trouvees.push({ fichier: f.replace(/\\/g, '/'), avant: texte.slice(debut, m.index) });
      }
    }
    expect(trouvees.map((t) => t.fichier)).toEqual(Array(4).fill('src/crm/contact-store.pg.ts'));
    for (const t of trouvees) expect(t.avant).toMatch(/refus_lus|cteRefus\(/);
  });
});
