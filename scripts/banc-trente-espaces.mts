/**
 * LE BANC DES TRENTE ESPACES (plan `docs/superpowers/plans/2026-10-03-banc-trente-espaces.md`).
 *
 * Le cas réel de Julien : 30 espaces, dans chacun 2 personnes avec l'Inbox ouverte et une dizaine de conversations,
 * et un pic où les 30 reçoivent des messages dans la même minute. Ce banc rejoue les ÉCRANS (leurs sondages, aux
 * cadences et à la gigue du code de la console) et les WEBHOOKS (signés, par la vraie route), contre une copie
 * d'API et deux workers montés sur un Postgres jetable, puis lit ce que la production lirait : p95 par route,
 * attentes de pool, âge des messages entrants. Une épreuve par lancement (`BANC_EPREUVE`) :
 * - `preparer` : vérifie les 30 espaces semés et y crée les conversations par un premier message entrant chacune ;
 * - `charge` : cinq minutes de sondage par les onglets, avec le pic à la deuxième minute ;
 * - `crash` : le même pic, pendant lequel l'hôte tue le worker principal (`docker kill`) ;
 * - `arret` : le même pic, pendant lequel l'hôte l'arrête proprement (`docker stop -t 30`, le geste d'un déploiement).
 * Les deux dernières exigent un geste que ce script ne peut pas faire depuis son conteneur : l'hôte le commande
 * quand le script écrit sa ligne `GESTE MAINTENANT` (au milieu du pic), et le script PROUVE ensuite qu'il a eu lieu
 * (l'heure de démarrage du worker principal, `worker_heartbeat.booted_at`, doit tomber dans le pic).
 *
 * 🔴 LA RECETTE DU MONTAGE, celle du second banc avec trois écarts (dossier, étiquette et réseau à eux) :
 *   1. `git clone --depth 1 <url publique> /home/ubuntu/banc-inbox30`, puis `docker build -t banc-mba:inbox30 .`
 *   2. `docker network create banc30_net` ; Postgres `pgvector/pgvector:pg16` nommé `banc30-postgres`, avec
 *      `--cap-add NET_ADMIN`, publié sur 127.0.0.1 seulement. 🔴 TOUS les conteneurs du banc portent l'étiquette
 *      `banc=inbox30` : le démontage passe par elle, et le geste aussi.
 *   3. 🔴 LE DÉLAI RÉSEAU DE LA PRODUCTION : 10 ms d'aller-retour mesurés entre `mba-api` et Supabase le
 *      2026-10-03. Sans lui, la base locale répond cinquante fois plus vite et une connexion du pool se libère
 *      d'autant plus tôt : le banc conclurait que le pool tient pour une raison qui n'existe pas en production.
 *      `apt-get install iproute2` dans le conteneur Postgres, puis `tc qdisc add dev eth0 root netem delay 10ms`.
 *   4. `.env.banc` aux secrets JETABLES (`openssl rand -hex 32`), jamais affichés, `DRY_RUN=true`, `DB_SSL=off`.
 *   5. `npm run migrate`, puis `db/seed.ts` deux fois par espace (`SEED_TENANT_NAME=banc30-NN`, une adresse par
 *      personne, `SEED_PHONE_NUMBER_ID=banc30-pn-NN`, `SEED_WABA_ID=banc30-waba-NN`).
 *   6. Les tailles de pool de la production : worker principal (`WORKER_ROLE=principal`, `DB_POOL_MAX=8`,
 *      `PGBOSS_MAX=2`) et d'analyse (`3`, `2`) D'ABORD, puis l'API (`DB_POOL_MAX=10`), nommés `banc30-worker`,
 *      `banc30-worker-analyse` et `banc30-api`.
 *   7. Ce script, dans un conteneur de l'image sur le même réseau, avec le dossier `scripts` monté.
 *   8. Pour `crash` et `arret` : attendre la ligne `GESTE MAINTENANT` dans les journaux du script, puis frapper
 *      PAR L'ÉTIQUETTE, jamais par un nom tapé à la main (`mba-worker` est le vrai worker, sur le même hôte) :
 *      `W=$(docker ps -q --filter label=banc=inbox30 --filter name=^banc30-worker$)`, puis `docker kill $W` (ou
 *      `docker stop -t 30 $W`), et `docker start $W` quelques secondes après.
 * Démontage : `docker rm -f $(docker ps -aq --filter label=banc=inbox30)`, `docker network rm banc30_net`,
 * `docker rmi banc-mba:inbox30`, et le dossier.
 *
 * Usage (jamais contre la production, cf. les gardes) :
 *   BANC_CONFIRME=1 BANC_EPREUVE=charge BANC_API=http://banc30-api:8095 DATABASE_URL=<base jetable> \
 *     AUTH_SECRET=<celui du banc> META_APP_SECRET=<celui du banc> npx tsx scripts/banc-trente-espaces.mts
 *
 * 🔴 UN « NON ÉPROUVÉ » NE VAUT PAS UN SUCCÈS : un geste qui n'a pas eu lieu pendant le pic, ou un crash qui ne
 * frappe aucune tâche en vol, ne prouve rien, et le script le dit et sort en échec.
 *
 * 🔴 CE QUE LE BANC NE REPRODUIT PAS, et qui borne ses conclusions à l'API et aux workers (jamais à la base) : le
 * pooler de Supabase (Supavisor, son « Pool Size » partagé avec mm-hubspot, ses files d'attente muettes), le calcul
 * d'une base Supabase Micro partagée et ses tables peuplées, TLS, les accusés de campagne, les analyses, les tours
 * d'agent, l'agent de Meta, les automations et la traduction (des espaces sans scénario ni agent, `DRY_RUN=true` :
 * le traitement d'un entrant prend son chemin le plus léger). Seul le délai réseau vers la base est fidèle.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { signSession } from '../src/auth/token';
import { PgHttpLatencesStore } from '../src/ops/latence-http.pg';

const API = process.env.BANC_API ?? '';
const URL_BASE = process.env.DATABASE_URL ?? '';
const EPREUVE = process.env.BANC_EPREUVE ?? '';
const SECRET_AUTH = process.env.AUTH_SECRET ?? '';
const SECRET_META = process.env.META_APP_SECRET ?? '';
const ESPACES = Number(process.env.BANC_ESPACES ?? 30);
const PERSONNES = Number(process.env.BANC_PERSONNES ?? 2);
const CONVERSATIONS = Number(process.env.BANC_CONVERSATIONS ?? 10);
const DUREE_MS = Number(process.env.BANC_DUREE_S ?? 300) * 1000;
const PIC_A_MS = Number(process.env.BANC_PIC_A_S ?? 120) * 1000;
/** Le pic dure une minute : chaque message part à un instant tiré dans cette minute. */
const PIC_DUREE_MS = 60_000;
const PIC_MESSAGES = Number(process.env.BANC_PIC_MESSAGES ?? 2);
/** Combien de temps on attend que chaque message du pic soit écrit. Le crash peut exiger le délai d'expiration de pg-boss. */
const ATTENTE_MAX_MS = Number(process.env.BANC_ATTENTE_MAX_S ?? (EPREUVE === 'crash' ? 1200 : 180)) * 1000;
const SCHEMA_BOSS = process.env.PGBOSS_SCHEMA ?? 'pgboss';
/** Les seuils de l'audit : p95 de l'Inbox au-delà de 500 à 800 ms, message entrant traité en 30 s (SLO 1). */
const SEUIL_P95_INBOX_MS = 800;
const SLO_ENTRANT_MS = 30_000;

