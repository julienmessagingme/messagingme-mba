-- 0025_template_param_hints.sql : « indices » de mapping variable -> champ, posés à la CRÉATION d'un template
-- via le sélecteur de champ (« {{1}} = Prénom »). Meta ne stocke que l'exemple texte, pas quel champ CRM
-- correspond à une variable : on garde ce lien chez nous pour PRÉ-REMPLIR le mapping d'une campagne.
-- Clé = (tenant, nom, langue, position). source jsonb = un ParamSource ({type:'attribute'|'field'|'literal', …}).
create table if not exists template_param_hints (
  tenant_id         uuid not null references tenants(id) on delete cascade,
  template_name     text not null,
  template_language text not null,
  position          integer not null,
  source            jsonb not null,
  primary key (tenant_id, template_name, template_language, position)
);
