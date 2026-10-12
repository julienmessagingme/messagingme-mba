/**
 * LE BANC DE L'API PUBLIQUE (lot 14, livraison B ; spec `docs/superpowers/specs/2026-10-12-tenue-en-charge-design.md`).
 *
 * Ce qu'il mesure : ce que tient UNE copie de l'API quand cent espaces appellent `/v1` et `/mcp` en même temps, pendant
 * que Meta envoie ses webhooks. Il sème 100 espaces (la moitié en Base, la moitié en Entreprise), chacun avec sa clé,
 * puis envoie un trafic mêlé (lecture des fils, écriture d'une fiche, lot de dix fiches, appel MCP) par paliers de débit
 * global croissants, avec des webhooks de Meta signés à débit fixe. À chaque palier : p95 et erreurs par famille vus du
 * client, latence de la réception de Meta ; à la fin, ce que la production lirait (`http_latences`, `pool_attentes`,
 * l'âge des files) et ce que la veille de charge en dirait.
 *
 * Le verdict : la capacité C est le plus haut palier où le p95 de `/v1` reste sous 1 s, sans aucun 5xx ni erreur
 * réseau, et où la réception de Meta reste sous 2 s. Le plafond global se pose à 70 % de C (en appels par 10 s).
 *
 * Les épreuves (`BANC_EPREUVE`) :
 * - `semer` : les 100 espaces `banc14-NNN`, leurs numéros, 20 fiches chacun et une clé par espace, dérivée de
 *   `BANC_SECRET` (le script la recalcule, rien n'est affiché) ;
 * - `paliers` : les paliers `BANC_PALIERS` (appels par seconde), `BANC_PALIER_S` secondes chacun ;
 * - `statuts` : une rafale d'accusés de livraison (`webhook-status`) à `BANC_STATUTS_PAR_S` pendant 10 s, au-delà de
 *   ce que le pool de deux connexions de la réception accuse (environ 200 par seconde à 10 ms de la base) ;
 * - `plafond` : un palier au-dessus du plafond global, l'API relancée avec `API_PLAFOND_GLOBAL_PAR_10S` posé : les Free
 *   doivent recevoir le 429 de la plateforme en premier, et la ligne chaude du compteur se mesure.
 *
 * 🔴 IL NE TOUCHE JAMAIS LA PRODUCTION : `BANC_CONFIRME=1` est exigé, une `DATABASE_URL` de Supabase est refusée, et
 * l'API visée doit répondre sur un nom du banc. Le montage, la mesure et le démontage sont dans `scripts/banc-api.sh`,
 * lancé par Julien (son accord à ce moment-là) ; tous les conteneurs portent l'étiquette `banc=api14`.
 *
 * 🔴 CE QUE LE BANC NE REPRODUIT PAS : le pooler de Supabase (ses files d'attente muettes, son « Pool Size » partagé),
 * une base Micro peuplée, TLS, l'envoi réel chez Meta (`DRY_RUN=true`), les agents et l'analyse. Seul le délai réseau
 * vers la base est fidèle (10 ms, `tc netem`). La mesure est donc OPTIMISTE, d'où les 70 %.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PgHttpLatencesStore } from '../src/ops/latence-http.pg';
import { PgPoolAttentesStore } from '../src/ops/pool-attentes.pg';
import { PgOpsStore } from '../src/ops/store.pg';
import { PgCompteurDebit } from '../src/db/debit.pg';
import { creerVeilleCharge } from '../src/ops/veille-charge';
import { CLE_REFUS_GLOBAL } from '../src/auth/plafond-global';
import { sendTelegram } from '../src/ops/telegram';

const API = process.env.BANC_API ?? '';
const URL_BASE = process.env.DATABASE_URL ?? '';
const EPREUVE = process.env.BANC_EPREUVE ?? '';
const SECRET_BANC = process.env.BANC_SECRET ?? '';
const SECRET_META = process.env.META_APP_SECRET ?? '';
const ESPACES = 100;
const FICHES = 20;
const PALIERS = (process.env.BANC_PALIERS ?? '10,25,50,75,100,150').split(',').map(Number).filter((n) => n > 0);
const PALIER_MS = Number(process.env.BANC_PALIER_S ?? 60) * 1000;
const WEBHOOKS_PAR_S = Number(process.env.BANC_WEBHOOKS_PAR_S ?? 5);
const STATUTS_PAR_S = Number(process.env.BANC_STATUTS_PAR_S ?? 300);
const SCHEMA_BOSS = process.env.PGBOSS_SCHEMA ?? 'pgboss';
/** Les alertes de la veille partent sur Telegram, préfixées, seulement si demandé (essai réel 91). */
const TELEGRAM = process.env.BANC_TELEGRAM === '1';