if (process.env.BANC_CONFIRME !== '1') throw new Error('BANC_CONFIRME=1 manquant : ce banc sature une API et ses workers.');
if (URL_BASE === '') throw new Error('DATABASE_URL manquant');
if (/supabase/i.test(URL_BASE)) throw new Error('DATABASE_URL ressemble a la PRODUCTION : banc interdit.');
if (API === '') throw new Error('BANC_API manquant');
if (/messagingme\.app/i.test(API)) throw new Error('BANC_API ressemble a la PRODUCTION : banc interdit.');
if (SECRET_AUTH === '' || SECRET_META === '') throw new Error('AUTH_SECRET et META_APP_SECRET du banc requis (sessions et signatures).');
const EPREUVES = ['preparer', 'charge', 'crash', 'arret'] as const;
type Epreuve = (typeof EPREUVES)[number];
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
/** La gigue de la console (`web/lib/poll.ts`) : chaque attente vaut la période à ±20 %, retirée à neuf. */
const gigue = (periodeMs: number): number => periodeMs * (0.8 + Math.random() * 0.4);
const quantile = (xs: number[], q: number): number => {
  const t = [...xs].sort((x, y) => x - y);
  return t.length === 0 ? 0 : t[Math.min(t.length - 1, Math.max(0, Math.ceil(q * t.length) - 1))]!;
};
const ms = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);

// ---------------------------------------------------------------------------------------------------------------
// HTTP : une réponse, ou la cause réseau.
// ---------------------------------------------------------------------------------------------------------------
type Reponse = { statut: number; corps: Record<string, unknown> | null; ms: number } | { erreur: string; ms: number };

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

