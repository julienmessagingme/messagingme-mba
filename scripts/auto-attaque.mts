/**
 * AUTO-ATTAQUE : on tape sur son propre produit avec les gestes d'un attaquant.
 *
 * 🔴 CE QUE CE SCRIPT APPORTE, ET QUE LA SUITE DE TESTS N'APPORTE PAS. Les tests prouvent que chaque garde,
 * PRISE UNE PAR UNE, se comporte comme son auteur l'a voulu. Ils ne prouvent pas qu'elle est POSÉE sur les
 * routes réelles : un test unitaire monte son propre câblage, et le faux bouge avec le code. Ici les modules
 * montés viennent du REGISTRE (`modulesDeRoutes`), l'inventaire des routes vient du SERVEUR CONSTRUIT, la
 * classe d'accès de chaque route vient de l'entrée qui la déclare, et chaque route est attaquée pour de bon
 * avec les gestes de sa classe. Un module ajouté demain est sondé sans que personne y pense.
 *
 * ⚠️ La liste des modules a été écrite à la main jusqu'au 2026-09-21, sous un commentaire qui affirmait le
 * contraire : huit modules du registre n'étaient jamais montés (27 routes jamais attaquées), dont `v1`
 * (l'API publique, `/mcp` et le relais du Meta Business Agent), et un nom (`users`) ne montait rien parce
 * que l'entrée s'appelle `admin`. `receiver` et `auth` manquaient aussi à la liste, mais se montaient par
 * leurs clés posées à côté (`queue`, `auth`) : l'écart entre la liste et le registre n'était donc même
 * pas lisible dans la liste.
 *
 * 🔴 LA POLARITÉ EST « TOUT EST FERMÉ SAUF PREUVE DU CONTRAIRE ». Les routes publiques sont énumérées ici,
 * une par une, avec la raison de leur ouverture. Une route qui répond sans session sans figurer dans cette
 * liste est signalée comme trouvaille, jamais tolérée par défaut. L'inverse (une liste de routes à tester)
 * serait une liste à tenir à jour à la main, c'est-à-dire une liste qui dérive.
 *
 * ## Deux cibles, et pourquoi il faut les deux
 *
 * `--cible=local` (DÉFAUT) monte le serveur en mémoire avec des dépendances factices et l'attaque par
 * `inject`. Les gardes tournent pour de vrai : elles s'exécutent AVANT les dépendances, donc le fait que
 * celles-ci soient factices ne retire rien à ce qui est prouvé. Rejouable, utilisable en CI, aucun effet.
 *
 * ⚠️ Le mode local NE PEUT PAS booter le vrai serveur : le `DATABASE_URL` du `.env` de ce poste pointe sur
 * la base de PRODUCTION (cf. CLAUDE.md). Un « local » qui démarre l'application serait donc aussi dangereux
 * que la production, sous un nom rassurant. D'où les dépendances factices, qui ne sont pas un pis-aller mais
 * la seule façon d'avoir un mode local qui mérite son nom.
 *
 * `--cible=https://...` attaque un déploiement par le réseau. C'est le SEUL moyen de voir la couche que rien
 * d'autre ne couvre : le routage par chemin de NPM, Cloudflare, le CORS de la nouvelle origine, la config
 * réelle. Il exige `--je-sais-ce-que-je-fais` et un jeton fourni à la main, et il refuse en dur les sondes
 * destructrices.
 *
 * ## Ce qu'une sonde doit garantir
 *
 * Presque toutes sont des tentatives qui DOIVENT ÉCHOUER. Si le produit est correct, rien n'est écrit nulle
 * part : c'est la réussite d'une écriture qui serait la trouvaille. Une sonde qui écrirait quelque chose en
 * cas de SUCCÈS ATTENDU n'a pas sa place ici.
 *
 * Usage :
 *   npx tsx scripts/auto-attaque.mts
 *   npx tsx scripts/auto-attaque.mts --cible=https://api.messagingme.app --je-sais-ce-que-je-fais \
 *     --jeton=<JWT d'un compte de test> --tenant=<son espace>
 */
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { buildServer, modulesDeRoutes } from '../src/server';
import type { ClasseDAcces, Gardes, ServerDeps } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { RateLimiter } from '../src/auth/rate-limit';
import { signSession } from '../src/auth/token';
import { API_KEY_PREFIX } from '../src/auth/api-key-store.pg';
import type { PreHandler } from '../src/auth/middleware';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
import type { HubspotEventRouteDeps } from '../src/http/hubspot-events';
import type { FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------------------

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args.set(m[1]!, m[2] ?? 'true');
}
const CIBLE = args.get('cible') ?? 'local';
const LOCAL = CIBLE === 'local';
const JETON_FOURNI = args.get('jeton') ?? '';
const TENANT_FOURNI = args.get('tenant') ?? '';

if (!LOCAL) {
  if (args.get('je-sais-ce-que-je-fais') !== 'true') {
    console.error(
      `REFUS : attaquer « ${CIBLE} » demande --je-sais-ce-que-je-fais.\n` +
      `Ce n'est pas une formalité : la cible sert de vrais clients WhatsApp. Les sondes destructrices sont\n` +
      `refusées en dur sur une cible distante, mais le plafond de débit du compte utilisé SERA consommé,\n` +
      `les refus sur /ops déclencheront l'alerte Telegram, et les clés inventées envoyées à /v1 entameront\n` +
      `pour une minute le budget des clés inconnues, partagé par tous les intégrateurs.\n` +
      `Utiliser un compte de test dédié, jamais celui d'un client.`,
    );
    process.exit(2);
  }
  if (!JETON_FOURNI || !TENANT_FOURNI) {
    console.error('REFUS : une cible distante exige --jeton=<JWT> et --tenant=<espace> (compte de test dédié).');
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------------------------------------
// Inventaire : les modules lus dans le REGISTRE, les routes lues sur le SERVEUR CONSTRUIT, jamais à la main
// ---------------------------------------------------------------------------------------------------------

interface Route { chemin: string; methodes: string[] }

/**
 * Dépendance factice qui satisfait n'importe quelle forme et répond `{}` à tout appel : elle monte un module
 * `tenant` sans base ni réseau. Ses routes sont gardées AVANT leurs dépendances (`preHandler`), donc le fait
 * que celles-ci soient factices ne retire rien à ce que les sondes prouvent.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bidon = (): any => new Proxy(function () { /* noop */ } as unknown as object, {
  get: (_c, p) => (p === 'then' ? undefined : bidon()),
  apply: () => Promise.resolve({}),
});

