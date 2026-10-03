/**
 * SECOND BANC À DEUX COPIES D'API (plan `docs/superpowers/plans/2026-10-03-second-banc-deux-api.md`).
 *
 * Le premier banc (`scripts/banc-deux-api.mts`) a prouvé les clés, leur révocation et le plafond global. Celui-ci
 * éprouve ce qui reste, et qui ne dépend que du CODE : l'idempotence des envois entre copies, l'arrêt d'une copie
 * en plein trafic, la réception des webhooks quand le pool sature, et les connexions qu'une copie ouvre.
 *
 * 🔴 UNE ÉPREUVE PAR LANCEMENT (`BANC_EPREUVE`), parce que deux d'entre elles exigent un geste que ce script ne
 * peut pas faire : arrêter une copie se commande depuis l'hôte (`docker stop` ou `docker kill banc-api-a`)
 * PENDANT que l'épreuve `arret` tire. Le montage est celui du premier banc (sa recette est en tête de
 * `scripts/banc-deux-api.mts`), avec, sur les deux copies : `API_COPIE=a` ou `b`, `DB_POOL_MAX=3` (la pression
 * vient de là), `API_PLAFOND_MINUTE=0` et `API_PLAFOND_HEURE=0` (le plafond par espace a été prouvé par le
 * premier banc ; ici il ne ferait que refuser les tirs).
 *
 * Usage (jamais contre la production, cf. les gardes) :
 *   BANC_CONFIRME=1 BANC_EPREUVE=idempotence BANC_API_A=http://banc-api-a:8095 BANC_API_B=http://banc-api-b:8095 \
 *     DATABASE_URL=postgres://...base-jetable... META_APP_SECRET=<celui du banc> npx tsx scripts/banc-deux-api-2.mts
 *
 * 🔴 UN « NON ÉPROUVÉ » NE VAUT PAS UN SUCCÈS : une épreuve dont la condition n'a pas été réunie (aucune attente de
 * pool, aucune requête en vol au moment de l'arrêt) le dit, et le script sort en échec.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { Pool } from 'pg';
import { PgApiKeyStore } from '../src/auth/api-key-store.pg';
import { PgWorkflowStore } from '../src/workflow/store.pg';
import { DUREE_CLE_EN_COURS_MAX_MS } from '../src/api/idempotence';

const A = process.env.BANC_API_A ?? '';
const B = process.env.BANC_API_B ?? '';
const URL_BASE = process.env.DATABASE_URL ?? '';
const EPREUVE = process.env.BANC_EPREUVE ?? '';
const SECRET_META = process.env.META_APP_SECRET ?? '';
const DUREE_MS = Number(process.env.BANC_DUREE_S ?? 20) * 1000;
const POOL_MAX = Number(process.env.BANC_POOL_MAX ?? 3);
const SCHEMA_BOSS = process.env.PGBOSS_SCHEMA ?? 'pgboss';

if (process.env.BANC_CONFIRME !== '1') throw new Error('BANC_CONFIRME=1 manquant : ce banc envoie, arrete des copies et sature un pool.');
if (URL_BASE === '') throw new Error('DATABASE_URL manquant');
if (/supabase/i.test(URL_BASE)) throw new Error('DATABASE_URL ressemble a la PRODUCTION : banc interdit.');
for (const [nom, url] of [['BANC_API_A', A], ['BANC_API_B', B]] as const) {
  if (url === '') throw new Error(`${nom} manquant`);
  if (/messagingme\.app/i.test(url)) throw new Error(`${nom} ressemble a la PRODUCTION : banc interdit.`);
}
const EPREUVES = ['idempotence', 'arret', 'pression', 'connexions'] as const;
if (!(EPREUVES as readonly string[]).includes(EPREUVE)) throw new Error(`BANC_EPREUVE parmi ${EPREUVES.join(', ')}`);

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

// ---------------------------------------------------------------------------------------------------------------
// HTTP : une réponse, ou la cause réseau. La distinction « refusée » / « coupée » est tout l'enjeu de `arret` :
// une requête refusée n'a jamais atteint la copie, une requête coupée l'a peut-être traitée à moitié.
// ---------------------------------------------------------------------------------------------------------------
type Reponse = { statut: number; corps: Record<string, unknown> | null; ms: number } | { erreur: string; ms: number };
const REFUSEES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
const estRefusee = (e: string): boolean => REFUSEES.has(e);

async function requete(url: string, init: RequestInit, delaiMs = 20_000): Promise<Reponse> {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(delaiMs) });
    const texte = await r.text();
    let corps: Record<string, unknown> | null = null;
    try { corps = texte ? JSON.parse(texte) as Record<string, unknown> : null; } catch { corps = null; }
    return { statut: r.status, corps, ms: Date.now() - t0 };
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    const code = cause?.code ?? (e instanceof Error && e.name === 'TimeoutError' ? 'timeout' : (cause?.message ?? String(e)));
    return { erreur: code, ms: Date.now() - t0 };
  }
}

const json = (cle: string): Record<string, string> => ({ authorization: `Bearer ${cle}`, 'content-type': 'application/json' });

// ---------------------------------------------------------------------------------------------------------------
// PRÉPARATION, par le VRAI code et la vraie API (comme le premier banc) : une clé neuve à chaque lancement (on
// ne garde que son empreinte, on ne peut pas la relire), un scénario publié qui ouvre par un message rapide,
// des contacts créés par `POST /v1/contacts`, et leur fenêtre de 24 h ouverte par un message entrant.
// ---------------------------------------------------------------------------------------------------------------
const NOM_SCENARIO = 'banc2 message rapide';
// `nod_<client>_<26 caracteres Crockford>`, la forme que minte la console (I, L, O et U exclus).
const CODE_BLOC = 'nod_banc2_01JBANC2QQQQQQQQQQQQQQQQQQ';
const TELEPHONES = Array.from({ length: 5 }, (_, i) => `3361000${String(9001 + i)}`);

interface Banc { pool: Pool; espace: string; cle: string; numero: string }

async function preparer(): Promise<Banc> {
  const pool = new Pool({ connectionString: URL_BASE, max: 2, application_name: 'banc2-script' });
  const espace = process.env.BANC_TENANT
    ?? (await pool.query<{ id: string }>('select id from tenants order by created_at limit 1')).rows[0]?.id;
  if (!espace) throw new Error('aucun espace en base : lancer `npm run seed` sur la base jetable d abord.');
  const numero = (await pool.query<{ id: string }>('select id from phone_numbers where tenant_id = $1 limit 1', [espace])).rows[0]?.id;
  if (!numero) throw new Error('aucun numero sur l espace : le seed en pose un.');

  const cle = (await new PgApiKeyStore(pool).create(espace, `banc2 ${EPREUVE}`, ['contacts:read', 'contacts:write', 'sends:create'])).key;

  const existe = await pool.query('select 1 from workflows where tenant_id = $1 and name = $2', [espace, NOM_SCENARIO]);
  if (existe.rowCount === 0) {
    const scenarios = new PgWorkflowStore(pool);
    const { id } = await scenarios.insert(espace, NOM_SCENARIO, {
      nodes: [{ id: 'n1', type: 'quick_message', position: { x: 0, y: 0 }, data: { code: CODE_BLOC, body: 'Message du banc' } }],
      edges: [],
    });
    await scenarios.publish(id, espace);
  }

  for (const tel of TELEPHONES) {
    const r = await requete(`${A}/v1/contacts`, { method: 'POST', headers: json(cle), body: JSON.stringify({ phone: `+${tel}` }) });
    if (!('statut' in r) || r.statut !== 200) throw new Error(`contact ${tel} non cree : ${JSON.stringify(r)}`);
    // La fenetre de 24 h : sans message entrant recent, un message rapide ne part pas, et l'envoi serait refuse.
    await pool.query(
      `with c as (
         insert into conversations (tenant_id, wa_id) select $1, $2
         where not exists (select 1 from conversations where tenant_id = $1 and wa_id = $2)
         returning id
       ), conv as (select id from c union all select id from conversations where tenant_id = $1 and wa_id = $2 limit 1)
       insert into conversation_messages (conversation_id, direction, type, body)
       select id, 'in', 'text', 'banc2' from conv limit 1`,
      [espace, tel],
    );
  }
  return { pool, espace, cle, numero };
}

const corpsEnvoi = (cle: string, i: number): string => JSON.stringify({
  idempotencyKey: cle,
  target: { node: CODE_BLOC },
  category: 'utility',
  recipients: [{ phone: `+${TELEPHONES[i % TELEPHONES.length]}` }],
});
const envoyer = (base: string, b: Banc, cleIdem: string, i: number): Promise<Reponse> =>
  requete(`${base}/v1/sends`, { method: 'POST', headers: json(b.cle), body: corpsEnvoi(cleIdem, i) });

/** Rejoue tant que la réponse est 409 « en cours » ou 429 « place occupée », au plus `essais` fois. */
async function rejouer(base: string, b: Banc, cleIdem: string, i: number, essais = 8): Promise<Reponse> {
  let r = await envoyer(base, b, cleIdem, i);
  for (let n = 1; n < essais && 'statut' in r && (r.statut === 409 || r.statut === 429); n++) {
    await attendre(r.statut === 429 ? 2000 : 1000);
    r = await envoyer(base, b, cleIdem, i);
  }
  return r;
}

