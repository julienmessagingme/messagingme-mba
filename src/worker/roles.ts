import type { BASE_QUEUES } from '../queue/names';
import type { OptionsTache, RegistreDeTaches } from './taches';

/**
 * LES DEUX RÔLES DU WORKER (plan `docs/superpowers/plans/2026-10-02-deux-workers-et-banc-deux-api.md`).
 *
 * Ce n'est PAS un microservice : le même programme, la même image, le même schéma, le même pg-boss, lancé
 * avec deux responsabilités. Ce qu'on achète est l'ISOLATION, pas du débit : un appel LLM lent, un parsing
 * lourd ou un redémarrage de l'analyse ne doit pas retarder les messages entrants et les campagnes.
 *
 * 🔴 `all` EST LE DÉFAUT, ET IL REPRODUIT EXACTEMENT LE COMPORTEMENT D'AUJOURD'HUI. Un déploiement qui ne
 * pose pas `WORKER_ROLE` ne change rien, ce qui permet de livrer le code puis de découper en deux temps,
 * plutôt que de faire les deux le même soir.
 */
export type RoleWorker = 'principal' | 'analyse' | 'all';

/**
 * À qui appartient une file ou une minuterie.
 *
 * 🔴 `tous` N'EST PAS UNE FACILITÉ, C'EST UNE NÉCESSITÉ, et l'oublier serait pire que de ne pas découper.
 * Une minuterie d’INFRASTRUCTURE DU PROCESSUS (son heartbeat, les attentes de SON pool) decrit le processus
 * qui la porte : la donner a un seul role laisserait l’autre sans battement. C’est le seul cas ou `tous`
 * est juste.
 *
 * 🔴 MAIS `tous` NE SUFFIT PAS AUJOURD’HUI, ET C’EST UN BLOQUEUR DE DEPLOIEMENT DU DECOUPAGE (mesure le
 * 2026-10-03). `worker_heartbeat` est une ligne UNIQUE, `id = 'worker'` ECRIT EN DUR
 * (`src/ops/heartbeat-store.pg.ts`) : deux roles l’ecriraient tous les deux, le survivant rafraichirait la
 * ligne du mort, et `/ops` la lirait vivante. Le decoupage rendrait donc la surveillance STRICTEMENT PIRE
 * qu’aujourd’hui, ou un worker unique et une ligne unique sont honnetes. Il faut CLEFER le battement par
 * role (migration), le lire par role dans `/ops` et alerter par role, AVANT de lancer deux services.
 */
export type Appartenance = 'principal' | 'analyse' | 'tous';

type NomDeFile = (typeof BASE_QUEUES)[number];

/**
 * 🔴 LA RÈGLE DE PARTAGE EST « PAR DÉFAUT `principal` », ET `analyse` DOIT JUSTIFIER CHAQUE PRISE. Entre les
 * deux erreurs possibles, une seule se rattrape : laisser une analyse sur le principal coûte de la latence
 * d'analyse, que personne n'attend ; déplacer par erreur un chemin du produit coûte un message en retard.
 */
export const FILES_PAR_ROLE: Record<NomDeFile, Appartenance> = {
  // Ce que la production emprunte maintenant : un client attend derrière.
  webhook: 'principal',
  'webhook-status': 'principal',
  'campaign-run': 'principal',
  'automation-event': 'principal',
  'agent-turn': 'principal',
  'optout-poussee': 'principal',
  'signaux-batch': 'principal',
  // L'analyse et ce qu'elle alimente : personne n'attend derrière, et c'est ce qui appelle les modèles.
  'analyze-conversation': 'analyse',
  'push-analysis': 'analyse',
  'hubspot-catchup': 'analyse',
};

/**
 * Les minuteries, par leur nom exact passé à `taches.programmer`.
 *
 * 🔴 `agregats-analyse` RESTE SUR LE PRINCIPAL, CONTRE CE QUE L'AUDIT DU 2026-10-02 PROPOSAIT, et c'est le
 * point le plus important de ce fichier. `agregats-analyse` et `retention-conversations` se parlent par un
 * DRAPEAU EN MÉMOIRE (`agregatsAJour`, initialisé à `false`) : la purge renonce tant que les agrégats ne sont
 * pas à jour. Les séparer en deux processus mettrait ce drapeau dans deux espaces mémoire distincts, celui du
 * principal resterait `false` pour toujours, et **la purge RGPD s'arrêterait définitivement, en silence** :
 * l'alerte existante surveille l'ÉCHEC des agrégats, pas l'ABSENCE de purge. Les deux restent donc ensemble.
 * Le jour où l'analyse devra vraiment les porter, ce drapeau devra d'abord devenir un fait partagé, en base.
 */
