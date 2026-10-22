import type { Pool, PoolClient } from 'pg';
import { decryptSecret, encryptSecret } from '../crypto/secretbox';
import { enTransaction } from '../db/transaction';
import { estDonneeShopify, type DonneeShopify, type EvenementShopify } from './donnees';

/**
 * LE STORE DU CONNECTEUR SHOPIFY (plan 2026-10-21, lot 1), seul à écrire les tables `shopify_*` (migration 0246) ;
 * `purgeMany` y efface aussi les lignes d'une fiche purgée.
 *
 * 🔴 `tenant_id = $1` SUR CHAQUE REQUÊTE, sauf CINQ lectures transverses nommées ici : `boutiqueParDomaine` et
 * `couperParDomaine` (ce sont elles qui DONNENT l'espace, à partir du domaine qui signe un webhook), et trois balayages
 * de toutes les boutiques : `purgerEvenements`, `reclamerPaniersDus` (qui joint chaque panier à SA boutique et à SON
 * message par `tenant_id`) et `purgerPaniers`.
 *
 * 🔴 LE SECRET NE SORT JAMAIS VERS UN ÉCRAN : `lire` ne le sélectionne pas, et seule `boutiqueParDomaine` le rend
 * déchiffré, pour vérifier une signature.
 */

export type EtatBoutique = 'connectee' | 'coupee';

export interface VueBoutique {
  domaine: string;
  nom: string | null;
  pays: string | null;
  devise: string | null;
  etat: EtatBoutique;
  motifCoupure: string | null;
  coupeeLe: string | null;
  connecteeLe: string;
  dernierEvenementLe: string | null;
  /** Le marchand a affirmé que ses clients consentent : qui (identifiant d'utilisateur) et quand. */
  consentement: { par: string | null; le: string } | null;
  delaiPanierMinutes: number;
}

export interface MessageBranche {
  evenement: EvenementShopify;
  modele: string;
  langue: string;
  /** Les données Shopify de {{1}}, {{2}}... dans l'ordre. */
  variables: DonneeShopify[];
  actif: boolean;
  modifieLe: string;
}

export interface BoutiqueSignee {
  tenantId: string;
  etat: EtatBoutique;
  secret: string;
  pays: string | null;
  consentementAffirme: boolean;
}

/** De quoi demander un jeton à Shopify pour l'espace : l'import des clients (lot 3). */
export interface AccesBoutique {
  domaine: string;
  clientId: string;
  secret: string;
  pays: string | null;
  etat: EtatBoutique;
}

export interface Connexion {
  domaine: string;
  clientId: string;
  secretClair: string;
  nom: string | null;
  pays: string | null;
  devise: string | null;
  par: string | null;
}

/** `boutique_ailleurs` : un autre espace tient cette boutique, connectée. */
export type IssueConnexionBoutique = 'ok' | 'boutique_ailleurs';

/** Un panier réclamé pour sa relance, avec ce que l'envoi demande. */
export interface PanierDu {
  tenantId: string;
  jeton: string;
  telephone: string;
  nom: string | null;
  lien: string;
  domaine: string;
  modele: string;
  langue: string;
  variables: DonneeShopify[];
}

/** Une issue nulle depuis plus longtemps que ce bail = un traitement mort en route : il se reprend. */
export const BAIL_EVENEMENT_S = 120;

export type Reservation = 'nouveau' | 'en_cours' | 'servi';

interface LigneBoutique {
  domaine: string; nom: string | null; pays: string | null; devise: string | null; etat: EtatBoutique;
  motif_coupure: string | null; coupee_le: Date | null; connectee_le: Date; dernier_evenement_le: Date | null;
  consentement_par: string | null; consentement_le: Date | null; delai_panier_minutes: number;
}

export class PgShopifyStore {
  constructor(private readonly pool: Pool, private readonly cle: string) {}