/**
 * Combien de fois chaque fausse autorité a été INTERROGÉE, par nom de module. C'est ce qui dit si une sonde
 * a atteint la vérification qu'elle prétend attaquer, ou si elle a été refusée plus tôt pour une raison
 * sans intérêt (un code au mauvais format, par exemple).
 */
const interrogations = new Map<string, number>();

/**
 * Dépendance factice qui répond « inconnu » (`null`) à tout appel : aucun code, aucune clé ne s'y résout.
 *
 * ⚠️ C'EST CELLE DES MODULES DONT L'AUTORITÉ VIT DANS LEURS DÉPENDANCES (voir `FAUSSES_AUTORITES`). Avec
 * `bidon()`, le magasin des clés d'API répondrait `{}` à une clé inventée, c'est-à-dire « trouvée » : la
 * sonde ouvrirait la porte avec une fausse clé, et prendrait sa propre dépendance factice pour une faille.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const inconnu = (nom: string): any => new Proxy(function () { /* noop */ } as unknown as object, {
  get: (_c, p) => (p === 'then' ? undefined : inconnu(nom)),
  apply: () => {
    interrogations.set(nom, (interrogations.get(nom) ?? 0) + 1);
    return Promise.resolve(null);
  },
});

/**
 * `inconnu()`, SAUF pour les limiteurs nommés, qui sont de VRAIS limiteurs DÉSACTIVÉS.
 *
 * 🔴 SANS CELA, UN LIMITEUR ÉTAIT COMPTÉ COMME UNE INTERROGATION DU MAGASIN (2026-09-21). Le webhook entrant
 * lit `limiter` et, depuis le frein des codes jamais vus, `budgetInconnus` : sur `inconnu()`, leur `take()`
 * incrémentait `interrogations` et rendait une promesse, donc une valeur VRAIE. Le frein ne freinait jamais, et
 * une sonde qui n'aurait touché QUE le limiteur se serait crue arrivée jusqu'au magasin. Désactivés, ils
 * laissent passer sans rien compter : ce que la sonde attaque est le code de l'adresse, pas le débit.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const inconnuSaufLimiteurs = (nom: string, limiteurs: readonly string[]): any => new Proxy(inconnu(nom), {
  get: (cible, p) => (typeof p === 'string' && limiteurs.includes(p) ? new RateLimiter(0, 60_000) : Reflect.get(cible, p)),
});

/**
 * 🔴 TIRÉS AU HASARD À CHAQUE EXÉCUTION, jamais écrits dans le dépôt. Deux raisons, et la seconde est la
 * vraie : un littéral qui ressemble à un secret fait sonner le hook `gitleaks` de tous les commits (il a
 * sonné, c'est ainsi que ces lignes existent), et surtout une valeur de test en dur finit toujours par être
 * recopiée dans un vrai câblage. Le hasard ferme les deux d'un coup, et ne coûte rien : ces jetons ne
 * servent qu'au serveur monté en mémoire, le temps de l'exécution.
 *
 * ⚠️ `SECRET_META` et `SECRET_SERVICE` ne sont pas décoratifs. Sans le premier, le receveur lisait
 * `config.META_APP_SECRET`, VIDE en CI comme sur ce poste (le script ne charge pas `.env`) : la
 * vérification refusait alors tout AVANT de comparer quoi que ce soit. Mesuré le 2026-09-21 : une
 * vérification plantée qui accepte toute signature bien formée passait l'ancienne version sans trouvaille,
 * et la sonde 6 la trouve désormais.
 */
const SECRET = randomBytes(32).toString('hex');
const JETON_OPS = randomBytes(32).toString('hex');
const SECRET_META = randomBytes(32).toString('hex');
const JETON_VERIFICATION_META = randomBytes(16).toString('hex');
const SECRET_SERVICE = randomBytes(32).toString('hex');

const aucunCompte: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };

/**
 * 🔴 LES MODULES DONT L'AUTORITÉ VIT DANS LEURS DÉPENDANCES, un par un, avec leur fausse autorité.
 *
 * Une route `tenant` est gardée avant ses dépendances, donc `bidon()` lui suffit. Ce n'est plus vrai des
 * autres classes : un lien tracé est autorisé par le code que SON MAGASIN retrouve, `/v1` par la clé que son
 * magasin résout, le connecteur HubSpot par le secret qu'il PORTE. Pour ceux-là, la dépendance factice EST
 * l'autorité attaquée, et elle doit dire « personne n'est reconnu ».
 *
 * ⚠️ D'OÙ LA POLARITÉ : un module du registre dont la classe n'est pas `tenant` et qui n'est pas nommé ici
 * ARRÊTE le script. Le monter avec `bidon()` donnerait une sonde qui ne prouve rien, sans un mot. Ajouter
 * une ligne ici oblige à décider ce que « personne n'est reconnu » veut dire pour lui.
 */
