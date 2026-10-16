import { journaliser } from '../lib/journal';
import type { EmetteurEmails } from './emission';

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
  /** Les limites de l'offre de l'espace : `null` = sans limite (Pro, Entreprise). */
  limites(tenantId: string): Promise<{ modelesMois: number | null; contacts: number | null }>;
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

/** Le seuil atteint : `usage` vaut au moins `pct` % de `limite`, arrondi au supérieur (80 % de 100, c'est 80). */
/**
 * Les limites que surveille le balayage, selon l'offre (spec offres v2, livraison 1) : la Free seule, parce que le texte
 * de ces e-mails dit « Offre Free… Passez en Pro ». Une Entreprise peut avoir une limite de contacts posée par /ops, et le
 * Pro en aura une à la livraison 5 : leurs textes viennent avec elle. `null` = rien à surveiller.
 */
export function limitesAlertables(
  offre: 'base' | 'pro' | 'entreprise', l: { envoisModelesMois: number | null; contacts: number | null },
): { modelesMois: number | null; contacts: number | null } {
  return offre === 'base' ? { modelesMois: l.envoisModelesMois, contacts: l.contacts } : { modelesMois: null, contacts: null };
}

export function seuilAtteint(usage: number, limite: number, pct: number): boolean {
  return limite > 0 && usage >= Math.ceil((limite * pct) / 100);
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
      if (l.contacts === null) {
        // Une offre sans limite relâche ses seuils : revenu en Free au-dessus de la limite (fin du Pro, impayé), l'espace
        // doit recevoir l'alerte de 100 % et son « Passer en Pro », c'est là qu'elle sert le plus.
        for (const pct of SEUILS_LIMITES) await d.franchir(tenantId, `contacts_${pct}`, false);
      } else {
        const crees = await d.contactsCrees(tenantId);
        // Chaque seuil a son état ; on les pose tous (un seuil relâché se réarme), et on n'écrit que le plus haut
        // franchi à l'instant.
        const franchis: Array<{ pct: (typeof SEUILS_LIMITES)[number]; generation: number }> = [];
        for (const pct of SEUILS_LIMITES) {
          const g = await d.franchir(tenantId, `contacts_${pct}`, seuilAtteint(crees, l.contacts, pct));
          if (g !== null) franchis.push({ pct, generation: g });
        }
        const plusHaut = franchis[0];
        if (plusHaut) {
          try {
            await d.emettre({
              cle: `limite_contacts_${plusHaut.pct}` as const, tenantId, occasion: `franchissement:${plusHaut.generation}`, a: 'admins',
              valeurs: { limite: String(l.contacts), lien_offre: d.pageOffre },
            });
          } catch (err) {
            // 🔴 Le seuil est posé AVANT la réservation : sans ce relâchement, une émission ratée (base, pool) perdrait
            // l'alerte jusqu'à un retour sous le seuil, qui à 100 % peut ne jamais venir. Relâchés, les seuils franchis
            // le seront de nouveau au tour suivant, avec une génération neuve.
            for (const f of franchis) await d.franchir(tenantId, `contacts_${f.pct}`, false);
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
      await d.emettre({
        cle: 'transfert_equipe', tenantId, a: 'admins',
        // Le message qui attend : deux passages pour le même message n'envoient qu'un e-mail.
        occasion: `attente:${c.conversationId}:${c.dernierEntrantLe.toISOString()}`,
        valeurs: {
          contact: c.nom?.trim() || numeroMasque(c.waId),
          fin_fenetre: new Date(c.dernierEntrantLe.getTime() + FENETRE_MS).toISOString(),
          lien_conversation: d.lienConversation(c.conversationId),
        },
      });
    } catch (err) {
      journaliser('error', 'alerte_passage_equipe_impossible', { err, tenantId });
    }
  };
}
