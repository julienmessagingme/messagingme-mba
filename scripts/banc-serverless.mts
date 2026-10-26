/**
 * BANC DU CONTENEUR SERVERLESS DE SCALEWAY, avant le jour J (l'essai réel qui clôt le plan
 * `docs/superpowers/plans/2026-10-15-jour-j-conteneur-et-budget.md`).
 *
 * Le second banc (`scripts/banc-deux-api-2.mts`) éprouve des propriétés du CODE (idempotence entre copies, pression
 * de pool) sur deux copies qu'il adresse une par une et qu'il arrête depuis l'hôte. Le serverless n'en adresse
 * aucune (une adresse, un répartiteur devant) et sa base d'essai s'appelle `rdb`, que la garde des bancs refuse.
 * Celui-ci mesure ce que le serverless CHANGE : les connexions qu'ouvrent ses copies sous charge (le budget de
 * `ops/scaleway/conteneur-api.json`), et un redéploiement en plein trafic, ce que fera chaque déploiement après la
 * bascule.
 *
 * Deux rôles, un fichier, lancés en même temps :
 *  - `BANC_ROLE=charge`, depuis le poste : `/health` (qui touche la base) et `/live` (qui ne la touche pas) en
 *    `BANC_PARALLELE` boucles pendant `BANC_DUREE_S`, avec le jeton d'accès du conteneur privé ; à
 *    `BANC_REDEPLOIEMENT_S` secondes (0 = jamais), un PATCH sans changement le fait redéployer (tout PATCH
 *    redéploie, mesuré le 2026-10-15), et son statut date la relève. 🔴 Il ne tire que sur un conteneur qui se
 *    déclare en `DRY_RUN=true` et dont l'adresse publique est celle visée : la production refuse.
 *  - `BANC_ROLE=releve`, sur la machine des workers, dans l'image, avec le `.env.prod` d'ESSAI : compte chaque
 *    seconde les connexions de la base par adresse cliente, chaque relevé dans une transaction en LECTURE SEULE.
 *
 * Usage :
 *   BANC_CONFIRME=1 BANC_ROLE=charge BANC_CONTENEUR=<id> BANC_JETON=<clé> npx tsx scripts/banc-serverless.mts
 *   docker run --rm --env-file /opt/messagingme/.env.prod -e BANC_ROLE=releve -e BANC_DUREE_S=<s> \
 *     -v <ce fichier>:/app/scripts/banc-serverless.mts:ro <image> npx tsx scripts/banc-serverless.mts
 *
 * 🔴 UN « NON ÉPROUVÉ » NE VAUT PAS UN SUCCÈS : une relève qui n'a pas eu lieu, ou une seule copie là où la charge
 * devait en demander plusieurs, le dit, et le script sort en échec.
 */
import { Client } from 'pg';
import { pgSsl } from '../src/db/ssl';

const ROLE = process.env.BANC_ROLE ?? '';
const DUREE_MS = Number(process.env.BANC_DUREE_S ?? 300) * 1000;

type Issue = 'ok' | 'echec' | 'non_eprouve';
const verdicts: Issue[] = [];
const poser = (nom: string, issue: Issue, dit: string): void => {
  verdicts.push(issue);
  const etiquette = issue === 'ok' ? 'OK   ' : issue === 'echec' ? 'ECHEC' : '?????';
  // eslint-disable-next-line no-console
  console.log(`${etiquette}  ${nom} : ${dit}`);
};
// eslint-disable-next-line no-console
const dire = (m: string): void => console.log(`       ${m}`);
const attendre = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const quantile = (xs: number[], q: number): number => {
  const t = [...xs].sort((x, y) => x - y);
  return t.length === 0 ? 0 : t[Math.min(t.length - 1, Math.floor(q * t.length))]!;
};

// ---------------------------------------------------------------------------------------------------------------
// RÔLE « charge » : le poste tire sur l'adresse publique du conteneur d'essai
// ---------------------------------------------------------------------------------------------------------------
interface Tir { t: number; route: '/health' | '/live'; statut: number | null; erreur: string | null; ms: number }

