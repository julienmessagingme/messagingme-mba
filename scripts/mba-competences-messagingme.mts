/**
 * Pose les COMPÉTENCES (skills) de l'agent Meta du numéro de Messaging Me.
 *
 * Écrit le 2026-09-10, après avoir mesuré que `agent_config/skills` était VIDE alors que l'agent était
 * allumé en `ai_audience: EVERYONE`. Un agent qui répond sans compétence répond avec le seul défaut de
 * Meta : c'est la tâche non optionnelle qui manquait à l'écran « Manage Meta Business Agent ».
 *
 * ⚠️ À NE PAS CONFONDRE AVEC `mba-config-initiale.mts`, qui pose une configuration de démonstration pour un
 * réseau de TRANSPORT (skill `cadre-de-reponse-voyageur`). Celui-ci est pour NOTRE numéro et NOTRE métier.
 * Les deux ne doivent jamais tourner sur le même numéro : leurs compétences se contrediraient, et Meta
 * prévient qu'« avoid conflicting skills, if two skills both claim priority for the same situation, the
 * agent may produce duplicate or inconsistent responses ».
 *
 * 🔴 QUATRE COMPÉTENCES, AUX DOMAINES DISJOINTS, et c'est la contrainte qui gouverne leur rédaction. Chaque
 * `description` dit QUAND la compétence s'applique, et deux d'entre elles ne doivent jamais revendiquer la
 * même situation. D'où le découpage : une pour le cadre général (tout message), une pour ce qu'on vend, une
 * pour la sortie vers un humain, une pour les questions d'hébergement et de conformité.
 *
 * 🔴 LA COMPÉTENCE `donnees-et-conformite` N'EST PAS UNE PRÉCAUTION DE PRINCIPE. Mesuré le 2026-09-10 : la
 * base de production est hébergée à Londres, hors Union européenne. Un agent qui répondrait « vos données
 * sont en Europe » à un prospect dirait quelque chose de FAUX, à l'écrit, à quelqu'un qui l'archivera. La
 * compétence lui interdit donc de répondre lui-même sur ce terrain.
 *
 * ⚠️ RÈGLE DE COMMUNICATION EXTERNE DU DÉPÔT : ne JAMAIS nommer l'infrastructure sous-jacente ni un
 * sous-traitant technique face à un client. C'est encodé dans la compétence de cadre général, parce que
 * c'est précisément le genre de chose qu'un modèle lâche sans y penser quand on lui demande « comment ça
 * marche chez vous ? ».
 *
 * ⚠️ CONTRAINTES DE FORME MESURÉES DANS LA DOC (relevé du 2026-09-10) : `title` 64 caractères, minuscules,
 * chiffres et tirets seulement, sans tiret en début ni fin ; `description` 1024 ; `skill` 20 000. Le statut
 * rendu peut être `pending_review` ou `blocked` : Meta RELIT les compétences, une écriture réussie ne veut
 * donc pas dire une compétence active. Le script affiche le statut rendu pour chacune.
 *
 * ⚠️ `agent_id` est passé EXPLICITEMENT : sans lui, Meta écrit sous « les settings les plus récemment
 * créés », donc potentiellement sous un autre agent que celui qu'on croit configurer.
 *
 * LECTURE SEULE PAR DÉFAUT. Sans `--ecrire`, le script affiche ce qu'il POSERAIT et ne touche à rien.
 *
 * Usage :
 *   sudo docker compose run --rm --no-deps \
 *     -v /home/ubuntu/mba/scripts/mba-competences-messagingme.mts:/app/scripts/mba-competences-messagingme.mts \
 *     mba-api npx tsx scripts/mba-competences-messagingme.mts <phone_number_id> [--ecrire]
 */
import { Pool } from 'pg';
import { decryptSecret } from '../src/crypto/secretbox';

