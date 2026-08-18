/**
 * Pose une configuration MINIMALE sur un agent MBA : business info, FAQ, une skill de comportement.
 * Objectif : franchir les 3 premières tâches de l'écran « Manage Meta Business Agent » pour observer ce que
 * Meta débloque ensuite (notamment si le bouton « Add payment method » se dégrise), et rendre l'agent
 * testable via `agent_test` (dont les jetons ne sont PAS facturés, cf. doc Meta).
 *
 * ⚠️ CONTENU VOLONTAIREMENT SANS FAIT INVENTÉ. Ce numéro peut servir un vrai réseau de transport : on ne
 * pose donc aucun horaire, tarif, adresse ni délai. Les réponses renvoient vers les canaux officiels, et une
 * skill interdit explicitement à l'agent d'inventer ces informations. Un contenu réel se saisira depuis la
 * console, par le client.
 *
 * ⚠️ `business_info` est un PUT en REMPLACEMENT COMPLET : ce script lit l'existant et le fusionne avant
 * d'écrire, il n'écrase rien qui aurait été saisi côté Meta.
 * ⚠️ `agent_id` est passé EXPLICITEMENT à la création de skill : sans lui, Meta écrit sous « les settings les
 * plus récemment créés », donc potentiellement ailleurs que là où on croit.
 *
 * Usage :
 *   sudo docker compose run --rm --no-deps \
 *     -v /home/ubuntu/mba/scripts/mba-config-initiale.mts:/app/scripts/mba-config-initiale.mts \
 *     mba-api npx tsx scripts/mba-config-initiale.mts <phone_number_id>
 */
import { Pool } from 'pg';
import { decryptSecret } from '../src/crypto/secretbox';

const PN = process.argv[2];
if (!PN) {
  console.error('usage: npx tsx scripts/mba-config-initiale.mts <phone_number_id>');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const cred = await pool.query<{ business_token_enc: string | null }>(
  `select w.business_token_enc from phone_numbers p join waba_credentials w on w.waba_id = p.waba_id
    where p.id = $1 limit 1`,
  [PN],
);
const token = cred.rows[0]?.business_token_enc
  ? decryptSecret(cred.rows[0].business_token_enc, process.env.ENCRYPTION_KEY ?? '')
  : (process.env.META_ACCESS_TOKEN ?? '');
console.log(`token resolu (longueur ${token.length})`);

const BASE = 'https://api.facebook.com';
async function appel(methode: string, chemin: string, corps?: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${BASE}/${chemin}`, {
    method: methode,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-API-Version': '2.0.0',
      ...(corps ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(corps ? { body: JSON.stringify(corps) } : {}),
  });
  const txt = await res.text();
  let json: unknown = txt;
  try { json = JSON.parse(txt); } catch { /* réponse non JSON : on garde le texte */ }
  console.log(`${methode} ${chemin} -> HTTP ${res.status}`);
  if (res.status >= 400) console.log('  ', txt.slice(0, 400));
  return { status: res.status, json };
}

// --- 1. Business info (PUT = remplacement complet, donc lecture puis fusion).
const avant = await appel('GET', `${PN}/agent_config/business_info`);
const existant = (typeof avant.json === 'object' && avant.json !== null ? avant.json : {}) as Record<string, unknown>;
const nonVide = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';

await appel('PUT', `${PN}/agent_config/business_info`, {
  ...existant,
  business_description: nonVide(existant.business_description)
    ? existant.business_description
    : "Service d'information voyageurs d'un réseau de transport public par autobus. L'assistant renseigne sur "
      + "l'usage du réseau et oriente vers les canaux officiels. Configuration de test.",
  purchase_info: nonVide(existant.purchase_info)
    ? existant.purchase_info
    : "Les titres de transport s'achètent sur les canaux officiels du réseau (site, application, agence, "
      + 'dépositaires). Ne jamais annoncer un tarif : renvoyer vers ces canaux.',
});

// --- 2. FAQ : questions formulées comme un usager les pose, réponses autoportantes et sans fait inventé.
const FAQS: Array<{ question: string; answer: string }> = [
  {
    question: 'À quelle heure passe mon bus ?',
    answer:
      "Les horaires en temps réel sont disponibles sur le site et l'application officiels du réseau, ainsi "
      + "qu'aux points d'arrêt. Je n'annonce pas d'horaire de mémoire, car il change selon la ligne, le jour "
      + 'et les travaux en cours. Indiquez-moi votre ligne et votre arrêt et je vous oriente vers la bonne source.',
  },
  {
    question: 'Comment acheter un ticket ou un abonnement ?',
    answer:
      "L'achat se fait sur les canaux officiels du réseau : application mobile, site internet, agence "
      + 'commerciale et dépositaires agréés. Les tarifs et les conditions y sont à jour ; je ne les cite pas '
      + 'moi-même pour éviter toute information périmée.',
  },
  {
    question: "J'ai oublié un objet dans le bus, que faire ?",
    answer:
      "Les objets trouvés sont rassemblés par le réseau. Contactez le service client officiel en précisant la "
      + "ligne, le sens, la date et l'heure approximative du trajet, ainsi qu'une description de l'objet. "
      + 'Je peux transmettre votre demande à un conseiller.',
  },
];
for (const f of FAQS) await appel('POST', `${PN}/agent_config/faq`, f);

// --- 3. Skill de COMPORTEMENT (pas de contenu factuel) : le garde-fou anti-invention.
const settings = await appel('GET', `${PN}/agent_config/settings`);
const agentId = Array.isArray(settings.json) && settings.json[0] && typeof settings.json[0] === 'object'
  ? (settings.json[0] as { agent_id?: string }).agent_id
  : undefined;
console.log(`agent_id : ${agentId ?? 'INTROUVABLE (la skill irait sous les settings les plus recents)'}`);

await appel(
  'POST',
  `${PN}/agent_config/skills${agentId ? `?agent_id=${encodeURIComponent(agentId)}` : ''}`,
  {
    title: 'cadre-de-reponse-voyageur',
    description:
      "Appliquer à CHAQUE message d'un voyageur, quel que soit le sujet. Régit le ton, la langue et ce que "
      + "l'agent a le droit d'affirmer.",
    skill:
      "Réponds en français, de manière brève et courtoise, en vouvoyant.\n\n"
      + "N'invente JAMAIS un horaire, un tarif, un temps d'attente, une adresse ni une durée de trajet. Si "
      + "l'information n'est pas dans ta base de connaissance, dis-le simplement et oriente vers le canal "
      + 'officiel du réseau. Une information de transport fausse fait rater un bus : mieux vaut une réponse '
      + "qui renvoie qu'une réponse qui invente.\n\n"
      + "Ne promets jamais un remboursement, un geste commercial ni un délai de traitement.\n\n"
      + "Si le voyageur signale un incident de sécurité, une agression, un malaise ou un accident, ne traite "
      + 'pas la demande toi-même : passe immédiatement la main à un conseiller humain.\n\n'
      + "Si le voyageur demande à parler à quelqu'un, ou s'il reformule une troisième fois sans obtenir "
      + 'satisfaction, passe la main à un conseiller humain.',
  },
);

// --- 4. Relevé final.
console.log('\n===== ÉTAT APRÈS =====');
for (const r of ['business_info', 'faq', 'skills', 'settings']) {
  const res = await appel('GET', `${PN}/agent_config/${r}`);
  console.log(`  ${r}: ${JSON.stringify(res.json).slice(0, 300)}`);
}

await pool.end();
