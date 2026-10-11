import type { VerrousCourts } from '../db/verrous-courts';
import { messageDe } from '../lib/erreur';
import { refus, type Issue } from '../lib/issue';
import { MetaApiError } from '../meta/errors';
import { ErreurPublication, type ContextePublication } from './appliquer-publication';
import {
  planifierPublication, type EtatMeta, type Geste, type OutilAPublier, type RelaisAPublier,
} from './publication';

/** Ce que la route montre avant de publier. */
export interface ApercuPublication {
  gestes: Geste[];
  phoneNumberId: string | null;
}

/** Ce qui a effectivement été appliqué chez Meta. */
export interface PublicationFaite {
  faits: Geste[];
}

/**
 * La façade de publication du catalogue chez Meta. Elle possède tout le cycle : instantané du plan, verrou partagé,
 * contexte d'application et reprise après un échec. La route HTTP ne connaît rien de cette mécanique.
 */
export interface PublicationMba {
  apercevoir(tenantId: string): Promise<Issue<ApercuPublication>>;
  publier(tenantId: string, acteurId: string | null): Promise<Issue<PublicationFaite>>;
}

export interface DepsPublicationMba {
  numeroWhatsapp(tenantId: string): Promise<string | null>;
  /** Le relais tel qu'il se présente à Meta. `null` quand l'adresse publique manque. */
  relais(tenantId: string): Promise<RelaisAPublier | null>;
  outilsExposes(tenantId: string, phoneNumberId: string): Promise<OutilAPublier[]>;
  etatMeta(tenantId: string, phoneNumberId: string): Promise<EtatMeta>;
  appliquer(
    tenantId: string,
    phoneNumberId: string,
    geste: Geste,
    contexte: ContextePublication,
  ): Promise<void>;
  verrous: VerrousCourts;
}

/**
 * Dix minutes, prolongées avant chaque geste. Un appel Meta peut attendre jusqu'au délai d'undici (300 s) : le bail
 * couvre une publication ordinaire et empêche deux copies de l'API de poser puis révoquer leurs clés mutuellement.
 * Limite connue : un geste unique qui dépasserait dix minutes pourrait perdre son verrou pendant l'appel ; la perte
 * ne serait constatée qu'avant le geste suivant. Les appels actuels restent très en dessous de cette durée.
 */
export const BAIL_PUBLICATION_MS = 10 * 60_000;

/** La clé est par espace : un client lent ne bloque pas les publications des autres. */
export function clePublication(tenantId: string): string {
  return `mba-publication:${tenantId}`;
}

const SANS_ADRESSE = 'L’adresse publique de l’API n’est pas réglée : l’agent de Meta ne saurait pas où appeler.';
const SANS_NUMERO = 'Aucun numéro WhatsApp connecté : il n’y a pas d’agent Meta où publier.';

export function creerPublicationMba(deps: DepsPublicationMba): PublicationMba {
  /** Le plan et l'instantané des outils qui a servi à le calculer. */
  async function planifier(
    tenantId: string,
    phoneNumberId: string,
  ): Promise<{ gestes: Geste[]; outils: OutilAPublier[] } | null> {
    const relais = await deps.relais(tenantId);
    if (relais === null) return null;
    const [outils, meta] = await Promise.all([
      deps.outilsExposes(tenantId, phoneNumberId),
      deps.etatMeta(tenantId, phoneNumberId),
    ]);
    return { gestes: planifierPublication(relais, outils, meta), outils };
  }

  return {
    async apercevoir(tenantId) {
      const phoneNumberId = await deps.numeroWhatsapp(tenantId);
      if (!phoneNumberId) {
        return { ok: true, valeur: { gestes: [], phoneNumberId: null } };
      }
      const plan = await planifier(tenantId, phoneNumberId);
      if (plan === null) return refus(409, SANS_ADRESSE);
      return { ok: true, valeur: { gestes: plan.gestes, phoneNumberId } };
    },

    async publier(tenantId, acteurId) {
      const phoneNumberId = await deps.numeroWhatsapp(tenantId);
      if (!phoneNumberId) return refus(409, SANS_NUMERO);

      const prise = await deps.verrous.prendre([[clePublication(tenantId), BAIL_PUBLICATION_MS]]);
      if (prise === null) {
        return refus(409, 'Une publication est déjà en cours pour cet espace : attendez qu’elle se termine.');
      }

      try {
        // Meta a pu changer entre l'aperçu et le clic : le plan se recalcule sous le verrou, juste avant d'écrire.
        const plan = await planifier(tenantId, phoneNumberId);
        if (plan === null) return refus(409, SANS_ADRESSE);

        const faits: Geste[] = [];
        const contexte: ContextePublication = { acteurId, outils: plan.outils };
        for (const geste of plan.gestes) {
          /**
           * Prolonger prouve aussi que cette publication tient encore SA prise. Une erreur de lecture vaut perte du
           * verrou : continuer pourrait entrelacer les écritures de deux copies de l'API.
           */
          const tenu = await deps.verrous.prolonger(prise, BAIL_PUBLICATION_MS).catch((err: unknown) => {
            // eslint-disable-next-line no-console
            console.error(`mba-publication: verrou illisible avant « ${geste.nom} » (${tenantId}):`, messageDe(err));
            return false;
          });
          if (!tenu) {
            return refus(
              409,
              `La publication a perdu son verrou avant « ${geste.nom} » (une autre publication a pu démarrer). ${faits.length} geste(s) déjà appliqué(s), le reste n’a pas été tenté. Relancez : ce qui a réussi ne sera pas refait.`,
              { faits },
            );
          }

          try {
            await deps.appliquer(tenantId, phoneNumberId, geste, contexte);
            faits.push(geste);
          } catch (err) {
            // eslint-disable-next-line no-console
            console.error(`mba-publication: ${geste.type} « ${geste.nom} » a échoué (${tenantId}):`, messageDe(err));
            const cause = err instanceof ErreurPublication
              ? `« ${geste.nom} » : ${err.message}.`
              : err instanceof MetaApiError
                ? `Meta a refusé « ${geste.nom} » (${geste.type}).`
                : `« ${geste.nom} » (${geste.type}) n’a pas abouti (Meta injoignable, ou panne de notre côté).`;
            return refus(
              409,
              `${cause} ${faits.length} geste(s) déjà appliqué(s), le reste n’a pas été tenté. Relancez : ce qui a réussi ne sera pas refait.`,
              { faits },
            );
          }
        }
        return { ok: true, valeur: { faits } };
      } finally {
        // Un relâchement raté laisse seulement le verrou vivre jusqu'à la fin de son bail.
        await deps.verrous.relacher(prise).catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.error(`mba-publication: verrou non relâché (${tenantId}):`, messageDe(err));
        });
      }
    },
  };
}
