import { z } from 'zod';
import type { HttpGet } from '../../lib/http-get';
import type { CompteurDebit } from '../../db/debit';

/**
 * La consommation de l'équipe sur la passerelle d'IA de Vercel (lot 14, décision de Julien du 2026-10-12). Le budget
 * d'ÉQUIPE (100 $ par mois) est le seul contre-feu au-dessus des plafonds par clé : à 100 %, Vercel refuse chaque appel
 * de l'équipe (402 `quota_for_entity_exceeded`), donc chaque bot de chaque client se tait d'un coup. Julien le relève
 * lui-même ; ce module le prévient avant.
 *
 * 🔴 LA FORME DE LA RÉPONSE A ÉTÉ MESURÉE, PAS LUE : la documentation de Vercel donne le point (`GET
 * /ai-gateway/budgets/list?teamId=`, jeton de compte) mais pas sa réponse. Lue en lecture seule le 2026-10-12 :
 * `{ budgets: [{ scopeType, limitAmount, currentSpend, refreshPeriod, active, archived, ... }] }`, sans pagination, en
 * dollars. Une autre forme LÈVE (`ConsommationIllisible`) : deviner une jauge serait pire que n'en avoir aucune.
 *
 * 🔴 LA JAUGE RETIENT LE PLUS GRAND DE DEUX CHIFFRES. Mesuré le même jour, le compteur de l'équipe disait 0 $ quand les
 * clés mensuelles en avaient dépensé 7,96. Une clé compte aussi pour l'équipe : si le compteur de l'équipe est juste, la
 * somme des clés ne le dépasse jamais, et s'il est en retard, elle en est le plancher. Les clés sans période (`none`,
 * celles des espaces : leur crédit est prépayé) cumulent depuis leur création et n'entrent pas dans un compte du mois.
 */

const LISTE_URL = 'https://api.vercel.com/ai-gateway/budgets/list';

const budgetSchema = z.object({
  scopeType: z.string(),
  limitAmount: z.number(),
  currentSpend: z.number(),
  refreshPeriod: z.string(),
  active: z.boolean(),
  archived: z.boolean(),
});
const listeSchema = z.object({ budgets: z.array(budgetSchema) });

export class ConsommationIllisible extends Error {
  constructor(readonly status: number | null, detail: string) {
    // Jamais le corps : ce message finit dans les journaux et sur Telegram.
    super(`consommation Vercel illisible (${status ?? 'reseau'}) : ${detail}`);
    this.name = 'ConsommationIllisible';
  }
}

export interface ConsommationEquipe {
  /** Le plafond du budget d'équipe actif, en dollars ; `null` = aucun budget d'équipe, rien ne borne la dépense. */
  limiteDollars: number | null;
  /** Ce que le compteur du budget d'équipe dit de la période (0 sans budget d'équipe). */
  depenseEquipeDollars: number;
  /** La somme des clés à période mensuelle, actives : le plancher de la dépense du mois. */
  depenseClesMensuellesDollars: number;
  /** Le plus grand des deux : ce que la jauge et les alertes retiennent. */
  depenseRetenueDollars: number;
  /** `depenseRetenueDollars / limiteDollars`, `null` sans budget d'équipe. */
  part: number | null;
}

