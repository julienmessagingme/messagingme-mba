#!/usr/bin/env node
/**
 * Veille sur la DOCUMENTATION Meta Business Agent.
 *
 * La doc MBA arrive au compte-gouttes avant le 01/08 : de nouvelles pages apparaissent, d'anciennes
 * changent. Ce script empreinte chaque page suivie et alerte sur Telegram quand une empreinte bouge
 * ou qu'une page jusque-la absente (404) devient disponible.
 *
 * Jumeau de `mba-eligibility-watch.mjs`, qui surveille l'ACCES (403 ToS). Celui-ci surveille le
 * CONTENU. Les deux sont utiles : la doc peut s'enrichir bien avant que l'acces s'ouvre.
 *
 * CE QU'ON EMPREINTE, et pourquoi ce n'est ni le HTML brut ni le texte visible.
 *
 * Les pages developers.facebook.com sont rendues cote client : le HTML fait 800 Ko mais ne contient
 * presque aucun texte hors des balises. Une premiere version de ce script retirait les <script> puis
 * empreintait le texte restant, et obtenait 10 a 50 caracteres par page, identiques d'une page a
 * l'autre. Elle n'aurait JAMAIS rien detecte, tout en donnant l'illusion de surveiller. Verifie et
 * corrige le 2026-07-20.
 *
 * La prose documentaire vit en fait dans des blocs JSON embarques. On extrait donc les chaines JSON
 * longues qui ressemblent a du texte (au moins 8 mots), en excluant les jetons hexadecimaux. Mesures
 * sur la page overview : 2137 caracteres de corpus, empreinte IDENTIQUE sur deux telechargements
 * consecutifs (donc pas de faux positif de session), contre 54 caracteres pour une page inexistante
 * (donc un ecart net entre « page reelle » et « coquille »).
 *
 * Un faux positif coute une lecture, un faux negatif coute de rater l'ouverture : en cas de doute, on
 * alerte.
 *
 * Secrets lus A L'EXECUTION sur le VPS (jamais dans le repo) :
 *   - telegramBotToken + chatId : /home/ubuntu/messagingme-pilot/config.json
 *
 * Lance par cron. Aucune dependance externe (fetch natif).
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const OPS_CONFIG = process.env.OPS_CONFIG_FILE || '/home/ubuntu/messagingme-pilot/config.json';
const STATE_FILE = process.env.MBA_DOCS_STATE_FILE || '/home/ubuntu/mba/.mba-docs-state.json';
const BASE = 'https://developers.facebook.com/documentation/meta-business-agent';

/** Les pages suivies. Ajouter ici toute nouvelle page reperee. */
const PAGES = [
  ['overview', `${BASE}/overview`],
  ['get-started', `${BASE}/get-started`],
  ['eligibility', `${BASE}/reference/onboard/agent-eligibility`],
  ['onboarding', `${BASE}/reference/onboard/agent-onboarding`],
  ['settings', `${BASE}/reference/onboard/agent-settings`],
  ['allowlist', `${BASE}/reference/onboard/agent-allowlist`],
  ['skills', `${BASE}/reference/configure/agent-skills`],
  ['knowledge-business-info', `${BASE}/reference/configure/agent-knowledge-business-info`],
  ['knowledge-faqs', `${BASE}/reference/configure/agent-knowledge-faqs`],
  ['knowledge-websites', `${BASE}/reference/configure/agent-knowledge-websites`],
  ['knowledge-files', `${BASE}/reference/configure/agent-knowledge-files`],
  ['connectors', `${BASE}/reference/configure/connectors`],
  ['connector-tools', `${BASE}/reference/configure/connector-tools`],
  ['thread-control', `${BASE}/reference/operate/thread-control-cloud-api`],
  ['agent-event', `${BASE}/reference/operate/agent-event`],
  ['agent-test', `${BASE}/reference/operate/agent-test`],
  ['agent-eval', `${BASE}/reference/operate/agent-eval`],
  ['delete-agent', `${BASE}/reference/delete-agent/delete-agent`],
  // Pages PLAUSIBLES mais jamais vues : un passage de 404 a 200 est le signal le plus interessant
  // de tout ce script, c'est ainsi qu'on verra arriver une nouveaute.
  ['pricing', `${BASE}/pricing`],
  ['webhooks', `${BASE}/reference/operate/webhooks`],
  ['changelog', `${BASE}/changelog`],
];

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function sendTelegram(text) {
  try {
    const c = JSON.parse(fs.readFileSync(OPS_CONFIG, 'utf8'));
    if (!c.telegramBotToken || !c.chatId) {
      log('Telegram non configure (config.json) -> alerte loggee seulement');
      return;
    }
    const res = await fetch(`https://api.telegram.org/bot${c.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: c.chatId, text, disable_web_page_preview: true }),
    });
    log('Telegram sendMessage -> HTTP ' + res.status);
  } catch (e) {
    log('Telegram KO: ' + e.message);
  }
}

/**
 * Corpus de prose d'une page : les chaines JSON longues qui ressemblent a du texte redige.
 * Deduplique et trie, donc insensible a l'ordre de serialisation.
 */
function prose(html) {
  const out = new Set();
  const re = /"((?:[^"\\]|\\.){60,2000})"/g;
  for (const m of html.matchAll(re)) {
    const s = m[1]
      .replace(/\\[nrt]/g, ' ')
      .replace(/\\"/g, '"')
      .replace(/\\u[0-9a-f]{4}/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!/[a-zA-Z]{3,} [a-zA-Z]{3,} [a-zA-Z]{3,}/.test(s)) continue; // au moins 3 mots enchaines
    if (/[0-9a-f]{24,}/i.test(s)) continue;                          // jeton de session
    if (s.split(' ').length < 8) continue;
    out.add(s);
  }
  return [...out].sort().join('\n');
}

/**
 * En dessous de ce seuil, la page ne porte pas de documentation : c'est une coquille rendue cote
 * client (mesure : 54 caracteres sur une URL inexistante, contre 2137 sur une vraie page).
 * Le passage sous/au-dessus de ce seuil est le signal « la page existe maintenant ».
 */
const SEUIL_CONTENU = 300;

async function empreinte(url) {
  const res = await fetch(url, {
    headers: {
      // Sans User-Agent explicite, Meta sert parfois une page de garde differente.
      'user-agent': 'Mozilla/5.0 (compatible; messagingme-docs-watch/1.0)',
      'accept-language': 'en',
    },
    redirect: 'follow',
  });
  if (res.status !== 200) return { status: res.status, contenu: false, hash: null, len: 0 };
  const corpus = prose(await res.text());
  return {
    status: 200,
    contenu: corpus.length >= SEUIL_CONTENU,
    hash: crypto.createHash('sha256').update(corpus).digest('hex').slice(0, 16),
    len: corpus.length,
  };
}

async function main() {
  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    /* premier run : on etablit la baseline sans alerter */
  }
  const premierRun = Object.keys(prev).length === 0;
  const courant = {};
  const changements = [];

  for (const [cle, url] of PAGES) {
    let e;
    try {
      e = await empreinte(url);
    } catch (err) {
      // Erreur reseau : on REPORTE l'etat precedent plutot que d'inventer un changement.
      log(`${cle}: reseau KO (${err.message}), etat precedent conserve`);
      if (prev[cle]) courant[cle] = prev[cle];
      continue;
    }
    courant[cle] = { status: e.status, contenu: e.contenu, hash: e.hash, len: e.len };
    const p = prev[cle];
    if (!p) {
      if (!premierRun) changements.push(`🆕 ${cle} : page suivie pour la premiere fois (${e.contenu ? 'avec' : 'sans'} contenu)`);
    } else if (!p.contenu && e.contenu) {
      // LE signal le plus interessant : une page annoncee ou devinee vient d'etre publiee.
      changements.push(`🟢 NOUVELLE PAGE : ${cle} (${e.len} caracteres de doc)\n   ${url}`);
    } else if (p.contenu && !e.contenu) {
      changements.push(`⚠️ ${cle} : la page a PERDU son contenu (HTTP ${e.status}, ${e.len} car)\n   ${url}`);
    } else if (e.contenu && p.hash !== e.hash) {
      const delta = e.len - (p.len || 0);
      changements.push(`✏️ ${cle} : contenu modifie (${delta >= 0 ? '+' : ''}${delta} caracteres)\n   ${url}`);
    }
    log(`${cle}: HTTP ${e.status} contenu=${e.contenu} hash=${e.hash ?? '-'} len=${e.len}`);
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(courant, null, 2));

  if (premierRun) {
    log(`Baseline etablie sur ${Object.keys(courant).length} pages, pas d'alerte.`);
    return;
  }
  if (changements.length === 0) {
    log('Aucun changement.');
    return;
  }

  log(`${changements.length} changement(s) -> alerte Telegram`);
  await sendTelegram(
    `📚 Doc Meta Business Agent : ${changements.length} changement(s)\n\n` +
      changements.join('\n') +
      `\n\n➡️ Retelecharger les pages touchees et relancer la mise a jour de` +
      ` messagingme-mba/docs/MBA-API-REFERENCE.md.`,
  );
}

main().catch((e) => {
  log('Erreur fatale: ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
