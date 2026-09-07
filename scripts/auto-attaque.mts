/**
 * AUTO-ATTAQUE : on tape sur son propre produit avec les gestes d'un attaquant.
 *
 * 🔴 CE QUE CE SCRIPT APPORTE, ET QUE LA SUITE DE TESTS N'APPORTE PAS. Les 3853 tests prouvent que chaque
 * garde, PRISE UNE PAR UNE, se comporte comme son auteur l'a voulu. Ils ne prouvent pas qu'elle est POSÉE
 * sur les 169 routes réelles : un test unitaire monte son propre câblage, et le faux bouge avec le code.
 * Ici l'inventaire des routes vient du SERVEUR CONSTRUIT, pas d'une liste écrite à la main, et chaque route
 * est attaquée pour de bon. Une route ajoutée demain sans garde est trouvée sans que personne y pense.
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
import { buildServer } from '../src/server';
import { FakeQueue } from '../src/queue/fake';
import { signSession } from '../src/auth/token';
import type { UserAuthStore, EmailIdentity } from '../src/auth/store';
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
      `refusées en dur sur une cible distante, mais le plafond de débit du compte utilisé SERA consommé.\n` +
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
// Inventaire des routes : lu sur le SERVEUR CONSTRUIT, jamais écrit à la main
// ---------------------------------------------------------------------------------------------------------

interface Route { chemin: string; methodes: string[] }

/** Dépendance factice qui satisfait n'importe quelle forme : on monte les 40 modules sans base ni réseau. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bidon = (): any => new Proxy(function () { /* noop */ } as unknown as object, {
  get: (_c, p) => (p === 'then' ? undefined : bidon()),
  apply: () => Promise.resolve({}),
});

const MODULES = [
  'import', 'campaigns', 'contacts', 'templates', 'inbox', 'stats', 'settings', 'users', 'flows', 'agents',
  'media', 'tags', 'fields', 'support', 'account', 'me', 'workflows', 'automations', 'apiKeys',
  'embeddedSignup', 'mba', 'email', 'webhooksAdmin', 'hubspotImport', 'hubspotPipelines', 'hubspotInstall',
  'rcsMessages', 'rcsChannel', 'rcsMedia', 'agentKnowledge', 'agentTools', 'agentSetup', 'agentTest',
  'workflowReports', 'channelsMe', 'agentSources', 'agentRequetes', 'ops', 'links', 'webhookEntrant',
] as const;

/**
 * 🔴 TIRÉS AU HASARD À CHAQUE EXÉCUTION, jamais écrits dans le dépôt. Deux raisons, et la seconde est la
 * vraie : un littéral qui ressemble à un secret fait sonner le hook `gitleaks` de tous les commits (il a
 * sonné, c'est ainsi que ces lignes existent), et surtout une valeur de test en dur finit toujours par être
 * recopiée dans un vrai câblage. Le hasard ferme les deux d'un coup, et ne coûte rien : ces jetons ne
 * servent qu'au serveur monté en mémoire, le temps de l'exécution.
 */
const SECRET = randomBytes(32).toString('hex');
const JETON_OPS = randomBytes(32).toString('hex');

