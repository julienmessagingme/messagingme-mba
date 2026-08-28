-- 0088 : les sources externes d outils (lot L2), et le lien depuis le catalogue.
--
-- POURQUOI UNE TABLE SEPAREE. L adresse de base et le secret appartiennent au TENANT, pas a l agent : deux
-- agents du meme client interrogent le meme systeme. Les mettre sur l outil obligerait a recopier le secret
-- a chaque outil, donc a le faire tourner en N endroits le jour ou il change.
--
-- POURQUOI L ADRESSE DE BASE EST FIGEE ICI. C est la garde anti-SSRF et anti-IDOR : le modele ne compose
-- jamais qu un gabarit de chemin, et le chemin final doit rester SOUS cette adresse (`src/agent/http-cible.ts`).
-- Une adresse ecrite par le modele serait un lecteur de l interieur du reseau Docker du VPS : il voit l admin
-- NPM, les autres conteneurs et le service de metadonnees.

create table if not exists agent_tool_sources (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  -- 'mcp' est declare des maintenant pour que L4 n ait pas de migration a faire, mais aucun code ne le sert.
  kind             text not null check (kind in ('http','mcp')),
  label            text not null,
  -- Adresse de BASE, https obligatoire (verifie en code a l ecriture). Jamais choisie par le modele.
  base_url         text not null,
  auth_kind        text not null check (auth_kind in ('none','bearer','header')),
  auth_header_name text,
  -- CHIFFRE au repos (src/crypto/secretbox.ts, meme patron que email_accounts.password_enc). Aucune route ne
  -- le rend, aucun journal ne l ecrit, aucun message d erreur ne le cite : `erreur` et `contenu` repartent au
  -- MODELE, donc chez le fournisseur.
  auth_secret_enc  text,
  status           text not null default 'draft' check (status in ('draft','active','disabled')),
  -- Derniere epreuve reussie / derniere erreur : c est ce qui rend un connecteur mort VISIBLE avant qu un
  -- contact ne le decouvre. Un jeton expire ne produit aucune erreur applicative cote client.
  last_ok_at       timestamptz,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index if not exists agent_tool_sources_label_idx
  on agent_tool_sources (tenant_id, lower(label));

-- Un secret est exige des que l authentification en demande un : une source 'bearer' sans secret signerait
-- avec une chaine vide, et le systeme du client repondrait 401 qu on mettrait sur le dos de ses identifiants.
alter table agent_tool_sources drop constraint if exists agent_tool_sources_auth_chk;
alter table agent_tool_sources add constraint agent_tool_sources_auth_chk
  check ((auth_kind = 'none' and auth_secret_enc is null)
      or (auth_kind = 'bearer' and auth_secret_enc is not null)
      or (auth_kind = 'header' and auth_secret_enc is not null and auth_header_name is not null));

alter table agent_tools add column if not exists source_id uuid
  references agent_tool_sources(id) on delete cascade;

-- L integrite qui compte : un outil maison n a pas de source, un outil externe en a forcement une. Sans
-- elle, un outil 'http' sans source serait actif, expose au modele, et refuserait a chaque appel : le client
-- verrait un agent qui « ne fait rien », sans trace lisible.
alter table agent_tools drop constraint if exists agent_tools_origin_src_chk;
alter table agent_tools add constraint agent_tools_origin_src_chk
  check ((origin = 'mba' and source_id is null) or (origin <> 'mba' and source_id is not null));

-- Le resolveur lit les outils ACTIFS d un agent puis leur source : l index existant porte deja
-- (tenant_id, agent_id) where actif. Ici on sert l ecran, qui liste les outils d UNE source pour refuser sa
-- suppression tant qu un outil actif en depend.
create index if not exists agent_tools_source_idx on agent_tools (source_id) where source_id is not null;
