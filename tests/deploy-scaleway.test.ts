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
 * Docker exécutent, et aucune bibliothèque YAML n'est une dépendance directe du dépôt. Les fins de ligne sont
 * ramenées à `\n` : une extraction Windows en `\r\n` ferait sinon échouer chaque comparaison de ligne entière.
 */

const RACINE = resolve(__dirname, '..');
const lire = (chemin: string) => readFileSync(resolve(RACINE, chemin), 'utf8').replace(/\r\n/g, '\n');
const WORKFLOW = lire('.github/workflows/deploy-scaleway.yml');
const COMPOSE_SCALEWAY = lire('ops/scaleway/docker-compose.workers.yml');
const COMPOSE_VPS = lire('docker-compose.yml');
const WORKER = lire('src/worker.ts');

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

/** Le bloc `run` d'une étape, repérée par son nom exact. */
function etape(nom: string): string {
  const debut = WORKFLOW.indexOf(`- name: ${nom}\n`);
  if (debut < 0) return '';
  const suite = WORKFLOW.indexOf('\n      - ', debut + 1);
  return WORKFLOW.slice(debut, suite < 0 ? undefined : suite);
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

  // 🔴 Pas `production` : GitHub ne distingue pas la casse des noms d'environnement, et `Production` existe déjà dans
  // ce dépôt, créé par Vercel le 2026-09-03, sans aucune règle de protection (l'API le rend quand on lui demande
  // `production`, mesuré le 2026-10-14). Le job y partirait sans l'approbation de Julien, sans erreur ni avertissement.
  it('🔴 le job qui voit les secrets attend l’approbation de l’environnement `scaleway`', () => {
    expect(blocNiveau2(WORKFLOW, 'deployer')).toMatch(/^ {4}environment: scaleway$/m);
  });

  it('🔴 le job qui exécute le code tiers (la construction) ne voit AUCUN secret', () => {
    const construire = blocNiveau2(WORKFLOW, 'construire');
    expect(construire).not.toBe('');
    expect(construire).not.toMatch(/secrets\b/);
  });

  it('🔴 aucun secret de production : seulement la clé du registre et du conteneur, et celle du bastion', () => {
    const secrets = [...new Set([...WORKFLOW.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
    // L'égalité, et non l'inclusion : une liste vide passerait une inclusion sans rien prouver.
    expect(secrets).toEqual(['DEPLOY_SSH_KEY', 'SCW_SECRET_KEY']);
    // Les deux autres façons de nommer un secret, que le motif ci-dessus ne verrait pas : par crochets, ou tous à la
    // fois (`toJSON(secrets)` livrerait au job chaque secret du dépôt et de l'environnement).
    expect(WORKFLOW).not.toMatch(/secrets\s*\[/);
    expect(WORKFLOW).not.toMatch(/toJSON\(\s*secrets/);
    // Et seulement dans le job qui déploie.
    const partout = WORKFLOW.match(/secrets\./g)?.length ?? 0;
    expect(blocNiveau2(WORKFLOW, 'deployer').match(/secrets\./g)?.length ?? 0).toBe(partout);
  });

  it('🔴 ne déploie qu’un commit de l’histoire de `main`, sur le dépôt public', () => {
    const construire = blocNiveau2(WORKFLOW, 'construire');
    expect(construire).toMatch(/git merge-base --is-ancestor HEAD origin\/main/);
    expect(construire).toMatch(/^ {4}if: github\.ref == 'refs\/heads\/main'$/m);
    // Toute l'histoire, pour que `merge-base` puisse répondre ; et le jeton du dépôt n'est pas laissé sur le disque
    // d'un job qui exécute le `npm ci` du Dockerfile.
    expect(construire).toMatch(/^ {10}fetch-depth: 0$/m);
    expect(construire).toMatch(/^ {10}persist-credentials: false$/m);
    expect(blocNiveau2(WORKFLOW, 'deployer')).toMatch(/^ {4}needs: construire$/m);
  });

  it('🔴 chaque bloc `run` échoue sur la première commande d’un pipeline qui échoue', () => {
    // `shell: bash` nommé donne `bash -eo pipefail` ; sans lui, `docker save | gzip` qui échoue range une archive vide.
    expect(blocRacine(WORKFLOW, 'defaults').trim()).toBe('defaults:\n  run:\n    shell: bash');
    // Le regard en avant porte sur TOUT ce qui suit `shell:` : placé après un `\s*`, le retour arrière le rendrait
    // toujours vrai.
    expect(WORKFLOW).not.toMatch(/^\s+shell:(?!\s*bash\s*$)/m);
    expect(blocNiveau2(WORKFLOW, 'construire')).toMatch(/^ {10}if-no-files-found: error$/m);
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

  it('🔴 les journaux des workers ne sont jamais imprimés : seulement comptés, sortie jetée', () => {
    // Ils portent des données de clients, et le journal du workflow est public. `grep -c` et non `grep -q` : sous
    // `pipefail`, `grep -q` s'arrête au premier trouvé, coupe `docker logs`, et le pipeline échoue alors que la
    // ligne est là.
    const lectures = WORKFLOW.split('\n').filter((l) => /docker (compose )?logs\s+"?\$/.test(l));
    expect(lectures.length).toBeGreaterThan(0);
    for (const ligne of lectures) {
      expect(ligne).toMatch(/docker logs "\$id" 2>&1 \| grep -cF '[^']+' > \/dev\/null;/);
    }
  });

  it('🔴 l’API ne passe sur la nouvelle image qu’après le démarrage annoncé de chaque worker', () => {
    const workers = etape('Les workers passent sur la nouvelle image');
    // La ligne cherchée est celle que `src/worker.ts` imprime : la renommer là-bas ferait échouer chaque déploiement
    // au bout de 150 secondes, et ce cas le dit avant.
    const attendue = /grep -cF '([^']+)'/.exec(workers)?.[1];
    expect(attendue).toBe('messagingme-mba worker démarré');
    expect(WORKER).toContain(`console.log(\`${attendue} (files:`);
    expect(workers).toMatch(/for service in mba-worker mba-worker-analyse; do/);
    expect(workers).toMatch(/RestartCount/);
    expect(workers).toMatch(/docker compose up -d --remove-orphans/);
    expect(WORKFLOW.indexOf('- name: Les workers passent sur la nouvelle image'))
      .toBeLessThan(WORKFLOW.indexOf('- name: L\'API passe sur la nouvelle image'));
  });

  it('⚠️ la clé SSH et les empreintes perdent leurs retours chariot, et la connexion muette reste ouverte', () => {
    const ssh = etape('Ouvrir le chemin SSH, par le bastion de la passerelle');
    expect(ssh).toContain(`printf '%s\\n' "$CLE_SSH" | tr -d '\\r' > ~/.ssh/deploiement`);
    expect(ssh).toContain(`printf '%s\\n' "$CONNUS" | tr -d '\\r' > ~/.ssh/known_hosts`);
    expect(ssh).toMatch(/ServerAliveInterval 30/);
    expect(ssh.match(/StrictHostKeyChecking yes/g)?.length).toBe(2);
  });

  it('⚠️ le fichier de secrets de la machine est refusé s’il porte des guillemets', () => {
    // Compose (les workers) les retire, `docker run --env-file` (la migration) les garde : deux configurations.
    const garde = etape('Le fichier de secrets de la machine est present, et sans guillemets');
    expect(garde).toContain(`grep -qE "^[A-Za-z_][A-Za-z0-9_]*=[\\"']" "$f"`);
    expect(WORKFLOW.indexOf('- name: Le fichier de secrets de la machine est present'))
      .toBeLessThan(WORKFLOW.indexOf('- name: Migration avant le deploiement'));
  });

  it('🔴 le registre, l’API et la connexion au registre sont dans la MÊME région, celle du réseau privé', () => {
    // Le réseau privé et la base sont régionaux : une image poussée ou un conteneur appelé dans une autre région ne
    // les verrait pas. Amsterdam depuis le 2026-10-14 (Paris refusait toute nouvelle machine).
    const env = blocRacine(WORKFLOW, 'env');
    const region = valeur(env, 'REGION');
    expect(region).toBe('nl-ams');
    expect(valeur(env, 'REGISTRE')).toBe(`rg.${region}.scw.cloud/messagingme`);
    expect(WORKFLOW).toContain('https://api.scaleway.com/containers/v1/regions/$REGION/containers/$CONTENEUR');
    expect(WORKFLOW).toContain('docker login rg.$REGION.scw.cloud');
    // L'API `v1` : `image`, et `/redeploy` pour la même image. L'ancienne version bêta portait d'autres noms de
    // champs ; seul le CODE compte ici, pas les commentaires qui la citent.
    const code = WORKFLOW.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code).not.toMatch(/v1beta1|registry_image/);
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
  it('🔴 tire son image du registre du workflow, au SHA déployé, et ne construit rien sur la machine', () => {
    const registre = valeur(blocRacine(WORKFLOW, 'env'), 'REGISTRE');
    expect(registre).toBeTruthy();
    expect(COMPOSE_SCALEWAY).not.toMatch(/^\s+build:/m);
    for (const service of ['mba-worker', 'mba-worker-analyse']) {
      expect(blocNiveau2(COMPOSE_SCALEWAY, service), service)
        .toContain(`    image: ${registre}/mba:\${IMAGE_TAG:?`);
    }
  });

  it('⚠️ les journaux de chaque worker tournent : le pilote json-file les garderait sans fin', () => {
    for (const service of ['mba-worker', 'mba-worker-analyse']) {
      const bloc = blocNiveau2(COMPOSE_SCALEWAY, service);
      expect(bloc, service).toMatch(/^ {6}driver: json-file$/m);
      expect(valeur(bloc, 'max-size'), service).toBe('10m');
      expect(valeur(bloc, 'max-file'), service).toBe('5');
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
