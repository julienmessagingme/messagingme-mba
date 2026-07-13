-- 0022_workflows.sql — workflows (bot builder visuel) : un graphe de blocs (nodes) reliés par des arêtes.
-- graph jsonb = { nodes:[{id,type,position,data}], edges:[{id,source,target,sourceHandle}] }.
-- PB1 : stockage + édition visuelle. L'exécution (workflow_runs) arrive en PB2.
create table if not exists workflows (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  name        text not null,
  status      text not null default 'draft' check (status in ('draft', 'active')),
  graph       jsonb not null default '{"nodes":[],"edges":[]}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists workflows_tenant_idx on workflows (tenant_id);