const sendIdDe = (r: Reponse): string | null =>
  'statut' in r && r.statut === 201 && typeof r.corps?.sendId === 'string' ? r.corps.sendId : null;

// ---------------------------------------------------------------------------------------------------------------
// ÉPREUVE 1 : la même clé d'idempotence tirée EN MÊME TEMPS sur les deux copies
// ---------------------------------------------------------------------------------------------------------------
async function idempotence(b: Banc): Promise<void> {
  const run = randomUUID().slice(0, 8);
  const N = 10;
  const avant = Number((await b.pool.query<{ n: string }>('select count(*) as n from campaigns where tenant_id = $1', [b.espace])).rows[0]!.n);
  let doubles = 0;
  let sansEnvoi = 0;
  let concurrents = 0;
  for (let i = 0; i < N; i++) {
    const cle = `banc2-idem-${run}-${i}`;
    const [ra, rb] = await Promise.all([envoyer(A, b, cle, i), envoyer(B, b, cle, i)]);
    // Une 409 « en cours » ou une 429 « place occupée » est la bonne réponse du perdant : on la rejoue jusqu'au
    // rapport, qui doit alors porter le MÊME envoi.
    const fa = 'statut' in ra && (ra.statut === 409 || ra.statut === 429) ? await rejouer(A, b, cle, i) : ra;
    const fb = 'statut' in rb && (rb.statut === 409 || rb.statut === 429) ? await rejouer(B, b, cle, i) : rb;
    if ('statut' in ra && 'statut' in rb && (ra.statut === 409 || rb.statut === 409)) concurrents++;
    const ids = new Set([sendIdDe(fa), sendIdDe(fb)].filter((x): x is string => x !== null));
    if (ids.size > 1) doubles++;
    if (ids.size === 0) { sansEnvoi++; dire(`cle ${i} : aucun envoi, A ${JSON.stringify(fa).slice(0, 160)} B ${JSON.stringify(fb).slice(0, 160)}`); }
  }
  const apres = Number((await b.pool.query<{ n: string }>('select count(*) as n from campaigns where tenant_id = $1', [b.espace])).rows[0]!.n);
  const crees = apres - avant;
  const dit = `${N} cles, ${crees} envoi(s) cree(s) en base, ${concurrents} course(s) vue(s) en 409, ${doubles} cle(s) a deux envois`;
  if (sansEnvoi > 0) poser('une cle, un envoi, entre deux copies', 'non_eprouve', `${dit}, ${sansEnvoi} cle(s) sans aucun envoi`);
  else if (doubles > 0 || crees !== N) poser('une cle, un envoi, entre deux copies', 'echec', dit);
  else poser('une cle, un envoi, entre deux copies', 'ok', dit);
}