const FAUSSES_AUTORITES: Readonly<Record<string, unknown>> = {
  // Signature Meta : l'autorité est `appSecret` (posé dans `dependancesDuRegistre`), la file n'est jamais atteinte.
  receiver: new FakeQueue(),
  // Jeton d'exploitation : l'autorité est `opsToken`, vérifiée avant toute dépendance.
  ops: inconnu('ops'),
  // Code dans l'adresse : aucun code ne se résout.
  links: inconnu('links'),
  webhookEntrant: inconnuSaufLimiteurs('webhookEntrant', ['limiter', 'budgetInconnus']),
  rcsCallback: inconnu('rcsCallback'),
  // Avant toute session : aucun compte n'existe, et le secret de session est celui des jetons fabriqués ici.
  auth: { users: aucunCompte, secret: SECRET },
  // Signature entre nos services : un VRAI secret, sans quoi la comparaison n'est jamais exercée.
  hubspotEvents: {
    secret: SECRET_SERVICE,
    findWaId: async () => null,
    publish: async () => undefined,
  } satisfies HubspotEventRouteDeps,
  // Clé d'API : aucune clé ne se résout. `inconnu()` étant une fonction, donc une valeur vraie, les quatre
  // montages de l'entrée (`/v1`, les envois, `/mcp`, le relais du Meta Business Agent) ont bien lieu.
  v1: inconnu('v1'),
};

/**
 * Les clés de `ServerDeps` que le registre lit pour décider de monter chacun de ses modules.
 *
 * 🔴 LUES EN EXÉCUTANT LE REGISTRE, PAS RECOPIÉES. `modulesDeRoutes` évalue la dépendance de chaque entrée en
 * construisant sa liste (le troisième argument d'`entree`) : un espion qui note les clés lues rend donc la
 * liste exacte des modules, y compris celui qui sera ajouté demain. Le nom d'une entrée n'est pas toujours
 * sa clé (`receiver` lit `queue`), et c'est pour ça qu'on ne dérive pas les clés des noms.
 */
function clesDuRegistre(): string[] {
  const lues = new Set<string>();
  const espion = new Proxy({}, {
    get: (_c, p) => {
      if (typeof p === 'string') lues.add(p);
      return undefined;
    },
  });
  modulesDeRoutes(espion as ServerDeps, bidon());
  return [...lues];
}

/**
 * Les dépendances de TOUT le registre : `bidon()` pour un module `tenant`, sa fausse autorité pour les autres.
 *
 * Chaque clé est rattachée à son entrée en rejouant le registre avec CETTE SEULE clé fournie : l'entrée qui
 * se déclare alors fournie est la sienne, avec son nom et sa classe. Rien n'est deviné sur l'orthographe.
 */
function dependancesDuRegistre(): Record<string, unknown> {
  const deps: Record<string, unknown> = {
    corsOrigins: ['https://engageme.messagingme.app'],
    opsToken: JETON_OPS,
    appSecret: SECRET_META,
    verifyToken: JETON_VERIFICATION_META,
    // Plafonds larges : les sondes d'autorisation ne doivent pas être refusées pour cause de débit. La sonde
    // de débit, elle, construit son propre serveur avec un plafond bas.
    plafonds: { utilisateurParMinute: 0, couteuxParMinute: 0 },
  };
  const problemes: string[] = [];
  const nommes = new Set<string>();
  for (const cle of clesDuRegistre()) {
    const entrees = modulesDeRoutes({ [cle]: bidon() } as unknown as ServerDeps, bidon()).filter((m) => m.fourni);
    const horsTenant = entrees.filter((m) => m.acces !== 'tenant');
    if (horsTenant.length === 0) {
      deps[cle] = bidon();
      continue;
    }
    if (entrees.length > 1) {
      problemes.push(`la clé « ${cle} » monte plusieurs modules dont un hors tenant (${entrees.map((m) => m.nom).join(', ')}) : une seule fausse autorité ne peut pas les servir tous`);
      continue;
    }
    const m = horsTenant[0]!;
    nommes.add(m.nom);
    if (!Object.hasOwn(FAUSSES_AUTORITES, m.nom)) {
      problemes.push(`le module « ${m.nom} » (classe ${m.acces}) n'a pas de fausse autorité : la déclarer dans FAUSSES_AUTORITES`);
      continue;
    }
    deps[cle] = FAUSSES_AUTORITES[m.nom];
  }
  for (const nom of Object.keys(FAUSSES_AUTORITES)) {
    if (!nommes.has(nom)) problemes.push(`FAUSSES_AUTORITES nomme « ${nom} », que le registre ne déclare pas (ou plus) hors de la classe tenant`);
  }
  // La garantie que tout ce script repose sur elle : AUCUNE entrée du registre ne reste sans dépendances.
  const nonMontes = modulesDeRoutes(deps as unknown as ServerDeps, bidon()).filter((m) => !m.fourni).map((m) => m.nom);
  // ⚠️ Un module non monté a le plus souvent sa cause dans le registre : il a cessé de lire la dépendance de
  // cette entrée en construisant sa liste (lecture différée dans une closure), et l'espion de `clesDuRegistre`
  // ne la voit plus. Le message le dit EN PREMIER, parce que c'est dans `src/server.ts` qu'on le provoquera,
  // ici qu'on le découvrira, et que les autres lignes n'en sont alors que les conséquences.
  if (nonMontes.length > 0) {
    problemes.unshift(
      `modules du registre non montés : ${nonMontes.join(', ')}. Le registre lit-il encore la dépendance de ` +
      `chaque entrée pendant qu'il construit sa liste ? C'est ce que \`clesDuRegistre\` observe.`,
    );
  }
  if (problemes.length > 0) throw new Error(`le registre ne se laisse pas monter en entier :\n  - ${problemes.join('\n  - ')}`);
  return deps;
}

