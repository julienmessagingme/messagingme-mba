/**
 * LE PANNEAU DÉTAIL DE L'INBOX (cadrage du 2026-09-28) : la forme de ce que rend
 * `GET /tenants/:tenantId/conversations/:id/detail`, sa validation, et les phrases de sa frise.
 *
 * La liste des types et la forme du détail sont partagées avec le serveur (`./partage/evenements-conversation`).
 * Fonctions pures, testées dans `inbox-detail.test.ts`.
 */
import {
  TYPES_EVENEMENT, CAUSE_AMORCAGE,
  type TypeEvenement, type QuiEvenement, type EvenementConversation, type DetailConversation,
} from './partage/evenements-conversation';

export { TYPES_EVENEMENT, CAUSE_AMORCAGE, type TypeEvenement, type QuiEvenement, type EvenementConversation, type DetailConversation };

const estObjet = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const texteOuNul = (v: unknown): v is string | null => v === null || typeof v === 'string';
const estType = (v: unknown): v is TypeEvenement => typeof v === 'string' && (TYPES_EVENEMENT as readonly string[]).includes(v);

function lireQui(v: unknown): QuiEvenement | undefined {
  if (v === null) return null;
  if (!estObjet(v)) return undefined;
  if (v.ancien === true) return { ancien: true };
  return typeof v.nom === 'string' ? { nom: v.nom } : undefined;
}

function lireEvenement(v: unknown): EvenementConversation | null {
  if (!estObjet(v)) return null;
  const acteur = lireQui(v.acteur);
  const cible = lireQui(v.cible);
  if (typeof v.id !== 'string' || typeof v.at !== 'string' || !estType(v.type)
    || acteur === undefined || cible === undefined || !texteOuNul(v.cause)) return null;
  return {
    id: v.id, type: v.type, at: v.at, acteur, cible, cause: v.cause,
    reassignation: v.reassignation === true,
    // Absent d'une API plus ancienne : faux, et la ligne dit « Assignée à Marie », comme avant.
    prise: v.prise === true,
  };
}

/**
 * La réponse du serveur, vérifiée et non castée : elle vient du réseau, et l'écran fait `.map` dessus pendant le
 * rendu. `null` quand elle n'a pas la forme attendue, ce que le panneau traite comme une route absente (il se
 * replie sans erreur). Un événement mal formé est écarté seul : la frise garde les autres.
 */
export function lireDetail(brut: unknown): DetailConversation | null {
  if (!estObjet(brut) || typeof brut.conversationId !== 'string' || !estObjet(brut.identite)) return null;
  const i = brut.identite;
  if (typeof i.waId !== 'string' || !texteOuNul(i.contactId) || !texteOuNul(i.nom) || !texteOuNul(i.prenom)
    || !texteOuNul(i.telephone) || !texteOuNul(i.email)) return null;
  if (!texteOuNul(brut.resume) || !Array.isArray(brut.historique)) return null;
  const a = brut.assignation;
  const assignation = estObjet(a) && typeof a.userId === 'string' && typeof a.nom === 'string'
    ? { userId: a.userId, nom: a.nom }
    : null;
  if (a !== null && assignation === null) return null;
  return {
    conversationId: brut.conversationId,
    identite: {
      contactId: i.contactId, waId: i.waId, nom: i.nom, prenom: i.prenom, telephone: i.telephone, email: i.email,
      tags: Array.isArray(i.tags) ? i.tags.filter((x): x is string => typeof x === 'string') : [],
      desabonne: i.desabonne === true,
      bloque: i.bloque === true,
    },
    resume: brut.resume,
    assignation,
    historique: brut.historique.map(lireEvenement).filter((e): e is EvenementConversation => e !== null),
  };
}

type T = (fr: string, en?: string) => string;

/** Le nom d'un collaborateur de la frise ; `null` = personne (la cause parle alors). */
export function nomDe(q: QuiEvenement, t: T): string | null {
  if (q === null) return null;
  if ('ancien' in q) return t('ancien collaborateur', 'former teammate');
  return q.nom;
}

