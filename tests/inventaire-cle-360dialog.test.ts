import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * L'INVENTAIRE DE CEUX QUI LISENT UNE CLÉ 360DIALOG (360dialog, lot 2, livraison A).
 *
 * `resolveForTenant` et `resolveForWaba` refusent la clé d'un compte 360dialog (`CompteChez360dialog`) : tout ce qui
 * parle à Graph échoue donc fermé, par construction. Seules `resolvePourEnvoi` et `cle360dialog` la rendent, et
 * chaque fichier qui les appelle doit savoir parler à 360dialog. 🔴 Un appelant de plus qui construirait un client Graph
 * avec elle ferait partir la clé chez Meta, et le 401 l'invaliderait : tous les envois de l'espace coupés. Ce test
 * oblige à le décider, ici, avec sa raison.
 */
const AUTORISES: Record<string, string> = {
  'src/meta/credentials.ts': 'la définition, et `cle360dialog` bâtie sur `resolvePourEnvoi`',
  'src/meta/factory.ts': 'envoi (`MetaClient`), modèles (`Template360dialogClient`) et Flows (`MetaFlowClient`) : chacun reçoit le fournisseur et parle à 360dialog',
  'src/workflow/wiring.ts': 'le téléversement des médias d’envoi : `Media360dialogClient` pour un compte 360dialog',
  'src/index.ts': 'les médias reçus (`Media360dialogClient`) et l’en-tête d’un modèle créé (médiathèque) pour un compte 360dialog',
};

const RACINE = resolve(__dirname, '..');

function fichiers(dossier: string): string[] {
  return readdirSync(dossier).flatMap((nom) => {
    const chemin = join(dossier, nom);
    if (statSync(chemin).isDirectory()) return fichiers(chemin);
    return nom.endsWith('.ts') ? [chemin] : [];
  });
}

describe('qui lit une clé 360dialog', () => {
  it('🔴 seuls les fichiers inventoriés appellent resolvePourEnvoi ou cle360dialog', () => {
    const lecteurs = fichiers(join(RACINE, 'src'))
      .filter((f) => /\b(resolvePourEnvoi|cle360dialog)\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(RACINE, f).split('\\').join('/'))
      .sort();
    expect(lecteurs).toEqual(Object.keys(AUTORISES).sort());
  });
});
