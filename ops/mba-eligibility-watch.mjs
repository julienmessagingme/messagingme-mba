#!/usr/bin/env node
/**
 * Veille dispo MBA (Meta Business Agent).
 *
 * Poll `GET https://api.facebook.com/{phone_number_id}/agent_eligibility` (X-API-Version 2.0.0).
 * Baseline connue (2026-07) = HTTP 403 « The Meta Business AI Terms of Service must be accepted »
 * = MBA pas encore ouvert pour notre WABA FR. Quand ça CHANGE (200 {is_eligible}, ou tout autre
 * statut), on alerte sur Telegram (bot ops @Messagingmeapp_bot) + log + fichier d'état.
 *
 * Secrets lus À L'EXÉCUTION sur le VPS (jamais dans le repo) :
 *   - META_ACCESS_TOKEN : depuis /home/ubuntu/mba/.env.prod
 *   - telegramBotToken + chatId : depuis /home/ubuntu/messagingme-pilot/config.json
 *
 * Lancé par cron. Aucune dépendance externe (fetch natif Node 18+).
 */
import fs from 'node:fs';

const PHONE_NUMBER_ID = process.env.MBA_PHONE_NUMBER_ID || '1234840649713976';
const ENV_PROD = process.env.MBA_ENV_FILE || '/home/ubuntu/mba/.env.prod';
const OPS_CONFIG = process.env.OPS_CONFIG_FILE || '/home/ubuntu/messagingme-pilot/config.json';
const STATE_FILE = process.env.MBA_STATE_FILE || '/home/ubuntu/mba/.mba-eligibility-state.json';
const DISPLAY = process.env.MBA_DISPLAY_NUMBER || '+33 5 25 68 02 50';

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function readEnvVar(file, key) {
  try {
    const m = fs.readFileSync(file, 'utf8').match(new RegExp('^' + key + '=(.*)$', 'm'));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

async function sendTelegram(text) {
  try {
    const c = JSON.parse(fs.readFileSync(OPS_CONFIG, 'utf8'));
    if (!c.telegramBotToken || !c.chatId) {
      log('Telegram non configuré (config.json) -> alerte loggée seulement');
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

/** Réduit la réponse à un état stable comparable d'un run à l'autre. */
function classify(status, body) {
  const blob = JSON.stringify(body ?? {});
  if (status === 403 && /Meta Business AI Terms/i.test(blob)) return 'BLOCKED_TOS';
  if (status === 200) return `ELIGIBLE:${body && typeof body === 'object' ? body.is_eligible : 'unknown'}`;
  return `OTHER:${status}`;
}

async function main() {
  const token = process.env.META_ACCESS_TOKEN || readEnvVar(ENV_PROD, 'META_ACCESS_TOKEN');
  if (!token) {
    log('ERREUR: META_ACCESS_TOKEN introuvable (' + ENV_PROD + ')');
    process.exit(1);
  }

  let status;
  let body;
  try {
    const res = await fetch(`https://api.facebook.com/${PHONE_NUMBER_ID}/agent_eligibility`, {
      headers: { authorization: `Bearer ${token}`, 'X-API-Version': '2.0.0' },
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch (e) {
    // Erreur réseau transitoire : on NE modifie pas l'état (pas un changement réel).
    log('Poll KO (réseau), état précédent conservé: ' + e.message);
    process.exit(0);
  }

  const state = classify(status, body);
  const summary = `HTTP ${status} ${JSON.stringify(body ?? {}).slice(0, 400)}`;
  log(`état=${state} | ${summary}`);

  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    /* pas encore de baseline */
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify({ state, status, summary, checkedAt: new Date().toISOString() }, null, 2));

  if (!prev) {
    log('Baseline établie, pas d’alerte.');
    return;
  }
  if (prev.state === state) {
    log('Inchangé.');
    return;
  }

  const opened = prev.state === 'BLOCKED_TOS' && state !== 'BLOCKED_TOS';
  const head = opened ? '🟢🚀 MBA BOUGE' : '🔔 MBA agent_eligibility a changé';
  const msg =
    `${head} — numéro ${DISPLAY}\n` +
    `Avant : ${prev.state}\n` +
    `Maintenant : ${state}\n` +
    `${summary}\n` +
    (opened
      ? '\n➡️ Le mur « ToS Meta Business AI » semble levé. Va vérifier l’onboarding MBA (agent_onboarding) sur notre WABA.'
      : '');
  log('CHANGEMENT DÉTECTÉ -> alerte Telegram');
  await sendTelegram(msg);
}

main().catch((e) => {
  log('Erreur fatale: ' + (e && e.message ? e.message : String(e)));
  process.exit(1);
});
