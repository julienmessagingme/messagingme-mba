import { texteDe } from '../lib/erreur';
import type { IssueSortieNumero } from '../numero/liberation.pg';

/**
 * SUPPRIMER UN ESPACE, DÉFINITIVEMENT, DEPUIS /ops (RC8, plan `docs/superpowers/plans/2026-10-06-rc8-supprimer-un-espace.md`).
 *
 * Ce module ne parle à aucune base ni à aucun tiers : il décide QUELLES étapes jouer, dans QUEL ordre, et ce qu'un échec
 * arrête. Le câblage (`src/index.ts`) lui donne les gestes ; la lecture et la purge vivent dans `suppression-espace.pg.ts`.
 *
 * L'ordre, et ce qui l'arrête :
 *  0. le verrou de l'espace (`tenants.status = 'locked'`) : la console, `/v1` et `/mcp` se ferment, et aucune clé Vercel
 *     ne peut plus s'ouvrir (`assurerCleGateway` refuse un espace verrouillé). Échec : arrêt, rien n'est touché ;
 *  1. 🔴 la clé Vercel, révoquée chez Vercel puis chez nous. ÉCHEC = ARRÊT, RIEN N'EST PURGÉ : la cascade emporterait
 *     notre ligne, et une clé dont l'identifiant est perdu facture à vie ;
 *  2. au mieux, chacun noté et aucun n'arrête la suite : l'agent de Meta éteint, sa liste vidée, le compte WhatsApp
 *     désabonné de notre app, Salesforce et HubSpot déliés, le numéro fourni sorti ;
 *  3. la purge, en UNE transaction, qui écrit la ligne de trace (`espaces_supprimes`) avec elle.
 *
 * 🔴 UN OBJET META PARTAGÉ NE SE TOUCHE PAS. Les trois étapes chez Meta sont SAUTÉES si le compte WhatsApp ou le numéro
 * de l'espace sont nommés par un autre espace (`partage`), ou si les appels partiraient avec le jeton GLOBAL, celui de
 * notre propre compte (un espace sans jeton propre) : désabonner notre propre compte de notre app couperait les
 * webhooks d'autres espaces. Le bilan le dit à l'avance (`prevoirEtapes`).
 */

/** Les étapes, dans l'ordre où elles se jouent. */
export const ETAPES = [
  'verrou', 'cle_vercel', 'mba_eteint', 'mba_liste', 'waba_desabonne', 'salesforce', 'hubspot', 'numero_fourni', 'purge',
] as const;
export type NomEtape = (typeof ETAPES)[number];

/** Ce qu'une étape va faire, dit AVANT (le bilan) : la jouer, la sauter (et pourquoi), ou constater qu'elle ne peut pas. */
export interface EtapePrevue {
  etape: NomEtape;
  etat: 'a_faire' | 'sautee' | 'impossible';
  detail: string | null;
}

/** Ce qu'une étape a fait, dit APRÈS (la réponse et la ligne de trace). */
export interface EtapeJouee {
  etape: NomEtape;
  etat: 'fait' | 'sautee' | 'echec';
  detail: string | null;
}

export interface ClientStripe {
  customerId: string;
  livemode: boolean;
  /** Le tableau de bord de Stripe (`lienTableauStripe`). */
  lien: string;
}

export interface AbonnementStripe {
  id: string;
  /** L'abonnement du numéro fourni (lot 3c) ou celui de l'offre Pro (lot 6). */
  produit: 'numero' | 'offre';
  statut: string;
  livemode: boolean;
  /** Stripe le facture encore : c'est lui qu'il faut résilier à la main. */
  vivant: boolean;
  lien: string;
}

/** Ce que notre base sait de l'espace, lu AVANT la cascade (`PgSuppressionEspaceStore.bilan`). */
export interface BilanSuppression {
  tenantId: string;
  nom: string;
  /** ISO. */
  creeLe: string;
  statut: string;
  comptes: { utilisateurs: number; contacts: number; conversations: number; scenarios: number };
  soldeMicroEur: number;
  /** La clé restreinte ne lit pas les abonnements : on ne montre que ce que notre base sait. */
  stripe: { clients: ClientStripe[]; abonnements: AbonnementStripe[] };
  numeroFourni: { numero: string; vuDeMeta: boolean } | null;
  meta: {
    phoneNumberId: string | null;
    wabaId: string | null;
    /** Le compte WhatsApp ou le numéro sont nommés par un AUTRE espace : rien ne se fait chez Meta. */
    partage: boolean;
    mbaAllume: boolean;
    contactsSurLaListe: number;
  };
  salesforce: boolean;
  cleVercel: boolean;
  /** Les adresses de l'espace : effacées (aucun autre espace), ou gardées (un autre espace, ou l'exploitation). */
  adresses: { effacees: string[]; gardees: string[] };
}

