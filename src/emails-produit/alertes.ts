import { journaliser } from '../lib/journal';
import type { EmetteurEmails } from './emission';
import { DROITS, type Offre } from '../offres/offres';
import { jourDans } from '../repondeur/alerte-credit';

/**
 * LES ALERTES DE LA LIVRAISON B (lot 7, spec `docs/superpowers/specs/2026-10-14-emails-produit-design.md`) : ce qui
 * DÉCIDE qu'un e-mail part, et son occasion. L'envoi lui-même est celui du socle (journal, file, réessais). Aucune ne
 * lève jamais : une alerte qui tombe ne doit pas faire tomber le débit, le webhook ou la bascule qu'elle accompagne.
 */

type Emettre = EmetteurEmails['emettre'];

// ---------------------------------------------------------------------------------------------------------------
// Le crédit IA presque épuisé
// ---------------------------------------------------------------------------------------------------------------

/** Le seuil du crédit bas : 0,50 €, celui du bandeau de la console (`web/lib/agent-solde.ts`). */
export const SEUIL_CREDIT_BAS_MICRO_EUR = 500_000;

/**
 * Le débit qui fait passer le solde SOUS le seuil émet l'alerte ; les débits suivants, sous le seuil, ne la refont
 * pas. 🔴 L'occasion est le DERNIER CRÉDIT REÇU (recharge, achat, offert) : une recharge en ouvre une nouvelle, donc
 * l'alerte se réarme sans aucun état à tenir, et deux copies qui franchissent le seuil ensemble n'en réservent qu'une.
 */
