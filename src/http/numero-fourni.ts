import type { FastifyInstance } from 'fastify';
import { gardeEtendue, type Guard, type PreHandler } from '../auth/middleware';
import type { VerrousCourts } from '../db/verrous-courts';
import { espaceVerifie } from './scope';
import { texteDe } from '../lib/erreur';
import { journaliser } from '../lib/journal';
import type { PgNumerosFournisStore } from '../otp/store.pg';
import { lireEtatConnexion, empreinteEtat } from '../otp/etat-connexion';
import { z } from 'zod';
import type { PgAbonnementsNumeroStore } from '../stripe/abonnements.pg';
import type { RetourAbonnement } from '../stripe/abonnement';
import { corpsDuRefus, type Issue } from '../lib/issue';

/**
 * LE NUMÉRO FOURNI CÔTÉ CLIENT (lot 3b, spec `docs/superpowers/specs/2026-10-05-numero-fourni-design.md`).
 *
 * La page « Connecter WhatsApp » obtient un numéro de notre réserve DIDWW et l'affiche ; le client le tape dans la
 * fenêtre de Meta, par appel si Meta laisse choisir, sinon par SMS, que la ligne fixe lit à voix haute ; notre
 * Asterisk capte le code dans les deux cas (lot 3a, `src/otp/extraire-code.ts`) ; la page le lit ici et
 * l'affiche, et le client le recopie. Aucune de ces routes ne parle à Meta : c'est la fenêtre qui vérifie, puis la
 * route actuelle de l'inscription qui relie et active le numéro. En Embedded Signup v4, rien ne fait sauter l'écran du
 * numéro (mesuré le 2026-10-06), d'où ce parcours.
 *
 * Toutes les lectures et écritures sont filtrées sur l'espace (`espaceVerifie`), admin seulement : obtenir un numéro
 * engage notre réserve, et le code donne la main sur un numéro. Une seule exception, délibérée : un numéro rendu va
 * d'office à l'abonné qui attend le sien (la réserve est à nous, comme dans /ops).
 */
export interface NumeroFourniRouteDeps {
  numeros: Pick<PgNumerosFournisStore, 'attribuer' | 'numeroDeLEspace' | 'codeDeLEspace' | 'remplacerNumero' | 'rendre' | 'compterLibres'>;
  /**
   * Le numéro WhatsApp connecté à l'espace, en chiffres (`''` si son affichage est inconnu), `null` s'il n'en a pas.
   * 🔴 Un espace qui a déjà un numéro n'en reçoit pas d'autre (un seul numéro par espace), et le numéro fourni ne
   * retourne pas à la réserve s'il EST celui qui est connecté ; un espace qui a connecté le sien le rend, lui.
   */
  numeroConnecte(tenantId: string): Promise<{ chiffres: string; aActiver: boolean } | null>;
  /** Un remplacement par heure et par espace : « En obtenir un autre » ne vide pas la réserve partagée. */
  verrous: Pick<VerrousCourts, 'prendre'>;
  /** Prévenir Julien. Ne lèvent jamais (le câblage borne leur fréquence). */
  alertes: {
    /** La réserve est passée sous le seuil, ou vide (`libres` = 0). */
    reserveBasse(libres: number): Promise<void>;
    /** Meta a refusé ce numéro (déjà actif ailleurs) : il est sorti de la réserve, à résilier ou à garder. */
    numeroBloque(numero: string, tenantId: string): Promise<void>;
  };
  /** Sous ce nombre de numéros libres, Julien est prévenu (`ALERTE_RESERVE_SEUIL`). */
  seuilReserve: number;
  /**
   * L'abonnement du numéro (lot 3c, livraison B, migration 0214). 🔴 Un numéro ne s'attribue plus sans abonnement vivant
   * (`actif` ou `en_retard`) : il se paie d'abord, et le webhook l'attribue à la confirmation.
   */
  abonnements: Pick<PgAbonnementsNumeroStore, 'deLEspace' | 'enAttenteDeNumero'>;
  /**
   * Ouvrir le paiement de l'abonnement (`ouvrirAbonnement`) et le portail client de Stripe (`ouvrirPortail`,
   * `src/stripe/abonnement.ts`) : une adresse, ou un refus.
   */
  abonnement: {
    ouvrir(tenantId: string, retour: RetourAbonnement, payeur: string): Promise<Issue<{ url: string }>>;
    portail(tenantId: string, payeur: string): Promise<Issue<{ url: string }>>;
  };
}

