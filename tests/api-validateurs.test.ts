// tests/api-validateurs.test.ts
import { describe, it, expect } from 'vitest';
import { schemaClesFiche } from '../src/api/fiche';
import {
  schemaCorpsContact, schemaCorpsLot, schemaCorpsRecherche, schemaCorpsModification, MAX_BATCH,
} from '../src/http/v1-contacts';
import {
  schemaCorpsEnvoi, schemaDestinataireEnvoi, lireCible, MAX_RECIPIENTS, MAX_SKIPPED_REPORT, type RapportEnvoi,
} from '../src/http/v1-sends';
import { schemaMessageWhatsapp } from '../src/http/v1-messages';
import { schemaMessageRcs } from '../src/http/v1-messages-rcs';

/**
 * LES VALIDATEURS DES CORPS /v1 SONT NOMMÉS ET EXPORTÉS.
 *
 * 🔴 ILS EXISTENT POUR ÊTRE INTERROGÉS DE L'EXTÉRIEUR : `tests/api-exemples.test.ts` leur soumet chaque
 * exemple de la page Documentation API. Une route qui validerait par un schéma anonyme, écrit dans son
 * handler, rendrait ce contrôle impossible, et la page pourrait de nouveau décrire un corps que le serveur
 * refuse (elle l'a fait : `optIn`, des destinataires en chaînes, `/v1/messages` sans accents).
 *
 * ⚠️ Le typage est volontairement LARGE (un `safeParse` qui rend `success`) : ce fichier vérifie qu'ils
 * existent et qu'ils refusent quelque chose, pas ce qu'ils acceptent. Ce qu'ils acceptent, ce sont les
 * exemples de la documentation qui le prouvent.
 */
const SCHEMAS: Record<string, { safeParse(v: unknown): { success: boolean } }> = {
  schemaClesFiche,
  schemaCorpsContact,
  schemaCorpsLot,
  schemaCorpsRecherche,
  schemaCorpsModification,
  schemaCorpsEnvoi,
  schemaDestinataireEnvoi,
  schemaMessageWhatsapp,
  schemaMessageRcs,
};

describe('les validateurs des corps de l’API publique', () => {
  it.each(Object.entries(SCHEMAS))('%s est un schéma zod', (_nom, schema) => {
    expect(typeof schema.safeParse).toBe('function');
  });

  it('🔴 aucun n’accepte n’importe quoi : une chaîne nue est refusée partout', () => {
    // La garde de la garde : un `z.unknown()` passerait tous les exemples et ne prouverait rien.
    for (const [nom, schema] of Object.entries(SCHEMAS)) {
      expect(schema.safeParse('texte').success, nom).toBe(false);
    }
  });

  it('les règles de cible de l’envoi sont une fonction exportée', () => {
    expect(typeof lireCible).toBe('function');
  });

  it('le rapport de POST /v1/sends est un type exporté (tenu au typage)', () => {
    const rapport: RapportEnvoi | null = null;
    expect(rapport).toBeNull();
  });

  it('les bornes de lot sont des entiers positifs', () => {
    for (const n of [MAX_BATCH, MAX_RECIPIENTS, MAX_SKIPPED_REPORT]) {
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThan(0);
    }
  });
});
