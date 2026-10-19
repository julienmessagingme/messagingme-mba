import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ENTREES } from '../web/lib/registre-vitrine';
import { COMMANDES, COMMANDES_EN_ATTENTE } from '../scripts/plugin/commandes';
import { commandesPubliees, dossiersDeCommandes } from '../scripts/plugin/generer';

/**
 * LES COMMANDES DE CAS DU PLUGIN (lot 6 bis, livraison D) : un dossier par commande, généré depuis le registre, le code
 * compilé des cas (`EXEMPLES_CAS`) et le texte de `scripts/plugin/commandes.ts`. Le dossier `plugin/` part tel quel
 * dans le dépôt public : ce qui y traîne s'installe chez tout le monde.
 */
const PLUGIN = resolve(__dirname, '..', 'plugin');
const lister = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? lister(join(d, n)) : [join(d, n)]));

describe('les commandes de cas du plugin', () => {
  it('🔴 chaque fichier généré est sur le disque, égal au caractère près (npm run plugin:generer)', () => {
    expect(dossiersDeCommandes().length).toBeGreaterThan(0);
    for (const f of dossiersDeCommandes()) expect(readFileSync(resolve(PLUGIN, f.chemin), 'utf8'), f.chemin).toBe(f.contenu);
  });

  it('aucun fichier de plus dans le dossier d’une commande : un reste d’une version précédente partirait chez tout le monde', () => {
    const attendus = new Set(dossiersDeCommandes().map((f) => f.chemin));
    for (const c of commandesPubliees()) {
      for (const f of lister(resolve(PLUGIN, 'skills', c))) expect(attendus.has(relative(PLUGIN, f).replace(/\\/g, '/')), f).toBe(true);
    }
  });

  it('chaque commande du registre est publiée, ou dit ce qu’elle attend : aucune ne disparaît en silence', () => {
    for (const e of ENTREES) {
      if (!e.commande || e.commande === 'demarrer') continue;
      expect(commandesPubliees().includes(e.commande) || e.commande in COMMANDES_EN_ATTENTE, e.commande).toBe(true);
    }
    for (const c of Object.keys(COMMANDES_EN_ATTENTE)) expect(commandesPubliees(), c).not.toContain(c);
  });

  it('un texte de commande sans entrée au registre ne se publie pas', () => {
    for (const c of Object.keys(COMMANDES)) expect(ENTREES.some((e) => e.commande === c), c).toBe(true);
  });

  it('🔴 aucune clé ni aucun secret dans un dossier de commande : seulement les noms des variables', () => {
    for (const f of dossiersDeCommandes()) expect(f.contenu, f.chemin).not.toMatch(/mba_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}/);
  });
});
