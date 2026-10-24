import {
  enfilerPremierMessage, type DemandePremierMessage, type DepsPremierMessage, type PremierMessage, type ResultatPremier,
} from '../../src/application/premier-message';
import type { StatutCompte } from '../../src/application/comptes';
import type { ContactEnvoi } from '../../src/campaign/build';
import type { ResolutionFiche } from '../../src/api/fiche';

/**
 * LA VRAIE PORTE « ÉCRIRE EN PREMIER », SUR DES FAUX (plan 2026-10-23, tâches 3 et 4) : les portes de réponse et l'API
 * publique y passent, et ce qu'elles lui demandent (origine, clé, consentement) n'a de sens que jugé par elle. `enfilerPremierMessage` est celle de la production ; seuls ses dépôts sont en mémoire. Chaque geste est noté.
 * Les tests de la porte elle-même : `tests/application-premier-message.test.ts`.
 */
export const FICHE_PORTE = 'cccccccc-0000-4000-8000-0000000000f1';
const COMPTE = 'aaaaaaaa-0000-4000-8000-0000000000f1';
/** L'heure de la porte : son créneau tombe 30 s après, à 12:00 heure de Paris. */
export const MAINTENANT_PORTE = new Date('2026-10-23T09:59:30Z');

export interface ReglagesPorte {
  filiere?: 'api' | 'application';
  statut?: StatutCompte;
  /** Le consentement de la fiche avant l'appel, tel que la porte le lit (`listContactsPourEnvoiApi`). */
  optIn?: ContactEnvoi['optInStatus'];
  desabonne?: boolean;
  quotaOk?: boolean;
  fiche?: ResolutionFiche;
}

export function porteEnMemoire(r: ReglagesPorte = {}) {
  const demandes: DemandePremierMessage[] = [];
  const gestes: string[] = [];
  const lignes: PremierMessage[] = [];
  const optIn: ContactEnvoi['optInStatus'] = r.optIn ?? 'unknown';
  const deps: DepsPremierMessage = {
    premiers: {
      existant: async (t, cle) => lignes.find((l) => l.tenantId === t && l.cle === cle) ?? null,
      inserer: async (m, aleatoire) => {
        const deja = lignes.find((l) => l.tenantId === m.tenantId && l.cle === m.cle);
        if (deja) return { ligne: deja, cree: false };
        const ligne: PremierMessage = {
          ...m, id: `00000000-0000-4000-8000-${String(lignes.length + 1).padStart(12, '0')}`, statut: 'en_file', issue: null,
          prevuLe: new Date(MAINTENANT_PORTE.getTime() + 30_000 + aleatoire * 30_000), essais: 0, messageId: null,
        };
        lignes.push(ligne);
        return { ligne, cree: true };
      },
      geleJusqua: async () => null,
    },
    comptes: {
      filiereDe: async () => r.filiere ?? 'application',
      parEspace: async (tenantId) => ({
        id: COMPTE, tenantId, numero: '447700900000', jid: null, statut: r.statut ?? 'relie', fourniId: null,
        relieLe: new Date('2026-10-01T10:00:00Z'), dernierMessageLe: null, statutChangeLe: new Date(0),
      }),
    },
    fiches: {
      resoudreFiche: async (_t, cles, o) => {
        gestes.push(`fiche:${cles.phone}:${o.creer}`);
        return r.fiche ?? { ok: true, contactId: FICHE_PORTE, cree: false };
      },
      listContactsPourEnvoiApi: async (_t, ids) => ids.map((id) => ({ id, phone_e164: '+33612345678', optInStatus: optIn, bloque: false, rcsDesabonne: false })),
    },
    contacts: {
      estDesabonneParWaId: async () => r.desabonne === true,
      machineSeTaitParWaId: async () => r.desabonne === true,
    },
    quota: { consommer: async () => { gestes.push('quota'); return r.quotaOk === false ? { ok: false, max: 1000 } : { ok: true }; } },
    enfiler: async (_t, id) => { gestes.push(`file:${id}`); },
    maintenant: () => MAINTENANT_PORTE,
    aleatoire: () => 0,
  };
  const ecrirePremier = async (d: DemandePremierMessage): Promise<ResultatPremier> => {
    demandes.push(d);
    return enfilerPremierMessage(deps, d);
  };
  return { ecrirePremier, demandes, gestes, lignes };
}