const SEUIL_P95_V1_MS = 1_000;
const SEUIL_P95_RECEPTION_MS = 2_000;

function garde(): void {
  if (process.env.BANC_CONFIRME !== '1') throw new Error('BANC_CONFIRME=1 requis : ce banc sème cent espaces.');
  if (/supabase/i.test(URL_BASE)) throw new Error('DATABASE_URL ressemble à la PRODUCTION (supabase) : refusé.');
  if (URL_BASE === '') throw new Error('DATABASE_URL manquant');
  if (!/^http:\/\/banc14-/.test(API)) throw new Error('BANC_API doit viser un conteneur du banc (http://banc14-...)');
  if (SECRET_BANC.length < 32 || SECRET_META === '') throw new Error('BANC_SECRET (32+) et META_APP_SECRET requis');
}

const dire = (m: string): void => console.log(`       ${m}`);
const attendre = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const quantile = (xs: number[], q: number): number => {
  const t = [...xs].sort((x, y) => x - y);
  return t.length === 0 ? 0 : t[Math.min(t.length - 1, Math.max(0, Math.ceil(q * t.length) - 1))]!;
};

/** La clé d'un espace : 43 caractères dérivés du secret du banc, au format des vraies (`mba_` + base64url). */
const cleDe = (rang: number): string => `mba_${createHmac('sha256', SECRET_BANC).update(`cle-${rang}`).digest('base64url').slice(0, 43)}`;
const nomDe = (rang: number): string => `banc14-${String(rang).padStart(3, '0')}`;
const numeroDe = (rang: number): string => `banc14-pn-${String(rang).padStart(3, '0')}`;
const ficheDe = (rang: number, j: number): string => `+3361${String(rang).padStart(3, '0')}${String(j).padStart(4, '0')}`;
/** Base pour les rangs impairs, Entreprise pour les pairs. */
const estFree = (rang: number): boolean => rang % 2 === 1;

async function semer(pool: Pool): Promise<void> {
  await pool.query(`delete from tenants where name like 'banc14-%'`);
  for (let rang = 1; rang <= ESPACES; rang += 1) {
    const id = (await pool.query<{ id: string }>(
      'insert into tenants (name, offre_entreprise) values ($1, $2) returning id', [nomDe(rang), !estFree(rang)],
    )).rows[0]!.id;
    await pool.query(`insert into waba (id, tenant_id, name) values ($1, $2, 'banc14')`, [`banc14-waba-${rang}`, id]);
    await pool.query(
      `insert into phone_numbers (id, tenant_id, waba_id, display_phone_number, status) values ($1, $2, $3, '+33500000000', 'CONNECTED')`,
      [numeroDe(rang), id, `banc14-waba-${rang}`],
    );
    await pool.query(
      `insert into contacts (tenant_id, phone_e164, profile_name, opt_in_status)
       select $1, $2::text || lpad(i::text, 4, '0'), 'Banc ' || i, 'opted_in' from generate_series(0, $3 - 1) i`,
      [id, `+3361${String(rang).padStart(3, '0')}`, FICHES],
    );
    await pool.query(
      `insert into api_keys (tenant_id, key_hash, name, scopes) values ($1, $2, 'banc14', $3)`,
      [id, createHash('sha256').update(cleDe(rang)).digest('hex'), ['contacts:read', 'contacts:write', 'conversations:read', 'mcp:read']],
    );
  }
  dire(`${ESPACES} espaces semés (${ESPACES / 2} Base, ${ESPACES / 2} Entreprise), ${FICHES} fiches et une clé chacun`);
}

// ---------------------------------------------------------------------------------------------------------------
// LE TRAFIC : quatre familles, tirées au hasard, vers un espace au hasard.
// ---------------------------------------------------------------------------------------------------------------
type Famille = 'lecture' | 'fiche' | 'lot' | 'mcp' | 'reception';
interface Mesure { famille: Famille; statut: number | string; ms: number; free: boolean; code: string | null }
let mesures: Mesure[] = [];

