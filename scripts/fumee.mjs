#!/usr/bin/env node
/**
 * Contrôle de fumée APRÈS déploiement, sur les adresses PUBLIQUES.
 *
 * 🔴 POURQUOI IL EXISTE. Le 502 par IP périmée de NPM est INTERMITTENT : absent au premier déploiement de la
 * journée, présent au second, sur exactement la même commande (vécu le 2026-09-07). Un conteneur `healthy`
 * et un appel interne en 200 ne prouvent donc rien de ce que voit un client. Le contrôle public est
 * obligatoire après CHAQUE déploiement, et un contrôle qui dépend de la mémoire de l'opérateur finit par
 * sauter précisément le jour où il servait.
 *
 * 🔴 ET IL PORTE LES BONS CHEMINS. Sur un hôte à routage par chemin, une URL servie par un AUTRE conteneur
 * rend 404 et ressemble à une panne qui n'existe pas ; à l'inverse, contrôler seulement la racine laisse
 * passer une API cassée. Les chemins ci-dessous sont ceux qui portent vraiment quelque chose, webhook Meta
 * compris : c'est LUI qui reçoit les messages des clients, et il traverse le routage le plus fragile.
 *
 * Usage : node scripts/fumee.mjs
 * Sortie non nulle si un seul contrôle échoue.
 */

/**
 * `attendu` est une LISTE de codes acceptables, pas un seul.
 *
 * ⚠️ Le webhook répond 403 sans jeton de vérification, et c'est le BON résultat : il prouve à la fois qu'il
 * est joignable ET que sa garde est active. Exiger 200 le ferait échouer en permanence ; n'exiger « pas 502 »
 * laisserait passer une route disparue en 404.
 */
const CONTROLES = [
  { url: 'https://api.messagingme.app/health', attendu: [200], quoi: "l'API par son nom propre" },
  { url: 'https://api.messagingme.app/webhooks/meta', attendu: [403], quoi: 'le webhook Meta sur api.' },
  { url: 'https://mba.messagingme.app/api/backend/health', attendu: [200], quoi: "l'API par le routage historique" },
  { url: 'https://mba.messagingme.app/api/backend/webhooks/meta', attendu: [403], quoi: 'le webhook Meta À SON ADRESSE ACTUELLE, celle que Meta appelle' },
  { url: 'https://mba.messagingme.app/', attendu: [200], quoi: "l'ancienne console" },
  { url: 'https://engageme.messagingme.app/', attendu: [200, 401, 307, 308], quoi: 'la console Vercel' },
];

const DELAI_MS = 20_000;

async function code(url) {
  const abandon = AbortSignal.timeout(DELAI_MS);
  try {
    // `redirect: manual` : une redirection est une REPONSE, et sur `engageme.` c'en est une legitime
    // (renvoi vers la connexion). La suivre masquerait le code qu'on veut justement observer.
    const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: abandon });
    return res.status;
  } catch (err) {
    return `injoignable (${err instanceof Error ? err.message : err})`;
  }
}

/**
 * ⚠️ UNE SEULE REPRISE, ET ELLE N'EST PAS DE LA COMPLAISANCE. Mesuré deux fois le 2026-09-08 : juste après
 * un `reload`, nginx met quelques secondes à servir la nouvelle adresse, et le contrôle lancé dans la
 * foulée rend des 502 qui disparaissent au passage suivant. Un contrôle qui crie au loup finit par être
 * ignoré, ce qui coûte plus cher que le défaut qu'il cherche. Une reprise, pas dix : au-delà, on ne
 * mesurerait plus une panne mais notre patience.
 */
const REPRISES = 1;
const ATTENTE_MS = 8000;

async function passe() {
  return Promise.all(CONTROLES.map(async (c) => ({ ...c, obtenu: await code(c.url) })));
}
const acceptable = (r) => typeof r.obtenu === 'number' && r.attendu.includes(r.obtenu);

let resultats = await passe();
for (let i = 0; i < REPRISES && resultats.some((r) => !acceptable(r)); i += 1) {
  console.log(`Des chemins ne répondent pas encore, seconde lecture dans ${ATTENTE_MS / 1000} s...`);
  await new Promise((r) => setTimeout(r, ATTENTE_MS));
  resultats = await passe();
}

let echecs = 0;
for (const r of resultats) {
  const ok = acceptable(r);
  if (!ok) echecs += 1;
  console.log(`${ok ? 'OK  ' : 'KO  '}${String(r.obtenu).padEnd(12)} ${r.url}  (${r.quoi})`);
}

if (echecs > 0) {
  console.error(
    `\n${echecs} contrôle(s) en échec.\n`
    + "Un 502 alors que le conteneur est sain veut dire que NPM tient l'ANCIENNE IP : recréer un conteneur lui\n"
    + "en donne une nouvelle, et nginx a résolu son amont au CHARGEMENT de sa config. `docker network connect`\n"
    + "ne répare PAS ça (le conteneur est déjà sur le bon réseau, la commande ne fait rien, et c'est ce qui\n"
    + 'fait chercher du côté de l\'app). Le remède :\n'
    + '  sudo docker exec mcp-robot_nginx-proxy-manager_1 nginx -s reload\n',
  );
  process.exit(1);
}
console.log('\nTous les chemins publics répondent comme attendu.');
