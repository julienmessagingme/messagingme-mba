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
  // Reperee le 2026-08-18 en relisant les pages : referencee par Meta, jamais lue par notre corpus.
  ['capabilities', `${BASE}/capabilities`],
  // Pages PLAUSIBLES mais jamais vues : un passage de 404 a 200 est le signal le plus interessant
  // de tout ce script, c'est ainsi qu'on verra arriver une nouveaute.
  ['pricing', `${BASE}/pricing`],
  ['webhooks', `${BASE}/reference/operate/webhooks`],
  ['changelog', `${BASE}/changelog`], // apparue le 2026-08-14, c'est elle qui a annonce l'action `take`
  // ⚠️ ANGLE MORT COMBLE le 2026-08-26. Meta a publie une page de reference (ui-skills) et trois guides
  // entre le 14 et le 25 aout, soit une centaine de milliers de caracteres de doc, et cette sonde n'a RIEN
  // dit : elle ne surveille qu'une liste ecrite en dur, et le groupe `usage-guides/` n'y figurait pas.
  // Une veille ne voit que ce qu'on lui a nomme. C'est le changelog qui les a revelees, en les liant.
  ['ui-skills', `${BASE}/reference/configure/ui-skills`],
  ['guide-ui-skills', `${BASE}/usage-guides/writing-ui-skills`],
  ['guide-booking', `${BASE}/usage-guides/booking-and-reservation-agent`],
  ['guide-purchase', `${BASE}/usage-guides/single-purchase-transaction-agent`],
  ['usage-guides', `${BASE}/usage-guides`], // le repertoire : c'est lui qui portera les guides suivants
  // ⚠️ MEME ANGLE MORT, LE SOIR MEME. Trois pages entieres vivaient dans la nav de Meta sans AUCUNE
  // entree de changelog, donc sans le lien qui avait revele les guides le matin. Le garde-fou « le
  // changelog les revelera » ne vaut donc rien : seule la NAV nomme tout. D'ou `verifierNav()` plus bas.
  // (`reference/operate/agent-insights`, devinee le 2026-08-18, a ete RETIREE : 33 executions a zero
  // caractere, absente de la nav, et signature identique a une URL inventee. La vraie page est
  // `reference/insights/conversation-turns`, sous un groupe de nav « Insights » entierement neuf.)
  ['agent-budget', `${BASE}/reference/configure/agent-budget`],
  ['conversation-turns', `${BASE}/reference/insights/conversation-turns`],
  ['troubleshooting', `${BASE}/troubleshooting`],
];

/** Les chemins connus, pour confronter la liste ci-dessus a la nav de Meta. */
const CHEMINS_SUIVIS = new Set(PAGES.map(([, url]) => url.replace(`${BASE}/`, '').replace(/\/+$/, '')));

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
    // ⚠️ Les tests de mots sont ancres sur des LIMITES DE MOTS. Sans `\b`, une liste de classes CSS de
    // Meta (`x1motxo8 x1dg8jwx xjliv6m ...`) passait : le moteur y trouvait « txxm xcxolhg xwczod » a
    // l'interieur des jetons. Deux de ces listes etaient donc dans le corpus de TOUTES les pages, et
    // Meta les a renumerotees le 2026-08-20 : 20 fausses alertes d'un coup, a longueur de corpus
    // rigoureusement identique, qui ont efface la vraie date de dernier changement de 19 pages.
    if (/^x[0-9a-z]{5,8}(?: x[0-9a-z]{5,8}){2,}/.test(s)) continue;  // liste de classes CSS
    if (!/\b[a-zA-Z]{3,}\b \b[a-zA-Z]{3,}\b \b[a-zA-Z]{3,}\b/.test(s)) continue; // 3 vrais mots enchaines
    if (/[0-9a-f]{24,}/i.test(s)) continue;                          // jeton de session
    if (s.split(' ').length < 8) continue;
    out.add(s);
  }
  return [...out].sort().join('\n');
}

/**
 * Version du CORPUS. A INCREMENTER des qu'on touche a `prose()` : toutes les empreintes bougent alors
 * d'un coup, et sans ce garde-fou l'execution suivante alerterait sur les 28 pages a la fois, ce qui
 * ressemble trait pour trait a une vraie salve et ne veut rien dire. Un changement de version rebase
 * l'etat en silence, exactement comme un premier run.
 */
const VERSION_CORPUS = 2;