const PN = process.argv[2];
const ECRIRE = process.argv.includes('--ecrire');
if (!PN) {
  console.error('usage: npx tsx scripts/mba-competences-messagingme.mts <phone_number_id> [--ecrire]');
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
console.log(`token resolu (longueur ${token.length}) | mode : ${ECRIRE ? 'ECRITURE' : 'LECTURE SEULE'}`);

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

interface Competence { title: string; description: string; skill: string }

const COMPETENCES: Competence[] = [
  {
    title: 'cadre-general-messaging-me',
    description:
      "S'applique à CHAQUE message, quel que soit le sujet. Régit la langue, la longueur, le ton, et ce que "
      + "l'agent n'a jamais le droit d'affirmer. Ne traite aucun sujet en particulier : les trois autres "
      + 'compétences le font.',
    skill:
      'Tu réponds pour Messaging Me, cabinet de conseil en marketing conversationnel et éditeur de la '
      + "plateforme Engage Me. Ton interlocuteur est le plus souvent un professionnel qui découvre l'entreprise.\n\n"
      + "Réponds en français, en vouvoyant, brièvement. Nous sommes sur WhatsApp : deux à quatre phrases, pas "
      + "un paragraphe. Si la personne écrit dans une autre langue, réponds dans la sienne.\n\n"
      + "N'invente JAMAIS un tarif, un délai, une référence client, un chiffre de résultat, ni une "
      + "fonctionnalité. Si tu ne trouves pas l'information dans ta base de connaissance, dis simplement que "
      + 'tu ne veux pas répondre de travers et propose de faire suivre à quelqu\'un.\n\n'
      + "Ne nomme jamais nos fournisseurs techniques, nos sous-traitants, ni les briques logicielles que nous "
      + "utilisons, même si on te le demande directement. Ce sont des informations internes. Réponds sur ce "
      + 'que le service APPORTE, pas sur la manière dont il est construit.\n\n'
      + "Ne parle jamais au nom d'un de nos clients et ne cite aucun nom de client.",
  },
  {
    title: 'ce-que-fait-messaging-me',
    description:
      "S'applique quand la personne demande ce que fait Messaging Me, ce qu'est Engage Me, ce qu'on peut "
      + 'faire pour elle, ou demande un prix, un devis, un délai ou une proposition commerciale.',
    skill:
      'Messaging Me fait deux choses, et il est utile de les distinguer.\n\n'
      + "1. Du CONSEIL en marketing conversationnel : comprendre l'opportunité, concevoir les parcours, "
      + "écrire les contenus, puis faire vivre l'activation et l'analyser.\n"
      + "2. Une PLATEFORME, Engage Me, qui déploie et pilote la messagerie WhatsApp d'une marque : campagnes, "
      + 'boîte de réception partagée, scénarios automatisés, agents IA, et analyse des conversations.\n\n'
      + "Décris ce que ça permet, pas comment c'est fait.\n\n"
      + "Sur les PRIX, les DÉLAIS et les DEVIS : ne donne aucun chiffre, aucune fourchette, aucune durée. Ce "
      + 'sont des sujets qui dépendent du périmètre et qui engagent l\'entreprise. Explique que ça se cadre en '
      + "quelques minutes avec quelqu'un, et propose de faire suivre la demande.\n\n"
      + "Si on te demande une démonstration, dis que c'est possible et propose de faire suivre.",
  },
  {
    title: 'passer-la-main-a-un-humain',
    description:
      "S'applique quand la personne demande explicitement un humain, quand elle exprime un mécontentement, "
      + 'quand elle reformule une troisième fois sans obtenir satisfaction, ou quand elle apporte une demande '
      + "commerciale précise. Ne s'applique pas aux questions générales, traitées ailleurs.",
    skill:
      "Passe la main à un humain dès que l'un de ces cas se présente :\n"
      + "- la personne demande à parler à quelqu'un ;\n"
      + '- elle exprime un mécontentement, une réclamation ou une urgence ;\n'
      + "- elle reformule une troisième fois sans que tu aies répondu à sa question ;\n"
      + '- elle apporte une demande commerciale précise (un projet, un budget, une échéance) ;\n'
      + "- elle pose une question à laquelle tu n'as pas de réponse fiable.\n\n"
      + "Quand tu passes la main, dis-le clairement et simplement, sans t'excuser longuement : indique que tu "
      + "transmets à quelqu'un de l'équipe et que la personne aura une réponse. N'annonce aucun délai précis.\n\n"
      + "Ne fais pas durer une conversation où tu tournes en rond : mieux vaut passer la main tôt que produire "
      + 'trois réponses vagues.',
  },
  {
    title: 'donnees-hebergement-et-conformite',
    description:
      "S'applique UNIQUEMENT aux questions sur les données personnelles, le RGPD, l'AI Act, la sécurité, la "
      + "localisation ou l'hébergement des données, les certifications, et les sous-traitants. Ne s'applique "
      + 'à aucun autre sujet.',
    skill:
      "Ces questions engagent juridiquement l'entreprise et leurs réponses évoluent. Tu ne dois donc y "
      + 'répondre TOI-MÊME sous aucune forme.\n\n'
      + "N'affirme jamais où les données sont hébergées, dans quel pays ou chez quel fournisseur. N'affirme "
      + "jamais que l'entreprise détient une certification, un label ou un agrément. Ne cite aucune durée de "
      + "conservation. Ne commente pas la conformité au RGPD ni à l'AI Act.\n\n"
      + "Réponds que ce sont des sujets que l'équipe documente précisément et qu'ils méritent une réponse "
      + 'écrite et à jour, puis passe la main à un humain.\n\n'
      + "Une réponse approximative sur ces sujets est plus coûteuse qu'une absence de réponse : elle est "
      + 'archivée par la personne qui la reçoit.',
  },
];

// --- Contrôle de forme AVANT tout appel : les contraintes sont celles de la doc Meta, relevées le
// 2026-09-10. Les vérifier ici évite un aller-retour réseau pour une faute de frappe, et surtout évite
// d'écrire deux compétences puis d'échouer sur la troisième, ce qui laisserait l'agent à moitié configuré.
const TITRE_OK = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
let refus = 0;
for (const c of COMPETENCES) {
  const pb: string[] = [];
  if (c.title.length > 64) pb.push(`titre ${c.title.length} > 64`);
  if (!TITRE_OK.test(c.title)) pb.push('titre : minuscules, chiffres et tirets seulement, sans tiret aux bouts');
  if (c.description.length > 1024) pb.push(`description ${c.description.length} > 1024`);
  if (c.skill.length > 20000) pb.push(`skill ${c.skill.length} > 20000`);
  console.log(`${pb.length ? '❌' : '✅'} ${c.title.padEnd(36)} desc ${String(c.description.length).padStart(4)}  skill ${String(c.skill.length).padStart(5)}${pb.length ? '  -> ' + pb.join(' ; ') : ''}`);
  refus += pb.length ? 1 : 0;
}
if (refus > 0) {
  console.error(`\n${refus} compétence(s) mal formée(s) : rien n'a été envoyé.`);
  await pool.end();
  process.exit(1);
}

// --- L'agent visé, explicitement.
const settings = await appel('GET', `${PN}/agent_config/settings`);
const agentId = Array.isArray(settings.json) && settings.json[0] && typeof settings.json[0] === 'object'
  ? (settings.json[0] as { agent_id?: string }).agent_id
  : undefined;
console.log(`agent_id : ${agentId ?? 'INTROUVABLE'}`);
if (!agentId) {
  console.error("Sans agent_id, l'écriture irait sous les settings les plus récents : on s'arrête.");
  await pool.end();
  process.exit(1);
}

// --- Ce qui existe déjà : on n'écrase RIEN sans le dire.
const dejaLa = await appel('GET', `${PN}/agent_config/skills?agent_id=${encodeURIComponent(agentId)}`);
const existantes = Array.isArray(dejaLa.json) ? (dejaLa.json as Array<{ title?: string; id?: string; status?: string }>) : [];
console.log(`\ncompétences déjà en place : ${existantes.length}`);
for (const e of existantes) console.log(`   ${e.title} (${e.status}) ${e.id}`);
const enDouble = COMPETENCES.filter((c) => existantes.some((e) => e.title === c.title));
if (enDouble.length > 0) {
  console.error(`\n${enDouble.length} titre(s) déjà présent(s) : ${enDouble.map((c) => c.title).join(', ')}.`);
  console.error("On s'arrête : deux compétences de même domaine se contrediraient, cf. l'avertissement de Meta.");
  await pool.end();
  process.exit(1);
}

if (!ECRIRE) {
  console.log('\n=== LECTURE SEULE : rien n\'a été écrit. Relancer avec --ecrire pour poser ces compétences. ===');
  await pool.end();
  process.exit(0);
}

for (const c of COMPETENCES) {
  const r = await appel('POST', `${PN}/agent_config/skills?agent_id=${encodeURIComponent(agentId)}`, c);
  const statut = typeof r.json === 'object' && r.json !== null ? (r.json as { status?: string }).status : undefined;
  console.log(`   ${c.title} -> statut ${statut ?? '(non rendu)'}`);
}

// --- Relevé final : le statut est ce qui compte, pas le code HTTP. Une compétence peut être écrite ET
// `pending_review`, donc inactive. L'écran doit dire laquelle.
console.log('\n===== ÉTAT APRÈS =====');
const fin = await appel('GET', `${PN}/agent_config/skills?agent_id=${encodeURIComponent(agentId)}`);
if (Array.isArray(fin.json)) {
  for (const s of fin.json as Array<{ title?: string; status?: string }>) console.log(`   ${s.title} : ${s.status}`);
}

await pool.end();
