-- Tester un scénario depuis son propre téléphone (Lot F).
--
-- `test_token` : mot pré-rempli dans un lien wa.me / QR (« test-a7k2m9p3 »). STABLE par scénario : le lien et
-- le QR restent valables, on ne régénère pas à chaque essai. Nullable = aucun lien de test encore demandé.
-- Unique GLOBALEMENT (et non par tenant) : la résolution se fait sur le seul texte reçu, avant de savoir à
-- quel scénario il appartient, donc deux tenants ne doivent jamais partager un jeton.
alter table workflows add column if not exists test_token text;
create unique index if not exists workflows_test_token_key on workflows (test_token) where test_token is not null;

-- `is_test` : ce fil vient d'un test interne, pas d'un vrai client. Posé quand un run de test démarre, et
-- JAMAIS remis à false (une conversation née d'un test le reste : les messages du test y sont pour toujours).
-- Sert à exclure ces conversations de l'analyse (donc, par construction, du push HubSpot) et des statistiques,
-- pour qu'un essai ne ressemble pas à un lead dans le tableau de bord.
alter table conversations add column if not exists is_test boolean not null default false;
