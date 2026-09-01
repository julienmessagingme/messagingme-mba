-- 0100_analyse_resume.sql : le RESUME de la conversation, ecrit par l'analyse.
--
-- Demande de Julien du 2026-09-01 : cliquer une ligne du detail quali doit ouvrir une fiche qui reprend
-- tous les champs du tableau « mais aussi un resume de la conversation ».
--
-- Pourquoi une colonne et pas un champ existant : `justification` explique le CLASSEMENT (« pourquoi
-- j'ai propose de rappeler »), pas ce qui s'est dit. La montrer comme un resume tromperait le lecteur, et
-- c'est le genre de raccourci qu'on ne voit plus une fois pris.
--
-- NULLABLE, et sans remplissage : les analyses d'AVANT cette migration n'ont pas de resume et n'en auront
-- jamais (le reconstruire voudrait dire rappeler le LLM sur chaque conversation deja analysee, donc payer
-- une seconde fois pour du confort). L'ecran le DIT au lieu de laisser un vide qui passerait pour un bug.
--
-- 🔴 BLOQUANTE : des le deploiement, chaque analyse ecrit cette colonne.

alter table conversation_analysis add column if not exists summary text;