/**
 * 🔴 LA CLASSE D'ACCÈS DE CHAQUE ROUTE, prise au registre et pas devinée sur son adresse. Chaque module est
 * monté SEUL sur une instance jetable, et ses routes reçoivent la classe que son entrée DÉCLARE. C'est ce
 * qui permet d'attaquer chaque route avec les gestes de SA classe : une clé d'API inventée sur `/v1`, un
 * code inconnu sur `/r/:code`, une signature fausse sur `/hubspot/deal-stage`. L'ancienne version les
 * reconnaissait à des préfixes écrits à la main, et ne connaissait pas `/mba/relais/`.
 *
 * ⚠️ Les gardes y sont des laissez-passer : ces instances ne servent qu'à savoir QUI déclare quelle route.
 * Les sondes, elles, tapent sur le serveur de `buildServer`, avec ses vraies gardes.
 */
async function classesDesRoutes(deps: Record<string, unknown>): Promise<Map<string, { classe: ClasseDAcces; module: string }>> {
  const passe: PreHandler = async () => undefined;
  const gardes: Gardes = { auth: passe, admin: [passe], encadrement: [passe] };
  const classes = new Map<string, { classe: ClasseDAcces; module: string }>();
  for (const m of modulesDeRoutes(deps as unknown as ServerDeps, bidon())) {
    const seul = Fastify({ logger: false });
    m.monte(seul, gardes);
    await seul.ready();
    for (const r of inventaire(seul)) {
      const deja = classes.get(r.chemin);
      if (deja !== undefined && deja.classe !== m.acces) {
        throw new Error(`${r.chemin} est déclarée par deux classes d'accès (${deja.module} : ${deja.classe}, ${m.nom} : ${m.acces})`);
      }
      classes.set(r.chemin, { classe: m.acces, module: m.nom });
    }
    await seul.close();
  }
  return classes;
}

/** Aplatit `printRoutes` (un arbre de préfixes) en chemins complets + méthodes. */
function inventaire(app: FastifyInstance): Route[] {
  const brut = app.printRoutes({ commonPrefix: false });
  const pile: string[] = [];
  const routes: Route[] = [];
  for (const ligne of brut.split('\n')) {
    const m = /^([\s│]*)(?:├──|└──)\s(.*)$/.exec(ligne);
    if (!m) continue;
    const niveau = Math.floor(m[1]!.length / 4);
    const mm = /^(.*?)\s\(([A-Z, ]+)\)\s*$/.exec(m[2]!);
    pile.length = niveau;
    pile.push((mm ? mm[1]! : m[2]!).trim());
    if (mm) {
      routes.push({
        chemin: pile.join('').replace(/\/{2,}/g, '/'),
        methodes: mm[2]!.split(',').map((x) => x.trim()).filter((x) => x !== 'HEAD' && x !== 'OPTIONS'),
      });
    }
  }
  return routes.filter((r) => r.methodes.length > 0);
}

// ---------------------------------------------------------------------------------------------------------
// Les routes LÉGITIMEMENT ouvertes, chacune avec sa raison
// ---------------------------------------------------------------------------------------------------------

/**
 * 🔴 Tout ce qui n'est pas ici DOIT refuser en 401 un appel qui ne présente AUCUNE autorisation. Une route
 * qui répond sans rien sans figurer dans cette liste est une trouvaille, pas une exception à ajouter sans
 * réfléchir. La raison est écrite parce qu'une liste sans raisons finit par tout accueillir.
 *
 * ⚠️ N'Y FIGURENT QUE LES EXCEPTIONS À LA CLASSE DE LEUR MODULE. Une route dont la CLASSE place l'autorité
 * dans l'appel lui-même (`code-url`, `signature-meta`, `signature-service`) n'est pas ici : elle est écartée
 * de la sonde 1 par sa classe, et attaquée par la sonde de sa classe. Une route `jeton-ops` ou `cle-api`
 * n'est pas ici non plus : sans jeton ni clé, elle doit répondre 401 comme les autres, et c'est ce qui lui
 * manquait quand elle était rangée parmi les « ouvertes ». Restent les routes sans module (`/live`,
 * `/health`) et les routes publiques d'un module qui ne l'est pas (`/m/` dans les visuels RCS, les points
 * d'entrée de `/auth`).
 */
