-- Un outil dit ce que L'AGENT fait de la réponse : il POUSSE de l'info, ou il l'INTÈGRE.
--
-- 🔴 CE QUE ÇA RÉPARE, ET C'EST UN DÉFAUT DE CONCEPTION, PAS UN OUBLI. Jusqu'ici, tout appel de connecteur
-- était supposé RENDRE quelque chose : la déclaration exigeait des champs de réponse, et le résolveur
-- refusait l'appel quand la liste était vide. Or la moitié des appels qu'un client veut brancher ne rendent
-- rien d'utile : poser une étiquette, créer une fiche, pousser un opt-out. Julien, le 2026-09-15, bloqué sur
-- un `POST /subscriber/add-tag` qu'aucun écran ne voulait laisser passer : « la question c'est qu'est-ce que
-- cet appel fait ? est-ce que c'est pour pousser de l'info quelque part, ou pour avoir un retour de payload
-- avec une information qui enrichirait la discussion ».
--
-- 🔴 ELLE NE SE DÉDUIT PAS DE LA MÉTHODE HTTP, et c'est pour ça qu'elle est demandée plutôt que calculée.
-- Un `POST` peut parfaitement être une RECHERCHE (l'API de UChat en a plusieurs). Dériver la nature du verbe
-- rangerait ces appels-là en « pousse » et rendrait leur réponse invisible à l'agent, sans aucune erreur.
--
-- 🔴 ELLE VIT SUR L'OUTIL, PAS SUR L'APPEL, ET C'EST LA DÉCISION STRUCTURANTE. Un appel est PARTAGÉ entre
-- agents ; ce que CET agent fait de la réponse ne l'est pas. `connector_requests.output_paths` reste, mais
-- change de rôle : elle devient le DÉFAUT qui pré-remplit le rattachement, et ne gouverne plus rien à
-- l'exécution. Changer ce défaut ne modifie donc aucun agent déjà en service.
--
-- ⚠️ `agent_tools.output_paths` EXISTE DÉJÀ (migration 0086) et n'est PAS recréée ici. Elle était
-- délibérément laissée vide pour les connecteurs, avec une justification écrite dans `catalog.pg.ts` qui
-- était juste pour l'ancienne conception et devient fausse avec celle-ci. Conséquence mesurée le 2026-09-15 :
-- le bac à sable bouclait dessus et rendait un objet VIDE, alors qu'il promet « exactement ce que l'agent
-- recevra ». La remplir répare ce défaut-là au passage.
--
-- ⚠️ DÉFAUT `integre`, ET IL NE REPREND RIEN. C'est le comportement de tous les outils existants : ils
-- lisent des champs. Mesuré AVANT d'écrire cette ligne plutôt que supposé : **zéro** outil issu d'un appel en
-- base (`select count(*) from agent_tools where request_id is not null`), donc ce défaut ne change le
-- comportement de personne. Les trois outils existants sont des outils maison, que cette colonne ne concerne
-- pas.
--
-- ⚠️ AUCUN INDEX, délibérément : cette colonne se lit toujours sur une ligne déjà retrouvée par sa clé
-- (l'outil que le modèle vient d'appeler). Aucune requête ne la balaie, et un index serait un contrat avec
-- une requête qui n'existe pas.
alter table agent_tools
  add column if not exists nature text not null default 'integre';

-- Le CHECK est posé à part et par son nom : créé en ligne, il serait nommé automatiquement, et le jour où il
-- faudra l'élargir personne ne saura comment le désigner sans le lire en base d'abord (leçon de 0122).
alter table agent_tools drop constraint if exists agent_tools_nature_chk;
alter table agent_tools add constraint agent_tools_nature_chk check (nature in ('pousse', 'integre'));