/**
 * La liste des pages est ecrite en dur, donc la sonde ne voit que ce qu'on lui a nomme : c'est ce qui
 * a laisse passer quatre pages le 2026-08-26 (matin) puis trois autres le meme soir. La NAV de Meta,
 * elle, les nomme toutes. On la lit donc a chaque tour et on alerte sur tout chemin inconnu.
 */
async function verifierNav(connus) {
  const res = await fetch(`${BASE}/overview`, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; messagingme-docs-watch/1.0)', 'accept-language': 'en' },
    redirect: 'follow',
  });
  if (res.status !== 200) return { chemins: [], inconnus: [] };
  const html = (await res.text()).replace(/\\\//g, '/');
  const chemins = new Set();
  for (const m of html.matchAll(/\/documentation\/meta-business-agent\/([a-z0-9/-]+)/g)) {
    const c = m[1].replace(/\/+$/, '');
    if (c && !c.includes('#')) chemins.add(c);
  }
  return { chemins: [...chemins].sort(), inconnus: [...chemins].filter((c) => !connus.has(c) && !c.endsWith('.md')).sort() };
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
  const meta = prev._meta ?? {};
  const premierRun = Object.keys(prev).length === 0;
  // Un changement de `prose()` deplace TOUTES les empreintes : on rebase sans alerter, sinon la salve
  // est indiscernable d'une vraie journee de publications chez Meta.
  const rebase = premierRun || (meta.version ?? 1) !== VERSION_CORPUS;
  const maintenant = new Date().toISOString();
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
    const p = prev[cle];
    // `change_le` repond sans rejouer le journal a « depuis quand cette page n'a pas bouge ? », qui
    // etait jusqu'ici impossible : l'etat ne portait aucune date.
    let changeLe = p?.change_le ?? null;
    if (!p) {
      if (!rebase) changements.push(`🆕 ${cle} : page suivie pour la premiere fois (${e.contenu ? 'avec' : 'sans'} contenu)`);
      changeLe = maintenant;
    } else if (rebase) {
      /* corpus recalcule : on reprend l'empreinte sans rien conclure de son deplacement */
    } else if (!p.contenu && e.contenu) {
      // LE signal le plus interessant : une page annoncee ou devinee vient d'etre publiee.
      changements.push(`🟢 NOUVELLE PAGE : ${cle} (${e.len} caracteres de doc)\n   ${url}`);
      changeLe = maintenant;
    } else if (p.contenu && !e.contenu) {
      changements.push(`⚠️ ${cle} : la page a PERDU son contenu (HTTP ${e.status}, ${e.len} car)\n   ${url}`);
      changeLe = maintenant;
    } else if (e.contenu && p.hash !== e.hash) {
      const delta = e.len - (p.len || 0);
      changements.push(`✏️ ${cle} : contenu modifie (${delta >= 0 ? '+' : ''}${delta} caracteres)\n   ${url}`);
      changeLe = maintenant;
    }
    courant[cle] = { status: e.status, contenu: e.contenu, hash: e.hash, len: e.len, change_le: changeLe };
    log(`${cle}: HTTP ${e.status} contenu=${e.contenu} hash=${e.hash ?? '-'} len=${e.len}`);
  }

  // La nav de Meta est la SEULE source exhaustive des pages existantes. Tout chemin qu'elle nomme et
  // que la liste ci-dessus ignore est signale une fois, puis memorise pour ne pas re-alerter a chaque
  // tour. Une erreur reseau ici ne doit pas faire perdre la liste deja connue.
  let navConnus = Array.isArray(meta.nav_signales) ? meta.nav_signales : [];
  try {
    const connus = new Set([...CHEMINS_SUIVIS, ...navConnus]);
    const { chemins, inconnus } = await verifierNav(connus);
    log(`nav: ${chemins.length} chemins, ${inconnus.length} inconnu(s)`);
    if (inconnus.length > 0) {
      navConnus = [...new Set([...navConnus, ...inconnus])].sort();
      if (!rebase) {
        changements.push(
          `🔎 ${inconnus.length} page(s) dans la nav de Meta que la sonde NE SUIT PAS :\n` +
            inconnus.map((c) => `   ${BASE}/${c}`).join('\n'),
        );
      }
    }
  } catch (err) {
    log(`nav: KO (${err.message}), liste connue conservee`);
  }

  courant._meta = { version: VERSION_CORPUS, vu_le: maintenant, nav_signales: navConnus };
  fs.writeFileSync(STATE_FILE, JSON.stringify(courant, null, 2));

  if (rebase) {
    log(`Baseline etablie sur ${Object.keys(courant).length - 1} pages (corpus v${VERSION_CORPUS}), pas d'alerte.`);
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
