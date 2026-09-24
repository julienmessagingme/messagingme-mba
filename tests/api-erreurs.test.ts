import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { STATUT_PAR_CODE, refuser } from '../src/api/erreurs';

/**
 * LE VOCABULAIRE D'ERREUR DE L'API PUBLIQUE (spec du 2026-09-24, § 9).
 *
 * 🔴 UN MÊME REFUS PORTE LE MÊME CODE PARTOUT, qu'il sorte en erreur d'une route ou en motif d'écart d'un
 * envoi. C'est la TABLE qui le garantit, pas la mémoire de celui qui écrit la route suivante.
 */
describe('les codes d’erreur de l’API publique', () => {
  it('🔴 la table est celle du § 9, code par code ET statut par statut ; `duplicate` et `missing_variable` ne sont que des motifs d’écart', () => {
    // Recopiée du tableau du § 9 : un statut changé dans la table deviendrait un mauvais statut sur le fil
    // pour qui relaie le code d'un service (`STATUT_PAR_CODE[code] ?? 400`), sans qu'aucune route ne le montre.
    expect(STATUT_PAR_CODE).toEqual({
      invalid_body: 400, invalid_recipient: 400, invalid_phone: 400,
      unauthorized: 401, missing_scope: 403, tenant_locked: 403,
      unknown_contact: 404, duplicate: null, identity_conflict: 409, blocked_contact: 409, opted_out: 409, no_consent: 409,
      window_closed: 422, missing_variable: null, no_phone: 422, rcs_unreachable: 422,
      rcs_not_enabled: 409, no_whatsapp_number: 409,
      scenario_not_found: 404, node_not_found: 404, template_not_found: 404, rcs_message_not_found: 404, send_not_found: 404,
      scenario_ambiguous: 409, unsendable_target: 422, template_category_unknown: 422,
      idempotency_key_required: 400, idempotency_in_progress: 409, idempotency_key_reused: 422,
      rate_limited: 429,
    });
  });

  it('chaque code est un identifiant anglais en snake_case : il est lu par des programmes', () => {
    for (const code of Object.keys(STATUT_PAR_CODE)) expect(code).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it('🔴 `refuser` rend `{ error, code }` avec le statut demandé', async () => {
    const app = Fastify();
    app.get('/x', async (_req, reply) => refuser(reply, 409, 'identity_conflict', 'deux fiches différentes'));
    const res = await app.inject({ method: 'GET', url: '/x' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'deux fiches différentes', code: 'identity_conflict' });
    await app.close();
  });
});