async function appeler(famille: Famille, rang: number): Promise<void> {
  const cle = cleDe(rang);
  const json = { authorization: `Bearer ${cle}`, 'content-type': 'application/json' };
  const j = Math.floor(Math.random() * FICHES);
  const init: { url: string; methode: string; corps?: unknown; entetes: Record<string, string> } =
    famille === 'lecture' ? { url: '/v1/conversations?limit=20', methode: 'GET', entetes: { authorization: `Bearer ${cle}` } }
      : famille === 'fiche' ? { url: '/v1/contacts', methode: 'POST', corps: { phone: ficheDe(rang, j), name: `Banc ${j}` }, entetes: json }
        : famille === 'lot' ? { url: '/v1/contacts/batch', methode: 'POST', corps: { contacts: Array.from({ length: 10 }, (_, k) => ({ phone: ficheDe(rang, (j + k) % FICHES), name: `Banc ${k}` })) }, entetes: json }
          : { url: '/mcp', methode: 'POST', corps: { jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: 'list_conversations', arguments: {} } }, entetes: { ...json, accept: 'application/json, text/event-stream' } };
  const t0 = Date.now();
  try {
    const r = await fetch(`${API}${init.url}`, {
      method: init.methode, headers: init.entetes, ...(init.corps === undefined ? {} : { body: JSON.stringify(init.corps) }), signal: AbortSignal.timeout(20_000),
    });
    const corps = (await r.json().catch(() => null)) as { code?: string } | null;
    mesures.push({ famille, statut: r.status, ms: Date.now() - t0, free: estFree(rang), code: corps?.code ?? null });
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause?.code ?? (e instanceof Error ? e.name : 'erreur');
    mesures.push({ famille, statut: cause, ms: Date.now() - t0, free: estFree(rang), code: null });
  }
}

const POIDS: Array<[Famille, number]> = [['lecture', 0.5], ['fiche', 0.25], ['lot', 0.1], ['mcp', 0.15]];
const tirer = (): Famille => {
  let x = Math.random();
  for (const [f, p] of POIDS) { if (x < p) return f; x -= p; }
  return 'lecture';
};

