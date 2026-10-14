import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * LE BOUTON DE DÉPLOIEMENT DE SCALEWAY, ET CE QU'IL N'A PAS LE DROIT DE DEVENIR (docs/ARCHITECTURE-CIBLE.md §10 bis).
 *
 * 🔴 LE DÉPÔT EST PUBLIC. Un déclencheur `push` ferait partir la production à chaque commit, avant sa relecture et avant
 * sa migration ; un `pull_request` ferait tourner le workflow sur le code d'un inconnu. Julien a décidé le 2026-10-14
 * qu'un déploiement se lance à la main et attend son approbation.
 *
 * 🔴 LES SECRETS DE PRODUCTION NE PASSENT JAMAIS PAR GITHUB (même décision, §13 point 18). Le workflow ne connaît que la
 * clé du registre et du conteneur, et celle du bastion ; un `secrets.ENCRYPTION_KEY` ajouté « pour simplifier »
 * casserait cette promesse sans que rien d'autre ne le voie.
 *
 * ⚠️ Ce test lit le TEXTE du workflow et du compose, comme `tests/ci-decoupage.test.ts` : c'est lui que GitHub et
 * Docker exécutent, et aucune bibliothèque YAML n'est une dépendance directe du dépôt.
 */

const RACINE = resolve(__dirname, '..');
const WORKFLOW = readFileSync(resolve(RACINE, '.github/workflows/deploy-scaleway.yml'), 'utf8');
const COMPOSE_SCALEWAY = readFileSync(resolve(RACINE, 'ops/scaleway/docker-compose.workers.yml'), 'utf8');
const COMPOSE_VPS = readFileSync(resolve(RACINE, 'docker-compose.yml'), 'utf8');

/** Le bloc d'une clé de PREMIER niveau (`nom:` en colonne 0), jusqu'à la clé de premier niveau suivante. */
function blocRacine(yml: string, nom: string): string {
  const lignes = yml.split('\n');
  const debut = lignes.findIndex((l) => l.startsWith(`${nom}:`));
  if (debut < 0) return '';
  const fin = lignes.findIndex((l, i) => i > debut && /^[a-zA-Z]/.test(l));
  return lignes.slice(debut, fin < 0 ? undefined : fin).join('\n');
}

/** Le bloc d'un job ou d'un service : la clé à DEUX espaces d'indentation, jusqu'à la clé suivante du même niveau. */
function blocNiveau2(yml: string, nom: string): string {
  const lignes = yml.split('\n');
  const debut = lignes.findIndex((l) => l === `  ${nom}:`);
  if (debut < 0) return '';
  const fin = lignes.findIndex((l, i) => i > debut && (/^ {2}[a-z]/.test(l) || /^[a-zA-Z]/.test(l)));
  return lignes.slice(debut, fin < 0 ? undefined : fin).join('\n');
}

/** Les valeurs `NOM: "x"` ou `NOM: x` d'un bloc. */
function valeur(bloc: string, nom: string): string | undefined {
  return new RegExp(`^\\s+${nom}:\\s*"?([^"\\n]+?)"?\\s*$`, 'm').exec(bloc)?.[1];
}

