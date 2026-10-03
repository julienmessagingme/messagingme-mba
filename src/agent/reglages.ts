import { z } from 'zod';
import type { OutilComplet } from './catalog';
import { NomOutilDejaPris, OutilNonActivable } from './catalog';
import { handlerMaison, outilMaison, paramsInitiaux } from './outils-maison';
import { estModeTransfert, MODES_TRANSFERT, type ModeTransfert } from './disponibilite-equipe';
import { refus, type Issue } from '../lib/issue';
import { estUuid } from '../http/scope';
import type { OutilsAgentDep } from '../http/agent-tools';

/**
 * LES RÉGLAGES D'UN AGENT IA QU'UN AGENT TIERS PEUT POSER : ses outils sûrs, et ce qu'il peut promettre de la
 * disponibilité de l'équipe (lot 8a, `docs/superpowers/plans/2026-10-03-mcp-agent-ia.md`).
 *
 * 🔴 UNE SEULE VÉRITÉ, DEUX PORTES. L'ajout d'un outil maison sert la route de la console (`POST .../tools`) et
 * l'outil MCP `set_agent_tools` ; le mode de transfert sert `PATCH /settings/transfert-agent` et `set_transfer_mode`.
 */

/** Ce que l'ajout d'outils sûrs lit et écrit du catalogue de l'agent (`PgToolCatalog`). */
export type OutilsSurs = Pick<OutilsAgentDep, 'listToutes' | 'ajouter' | 'activer'>;

/**
 * Ajoute à l'agent un outil maison du catalogue, INACTIF. 🔴 Le modèle d'outil vient du catalogue, jamais de
 * l'appelant : titre, mots, paramètres et risque avec lui ; l'appelant ne choisit que le handler et, au plus, le nom.
 */
export async function ajouterOutilMaison(
  outils: Pick<OutilsAgentDep, 'ajouter'>, tenantId: string, agentId: string, handler: string, nom?: string,
): Promise<Issue<OutilComplet>> {
  const modele = outilMaison(handler);
  if (!modele) return refus(400, 'outil inconnu');
  try {
    const outil = await outils.ajouter(tenantId, agentId, {
      handler: modele.handler,
      name: nom ?? modele.nomDefaut,
      title: modele.titre.fr,
      description: modele.description.fr,
      nePasUtiliser: modele.nePasUtiliser.fr,
      params: paramsInitiaux(modele),
      risk: modele.risk,
    });
    return outil ? { ok: true, valeur: outil } : refus(404, 'agent introuvable');
  } catch (err) {
    if (err instanceof NomOutilDejaPris) return refus(409, err.message);
    throw err;
  }
}

/**
 * Les quatre outils qu'un agent tiers peut donner à un agent IA (spec du lot 8a, section 1). 🔴 Ni `envoyer_bloc`
 * (irréversible : il envoie un message hors de la conversation), ni les outils qui écrivent sur la fiche d'un
 * contact (`poser_tag`, `ecrire_variable`), ni l'autonomie, ni un connecteur : ceux-là restent un geste d'écran.
 */
export const OUTILS_SURS = ['terminer', 'chercher_connaissance', 'lire_contact', 'escalader'] as const;

/** Exportée : l'outil MCP annonce la liste fermée et la borne d'ici. */
export const saisieDOutilsSurs = z.array(z.enum(OUTILS_SURS)).min(1).max(OUTILS_SURS.length);

/**
 * Ajoute ce qui manque parmi les outils demandés, et active ce qui ne l'est pas. Idempotent : un outil déjà posé
 * n'est pas recréé (sinon 409 sur son nom), un outil déjà actif n'est pas réactivé. Rien n'est retiré.
 * 🔴 L'activation porte le nom de `personne`, l'utilisateur de la session ou du jeton : c'est le consentement humain
 * que la base exige (`active_par`), jamais une valeur de l'appelant. Vide, l'activation est refusée, comme à l'écran.
 */
export async function ajouterOutilsSurs(
  outils: OutilsSurs, tenantId: string, agentId: string, codes: unknown, personne: string,
): Promise<Issue<OutilComplet[]>> {
  if (!estUuid(agentId)) return refus(404, 'agent introuvable');
  const lu = saisieDOutilsSurs.safeParse(codes);
  if (!lu.success) return refus(400, `outils acceptés : ${OUTILS_SURS.join(', ')}`);
  if (personne === '') return refus(403, 'activation impossible sans utilisateur identifié');
  const poses = await outils.listToutes(tenantId, agentId);
  const actifs: OutilComplet[] = [];
  for (const code of new Set(lu.data)) {
    let outil = poses.find((o) => handlerMaison(o) === code);
    if (!outil) {
      const ajoute = await ajouterOutilMaison(outils, tenantId, agentId, code);
      if (!ajoute.ok) return ajoute;
      outil = ajoute.valeur;
    }
    if (!outil.actif) {
      let active: OutilComplet | null;
      try {
        active = await outils.activer(tenantId, agentId, outil.id, true, personne);
      } catch (err) {
        if (err instanceof OutilNonActivable) return refus(409, err.raison);
        throw err;
      }
      if (!active) return refus(404, 'outil introuvable');
      outil = active;
    }
    actifs.push(outil);
  }
  return { ok: true, valeur: actifs };
}

/**
 * Quand l'équipe est joignable, pour les agents IA de l'espace. Ce réglage ne décide pas si l'on transfère (la
 * conversation arrive dans « À traiter » dans tous les cas), mais ce que l'agent a le droit de promettre.
 */
export async function reglerModeTransfert(
  reglages: { setAgentTransfertMode(tenantId: string, mode: ModeTransfert): Promise<void> }, tenantId: string, mode: unknown,
): Promise<Issue<ModeTransfert>> {
  if (!estModeTransfert(mode)) return refus(400, `mode requis (${MODES_TRANSFERT.join(' | ')})`);
  await reglages.setAgentTransfertMode(tenantId, mode);
  return { ok: true, valeur: mode };
}
