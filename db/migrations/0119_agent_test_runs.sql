-- 0119_agent_test_runs.sql : garder la trace des essais faits dans le bac a sable d'un agent.
--
-- 🔴 LE MANQUE, DIT PAR JULIEN LE 2026-09-08. « Dans la partie tester, il faudrait qu'on puisse garder la
-- trace des differents tests... la j'ai voulu reappuyer et j'ai plus la trace de ce que j'ai lu. » Regler un
-- agent, c'est comparer : on change une consigne, on repose la meme question, et on regarde si la reponse a
-- bouge. Sans trace, la comparaison se fait de memoire, donc mal, et on ne sait jamais si le reglage a servi.
--
-- ⚠️ RETENTION : 14 JOURS, choisis par Julien. Assez pour comparer deux essais dans la journee et revenir le
-- lendemain, assez court pour ne pas accumuler des mois de brouillons. Le balayage vit dans le worker, avec
-- les autres retentions, et il DIT combien de lignes il efface a chaque passage.
--
-- ⚠️ CE SONT DES ESSAIS, PAS DES CONVERSATIONS DE CLIENTS. Le bac a sable ne parle a personne : ces lignes
-- ne portent ni `wa_id` ni contact, seulement ce que l'administrateur a tape lui-meme et ce que le modele a
-- repondu. C'est ce qui autorise une retention courte et simple, sans le soin particulier que demande la
-- purge RGPD des conversations reelles.
--
-- Le cout est garde parce qu'il est la MOITIE de ce qu'on juge : une reponse deux fois meilleure qui coute
-- dix fois plus cher n'est pas un progres, et on ne peut pas s'en apercevoir apres coup si on ne l'a pas
-- note sur le moment.

create table if not exists agent_test_runs (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  agent_id       uuid not null references agents(id) on delete cascade,
  -- La conversation ENVOYEE au modele, telle quelle : sans elle, une reponse ne veut rien dire.
  messages       jsonb  not null,
  -- La reponse rendue. `null` est un cas NOMINAL : l'agent peut sortir sans rien dire.
  reponse        text,
  -- La sortie empruntee, s'il en a pris une (`terminer`, `escalader`, plafond...).
  sortie         text,
  -- Les outils reellement appeles, dans l'ordre. C'est ce qui distingue « il n'a pas trouve » de « il n'a
  -- meme pas cherche », et c'est la question qu'on se pose en premier devant une mauvaise reponse.
  appels         jsonb  not null default '[]'::jsonb,
  tokens_in      bigint not null default 0,
  tokens_out     bigint not null default 0,
  cout_micro_eur bigint not null default 0,
  created_at     timestamptz not null default now()
);

-- L'ecran lit « les derniers essais de CET agent », et le balayage lit « les vieux ». Le premier est servi
-- par cet index ; le second balaie de toute facon.
create index if not exists agent_test_runs_agent_idx
  on agent_test_runs (tenant_id, agent_id, created_at desc);