describe('le workflow de déploiement Scaleway', () => {
  it('🔴 ne se déclenche QU’À LA MAIN : aucun push, aucune pull request, aucune minuterie', () => {
    const declencheurs = blocRacine(WORKFLOW, 'on').split('\n')
      .map((l) => /^ {2}([a-z_]+):/.exec(l)?.[1])
      .filter((n): n is string => Boolean(n));
    expect(declencheurs).toEqual(['workflow_dispatch']);
  });

  it('🔴 ne demande que la LECTURE du dépôt', () => {
    expect(blocRacine(WORKFLOW, 'permissions').trim()).toBe('permissions:\n  contents: read');
    expect(WORKFLOW).not.toMatch(/:\s*write\b/);
  });

  it('🔴 le job qui voit les secrets attend l’approbation de l’environnement `production`', () => {
    expect(blocNiveau2(WORKFLOW, 'deployer')).toMatch(/^ {4}environment: production$/m);
  });

  it('🔴 le job qui exécute le code tiers (la construction) ne voit AUCUN secret', () => {
    const construire = blocNiveau2(WORKFLOW, 'construire');
    expect(construire).not.toBe('');
    expect(construire).not.toMatch(/secrets\./);
  });

  it('🔴 aucun secret de production : seulement la clé du registre et du conteneur, et celle du bastion', () => {
    const secrets = [...new Set([...WORKFLOW.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
    // L'égalité, et non l'inclusion : une liste vide passerait une inclusion sans rien prouver.
    expect(secrets).toEqual(['DEPLOY_SSH_KEY', 'SCW_SECRET_KEY']);
  });

  it('🔴 ne déploie qu’un commit de l’histoire de `main`, sur le dépôt public', () => {
    expect(blocNiveau2(WORKFLOW, 'construire')).toMatch(/git merge-base --is-ancestor HEAD origin\/main/);
  });

  it('🔴 la sortie de `migrate` ne remonte JAMAIS en clair dans le journal public : elle reste sur la machine', () => {
    // Le journal d'un workflow d'un dépôt public est lisible par tous, et une migration qui échoue sur des données
    // réelles imprime l'erreur entière de Postgres, `detail` compris (relecture du lot 3, le 2026-10-14).
    const appels = WORKFLOW.split('\n').filter((l) => l.includes('npm run migrate'));
    expect(appels.length, 'une migration avant, une après').toBe(2);
    for (const ligne of appels) {
      expect(ligne).toMatch(/npm run migrate > \/root\/migrate-\$SHA\.log 2>&1;/);
      expect(ligne).toMatch(/umask 077;/);
      // `-o`, et une ligne `->` coupée après son issue : Postgres colle le MESSAGE de l'erreur à la suite de
      // `-> fichier ... `, et un message comme « invalid input syntax for type bigint: "336…" » porte la valeur.
      expect(ligne).toContain("grep -oE '^-> [^ ]+( \\(hors transaction\\))? \\.\\.\\. (ok|ECHEC)?|");
    }
  });

  it('🔴 la migration se CHOISIT à chaque lancement : le menu s’ouvre sur « choisir », que la construction refuse', () => {
    // Décision de Julien du 2026-10-14 : un oubli de migration « avant » rejouerait la panne du 2026-08-17.
    const entrees = blocRacine(WORKFLOW, 'on');
    expect(entrees).toMatch(/options: \[choisir, aucune, avant, apres\]/);
    expect(/migration:[\s\S]*?default: (\w+)/.exec(entrees)?.[1]).toBe('choisir');
    const construire = blocNiveau2(WORKFLOW, 'construire');
    expect(construire).toMatch(/^ {6}MIGRATION: \$\{\{ inputs\.migration \}\}$/m);
    expect(construire).toMatch(/^ {12}aucune\|avant\|apres\) echo "migration : \$MIGRATION" ;;$/m);
    expect(construire).toMatch(/^ {12}\*\) echo "::error::choisis la migration[^\n]*exit 1 ;;$/m);
  });
});

describe('le compose de la machine des workers', () => {
  it('🔴 tire son image du registre privé, au SHA déployé, et ne construit rien sur la machine', () => {
    expect(COMPOSE_SCALEWAY).not.toMatch(/^\s+build:/m);
    for (const service of ['mba-worker', 'mba-worker-analyse']) {
      expect(blocNiveau2(COMPOSE_SCALEWAY, service), service)
        .toMatch(/^ {4}image: rg\.fr-par\.scw\.cloud\/messagingme\/mba:\$\{IMAGE_TAG:\?/m);
    }
  });

  it('⚠️ les deux rôles, avec les tailles de pool du VPS tant que le lot 4 ne les a pas recalculées', () => {
    // Deux fichiers qui portent les mêmes nombres dérivent dès que l'un bouge seul : ce cas casse le jour où le
    // budget du VPS change sans celui de Scaleway, et se réécrit le jour où le lot 4 pose ceux de Scaleway.
    for (const service of ['mba-worker', 'mba-worker-analyse']) {
      const scaleway = blocNiveau2(COMPOSE_SCALEWAY, service);
      const vps = blocNiveau2(COMPOSE_VPS, service);
      expect(vps, `${service} dans docker-compose.yml`).not.toBe('');
      for (const cle of ['WORKER_ROLE', 'DB_POOL_MAX', 'PGBOSS_MAX']) {
        expect(valeur(scaleway, cle), `${service} ${cle}`).toBe(valeur(vps, cle));
      }
    }
  });
});