/** Ce qui ne vient pas de notre base : le jeton que Meta recevrait, HubSpot, et ce que cette instance sait faire. */
export interface ContexteTiers {
  /**
   * Le jeton que les appels chez Meta prendraient (`MetaCredentialsResolver.resolveForTenant`) : `propre` (celui de
   * l'espace, avec le compte WhatsApp qu'il porte), `global` (le nôtre, `META_ACCESS_TOKEN`), ou `invalide` (révoqué).
   */
  meta: { jeton: 'propre' | 'global' | 'invalide'; wabaId: string | null };
  /** Un portail HubSpot relié ? `null` = la lecture a échoué. */
  hubspot: boolean | null;
  configures: { vercel: boolean; salesforce: boolean; hubspot: boolean };
}

/** Les gestes, donnés par le câblage. Chacun peut lever : l'orchestrateur note l'échec. */
export interface DepsSuppression {
  verrouiller(tenantId: string): Promise<boolean>;
  /** `false` = pas de clé. `null` = provisionnement non configuré sur cette instance. */
  revoquerCleVercel: ((tenantId: string) => Promise<boolean>) | null;
  eteindreMba(tenantId: string, phoneNumberId: string): Promise<void>;
  viderListeMba(tenantId: string): Promise<{ retires: number; refuses: number }>;
  desabonnerWaba(tenantId: string, wabaId: string): Promise<void>;
  /**
   * Délie l'organisation Salesforce (`src/salesforce/connexion.ts`) : `efface` (le secret effacé dans l'org, la ligne
   * oubliée), `non_efface` (l'org n'a pas répondu, la ligne oubliée quand même), `oublie` (l'app n'est pas configurée
   * sur cette instance : la ligne seule est oubliée), `non_relie`. 🔴 Requis, et jamais dans la purge : le schéma
   * `salesforce` ne se nomme que dans `src/salesforce/` (il doit pouvoir partir sur sa propre base), et une org laissée
   * à un espace disparu serait encore appelée par le balayage des orgs connectées.
   */
  deconnecterSalesforce(tenantId: string): Promise<'efface' | 'non_efface' | 'oublie' | 'non_relie'>;
  deconnecterHubspot: ((tenantId: string) => Promise<void>) | null;
  sortirNumeroFourni(tenantId: string): Promise<IssueSortieNumero>;
  purger(tenantId: string, trace: { par: string; etapes: EtapeJouee[] }): Promise<IssuePurge>;
}

export interface ComptesPurges {
  utilisateurs: number;
  contacts: number;
  conversations: number;
  messages: number;
  scenarios: number;
  identitesEffacees: number;
  identitesGardees: number;
}

/**
 * Ce qu'a fait la purge : faite (avec ses comptes), ou refusée sans rien toucher, l'espace ayant disparu entre-temps
 * (`disparu`) ou une clé Vercel s'étant rouverte depuis la révocation (`cle_rouverte`, il faut recommencer).
 */
export type IssuePurge =
  | { fait: true; comptes: ComptesPurges }
  | { fait: false; raison: 'disparu' | 'cle_rouverte' };

export interface IssueSuppression {
  supprime: boolean;
  etapes: EtapeJouee[];
  comptes: ComptesPurges | null;
  /** Les liens rendus avec la réponse : c'est le moment où Julien en a besoin. */
  stripe: BilanSuppression['stripe'];
}

/**
 * Le nom tapé correspond-il au nom de l'espace ? Exactement, casse comprise, sans tenir compte des espaces en tête et
 * en fin. C'est la confirmation d'un geste irréversible : aucune tolérance de plus.
 */
export function nomCorrespond(saisi: unknown, nom: string): boolean {
  return typeof saisi === 'string' && saisi.trim() !== '' && saisi.trim() === nom.trim();
}

/** Un détail lisible et borné : il part dans la réponse et dans la ligne de trace. */
const borne = (texte: string): string => (texte.length > 300 ? `${texte.slice(0, 297)}...` : texte);

