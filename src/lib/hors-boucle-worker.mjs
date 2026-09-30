// Le worker de `hors-boucle.ts` : à chaque message, appelle une fonction d'un module TypeScript du dépôt et poste son
// résultat en JSON. Il vit le temps d'un lecteur, qui le tue quand son travail finit ; le lecteur n'envoie jamais un
// message avant d'avoir reçu la réponse du précédent.
// En JavaScript, et il enregistre tsx lui-même : il hérite bien du `--import` de tsx, mais sous Node 22 celui-ci
// n'enregistre pas ses hooks hors du fil principal, et sous vitest il n'y en a aucun.
import { parentPort } from 'node:worker_threads';
import { register } from 'tsx/esm/api';

register();
parentPort.on('message', async ({ module, fonction, args }) => {
  try {
    const f = (await import(module))[fonction];
    // Un `Buffer` traverse le clonage en simple `Uint8Array` : les fonctions lues ici attendent un `Buffer`.
    const entree = args.map((a) => (a instanceof Uint8Array && !Buffer.isBuffer(a) ? Buffer.from(a.buffer, a.byteOffset, a.byteLength) : a));
    const resultat = await f(...entree);
    parentPort.postMessage({ json: JSON.stringify(resultat) });
  } catch (e) {
    parentPort.postMessage({
      erreur: { message: e instanceof Error ? e.message : String(e), statusCode: e?.statusCode, pile: e instanceof Error ? e.stack : undefined },
    });
  }
});