/** Ce que chaque requête du banc a rendu, vu du client, avec la phase où elle est partie. */
interface Mesure { route: string; statut: number | string; ms: number; pic: boolean }
const mesures: Mesure[] = [];
let debutBanc = Date.now();
const enPic = (): boolean => {
  const t = Date.now() - debutBanc;
  // Le pic, plus le temps que le worker l'écoule : c'est là que la contention se voit.
  return t >= PIC_A_MS && t < PIC_A_MS + PIC_DUREE_MS + 30_000;
};
const noter = (route: string, r: Reponse, pic = enPic()): void => {
  mesures.push({ route, statut: 'statut' in r ? r.statut : r.erreur, ms: r.ms, pic });
};

// ---------------------------------------------------------------------------------------------------------------
// LES ESPACES : semés par `db/seed.ts` (le vrai code), retrouvés ici par leur nom.
// ---------------------------------------------------------------------------------------------------------------
interface Espace { rang: number; id: string; numero: string; personnes: string[]; conversations: string[] }

/** Un téléphone de contact unique par espace et par conversation (11 chiffres, comme un mobile français). */
const telephone = (rang: number, j: number): string => `3360${String(rang).padStart(3, '0')}${String(j).padStart(4, '0')}`;

async function lesEspaces(pool: Pool, avecConversations: boolean): Promise<Espace[]> {
  const t = await pool.query<{ id: string; name: string; numero: string }>(
    `select t.id, t.name, p.id as numero
       from tenants t join phone_numbers p on p.tenant_id = t.id
      where t.name like 'banc30-%' order by t.name`,
  );
  if (t.rows.length !== ESPACES) throw new Error(`${t.rows.length} espace(s) banc30 semes, ${ESPACES} attendus : semer d abord (recette, etape 5).`);
  const espaces: Espace[] = [];
  for (const [i, row] of t.rows.entries()) {
    const u = await pool.query<{ id: string }>('select id from users where tenant_id = $1 order by email', [row.id]);
    if (u.rows.length < PERSONNES) throw new Error(`espace ${row.name} : ${u.rows.length} compte(s), ${PERSONNES} attendus`);
    let conversations: string[] = [];
    if (avecConversations) {
      const c = await pool.query<{ id: string; wa_id: string }>('select id, wa_id from conversations where tenant_id = $1', [row.id]);
      const parTelephone = new Map(c.rows.map((x) => [x.wa_id, x.id]));
      conversations = Array.from({ length: CONVERSATIONS }, (_, j) => parTelephone.get(telephone(i + 1, j)) ?? '');
      if (conversations.some((x) => x === '')) throw new Error(`espace ${row.name} : conversations manquantes, lancer l epreuve preparer d abord`);
    }
    espaces.push({ rang: i + 1, id: row.id, numero: row.numero, personnes: u.rows.slice(0, PERSONNES).map((x) => x.id), conversations });
  }
  return espaces;
}

// ---------------------------------------------------------------------------------------------------------------
// LES WEBHOOKS : la forme que Meta envoie, signée avec le secret du banc.
// ---------------------------------------------------------------------------------------------------------------
function webhook(numero: string, wamid: string, waId: string, texte: string): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'banc30', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp',
      metadata: { display_phone_number: '33100000000', phone_number_id: numero },
      contacts: [{ wa_id: waId, profile: { name: `Banc ${waId.slice(-4)}` } }],
      messages: [{ from: waId, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: texte } }],
    } }] }],
  });
}
async function poster(corps: string): Promise<Reponse> {
  const signature = `sha256=${createHmac('sha256', SECRET_META).update(corps).digest('hex')}`;
  return requete(`${API}/webhooks/meta`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature }, body: corps });
}

/** Attend que chaque identifiant soit écrit en base ; rend l'instant d'écriture de chacun (absent = pas écrit). */
async function attendreEcrits(pool: Pool, prefixe: string, attendus: number, delaiMs: number): Promise<Map<string, number>> {
  const fin = Date.now() + delaiMs;
  let ecrits = new Map<string, number>();
  let dernierCompte = -1;
  while (Date.now() < fin) {
    const r = await pool.query<{ meta_message_id: string; at: Date }>(
      `select meta_message_id, created_at as at from conversation_messages where meta_message_id like $1`,
      [`${prefixe}%`],
    );
    ecrits = new Map(r.rows.map((x) => [x.meta_message_id, x.at.getTime()]));
    if (ecrits.size !== dernierCompte) { dire(`${ecrits.size}/${attendus} messages ecrits`); dernierCompte = ecrits.size; }
    if (ecrits.size >= attendus) break;
    await attendre(3000);
  }
  return ecrits;
}