/** Les trois étapes chez Meta sautées pour la même raison, ou `null` si elles peuvent se jouer. */
function gardeMeta(b: BilanSuppression, c: ContexteTiers): string | null {
  if (b.meta.partage) return 'sautée : compte WhatsApp ou numéro partagé avec un autre espace';
  if (c.meta.jeton === 'global') return 'sautée : jeton global (l’espace n’a pas de jeton propre)';
  if (c.meta.jeton === 'invalide') return 'sautée : jeton de l’espace invalide';
  return null;
}

/**
 * Ce que chaque étape fera, sans rien faire : le bilan le montre avant la saisie du nom, la suppression le suit. Une
 * étape sans objet est sautée avant toute garde (« liste vide » dit plus que « partagé » quand il n'y a rien à faire).
 */
export function prevoirEtapes(b: BilanSuppression, c: ContexteTiers): EtapePrevue[] {
  const a = (etape: NomEtape, detail: string | null = null): EtapePrevue => ({ etape, etat: 'a_faire', detail });
  const s = (etape: NomEtape, detail: string): EtapePrevue => ({ etape, etat: 'sautee', detail });
  const i = (etape: NomEtape, detail: string): EtapePrevue => ({ etape, etat: 'impossible', detail });
  const meta = gardeMeta(b, c);
  return [
    a('verrou', b.statut === 'locked' ? 'déjà verrouillé' : null),
    !b.cleVercel ? s('cle_vercel', 'aucune clé')
      : !c.configures.vercel ? i('cle_vercel', 'Vercel non configuré sur cette instance : la clé ne peut pas être révoquée')
        : a('cle_vercel'),
    b.meta.phoneNumberId === null ? s('mba_eteint', 'aucun numéro')
      : !b.meta.mbaAllume ? s('mba_eteint', 'agent de Meta déjà éteint')
        : meta !== null ? s('mba_eteint', meta) : a('mba_eteint'),
    b.meta.contactsSurLaListe === 0 ? s('mba_liste', 'liste vide')
      : meta !== null ? s('mba_liste', meta) : a('mba_liste', `${b.meta.contactsSurLaListe} contact(s)`),
    c.meta.wabaId === null && b.meta.wabaId === null ? s('waba_desabonne', 'aucun compte WhatsApp')
      : meta !== null ? s('waba_desabonne', meta) : a('waba_desabonne'),
    !b.salesforce ? s('salesforce', 'non relié')
      : a('salesforce', c.configures.salesforce ? null : 'app Salesforce non configurée : la ligne seule sera oubliée'),
    c.hubspot === false ? s('hubspot', 'non relié')
      : !c.configures.hubspot ? i('hubspot', 'connecteur HubSpot non configuré : portail à délier à la main')
        : a('hubspot', c.hubspot === null ? 'portail inconnu (lecture en échec)' : null),
    b.numeroFourni === null ? s('numero_fourni', 'aucun')
      : a('numero_fourni', b.numeroFourni.vuDeMeta ? `${b.numeroFourni.numero} : vu de Meta, à résilier chez DIDWW` : `${b.numeroFourni.numero} : rendu à la réserve`),
    a('purge'),
  ];
}

function detailNumero(r: IssueSortieNumero): { etat: 'fait' | 'sautee' | 'echec'; detail: string } {
  switch (r.fait) {
    case 'aucun': return { etat: 'sautee', detail: 'aucun' };
    case 'libre': return { etat: 'fait', detail: `${r.numero} rendu à la réserve` };
    case 'resilie': return { etat: 'fait', detail: `${r.numero} résilié chez DIDWW` };
    // Sorti de la réserve sans être résilié : Julien doit le résilier à la main, c'est un échec à lire.
    case 'bloque': return { etat: 'echec', detail: `${r.numero} bloqué, à résilier chez DIDWW à la main : ${r.cause}` };
  }
}

/**
 * Joue la suppression d'un espace dont le nom a déjà été vérifié par la route. Ne lève jamais sur une étape : chaque
 * résultat est noté, et la réponse dit ce qui a été fait. 🔴 Le verrou et la clé Vercel arrêtent tout s'ils échouent ;
 * le reste est au mieux.
 */