const OUVERTES: ReadonlyArray<{ motif: RegExp; raison: string }> = [
  { motif: /^\/live$/, raison: 'sonde de vie, aucune donnée' },
  { motif: /^\/health$/, raison: 'sonde de readiness, aucune donnée' },
  { motif: /^\/m\//, raison: 'visuel RCS : servi à l\'opérateur et au destinataire' },
  // Les points d'ENTRÉE : par construction il n'y a pas encore de session quand on les appelle. Ils sont
  // nommés un par un, et surtout `/auth/change-password` n'y est PAS : elle est montée sous `requireAuth`,
  // et c'est bien la sonde 1 qui doit continuer à le vérifier.
  { motif: /^\/auth\/(login|signup|config|google|forgot-password|reset-password)$/, raison: 'entrée : pas encore de session' },
  { motif: /^\/auth\/invitations\/accept$/, raison: 'entrée : on accepte une invitation sans avoir de compte' },
  // Second temps d'une connexion à plusieurs espaces. Autorité SÉPARÉE de la session, comme /ops : ce qui
  // autorise est un jeton de CHOIX signé, qui porte la liste des espaces permis et dont la route vérifie que
  // l'espace demandé s'y trouve. Sa propre sonde (10) attaque cette vérification.
  { motif: /^\/auth\/choose-workspace$/, raison: 'entrée : autorisé par un jeton de choix signé, pas par une session' },
];

const estOuverte = (chemin: string): string | null => OUVERTES.find((o) => o.motif.test(chemin))?.raison ?? null;

/**
 * Les classes dont l'autorité est portée par l'APPEL lui-même (un code dans l'adresse, une signature du
 * corps) : aucun appelant n'y a de session, donc la sonde 1 n'y a pas de sens. Leurs routes ne sont pas
 * laissées de côté pour autant, chacune a sa sonde (6, 11, 12).
 */
const AUTORITE_DANS_L_APPEL: ReadonlySet<ClasseDAcces> = new Set(['code-url', 'signature-meta', 'signature-service']);

/**
 * Des codes BIEN FORMÉS que personne n'a émis, un par format connu : sans le bon format, un code est refusé
 * par l'expression régulière de sa route avant d'atteindre le magasin, et la sonde ne prouverait que
 * l'existence de cette expression. La sonde 11 vérifie qu'au moins un d'eux a atteint chaque magasin.
 */
const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
const auHasard = (n: number): string => Array.from(randomBytes(n), (o) => CROCKFORD[o % CROCKFORD.length]).join('');
const CODES_INCONNUS = [auHasard(12), auHasard(26), `rcs-${randomBytes(12).toString('hex')}`];

/** Chemins qu'on n'envoie JAMAIS sur une cible distante : ils effacent ou dépensent pour de vrai. */
const DESTRUCTRICES = /purge|\/run$|broadcast|\/send|\/stop$|\/archive$|import$/;

// ---------------------------------------------------------------------------------------------------------
// Transport : une seule interface, deux implémentations, pour que les deux modes exercent LE MÊME code
// ---------------------------------------------------------------------------------------------------------

interface Reponse { statut: number; entetes: Record<string, string>; corps: string }
interface Appel { methode: string; chemin: string; entetes?: Record<string, string>; corps?: unknown }

function transportLocal(app: FastifyInstance) {
  return async (a: Appel): Promise<Reponse> => {
    const res = await app.inject({
      method: a.methode as 'GET',
      url: a.chemin,
      headers: { 'content-type': 'application/json', ...(a.entetes ?? {}) },
      ...(a.corps === undefined ? {} : { payload: a.corps as object }),
    });
    const entetes: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers)) entetes[k.toLowerCase()] = String(v);
    return { statut: res.statusCode, entetes, corps: res.body.slice(0, 300) };
  };
}

function transportReseau(base: string) {
  return async (a: Appel): Promise<Reponse> => {
    const res = await fetch(new URL(a.chemin, base), {
      method: a.methode,
      headers: { 'content-type': 'application/json', ...(a.entetes ?? {}) },
      ...(a.corps === undefined ? {} : { body: JSON.stringify(a.corps) }),
      redirect: 'manual',
    });
    const entetes: Record<string, string> = {};
    res.headers.forEach((v, k) => { entetes[k.toLowerCase()] = v; });
    return { statut: res.status, entetes, corps: (await res.text()).slice(0, 300) };
  };
}

// ---------------------------------------------------------------------------------------------------------
// Compte rendu
// ---------------------------------------------------------------------------------------------------------

interface Trouvaille { sonde: string; ou: string; attendu: string; obtenu: string }
const trouvailles: Trouvaille[] = [];
let sondesJouees = 0;

function verifier(sonde: string, ou: string, ok: boolean, attendu: string, obtenu: string): void {
  sondesJouees += 1;
  if (!ok) trouvailles.push({ sonde, ou, attendu, obtenu });
}

/** Remplace les paramètres de chemin. `:tenantId` prend la valeur demandée, le reste un identifiant bidon. */
const concretiser = (chemin: string, tenant: string): string =>
  chemin.replace(/:tenantId/g, tenant).replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');