// ---------------------------------------------------------------------------------------------------------------
// ÉPREUVE `preparer` : une conversation par contact, par un premier message entrant chacune.
// ---------------------------------------------------------------------------------------------------------------
async function preparer(pool: Pool): Promise<void> {
  const espaces = await lesEspaces(pool, false);
  dire(`${espaces.length} espaces semes, ${PERSONNES} comptes chacun`);
  const attendus = espaces.length * CONVERSATIONS;
  const refus: string[] = [];
  for (const e of espaces) {
    await Promise.all(Array.from({ length: CONVERSATIONS }, async (_, j) => {
      const r = await poster(webhook(e.numero, `wamid.banc30.prep.${e.rang}.${j}`, telephone(e.rang, j), 'Bonjour, une question'));
      if (!('statut' in r) || r.statut !== 200) refus.push('statut' in r ? String(r.statut) : r.erreur);
    }));
  }
  const ecrits = await attendreEcrits(pool, 'wamid.banc30.prep.', attendus, 180_000);
  if (refus.length > 0) poser('preparation', 'echec', `${refus.length} webhook(s) refuse(s) : ${[...new Set(refus)].join(', ')}`);
  else if (ecrits.size < attendus) poser('preparation', 'echec', `${ecrits.size}/${attendus} conversations seulement`);
  else poser('preparation', 'ok', `${espaces.length} espaces x ${CONVERSATIONS} conversations creees par de vrais webhooks`);
}

// ---------------------------------------------------------------------------------------------------------------
// UN ONGLET : les trois sondages de l'Inbox, aux cadences de la console.
// ---------------------------------------------------------------------------------------------------------------
interface Onglet { espace: string; jeton: string; conversation: string; curseur: { at: string; id: string } | null; vus: Set<string> }

async function onglet(o: Onglet, fin: number): Promise<void> {
  const lire = async (route: string, chemin: string, methode = 'GET'): Promise<Reponse> => {
    const r = await requete(`${API}${chemin}`, { method: methode, headers: { authorization: `Bearer ${o.jeton}` } });
    noter(route, r);
    return r;
  };
  const pastille = async (): Promise<void> => { await lire('GET non-lus', `/tenants/${o.espace}/conversations/unread-count`); };
  // La liste, puis les compteurs du menu : la console les relit à chaque liste rechargée (`rechargerCompteur`).
  const liste = async (): Promise<void> => {
    await lire('GET liste', `/tenants/${o.espace}/conversations?limit=50`);
    await lire('GET compteurs', `/tenants/${o.espace}/conversations/counts`);
  };
  // Le fil ouvert, en delta sur le curseur rendu par le serveur ; un message neuf est marqué lu, puis la pastille
  // est relue (l'événement `UNREAD_CHANGED_EVENT`).
  const fil = async (): Promise<void> => {
    const q = o.curseur ? `?afterAt=${encodeURIComponent(o.curseur.at)}&afterId=${o.curseur.id}` : '';
    const r = await lire('GET fil', `/tenants/${o.espace}/conversations/${o.conversation}/messages${q}`);
    if (!('statut' in r) || r.statut !== 200) return;
    const messages = (Array.isArray(r.corps?.messages) ? r.corps.messages : []) as { id: string; curseur?: string }[];
    const neufs = messages.filter((m) => !o.vus.has(m.id));
    for (const m of messages) o.vus.add(m.id);
    const dernier = messages[messages.length - 1];
    if (dernier) o.curseur = dernier.curseur ? { at: dernier.curseur, id: dernier.id } : null;
    if (neufs.length > 0) {
      await lire('POST lu', `/tenants/${o.espace}/conversations/${o.conversation}/read`, 'POST');
      await pastille();
    }
  };
  // Les personnes n'ouvrent pas toutes la console à la même seconde : l'ouverture s'étale sur dix secondes.
  await attendre(Math.random() * 10_000);
  await liste();
  await pastille();
  await fil();
  const boucle = async (periodeMs: number, geste: () => Promise<void>): Promise<void> => {
    while (Date.now() < fin) {
      await attendre(gigue(periodeMs));
      if (Date.now() >= fin) return;
      await geste();
    }
  };
  await Promise.all([boucle(4000, fil), boucle(15_000, liste), boucle(30_000, pastille)]);
}

