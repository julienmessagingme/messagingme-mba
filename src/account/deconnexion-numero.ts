import { texteDe } from '../lib/erreur';
import type { IssueSortieNumero } from '../numero/liberation.pg';

/**
 * « DÉCONNECTER LE NUMÉRO » : le numéro WhatsApp quitte l'espace pour de bon (plan
 * `docs/superpowers/plans/2026-10-10-deconnecter-le-numero.md`, décisions de Julien du 2026-10-10). « Délier » coupe les
 * envois et garde le numéro ; ce geste-ci l'oublie, avec son compte WhatsApp et son jeton, et l'espace peut ensuite en
 * connecter un autre.
 *
 * Ce module ne parle à aucune base ni à aucun tiers : il décide QUELLES étapes jouer, dans QUEL ordre, et ce qu'un échec
 * arrête. Le câblage (`src/index.ts`) lui donne les gestes ; la lecture et l'écriture vivent dans
 * `deconnexion-numero.pg.ts`. L'ordre, et ce qui l'arrête :
 *  1. 🔴 la purge des conversations, par lots. ÉCHEC = ARRÊT, rien n'est encore détaché : le geste se rejoue ;
 *  2. au mieux (chaque échec noté, aucun n'arrête la suite) : l'agent de Meta éteint, sa liste vidée, notre app
 *     désabonnée du compte WhatsApp, le numéro fourni sorti et la fin de son abonnement programmée ;
 *  3. le détachement, en une transaction (`PgDeconnexionNumeroStore.detacher`).
 *
 * 🔴 LES GESTES CHEZ META PASSENT AVANT LE DÉTACHEMENT : ils lisent le jeton dans `waba_credentials`, que la transaction
 * emporte. Et le numéro fourni est jugé « vu de Meta » AVANT que sa ligne `phone_numbers` parte : jugé après, un numéro
 * connecté serait rendu à la réserve, puis attribué à un autre client alors que Meta le tient encore.
 *
 * 🔴 UN OBJET META PARTAGÉ NE SE TOUCHE PAS, et le jeton global non plus : la règle de la suppression d'un espace
 * (`objetsMetaDeLEspace`, `src/ops/suppression-espace.pg.ts`), pour la même raison. Désabonner notre propre compte de
 * notre app couperait les webhooks d'autres espaces.
 */

export const ETAPES_DECONNEXION = [
  'conversations', 'mba_eteint', 'mba_liste', 'waba_desabonne', 'numero_fourni', 'fin_abonnement', 'detachement',
] as const;
export type NomEtapeDeconnexion = (typeof ETAPES_DECONNEXION)[number];

export interface EtapeDeconnexion {
  etape: NomEtapeDeconnexion;
  etat: 'fait' | 'sautee' | 'echec';
  detail: string | null;
}

/** Ce que la confirmation montre AVANT le geste, et ce que le déroulé lit pour décider. Lu sans rien écrire. */
export interface BilanDeconnexion {
  /** Le numéro que les gestes chez Meta visent (le premier créé). */
  phoneNumberId: string;
  /** Le numéro tel que Meta l'affiche, que la confirmation fait retaper ; `null` s'il n'est pas connu. */
  affiche: string | null;
  /** Le compte WhatsApp de l'espace (le premier créé), `null` sans compte relié par l'inscription. */
  wabaId: string | null;
  /** Un AUTRE espace nomme ce compte ou ce numéro : rien ne se fait chez Meta. */
  partage: boolean;
  /** Le jeton que les appels chez Meta prendraient : le sien, le nôtre (repli), ou le sien mais refusé par Meta. */
  jeton: 'propre' | 'global' | 'invalide';
  /** Le numéro connecté EST le numéro fourni de l'espace : il est perdu, et son abonnement prend fin. */
  numeroFourni: { numero: string; vuDeMeta: boolean } | null;
  /** Les conversations que la purge efface (fils entiers, RCS compris). */
  conversations: number;
  /** Les campagnes WhatsApp (canal principal) pas finies : elles passent en échec. Une campagne RCS continue. */
  campagnesArretees: number;
  /** L'agent de Meta est allumé sur ce numéro. */
  mbaAllume: boolean;
  /** Les contacts confiés à l'agent de Meta (sa liste). */
  contactsSurLaListe: number;
}

/** Ce que la transaction du détachement a fait. */
export interface ResultatDetachement {
  /** Les conversations arrivées pendant le geste, effacées dans la transaction. */
  conversations: number;
  campagnesArretees: number;
}

export interface GestesDeconnexion {
  /** Efface les conversations de l'espace par lots ; rend le nombre effacé. */
  purgerConversations(tenantId: string): Promise<number>;
  eteindreMba(tenantId: string, phoneNumberId: string): Promise<void>;
  viderListeMba(tenantId: string): Promise<{ retires: number; refuses: number }>;
  desabonnerWaba(tenantId: string, wabaId: string): Promise<void>;
  /** La sortie du numéro fourni de la suppression d'un espace (`PgLiberationStore.sortirDeLEspaceSupprime`). */
  sortirNumeroFourni(tenantId: string): Promise<IssueSortieNumero>;
  /** La fin de l'abonnement du numéro à la fin de la période payée (`programmerLaFinDuNumero`). */
  programmerFinDuNumero(tenantId: string): Promise<'programmee' | 'aucun' | 'echec'>;
  /** La transaction ; `null` = l'espace n'a plus de numéro (un autre geste l'a détaché entre-temps). */
  detacher(tenantId: string): Promise<ResultatDetachement | null>;
}

