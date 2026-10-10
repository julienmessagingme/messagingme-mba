import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { contratDuSdk, schemaDuSdk } from '../scripts/sdk-contrat';

/**
 * 🔴 LE SDK N'EST JAMAIS EN RETARD SUR L'API (lot 16, livraison B). Son contrat recopié (`sdk/openapi.json`) et ses
 * types (`sdk/src/schema.ts`) sont refaits ici depuis le code et comparés au caractère près. Une route, un champ ou un
 * événement changés sans `npm run sdk:contrat` rendent la CI rouge, au lieu de publier un SDK qui ment.
 */
const lire = (chemin: string): string => readFileSync(new URL(`../${chemin}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('le contrat et les types du SDK sont ceux du code', () => {
  it('sdk/openapi.json est le contrat que l’API sert (lancer npm run sdk:contrat sinon)', () => {
    expect(lire('sdk/openapi.json')).toBe(contratDuSdk().texte);
  });

  it('sdk/src/schema.ts est généré depuis ce contrat (lancer npm run sdk:contrat sinon)', async () => {
    expect(lire('sdk/src/schema.ts')).toBe(await schemaDuSdk(contratDuSdk().contrat));
  }, 60_000);

  it('le SDK se construit avec SA configuration (NodeNext, celle de la publication), pas seulement celle du dépôt', () => {
    // Le typage du dépôt (Bundler) lit `sdk/src` par les tests ; la publication le construit en NodeNext. Une rupture
    // propre à NodeNext (une extension d'import oubliée) se voit ici, en CI, et non à la publication.
    const racine = fileURLToPath(new URL('..', import.meta.url));
    const tsc = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
    try {
      execFileSync(process.execPath, [tsc, '-p', 'sdk/tsconfig.json', '--noEmit'], { cwd: racine, stdio: 'pipe' });
    } catch (e) {
      // tsc écrit ses diagnostics sur la sortie standard : les remonter, sinon l'échec ne dit que « Command failed ».
      const sortie = e as { stdout?: Buffer; stderr?: Buffer };
      throw new Error(`tsc -p sdk/tsconfig.json a échoué :\n${String(sortie.stdout ?? '')}${String(sortie.stderr ?? '')}`);
    }
  }, 120_000);

  it('la page SDK de la doc et le README installent la version de sdk/package.json', () => {
    // Monter la version sans les toucher ferait installer l'ancienne aux intégrateurs, sans aucune erreur.
    const { version } = JSON.parse(lire('sdk/package.json')) as { version: string };
    expect(lire('web/app/developers/api/sdk/page.tsx')).toContain(`const VERSION_SDK = '${version}';`);
    expect(lire('sdk/README.md')).toContain(`messagingme-sdk#v${version}`);
  });

  it('le SDK publié pointe la production et n’embarque aucune dépendance d’exécution', () => {
    const paquet = JSON.parse(lire('sdk/package.json')) as Record<string, unknown>;
    expect(paquet.dependencies).toBeUndefined();
    expect(paquet.peerDependencies).toBeUndefined();
    expect((JSON.parse(lire('sdk/openapi.json')) as { servers: unknown }).servers).toEqual([{ url: 'https://api.messagingme.app' }]);
    expect(lire('sdk/src/index.ts')).toMatch(/DEFAULT_BASE_URL = 'https:\/\/api\.messagingme\.app'/);
  });
});