async function monterServeur(): Promise<FastifyInstance> {
  const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deps: any = {
    queue: new FakeQueue(),
    auth: { users: noUsers, secret: SECRET },
    corsOrigins: ['https://engageme.messagingme.app'],
    opsToken: JETON_OPS,
    // Plafonds larges : les sondes d'autorisation ne doivent pas être refusées pour cause de débit. La sonde
    // de débit, elle, construit son propre serveur avec un plafond bas.
    plafonds: { utilisateurParMinute: 0, couteuxParMinute: 0 },
  };
  for (const m of MODULES) deps[m] = bidon();
  const app = buildServer(deps);
  await app.ready();
  return app;
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
 * 🔴 Tout ce qui n'est pas ici DOIT exiger une session. Une route qui répond sans jeton sans figurer dans
 * cette liste est une trouvaille, pas une exception à ajouter sans réfléchir. La raison est écrite parce
 * qu'une liste sans raisons finit par tout accueillir.
 */
const OUVERTES: ReadonlyArray<{ motif: RegExp; raison: string }> = [
  { motif: /^\/live$/, raison: 'sonde de vie, aucune donnée' },
  { motif: /^\/health$/, raison: 'sonde de readiness, aucune donnée' },
  { motif: /^\/webhooks\/meta$/, raison: 'webhook Meta : autorisé par la SIGNATURE, pas par une session' },
  { motif: /^\/w\/:code$/, raison: 'webhook entrant : code non devinable + secret optionnel + limiteur' },
  { motif: /^\/r\/:code/, raison: 'lien tracé : c\'est un destinataire WhatsApp qui clique, il n\'a pas de session' },
  { motif: /^\/m\//, raison: 'visuel RCS : servi à l\'opérateur et au destinataire' },
  { motif: /^\/rcs\/callback\/:code$/, raison: 'rappel smsmode : le fournisseur ne signe pas, le code opaque autorise' },
  { motif: /^\/hubspot\/deal-stage$/, raison: 'connecteur HubSpot : autorisé par signature v3' },
  // Les points d'ENTRÉE : par construction il n'y a pas encore de session quand on les appelle. Ils sont
  // nommés un par un, et surtout `/auth/change-password` n'y est PAS : elle est montée sous `requireAuth`,
  // et c'est bien la sonde 1 qui doit continuer à le vérifier.
  { motif: /^\/auth\/(login|signup|config|google|forgot-password|reset-password)$/, raison: 'entrée : pas encore de session' },
  { motif: /^\/auth\/invitations\/accept$/, raison: 'entrée : on accepte une invitation sans avoir de compte' },
  // Second temps d'une connexion à plusieurs espaces. Autorité SÉPARÉE de la session, comme /ops : ce qui
  // autorise est un jeton de CHOIX signé, qui porte la liste des espaces permis et dont la route vérifie que
  // l'espace demandé s'y trouve. Sa propre sonde (10) attaque cette vérification.
  { motif: /^\/auth\/choose-workspace$/, raison: 'entrée : autorisé par un jeton de choix signé, pas par une session' },
  { motif: /^\/ops\//, raison: 'autorité SÉPARÉE : jeton x-ops-token, testé par sa propre sonde' },
  { motif: /^\/v1\//, raison: 'autorité SÉPARÉE : clé d\'API, testée par sa propre sonde' },
  { motif: /^\/mcp/, raison: 'autorité SÉPARÉE : clé d\'API' },
];

const estOuverte = (chemin: string): string | null => OUVERTES.find((o) => o.motif.test(chemin))?.raison ?? null;

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
  const app = await monterServeur();
  const routes = inventaire(app);
  const envoyer = LOCAL ? transportLocal(app) : transportReseau(CIBLE);

  const tenantA = LOCAL ? 'aaaaaaaa-0000-4000-8000-000000000001' : TENANT_FOURNI;
  const tenantB = 'bbbbbbbb-0000-4000-8000-000000000002';
  const jetonAdmin = LOCAL ? await signSession({ userId: 'u-admin', tenantId: tenantA, role: 'admin' }, SECRET) : JETON_FOURNI;
  const jetonAgent = LOCAL ? await signSession({ userId: 'u-agent', tenantId: tenantA, role: 'agent' }, SECRET) : '';
  const jetonEmprunt = LOCAL
    ? await signSession({ userId: 'u-ops', tenantId: tenantA, role: 'admin', impersonated: true }, SECRET)
    : '';
  const bearer = (t: string): Record<string, string> => ({ authorization: `Bearer ${t}` });

  const gardees = routes.filter((r) => estOuverte(r.chemin) === null);
  const jouables = (r: Route): boolean => LOCAL || !DESTRUCTRICES.test(r.chemin);

  console.log(`Cible : ${CIBLE}`);
  console.log(`${routes.length} routes inventoriées depuis le serveur construit, dont ${gardees.length} devant exiger une session.`);
  if (!LOCAL) {
    const ecartees = gardees.filter((r) => !jouables(r)).length;
    console.log(`${ecartees} routes destructrices ÉCARTÉES (cible distante).`);
  }
  console.log('');

  // --- Sonde 1 : aucune authentification ---------------------------------------------------------------
  // La plus bête et la plus payante : une route montée sans garde répond 200 à qui passe.
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
  const routesTenant = gardees.filter((r) => r.chemin.includes(':tenantId'));
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

  // --- Sonde 5 : /ops sans jeton -------------------------------------------------------------------------
  for (const r of routes.filter((r) => r.chemin.startsWith('/ops/')).filter(jouables)) {
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

  // --- Sonde 6 : webhook Meta sans signature valide ------------------------------------------------------
  // 403 et non 401 : le receveur SAIT de qui l'appel se réclame, il constate qu'il n'est pas autorisé
  // (`src/webhooks/receiver.ts`). Ce qui compte n'est pas le code exact mais qu'il soit un REFUS : un 200
  // ici voudrait dire que n'importe qui peut nous injecter des messages entrants.
  {
    const sansSignature = await envoyer({ methode: 'POST', chemin: '/webhooks/meta', corps: { object: 'whatsapp_business_account' } });
    verifier('6. webhook Meta sans signature', 'POST /webhooks/meta', sansSignature.statut === 403, '403', String(sansSignature.statut));
    const mauvaise = await envoyer({
      methode: 'POST', chemin: '/webhooks/meta',
      entetes: { 'x-hub-signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000' },
      corps: { object: 'whatsapp_business_account' },
    });
    verifier('6. webhook Meta signature fausse', 'POST /webhooks/meta', mauvaise.statut === 403, '403', String(mauvaise.statut));
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
    const noUsers: UserAuthStore = { findIdentity: async (): Promise<EmailIdentity | null> => null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d: any = { queue: new FakeQueue(), auth: { users: noUsers, secret: SECRET }, me: bidon(), plafonds: { utilisateurParMinute: 3 } };
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