async function charge(): Promise<void> {
  const conteneur = process.env.BANC_CONTENEUR ?? '';
  const jeton = process.env.BANC_JETON ?? '';
  const region = process.env.BANC_REGION ?? 'nl-ams';
  const parallele = Number(process.env.BANC_PARALLELE ?? 150);
  const redeploiementMs = Number(process.env.BANC_REDEPLOIEMENT_S ?? 60) * 1000;
  if (conteneur === '' || jeton === '') throw new Error('BANC_CONTENEUR et BANC_JETON requis.');
  const api = `https://api.scaleway.com/containers/v1/regions/${region}/containers/${conteneur}`;
  const scw = async (init: RequestInit = {}): Promise<Record<string, unknown>> => {
    const r = await fetch(api, { ...init, headers: { 'x-auth-token': jeton, 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`l'API de Scaleway refuse ${init.method ?? 'GET'} : ${r.status}`);
    return await r.json() as Record<string, unknown>;
  };

  // 🔴 La garde : un conteneur qui se déclare d'essai, et l'adresse qu'il annonce. Jamais un nom de production.
  const fiche = await scw();
  const env = (fiche.environment_variables ?? {}) as Record<string, string>;
  const adresse = String(fiche.public_endpoint ?? '');
  if (env.DRY_RUN !== 'true') throw new Error(`le conteneur ne se declare pas d'essai (DRY_RUN=${env.DRY_RUN ?? 'absent'}) : banc refuse.`);
  if (!/^https:\/\/[a-z0-9-]+\.functions\.fnc\.[a-z0-9-]+\.scw\.cloud$/.test(adresse) || /messagingme\.app/i.test(adresse)) {
    throw new Error(`adresse inattendue (${adresse}) : banc refuse.`);
  }
  const minScale = Number(fiche.min_scale);
  const maxScale = Number(fiche.max_scale);
  dire(`conteneur ${String(fiche.name)} : ${adresse}, ${minScale} a ${maxScale} copie(s), ${fiche.status}, ${parallele} boucles, ${DUREE_MS / 1000} s`);

  const debut = Date.now();
  const fin = debut + DUREE_MS;
  const tirs: Tir[] = [];
  const boucle = async (i: number): Promise<void> => {
    for (let n = 0; Date.now() < fin; n++) {
      const route = (i + n) % 2 === 0 ? '/health' : '/live';
      const t0 = Date.now();
      try {
        const r = await fetch(`${adresse}${route}`, { headers: { 'x-auth-token': jeton }, signal: AbortSignal.timeout(30_000) });
        await r.arrayBuffer();
        tirs.push({ t: t0 - debut, route, statut: r.status, erreur: null, ms: Date.now() - t0 });
      } catch (e) {
        const cause = (e as { cause?: { code?: string } }).cause;
        const erreur = cause?.code ?? (e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : String(e).slice(0, 60));
        tirs.push({ t: t0 - debut, route, statut: null, erreur, ms: Date.now() - t0 });
        await attendre(200);
      }
    }
  };

  // La relève : un PATCH qui ne change rien (min_scale à sa valeur), puis le statut relu toutes les 3 s. Une lecture
  // du statut qui traîne ne doit pas arrêter le banc (vécu au premier lancement : le bilan était perdu) : elle se
  // note et la suivante la remplace.
  const etats: Array<{ t: number; etat: string }> = [];
  let demandeA: number | null = null;
  const surveiller = async (): Promise<void> => {
    if (redeploiementMs > 0) {
      await attendre(Math.max(0, debut + redeploiementMs - Date.now()));
      demandeA = Date.now() - debut;
      await scw({ method: 'PATCH', body: JSON.stringify({ min_scale: minScale }) });
      dire(`redeploiement demande a ${Math.round(demandeA / 1000)} s`);
    }
    while (Date.now() < fin) {
      try {
        const etat = String((await scw()).status);
        if (etats.length === 0 || etats[etats.length - 1]!.etat !== etat) {
          etats.push({ t: Date.now() - debut, etat });
          dire(`statut du conteneur a ${Math.round((Date.now() - debut) / 1000)} s : ${etat}`);
        }
      } catch (e) {
        dire(`statut illisible a ${Math.round((Date.now() - debut) / 1000)} s (${e instanceof Error ? e.message : String(e)})`);
      }
      await attendre(3000);
    }
  };
  await Promise.all([...Array.from({ length: parallele }, (_, i) => boucle(i)), surveiller()]);

  // Le bilan, par tranche de 10 s, puis par fenêtre : avant la relève, pendant, après.
  const echoue = (x: Tir): boolean => x.statut !== 200;
  for (let tranche = 0; tranche * 10_000 < DUREE_MS; tranche++) {
    const ici = tirs.filter((x) => x.t >= tranche * 10_000 && x.t < (tranche + 1) * 10_000);
    const ratees = ici.filter(echoue);
    const causes = [...new Set(ratees.map((x) => x.erreur ?? String(x.statut)))].join(',');
    dire(`${String(tranche * 10).padStart(4)} s : ${String(ici.length).padStart(5)} tirs, ${ratees.length} rate(s)${causes ? ` (${causes})` : ''}, ` +
      `/health p50 ${quantile(ici.filter((x) => x.route === '/health').map((x) => x.ms), 0.5)} ms p99 ${quantile(ici.filter((x) => x.route === '/health').map((x) => x.ms), 0.99)} ms`);
  }
  const ratees = tirs.filter(echoue);
  dire(`total : ${tirs.length} tirs, ${ratees.length} rate(s), /live p99 ${quantile(tirs.filter((x) => x.route === '/live').map((x) => x.ms), 0.99)} ms`);

  if (redeploiementMs === 0) {
    if (ratees.length > 0) poser('charge sans releve', 'echec', `${ratees.length} tir(s) rate(s) : ${[...new Set(ratees.map((x) => x.erreur ?? String(x.statut)))].join(', ')}`);
    else poser('charge sans releve', 'ok', `${tirs.length} tirs, tous en 200`);
    return;
  }
  const enCours = etats.find((e) => e.etat !== 'ready' && e.t >= (demandeA ?? 0));
  const pret = enCours ? etats.find((e) => e.etat === 'ready' && e.t > enCours.t) : undefined;
  if (!enCours || !pret) {
    poser('redeploiement en plein trafic', 'non_eprouve', `aucune releve vue (${etats.map((e) => `${Math.round(e.t / 1000)} s ${e.etat}`).join(', ')}) : allonger BANC_DUREE_S`);
    return;
  }
  const pendant = tirs.filter((x) => x.t >= (demandeA ?? 0) && x.t <= pret.t + 30_000);
  const ratesPendant = pendant.filter(echoue);
  dire(`releve : demandee a ${Math.round((demandeA ?? 0) / 1000)} s, en cours a ${Math.round(enCours.t / 1000)} s, prete a ${Math.round(pret.t / 1000)} s`);
  if (ratesPendant.length > 0) {
    poser('redeploiement en plein trafic', 'echec', `${ratesPendant.length} tir(s) rate(s) sur ${pendant.length} pendant la releve : ` +
      [...new Set(ratesPendant.map((x) => x.erreur ?? String(x.statut)))].join(', '));
  } else poser('redeploiement en plein trafic', 'ok', `${pendant.length} tirs pendant la releve, tous en 200`);
  const avant = tirs.filter((x) => x.t < (demandeA ?? 0));
  if (avant.some(echoue)) poser('charge avant la releve', 'echec', `${avant.filter(echoue).length} tir(s) rate(s) avant toute releve`);
  else poser('charge avant la releve', 'ok', `${avant.length} tirs, tous en 200`);
}

// ---------------------------------------------------------------------------------------------------------------
// RÔLE « releve » : la machine des workers compte les connexions de la base d'essai, en lecture seule
// ---------------------------------------------------------------------------------------------------------------
async function releve(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  const plafondCopie = Number(process.env.BANC_POOL_ATTENDU ?? 14);
  const adresseWorkers = process.env.BANC_ADRESSE_WORKERS ?? '172.16.0.4';
  if (process.env.DRY_RUN !== 'true') throw new Error('le .env.prod ne se declare pas d essai (DRY_RUN) : releve refuse.');
  const c = new Client({ connectionString: url, ssl: pgSsl(url), application_name: 'banc-serverless-releve' });
  await c.connect();
  const lire = async <T extends object>(sql: string, valeurs: unknown[] = []): Promise<T[]> => {
    await c.query('begin read only');
    try { return (await c.query(sql, valeurs)).rows as T[]; } finally { await c.query('rollback'); }
  };
  try {
    const [plafonds] = await lire<{ max: string; reserve: string }>(
      `select current_setting('max_connections') as max, current_setting('superuser_reserved_connections') as reserve`);
    dire(`base : ${plafonds?.max} connexions, dont ${plafonds?.reserve} reservees`);
    const debut = new Date();
    const fin = Date.now() + DUREE_MS;
    const maxParAdresse = new Map<string, number>();
    let maxCopies = 0;
    let maxTotal = 0;
    let ecouteCopies = 0;
    while (Date.now() < fin) {
      const lignes = await lire<{ addr: string; n: string; ecoute: string }>(
        `select host(client_addr) as addr, count(*) as n, count(*) filter (where query ilike 'listen%') as ecoute
         from pg_stat_activity where datname = current_database() and client_addr is not null group by 1`);
      let total = 0;
      let copies = 0;
      for (const l of lignes) {
        total += Number(l.n);
        maxParAdresse.set(l.addr, Math.max(maxParAdresse.get(l.addr) ?? 0, Number(l.n)));
        if (l.addr !== adresseWorkers) { copies++; ecouteCopies = Math.max(ecouteCopies, Number(l.ecoute)); }
      }
      maxCopies = Math.max(maxCopies, copies);
      maxTotal = Math.max(maxTotal, total);
      dire(`${new Date().toISOString().slice(11, 19)} ${lignes.map((l) => `${l.addr}=${l.n}`).join(' ')} (total ${total})`);
      await attendre(1000);
    }
    const nomsCopies = await lire<{ process: string }>(
      `select distinct process from pool_attentes where minute >= date_trunc('minute', $1::timestamptz) and process like 'api%' order by 1`, [debut]);
    dire(`copies nommees dans pool_attentes : ${nomsCopies.map((x) => x.process).join(', ') || 'aucune'}`);
    dire(`au plus : ${[...maxParAdresse].map(([a, n]) => `${a}=${n}`).join(' ')}, ${maxCopies} adresse(s) de copie a la fois, total ${maxTotal}`);

    const copies = [...maxParAdresse].filter(([a]) => a !== adresseWorkers);
    if (copies.length === 0) poser('connexions par copie', 'non_eprouve', 'aucune connexion venue d une copie de l API');
    else if (copies.some(([, n]) => n > plafondCopie)) poser('connexions par copie', 'echec', `une adresse depasse ${plafondCopie} : ${copies.map(([a, n]) => `${a}=${n}`).join(' ')}`);
    else poser('connexions par copie', 'ok', `${copies.map(([a, n]) => `${a}=${n}`).join(' ')}, toutes sous ${plafondCopie}`);
    const budget = Number(plafonds?.max ?? 0) - Number(plafonds?.reserve ?? 0);
    if (maxTotal > budget) poser('total sous le plafond de la base', 'echec', `${maxTotal} connexions pour ${budget} ouvertes`);
    else poser('total sous le plafond de la base', 'ok', `au plus ${maxTotal} connexions sur ${budget}`);
    if (ecouteCopies > 0) poser('aucune ecoute cote API', 'echec', `${ecouteCopies} connexion(s) en LISTEN depuis une copie`);
    else poser('aucune ecoute cote API', 'ok', 'aucune connexion en LISTEN depuis les copies : seul le worker ecoute');
  } finally {
    await c.end();
  }
}

async function main(): Promise<void> {
  if (process.env.BANC_CONFIRME !== '1') throw new Error('BANC_CONFIRME=1 manquant : ce banc charge et redeploie le conteneur d essai.');
  if (ROLE === 'charge') await charge();
  else if (ROLE === 'releve') await releve();
  else throw new Error('BANC_ROLE parmi charge, releve');
}

main()
  .then(() => {
    const echecs = verdicts.filter((v) => v === 'echec').length;
    const inconnus = verdicts.filter((v) => v === 'non_eprouve').length;
    // eslint-disable-next-line no-console
    console.log(`\nBILAN ${ROLE} : ${verdicts.length - echecs - inconnus} ok, ${echecs} echec(s), ${inconnus} non eprouve(s).`);
    if (echecs > 0 || inconnus > 0) process.exit(1);
  })
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error('BANC EN ECHEC :', e instanceof Error ? e.message : e);
    process.exit(1);
  });