export async function supprimerEspace(d: DepsSuppression, b: BilanSuppression, c: ContexteTiers, par: string): Promise<IssueSuppression> {
  const prevues = new Map(prevoirEtapes(b, c).map((p) => [p.etape, p]));
  const etapes: EtapeJouee[] = [];
  const fin = (comptes: ComptesPurges | null): IssueSuppression => ({ supprime: comptes !== null, etapes, comptes, stripe: b.stripe });

  /** Joue une étape prévue : sautée telle quelle, impossible en échec, sinon l'action. Rend `false` sur un échec. */
  const jouer = async (etape: NomEtape, action: () => Promise<{ etat: 'fait' | 'sautee' | 'echec'; detail: string | null }>): Promise<boolean> => {
    const p = prevues.get(etape);
    if (p?.etat === 'sautee') {
      etapes.push({ etape, etat: 'sautee', detail: p.detail });
      return true;
    }
    if (p?.etat === 'impossible') {
      etapes.push({ etape, etat: 'echec', detail: p.detail });
      return false;
    }
    try {
      const r = await action();
      etapes.push({ etape, etat: r.etat, detail: r.detail === null ? null : borne(r.detail) });
      return r.etat !== 'echec';
    } catch (err) {
      etapes.push({ etape, etat: 'echec', detail: borne(texteDe(err)) });
      return false;
    }
  };
  const fait = (detail: string | null = null) => ({ etat: 'fait' as const, detail });

  // 0. Le verrou : sans lui, une traduction ou une création d'agent pourrait rouvrir une clé derrière la révocation.
  if (!(await jouer('verrou', async () => {
    if (!(await d.verrouiller(b.tenantId))) throw new Error('espace introuvable');
    return fait(prevues.get('verrou')?.detail ?? null);
  }))) return fin(null);

  // 1. 🔴 La clé Vercel : échec = arrêt, rien n'est purgé.
  if (!(await jouer('cle_vercel', async () => {
    if (d.revoquerCleVercel === null) throw new Error('Vercel non configuré sur cette instance');
    return (await d.revoquerCleVercel(b.tenantId)) ? fait('révoquée chez Vercel') : { etat: 'sautee', detail: 'aucune clé' };
  }))) return fin(null);

  // 2. Au mieux : chaque échec est noté, aucun n'arrête la suite.
  await jouer('mba_eteint', async () => {
    await d.eteindreMba(b.tenantId, b.meta.phoneNumberId ?? '');
    return fait();
  });
  await jouer('mba_liste', async () => {
    const r = await d.viderListeMba(b.tenantId);
    return r.refuses > 0
      ? { etat: 'echec', detail: `${r.retires} retiré(s), ${r.refuses} refusé(s) par Meta` }
      : fait(`${r.retires} retiré(s)`);
  });
  await jouer('waba_desabonne', async () => {
    const waba = c.meta.wabaId ?? b.meta.wabaId;
    if (waba === null) return { etat: 'sautee', detail: 'aucun compte WhatsApp' };
    await d.desabonnerWaba(b.tenantId, waba);
    return fait();
  });
  await jouer('salesforce', async () => {
    switch (await d.deconnecterSalesforce(b.tenantId)) {
      case 'non_relie': return { etat: 'sautee', detail: 'non relié' };
      case 'efface': return fait('secret effacé dans l’org');
      case 'non_efface': return fait('délié chez nous, l’org n’a pas répondu (secret non effacé)');
      case 'oublie': return fait('app Salesforce non configurée : ligne oubliée, secret non effacé dans l’org');
    }
  });
  await jouer('hubspot', async () => {
    if (d.deconnecterHubspot === null) throw new Error('connecteur HubSpot non configuré : portail à délier à la main');
    await d.deconnecterHubspot(b.tenantId);
    return fait();
  });
  await jouer('numero_fourni', async () => detailNumero(await d.sortirNumeroFourni(b.tenantId)));

  // 3. La purge, et sa ligne de trace dans la même transaction. Ses propres étapes ne sont pas dans la trace : la
  //    ligne n'existe que si elle a réussi.
  let comptes: ComptesPurges | null = null;
  await jouer('purge', async () => {
    const r = await d.purger(b.tenantId, { par, etapes: [...etapes] });
    if (!r.fait) {
      return {
        etat: 'echec',
        detail: r.raison === 'cle_rouverte'
          ? 'une clé Vercel s’est rouverte depuis la révocation : rien n’est purgé, recommencez'
          : 'l’espace n’existe plus',
      };
    }
    comptes = r.comptes;
    return fait();
  });
  return fin(comptes);
}