/** La phrase d'un événement, sans son auteur ni sa date (l'écran les pose à côté). */
export function libelleEvenement(e: EvenementConversation, t: T): string {
  const cible = nomDe(e.cible, t) ?? t('un collaborateur', 'a teammate');
  switch (e.type) {
    case 'assignee':
      // Une prise (le collaborateur se l'assigne lui-même) : « Prise en charge », et la ligne d'origine dit par qui.
      // « Assignée à Marie · par Marie » disait le fait sans dire le geste.
      if (e.prise) return t('Prise en charge', 'Taken on');
      return e.reassignation ? t(`Réassignée à ${cible}`, `Reassigned to ${cible}`) : t(`Assignée à ${cible}`, `Assigned to ${cible}`);
    case 'desassignee':
      return t(`Désassignée (était à ${cible})`, `Unassigned (was ${cible})`);
    case 'prise_mba':
      return e.cause === CAUSE_AMORCAGE
        ? t('Tenue par l’équipe', 'Held by the team')
        : t('Prise à l’agent de Meta', 'Taken from Meta’s agent');
    case 'rendue_mba':
      return t('Rendue à l’agent de Meta', 'Handed back to Meta’s agent');
    case 'passee_par_mba':
      return t('L’agent de Meta passe la main à l’équipe', 'Meta’s agent hands over to the team');
    case 'traitee':
      return t('Marquée traitée', 'Marked as done');
    case 'non_traitee':
      return t('Plus marquée traitée', 'No longer marked as done');
    case 'archivee':
      return t('Archivée', 'Archived');
    case 'desarchivee':
      return t('Désarchivée', 'Unarchived');
    case 'signalee':
      return t('Signalée', 'Flagged');
    case 'designalee':
      return t('Plus signalée', 'No longer flagged');
    case 'rouverte':
      return t('Rouverte', 'Reopened');
    // La cause dit QUI passe la main ou reprend (« automatique : scénario Bienvenue »), ou que le contact a rouvert une
    // conversation que l'équipe tenait déjà : la phrase reste vraie dans les deux cas, une demande s'ouvre pour elle.
    case 'escaladee':
      return t('Demande pour l’équipe', 'Request for the team');
    case 'rendue_scenario':
      return t('Rendue au scénario', 'Handed back to the scenario');
    // La cause nomme la règle d'arrêt (« automatique : règle d'arrêt rdv_pris ») : la phrase dit seulement le geste.
    case 'sortie_agent':
      return t('L’agent IA a terminé', 'The AI agent finished');
    // L'origine dit qui (« par Marie », ou la cause « automatique : agent IA Sophie ») ; une urgence levée par « Traité »
    // ou l'archivage porte le même auteur que le geste, dont la ligne est juste au-dessus.
    case 'urgente':
      return t('Marquée urgente', 'Marked as urgent');
    case 'urgence_levee':
      return t('Urgence levée', 'No longer urgent');
    // RC6 : le bloc « Envoyer au MBA » a trouvé l'agent de Meta éteint ; la cause nomme le scénario, la bascule vers
    // l'équipe suit sur sa propre ligne.
    case 'mba_indisponible':
      return t('Agent de Meta éteint : la conversation va à l’équipe', 'Meta’s agent is off: the conversation goes to the team');
  }
}

/** Qui ou quoi : « par Marie », la cause d'un changement automatique, ou les deux sur une ligne amorcée. */
export function origineEvenement(e: EvenementConversation, t: T): string | null {
  const nom = nomDe(e.acteur, t);
  const par = nom !== null ? t(`par ${nom}`, `by ${nom}`) : null;
  if (par && e.cause) return `${par} · ${e.cause}`;
  return par ?? e.cause;
}

/**
 * Le repli du panneau, retenu PAR NAVIGATEUR (cadrage : « le choix est retenu »), comme le choix de langue.
 * ⚠️ Toujours dans un try/catch : un navigateur en navigation privée, ou un stockage plein, lève à la lecture
 * comme à l'écriture, et le panneau doit rester utilisable (déplié) sans lui.
 */
export const CLE_REPLI_DETAIL = 'mba_inbox_detail_replie';

export function lireRepliDetail(): boolean {
  try {
    return window.localStorage.getItem(CLE_REPLI_DETAIL) === '1';
  } catch {
    return false;
  }
}

export function ecrireRepliDetail(replie: boolean): void {
  try {
    window.localStorage.setItem(CLE_REPLI_DETAIL, replie ? '1' : '0');
  } catch {
    /* le repli reste valable pour cette page, il ne sera simplement pas retenu */
  }
}
