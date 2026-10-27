/**
 * Recopie au bucket les fichiers de la médiathèque encore en base (lot A des médias, `src/medias/recopie.ts`). Sur la
 * machine des workers, dans l'image en service, avec le `.env.prod` (la base et les cinq variables `OBJETS_*`) :
 *
 *   docker run --rm --env-file /opt/messagingme/.env.prod <image> npx tsx scripts/medias-vers-objets.mts [--espaces=<id>,<id>]
 *
 * `--espaces` borne la recopie à ces espaces : un essai sur un espace de test avant le reste. Rejouable. Sort en 0 quand
 * plus aucune fiche n'est en base (dans le périmètre), en 1 sinon : la relancer, puis lire ses échecs.
 */
import '../src/charger-env';
import { Client } from 'pg';
import { pgSsl } from '../src/db/ssl';
import { config } from '../src/config';
import { creerMagasinObjets, configObjets } from '../src/lib/magasin-objets';
import { recopierVersObjets, sourceRecopiePg } from '../src/medias/recopie';

const magasin = creerMagasinObjets(configObjets(config));
if (magasin === null) {
  console.error('les variables OBJETS_* ne sont pas posées : rien ne peut être recopié');
  process.exit(1);
}
const argument = process.argv.find((a) => a.startsWith('--espaces='));
const espaces = argument ? argument.slice('--espaces='.length).split(',').filter((e) => e !== '') : null;
if (espaces && (espaces.length === 0 || !espaces.every((e) => /^[0-9a-f-]{36}$/i.test(e)))) {
  console.error('--espaces attend des identifiants d’espace séparés par des virgules');
  process.exit(1);
}
const client = new Client({ connectionString: config.DATABASE_URL, ssl: pgSsl(config.DATABASE_URL) });
await client.connect();
try {
  const r = await recopierVersObjets(sourceRecopiePg(client, espaces), magasin, (ligne) => console.error(ligne));
  console.log(`recopiees ${r.recopiees}, echecs ${r.echecs}, encore en base ${r.restantes}`);
  process.exitCode = r.restantes === 0 ? 0 : 1;
} finally {
  await client.end();
}