const saisieAbonnement = z.object({ retour: z.enum(['brancher', 'console']) });

/** Un abonnement vivant : payé, ou en retard d'un renouvellement (rien n'est coupé avant le lot 4). */
const vivant = (a: { statut: string } | null): boolean => a !== null && a.statut !== 'resilie';

/** Le délai entre deux remplacements d'un même espace. Un numéro remplacé sort de la réserve pour de bon (`bloque`). */
export const DELAI_ENTRE_REMPLACEMENTS_MS = 3_600_000;

/**
 * Les alertes de la réserve, avec leur fréquence : un message par jour au plus pour « basse », et une clé À PART pour
 * « vide », sans quoi l'alerte basse de la veille ferait taire celle qui compte. Le verrou court n'est jamais relâché
 * après un envoi réussi : son échéance EST le silence, commun à toutes les copies de l'API. Un envoi RATÉ (`false`,
 * Telegram ne lève jamais) le relâche, pour que la prochaine attribution réessaie.
 */
export function creerAlertesReserve(o: {
  verrous: Pick<VerrousCourts, 'prendre' | 'relacher'>;
  envoyer(texte: string): Promise<boolean>;
}): NumeroFourniRouteDeps['alertes'] {
  return {
    reserveBasse: async (libres) => {
      const cle = libres === 0 ? 'numeros.reserve-vide' : 'numeros.reserve-basse';
      const prise = await o.verrous.prendre([[cle, 24 * 3_600_000]]);
      if (!prise) return;
      const texte = libres === 0
        ? 'Réserve de numéros fournis vide : plus aucun client ne peut en obtenir. Achète des numéros chez DIDWW, puis déclare-les dans /ops.'
        : `Réserve de numéros fournis basse : ${libres} libre(s). Achète des numéros chez DIDWW, puis déclare-les dans /ops.`;
      if (!(await o.envoyer(texte))) await o.verrous.relacher(prise);
    },
    numeroBloque: async (numero, tenant) => {
      await o.envoyer(`Numéro fourni refusé par Meta et bloqué : +${numero} (espace ${tenant}). À résilier chez DIDWW, ou à garder.`);
    },
  };
}

const RESERVE_VIDE = {
  error: 'Plus aucun numéro disponible pour le moment. Nous en ajoutons ; réessayez un peu plus tard.',
  cause: 'reserve_vide',
} as const;

/** `+` devant les chiffres : c'est la forme que le client tape dans la fenêtre de Meta. */
const affiche = (numero: string) => `+${numero}`;

