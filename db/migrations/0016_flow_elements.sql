-- 0016_flow_elements.sql — Flows riches (phase 3) : éléments texte/image/champ + discriminant + mapping.
-- `elements` = modèle riche (source de vérité UI/édition). `ref` = constante embarquée dans le payload
-- complete du flow, renvoyée dans le nfm_reply -> identifie le flow au retour. `mapping` = clé champ ->
-- clé user field du contact (où écrire la valeur saisie). `fields` (0015) reste dérivé pour rétro-compat.
alter table flows add column if not exists elements jsonb;
alter table flows add column if not exists ref text;
alter table flows add column if not exists mapping jsonb;

-- ref unique (quand présent) : findByRef doit être déterministe.
create unique index if not exists flows_ref_unique on flows (ref) where ref is not null;