// ---------------------------------------------------------------------------------------------------------------
// ÉPREUVE 2 : une copie arrêtée en plein trafic (le geste vient de l'hôte, pendant le tir)
// ---------------------------------------------------------------------------------------------------------------
interface Tir { copie: 'A' | 'B'; cle: string; i: number; r: Reponse }

async function arret(b: Banc): Promise<void> {
  const mode = process.env.BANC_ARRET ?? 'inconnu';
  const run = randomUUID().slice(0, 8);
  const debut = new Date();
  const tirs: Tir[] = [];
  const fin = Date.now() + DUREE_MS;
  let n = 0;
  // Une boucle par copie : `API_MAX_LOURDES_SIMULTANEES` vaut 1, donc deux envois en vol sur la même copie se
  // refuseraient l'un l'autre (429) sans rien éprouver.
  const boucle = async (copie: 'A' | 'B'): Promise<void> => {
    while (Date.now() < fin) {
      const i = n++;
      const cle = `banc2-arret-${run}-${i}`;
      const r = await envoyer(copie === 'A' ? A : B, b, cle, i);
      tirs.push({ copie, cle, i, r });
      if ('statut' in r && r.statut === 429) await attendre(2000);
      // A arrêtée : on ne martèle pas un port fermé, on garde une cadence pour dater l'arrêt.
      if ('erreur' in r) await attendre(200);
    }
  };
  // eslint-disable-next-line no-console
  console.log(`TIR ${mode} : ${DUREE_MS / 1000} s, arreter banc-api-a PENDANT ce tir`);
  await Promise.all([boucle('A'), boucle('B')]);

  const acquittes = tirs.filter((t) => sendIdDe(t.r) !== null);
  const coupes = tirs.filter((t) => t.copie === 'A' && 'erreur' in t.r && !estRefusee(t.r.erreur));
  const refusesA = tirs.filter((t) => t.copie === 'A' && 'erreur' in t.r && estRefusee(t.r.erreur));
  const anomaliesB = tirs.filter((t) => t.copie === 'B' && !(('statut' in t.r) && (t.r.statut === 201 || t.r.statut === 429)));
  dire(`${tirs.length} tirs : ${acquittes.length} acquittes, A coupees ${coupes.length}, A refusees ${refusesA.length}, B anormales ${anomaliesB.length}`);
  for (const t of coupes) dire(`coupee : ${t.cle} (${'erreur' in t.r ? t.r.erreur : ''})`);

  if (refusesA.length === 0 && coupes.length === 0) {
    poser(`arret ${mode} : la copie a-t-elle ete arretee ?`, 'non_eprouve', 'aucune requete de A n a echoue : l arret n a pas eu lieu pendant le tir');
    return;
  }

  // Ce qui a été acquitté doit exister en base, des deux côtés de la clé.
  let perdus = 0;
  for (const t of acquittes) {
    const id = sendIdDe(t.r)!;
    const q = await b.pool.query(
      `select 1 from campaigns c join api_idempotency k on k.send_id = c.id
       where c.id = $1::uuid and c.tenant_id = $2 and k.idempotency_key = $3`,
      [id, b.espace, t.cle],
    );
    if (q.rowCount === 0) perdus++;
  }
  if (perdus > 0) poser(`arret ${mode} : rien d acquitte n est perdu`, 'echec', `${perdus} envoi(s) acquitte(s) sans trace en base`);
  else poser(`arret ${mode} : rien d acquitte n est perdu`, 'ok', `${acquittes.length} envois acquittes, tous en base avec leur cle`);

  if (anomaliesB.length > 0) {
    poser(`arret ${mode} : l autre copie ne voit rien`, 'echec', anomaliesB.map((t) => JSON.stringify(t.r).slice(0, 120)).join(' | '));
  } else poser(`arret ${mode} : l autre copie ne voit rien`, 'ok', 'B a rendu 201 (ou 429 de place occupee) a chaque tir');

  // 🔴 Les requêtes coupées, rejouées sur B avec la même clé : c'est ce que fait un client correct. La seule issue
  // fautive est une clé restée « en cours » (409) alors que plus personne ne la traite.
  if (coupes.length === 0) {
    poser(`arret ${mode} : une requete coupee se rejoue`, mode === 'propre' ? 'ok' : 'non_eprouve',
      mode === 'propre' ? 'aucune requete coupee : l arret propre a laisse finir ce qui etait en vol' : 'aucune requete en vol au moment de l arret, relancer');
    return;
  }
  let coincees = 0;
  let apresBail = 0;
  const issues: string[] = [];
  const etatCle = async (cle: string): Promise<{ send_id: string | null; age_ms: string } | undefined> => (await b.pool.query<{ send_id: string | null; age_ms: string }>(
    `select send_id, round(extract(epoch from now() - created_at) * 1000) as age_ms from api_idempotency where tenant_id = $1 and idempotency_key = $2`,
    [b.espace, cle],
  )).rows[0];
  for (const t of coupes) {
    let r = await rejouer(B, b, t.cle, t.i);
    let ligne = await etatCle(t.cle);
    issues.push(`${t.cle} -> ${'statut' in r ? r.statut : r.erreur} (cle en base : ${ligne ? (ligne.send_id ?? 'SANS ENVOI') : 'absente'})`);
    // 🔴 Toujours « en cours » : la pose est orpheline. Le bail (`DUREE_CLE_EN_COURS_MAX_MS`) doit la libérer ; on
    // attend qu'il soit passé, à l'heure de la BASE (l'âge qu'elle donne), puis on rejoue la même clé.
    if ('statut' in r && r.statut === 409 && ligne && ligne.send_id === null) {
      const attente = Math.max(0, DUREE_CLE_EN_COURS_MAX_MS - Number(ligne.age_ms)) + 3000;
      dire(`${t.cle} : pose orpheline, on attend la fin du bail (${Math.round(attente / 1000)} s)`);
      await attendre(attente);
      r = await rejouer(B, b, t.cle, t.i);
      ligne = await etatCle(t.cle);
      issues.push(`${t.cle} apres le bail -> ${'statut' in r ? r.statut : r.erreur} (cle en base : ${ligne ? (ligne.send_id ?? 'SANS ENVOI') : 'absente'})`);
      if (sendIdDe(r) !== null) apresBail++;
    }
    if ('statut' in r && r.statut === 409) coincees++;
  }
  for (const s of issues) dire(s);
  if (coincees > 0) poser(`arret ${mode} : une requete coupee se rejoue`, 'echec', `${coincees} cle(s) restee(s) EN COURS : le client recoit 409 sans fin`);
  else poser(`arret ${mode} : une requete coupee se rejoue`, 'ok', `${coupes.length} requete(s) coupee(s), toutes abouties (dont ${apresBail} une fois le bail passe)`);

  // 🔴 Une campagne créée par la copie tuée, sans clé qui la désigne, ne doit JAMAIS avoir été lancée : la clé
  // reprise a créé la sienne, et lancer les deux enverrait deux fois.
  // « Lancée » se juge sur les DESTINATAIRES et pas sur le statut : une campagne d'API enfilée reste `draft` tant
  // que son run n'a pas démarré, alors qu'un destinataire sorti de `pending` prouve qu'elle est partie.
  const orphelines = await b.pool.query<{ id: string; status: string; partie: boolean }>(
    `select c.id, c.status,
            exists (select 1 from campaign_recipients r where r.campaign_id = c.id and r.status <> 'pending') as partie
     from campaigns c
     where c.tenant_id = $1 and c.created_at >= $2
       and not exists (select 1 from api_idempotency k where k.tenant_id = c.tenant_id and k.send_id = c.id)`,
    [b.espace, debut],
  );
  const lancees = orphelines.rows.filter((o) => o.partie || o.status !== 'draft');
  // 🔴 Depuis que la campagne et le scellement de sa clé naissent dans UNE transaction, il ne doit plus en exister
  // AUCUNE, lancée ou non : une seule orpheline dirait que le scellement est ressorti de la transaction.
  if (lancees.length > 0) poser(`arret ${mode} : aucune campagne orpheline`, 'echec', `LANCEE(S) : ${lancees.map((o) => `${o.id} ${o.status}`).join(', ')}`);
  else if (orphelines.rows.length > 0) poser(`arret ${mode} : aucune campagne orpheline`, 'echec', `${orphelines.rows.length} orpheline(s) en brouillon : ${orphelines.rows.map((o) => o.id).join(', ')}`);
  else poser(`arret ${mode} : aucune campagne orpheline`, 'ok', 'aucune campagne sans la cle qui la designe');
}

