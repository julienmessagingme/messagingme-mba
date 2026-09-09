// `HttpGet` et `fetchGet` vivent dans `src/lib/http-get.ts` depuis le 2026-09-09 : un second consommateur
// (le catalogue de modeles du Gateway) en avait besoin. Pas de re-export ici, deux chemins d'import pour la
// meme brique redonneraient les deux copies qu'on vient d'eviter.
import type { HttpGet } from '../lib/http-get';

/**
 * Ce qu'une clé d'API smsmode donne comme droits, lu chez eux.
 *
 * C'est ce que l'écran d'activation affiche : à quoi on a droit, et sous quel nom on parle. Rien n'est
 * inventé ici, tout vient de leur API Commons.
 */
export interface RcsChannelInfo {
  channelId: string;
  /** Nom du canal chez smsmode (ex. « CANAL RCS (test) »). */
  name: string;
  /** Nom de l'AGENT, celui que le destinataire voit (`defaultFromField`, ex. « MessagingMe »). */
  agentName: string;
  flow: string;
  dailyLimit: number | null;
  dailyUsed: number | null;
  monthlyLimit: number | null;
  monthlyUsed: number | null;
}

export type RcsChannelCheck =
  | { ok: true; channel: RcsChannelInfo }
  | { ok: false; reason: 'invalid_key' | 'no_rcs_channel' | 'unreachable'; detail: string };

const COMMONS = 'https://rest.smsmode.com/commons/v1/channels';

function nombre(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Vérifie une clé d'API smsmode et rend le canal RCS auquel elle donne accès.
 *
 * Mesuré contre l'API réelle : une clé est rattachée à UN canal. Une clé de canal SMS liste bien un canal,
 * mais de type SMS, et l'API RCS la refuse ensuite en 403 « Channel type mismatch ». On refuse donc ICI,
 * à la saisie, plutôt que de laisser l'opérateur découvrir l'erreur au premier envoi.
 */
export async function verifierCleRcs(transport: HttpGet, apiKey: string): Promise<RcsChannelCheck> {
  let res: { status: number; json: unknown };
  try {
    res = await transport.get(COMMONS, { 'X-Api-Key': apiKey, accept: 'application/json' });
  } catch (e) {
    return { ok: false, reason: 'unreachable', detail: e instanceof Error ? e.message : 'appel impossible' };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: 'invalid_key', detail: 'Clé refusée par smsmode.' };
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, reason: 'unreachable', detail: `smsmode a répondu ${res.status}.` };
  }

  const items = (res.json as { items?: unknown } | null)?.items;
  const canaux = Array.isArray(items) ? (items as Array<Record<string, unknown>>) : [];
  const rcs = canaux.find((c) => c.type === 'RCS');
  if (!rcs) {
    const types = [...new Set(canaux.map((c) => String(c.type ?? '?')))].join(', ') || 'aucun';
    return {
      ok: false,
      reason: 'no_rcs_channel',
      detail: `Cette clé ne donne pas accès à un canal RCS (canaux vus : ${types}). Chez smsmode une clé est rattachée à UN canal : demandez celle du canal RCS.`,
    };
  }

  return {
    ok: true,
    channel: {
      channelId: String(rcs.channelId ?? ''),
      name: String(rcs.name ?? ''),
      agentName: String(rcs.defaultFromField ?? ''),
      flow: String(rcs.flow ?? ''),
      dailyLimit: nombre(rcs.dailyConsumptionLimit),
      dailyUsed: nombre(rcs.dailyConsumption),
      monthlyLimit: nombre(rcs.monthlyConsumptionLimit),
      monthlyUsed: nombre(rcs.monthlyConsumption),
    },
  };
}
