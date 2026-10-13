import { z } from 'zod';
import type { OutilComplet } from './catalog';
import { NomOutilDejaPris, OutilNonActivable } from './catalog';
import {
  BORNES_ACTION, cibleOutilAgentSchema, exigeUneCible, handlerMaison, lireCibleOutilAgent, outilMaison, paramsInitiaux,
  type CibleOutilAgent, type HandlerACible,
} from './outils-maison';
import { estModeTransfert, MODES_TRANSFERT, type ModeTransfert } from './disponibilite-equipe';
import type { BusinessHours, DayHours } from '../workflow/conditions';
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
/** Ce que le réglage d'une action lit et écrit en plus : la modifier et la retirer (`PgToolCatalog`). */
export type OutilsActions = OutilsSurs & Pick<OutilsAgentDep, 'patch' | 'detacher'>;

/**
 * La cible saisie pour un outil maison, lue contre le schéma du catalogue, `handler` imposé par l'outil et jamais par
 * la saisie (une cible de scénario ne se glisse pas sous un outil de tag). `null` = absente ou invalide. Le texte du
 * refus dit ce qu'il fallait, sans détailler Zod.
 */
export function lireCibleSaisie(handler: HandlerACible, saisie: unknown): CibleOutilAgent | null {
  if (!saisie || typeof saisie !== 'object' || Array.isArray(saisie)) return null;
  return lireCibleOutilAgent({ ...saisie, handler });
}

/** Ce qu'il faut pour chaque cible, dit au client quand elle manque ou ne tient pas. */
export const CIBLE_REQUISE: Readonly<Record<HandlerACible, string>> = {
  poser_tag: 'cible requise : le tag à poser',
  ecrire_variable: 'cible requise : le champ à renseigner, et au plus 50 valeurs permises',
  envoyer_bloc: 'cible requise : le scénario et le code du bloc à envoyer',
  lancer_scenario: 'cible requise : le scénario à lancer',
  declencher_action: `cible requise : le nom de l’action, sa consigne, et au plus ${BORNES_ACTION.champs} champs (code, libellé, type texte, nombre, date, email ou liste avec ses valeurs)`,
};

/**
 * Ajoute à l'agent un outil maison du catalogue, INACTIF. 🔴 Le modèle d'outil vient du catalogue, jamais de
 * l'appelant : titre, mots, paramètres et risque avec lui ; l'appelant ne choisit que le handler, au plus le nom, et
 * la CIBLE quand le handler en exige une (RC4 : un tag, un champ, un bloc, un scénario fixés par l'administrateur).
 * Une cible absente ou invalide est refusée (400) : un outil posé sans cible refuserait chaque appel. L'existence de
 * ce qu'elle vise dans l'espace (champ, bloc, scénario) est vérifiée par la route, qui en a les dépôts.
 */