export type IssueDeconnexion =
  | { fait: true; etapes: EtapeDeconnexion[]; conversations: number; campagnesArretees: number }
  | { fait: false; etapes: EtapeDeconnexion[]; raison: 'purge' | 'detachement' | 'deja_detache' };

/** Les trois étapes chez Meta sautées pour la même raison, ou `null` si elles peuvent se jouer. */
export function gardeMetaDeconnexion(b: Pick<BilanDeconnexion, 'partage' | 'jeton'>): string | null {
  if (b.partage) return 'sautée : compte WhatsApp ou numéro partagé avec un autre espace';
  if (b.jeton === 'global') return 'sautée : jeton global (l’espace n’a pas de jeton propre)';
  if (b.jeton === 'invalide') return 'sautée : jeton de l’espace refusé par Meta';
  return null;
}

type Issue = Omit<EtapeDeconnexion, 'etape'>;
const fait = (detail: string | null = null): Issue => ({ etat: 'fait', detail });
const sautee = (detail: string): Issue => ({ etat: 'sautee', detail });

export async function deconnecterNumero(tenantId: string, b: BilanDeconnexion, g: GestesDeconnexion): Promise<IssueDeconnexion> {
  const etapes: EtapeDeconnexion[] = [];
  const auMieux = async (etape: NomEtapeDeconnexion, jouer: () => Promise<Issue>): Promise<void> => {
    try {
      etapes.push({ etape, ...(await jouer()) });
    } catch (err) {
      etapes.push({ etape, etat: 'echec', detail: texteDe(err) });
    }
  };

  // 1. 🔴 La purge : échec = arrêt, rien n'est encore détaché.
  let effacees: number;
  try {
    effacees = await g.purgerConversations(tenantId);
    etapes.push({ etape: 'conversations', ...fait(`${effacees} effacée(s)`) });
  } catch (err) {
    etapes.push({ etape: 'conversations', etat: 'echec', detail: texteDe(err) });
    return { fait: false, etapes, raison: 'purge' };
  }

  // 2. Au mieux : chaque échec est noté, aucun n'arrête la suite.
  const meta = gardeMetaDeconnexion(b);
  await auMieux('mba_eteint', async () => {
    if (!b.mbaAllume) return sautee('agent de Meta déjà éteint');
    if (meta !== null) return sautee(meta);
    await g.eteindreMba(tenantId, b.phoneNumberId);
    return fait();
  });
  await auMieux('mba_liste', async () => {
    if (b.contactsSurLaListe === 0) return sautee('liste vide');
    if (meta !== null) return sautee(meta);
    const r = await g.viderListeMba(tenantId);
    return r.refuses > 0
      ? { etat: 'echec', detail: `${r.retires} retiré(s), ${r.refuses} refusé(s) par Meta` }
      : fait(`${r.retires} retiré(s)`);
  });
  await auMieux('waba_desabonne', async () => {
    if (b.wabaId === null) return sautee('aucun compte WhatsApp relié par l’inscription');
    if (meta !== null) return sautee(meta);
    await g.desabonnerWaba(tenantId, b.wabaId);
    return fait();
  });
  await auMieux('numero_fourni', async () => {
    if (b.numeroFourni === null) return sautee('le numéro n’est pas un numéro fourni');
    const s = await g.sortirNumeroFourni(tenantId);
    switch (s.fait) {
      case 'aucun': return sautee('aucun numéro fourni attribué');
      case 'libre': return fait(`${s.numero} rendu à la réserve`);
      case 'resilie': return fait(`${s.numero} résilié`);
      case 'bloque': return { etat: 'echec', detail: `${s.numero} sorti de la réserve sans être résilié (${s.cause})` };
    }
  });
  await auMieux('fin_abonnement', async () => {
    if (b.numeroFourni === null) return sautee('le numéro n’est pas un numéro fourni');
    switch (await g.programmerFinDuNumero(tenantId)) {
      case 'programmee': return fait('fin à la fin de la période payée');
      case 'aucun': return sautee('aucun abonnement du numéro en cours');
      case 'echec': return { etat: 'echec', detail: 'fin non programmée chez Stripe : résiliation à la main' };
    }
  });

  // 3. Le détachement, en une transaction.
  let r: ResultatDetachement | null;
  try {
    r = await g.detacher(tenantId);
  } catch (err) {
    etapes.push({ etape: 'detachement', etat: 'echec', detail: texteDe(err) });
    return { fait: false, etapes, raison: 'detachement' };
  }
  if (r === null) {
    etapes.push({ etape: 'detachement', ...sautee('l’espace n’a plus de numéro') });
    return { fait: false, etapes, raison: 'deja_detache' };
  }
  etapes.push({ etape: 'detachement', ...fait() });
  return { fait: true, etapes, conversations: effacees + r.conversations, campagnesArretees: r.campagnesArretees };
}