// ---------------------------------------------------------------------------------------------------------------
// ÉPREUVE 3 : la réception des webhooks quand le pool de la copie sature
// ---------------------------------------------------------------------------------------------------------------
function webhook(numero: string, wamid: string, waId: string): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'banc2', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '33100000000', phone_number_id: numero },
      contacts: [{ wa_id: waId, profile: { name: 'Banc' } }],
      messages: [{ from: waId, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'banc2' } }],
    } }] }],
  });
}
const quantile = (xs: number[], q: number): number => {
  const t = [...xs].sort((x, y) => x - y);
  return t.length === 0 ? 0 : t[Math.min(t.length - 1, Math.floor(q * t.length))]!;
};

async function pression(b: Banc): Promise<void> {
  if (SECRET_META === '') throw new Error('META_APP_SECRET manquant : celui du banc, pour signer les webhooks.');
  const run = randomUUID().slice(0, 8);
  const debut = new Date();
  const fin = Date.now() + DUREE_MS;
  const lecteurs = Number(process.env.BANC_LECTEURS ?? 24);
  let lectures = 0;
  const lire = async (): Promise<void> => {
    while (Date.now() < fin) { await requete(`${A}/v1/scenarios`, { headers: json(b.cle) }); lectures++; }
  };
  const recus: Reponse[] = [];
  const signer = async (): Promise<void> => {
    for (let i = 0; Date.now() < fin; i++) {
      const corps = webhook(b.numero, `wamid.banc2.${run}.${i}`, TELEPHONES[i % TELEPHONES.length]!);
      const sig = `sha256=${createHmac('sha256', SECRET_META).update(corps).digest('hex')}`;
      recus.push(await requete(`${A}/webhooks/meta`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: corps }));
      await attendre(250);
    }
  };
  await Promise.all([...Array.from({ length: lecteurs }, lire), signer()]);

  const ok = recus.filter((r) => 'statut' in r && r.statut === 200);
  const ms = recus.map((r) => r.ms);
  const enfiles = Number((await b.pool.query<{ n: string }>(
    `select count(*) as n from ${SCHEMA_BOSS}.job where name in ('webhook', 'webhook-status') and data::text like $1`,
    [`%wamid.banc2.${run}.%`],
  )).rows[0]!.n);
  dire(`${lectures} lectures en rafale sur A (${lecteurs} en parallele), ${recus.length} webhooks : ${ok.length} acquittes, ${enfiles} enfiles`);
  dire(`accuse des webhooks : p50 ${quantile(ms, 0.5)} ms, p95 ${quantile(ms, 0.95)} ms, max ${Math.max(0, ...ms)} ms`);

  // La pression était-elle réelle ? Les attentes se versent une fois par minute, sous le nom de la copie.
  let attentes = -1;
  for (let essai = 0; essai < 15 && attentes <= 0; essai++) {
    const q = await b.pool.query<{ a: string | null }>(
      `select sum(attentes) as a from pool_attentes where process = 'api-a' and minute >= date_trunc('minute', $1::timestamptz)`,
      [debut],
    );
    attentes = Number(q.rows[0]?.a ?? 0);
    if (attentes <= 0) await attendre(5000);
  }
  dire(`attentes de pool versees sous api-a : ${attentes}`);

  const nonAcquittes = recus.length - ok.length;
  if (attentes <= 0) poser('webhooks sous pression de pool', 'non_eprouve', 'aucune attente de pool sous api-a : la pression n a pas eu lieu, ou le nom de la copie manque');
  else if (nonAcquittes > 0) {
    const causes = recus.filter((r) => !('statut' in r && r.statut === 200)).map((r) => ('statut' in r ? String(r.statut) : r.erreur));
    poser('webhooks sous pression de pool', 'echec', `${nonAcquittes} webhook(s) non acquitte(s) : ${[...new Set(causes)].join(', ')}`);
  } else if (enfiles !== ok.length) poser('webhooks sous pression de pool', 'echec', `${ok.length} acquittes mais ${enfiles} enfiles : un accuse sans tache`);
  else poser('webhooks sous pression de pool', 'ok', `${ok.length} acquittes et enfiles malgre ${attentes} attente(s) de pool`);
}

