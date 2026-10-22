-- 0249 : brancher Shopify et regler ses messages depuis la console (plan docs/superpowers/plans/2026-10-22-shopify-console.md,
-- lot 0 ; conception docs/superpowers/specs/2026-10-22-shopify-console-design.md).
--
-- shopify_boutiques.origine : par ou la boutique a ete branchee. claude_code = l app creee par la CLI, dont les webhooks
--   sont declares dans l app (shopify.app.toml) ; console = l app creee a la main sur le tableau de bord developpeur de
--   Shopify, dont NOTRE serveur abonne les webhooks par l API. Les deux ne doivent jamais etre confondues : abonner les
--   webhooks d une app de la CLI ferait tout recevoir en double. Les boutiques existantes viennent toutes de Claude
--   Code, d ou le defaut. Une boutique console desinstallee perd son branchement (shop/redact ne viendra jamais).
-- shopify_messages_attente : un message prepare par l assistant de la console, dont le modele attend l approbation de
--   Meta. Une attente par evenement et par espace (cle primaire) : une nouvelle preparation REMPLACE la precedente, et
--   un branchement direct (Claude Code) la retire. Le message actif de shopify_messages n est jamais touche par une
--   attente : il continue de partir jusqu a l approbation du nouveau.
--
-- A appliquer AVANT le code : le code ecrit origine et lit la table des attentes. L ancien code ignore l une et l autre.
-- shopify_boutiques ne compte que quelques lignes : la colonne a defaut constant et son CHECK sont instantanes, mais la
-- table est lue par chaque webhook, et la cle etrangere de la table neuve prend un verrou sur tenants : un lock_timeout
-- de 5 s, en set local.
set local lock_timeout = '5s';

alter table shopify_boutiques
  add column if not exists origine text not null default 'claude_code'
    constraint shopify_boutiques_origine_check check (origine in ('console', 'claude_code'));

create table if not exists shopify_messages_attente (
  tenant_id             uuid not null references tenants(id) on delete cascade,
  evenement             text not null check (evenement in ('order_paid', 'order_fulfilled', 'checkout_abandoned')),
  modele                text not null check (char_length(modele) between 1 and 512),
  langue                text not null check (char_length(langue) between 1 and 20),
  variables             jsonb not null default '[]'::jsonb check (jsonb_typeof(variables) = 'array'),
  delai_panier_minutes  integer check (delai_panier_minutes between 15 and 4320),
  par                   uuid,
  cree_le               timestamptz not null default now(),
  primary key (tenant_id, evenement)
);

-- Le filet relit les attentes anciennes, toutes boutiques confondues (lecture transverse 6 du store) : par anciennete.
create index if not exists shopify_messages_attente_cree_le on shopify_messages_attente (cree_le);