/** Un message entrant de Meta, signé, vers le numéro d'un espace : la vraie route, le vrai chemin d'enfilement. */
function webhookEntrant(rang: number): string {
  const waId = ficheDe(rang, Math.floor(Math.random() * FICHES)).slice(1);
  return JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'banc14', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '33500000000', phone_number_id: numeroDe(rang) },
    contacts: [{ wa_id: waId, profile: { name: 'Banc' } }],
    messages: [{ from: waId, id: `wamid.banc14.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'banc' } }],
  } }] }] });
}
/** Un accusé de livraison seul : il part sur `webhook-status`. */
function webhookStatut(rang: number): string {
  return JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'banc14', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '33500000000', phone_number_id: numeroDe(rang) },
    statuses: [{ id: `wamid.banc14.${randomUUID()}`, status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: ficheDe(rang, 0).slice(1) }],
  } }] }] });
}
async function poster(corps: string): Promise<void> {
  const signature = `sha256=${createHmac('sha256', SECRET_META).update(corps).digest('hex')}`;
  const t0 = Date.now();
  try {
    const r = await fetch(`${API}/webhooks/meta`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body: corps, signal: AbortSignal.timeout(20_000) });
    await r.text();
    mesures.push({ famille: 'reception', statut: r.status, ms: Date.now() - t0, free: false, code: null });
  } catch (e) {
    mesures.push({ famille: 'reception', statut: (e as { cause?: { code?: string } }).cause?.code ?? 'erreur', ms: Date.now() - t0, free: false, code: null });
  }
}

/** Envoie `parS` appels par seconde pendant `dureeMs`, sans attendre les réponses (un client lent ne ralentit pas le débit). */
async function rythmer(parS: number, dureeMs: number, envoyer: () => Promise<void>): Promise<void> {
  const enVol: Array<Promise<void>> = [];
  const fin = Date.now() + dureeMs;
  let du = 0;
  while (Date.now() < fin) {
    du += parS / 10;
    while (du >= 1) { enVol.push(envoyer()); du -= 1; }
    await attendre(100);
  }
  await Promise.all(enVol);
}

interface Bilan { palier: number; p95V1: number; p95Reception: number; erreurs: number; refus429: number; detail: string }

function bilan(palier: number, lot: Mesure[]): Bilan {
  const v1 = lot.filter((m) => m.famille !== 'reception');
  const reception = lot.filter((m) => m.famille === 'reception');
  const erreurs = lot.filter((m) => typeof m.statut === 'string' || m.statut >= 500).length;
  const refus429 = v1.filter((m) => m.statut === 429).length;
  const parFamille = (['lecture', 'fiche', 'lot', 'mcp', 'reception'] as Famille[]).map((f) => {
    const xs = lot.filter((m) => m.famille === f);
    return `${f} ${xs.length} p95 ${quantile(xs.map((m) => m.ms), 0.95)} ms`;
  }).join(' | ');
  return { palier, p95V1: quantile(v1.map((m) => m.ms), 0.95), p95Reception: quantile(reception.map((m) => m.ms), 0.95), erreurs, refus429, detail: parFamille };
}

/** La veille de charge, branchée sur la base du banc, chaque minute : ce que la production aurait dit. */
function veilleDuBanc(pool: Pool): () => Promise<void> {
  const compteur = new PgCompteurDebit(pool);
  const ops = new PgOpsStore(pool, SCHEMA_BOSS);
  return creerVeilleCharge({
    lire: {
      agesDAttente: () => ops.agesDAttente(),
      latencesReceptionMeta: (fenetre) => new PgHttpLatencesStore(pool).lireFenetre('POST', '/webhooks/meta', fenetre),
      attentesPool: () => new PgPoolAttentesStore(pool).lireDernieresMinutes(3),
      refusPlafondGlobal: () => compteur.lister(CLE_REFUS_GLOBAL, 2 * 60_000),
    },
    alerter: (cle, texte) => {
      dire(`VEILLE ${cle} : ${texte}`);
      if (TELEGRAM) void sendTelegram(`[BANC lot 14, copie jetable, PAS la production] ${texte}`);
    },
  });
}

async function rapportServeur(pool: Pool): Promise<void> {
  dire('--- vu du serveur (http_latences de la derniere heure, /v1, /mcp et la reception) ---');
  for (const l of (await new PgHttpLatencesStore(pool).lire(1)).filter((x) => x.route.startsWith('/v1') || x.route === '/mcp' || x.route === '/webhooks/meta').sort((a, b) => b.requetes - a.requetes)) {
    dire(`${`${l.methode} ${l.route}`.padEnd(40)} ${l.code} | ${String(l.requetes).padStart(6)} req. | p50 <= ${l.p50Ms} ms | p95 <= ${l.p95Ms} ms | max ${l.maxMs} ms`);
  }
  dire('--- attente du pool (pool_attentes, derniere heure) ---');
  const r = await pool.query<{ process: string; n: string; attentes: string; pire: number }>(
    `select process, sum(echantillons)::text as n, sum(attentes)::text as attentes, max(max_attente_ms) as pire
       from pool_attentes where minute > now() - interval '1 hour' group by process order by process`,
  );
  for (const x of r.rows) dire(`${x.process.padEnd(18)} ${x.n} prises | ${x.attentes} sur pool plein | pire ${x.pire} ms`);
  dire('--- files (plus vieux job qui attend) ---');
  for (const a of await new PgOpsStore(pool, SCHEMA_BOSS).agesDAttente()) dire(`${a.file.padEnd(24)} ${a.ageSecondes} s`);
}

async function paliers(pool: Pool): Promise<void> {
  const veille = veilleDuBanc(pool);
  const minuterie = setInterval(() => { void veille().catch((e: unknown) => dire(`veille en echec : ${String(e)}`)); }, 60_000);
  const bilans: Bilan[] = [];
  try {
    for (const palier of PALIERS) {
      mesures = [];
      dire(`=== palier ${palier} appels/s pendant ${PALIER_MS / 1000} s, ${WEBHOOKS_PAR_S} webhooks/s ===`);
      await Promise.all([
        rythmer(palier, PALIER_MS, () => appeler(tirer(), 1 + Math.floor(Math.random() * ESPACES))),
        rythmer(WEBHOOKS_PAR_S, PALIER_MS, () => poster(webhookEntrant(1 + Math.floor(Math.random() * ESPACES)))),
      ]);
      const b = bilan(palier, mesures);
      bilans.push(b);
      dire(`p95 /v1+/mcp ${b.p95V1} ms | p95 reception ${b.p95Reception} ms | ${b.erreurs} 5xx ou reseau | ${b.refus429} 429`);
      dire(b.detail);
      await attendre(5_000);
    }
  } finally {
    clearInterval(minuterie);
  }
  await attendre(65_000); // le dernier vidage de la mesure de l'API
  await rapportServeur(pool);
  const tenus = bilans.filter((b) => b.p95V1 <= SEUIL_P95_V1_MS && b.erreurs === 0 && b.p95Reception <= SEUIL_P95_RECEPTION_MS);
  // La capacité est le dernier palier tenu AVANT le premier qui casse : un palier tenu après une casse ne compte pas.
  const premiereCasse = bilans.findIndex((b) => !tenus.includes(b));
  const capacite = premiereCasse === 0 ? 0 : (premiereCasse === -1 ? bilans[bilans.length - 1]! : bilans[premiereCasse - 1]!).palier;
  console.log('');
  dire(`VERDICT : capacite C = ${capacite} appels/s ${premiereCasse === -1 ? '(AUCUN palier n a casse : C est au moins ce palier, monter BANC_PALIERS)' : ''}`);
  dire(`plafond global recommande : API_PLAFOND_GLOBAL_PAR_10S=${Math.floor(capacite * 0.7 * 10)} (70 % de C, par 10 s)`);
  dire(`hypothese a couvrir : environ 50 appels/s (100 espaces a 10/min, pics x3) : ${capacite >= 50 ? 'COUVERTE' : 'NON COUVERTE, voir ce qui sature ci-dessus'}`);
}

async function statuts(pool: Pool): Promise<void> {
  mesures = [];
  dire(`=== rafale de ${STATUTS_PAR_S} accuses/s pendant 10 s (pool de reception) ===`);
  await rythmer(STATUTS_PAR_S, 10_000, () => poster(webhookStatut(1 + Math.floor(Math.random() * ESPACES))));
  const xs = mesures.filter((m) => m.famille === 'reception');
  const erreurs = xs.filter((m) => typeof m.statut === 'string' || m.statut >= 500).length;
  dire(`${xs.length} accuses | p50 ${quantile(xs.map((m) => m.ms), 0.5)} ms | p95 ${quantile(xs.map((m) => m.ms), 0.95)} ms | max ${Math.max(0, ...xs.map((m) => m.ms))} ms | ${erreurs} 5xx ou reseau`);
  await attendre(65_000);
  await rapportServeur(pool);
  await veilleDuBanc(pool)();
}

async function plafond(pool: Pool): Promise<void> {
  const palier = PALIERS[0]!;
  mesures = [];
  dire(`=== palier ${palier} appels/s, API relancee avec le plafond global pose (Free d abord) ===`);
  await rythmer(palier, PALIER_MS, () => appeler(tirer(), 1 + Math.floor(Math.random() * ESPACES)));
  const v1 = mesures.filter((m) => m.famille !== 'reception');
  const plateforme = (free: boolean) => v1.filter((m) => m.free === free && m.statut === 429 && m.code === 'rate_limited').length;
  const total = (free: boolean) => v1.filter((m) => m.free === free).length;
  dire(`Free : ${plateforme(true)} refus sur ${total(true)} | payants : ${plateforme(false)} refus sur ${total(false)} | p95 ${quantile(v1.map((m) => m.ms), 0.95)} ms`);
  dire(plateforme(true) > plateforme(false) ? 'FREE D ABORD : tenu' : 'FREE D ABORD : NON TENU (plus de refus payants que Free)');
  await attendre(65_000);
  await rapportServeur(pool);
  await veilleDuBanc(pool)();
}

async function main(): Promise<void> {
  garde();
  const pool = new Pool({ connectionString: URL_BASE, max: 4 });
  try {
    if (EPREUVE === 'semer') await semer(pool);
    else if (EPREUVE === 'paliers') await paliers(pool);
    else if (EPREUVE === 'statuts') await statuts(pool);
    else if (EPREUVE === 'plafond') await plafond(pool);
    else throw new Error('BANC_EPREUVE : semer, paliers, statuts ou plafond');
  } finally {
    await pool.end();
    // Les alertes de la veille partent sans être attendues : leur laisser le temps d'arriver.
    if (TELEGRAM) await attendre(5_000);
  }
}

await main();