// ---------------------------------------------------------------------------------------------------------------
// LE PIC : chaque conversation de chaque espace reçoit `PIC_MESSAGES` messages, à des instants tirés dans la minute.
// ---------------------------------------------------------------------------------------------------------------
/** Le repère que l'hôte attend pour frapper le worker, au milieu du pic (`crash` et `arret`). */
async function repereDuGeste(): Promise<void> {
  await attendre(Math.max(0, debutBanc + PIC_A_MS + PIC_DUREE_MS / 2 - Date.now()));
  // eslint-disable-next-line no-console
  console.log(`GESTE MAINTENANT ${new Date().toISOString()}`);
}

async function pic(espaces: Espace[], run: string, envois: Map<string, number>): Promise<void> {
  await attendre(Math.max(0, debutBanc + PIC_A_MS - Date.now()));
  dire(`pic : ${espaces.length * CONVERSATIONS * PIC_MESSAGES} messages entrants sur une minute`);
  const taches: Promise<void>[] = [];
  for (const e of espaces) {
    for (let j = 0; j < CONVERSATIONS; j += 1) {
      for (let k = 0; k < PIC_MESSAGES; k += 1) {
        taches.push((async () => {
          await attendre(Math.random() * PIC_DUREE_MS);
          const wamid = `wamid.banc30.${run}.${e.rang}.${j}.${k}`;
          envois.set(wamid, Date.now());
          noter('POST /webhooks/meta', await poster(webhook(e.numero, wamid, telephone(e.rang, j), `Message ${k + 1} du pic`)), true);
        })());
      }
    }
  }
  await Promise.all(taches);
}

// ---------------------------------------------------------------------------------------------------------------
// LES RAPPORTS
// ---------------------------------------------------------------------------------------------------------------
function rapportClient(): { p95Inbox: number; p95InboxPic: number; erreurs: Mesure[] } {
  dire('--- vu du client (le navigateur simule) ---');
  const routes = [...new Set(mesures.map((m) => m.route))].sort();
  for (const route of routes) {
    const toutes = mesures.filter((m) => m.route === route);
    const ok = toutes.filter((m) => typeof m.statut === 'number' && m.statut < 400).map((m) => m.ms);
    const pendantPic = toutes.filter((m) => m.pic && typeof m.statut === 'number' && m.statut < 400).map((m) => m.ms);
    const ko = toutes.length - ok.length;
    dire(`${route.padEnd(22)} ${String(toutes.length).padStart(6)} req. | p50 ${ms(quantile(ok, 0.5)).padStart(7)} | p95 ${ms(quantile(ok, 0.95)).padStart(7)} | max ${ms(Math.max(0, ...ok)).padStart(7)} | pendant le pic p95 ${ms(quantile(pendantPic, 0.95)).padStart(7)}${ko > 0 ? ` | ${ko} en erreur` : ''}`);
  }
  // Les coupures (réseau, délai de 20 s) comptent à leur durée : les exclure rendrait le p95 optimiste au pire moment.
  const inbox = mesures.filter((m) => m.route !== 'POST /webhooks/meta' && (typeof m.statut !== 'number' || m.statut < 400));
  const erreurs = mesures.filter((m) => m.route !== 'POST /webhooks/meta' && !(typeof m.statut === 'number' && m.statut < 400));
  return { p95Inbox: quantile(inbox.map((m) => m.ms), 0.95), p95InboxPic: quantile(inbox.filter((m) => m.pic).map((m) => m.ms), 0.95), erreurs };
}

/** La mesure livrée le 2026-10-03, relue par son vrai code : ce que la carte de `/ops` afficherait. */
async function rapportServeur(pool: Pool): Promise<void> {
  dire('--- vu du serveur (http_latences, la carte de /ops : TOUTE la derniere heure, preparation et lancements precedents compris) ---');
  const lignes = (await new PgHttpLatencesStore(pool).lire(1))
    .filter((l) => l.groupe === 'inbox' || l.groupe === 'webhooks')
    .sort((a, b) => b.requetes - a.requetes);
  if (lignes.length === 0) dire('aucune ligne : l API n a pas encore vide sa mesure, ou la table manque');
  for (const l of lignes) dire(`${`${l.methode} ${l.route}`.padEnd(70)} ${String(l.code)} | ${String(l.requetes).padStart(6)} req. | p50 <= ${l.p50Ms} ms | p95 <= ${l.p95Ms} ms | max ${l.maxMs} ms`);
}