// ---------------------------------------------------------------------------------------------------------------
// ÉPREUVE 4 : les connexions qu'une copie ouvre, au repos et sous charge
// ---------------------------------------------------------------------------------------------------------------
async function connexions(b: Banc): Promise<void> {
  const ip = async (url: string): Promise<string> => (await lookup(new URL(url).hostname)).address;
  const [ipA, ipB] = [await ip(A), await ip(B)];
  const releve = async (): Promise<Map<string, { n: number; ecoute: number }>> => {
    const q = await b.pool.query<{ addr: string; n: string; ecoute: string }>(
      `select host(client_addr) as addr, count(*) as n, count(*) filter (where query ilike 'listen%') as ecoute
       from pg_stat_activity where datname = current_database() and client_addr is not null group by 1`,
    );
    return new Map(q.rows.map((r) => [r.addr, { n: Number(r.n), ecoute: Number(r.ecoute) }]));
  };
  const repos = await releve();
  dire(`au repos : ${[...repos].map(([a, v]) => `${a === ipA ? 'A' : a === ipB ? 'B' : a} ${v.n} (ecoute ${v.ecoute})`).join(', ')}`);

  const fin = Date.now() + Math.min(DUREE_MS, 10_000);
  const max = { A: 0, B: 0, ecouteA: 0, ecouteB: 0 };
  const tirer = async (base: string): Promise<void> => { while (Date.now() < fin) await requete(`${base}/v1/scenarios`, { headers: json(b.cle) }); };
  const relever = async (): Promise<void> => {
    while (Date.now() < fin) {
      const r = await releve();
      max.A = Math.max(max.A, r.get(ipA)?.n ?? 0);
      max.B = Math.max(max.B, r.get(ipB)?.n ?? 0);
      max.ecouteA = Math.max(max.ecouteA, r.get(ipA)?.ecoute ?? 0);
      max.ecouteB = Math.max(max.ecouteB, r.get(ipB)?.ecoute ?? 0);
      await attendre(300);
    }
  };
  await Promise.all([...Array.from({ length: 12 }, () => tirer(A)), ...Array.from({ length: 12 }, () => tirer(B)), relever()]);
  dire(`sous charge, au plus : A ${max.A}, B ${max.B} (DB_POOL_MAX attendu ${POOL_MAX})`);

  if (max.A === 0 || max.B === 0) poser('connexions par copie', 'non_eprouve', 'une copie n a ouvert aucune connexion visible');
  else if (max.A > POOL_MAX || max.B > POOL_MAX) poser('connexions par copie', 'echec', `une copie depasse son pool : A ${max.A}, B ${max.B}, plafond ${POOL_MAX}`);
  else poser('connexions par copie', 'ok', `A ${max.A}, B ${max.B}, toutes deux sous leur plafond de ${POOL_MAX}`);
  if (max.ecouteA > 0 || max.ecouteB > 0) poser('aucune ecoute cote API', 'echec', `A ${max.ecouteA}, B ${max.ecouteB} connexion(s) en LISTEN`);
  else poser('aucune ecoute cote API', 'ok', 'aucune connexion en LISTEN depuis les copies : seul le worker ecoute');
}

async function main(): Promise<void> {
  const b = await preparer();
  try {
    if (EPREUVE === 'idempotence') await idempotence(b);
    else if (EPREUVE === 'arret') await arret(b);
    else if (EPREUVE === 'pression') await pression(b);
    else await connexions(b);
  } finally {
    await b.pool.end();
  }
}

main()
  .then(() => {
    const echecs = verdicts.filter((v) => v === 'echec').length;
    const inconnus = verdicts.filter((v) => v === 'non_eprouve').length;
    // eslint-disable-next-line no-console
    console.log(`\nBILAN ${EPREUVE} : ${verdicts.length - echecs - inconnus} ok, ${echecs} echec(s), ${inconnus} non eprouve(s).`);
    if (echecs > 0 || inconnus > 0) process.exit(1);
  })
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error('BANC EN ECHEC :', e instanceof Error ? e.message : e);
    process.exit(1);
  });
