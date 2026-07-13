-- 0024_campaign_workflow.sql : une campagne peut envoyer SOIT un template SOIT un WORKFLOW (bot builder).
-- workflow_id non null -> le run de campagne DÉMARRE le workflow pour chaque destinataire (au lieu d'envoyer
-- un template). template_name/language deviennent nullable (une campagne workflow n'a pas de template propre).
alter table campaigns add column if not exists workflow_id uuid references workflows(id) on delete set null;
alter table campaigns alter column template_name drop not null;
alter table campaigns alter column template_language drop not null;