// ---------------------------------------------------------------------------------------------------------
// Les sondes
// ---------------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const deps = dependancesDuRegistre();
  const app = buildServer(deps as unknown as ServerDeps);
  await app.ready();
  const routes = inventaire(app);
  const classes = await classesDesRoutes(deps);
  const classeDe = (r: Route): ClasseDAcces | undefined => classes.get(r.chemin)?.classe;
  const deClasse = (c: ClasseDAcces): Route[] => routes.filter((r) => classeDe(r) === c);
  const envoyer = LOCAL ? transportLocal(app) : transportReseau(CIBLE);

  const tenantA = LOCAL ? 'aaaaaaaa-0000-4000-8000-000000000001' : TENANT_FOURNI;
  const tenantB = 'bbbbbbbb-0000-4000-8000-000000000002';
  const jetonAdmin = LOCAL ? await signSession({ userId: 'u-admin', tenantId: tenantA, role: 'admin' }, SECRET) : JETON_FOURNI;
  const jetonAgent = LOCAL ? await signSession({ userId: 'u-agent', tenantId: tenantA, role: 'agent' }, SECRET) : '';
  const jetonEmprunt = LOCAL
    ? await signSession({ userId: 'u-ops', tenantId: tenantA, role: 'admin', impersonated: true }, SECRET)
    : '';
  const bearer = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` });

  const gardees = routes.filter((r) => {
    const c = classeDe(r);
    return estOuverte(r.chemin) === null && (c === undefined || !AUTORITE_DANS_L_APPEL.has(c));
  });
  // Une route hors registre (`classeDe` indéfinie) est traitée comme la plus exigeante : une route `tenant`.
  const routesTenant = gardees.filter((r) => r.chemin.includes(':tenantId') && (classeDe(r) ?? 'tenant') === 'tenant');
  const jouables = (r: Route): boolean => LOCAL || !DESTRUCTRICES.test(r.chemin);

  const parClasse = new Map<string, number>();
  for (const r of routes) {
    const c = classeDe(r) ?? 'hors registre';
    parClasse.set(c, (parClasse.get(c) ?? 0) + 1);
  }
  const modules = new Set([...classes.values()].map((v) => v.module));
  console.log(`Cible : ${CIBLE}`);
  console.log(`${modules.size} modules montés depuis le registre, ${routes.length} routes inventoriées depuis le serveur construit.`);
  console.log(`Par classe d'accès : ${[...parClasse].map(([c, n]) => `${c} ${n}`).join(', ')}.`);
  console.log(`${gardees.length} routes doivent refuser en 401 un appel qui ne présente aucune autorisation.`);
  // `--inventaire` imprime ce qui est attaqué et ce qui est tenu pour ouvert, puis sort. Sert à COMPARER deux
  // environnements : la CI a inventorié une route gardée de MOINS que ce poste (168 contre 169) sans qu'on
  // ait su laquelle, et un écart d'inventaire est un écart de COUVERTURE, donc une chose à pouvoir trancher.
  if (args.get('inventaire') === 'true') {
    for (const r of routes) {
      const c = classes.get(r.chemin);
      const origine = c === undefined ? 'hors registre' : `${c.classe} (${c.module})`;
      const raison = estOuverte(r.chemin) ?? (gardees.includes(r) ? null : 'autorité portée par l’appel, attaquée par la sonde de sa classe');
      console.log(`${raison === null ? 'GARDEE ' : 'ouverte'} ${origine.padEnd(34)} ${r.methodes.join('|').padEnd(18)} ${r.chemin}${raison === null ? '' : `   <- ${raison}`}`);
    }
    await app.close();
    return;
  }
  if (!LOCAL) {
    const ecartees = gardees.filter((r) => !jouables(r)).length;
    console.log(`${ecartees} routes destructrices ÉCARTÉES (cible distante).`);
  }
  console.log('');

  // --- Sonde 1 : aucune authentification ---------------------------------------------------------------
  // La plus bête et la plus payante : une route montée sans garde répond 200 à qui passe. Elle vaut pour
  // toutes les classes qui attendent une autorisation PRÉSENTÉE (session, jeton d'exploitation, clé d'API).
  for (const r of gardees.filter(jouables)) {
    for (const methode of r.methodes) {
      const res = await envoyer({ methode, chemin: concretiser(r.chemin, tenantA) });
      verifier(
        '1. sans authentification',
        `${methode} ${r.chemin}`,
        res.statut === 401,
        '401',
        String(res.statut),
      );
    }
  }

  // --- Sonde 2 : IDOR, le geste d'école ------------------------------------------------------------------
  // Jeton valide pour l'espace A, identifiant de l'espace B dans l'URL. 403 attendu : c'est `scopeTenant`.
  // ⚠️ Sur cible distante on ne joue que les LECTURES : une écriture qui passerait écrirait chez le voisin.
  // ⚠️ Les seules routes de la classe `tenant` : `/ops/credits/:tenantId` porte aussi un espace dans son
  // adresse, et c'est correct, l'exploitation est délibérément cross-espace (sonde 5).
  for (const r of routesTenant.filter(jouables)) {
    for (const methode of LOCAL ? r.methodes : r.methodes.filter((m) => m === 'GET')) {
      const res = await envoyer({ methode, chemin: concretiser(r.chemin, tenantB), entetes: bearer(jetonAdmin) });
      verifier(
        '2. IDOR (espace croisé)',
        `${methode} ${r.chemin}`,
        res.statut === 403,
        '403',
        String(res.statut),
      );
    }
  }

  // --- Sonde 3 : jeton signé avec un AUTRE secret --------------------------------------------------------
  // Un JWT bien formé mais signé ailleurs doit être refusé : sinon n'importe qui fabrique une session.
  {
    const forge = await signSession({ userId: 'u-forge', tenantId: tenantA, role: 'admin' }, randomBytes(32).toString('hex'));
    const cible = routesTenant.find((r) => r.methodes.includes('GET'));
    if (cible) {
      const res = await envoyer({ methode: 'GET', chemin: concretiser(cible.chemin, tenantA), entetes: bearer(forge) });
      verifier('3. jeton forgé (autre secret)', `GET ${cible.chemin}`, res.statut === 401, '401', String(res.statut));
    }
  }

  // --- Sonde 4 : session d'emprunt en ÉCRITURE -----------------------------------------------------------
  // La garde d'observation est globale et doit refuser toute méthode autre que GET/HEAD, sur TOUTE route.
  if (LOCAL) {
    for (const r of routesTenant.filter((r) => r.methodes.some((m) => m !== 'GET'))) {
      const methode = r.methodes.find((m) => m !== 'GET')!;
      const res = await envoyer({ methode, chemin: concretiser(r.chemin, tenantA), entetes: bearer(jetonEmprunt) });
      verifier(
        '4. session d’emprunt en écriture',
        `${methode} ${r.chemin}`,
        res.statut === 403,
        '403',
        String(res.statut),
      );
    }
  }

  // --- Sonde 5 : /ops avec une session de client --------------------------------------------------------
  // Sans jeton du tout, c'est la sonde 1. Ici, la preuve que l'autorité est SÉPARÉE : un admin d'espace
  // n'entre pas. Choisies par leur classe, pas par leur préfixe.
  for (const r of deClasse('jeton-ops').filter(jouables)) {
    for (const methode of r.methodes) {
      const res = await envoyer({ methode, chemin: concretiser(r.chemin, tenantA), entetes: bearer(jetonAdmin) });
      verifier(
        '5. /ops avec un jeton de CLIENT',
        `${methode} ${r.chemin}`,
        res.statut === 401,
        '401 (autorité séparée : un admin de tenant n’entre pas)',
        String(res.statut),
      );
    }
  }

  // --- Sonde 6 : classe `signature-meta`, sans signature valide ------------------------------------------
  // 403 et non 401 : le receveur SAIT de qui l'appel se réclame, il constate qu'il n'est pas autorisé
  // (`src/webhooks/receiver.ts`). Ce qui compte n'est pas le code exact mais qu'il soit un REFUS : un 200
  // ici voudrait dire que n'importe qui peut nous injecter des messages entrants. En lecture, c'est la
  // poignée de main de Meta qui est attaquée : un jeton de vérification faux ne doit rien renvoyer.
  for (const r of deClasse('signature-meta').filter(jouables)) {
    for (const methode of r.methodes) {
      const chemin = concretiser(r.chemin, tenantA);
      if (methode === 'GET') {
        const faux = await envoyer({
          methode,
          chemin: `${chemin}?hub.mode=subscribe&hub.verify_token=${randomBytes(16).toString('hex')}&hub.challenge=sonde`,
        });
        verifier('6. Meta : jeton de vérification faux', `${methode} ${r.chemin}`, faux.statut === 403, '403', String(faux.statut));
        continue;
      }
      const corps = { object: 'whatsapp_business_account' };
      const sansSignature = await envoyer({ methode, chemin, corps });
      verifier('6. Meta : sans signature', `${methode} ${r.chemin}`, sansSignature.statut === 403, '403', String(sansSignature.statut));
      const mauvaise = await envoyer({
        methode, chemin, corps,
        entetes: { 'x-hub-signature-256': `sha256=${randomBytes(32).toString('hex')}` },
      });
      verifier('6. Meta : signature fausse', `${methode} ${r.chemin}`, mauvaise.statut === 403, '403', String(mauvaise.statut));
    }
  }

  /**
   * 🔴 UNE SONDE DE CLASSE SE VÉRIFIE ELLE-MÊME. Un refus rendu AVANT le magasin (l'expression régulière
   * d'une route, le contrôle de format d'une clé) ne prouve pas que la route refuse un code ou une clé
   * INCONNUS, seulement MAL FORMÉS. Si aucun appel n'a atteint la fausse autorité d'un module de la classe,
   * c'est la sonde qui est aveugle, et elle le dit. En local seulement : à distance, rien ne se compte.
   *
   * ⚠️ Ce qui se compte est un appel à N'IMPORTE QUELLE fonction de la fausse autorité, pas au seul magasin :
   * pour `/w/:code`, le limiteur de débit (lui aussi pris dans les dépendances) est appelé juste avant la
   * recherche du code. Les deux étant placés APRÈS le contrôle de format, le compte dit bien « la sonde a
   * passé ce contrôle », qui est la seule chose qu'il doit dire.
   */
  const verifierAtteinte = (sonde: string, classe: ClasseDAcces, avant: ReadonlyMap<string, number>, remede: string): void => {
    if (!LOCAL) return;
    const modulesDeLaClasse = new Set([...classes.values()].filter((v) => v.classe === classe).map((v) => v.module));
    for (const m of modulesDeLaClasse) {
      const n = (interrogations.get(m) ?? 0) - (avant.get(m) ?? 0);
      verifier(sonde, m, n > 0, 'au moins une recherche dans son magasin', `${n} (${remede})`);
    }
  };

  // --- Sonde 11 : classe `code-url`, un code que personne n'a émis ---------------------------------------
  // C'est le code de l'adresse qui autorise. Un code bien formé mais inconnu doit rendre 404, sans rien
  // écrire ni rediriger nulle part. En local le faux magasin ne connaît aucun code ; à distance, un code tiré
  // au hasard n'existe pas.
  {
    const avant = new Map(interrogations);
    for (const r of deClasse('code-url').filter(jouables)) {
      for (const methode of r.methodes) {
        for (const code of r.chemin.includes(':code') ? CODES_INCONNUS : ['']) {
          const chemin = concretiser(r.chemin.replace(':code', code), tenantA);
          const res = await envoyer({ methode, chemin, ...(methode === 'GET' ? {} : { corps: {} }) });
          verifier('11. code inconnu dans l’adresse', `${methode} ${r.chemin} (${code || 'sans code'})`, res.statut === 404, '404', String(res.statut));
        }
      }
    }
    verifierAtteinte('11. code inconnu : la sonde atteint le magasin', 'code-url', avant, 'aucun code candidat n’a le format de ce module : l’ajouter à CODES_INCONNUS');
  }

  // --- Sonde 12 : classe `signature-service`, signature absente ou fausse -----------------------------
  // Un corps est envoyé exprès : sans lui, la route refuse sur « corps absent » avant de calculer la moindre
  // signature, et la comparaison ne serait jamais exercée.
  for (const r of deClasse('signature-service').filter(jouables)) {
    for (const methode of r.methodes) {
      const chemin = concretiser(r.chemin, tenantA);
      const corps = methode === 'GET' ? undefined : { portalId: 1 };
      const sans = await envoyer({ methode, chemin, corps });
      verifier('12. signature de service absente', `${methode} ${r.chemin}`, sans.statut === 401, '401', String(sans.statut));
      const fausse = await envoyer({
        methode, chemin, corps,
        entetes: { 'x-mm-service-signature': `v1=${Date.now()}.${randomBytes(8).toString('hex')}.${randomBytes(32).toString('hex')}` },
      });
      verifier('12. signature de service fausse', `${methode} ${r.chemin}`, fausse.statut === 401, '401', String(fausse.statut));
    }
  }

  // --- Sonde 13 : classe `cle-api`, une session de console ou une clé inventée -------------------------
  // Sans rien, c'est la sonde 1. Ici, les deux gestes qui restent : présenter la session d'un admin d'espace
  // (l'autorité est SÉPARÉE, une session n'est pas une clé), et présenter une clé BIEN FORMÉE que personne
  // n'a émise, pour que le refus vienne du magasin et pas du seul contrôle de format.
  {
    const cleInventee = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const avant = new Map(interrogations);
    for (const r of deClasse('cle-api').filter(jouables)) {
      for (const methode of r.methodes) {
        const chemin = concretiser(r.chemin, tenantA);
        const session = await envoyer({ methode, chemin, entetes: bearer(jetonAdmin) });
        verifier('13. API publique avec une session de console', `${methode} ${r.chemin}`, session.statut === 401, '401 (autorité séparée)', String(session.statut));
        const inventee = await envoyer({ methode, chemin, entetes: bearer(cleInventee) });
        verifier('13. API publique avec une clé inventée', `${methode} ${r.chemin}`, inventee.statut === 401, '401', String(inventee.statut));
      }
    }
    verifierAtteinte('13. clé inventée : la sonde atteint le magasin', 'cle-api', avant, 'la clé inventée n’a pas le format attendu : revoir `cleInventee`');
  }

  // --- Sonde 10 : jeton de CHOIX présenté pour un espace qui n'y est pas --------------------------------
  // `/auth/choose-workspace` est ouverte, donc son contrôle est ailleurs : le jeton de choix porte la liste
  // signée des espaces permis. Sans la vérification d'appartenance, un jeton légitime ouvrirait N'IMPORTE
  // QUEL espace, ce qui serait la pire faille du produit. On l'attaque explicitement.
  if (LOCAL) {
    const { signChoice } = await import('../src/auth/token');
    const choix = await signChoice(
      { email: 'attaquant@exemple.test', comptes: [{ userId: 'u-admin', tenantId: tenantA, role: 'admin' }] },
      SECRET,
    );
    const res = await envoyer({ methode: 'POST', chemin: '/auth/choose-workspace', corps: { choiceToken: choix, tenantId: tenantB } });
    verifier(
      '10. jeton de choix pour un espace non listé',
      'POST /auth/choose-workspace',
      res.statut === 403,
      '403',
      String(res.statut),
    );
  }

  // --- Sonde 7 : CORS depuis une origine hostile ---------------------------------------------------------
  {
    const res = await envoyer({ methode: 'GET', chemin: '/live', entetes: { origin: 'https://site-hostile.test' } });
    const acao = res.entetes['access-control-allow-origin'];
    verifier(
      '7. CORS depuis une origine hostile',
      'GET /live (Origin: site-hostile.test)',
      acao === undefined || acao === '',
      'aucun access-control-allow-origin',
      acao ?? '(absent)',
    );
  }

  // --- Sonde 8 : le plafond de débit tient-il ? ----------------------------------------------------------
  // En local, un serveur DÉDIÉ avec un plafond bas : le serveur principal tourne plafonds désactivés pour
  // ne pas fausser les sondes d'autorisation. Sur cible distante, on tape le vrai plafond du déploiement.
  if (LOCAL) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d: any = { queue: new FakeQueue(), auth: { users: aucunCompte, secret: SECRET }, me: bidon(), plafonds: { utilisateurParMinute: 3 } };
    const petit = buildServer(d);
    await petit.ready();
    const envoyerPetit = transportLocal(petit);
    let refus = 0;
    for (let i = 0; i < 6; i++) {
      const res = await envoyerPetit({ methode: 'GET', chemin: `/tenants/${tenantA}/me`, entetes: bearer(jetonAdmin) });
      if (res.statut === 429) refus += 1;
    }
    verifier('8. plafond de débit', 'GET /tenants/:id/me x6 (plafond 3)', refus === 3, '3 refus', `${refus} refus`);
    await petit.close();
  } else {
    const chemin = `/tenants/${tenantA}/me`;
    let refus = 0;
    let vus = 0;
    for (let i = 0; i < 40; i++) {
      const res = await envoyer({ methode: 'GET', chemin, entetes: bearer(jetonAdmin) });
      vus += 1;
      if (res.statut === 429) { refus += 1; break; }
    }
    // 40 appels ne suffisent pas à franchir un plafond de 300/min : on ne conclut PAS à une absence de
    // plafond, on signale seulement ce qu'on a observé. Annoncer une faille ici serait un faux positif.
    console.log(`  (info) plafond distant : ${vus} appels envoyés, ${refus} refus. Un plafond de 300/min ne se franchit pas en 40 appels.`);
  }

  // --- Sonde 9 : les en-têtes de plafond sont-ils LISIBLES cross-origin ? --------------------------------
  {
    const res = await envoyer({ methode: 'GET', chemin: '/live', entetes: { origin: 'https://engageme.messagingme.app' } });
    const exposes = (res.entetes['access-control-expose-headers'] ?? '').toLowerCase();
    verifier(
      '9. en-têtes de plafond exposés au front',
      'GET /live (Origin: engageme)',
      exposes.includes('retry-after'),
      'retry-after dans access-control-expose-headers',
      exposes === '' ? '(absent)' : exposes,
    );
  }

  await app.close();

  // --- Compte rendu --------------------------------------------------------------------------------------
  console.log('');
  console.log(`${sondesJouees} sondes jouées.`);
  if (trouvailles.length === 0) {
    console.log('AUCUNE TROUVAILLE. Toutes les tentatives ont été refusées comme elles devaient l’être.');
    return;
  }
  console.log(`🔴 ${trouvailles.length} TROUVAILLE(S) :`);
  const parSonde = new Map<string, Trouvaille[]>();
  for (const t of trouvailles) parSonde.set(t.sonde, [...(parSonde.get(t.sonde) ?? []), t]);
  for (const [sonde, liste] of parSonde) {
    console.log(`\n  ${sonde} — ${liste.length} cas`);
    for (const t of liste.slice(0, 15)) console.log(`    ${t.ou}\n      attendu ${t.attendu}, obtenu ${t.obtenu}`);
    if (liste.length > 15) console.log(`    (+${liste.length - 15} autres)`);
  }
  process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error('auto-attaque : échec', err);
  process.exitCode = 2;
});
