-- 0116_lien_chaine_phrase.sql : la PHRASE d'un lien de chaine devient sa cle de routage.
--
-- Julien, le 2026-09-07 : « le token rattache au message qui est embedde dans le bouton c'est un peu too
-- much... on garde juste le message ». Le texte envoye par l'abonne passe de `phrase (cm-ab12cd34)` a
-- `phrase`, et c'est desormais la phrase qui declenche le scenario.
--
-- 🔴 CE QUI REND CETTE BASCULE POSSIBLE SANS RIEN CASSER. Un post DEJA PUBLIE ne peut plus etre modifie, et
-- il envoie `phrase (cm-xxxx)`. Le mode de comparaison de l'automation compagnon est `contains` : ce texte
-- CONTIENT la phrase, donc son bouton continue de declencher apres la bascule. En mode `equals`, tous les
-- posts en circulation seraient morts sans aucun recours.
--
-- ⚠️ PAS `CONCURRENTLY` ici, contrairement a la 0115, et la difference est le sujet : la 0115 indexait
-- `workflow_runs`, sur le chemin chaud des messages entrants, ou un verrou d'ecriture se paie. Celle-ci
-- touche `channelsme_links` (quelques lignes par espace) et `automations`. Une migration transactionnelle a
-- un FILET, ce qui vaut mieux quand elle contient une mise a jour de donnees.

-- 1. L'unicite de la phrase, par espace.
--
-- 🔴 Deux liens de meme phrase, c'est deux automations qui matchent un seul message : deux scenarios
-- demarres, dont un tue l'autre depuis le lot « le declencheur gagne ». L'abonne verrait un parcours
-- commencer puis disparaitre. Ce n'etait pas possible tant que le jeton routait, il portait deja un index
-- unique global.
--
-- ⚠️ `lower(btrim(...))` ignore la CASSE et les espaces, PAS les accents, alors que la correspondance reelle
-- (`normalizeText`) les ignore aussi. L'ecart est assume : `unaccent` n'est pas installe sur cette base et
-- n'est pas immuable, donc inutilisable dans une expression d'index sans emballage. Le controle applicatif,
-- lui, utilise exactement `normalizeText` : cet index est le FILET contre une course entre deux creations
-- simultanees, pas la definition de « la meme phrase ».
--
-- Verifie avant ecriture (2026-09-07, base de production) : aucune phrase en double aujourd'hui.
create unique index if not exists channelsme_links_phrase_key
  on channelsme_links (tenant_id, lower(btrim(phrase)));

-- 2. Les liens EXISTANTS basculent leur mot-cle du jeton vers leur phrase.
--
-- Sans cette bascule, ils continueraient de fonctionner (le texte des vieux posts porte les deux), mais ils
-- divergeraient des nouveaux : deux regles pour une seule fonctionnalite, et le premier qui lirait le code
-- croirait l'une ou l'autre selon le lien qu'il regarde.
--
-- IDEMPOTENTE : rejouee, elle reecrit la meme valeur. Le `where` la borne aux automations REELLEMENT
-- possedees par un lien, jamais aux automations ordinaires du client, dont les mots-cles lui appartiennent.
update automations a
   set trigger_config = jsonb_set(a.trigger_config, '{keywords}', to_jsonb(array[l.phrase]))
  from channelsme_links l
 where l.automation_id = a.id
   and l.tenant_id = a.tenant_id
   and a.possede_par = 'channelsme_link';