export function creerAlerteCreditBas(d: {
  emettre: Emettre;
  /** L'identifiant du dernier mouvement POSITIF du crédit de l'espace, `null` s'il n'y en a jamais eu. */
  dernierCreditRecu(tenantId: string): Promise<string | null>;
  pageCredit: string;
}): { surDebit(tenantId: string, avantMicroEur: number, apresMicroEur: number): Promise<void> } {
  return {
    async surDebit(tenantId, avant, apres) {
      if (!(avant >= SEUIL_CREDIT_BAS_MICRO_EUR && apres < SEUIL_CREDIT_BAS_MICRO_EUR)) return;
      try {
        const dernier = (await d.dernierCreditRecu(tenantId)) ?? 'aucun';
        await d.emettre({
          cle: 'credit_bas', tenantId, occasion: `recharge:${dernier}`, a: 'admins',
          valeurs: { solde: String(Math.max(0, Math.round(apres))), lien_credit: d.pageCredit },
        });
      } catch (err) {
        journaliser('error', 'alerte_credit_bas_impossible', { err, tenantId });
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Le paiement refusé
// ---------------------------------------------------------------------------------------------------------------

/** Un renouvellement refusé par Stripe, d'un abonnement EN RETARD : le Pro ou le numéro fourni, et sa facture. */
export interface PaiementRefuse {
  tenantId: string;
  offre: 'pro' | 'numero';
  /** La facture Stripe (`in_...`) : l'occasion. Stripe réessaie la même facture, l'e-mail ne part qu'une fois. */
  factureId: string;
}

export function creerPaiementRefuse(d: {
  emettre: Emettre; pageNumero: string; pageOffre: string;
  /**
   * Le jour où les envois du numéro seront coupés, lu dans l'état de l'espace (`etatDeLEspace().coupureLe` : premier
   * échec plus `DELAI_COUPURE_IMPAYE_MS`), `null` s'il ne le sera pas (un numéro apporté envoie, rien de chez nous n'est
   * coupé) : l'e-mail ne promet alors pas de coupure, il ne part pas.
   */
  coupureDuNumero(tenantId: string): Promise<Date | null>;
}): (p: PaiementRefuse) => Promise<void> {
  return async (p) => {
    try {
      if (p.offre === 'numero') {
        const coupure = await d.coupureDuNumero(p.tenantId);
        if (coupure === null) {
          journaliser('info', 'paiement_refuse_numero_sans_coupure', { tenantId: p.tenantId });
          return;
        }
        await d.emettre({
          cle: 'paiement_refuse_numero', tenantId: p.tenantId, occasion: `facture:${p.factureId}`, a: 'admins',
          valeurs: { date_coupure: coupure.toISOString(), lien_numero: d.pageNumero },
        });
      } else {
        await d.emettre({
          cle: 'paiement_refuse_pro', tenantId: p.tenantId, occasion: `facture:${p.factureId}`, a: 'admins',
          valeurs: { lien_offre: d.pageOffre },
        });
      }
    } catch (err) {
      journaliser('error', 'alerte_paiement_refuse_impossible', { err, tenantId: p.tenantId, offre: p.offre });
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Les limites du Free
// ---------------------------------------------------------------------------------------------------------------

/** Les seuils, du plus haut au plus bas : un balayage n'envoie que le plus haut franchi (100 % rend 80 % superflu). */
export const SEUILS_LIMITES = [100, 80] as const;

export interface DepsLimites {
  espaces(): Promise<string[]>;
  /** Les limites surveillées de l'espace (`limitesAlertables`) : `null` = rien à surveiller ; `offre` choisit les textes. */
  limites(tenantId: string): Promise<LimitesAlertables>;
  /** Les modèles envoyés ce mois-ci, `null` si le compteur ne répond pas. */
  modelesDuMois(tenantId: string): Promise<number | null>;
  contactsCrees(tenantId: string): Promise<number>;
  /**
   * Pose l'état d'un seuil des contacts : `atteint` vrai rend la nouvelle génération SEULEMENT si le seuil vient d'être
   * franchi (une seule copie la gagne), `null` sinon ; faux le relâche, pour qu'un nouveau franchissement prévienne.
   */
  franchir(tenantId: string, seuil: string, atteint: boolean): Promise<number | null>;
  emettre: Emettre;
  pageOffre: string;
  /** Le mois civil de Paris (`AAAA-MM`) : l'occasion des modèles, dont le compteur repart chaque mois. */
  moisDeParis(): string;
}

/** Ce que surveille le balayage d'un espace, et les textes de quelle offre (`null` : aucun, rien n'est surveillé). */
export interface LimitesAlertables {
  modelesMois: number | null;
  contacts: number | null;
  offre: 'free' | 'pro' | null;
}

/**
 * Les limites que surveille le balayage, selon l'offre (spec offres v2, livraison 5) : celles de la Free, dont les textes
 * disent « Passez en Pro », et les contacts du Pro, dont les textes renvoient à l'Entreprise (le Pro n'a pas de limite de
 * modèles). L'Entreprise, dont la limite de contacts se règle sur devis par /ops, n'en reçoit aucune : un texte la dirait
 * dans une offre qui n'est pas la sienne. Le Business non plus, tant que ses textes n'existent pas (lot 1, sous-lot B) :
 * ceux du Pro le diraient en Pro. `null` = rien à surveiller.
 */
export function limitesAlertables(
  offre: Offre, l: { envoisModelesMois: number | null; contacts: number | null },
): LimitesAlertables {
  if (offre === 'base') return { modelesMois: l.envoisModelesMois, contacts: l.contacts, offre: 'free' };
  if (offre === 'pro') return { modelesMois: null, contacts: l.contacts, offre: 'pro' };
  return { modelesMois: null, contacts: null, offre: null };
}

/** Le seuil atteint : `usage` vaut au moins `pct` % de `limite`, arrondi au supérieur (80 % de 100, c'est 80). */
export function seuilAtteint(usage: number, limite: number, pct: number): boolean {
  return limite > 0 && usage >= Math.ceil((limite * pct) / 100);
}

/**
 * 🔴 AU-DESSUS DE 100 %, LA FREE A UN SEUIL DE PLUS : « dépassée », strictement plus de fiches que sa limite (plan du
 * 2026-10-26). Un espace qui revient en Free avec 3 000 contacts (fin du Pro, de l'essai, sortie de l'Entreprise) franchit
 * les trois d'un coup, et reçoit celui-là seul (`limite_contacts_depassee`), qui dit combien en supprimer et comment, au
 * lieu du « limite atteinte » de 100 %. Le Pro n'en a pas : ses textes renvoient à l'Entreprise.
 */
export const SEUIL_DEPASSEE = 'depassee';
type SeuilContacts = typeof SEUIL_DEPASSEE | (typeof SEUILS_LIMITES)[number];
/** Les seuils des contacts de chaque famille, du plus haut au plus bas : seul le plus haut franchi s'écrit. */
const SEUILS_CONTACTS: Readonly<Record<'contacts' | 'contacts_pro', readonly SeuilContacts[]>> = {
  contacts: [SEUIL_DEPASSEE, ...SEUILS_LIMITES],
  contacts_pro: SEUILS_LIMITES,
};

function seuilContactsAtteint(fiches: number, limite: number, s: SeuilContacts): boolean {
  return s === SEUIL_DEPASSEE ? fiches > limite : seuilAtteint(fiches, limite, s);
}

/** L'e-mail du seuil le plus haut franchi, avec les textes de l'offre : le Pro renvoie à l'Entreprise, la Free au Pro. */
function emissionContacts(tenantId: string, offre: LimitesAlertables['offre'], seuil: SeuilContacts, generation: number,
  fiches: number, limite: number, pageOffre: string): Parameters<Emettre>[0] {
  const occasion = `franchissement:${generation}`;
  if (offre === 'pro') {
    return {
      cle: seuil === 100 ? 'limite_contacts_pro_100' : 'limite_contacts_pro_80', tenantId, occasion, a: 'admins',
      valeurs: { limite: String(limite), lien_offre: pageOffre },
    };
  }
  const limitePro = String(DROITS.pro.limites.contacts ?? '');
  if (seuil === SEUIL_DEPASSEE) {
    return {
      cle: 'limite_contacts_depassee', tenantId, occasion, a: 'admins',
      valeurs: { contacts: String(fiches), limite: String(limite), a_supprimer: String(fiches - limite), limite_pro: limitePro, lien_offre: pageOffre },
    };
  }
  return {
    cle: seuil === 100 ? 'limite_contacts_100' : 'limite_contacts_80', tenantId, occasion, a: 'admins',
    valeurs: { limite: String(limite), limite_pro: limitePro, lien_offre: pageOffre },
  };
}

/** Un tour du balayage des limites. Rend le nombre d'émissions tentées. Un espace en échec n'arrête pas les autres. */
export async function balayerLimites(d: DepsLimites): Promise<number> {
  let n = 0;
  const mois = d.moisDeParis();
  for (const tenantId of await d.espaces()) {
    try {
      const l = await d.limites(tenantId);
      if (l.modelesMois !== null) {
        const faits = await d.modelesDuMois(tenantId);
        const pct = faits === null ? undefined : SEUILS_LIMITES.find((s) => seuilAtteint(faits, l.modelesMois!, s));
        if (pct !== undefined) {
          await d.emettre({
            cle: `limite_modeles_${pct}` as const, tenantId, occasion: `mois:${mois}`, a: 'admins',
            valeurs: { limite: String(l.modelesMois), lien_offre: d.pageOffre },
          });
          n += 1;
        }
      }
      // Les seuils sont ceux de l'offre (`contacts_` en Free, `contacts_pro_` en Pro), et ceux de l'autre se relâchent :
      // un Pro arrivé à sa limite puis revenu en Free a déjà franchi ses seuils de Pro, pas ceux de la Free, et reçoit
      // son « Passer en Pro ». Un relâchement n'écrit rien quand le seuil l'est déjà.
      // 🔴 Tous les seuils de l'autre famille, « dépassée » compris : une Free à 3 000 contacts passée en Pro puis revenue
      // doit recevoir de nouveau son « dépassée ».
      const famille = l.offre === 'pro' ? 'contacts_pro' : 'contacts';
      const autre = famille === 'contacts' ? 'contacts_pro' : 'contacts';
      for (const s of SEUILS_CONTACTS[autre]) await d.franchir(tenantId, `${autre}_${s}`, false);
      if (l.contacts === null) {
        // Une offre sans limite relâche ses seuils : revenu en Free au-dessus de la limite (fin du Pro, impayé), l'espace
        // doit recevoir l'alerte qui lui dit quoi faire, c'est là qu'elle sert le plus.
        for (const s of SEUILS_CONTACTS[famille]) await d.franchir(tenantId, `${famille}_${s}`, false);
      } else {
        const crees = await d.contactsCrees(tenantId);
        // Chaque seuil a son état ; on les pose tous (un seuil relâché se réarme), et on n'écrit que le plus haut
        // franchi à l'instant.
        const franchis: Array<{ seuil: SeuilContacts; generation: number }> = [];
        for (const s of SEUILS_CONTACTS[famille]) {
          const g = await d.franchir(tenantId, `${famille}_${s}`, seuilContactsAtteint(crees, l.contacts, s));
          if (g !== null) franchis.push({ seuil: s, generation: g });
        }
        const plusHaut = franchis[0];
        if (plusHaut) {
          try {
            await d.emettre(emissionContacts(tenantId, l.offre, plusHaut.seuil, plusHaut.generation, crees, l.contacts, d.pageOffre));
          } catch (err) {
            // 🔴 Le seuil est posé AVANT la réservation : sans ce relâchement, une émission ratée (base, pool) perdrait
            // l'alerte jusqu'à un retour sous le seuil, qui à 100 % peut ne jamais venir. Relâchés, les seuils franchis
            // le seront de nouveau au tour suivant, avec une génération neuve.
            for (const f of franchis) await d.franchir(tenantId, `${famille}_${f.seuil}`, false);
            throw err;
          }
          n += 1;
        }
      }
    } catch (err) {
      journaliser('error', 'alerte_limites_impossible', { err, tenantId });
    }
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// L'espace Free plein qui écarte un nouveau client
// ---------------------------------------------------------------------------------------------------------------

/**
 * L'ALERTE DE L'ESPACE PLEIN (décision de Julien du 2026-10-25) : un inconnu a écrit à une Free qui a déjà tous ses
 * contacts, et son message n'est pas entré (`src/webhooks/espace-plein.ts`). Aux administrateurs, au plus une fois par
 * jour et par espace : l'occasion est le jour, dans le fuseau de l'espace, et la réservation en base arrête la seconde,
 * quel que soit le nombre de copies qui voient passer des inconnus (comme `credit_epuise`). Elle ne cite que la limite :
 * jamais rien de la personne qui a écrit. Ne lève jamais : l'alerte ne doit pas faire tomber la réception qu'elle accompagne.
 */
export function creerAlerteEspacePlein(d: {
  emettre: Emettre;
  /** Le fuseau IANA de l'espace (`tenant_settings.timezone`, défaut du serveur). */
  fuseau(tenantId: string): Promise<string>;
  pageOffre: string;
  now?: () => Date;
}): (tenantId: string, limite: number) => Promise<void> {
  return async (tenantId, limite) => {
    try {
      const jour = jourDans(await d.fuseau(tenantId), d.now ? d.now() : new Date());
      await d.emettre({
        cle: 'espace_plein_entrant', tenantId, occasion: `plein:${jour}`, a: 'admins',
        valeurs: { limite: String(limite), lien_offre: d.pageOffre },
      });
    } catch (err) {
      journaliser('error', 'alerte_espace_plein_impossible', { err, tenantId });
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------
// La conversation passée à l'équipe
// ---------------------------------------------------------------------------------------------------------------

/**
 * 🔴 LE CONTACT DOIT AVOIR ÉCRIT IL Y A MOINS DE QUINZE MINUTES, ET C'EST LA GARDE CONTRE L'ENVOI DE MASSE. Un
 * scénario passe aussi la main au démarrage d'une campagne ou à un réveil (un minuteur qui tombe pour des milliers de
 * contacts à la fois) : un e-mail par contact y serait un envoi de masse aux admins. Les trois robots qui passent la
 * main pendant qu'un client attend (agent IA, agent de Meta, scénario qui répond à un message) le font juste après son
 * message : c'est cela, et seulement cela, qui mérite un e-mail.
 */
export const ATTENTE_RECENTE_MS = 15 * 60 * 1000;
/**
 * Au plus dix e-mails de passage à l'équipe par espace et par jour (Paris), décision de Julien du 2026-10-14 : une
 * campagne dont le scénario passe chaque réponse à l'équipe en ferait un par réponse. Au-delà, plus rien ce jour-là ;
 * les conversations restent dans « À traiter ».
 */
export const PLAFOND_TRANSFERTS_JOUR = 10;
/** La fenêtre de service de WhatsApp : 24 heures depuis le dernier message du client. */
export const FENETRE_MS = 24 * 60 * 60 * 1000;

/** Ce que l'e-mail lit de la conversation. */
export interface ContextePassage {
  conversationId: string;
  /** Le nom du profil WhatsApp du contact, `null` s'il n'en a pas. */
  nom: string | null;
  waId: string;
  /** Le dernier message WhatsApp du contact, `null` s'il n'a jamais écrit. */
  dernierEntrantLe: Date | null;
}

/** Un numéro masqué : l'indicatif et les deux derniers chiffres, jamais le numéro entier dans un e-mail. */
export function numeroMasque(waId: string): string {
  const chiffres = waId.replace(/\D/g, '');
  if (chiffres.length < 6) return '••••';
  return `+${chiffres.slice(0, 2)} •• •• •• ${chiffres.slice(-2)}`;
}

export function creerPrevenirEquipe(d: {
  contexte(tenantId: string, waId: string): Promise<ContextePassage | null>;
  /** Les passages déjà écrits aujourd'hui pour l'espace (`PLAFOND_TRANSFERTS_JOUR`). */
  transfertsDuJour(tenantId: string): Promise<number>;
  emettre: Emettre;
  /** L'adresse de la conversation dans l'Inbox de la console. */
  lienConversation(conversationId: string): string;
  /**
   * L'offre de l'espace ouvre-t-elle l'Inbox (la fonction `inbox`) ? Sinon (la Free), l'e-mail dit de répondre depuis
   * Claude ou l'application, et son bouton mène à l'offre (`transfert_equipe_free`) : celui de l'Inbox mènerait à une
   * page fermée.
   */
  inboxOuverte(tenantId: string): Promise<boolean>;
  /** La page de l'offre, le bouton de la version sans Inbox. */
  lienOffre: string;
  now?: () => Date;
}): (tenantId: string, waId: string) => Promise<void> {
  return async (tenantId, waId) => {
    try {
      const c = await d.contexte(tenantId, waId);
      if (c === null || c.dernierEntrantLe === null) return;
      const maintenant = (d.now ? d.now() : new Date()).getTime();
      const depuis = maintenant - c.dernierEntrantLe.getTime();
      if (depuis > ATTENTE_RECENTE_MS || depuis < -60_000) return;
      if ((await d.transfertsDuJour(tenantId)) >= PLAFOND_TRANSFERTS_JOUR) {
        journaliser('info', 'passage_equipe_plafond_atteint', { tenantId });
        return;
      }
      // Une offre illisible garde l'e-mail d'aujourd'hui, comme le cache des offres se replie sur l'Entreprise.
      const avecInbox = await d.inboxOuverte(tenantId).catch(() => true);
      const contact = c.nom?.trim() || numeroMasque(c.waId);
      const finFenetre = new Date(c.dernierEntrantLe.getTime() + FENETRE_MS).toISOString();
      await d.emettre({
        tenantId, a: 'admins',
        // Le message qui attend : deux passages pour le même message n'envoient qu'un e-mail.
        occasion: `attente:${c.conversationId}:${c.dernierEntrantLe.toISOString()}`,
        ...(avecInbox
          ? { cle: 'transfert_equipe', valeurs: { contact, fin_fenetre: finFenetre, lien_conversation: d.lienConversation(c.conversationId) } }
          : { cle: 'transfert_equipe_free', valeurs: { contact, fin_fenetre: finFenetre, lien_offre: d.lienOffre } }),
      });
    } catch (err) {
      journaliser('error', 'alerte_passage_equipe_impossible', { err, tenantId });
    }
  };
}
