-- 0169_pub_connexion_noms.sql : le NOM du compte publicitaire et celui de la Page, gardés au choix.
-- Spec : docs/superpowers/specs/2026-09-22-pubs-ctwa-design.md (§ 3.1, § 3.7).
--
-- AVANT le déploiement : le code neuf écrit ces deux colonnes, l'ancien les ignore, il y survit.
--
-- 🔴 POURQUOI GARDER UN NOM QUE META POURRAIT REDONNER. L'écran n'affichait que des identifiants
-- (« 2084133708982860 »), demandés par Julien le 2026-09-23 : « je veux voir des noms, pas que des
-- numéros ». Les noms arrivent dans la liste des actifs, mais cette liste n'est lue qu'au MOMENT DU CHOIX :
-- la relire à chaque affichage coûterait deux appels à Meta pour ouvrir une page, sur le chemin d'un écran
-- que plusieurs personnes ouvrent, et rendrait l'écran dépendant de la disponibilité de Meta pour afficher
-- ce qu'il sait déjà.
--
-- ⚠️ CE QUE CE CHOIX COÛTE, ET IL FAUT LE SAVOIR : un nom renommé chez Meta ne bouge PAS ici tant qu'on ne
-- reconnecte pas. C'est un libellé d'affichage, jamais une clé : tout ce qui désigne un actif passe par son
-- identifiant, et le nom n'entre dans aucune requête ni dans aucun appel.
--
-- ⚠️ NULLABLES, et `null` est un cas normal : Meta ne donne pas toujours de nom, et les connexions faites
-- avant cette migration n'en portent aucun. L'écran retombe alors sur l'identifiant, comme avant.

alter table pub_connexion add column if not exists compte_nom text;
alter table pub_connexion add column if not exists page_nom   text;

-- AUCUN index : ces colonnes ne servent qu'à l'affichage d'une ligne déjà trouvée par sa clé primaire.