export const TACHES_PAR_ROLE: Record<string, Appartenance> = {
  // Infrastructure du processus : chaque rôle décrit le sien (voir `Appartenance`).
  heartbeat: 'tous',
  'pool-attentes': 'tous',
  // L'analyse proprement dite.
  'analyse-conversations': 'analyse',
  'hubspot-rattrapage': 'analyse',
  // Tout le reste : le produit, ses reprises, ses purges, son exploitation.
  'agregats-analyse': 'principal',
  'retention-conversations': 'principal',
  'auto-relance-echecs': 'principal',
  'automations-avant-date': 'principal',
  'campagnes-gelees': 'principal',
  'campagnes-programmees': 'principal',
  'campagnes-reprise-plafond': 'principal',
  'compteurs-debit': 'principal',
  'files-echec': 'principal',
  'handoff-mba': 'principal',
  'idempotence-api': 'principal',
  reclaim: 'principal',
  'reprise-controle': 'principal',
  'retention-evenements-meta': 'principal',
  'retention-generale': 'principal',
  'retention-oauth': 'principal',
  'retention-payloads-webhooks': 'principal',
  'reveil-parcours': 'principal',
  'risque-desengagement': 'principal',
  'statut-numeros': 'principal',
  'suivi-pubs': 'principal',
  'tours-agent-bloques': 'principal',
  vectorisation: 'principal',
  'webhooks-muets': 'principal',
};

/** Ce rôle porte-t-il ce qui appartient à `a` ? */
export function assume(role: RoleWorker, a: Appartenance): boolean {
  return role === 'all' || a === 'tous' || a === role;
}

/**
 * Le registre de tâches du rôle : il ne programme que ce qui lui appartient.
 *
 * 🔴 UN SEUL POINT DE PASSAGE, ET C'EST TOUT L'INTÉRÊT. Filtrer aux 27 appels de `programmer` ferait 27
 * endroits où l'oublier, et la 28e minuterie ajoutée demain ne l'aurait pas. ⚠️ Une minuterie INCONNUE de la
 * table LÈVE au lieu d'être ignorée : un nom qu'on n'a pas rangé est une décision qu'on n'a pas prise, et le
 * silence la trancherait au hasard du rôle qui tourne.
 */
export function tachesDuRole(registre: RegistreDeTaches, role: RoleWorker): RegistreDeTaches {
  return {
    programmer(nom: string, intervalMs: number, passe: () => void | number | Promise<void | number>, options?: OptionsTache): void {
      if (!minuterieDuRole(nom, role)) return;
      registre.programmer(nom, intervalMs, passe, options);
    },
    arreterTout: () => registre.arreterTout(),
    noms: () => registre.noms(),
  };
}

/** Ce rôle consomme-t-il cette file ? Même exigence que ci-dessus : une file inconnue lève. */
export function fileDuRole(nom: string, role: RoleWorker): boolean {
  const a = (FILES_PAR_ROLE as Record<string, Appartenance | undefined>)[nom];
  if (a === undefined) throw new Error(`file « ${nom} » sans rôle : la ranger dans FILES_PAR_ROLE (src/worker/roles.ts)`);
  return assume(role, a);
}

/**
 * Ce rôle porte-t-il cette minuterie ? Même exigence que `fileDuRole` : un nom inconnu lève.
 *
 * 🔴 SERT AUSSI À CE QUI TOURNE HORS DU REGISTRE, et c'est la raison de son existence (relecture du 2026-10-03).
 * Le balayage d'agrégats du DÉMARRAGE n'est pas une minuterie, il est appelé une fois avant elle : le filtre de
 * `tachesDuRole` ne l'atteint donc pas, et il tournait aussi dans le rôle `analyse`, en production, où il écrivait
 * un drapeau que personne ne lit. Le garder par le NOM de la minuterie qu'il précède, et non par un rôle écrit en
 * dur, le fait suivre automatiquement le jour où la table la déplace.
 */
export function minuterieDuRole(nom: string, role: RoleWorker): boolean {
  const a = TACHES_PAR_ROLE[nom];
  if (a === undefined) throw new Error(`minuterie « ${nom} » sans rôle : la ranger dans TACHES_PAR_ROLE (src/worker/roles.ts)`);
  return assume(role, a);
}

/**
 * Le nom sous lequel ce processus se signale : les attentes de pool de `/ops` et les alertes Telegram.
 *
 * 🔴 UN NOM PAR RÔLE, sinon les deux workers fusionnent dans la même courbe d'attentes de pool, et le signal
 * « pool saturé » ne dit plus de quel processus il vient : celui de l'analyse, à 3 connexions, saturerait plus
 * souvent que le principal, et on accuserait le chemin chaud. `all` garde `worker`, le nom d'avant.
 */
/**
 * 🔴 QUI SUPERVISE LES FILES : le worker principal (ou l'unique, `all`), pas celui de l'analyse. La supervision de
 * pg-boss couvre TOUTES les files depuis n'importe quel processus (elle rejoue aussi les orphelines de l'analyse), et
 * chaque passage relit la liste entière des files : la doubler sur deux workers doublait cet egress pour rien
 * (relecture du 2026-10-04). Un principal tombé est relancé en quelques secondes (`restart: unless-stopped`).
 */
export function superviseLesFiles(role: RoleWorker): boolean {
  return role !== 'analyse';
}

export function nomDuProcessus(role: RoleWorker): string {
  return role === 'all' ? 'worker' : `worker-${role}`;
}
