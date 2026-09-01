/**
 * BANC DE CHARGE ET DE REPRISE APRÈS KILL (programme II, item resté ouvert du lot 8).
 *
 * Ce que ce banc mesure, et pourquoi il existe : les lots 3 à 6 ont changé la concurrence des files, le
 * découpage des runs de campagne et le frein par numéro, et rien ne les avait encore vus tourner ENSEMBLE sur
 * un volume réel. Un test unitaire prouve une règle ; il ne dit rien du débit ni de ce qui reste debout quand
 * le worker meurt au milieu d'un envoi.
 *
 * 🔴 IL NE TOUCHE JAMAIS LA PRODUCTION, et ce n'est pas une intention, c'est vérifié deux fois avant la
 * première écriture : la chaîne de connexion ne doit pas ressembler à celle de Supabase, et `BANC_CONFIRME=1`
 * doit être posé explicitement. Sans les deux, le script s'arrête sans rien écrire. Il crée des milliers de
 * contacts et une campagne : le lancer par erreur sur la base des clients serait une catastrophe.
 *
 * 🔴 ET IL N'ENVOIE RIEN À META. Il se joue avec `DRY_RUN=true` côté worker : le sender de démo rend un
 * identifiant sans appeler personne. On mesure donc NOTRE tuyauterie (claim atomique, file, verrou de run,
 * écritures), jamais la latence de Meta, qu'on ne peut pas éprouver sans facturer de vrais messages et
 * abîmer la qualité d'un vrai numéro.
 *
 * Usage (sur le VPS, contre un Postgres jetable) :
 *   BANC_CONFIRME=1 DATABASE_URL=postgres://... npx tsx scripts/banc-charge.mts semer 5000
 *   BANC_CONFIRME=1 DATABASE_URL=postgres://... npx tsx scripts/banc-charge.mts suivre
 *   BANC_CONFIRME=1 DATABASE_URL=postgres://... npx tsx scripts/banc-charge.mts verdict
 */
import 'dotenv/config';
import { Client } from 'pg';
import { pgSsl } from '../src/db/ssl';

const url = process.env.DATABASE_URL ?? '';
const ESPACE = 'banc-de-charge';

function garde(): void {
  if (process.env.BANC_CONFIRME !== '1') {
    throw new Error('BANC_CONFIRME=1 requis : ce banc crée des milliers de lignes, il ne se lance pas par accident.');
  }
  // La production vit sur le pooler Supabase. Toute chaîne qui y ressemble est refusée, quelle que soit la
  // valeur de BANC_CONFIRME : les deux gardes sont indépendantes, et c'est le but.
  if (/supabase|pooler\.supabase\.com/i.test(url)) {
    throw new Error('DATABASE_URL ressemble à la PRODUCTION (supabase). Ce banc ne tourne que sur une base jetable.');
  }
  if (url === '') throw new Error('DATABASE_URL manquant');
}

async function client(): Promise<Client> {
  const c = new Client({ connectionString: url, ssl: pgSsl() });
  await c.connect();
  return c;
}

/** Crée l'espace, le numéro, les contacts et la campagne, puis matérialise les destinataires. */
async function semer(nb: number): Promise<void> {
  const c = await client();
  await c.query('delete from tenants where name = $1', [ESPACE]);
  const tenantId = (await c.query<{ id: string }>('insert into tenants (name) values ($1) returning id', [ESPACE])).rows[0]!.id;
  await c.query(`insert into waba (id, tenant_id, name) values ('banc-waba', $1, 'banc')`, [tenantId]);
  await c.query(
    `insert into phone_numbers (id, tenant_id, waba_id, display_phone_number, status)
     values ('banc-pn', $1, 'banc-waba', '+33500000000', 'CONNECTED')`,
    [tenantId],
  );
  // Contacts opt-in, avec un prénom : la campagne porte une variable, comme en vrai.
  await c.query(
    `insert into contacts (tenant_id, phone_e164, profile_name, opt_in_status, fields)
     select $1, '+336' || lpad(i::text, 8, '0'), 'Prenom' || i, 'opted_in', jsonb_build_object('prenom', 'Prenom' || i)
       from generate_series(1, $2) i`,
    [tenantId, nb],
  );
  const campaignId = (await c.query<{ id: string }>(
    `insert into campaigns (tenant_id, phone_number_id, name, category, template_name, template_language, status, param_mapping, rate_per_minute)
     values ($1, 'banc-pn', 'banc', 'marketing', 'banc_tpl', 'fr', 'draft', '[]'::jsonb, 80) returning id`,
    [tenantId],
  )).rows[0]!.id;
  // ⚠️ 80/minute est le PLAFOND du produit (`campaigns_rate_per_minute_check`, migration 0033). Une campagne
  // ne peut donc pas, par construction, servir de test de débit : sa vitesse est décidée par nous, pas par la
  // tuyauterie. Ce que ce scénario-ci éprouve est la REPRISE APRÈS KILL.
  //
  // 🔴 CE BANC NE MESURE PAS LE DÉBIT, et il ne prétend plus le contraire. Ce commentaire renvoyait à une
  // commande `webhooks` qui n'a jamais été écrite : une doc qui décrit du code absent est pire qu'une doc
  // manquante, parce qu'on croit la mesure faite. Relevé par le contre-audit du 2026-09-01. Ce qui manque
  // encore, et qui est listé dans `todo.md` : le débit des entrants, l'équité entre plusieurs espaces, la
  // rafale d'accusés, la concurrence API + worker sur un même numéro, et deux workers.
  // Destinataires matérialisés directement : le banc mesure l'ENVOI, pas la construction, et la création
  // passe déjà par ses propres tests.
  await c.query(
    `insert into campaign_recipients (campaign_id, contact_id, to_e164, status)
     select $1, id, phone_e164, 'pending' from contacts where tenant_id = $2`,
    [campaignId, tenantId],
  );
  await c.query(`update campaigns set status = 'running' where id = $1`, [campaignId]);
  console.log(JSON.stringify({ tenantId, campaignId, destinataires: nb }));
  await c.end();
}