async function rapportPool(pool: Pool, depuis: Date): Promise<number> {
  dire('--- attente du pool (pool_attentes) ---');
  const r = await pool.query<{ process: string; echantillons: string; attentes: string; max_attente_ms: number; minutes: string }>(
    `select process, sum(echantillons)::text as echantillons, sum(attentes)::text as attentes,
            max(max_attente_ms) as max_attente_ms, count(*) filter (where attentes > 0)::text as minutes
       from pool_attentes where minute >= date_trunc('minute', $1::timestamptz) group by process order by process`,
    [depuis],
  );
  let minutesApi = 0;
  for (const x of r.rows) {
    dire(`${x.process.padEnd(16)} ${x.echantillons} prises | ${x.attentes} attente(s) sur pool sature, pire ${x.max_attente_ms} ms, sur ${x.minutes} minute(s)`);
    if (x.process.startsWith('api')) minutesApi = Math.max(minutesApi, Number(x.minutes));
  }
  return minutesApi;
}

/** Le délai de chaque message du pic, de l'envoi du webhook à son écriture en base, par espace. */
function rapportEntrants(envois: Map<string, number>, ecrits: Map<string, number>): { perdus: number; delais: number[] } {
  dire('--- messages entrants du pic (envoi du webhook -> ecriture en base) ---');
  const delais: number[] = [];
  const parEspace = new Map<string, number[]>();
  for (const [wamid, envoi] of envois) {
    const ecrit = ecrits.get(wamid);
    if (ecrit === undefined) continue;
    const d = Math.max(0, ecrit - envoi);
    delais.push(d);
    const espace = wamid.split('.')[3]!;
    parEspace.set(espace, [...(parEspace.get(espace) ?? []), d]);
  }
  const pires = [...parEspace.entries()].map(([e, ds]) => ({ e, max: Math.max(...ds) })).sort((a, b) => a.max - b.max);
  dire(`${delais.length}/${envois.size} ecrits | p50 ${ms(quantile(delais, 0.5))} | p95 ${ms(quantile(delais, 0.95))} | max ${ms(Math.max(0, ...delais))} | au-dela de 30 s : ${delais.filter((d) => d > SLO_ENTRANT_MS).length}`);
  if (pires.length > 0) dire(`equite : l espace le mieux servi attend au pire ${ms(pires[0]!.max)}, le moins bien servi ${ms(pires[pires.length - 1]!.max)}`);
  return { perdus: envois.size - delais.length, delais };
}

/** Attend qu'aucune tâche du lancement ne soit plus active, en attente ou à rejouer, ou que la limite tombe. */
async function attendreTachesFinies(pool: Pool, run: string, depuis: Date, limite: number): Promise<void> {
  let dernier = -1;
  while (Date.now() < limite) {
    const n = Number((await pool.query<{ n: string }>(
      `select count(*)::text as n from ${SCHEMA_BOSS}.job
        where name = 'webhook' and created_on >= $1 and data::text like $2 and state in ('created', 'retry', 'active')`,
      [depuis, `%wamid.banc30.${run}.%`],
    )).rows[0]!.n);
    if (n !== dernier) { dire(`${n} tache(s) du lancement pas encore terminee(s)`); dernier = n; }
    if (n === 0) return;
    await attendre(5000);
  }
}

/** Ce que pg-boss a fait des tâches du lancement : rejouées après expiration, échouées, parties en file d'échec. */
async function rapportFile(pool: Pool, run: string, depuis: Date): Promise<{ rejouees: number; expirees: number; orphelines: number; echec: number; dlq: number }> {
  dire('--- la file des messages entrants (pg-boss) ---');
  // Une tâche expirée est RÉINSÉRÉE sous le même identifiant (pg-boss 12, `failJobsByTimeout`), et sa trace « job timed
  // out » peut être écrasée quand elle finit. Le compteur de rejeu ne monte qu'à la reprise, quelle qu'en soit la cause
  // (une simple erreur du traitement aussi) : seule une reprise APRÈS le délai d'expiration prouve une tâche orpheline.
  const r = await pool.query<{ rejouees: string; expirees: string; orphelines: string; echec: string; attente_p95: number | null; total_p95: number | null }>(
    `select count(*) filter (where retry_count > 0)::text as rejouees,
            count(*) filter (where retry_count > 0 and started_on - created_on >= expire_seconds * interval '1s')::text as expirees,
            count(*) filter (where state in ('created', 'retry', 'active'))::text as orphelines,
            count(*) filter (where state = 'failed')::text as echec,
            percentile_cont(0.95) within group (order by extract(epoch from (started_on - created_on)) * 1000) as attente_p95,
            percentile_cont(0.95) within group (order by extract(epoch from (completed_on - created_on)) * 1000) as total_p95
       from ${SCHEMA_BOSS}.job where name = 'webhook' and created_on >= $1 and data::text like $2`,
    [depuis, `%wamid.banc30.${run}.%`],
  );
  const dlq = await pool.query<{ n: string }>(
    `select count(*)::text as n from ${SCHEMA_BOSS}.job where name = 'webhook-dlq' and created_on >= $1`,
    [depuis],
  );
  const x = r.rows[0]!;
  dire(`taches : attente p95 ${ms(x.attente_p95 ?? 0)}, bout en bout p95 ${ms(x.total_p95 ?? 0)} | rejouees ${x.rejouees} (apres expiration ${x.expirees}) | pas encore terminees ${x.orphelines} | en echec ${x.echec} | file d echec ${dlq.rows[0]!.n}`);
  return { rejouees: Number(x.rejouees), expirees: Number(x.expirees), orphelines: Number(x.orphelines), echec: Number(x.echec), dlq: Number(dlq.rows[0]!.n) };
}

