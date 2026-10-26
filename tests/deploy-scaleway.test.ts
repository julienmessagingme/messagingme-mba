import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { schema } from '../src/config';
import { ECRITURES_EN_VOL } from '../src/api/contacts-upsert';

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

  it('⚠️ une erreur du conteneur ne compte que sur la NOUVELLE image', () => {
    // L'image provisoire du premier déploiement, ou une version cassée qu'on remplace, peut rester affichée en erreur
    // le temps que la mise à jour parte : s'arrêter là ferait échouer le déploiement même qui la répare.
    expect(etape('L\'API passe sur la nouvelle image'))
      .toMatch(/error\) if \[ "\$image" = "\$cible" \] && \{ \[ -n "\$en_cours" \] \|\| \[ "\$i" -ge 6 \]; \}; then/);
  });

  it('🔴 la taille DÉCLARÉE du conteneur part avec l’image, et ses variables COMPLÈTENT celles posées sans les remplacer', () => {
    // Un PATCH des seules variables déclarées effacerait celles que pose le script de Julien (dont l'adresse de la
    // base) : l'API repartirait sans sa configuration. Et tout PATCH redéploie, même à valeurs identiques (mesuré le
    // 2026-10-15) : l'image et la taille partent en un seul appel, sans `/redeploy` qui se heurterait au déploiement.
    const api = etape('L\'API passe sur la nouvelle image');
    expect(api).toContain('conteneur-api.json');
    expect(api).toContain('($actuel.environment_variables // {}) + .environment_variables');
    expect(api).toContain('appel -X PATCH -d "$corps" "$api"');
    expect(api).not.toContain('/redeploy');
    expect(etape('Ranger l\'image et le compose des workers')).toContain('ops/scaleway/conteneur-api.json livraison/');
    // Et le conteneur prêt se RELIT contre le fichier : sans cela, « le test lit ce que la production reçoit » serait
    // une promesse, pas une vérification.
    expect(api).toContain('--argjson reel "$reponse"');
    expect(api).toContain('le conteneur ne porte pas la taille declaree');
  });

  it('⚠️ la clé SSH et les empreintes perdent leurs retours chariot, et la connexion muette reste ouverte', () => {
    const ssh = etape('Ouvrir le chemin SSH, par le bastion de la passerelle');
    expect(ssh).toContain(`printf '%s\\n' "$CLE_SSH" | tr -d '\\r' > ~/.ssh/deploiement`);
    expect(ssh).toContain(`printf '%s\\n' "$CONNUS" | tr -d '\\r' > ~/.ssh/known_hosts`);
    expect(ssh).toMatch(/ServerAliveInterval 30/);
    expect(ssh.match(/StrictHostKeyChecking yes/g)?.length).toBe(2);
  });

  // Les deux programmes `jq` du bastion, tels que le workflow les porte : exigés en texte ici, EXÉCUTÉS plus bas.
  const PRESENTE = '(.bastion_allowed_ips | type) == "array" and (.bastion_allowed_ips | index($r) != null)';
  const ABSENTE = '(.bastion_allowed_ips | type) == "array" and (.bastion_allowed_ips | index($r) == null)';

  it('🔴 le bastion ne s’ouvre à ce runner que le temps du déploiement, et sa liste n’est jamais remplacée', () => {
    // Décision de Julien du 2026-10-26 : la liste du bastion porte son poste en permanence. Un PUT la remplacerait et
    // l'effacerait, sous quelque forme qu'il soit écrit ; retirer une adresse que ce workflow n'a pas retenue aussi.
    const code = WORKFLOW.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code).not.toMatch(/(-X|--request)\s+PUT\b/);
    expect(code.match(/-X DELETE/g)?.length).toBe(1);
    const ouvrir = etape('Ouvrir le bastion a l\'adresse de ce runner');
    expect(ouvrir).toMatch(/^ {8}id: bastion$/m);
    // La voie inerte : sans la variable, rien n'est appelé.
    expect(ouvrir).toContain('if [ -z "$PASSERELLE" ]; then echo "SCALEWAY_GATEWAY_ID absente');
    // 🔴 `ajoutee` s'écrit AVANT l'ajout (relecture du 2026-10-26) : un ajout pris chez Scaleway mais vu en échec ici
    // (délai dépassé, 502) laisserait sinon l'adresse ouverte, la fermeture sautée. L'ajout ne se rejoue pas, et se
    // RELIT ensuite.
    const retenue = ouvrir.indexOf('echo "ajoutee=$ip/32" >> "$GITHUB_OUTPUT"');
    const ajout = ouvrir.indexOf('-X POST');
    expect(retenue).toBeGreaterThan(0);
    expect(ajout).toBeGreaterThan(retenue);
    expect(ouvrir.split('\n').find((l) => l.includes('-X POST'))).not.toContain('--retry');
    expect(ouvrir.indexOf(PRESENTE, ajout)).toBeGreaterThan(ajout);
    expect(WORKFLOW.indexOf('- name: Ouvrir le bastion a l\'adresse de ce runner'))
      .toBeLessThan(WORKFLOW.indexOf('- name: Ouvrir le chemin SSH, par le bastion de la passerelle'));
    // La première connexion attend que la passerelle applique sa liste.
    expect(etape('Ouvrir le chemin SSH, par le bastion de la passerelle'))
      .toContain('ssh -o ConnectTimeout=10 -o BatchMode=yes workers true');
    // Le retrait : la DERNIÈRE étape (aucune autre après, `uses:` compris), même sur un échec ou une annulation, de
    // l'adresse retenue et d'elle seule, un 404 valant « déjà absente », puis la liste relue.
    const fermer = etape('Refermer le bastion');
    expect(fermer).toMatch(/^ {8}if: always\(\) && steps\.bastion\.outputs\.ajoutee != ''$/m);
    expect(fermer).toContain('AJOUTEE: ${{ steps.bastion.outputs.ajoutee }}');
    expect(fermer).toContain('"$api/bastion-allowed-ips/${AJOUTEE%/*}%2F32"');
    expect(fermer).toContain('2??|404) retire=1; break ;;');
    expect(fermer).toContain(ABSENTE);
    expect(WORKFLOW.lastIndexOf('\n      - ')).toBe(WORKFLOW.indexOf('\n      - name: Refermer le bastion'));
  });

  it('🔴 la passerelle lue ne s’imprime jamais dans le journal public : elle porte l’adresse permanente', () => {
    for (const nom of ['Ouvrir le bastion a l\'adresse de ce runner', 'Refermer le bastion']) {
      const e = etape(nom);
      expect(e).not.toBe('');
      expect(e).not.toMatch(/echo[^\n]*\$passerelle/);
      expect(e).not.toContain('--fail-with-body');
    }
  });

  const jqLa = spawnSync('jq', ['--version']).status === 0;
  it.skipIf(!jqLa)('🔴 les programmes jq du bastion, exécutés : un champ absent ne vaut ni « présente » ni « absente »', () => {
    const verdict = (programme: string, corps: unknown) =>
      spawnSync('jq', ['-e', '--arg', 'r', '1.2.3.4/32', programme], { input: JSON.stringify(corps), encoding: 'utf8' }).status;
    const avec = { bastion_allowed_ips: ['0.0.0.0/0', '1.2.3.4/32'] };
    const sans = { bastion_allowed_ips: ['0.0.0.0/0'] };
    expect(verdict(PRESENTE, avec)).toBe(0);
    expect(verdict(PRESENTE, sans)).not.toBe(0);
    expect(verdict(ABSENTE, sans)).toBe(0);
    expect(verdict(ABSENTE, avec)).not.toBe(0);
    // Le défaut relevé en relecture : sans le champ, `null | index($r)` rendait « absente », donc « bastion referme »
    // sans rien avoir vérifié.
    expect(verdict(PRESENTE, {})).not.toBe(0);
    expect(verdict(ABSENTE, {})).not.toBe(0);
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
    // L'API `v1` : un PATCH qui porte `image` et la taille déclarée. L'ancienne version bêta portait d'autres noms de
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
    for (const service of ['mba-worker', 'mba-worker-analyse', 'mba-application']) {
      expect(blocNiveau2(COMPOSE_SCALEWAY, service), service)
        .toContain(`    image: ${registre}/mba:\${IMAGE_TAG:?`);
    }
  });

  it('⚠️ les journaux de chaque worker tournent : le pilote json-file les garderait sans fin', () => {
    for (const service of ['mba-worker', 'mba-worker-analyse', 'mba-application']) {
      const bloc = blocNiveau2(COMPOSE_SCALEWAY, service);
      expect(bloc, service).toMatch(/^ {6}driver: json-file$/m);
      expect(valeur(bloc, 'max-size'), service).toBe('10m');
      expect(valeur(bloc, 'max-file'), service).toBe('5');
    }
  });

  it('🔴 chaque service porte une limite de mémoire et de processeur, la même sur le VPS et chez Scaleway', () => {
    // Lot 2b : la condition pour que les services partagent une machine (docs/ARCHITECTURE-CIBLE.md §2). Sans
    // limite, une fuite de l'un emporte l'autre ; des limites différentes des deux côtés ne seraient plus éprouvées.
    for (const service of ['mba-worker', 'mba-worker-analyse', 'mba-application']) {
      const vps = blocNiveau2(COMPOSE_VPS, service);
      const scaleway = blocNiveau2(COMPOSE_SCALEWAY, service);
      expect(valeur(vps, 'mem_limit'), `${service} mem_limit (VPS)`).toMatch(/^\d+[mg]$/);
      expect(Number(valeur(vps, 'cpus')), `${service} cpus (VPS)`).toBeGreaterThan(0);
      expect(valeur(scaleway, 'mem_limit'), `${service} mem_limit`).toBe(valeur(vps, 'mem_limit'));
      expect(valeur(scaleway, 'cpus'), `${service} cpus`).toBe(valeur(vps, 'cpus'));
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

/**
 * LE CONTENEUR DE L'API CHEZ SCALEWAY ET LE BUDGET DE CONNEXIONS (§ 7.5 de `docs/ARCHITECTURE-CIBLE.md`, plan du
 * 2026-10-15). Sans pooler devant la base, chaque copie d'API ouvre ses pools en connexions RÉELLES : au pire, pendant
 * un déploiement, deux versions de toutes les copies que l'autoscaler peut allumer, pleines, plus les workers, plus la
 * marge, doivent tenir dans la base.
 */
describe('le conteneur de l’API chez Scaleway et le budget de connexions', () => {
  const CONTENEUR = JSON.parse(lire('ops/scaleway/conteneur-api.json'));
  const env = CONTENEUR.environment_variables as Record<string, string>;
  /** Relus à la création de la base de production `mm-prod-db` (DB-PRO2-XXS), le 2026-10-15. */
  const MAX_CONNECTIONS = 200;
  const RESERVEES_SUPERUTILISATEUR = 3;
  /** Migrations, sondes, sauvegardes et console d'administration. */
  const MARGE = 10;
  // TOUS les services du compose de la machine comptent, pas seulement ceux qu'on connaît aujourd'hui. Un worker : son
  // pool, son pg-boss, et une connexion d'écoute des notifications. Le service de connexions de la filière application :
  // son pool seul, qu'il prête à pg-boss pour empiler, comme l'API.
  const SERVICES = [...blocRacine(COMPOSE_SCALEWAY, 'services').matchAll(/^ {2}([a-z0-9-]+):$/gm)].map((m) => m[1]!);
  const estConnexions = (bloc: string) => /^\s+command:.*src\/application\/service\.ts/m.test(bloc);
  const workers = SERVICES.reduce((n, s) => {
    const bloc = blocNiveau2(COMPOSE_SCALEWAY, s);
    if (estConnexions(bloc)) return n + Number(valeur(bloc, 'DB_POOL_MAX'));
    return n + Number(valeur(bloc, 'DB_POOL_MAX')) + Number(valeur(bloc, 'PGBOSS_MAX')) + 1;
  }, 0);
  // Une copie d'API : son pool applicatif (qui porte aussi ses enfilements) et celui de la réception de Meta.
  const parCopie = Number(env.DB_POOL_MAX) + Number(env.DB_POOL_RECEPTION_MAX);

  it('🔴 chaque service de la machine déclare ses pools, et tous entrent au budget', () => {
    expect(SERVICES).toEqual(expect.arrayContaining(['mba-worker', 'mba-worker-analyse', 'mba-application']));
    for (const s of SERVICES) {
      const bloc = blocNiveau2(COMPOSE_SCALEWAY, s);
      expect(valeur(bloc, 'DB_POOL_MAX'), `${s} sans DB_POOL_MAX`).toBeDefined();
      // Le service de connexions n'ouvre pas de pg-boss : le déclarer laisserait croire qu'il compte.
      if (estConnexions(bloc)) expect(valeur(bloc, 'PGBOSS_MAX'), s).toBeUndefined();
      else expect(valeur(bloc, 'PGBOSS_MAX'), `${s} sans PGBOSS_MAX`).toBeDefined();
    }
    // Le pool du service de connexions reprend celui du VPS, comme ceux des workers.
    expect(valeur(blocNiveau2(COMPOSE_SCALEWAY, 'mba-application'), 'DB_POOL_MAX'))
      .toBe(valeur(blocNiveau2(COMPOSE_VPS, 'mba-application'), 'DB_POOL_MAX'));
  });

  it('🔴 le pire cas tient dans la base PENDANT un déploiement : deux versions pleines, les workers, la marge', () => {
    // Pendant une mise à jour, l'ancienne version sert jusqu'à ce que la nouvelle soit prête (Scaleway, « Concepts »),
    // et rien ne dit que `max_scale` borne la somme des deux : le pire cas compte DEUX fois les copies. Il en permet 6.
    const total = 2 * CONTENEUR.max_scale * parCopie + workers + MARGE;
    expect(total, `2 x ${CONTENEUR.max_scale} copies x ${parCopie} + ${workers} (workers) + ${MARGE} (marge)`)
      .toBeLessThanOrEqual(MAX_CONNECTIONS - RESERVEES_SUPERUTILISATEUR);
  });

  it('🔴 une copie toujours allumée, et ses pools tiennent la console comme la réception de Meta', () => {
    // Un minimum à 0 ferait attendre le démarrage (plusieurs secondes, `tsx`) au premier webhook après un silence.
    expect(CONTENEUR.min_scale).toBeGreaterThanOrEqual(1);
    expect(CONTENEUR.max_scale).toBeGreaterThanOrEqual(CONTENEUR.min_scale);
    // Même règle que sur le VPS (`tests/budget-pooler.test.ts`) : un lot lourd ne doit pas prendre tout le pool.
    expect(Number(env.DB_POOL_MAX)).toBeGreaterThan(ECRITURES_EN_VOL * schema.shape.API_MAX_LOURDES_SIMULTANEES.parse(undefined));
    expect(Number(env.DB_POOL_RECEPTION_MAX)).toBeGreaterThanOrEqual(4);
    // Un nom fixe fondrait les attentes de pool de toutes les copies dans une seule courbe de `/ops` (lot 2c).
    expect(env.API_COPIE).toBe('auto');
  });

  it('⚠️ la sonde de vie interroge l’application, pas seulement son port, avec tous ses réglages', () => {
    // Une sonde TCP dit « prêt » dès que le port s'ouvre, même quand l'application ne répond pas. Et une sonde à qui il
    // manque un réglage est gardée par défaut, en silence (`DEPLOY.md`).
    expect(CONTENEUR.liveness_probe.http?.path).toBe('/live');
    expect(CONTENEUR.liveness_probe.tcp).toBeUndefined();
    for (const r of ['failure_threshold', 'interval', 'timeout']) expect(CONTENEUR.liveness_probe[r], r).toBeDefined();
  });

  it('🔴 le fichier ne porte ni secret ni réglage propre à un environnement : le dépôt est public', () => {
    // Le jq du workflow envoie le fichier ENTIER dans le PATCH : une clé de plus partirait telle quelle. Et l'adresse
    // de la base et son certificat (`DB_SSL_CA_FILE`) changent d'un environnement à l'autre : ils restent au script.
    expect(Object.keys(CONTENEUR).sort()).toEqual(['environment_variables', 'liveness_probe', 'max_scale',
      'memory_limit_bytes', 'min_scale', 'mvcpu_limit', 'scaling_option']);
    expect(Object.keys(env).sort()).toEqual(['API_COPIE', 'API_PLAFOND_GLOBAL_PAR_10S', 'DB_POOL_MAX', 'DB_POOL_RECEPTION_MAX']);
  });

  it('⚠️ le certificat de la base de production entre dans l’image, sans clé, valable pour son adresse', () => {
    const pem = lire('certs/scaleway-mm-prod.crt');
    expect(pem).not.toMatch(/PRIVATE KEY/);
    const certificat = new X509Certificate(pem);
    expect(certificat.checkIP('172.16.0.8')).toBe('172.16.0.8');
    expect(Date.parse(certificat.validTo) - Date.now(), 'certificat de mm-prod-db à renouveler (rdb instance get-certificate)')
      .toBeGreaterThan(365 * 24 * 3600 * 1000);
  });

  // Les deux programmes jq du workflow, EXÉCUTÉS tels que GitHub les lance (jq est sur le runner de la CI ; absent d'un
  // poste Windows, ces deux cas s'y sautent). Un opérande inversé passerait une recherche de texte, pas ceci.
  const jqPresent = spawnSync('jq', ['--version']).status === 0;
  const programme = (motif: RegExp) => motif.exec(etape('L\'API passe sur la nouvelle image'))?.[1] ?? '';
  const jq = (args: string[]) => spawnSync('jq', args, { input: lire('ops/scaleway/conteneur-api.json'), encoding: 'utf8' });

  it.skipIf(!jqPresent)('🔴 la fusion, exécutée : les variables posées ailleurs survivent, le fichier l’emporte, rien de secret ne repart', () => {
    const fusion = programme(/--arg image "\$cible" \\\n\s+'([^']+)'/);
    expect(fusion).not.toBe('');
    const actuel = { image: 'ancienne', environment_variables: { DB_SSL_CA_FILE: '/app/certs/x.crt', DB_POOL_MAX: '8' },
      secret_environment_variables: [{ key: 'DATABASE_URL', hashed_value: 'h' }] };
    const r = jq(['-c', '--argjson', 'actuel', JSON.stringify(actuel), '--arg', 'image', 'neuve', fusion]);
    expect(r.status, r.stderr).toBe(0);
    const corps = JSON.parse(r.stdout);
    expect(corps.image).toBe('neuve');
    expect(corps.environment_variables.DB_SSL_CA_FILE).toBe('/app/certs/x.crt');
    expect(corps.environment_variables.DB_POOL_MAX).toBe(env.DB_POOL_MAX);
    expect(corps.secret_environment_variables).toBeUndefined();
  });

  it.skipIf(!jqPresent)('🔴 la relecture, exécutée : conforme si le conteneur porte le fichier, non conforme sinon', () => {
    const relecture = programme(/--argjson reel "\$reponse" '([^']+)' conteneur-api\.json/);
    expect(relecture).not.toBe('');
    const juge = (reel: unknown) => jq(['-r', '--argjson', 'reel', JSON.stringify(reel), relecture]).stdout.trim();
    const porte = { ...CONTENEUR, environment_variables: { ...env, NODE_ENV: 'production' } };
    expect(juge(porte)).toBe('true');
    expect(juge({ ...porte, min_scale: 0 })).toBe('false');
    expect(juge({ ...porte, environment_variables: { ...porte.environment_variables, DB_POOL_MAX: '8' } })).toBe('false');
  });
});
