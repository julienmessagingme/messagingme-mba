-- L'AUTEUR DE CHAQUE MESSAGE DU FIL DE L'ASSISTANT.
--
-- 🔴 LE FIL EST PARTAGÉ ENTRE LES ADMINS D'UN ESPACE (décision de Julien du 2026-09-14 : « un fil continu
-- par surface »), pas par utilisateur. Sans cette colonne, « qui a demandé ça ? » n'a aucune réponse sur une
-- conversation qui décide de ce que le robot dit aux clients.
--
-- ⚠️ ELLE VIT À CÔTÉ DE `messages`, PAS DEDANS, et ce n'est pas un détour. Le tableau `messages` est relu par
-- un schéma Zod strict (`etatSchema`, `src/agent/setup/entretien-store.ts`) : y ajouter une clé OBLIGATOIRE
-- ferait échouer la relecture de TOUS les entretiens existants, qui retomberaient alors sur l'entretien
-- vierge, c'est-à-dire que le client perdrait sa conversation en silence.
--
-- ⚠️ NULLABLE PAR DÉFAUT ET SANS REPRISE : les messages d'avant n'ont pas d'auteur connu, et leur en inventer
-- un serait pire que de n'en afficher aucun. L'écran dit « auteur inconnu » pour ceux-là.
alter table agent_setup_conversations
  add column if not exists auteurs jsonb not null default '[]'::jsonb;
