-- 0245 : les campagnes depuis Claude (spec docs/superpowers/specs/2026-10-20-campagnes-depuis-claude-design.md, plan du
-- meme jour).
--
-- campaigns.prevue_le : la date choisie dans l'assistant, rangee sur un BROUILLON sans le programmer. launch_campaign le
-- programme a cette date, et la console montre alors « Programmer pour ... » au lieu de « Lancer ». Distincte de
-- scheduled_at, qui veut dire « programmee » et que le balayage lit (status = 'scheduled').
--
-- campagne_confirmations : le code du recapitulatif de prepare_campaign, HACHE (jamais en clair), l'empreinte de l'etat
-- montre a la personne, l'expiration et l'usage unique. Une ligne presente = le brouillon vient de l'assistant : c'est la
-- seule source de ce fait, pas un drapeau de plus sur campaigns. Elle part avec sa campagne, et la campagne avec l'espace.
-- tenant_id sert au filtre d'isolation de chaque requete.
--
-- A appliquer AVANT le up : le code neuf ecrit les deux. L'ancien code y survit : il ne lit ni l'une ni l'autre, et son
-- insertion laisse prevue_le a null. Une colonne nullable sans defaut ne reecrit pas la table. campaigns est lue par le
-- balayage des programmees et par le run : un lock_timeout de 5 s, en set local.
set local lock_timeout = '5s';

alter table campaigns add column if not exists prevue_le timestamptz;

create table if not exists campagne_confirmations (
  campaign_id    uuid primary key references campaigns(id) on delete cascade,
  tenant_id      uuid not null,
  code_empreinte text not null,
  etat_empreinte text not null,
  expire_le      timestamptz not null,
  utilise_le     timestamptz,
  cree_le        timestamptz not null default now()
);
