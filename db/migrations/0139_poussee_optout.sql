-- 0139 : QUEL connecteur prevenir quand quelqu un se desabonne.
--
-- 🔴 CE QU ELLE REND POSSIBLE : rendre un refus OPPOSABLE AILLEURS QUE CHEZ NOUS. Un opt-out qui ne vit que
-- dans notre base laisse le client continuer a ecrire a cette personne depuis ses autres outils (CRM,
-- back-office, routeur e-mail), et c est LUI qui en repond. Cette colonne designe l appel deja mis au point
-- dans Tools > Connecteurs API que l on joue au moment ou le refus est declare.
--
-- 🔴 ELLE DESIGNE UNE REQUETE, PAS UN OUTIL D AGENT, et la nuance decide de tout. Un « outil » est une
-- surface exposee a un MODELE : il porte un nom expose, une description destinee au modele et des parametres
-- que le modele remplit. Ici il n y a aucun modele : la poussee d un opt-out est exactement le cas du bloc
-- « Appel HTTP » d un scenario (`src/workflow/appel-http.ts`), qui DESIGNE une requete de la bibliotheque et
-- n en decrit aucune. Les deux passent donc par `creerAppelConnecteur`, avec les memes sept gardes.
--
-- ⚠️ `on delete set null`, ET LE REFUS LISIBLE EST AILLEURS. La contrainte est la ceinture : sans elle, une
-- requete supprimee laisserait ici un identifiant mort, et l ecran montrerait un branchement qui n existe
-- plus. Le refus explicite (409, « cette requete est branchee sur le consentement ») est porte par la route
-- de suppression, comme pour une source portant des requetes : meme doctrine qu en 0105.
--
-- ⚠️ NULLABLE, ET NULL EST LE DEFAUT DE TOUS LES ESPACES EXISTANTS : personne n est prevenu tant que
-- personne ne l a demande. Un defaut qui enverrait quoi que ce soit a un systeme tiers sans qu on l ait
-- choisi serait exactement l inverse de ce que ce menu existe pour garantir.
--
-- ⚠️ MIGRATION QUI AJOUTE UNE COLONNE ECRITE PAR LE CODE : elle passe AVANT le deploiement. L ancien code y
-- survit sans rien faire (il ne l ecrit pas, il ne la lit pas).

alter table tenant_settings
  add column if not exists optout_request_id uuid references connector_requests(id) on delete set null;

-- Sert la question « quelles requetes sont branchees sur le consentement ? », posee par la route de
-- suppression avant d accepter d effacer une requete. Index PARTIEL : la colonne est nulle sur la quasi
-- totalite des espaces, et un index complet couterait sa taille pour ne servir que quelques lignes.
create index if not exists tenant_settings_optout_request_idx
  on tenant_settings (optout_request_id)
  where optout_request_id is not null;