export async function ajouterOutilMaison(
  outils: Pick<OutilsAgentDep, 'ajouter' | 'listToutes'>, tenantId: string, agentId: string, handler: string, nom?: string, saisieCible?: unknown,
): Promise<Issue<OutilComplet>> {
  const modele = outilMaison(handler);
  if (!modele) return refus(400, 'outil inconnu');
  let cible: CibleOutilAgent | null = null;
  if (exigeUneCible(modele.handler)) {
    cible = lireCibleSaisie(modele.handler, saisieCible);
    if (!cible) return refus(400, CIBLE_REQUISE[modele.handler]);
  }
  // Au plus 10 actions par agent (décision de Julien du 2026-10-13). Lu avant l'écriture : deux poses simultanées
  // peuvent en faire onze, ce qui ne casse rien (le plafond borne la liste que le modèle lit, pas un coût).
  if (modele.handler === 'declencher_action') {
    const poses = await outils.listToutes(tenantId, agentId);
    if (poses.filter((o) => handlerMaison(o) === 'declencher_action').length >= BORNES_ACTION.parAgent) {
      return refus(409, `au plus ${BORNES_ACTION.parAgent} actions par agent : supprimer une action avant d’en ajouter une`);
    }
  }
  try {
    const outil = await outils.ajouter(tenantId, agentId, {
      handler: modele.handler,
      cible,
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
 * (irréversible : il envoie un message hors de la conversation), ni `lancer_scenario` (irréversible, et terminal), ni
 * les outils qui écrivent sur la fiche d'un contact (`poser_tag`, `ecrire_variable`), ni l'autonomie, ni un
 * connecteur : ceux-là restent un geste d'écran. Aucun n'exige de cible, ce que `ajouterOutilMaison` refuserait.
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

/** Fuseau IANA valide ? (Intl throw sur un identifiant inconnu.) */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.trim() === '') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Normalise/valide les heures d'ouverture d'un corps hostile : 7 jours '0'..'6', HH:MM valides, close > open si
 *  ouvert. null si invalide (une plage cassée est rejetée, pas silencieusement corrigée). */
export function normalizeBusinessHours(raw: unknown): BusinessHours | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: BusinessHours = {};
  for (let d = 0; d <= 6; d += 1) {
    const day = r[String(d)];
    if (!day || typeof day !== 'object') return null;
    const dd = day as Record<string, unknown>;
    const closed = dd.closed === true;
    if (closed) { out[String(d)] = { closed: true, open: '', close: '' }; continue; }
    const open = String(dd.open ?? '');
    const close = String(dd.close ?? '');
    if (!HHMM.test(open) || !HHMM.test(close)) return null;
    if (close <= open) return null; // plage vide/inversée -> refus
    out[String(d)] = { closed: false, open, close } satisfies DayHours;
  }
  return out;
}

/**
 * Les heures d'ouverture de l'espace, et son fuseau s'il est donné : la route de la console (`PATCH .../settings/
 * business-hours`) et l'outil MCP `set_business_hours` passent par les mêmes validateurs. Ce sont les heures que les
 * agents IA annoncent en `business_hours` (`disponibiliteEquipe`), et celles du bloc Condition des scénarios. Rien
 * n'est écrit si l'une des deux valeurs est fausse.
 */
export async function reglerHeuresOuverture(
  reglages: { setBusinessHours(tenantId: string, hours: BusinessHours): Promise<void>; setTimezone(tenantId: string, tz: string): Promise<void> },
  tenantId: string, heures: unknown, fuseau: unknown,
): Promise<Issue<{ hours: BusinessHours; timezone?: string }>> {
  const hours = normalizeBusinessHours(heures);
  if (hours === null) return refus(400, 'hours invalide (7 jours de « 0 » à « 6 », HH:MM, close après open)');
  // Absent ou nul : le fuseau de l'espace reste (un modèle envoie volontiers `null` pour « rien »).
  const avecFuseau = fuseau !== undefined && fuseau !== null;
  if (avecFuseau && !isValidTimeZone(fuseau)) return refus(400, 'timezone IANA invalide (ex. Europe/Paris)');
  await reglages.setBusinessHours(tenantId, hours);
  if (avecFuseau) await reglages.setTimezone(tenantId, fuseau);
  return { ok: true, valeur: { hours, ...(avecFuseau ? { timezone: fuseau } : {}) } };
}

/** Le nom technique d'un outil (`agent_tools.name`, `^[a-z0-9_]{1,64}$`), l'alphabet que le modèle appelle. */
const MAX_NOM_OUTIL = 64;

/**
 * Le nom technique d'une action neuve, tiré de son nom (« Résiliation » donne `action_resiliation`) et libre parmi les
 * outils de l'agent : deux actions d'un même agent ne peuvent pas porter le même nom (0211).
 */
export function nomTechniqueDAction(nom: string, pris: readonly string[]): string {
  const slug = nom.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const racine = `action_${slug === '' ? 'client' : slug}`.slice(0, MAX_NOM_OUTIL);
  if (!pris.includes(racine)) return racine;
  for (let i = 2; ; i += 1) {
    const suffixe = `_${i}`;
    const candidat = `${racine.slice(0, MAX_NOM_OUTIL - suffixe.length)}${suffixe}`;
    if (!pris.includes(candidat)) return candidat;
  }
}

/** Ce qu'un agent tiers donne pour une action : la cible, et l'action existante à modifier s'il y en a une. */
export interface SaisieAction {
  actionId?: string;
  nom: unknown;
  consigne?: unknown;
  champs?: unknown;
}

/**
 * 🔴 CRÉER OU MODIFIER UNE ACTION D'UN AGENT IA depuis Claude Code (`set_agent_action`, plan du 2026-10-13, livraison
 * C), par les MÊMES gardes que la console : la cible lue par `lireCibleSaisie` (le schéma du serveur, `.strict()`), la
 * pose par `ajouterOutilMaison` (le plafond de 10 actions par agent), la modification sous le handler de l'outil.
 *
 * Une action neuve est ACTIVÉE au nom de `personne` (le consentement que la base exige), comme `ajouterOutilsSurs` :
 * dans le parcours de Claude Code, un espace Free n'a pas de console pour le faire. Une action modifiée garde son état.
 * Écart assumé à « un outil à cible reste un geste d'écran » (`OUTILS_SURS`) : décision de Julien du 2026-10-13.
 */
export async function reglerAction(
  outils: OutilsActions, tenantId: string, agentId: string, saisie: SaisieAction, personne: string,
): Promise<Issue<OutilComplet>> {
  if (!estUuid(agentId)) return refus(404, 'agent introuvable');
  const poses = await outils.listToutes(tenantId, agentId);
  const existante = saisie.actionId === undefined
    ? undefined
    : poses.find((o) => o.id === saisie.actionId && handlerMaison(o) === 'declencher_action');
  if (saisie.actionId !== undefined && !existante) {
    return refus(404, 'action introuvable sur cet agent (list_agents, puis get_agent pour ses actions)');
  }
  // 🔴 EN MODIFICATION, CE QUI N'EST PAS DONNÉ RESTE (relecture de la livraison C) : une consigne ou des champs absents
  // ne s'effacent pas. Sinon, changer un mot de la consigne viderait les champs, et l'application recevrait des `fields`
  // vides, sans erreur nulle part. Des `champs` DONNÉS remplacent la liste entière.
  const lue = existante ? lireCibleOutilAgent(existante.binding) : null;
  const ancienne = lue?.handler === 'declencher_action' ? lue : null;
  const lu = cibleOutilAgentSchema.safeParse({
    handler: 'declencher_action',
    nom: saisie.nom,
    consigne: saisie.consigne ?? ancienne?.consigne ?? '',
    champs: saisie.champs ?? ancienne?.champs ?? [],
  });
  if (!lu.success || lu.data.handler !== 'declencher_action') {
    // Le détail de Zod, comme la route de la console : Claude n'a pas l'écran qui le dit avant.
    const detail = lu.success ? '' : lu.error.issues.map((i) => `${i.path.join('.') || '(racine)'} : ${i.message}`).join(' ; ');
    return refus(400, detail === '' ? CIBLE_REQUISE.declencher_action : `${CIBLE_REQUISE.declencher_action} (${detail})`);
  }
  const cible = lu.data;

  if (existante) {
    const modifiee = await outils.patch(tenantId, agentId, existante.id, { cible, title: cible.nom });
    return modifiee ? { ok: true, valeur: modifiee } : refus(404, 'action introuvable');
  }

  if (personne === '') return refus(403, 'activation impossible sans utilisateur identifié');
  const nom = nomTechniqueDAction(cible.nom, poses.map((o) => o.name));
  const ajoutee = await ajouterOutilMaison(outils, tenantId, agentId, 'declencher_action', nom, cible);
  if (!ajoutee.ok) return ajoutee;
  // Le titre de la console est le nom de l'action : la liste des outils la montre ainsi, comme une action posée à l'écran.
  await outils.patch(tenantId, agentId, ajoutee.valeur.id, { title: cible.nom });
  let active: OutilComplet | null;
  try {
    active = await outils.activer(tenantId, agentId, ajoutee.valeur.id, true, personne);
  } catch (err) {
    if (err instanceof OutilNonActivable) return refus(409, err.raison);
    throw err;
  }
  return active ? { ok: true, valeur: active } : refus(404, 'action introuvable');
}

/** Supprime une action d'un agent (`delete_agent_action`). Seule une action se supprime par là, jamais un autre outil. */
export async function supprimerAction(
  outils: Pick<OutilsActions, 'listToutes' | 'detacher'>, tenantId: string, agentId: string, actionId: string,
): Promise<Issue<{ supprimee: true }>> {
  if (!estUuid(agentId) || !estUuid(actionId)) return refus(404, 'action introuvable');
  const poses = await outils.listToutes(tenantId, agentId);
  if (!poses.some((o) => o.id === actionId && handlerMaison(o) === 'declencher_action')) {
    return refus(404, 'action introuvable sur cet agent');
  }
  return (await outils.detacher(tenantId, agentId, actionId)) ? { ok: true, valeur: { supprimee: true } } : refus(404, 'action introuvable');
}