/** Compteurs de la campagne du banc. */
async function compter(c: Client): Promise<Record<string, number>> {
  const r = await c.query<{ status: string; n: string }>(
    `select r.status, count(*)::text as n from campaign_recipients r
       join campaigns k on k.id = r.campaign_id join tenants t on t.id = k.tenant_id
      where t.name = $1 group by r.status`,
    [ESPACE],
  );
  const out: Record<string, number> = {};
  for (const l of r.rows) out[l.status] = Number(l.n);
  return out;
}

/** Suit l'avancement seconde par seconde et rend le débit observé. */
async function suivre(): Promise<void> {
  const c = await client();
  const debut = Date.now();
  let precedent = 0;
  for (let i = 0; i < 600; i += 1) {
    const compte = await compter(c);
    const finis = (compte.sent ?? 0) + (compte.failed ?? 0) + (compte.skipped ?? 0);
    const total = Object.values(compte).reduce((a, b) => a + b, 0);
    const secondes = (Date.now() - debut) / 1000;
    console.log(`${secondes.toFixed(0)}s ${JSON.stringify(compte)} debit=${(finis - precedent)}/s moyenne=${(finis / Math.max(1, secondes)).toFixed(0)}/s`);
    precedent = finis;
    if (finis >= total && total > 0) { console.log('TERMINE'); break; }
    await new Promise((r) => { setTimeout(r, 1000); });
  }
  await c.end();
}

/**
 * Le VERDICT après un kill : ce qui compte n'est pas que ça se termine, c'est que PERSONNE ne soit envoyé
 * deux fois et que personne ne reste coincé.
 */
async function verdict(): Promise<void> {
  const c = await client();
  const compte = await compter(c);
  const doublons = await c.query<{ n: string }>(
    // Un destinataire envoyé deux fois se verrait à un `message_id` réattribué : on compte les identifiants
    // de message distincts et on les compare au nombre d'envoyés. Un écart = un double envoi.
    `select count(*)::text as n from (
       select r.message_id from campaign_recipients r
         join campaigns k on k.id = r.campaign_id join tenants t on t.id = k.tenant_id
        where t.name = $1 and r.message_id is not null
        group by r.message_id having count(*) > 1
     ) d`,
    [ESPACE],
  );
  const coinces = await c.query<{ n: string }>(
    `select count(*)::text as n from campaign_recipients r
       join campaigns k on k.id = r.campaign_id join tenants t on t.id = k.tenant_id
      where t.name = $1 and r.status = 'sending'`,
    [ESPACE],
  );
  const campagne = await c.query<{ status: string }>(
    `select k.status from campaigns k join tenants t on t.id = k.tenant_id where t.name = $1`, [ESPACE],
  );
  console.log(JSON.stringify({
    compteurs: compte,
    identifiants_de_message_dupliques: Number(doublons.rows[0]!.n),
    destinataires_coinces_en_sending: Number(coinces.rows[0]!.n),
    statut_campagne: campagne.rows[0]?.status,
  }, null, 2));
  await c.end();
}

async function main(): Promise<void> {
  garde();
  const [commande, arg] = process.argv.slice(2);
  if (commande === 'semer') await semer(Number(arg ?? 5000));
  else if (commande === 'suivre') await suivre();
  else if (commande === 'verdict') await verdict();
  else throw new Error('commande attendue : semer <n> | suivre | verdict');
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