// ---------------------------------------------------------------------------------------------------------------
// LE DÉROULÉ
// ---------------------------------------------------------------------------------------------------------------
async function derouler(pool: Pool, epreuve: Exclude<Epreuve, 'preparer'>): Promise<void> {
  const espaces = await lesEspaces(pool, true);
  const run = randomUUID().slice(0, 8);
  const depuis = new Date();
  // Une session par personne, signée avec le secret du banc : la garde relit l'utilisateur en base à chaque requête,
  // comme en production. Le rôle relu en base prime de toute façon sur celui du jeton.
  const onglets: Onglet[] = [];
  for (const e of espaces) {
    for (const [p, userId] of e.personnes.entries()) {
      const jeton = await signSession({ userId, tenantId: e.id, role: 'admin' }, SECRET_AUTH);
      onglets.push({ espace: e.id, jeton, conversation: e.conversations[p % e.conversations.length]!, curseur: null, vus: new Set() });
    }
  }
  dire(`lancement ${run} : ${epreuve}, ${onglets.length} onglets sur ${espaces.length} espaces, ${Math.round(DUREE_MS / 1000)} s, pic a ${Math.round(PIC_A_MS / 1000)} s`);
  if (epreuve !== 'charge') dire(`l hote doit ${epreuve === 'crash' ? 'TUER (docker kill)' : 'ARRETER (docker stop -t 30)'} banc30-worker pendant le pic, puis le relancer`);
  debutBanc = Date.now();
  const fin = debutBanc + DUREE_MS;
  const envois = new Map<string, number>();
  await Promise.all([...onglets.map((o) => onglet(o, fin)), pic(espaces, run, envois), ...(epreuve === 'charge' ? [] : [repereDuGeste()])]);
  dire(`sondage termine ; attente de l ecriture des ${envois.size} messages du pic (au plus ${Math.round(ATTENTE_MAX_MS / 1000)} s)`);
  const limite = Date.now() + ATTENTE_MAX_MS;
  const ecrits = await attendreEcrits(pool, `wamid.banc30.${run}.`, envois.size, ATTENTE_MAX_MS);
  // Un message écrit ne dit pas que sa tâche est finie : tuée APRÈS l'insertion, elle reste active jusqu'à son
  // expiration. En `crash`, on attend que chaque tâche du lancement soit terminée (dans la même limite).
  if (epreuve === 'crash') await attendreTachesFinies(pool, run, depuis, limite);
  // L'API vide sa mesure chaque minute : on attend le vidage qui suit la dernière requête.
  await attendre(65_000);

  const { p95Inbox, p95InboxPic, erreurs } = rapportClient();
  await rapportServeur(pool);
  const minutesAttenteApi = await rapportPool(pool, depuis);
  const { perdus, delais } = rapportEntrants(envois, ecrits);
  const file = await rapportFile(pool, run, depuis);
  const acquittes = mesures.filter((m) => m.route === 'POST /webhooks/meta' && m.statut === 200).length;

  // Le geste a-t-il eu lieu PENDANT le pic ? Le worker principal réécrit son heure de démarrage en redémarrant.
  let geste: { ok: boolean; dit: string } = { ok: true, dit: '' };
  if (epreuve !== 'charge') {
    const b = (await pool.query<{ booted_at: Date | null }>(`select booted_at from worker_heartbeat where id = 'principal'`)).rows[0]?.booted_at;
    const debutPic = debutBanc + PIC_A_MS;
    const finPic = debutPic + PIC_DUREE_MS + 60_000;
    geste = b && b.getTime() >= debutPic && b.getTime() <= finPic
      ? { ok: true, dit: `le worker principal a redemarre a ${b.toISOString()}, pendant le pic` }
      : { ok: false, dit: `le worker principal a demarre a ${b?.toISOString() ?? 'jamais'}, hors du pic : le geste n a pas eu lieu au bon moment` };
  }
  dire('--- ce que le banc ne reproduit pas (cf. en-tete) : le pooler de Supabase, le calcul et le volume de la base de');
  dire('    production, TLS, les campagnes, analyses, agents et automations. Conclusions valables pour l API et les workers.');
  dire('--- verdicts ---');
  if (epreuve !== 'charge') poser('le geste a eu lieu pendant le pic', geste.ok ? 'ok' : 'non_eprouve', geste.dit);
  if (epreuve === 'charge') {
    poser('p95 des routes de l Inbox', p95Inbox === 0 || p95InboxPic === 0 ? 'non_eprouve' : p95Inbox <= SEUIL_P95_INBOX_MS && p95InboxPic <= SEUIL_P95_INBOX_MS ? 'ok' : 'echec',
      `${ms(p95Inbox)} sur tout le banc, ${ms(p95InboxPic)} pendant le pic (seuil ${SEUIL_P95_INBOX_MS} ms)`);
    poser('aucune erreur cote ecrans', erreurs.length === 0 ? 'ok' : 'echec',
      erreurs.length === 0 ? 'zero refus, zero 5xx, zero coupure' : `${erreurs.length} : ${[...new Set(erreurs.map((m) => `${m.route} ${m.statut}`))].slice(0, 6).join(', ')}`);
    poser('pas d attente persistante du pool de l API', minutesAttenteApi < 2 ? 'ok' : 'echec', `${minutesAttenteApi} minute(s) avec attente sur pool sature`);
  }
  poser('webhooks acquittes', acquittes === envois.size ? 'ok' : 'echec', `${acquittes}/${envois.size}`);
  poser('aucun message perdu', perdus === 0 ? 'ok' : 'echec', perdus === 0 ? `${envois.size} ecrits` : `${perdus} jamais ecrit(s) apres ${Math.round(ATTENTE_MAX_MS / 1000)} s`);
  poser('file d echec vide', file.dlq === 0 && file.echec === 0 ? 'ok' : 'echec', `${file.dlq} en file d echec, ${file.echec} en echec`);
  const auDela = delais.filter((d) => d > SLO_ENTRANT_MS).length;
  if (epreuve === 'crash') {
    // La preuve que le crash a frappé une tâche en vol : pg-boss l'a reprise APRÈS son délai d'expiration.
    if (file.expirees === 0) poser('le crash a frappe des taches en vol', 'non_eprouve', `aucune tache reprise apres expiration (${file.rejouees} reprise(s) d une autre cause) : soit rien n etait en vol, soit l attente a ete trop courte`);
    else poser('le crash a frappe des taches en vol', 'ok', `${file.expirees} tache(s) reprise(s) apres expiration`);
    poser('chaque tache finie apres le crash', file.orphelines === 0 ? 'ok' : 'echec', `${file.orphelines} tache(s) encore en vol ou en attente`);
  }
  if (epreuve === 'arret') {
    // Une tâche abandonnée par le SIGKILL de fin de grâce resterait active : elle se voit ICI, pas dans un rejeu qui
    // n'arriverait qu'après l'expiration.
    poser('arret propre sans tache abandonnee', file.rejouees === 0 && file.orphelines === 0 ? 'ok' : 'echec',
      `${file.rejouees} reprise(s), ${file.orphelines} tache(s) encore en vol ou en attente`);
  }
  // Un message jamais écrit est au-delà de tout délai : il compte contre le SLO, sinon tout perdre le rendrait vert.
  poser('SLO des messages entrants (30 s)', auDela + perdus === 0 && delais.length > 0 ? 'ok' : 'echec',
    auDela + perdus === 0 ? `pire ${ms(Math.max(0, ...delais))}` : `${auDela} message(s) au-dela de 30 s et ${perdus} jamais ecrit(s), le pire ecrit a ${ms(Math.max(0, ...delais))}`);
}

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: URL_BASE, max: 2, application_name: 'banc30-script' });
  try {
    if (EPREUVE === 'preparer') await preparer(pool);
    else await derouler(pool, EPREUVE as Exclude<Epreuve, 'preparer'>);
  } finally {
    await pool.end();
  }
  const echecs = verdicts.filter((v) => v !== 'ok').length;
  // eslint-disable-next-line no-console
  console.log(echecs === 0 ? '\nBANC VERT' : `\n${echecs} verdict(s) non vert(s)`);
  process.exit(echecs === 0 ? 0 : 1);
}

void main().catch((e: unknown) => {
  // eslint-disable-next-line no-console
  console.error('banc interrompu :', e instanceof Error ? e.message : e);
  process.exit(2);
});
