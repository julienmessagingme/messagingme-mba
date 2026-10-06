/**
 * LE CRÉDIT OFFERT À LA CONNEXION DU PREMIER NUMÉRO, pour les tests qui relient un numéro sans parler d'argent
 * (2026-09-29).
 *
 * `PgEmbeddedSignupStore` exige le montant offert : une dépendance optionnelle retomberait sur « rien d'offert » sans
 * rien signaler, et un câblage de production qui l'oublierait relierait des numéros sans jamais rien offrir. Les
 * tests qui s'en moquent passent `SANS_CREDIT_OFFERT`, ce qui DIT leur hypothèse.
 *
 * ⚠️ Il vit ici et jamais dans `src/` : il y serait importable par le câblage de production, et éteindrait le
 * crédit offert de tous les nouveaux espaces.
 */
export const SANS_CREDIT_OFFERT = { creditOffertMicroEur: 0, creditOffertClaudeCodeMicroEur: 0 } as const;
