/**
 * LE CRÉDIT OFFERT À L'OUVERTURE, pour les tests qui créent un espace sans parler d'argent (2026-09-28).
 *
 * `PgUserStore` exige le montant offert : une dépendance optionnelle retomberait sur « rien d'offert » sans rien
 * signaler, et un câblage de production qui l'oublierait créerait des espaces sans leur crédit. Les tests qui s'en
 * moquent passent `SANS_CREDIT_OFFERT`, ce qui DIT leur hypothèse.
 *
 * ⚠️ Il vit ici et jamais dans `src/` : il y serait importable par le câblage de production, et éteindrait le
 * crédit offert de tous les nouveaux espaces.
 */
export const SANS_CREDIT_OFFERT = { creditOffertMicroEur: 0 } as const;
