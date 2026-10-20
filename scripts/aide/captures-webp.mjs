// LES CAPTURES DU CENTRE D'AIDE, DU PNG AU WEBP (plan du centre d'aide, tâche 8). Les scénarios de
// `web/e2e/captures/` écrivent `web/e2e/captures/sortie/<clé>/etape-<n>[-en].png` ; ce script en fait
// `site/img/aide/<clé>/etape-<n>[-en].webp`, que `npm run vitrine:aide` place à côté de chaque étape.
// Usage : `npm run aide:captures` (les scénarios puis ce script), ou `node scripts/aide/captures-webp.mjs` seul.
// ⚠️ Il n'efface rien : une capture d'une étape retirée reste sous `site/img/aide/` et `tests/vitrine-aide.test.ts`
// la refuse, pour qu'on la retire en le sachant.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SORTIE = join(RACINE, 'web', 'e2e', 'captures', 'sortie');
const CIBLE = join(RACINE, 'site', 'img', 'aide');
const NOM = /^etape-\d+(-en)?\.png$/;

if (!existsSync(SORTIE)) {
  console.error(`Aucune capture dans ${SORTIE} : lancez d'abord les scénarios (npm run aide:captures).`);
  process.exit(1);
}

let n = 0;
for (const cle of readdirSync(SORTIE)) {
  for (const fichier of readdirSync(join(SORTIE, cle)).filter((f) => NOM.test(f))) {
    mkdirSync(join(CIBLE, cle), { recursive: true });
    const vers = join(CIBLE, cle, fichier.replace(/\.png$/, '.webp'));
    // `-preset text` : des écrans de console, du texte et des aplats, que le réglage photo brouillerait.
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(SORTIE, cle, fichier),
      '-c:v', 'libwebp', '-preset', 'text', '-quality', '85', '-compression_level', '6', vers], { stdio: 'inherit' });
    if (r.status !== 0) {
      console.error(`ffmpeg a échoué sur ${cle}/${fichier}${r.error ? ` (${r.error.message})` : ''}`);
      process.exit(1);
    }
    n++;
  }
}
console.log(`${n} captures écrites sous site/img/aide/. Ensuite : npm run vitrine:aide.`);
