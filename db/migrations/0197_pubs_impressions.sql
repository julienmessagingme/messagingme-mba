-- 0197 : les impressions et la couverture d'une publicité, relues chez Meta par le balayage de suivi, dans le même
-- appel que la dépense et les clics.
-- Additive : l'ancien code ignore les deux colonnes, elle passe AVANT le déploiement du code qui les écrit.
-- Nullables, SANS défaut : null veut dire « jamais lues », et l'entonnoir écrit alors « non disponible », jamais 0.
-- bigint et pas integer : un dépassement de 2,1 milliards ferait échouer l'écriture, donc tout le balayage de
-- l'espace, comme un NaN sur `clics`.
alter table publicites add column if not exists impressions bigint,
                       add column if not exists couverture bigint;