export function registerNumeroFourni(
  app: FastifyInstance,
  deps: NumeroFourniRouteDeps,
  /** `adminOuLien` : la session d'admin, ou le lien que donne Claude Code (lot 3c). */
  garde: Guard,
  /** La session d'admin SEULE : le portail de Stripe (carte, factures, résiliation) n'est pas une étape de la connexion. */
  gardeAdmin: Guard,
  limiteCouteuse?: PreHandler,
): void {
  const opts = { preHandler: garde };
  // Les trois gestes engagent la réserve partagée : la limite coûteuse, comme l'inscription.
  const couteux = gardeEtendue(garde, limiteCouteuse);

  /**
   * Les numéros libres que personne n'attend (jaune 7 de la relecture de la livraison B) : un abonné en attente a payé,
   * les libres lui sont dus d'abord. Ouvrir un paiement neuf sur un numéro déjà dû ferait payer pour rien.
   */
  const disponibles = async (): Promise<number> => {
    const [libres, attente] = await Promise.all([deps.numeros.compterLibres(), deps.abonnements.enAttenteDeNumero()]);
    return Math.max(0, libres - attente.length);
  };

  /** La réserve après une attribution : sous le seuil, Julien est prévenu. Jamais bloquant pour le client. */
  const surveillerReserve = async (): Promise<void> => {
    try {
      const libres = await disponibles();
      if (libres < deps.seuilReserve) await deps.alertes.reserveBasse(libres);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`numero-fourni : la réserve n'a pas pu être comptée : ${texteDe(err)}`);
    }
  };

  app.post('/tenants/:tenantId/numero-fourni', couteux, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (await deps.numeroConnecte(tenant)) {
      return reply.code(409).send({ error: 'Cet espace a déjà un numéro WhatsApp.', cause: 'deja_un_numero' });
    }
    // 🔴 Pas de numéro avant le paiement (lot 3c) : un numéro déjà attribué se rend toujours (un retour sur la page,
    // l'essai du 3b), un nouveau exige un abonnement vivant. Le webhook attribue d'ordinaire à la confirmation.
    if (!(await deps.numeros.numeroDeLEspace(tenant)) && !vivant(await deps.abonnements.deLEspace(tenant))) {
      return reply.code(409).send({ error: 'Le numéro se paie d’abord : 3,50 € HT par mois.', cause: 'abonnement_requis' });
    }
    const n = await deps.numeros.attribuer(tenant);
    await surveillerReserve();
    if (!n) return reply.code(409).send(RESERVE_VIDE);
    return reply.code(200).send({ numero: affiche(n.numero) });
  });

  /**
   * Ouvrir le paiement de l'abonnement du numéro (lot 3c, livraison B). Rien n'est ouvert chez Stripe quand l'espace a
   * déjà un numéro, déjà un abonnement vivant, ou quand la réserve est vide : il paierait pour un numéro qu'on ne peut
   * pas lui donner. Le payeur est l'utilisateur de la session ou du lien, jamais une valeur du corps.
   */
  app.post('/tenants/:tenantId/numero-fourni/abonnement', couteux, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const lu = saisieAbonnement.safeParse(req.body ?? {});
    if (!lu.success) return reply.code(400).send({ error: 'retour : « brancher » ou « console »' });
    const [connecte, fourni, abonnement] = await Promise.all([
      deps.numeroConnecte(tenant), deps.numeros.numeroDeLEspace(tenant), deps.abonnements.deLEspace(tenant),
    ]);
    // Lot 4 : le numéro connecté EST le numéro fourni de l'espace, son abonnement est fini : c'est un réabonnement du
    // MÊME numéro, que le paiement rend sans refaire la fenêtre de Meta. Un numéro apporté reste refusé.
    const memeNumero = connecte !== null && fourni !== null && connecte.chiffres === fourni.numero;
    if (connecte && !memeNumero) {
      return reply.code(409).send({ error: 'Cet espace a déjà un numéro WhatsApp.', cause: 'deja_un_numero' });
    }
    if (vivant(abonnement)) {
      return reply.code(409).send({ error: 'Le numéro de cet espace est déjà payé.', cause: 'deja_abonne' });
    }
    // Un numéro déjà attribué ne prend rien à la réserve : seul un numéro neuf la regarde.
    if (fourni === null && (await disponibles()) === 0) {
      await surveillerReserve();
      return reply.code(409).send(RESERVE_VIDE);
    }
    const r = await deps.abonnement.ouvrir(tenant, lu.data.retour, req.auth?.userId ?? '');
    return r.ok ? reply.code(200).send(r.valeur) : reply.code(r.statut).send(corpsDuRefus(r));
  });

  /**
   * Le portail client de Stripe (jaune 1 de la relecture de la livraison B) : changer de carte, lire les factures,
   * résilier, depuis la console. La session d'admin seule : le lien de Claude Code n'ouvre que la connexion du numéro,
   * et Claude a son outil (`manage_number_subscription`). Il appelle Stripe : la limite coûteuse.
   */
  app.post('/tenants/:tenantId/numero-fourni/portail', gardeEtendue(gardeAdmin, limiteCouteuse), async (req, reply) => {
    const r = await deps.abonnement.portail(espaceVerifie(req), req.auth?.userId ?? '');
    return r.ok ? reply.code(200).send(r.valeur) : reply.code(r.statut).send(corpsDuRefus(r));
  });

  // Interrogée toutes les 3 secondes par la page pendant que la fenêtre de Meta est ouverte : lecture seule, hors
  // plafond coûteux. Le code, jamais la transcription.
  app.get('/tenants/:tenantId/numero-fourni', opts, async (req, reply) => {
    const tenant = espaceVerifie(req);
    const n = await deps.numeros.numeroDeLEspace(tenant);
    if (!n) return reply.code(200).send({ numero: null, code: null, codeRecuLe: null });
    const c = await deps.numeros.codeDeLEspace(tenant);
    return reply.code(200).send({ numero: affiche(n.numero), code: c?.code ?? null, codeRecuLe: c ? c.recuLe.toISOString() : null });
  });

  // Où en est la connexion du numéro (lot 3c) : la page `/brancher` la relit, et l'outil d'attente de Claude Code lit la
  // MÊME chose (`lireEtatConnexion`). Lecture seule, hors plafond coûteux.
  app.get('/tenants/:tenantId/connexion-numero', opts, async (req, reply) => {
    const etat = await lireEtatConnexion(deps, espaceVerifie(req));
    return reply.code(200).send({ etat, empreinte: empreinteEtat(etat) });
  });

  app.post('/tenants/:tenantId/numero-fourni/remplacer', couteux, async (req, reply) => {
    const tenant = espaceVerifie(req);
    if (await deps.numeroConnecte(tenant)) {
      return reply.code(409).send({ error: 'Le numéro de cet espace est déjà connecté.', cause: 'deja_un_numero' });
    }
    // 🔴 La même garde que l'attribution (relecture de la livraison B) : « Remplacer » attribue un numéro neuf, donc un
    // espace sans numéro attribué ni abonnement vivant n'en reçoit pas ; sinon le numéro se prendrait sans payer.
    if (!(await deps.numeros.numeroDeLEspace(tenant)) && !vivant(await deps.abonnements.deLEspace(tenant))) {
      return reply.code(409).send({ error: 'Le numéro se paie d’abord : 3,50 € HT par mois.', cause: 'abonnement_requis' });
    }
    // Le verrou n'est jamais relâché : son échéance EST le délai, commun à toutes les copies de l'API.
    if (!(await deps.verrous.prendre([[`numeros.remplacer:${tenant}`, DELAI_ENTRE_REMPLACEMENTS_MS]]))) {
      return reply.code(429).send({ error: 'Un seul remplacement de numéro par heure. Si Meta refuse encore ce numéro, contactez-nous.', cause: 'trop_de_remplacements' });
    }
    const r = await deps.numeros.remplacerNumero(tenant);
    if (r.bloque) {
      try {
        await deps.alertes.numeroBloque(r.bloque, tenant);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`numero-fourni : alerte du numéro bloqué non partie : ${texteDe(err)}`);
      }
    }
    await surveillerReserve();
    if (!r.nouveau) return reply.code(409).send(RESERVE_VIDE);
    return reply.code(200).send({ numero: affiche(r.nouveau.numero) });
  });

  app.post('/tenants/:tenantId/numero-fourni/abandonner', couteux, async (req, reply) => {
    const tenant = espaceVerifie(req);
    // Refusé seulement si le numéro connecté EST le numéro fourni : un espace qui a connecté le sien rend celui-ci.
    const [connecte, fourni] = await Promise.all([deps.numeroConnecte(tenant), deps.numeros.numeroDeLEspace(tenant)]);
    if (connecte && fourni && (connecte.chiffres === '' || connecte.chiffres === fourni.numero)) {
      return reply.code(409).send({ error: 'Le numéro de cet espace est déjà connecté.', cause: 'deja_un_numero' });
    }
    const rendu = await deps.numeros.rendre(tenant);
    if (rendu !== null) await servirUnAbonneEnAttente(tenant);
    return reply.code(200).send({ rendu: rendu !== null });
  });

  /**
   * Un numéro rendu va d'abord à l'abonné qui attend le sien depuis le plus longtemps (jaune 7 de la relecture de la
   * livraison B), comme une déclaration dans /ops, et jamais à l'espace qui vient de le rendre. Un échec ne change pas
   * la réponse : le numéro est rendu, et /ops servira l'abonné à la prochaine déclaration.
   */
  async function servirUnAbonneEnAttente(sauf: string): Promise<void> {
    try {
      const suivant = (await deps.abonnements.enAttenteDeNumero()).find((t) => t !== sauf);
      if (suivant === undefined) return;
      const n = await deps.numeros.attribuer(suivant);
      journaliser('warn', 'numero_rendu_attribue_a_un_abonne', { tenantId: suivant, numero: n?.numero ?? null, renduPar: sauf });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`numero-fourni : le numéro rendu n'a pas pu servir l'abonné en attente : ${texteDe(err)}`);
    }
  }
}
