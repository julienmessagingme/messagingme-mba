#!/usr/bin/env node
/**
 * La base d'API est-elle vraiment SCELLÉE dans le bundle qu'on vient de construire ?
 *
 * 🔴 POURQUOI CE CONTRÔLE EXISTE. `NEXT_PUBLIC_API_URL` est figée AU BUILD : la changer sans reconstruire ne
 * fait rien, EN SILENCE. C'est le même piège que `BACKEND_URL` sur l'image Docker, et le dépôt le documente
 * déjà. Un build qui « passe » ne prouve donc rien du tout sur la valeur réellement embarquée : il prouve
 * que le code compile, pas que la console appellera la bonne adresse.
 *
 * 🔴 ET LA CONSOLE LIVRÉE N'EST PAS CELLE QUE LES E2E EXERCENT. Les specs Playwright interceptent
 * `**\/api\/backend\/**`, c'est-à-dire le chemin du proxy Next, celui de l'ancienne console servie par le
 * VPS. Depuis la bascule Vercel, le navigateur appelle `api.messagingme.app` en direct et ne traverse plus
 * ce proxy. Personne ne vérifiait la topologie réellement livrée.
 *
 * Ce script ferme ce trou pour le coût d'un `grep` : il construit la liste des fichiers JS du bundle client
 * et cherche la base attendue. Volontairement bête, sans dépendance, et il ne juge rien d'autre.
 *
 * Usage : node scripts/verifier-base-api.mjs https://api.messagingme.app
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const attendue = process.argv[2];
if (!attendue) {
  console.error('usage : node scripts/verifier-base-api.mjs <base attendue>');
  process.exit(2);
}

/** Le bundle CLIENT : c'est lui que le navigateur télécharge, donc lui qui porte la valeur figée. */
const RACINE = join(process.cwd(), '.next', 'static');

function fichiersJs(dossier) {
  let out = [];
  for (const entree of readdirSync(dossier)) {
    const chemin = join(dossier, entree);
    if (statSync(chemin).isDirectory()) out = out.concat(fichiersJs(chemin));
    else if (chemin.endsWith('.js')) out.push(chemin);
  }
  return out;
}

let fichiers;
try {
  fichiers = fichiersJs(RACINE);
} catch (err) {
  console.error(`Bundle introuvable dans ${RACINE} : lance le build avant. (${err.message})`);
  process.exit(2);
}

const porteur = fichiers.find((f) => readFileSync(f, 'utf8').includes(attendue));
if (porteur === undefined) {
  console.error(
    `ÉCHEC : « ${attendue} » n'apparaît dans AUCUN des ${fichiers.length} fichiers JS du bundle client.\n`
    + "La variable n'a donc PAS été scellée au build, et la console appellerait une autre adresse que celle\n"
    + 'annoncée, sans le dire. Vérifie que NEXT_PUBLIC_API_URL est bien passée à `npm run build`.',
  );
  process.exit(1);
}

console.log(`OK : « ${attendue} » est scellée dans le bundle (${porteur.replace(process.cwd(), '.')}).`);