export async function lireConsommationEquipe(
  http: HttpGet,
  o: { jeton: string; teamId: string; signal?: AbortSignal },
): Promise<ConsommationEquipe> {
  let res;
  try {
    res = await http.get(`${LISTE_URL}?teamId=${encodeURIComponent(o.teamId)}`, { authorization: `Bearer ${o.jeton}` }, o.signal ? { signal: o.signal } : undefined);
  } catch (err) {
    throw new ConsommationIllisible(null, err instanceof Error ? err.name : 'appel impossible');
  }
  if (res.status < 200 || res.status >= 300) throw new ConsommationIllisible(res.status, 'reponse en echec');
  const parse = listeSchema.safeParse(res.json);
  if (!parse.success) throw new ConsommationIllisible(res.status, 'reponse d une autre forme');
  const vivants = parse.data.budgets.filter((b) => b.active && !b.archived);
  const equipe = vivants.find((b) => b.scopeType === 'team') ?? null;
  const depenseEquipeDollars = equipe?.currentSpend ?? 0;
  const depenseClesMensuellesDollars = vivants
    .filter((b) => b.scopeType === 'api-key' && b.refreshPeriod === 'monthly')
    .reduce((s, b) => s + b.currentSpend, 0);
  const depenseRetenueDollars = Math.max(depenseEquipeDollars, depenseClesMensuellesDollars);
  const limiteDollars = equipe?.limitAmount ?? null;
  return {
    limiteDollars,
    depenseEquipeDollars,
    depenseClesMensuellesDollars,
    depenseRetenueDollars,
    part: limiteDollars === null || limiteDollars <= 0 ? null : depenseRetenueDollars / limiteDollars,
  };
}

/**
 * Les seuils, du plus haut au plus bas : un saut direct au plus haut n'envoie que lui. La carte de `/ops` change de
 * couleur aux mêmes (`web/lib/ops-mesures.ts`, tenus égaux par `tests/consommation-equipe.test.ts`).
 */
export const SEUILS_POURCENT = [95, 80] as const;

/**
 * La veille horaire (worker principal). Chaque alerte part une fois par mois civil UTC (le mois du budget de Vercel) ET
 * par plafond, et ce « une fois » est tenu par le compteur partagé (`compteurs_debit`, plafond 1 sur la fenêtre du
 * mois) : un redémarrage du worker ne la renvoie pas. Le plafond est dans la clé parce que relever le budget est
 * précisément le geste que l'alerte demande : sans lui, une alerte à 95 % des 100 $ consommerait le mois, et 95 % des
 * 150 $ relevés ne se dirait plus. Une lecture en échec lève : la tâche le signale.
 */
export function creerVeilleVercel(deps: {
  lire: () => Promise<ConsommationEquipe>;
  compteur: CompteurDebit;
  alerter: (cle: string, texte: string) => void;
  maintenant?: () => number;
}): () => Promise<void> {
  const maintenant = deps.maintenant ?? (() => Date.now());
  /** Vrai la première fois de ce mois pour cette clé, faux ensuite. */
  const premiereFoisDuMois = async (quoi: string): Promise<boolean> => {
    const t = new Date(maintenant());
    const origineMs = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1);
    const finMs = Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 1);
    const mois = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
    const verdict = await deps.compteur.compter([{ cle: `vercel.alerte|${mois}|${quoi}`, dureeMs: finMs - origineMs, max: 1, origineMs }]);
    return verdict.accepte;
  };

  return async function veilleVercel(): Promise<void> {
    const c = await deps.lire();
    if (c.limiteDollars === null || c.part === null) {
      if (await premiereFoisDuMois('sans-plafond')) {
        deps.alerter('vercel:sans-plafond', `aucun plafond d’équipe chez Vercel : rien ne borne la dépense de la passerelle d’IA (${Math.round(c.depenseRetenueDollars)} $ ce mois).`);
      }
      return;
    }
    const franchis = SEUILS_POURCENT.filter((s) => c.part! * 100 >= s);
    for (const [i, s] of franchis.entries()) {
      // Le plus haut franchi parle ; les plus bas se consomment en silence, pour ne pas revenir plus tard dans le mois.
      if ((await premiereFoisDuMois(`${c.limiteDollars}|${s}`)) && i === 0) {
        deps.alerter(`vercel:${s}`, `plafond Vercel à ${Math.round(c.part * 100)} % : ${Math.round(c.depenseRetenueDollars)} $ dépensés sur ${c.limiteDollars} $ ce mois. À 100 %, tous les bots se taisent : relever le budget d’équipe chez Vercel.`);
      }
    }
  };
}