  async lire(tenantId: string): Promise<VueBoutique | null> {
    const res = await this.pool.query<LigneBoutique>(
      `select domaine, nom, pays, devise, etat, motif_coupure, coupee_le, connectee_le, dernier_evenement_le,
              consentement_par, consentement_le, delai_panier_minutes
         from shopify_boutiques where tenant_id = $1`,
      [tenantId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      domaine: r.domaine, nom: r.nom, pays: r.pays, devise: r.devise, etat: r.etat, motifCoupure: r.motif_coupure,
      coupeeLe: r.coupee_le?.toISOString() ?? null, connecteeLe: r.connectee_le.toISOString(),
      dernierEvenementLe: r.dernier_evenement_le?.toISOString() ?? null,
      consentement: r.consentement_le ? { par: r.consentement_par, le: r.consentement_le.toISOString() } : null,
      delaiPanierMinutes: r.delai_panier_minutes,
    };
  }

  /**
   * La boutique de l'espace avec son secret déchiffré, pour demander un jeton (import des clients, lot 3), et à
   * personne d'autre : rien de ce qui est rendu ici ne sort de l'API.
   */
  async acces(tenantId: string): Promise<AccesBoutique | null> {
    const res = await this.pool.query<{ domaine: string; client_id: string; secret_chiffre: string; pays: string | null; etat: EtatBoutique }>(
      `select domaine, client_id, secret_chiffre, pays, etat from shopify_boutiques where tenant_id = $1`,
      [tenantId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return { domaine: r.domaine, clientId: r.client_id, secret: decryptSecret(r.secret_chiffre, this.cle), pays: r.pays, etat: r.etat };
  }

  /**
   * EXCEPTION TRANSVERSE 1 : la boutique d'un domaine, qui DONNE l'espace d'un webhook. Le secret est rendu déchiffré,
   * pour vérifier la signature, et à personne d'autre.
   */
  async boutiqueParDomaine(domaine: string): Promise<BoutiqueSignee | null> {
    const res = await this.pool.query<{ tenant_id: string; etat: EtatBoutique; secret_chiffre: string; pays: string | null; consentement_le: Date | null }>(
      `select tenant_id, etat, secret_chiffre, pays, consentement_le from shopify_boutiques where domaine = $1`,
      [domaine],
    );
    const r = res.rows[0];
    if (!r) return null;
    return { tenantId: r.tenant_id, etat: r.etat, secret: decryptSecret(r.secret_chiffre, this.cle), pays: r.pays, consentementAffirme: r.consentement_le !== null };
  }

  /**
   * Relie la boutique à l'espace, ou la reprend. Un espace qui se reconnecte remplace son secret et repasse `connectee`.
   * 🔴 TOUTE CONNEXION EFFACE L'AFFIRMATION DU CONSENTEMENT : elle vaut pour les clients d'UNE boutique, affirmée par
   * une personne pour CE branchement. Gardée, une boutique de production branchée après une boutique d'essai ferait
   * écrire consentants des clients pour qui personne n'a rien affirmé (relecture du lot 1).
   * Une boutique tenue par un AUTRE espace : refusée si elle y est connectée ; reprise si elle y est coupée (l'identifiant
   * et le secret valides prouvent qu'on la tient), et l'autre espace perd son branchement, pas ses fiches.
   */
  async connecter(tenantId: string, c: Connexion): Promise<IssueConnexionBoutique> {
    const secret = encryptSecret(c.secretClair, this.cle);
    // Deux espaces qui branchent la même boutique neuve en même temps : aucune ligne à verrouiller, l'unicité du domaine
    // départage, et le perdant est dit « ailleurs » plutôt qu'en panne (relecture du lot 1).
    try {
      return await this.connecterDansUneTransaction(tenantId, c, secret);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return 'boutique_ailleurs';
      throw err;
    }
  }

  private connecterDansUneTransaction(tenantId: string, c: Connexion, secret: string): Promise<IssueConnexionBoutique> {
    return enTransaction(this.pool, async (client): Promise<IssueConnexionBoutique> => {
      const tenue = (await client.query<{ tenant_id: string; etat: EtatBoutique }>(
        `select tenant_id, etat from shopify_boutiques where domaine = $1 for update`, [c.domaine],
      )).rows[0];
      if (tenue && tenue.tenant_id !== tenantId) {
        if (tenue.etat === 'connectee') return 'boutique_ailleurs';
        await effacerBranchement(client, tenue.tenant_id);
      }
      await client.query(
        `insert into shopify_boutiques (tenant_id, domaine, client_id, secret_chiffre, nom, pays, devise, etat, connectee_par, connectee_le, maj_le)
         values ($1, $2, $3, $4, $5, $6, $7, 'connectee', $8, now(), now())
         on conflict (tenant_id) do update set
           domaine = excluded.domaine, client_id = excluded.client_id, secret_chiffre = excluded.secret_chiffre,
           nom = excluded.nom, pays = excluded.pays, devise = excluded.devise, etat = 'connectee',
           motif_coupure = null, coupee_le = null, connectee_par = excluded.connectee_par, connectee_le = now(), maj_le = now(),
           consentement_par = null, consentement_le = null`,
        [tenantId, c.domaine, c.clientId, secret, c.nom, c.pays, c.devise, c.par],
      );
      // 🔴 Les paniers notés sous l'ancienne connexion partent avec son affirmation : les commandes d'une boutique coupée
      // ne les ont pas fermés, et ceux d'une autre boutique porteraient son lien (relecture du lot 2).
      await client.query(`delete from shopify_paniers where tenant_id = $1`, [tenantId]);
      return 'ok';
    });
  }

  /** Plus aucun message ; le secret reste, pour les sujets RGPD. Idempotent. */
  async couper(tenantId: string, motif: string): Promise<boolean> {
    const res = await this.pool.query(
      `update shopify_boutiques set etat = 'coupee', motif_coupure = $2, coupee_le = now(), maj_le = now()
        where tenant_id = $1 and etat <> 'coupee'`,
      [tenantId, motif],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** EXCEPTION TRANSVERSE 2 : `app/uninstalled`, qui ne connaît que le domaine. */
  async couperParDomaine(domaine: string, motif: string): Promise<void> {
    await this.pool.query(
      `update shopify_boutiques set etat = 'coupee', motif_coupure = $2, coupee_le = now(), maj_le = now()
        where domaine = $1 and etat <> 'coupee'`,
      [domaine, motif],
    );
  }

  /** `shop/redact` : le branchement part entier (secret, messages, paniers, événements, commandes), les fiches restent. */
  async effacerBoutique(tenantId: string): Promise<void> {
    await enTransaction(this.pool, (client) => effacerBranchement(client, tenantId));
  }

  async messages(tenantId: string): Promise<MessageBranche[]> {
    const res = await this.pool.query<{ evenement: EvenementShopify; modele: string; langue: string; variables: unknown; actif: boolean; modifie_le: Date }>(
      `select evenement, modele, langue, variables, actif, modifie_le from shopify_messages where tenant_id = $1 order by evenement`,
      [tenantId],
    );
    return res.rows.map((r) => ({
      evenement: r.evenement, modele: r.modele, langue: r.langue, actif: r.actif, modifieLe: r.modifie_le.toISOString(),
      // jsonb écrit par ce store seul ; une valeur illisible (version future) est retirée plutôt que de casser l'envoi.
      variables: Array.isArray(r.variables) ? r.variables.filter(estDonneeShopify) : [],
    }));
  }

  async message(tenantId: string, evenement: EvenementShopify): Promise<MessageBranche | null> {
    return (await this.messages(tenantId)).find((m) => m.evenement === evenement) ?? null;
  }

  /** Brancher REMPLACE le message de l'événement : jamais deux envois pour un même événement. */
  async brancher(tenantId: string, m: { evenement: EvenementShopify; modele: string; langue: string; variables: DonneeShopify[]; actif: boolean; par: string | null }): Promise<void> {
    await this.pool.query(
      `insert into shopify_messages (tenant_id, evenement, modele, langue, variables, actif, modifie_par, modifie_le)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7, now())
       on conflict (tenant_id, evenement) do update set
         modele = excluded.modele, langue = excluded.langue, variables = excluded.variables, actif = excluded.actif,
         modifie_par = excluded.modifie_par, modifie_le = now()`,
      [tenantId, m.evenement, m.modele, m.langue, JSON.stringify(m.variables), m.actif, m.par],
    );
  }

  /** Le marchand affirme que ses clients consentent (décision de Julien) : qui et quand, pour la trace. */
  async affirmerConsentement(tenantId: string, par: string | null): Promise<void> {
    await this.pool.query(
      `update shopify_boutiques set consentement_par = $2, consentement_le = now(), maj_le = now() where tenant_id = $1`,
      [tenantId, par],
    );
  }

  /** Le marchand retire son affirmation : plus aucune fiche n'est écrite consentante. Celles qui le sont le restent. */
  async retirerConsentement(tenantId: string): Promise<void> {
    await this.pool.query(
      `update shopify_boutiques set consentement_par = null, consentement_le = null, maj_le = now() where tenant_id = $1`,
      [tenantId],
    );
  }

  async reglerDelaiPanier(tenantId: string, minutes: number): Promise<void> {
    await this.pool.query(`update shopify_boutiques set delai_panier_minutes = $2, maj_le = now() where tenant_id = $1`, [tenantId, minutes]);
  }

  async noterDernierEvenement(tenantId: string): Promise<void> {
    await this.pool.query(`update shopify_boutiques set dernier_evenement_le = now() where tenant_id = $1`, [tenantId]);
  }

  /**
   * Réserve un événement métier. `nouveau` : à traiter ; `servi` : déjà traité, rien à faire ; `en_cours` : un autre
   * traitement le tient (Shopify réessaiera). Une réservation sans issue depuis plus de `BAIL_EVENEMENT_S` se reprend :
   * le traitement est mort en route, et l'envoi qu'il a pu lancer est protégé par sa clé d'idempotence.
   */
  async reserverEvenement(tenantId: string, cle: string, sujet: string): Promise<Reservation> {
    const pose = await this.pool.query(
      `insert into shopify_evenements (tenant_id, cle, sujet) values ($1, $2, $3) on conflict (tenant_id, cle) do nothing`,
      [tenantId, cle, sujet],
    );
    if ((pose.rowCount ?? 0) > 0) return 'nouveau';
    const repris = await this.pool.query(
      `update shopify_evenements set maj_le = now()
        where tenant_id = $1 and cle = $2 and issue is null and maj_le < now() - make_interval(secs => $3)`,
      [tenantId, cle, BAIL_EVENEMENT_S],
    );
    if ((repris.rowCount ?? 0) > 0) return 'nouveau';
    const r = (await this.pool.query<{ issue: string | null }>(
      `select issue from shopify_evenements where tenant_id = $1 and cle = $2`, [tenantId, cle],
    )).rows[0];
    return r?.issue === null ? 'en_cours' : 'servi';
  }

  async noterIssue(tenantId: string, cle: string, issue: string): Promise<void> {
    await this.pool.query(`update shopify_evenements set issue = $3, maj_le = now() where tenant_id = $1 and cle = $2`, [tenantId, cle, issue]);
  }

  /** Une réservation abandonnée sans effet (panne avant l'envoi) : Shopify réessaiera, la clé doit repartir à zéro. */
  async libererEvenement(tenantId: string, cle: string): Promise<void> {
    await this.pool.query(`delete from shopify_evenements where tenant_id = $1 and cle = $2 and issue is null`, [tenantId, cle]);
  }

  /** Les issues des `jours` derniers jours, par issue : les chiffres de la carte et de `get_shopify_state`. */
  async compteurs(tenantId: string, jours: number): Promise<Record<string, number>> {
    const res = await this.pool.query<{ issue: string; n: string }>(
      `select issue, count(*)::text as n from shopify_evenements
        where tenant_id = $1 and issue is not null and recu_le > now() - make_interval(days => $2)
        group by issue`,
      [tenantId, jours],
    );
    return Object.fromEntries(res.rows.map((r) => [r.issue, Number(r.n)]));
  }

  /** EXCEPTION TRANSVERSE 3 : le balayage, toutes boutiques confondues. */
  async purgerEvenements(jours: number): Promise<number> {
    const res = await this.pool.query(`delete from shopify_evenements where recu_le < now() - make_interval(days => $1)`, [jours]);
    return res.rowCount ?? 0;
  }

  /**
   * Un checkout reçu (lot 2) : le panier se crée ou se complète. 🔴 Un panier FERMÉ ne se rouvre jamais (garde du
   * `where`), et une valeur absente n'efface pas celle d'avant (`coalesce`). Chaque modification repousse l'échéance :
   * un client qui remplit encore son panier ne l'a pas abandonné.
   */
  async noterPanier(tenantId: string, p: { jeton: string; telephone: string | null; nom: string | null; lien: string | null }): Promise<void> {
    await this.pool.query(
      `insert into shopify_paniers (tenant_id, jeton, telephone, nom, lien) values ($1, $2, $3, $4, $5)
       on conflict (tenant_id, jeton) do update set
         telephone = coalesce(excluded.telephone, shopify_paniers.telephone),
         nom = coalesce(excluded.nom, shopify_paniers.nom),
         lien = coalesce(excluded.lien, shopify_paniers.lien),
         maj_le = now()
       where shopify_paniers.ferme_le is null`,
      [tenantId, p.jeton, p.telephone, p.nom, p.lien],
    );
  }

  /**
   * Le panier devient une commande (`orders/create` avec son `checkout_token`, ou un checkout `completed_at`). Aucun
   * ordre entre sujets (mesuré) : la fermeture peut arriver AVANT le panier, elle écrit alors un panier déjà fermé.
   */
  async fermerPanier(tenantId: string, jeton: string): Promise<void> {
    await this.pool.query(
      `insert into shopify_paniers (tenant_id, jeton, ferme_le) values ($1, $2, now())
       on conflict (tenant_id, jeton) do update set ferme_le = coalesce(shopify_paniers.ferme_le, now())`,
      [tenantId, jeton],
    );
  }

  /**
   * 🔴 Ferme un panier DÉJÀ noté, sans en créer : c'est ce que fait une commande quand la relance est éteinte. Sans
   * elle, une relance éteinte puis rallumée relançait le client qui avait commandé pendant la pause (relecture du lot 2).
   */
  async fermerPanierExistant(tenantId: string, jeton: string): Promise<void> {
    await this.pool.query(
      `update shopify_paniers set ferme_le = coalesce(ferme_le, now()) where tenant_id = $1 and jeton = $2`,
      [tenantId, jeton],
    );
  }

  /** Une commande ferme aussi les autres paniers ouverts du même numéro : un achat express passe par un autre checkout. */
  async fermerPaniersDuTelephone(tenantId: string, telephone: string): Promise<void> {
    await this.pool.query(
      `update shopify_paniers set ferme_le = now() where tenant_id = $1 and telephone = $2 and ferme_le is null`,
      [tenantId, telephone],
    );
  }

  /** `customers/redact` d'un client qui n'a pas de fiche : ses paniers en attente partent quand même. */
  async effacerPaniersDuTelephone(tenantId: string, telephone: string): Promise<void> {
    await this.pool.query(`delete from shopify_paniers where tenant_id = $1 and telephone = $2`, [tenantId, telephone]);
  }

  /** Le panier est-il encore ouvert ? Relu juste avant l'envoi : une commande a pu arriver depuis la réclamation. */
  async panierOuvert(tenantId: string, jeton: string): Promise<boolean> {
    const r = (await this.pool.query<{ ouvert: boolean }>(
      `select ferme_le is null as ouvert from shopify_paniers where tenant_id = $1 and jeton = $2`, [tenantId, jeton],
    )).rows[0];
    return r?.ouvert === true;
  }

  /**
   * EXCEPTION TRANSVERSE 4 : le balayage des relances, toutes boutiques confondues. Un panier DÛ : ouvert, jamais relancé,
   * avec un téléphone et un lien, dont la dernière modification a dépassé le délai de SA boutique, connectée, au
   * consentement affirmé, et dont le message `checkout_abandoned` est actif. 🔴 La réclamation POSE `relance_le` dans la
   * même écriture (`for update skip locked`) : deux balayages, de deux copies de l'API, ne relancent jamais le même panier.
   */
  async reclamerPaniersDus(limite: number): Promise<PanierDu[]> {
    const res = await this.pool.query<{
      tenant_id: string; jeton: string; telephone: string; nom: string | null; lien: string; domaine: string;
      modele: string; langue: string; variables: unknown;
    }>(
      `with dus as (
         select p.tenant_id, p.jeton from shopify_paniers p
           join shopify_boutiques b on b.tenant_id = p.tenant_id
           join shopify_messages m on m.tenant_id = p.tenant_id and m.evenement = 'checkout_abandoned'
          where p.ferme_le is null and p.relance_le is null and p.telephone is not null and p.lien is not null
            and b.etat = 'connectee' and b.consentement_le is not null and m.actif
            and p.maj_le < now() - make_interval(mins => b.delai_panier_minutes)
          order by p.maj_le
          limit $1
          for update of p skip locked
       )
       update shopify_paniers p set relance_le = now()
         from dus, shopify_boutiques b, shopify_messages m
        where p.tenant_id = dus.tenant_id and p.jeton = dus.jeton and p.relance_le is null
          and b.tenant_id = p.tenant_id and m.tenant_id = p.tenant_id and m.evenement = 'checkout_abandoned'
       returning p.tenant_id, p.jeton, p.telephone, p.nom, p.lien, b.domaine, m.modele, m.langue, m.variables`,
      [limite],
    );
    return res.rows.map((r) => ({
      tenantId: r.tenant_id, jeton: r.jeton, telephone: r.telephone, nom: r.nom, lien: r.lien, domaine: r.domaine,
      modele: r.modele, langue: r.langue, variables: Array.isArray(r.variables) ? r.variables.filter(estDonneeShopify) : [],
    }));
  }

  async noterIssuePanier(tenantId: string, jeton: string, issue: string): Promise<void> {
    await this.pool.query(`update shopify_paniers set issue = $3 where tenant_id = $1 and jeton = $2`, [tenantId, jeton, issue]);
  }

  /**
   * Les paniers des `jours` derniers jours : relancés (par issue), fermés à temps, en attente. Seuls les paniers NOTÉS
   * comptent (un téléphone) : la ligne qu'écrit une commande arrivée avant son panier n'est pas un panier sauvé.
   */
  async compteursPaniers(tenantId: string, jours: number): Promise<{ relances: Record<string, number>; fermesATemps: number; enAttente: number }> {
    const res = await this.pool.query<{ issue: string | null; ferme: boolean; relance: boolean; n: string }>(
      `select issue, ferme_le is not null as ferme, relance_le is not null as relance, count(*)::text as n
         from shopify_paniers where tenant_id = $1 and telephone is not null and ouvert_le > now() - make_interval(days => $2)
        group by 1, 2, 3`,
      [tenantId, jours],
    );
    const relances: Record<string, number> = {};
    let fermesATemps = 0;
    let enAttente = 0;
    for (const r of res.rows) {
      const n = Number(r.n);
      if (r.relance) relances[r.issue ?? 'en_cours'] = (relances[r.issue ?? 'en_cours'] ?? 0) + n;
      else if (r.ferme) fermesATemps += n;
      else enAttente += n;
    }
    return { relances, fermesATemps, enAttente };
  }

  /** EXCEPTION TRANSVERSE 5 : les paniers de plus de `jours` jours partent, relancés ou non (ils portent un téléphone). */
  async purgerPaniers(jours: number): Promise<number> {
    const res = await this.pool.query(`delete from shopify_paniers where ouvert_le < now() - make_interval(days => $1)`, [jours]);
    return res.rowCount ?? 0;
  }

  /** La fiche écrite pour une commande, pour la retrouver quand Shopify demande d'effacer son client. */
  async lierCommande(tenantId: string, commandeId: string, clientId: string | null, contactId: string): Promise<void> {
    await this.pool.query(
      `insert into shopify_commandes (tenant_id, commande_id, client_id, contact_id) values ($1, $2, $3, $4)
       on conflict (tenant_id, commande_id) do update set client_id = coalesce(excluded.client_id, shopify_commandes.client_id), contact_id = excluded.contact_id`,
      [tenantId, commandeId, clientId, contactId],
    );
  }

  /** Les fiches liées à ces commandes ou à ce client Shopify, dans l'espace. */
  async contactsLies(tenantId: string, commandeIds: readonly string[], clientId: string | null): Promise<string[]> {
    const res = await this.pool.query<{ contact_id: string }>(
      `select distinct contact_id from shopify_commandes
        where tenant_id = $1 and (commande_id = any($2::text[]) or ($3::text is not null and client_id = $3))`,
      [tenantId, commandeIds, clientId],
    );
    return res.rows.map((r) => r.contact_id);
  }
}

/** Tout le branchement d'un espace, dans la transaction de l'appelant. */
async function effacerBranchement(client: PoolClient, tenantId: string): Promise<void> {
  for (const table of ['shopify_messages', 'shopify_paniers', 'shopify_evenements', 'shopify_commandes', 'shopify_boutiques']) {
    await client.query(`delete from ${table} where tenant_id = $1`, [tenantId]);
  }
}
