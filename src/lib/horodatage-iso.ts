import { z } from 'zod';

/**
 * Un horodatage ISO 8601 AVEC fuseau, les SECONDES FACULTATIVES : « 2026-10-25T09:00Z » comme
 * « 2026-10-25T09:00:00.123+02:00 ». Le point de passage de toute date reçue d'un appelant (API publique, console, MCP).
 *
 * 🔴 zod 4.6 exige les secondes par défaut, là où 4.4 les laissait facultatives (mesuré le 2026-10-24) : une date écrite
 * à la minute par un intégrateur ou par un modèle aurait été refusée du jour au lendemain. L'union rend EXACTEMENT
 * l'ancien domaine, et la valeur reste intacte (aucune réécriture). `tests/horodatage-iso.test.ts` tient les deux.
 */
export const horodatageIso = () =>
  z.union(
    [z.string().datetime({ offset: true }), z.string().datetime({ offset: true, precision: -1 })],
    { error: 'date ISO 8601 attendue, avec son fuseau (ex. 2026-10-25T09:00:00Z)' },
  );
