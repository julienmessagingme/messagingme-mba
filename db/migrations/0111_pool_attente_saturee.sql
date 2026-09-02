-- 0111_pool_attente_saturee.sql : separer l ATTENTE SUR POOL SATURE du simple temps d ouverture.
--
-- Constat de l audit externe du 2026-09-02, verifie dans le code : la carte /ops colore une barre en rouge
-- des que `max_ms >= 50`, sans regarder `attentes`. Or `max_ms` est le maximum de TOUTES les acquisitions,
-- y compris l ouverture normale d une connexion neuve (TCP + TLS), qui coute quelques dizaines de
-- millisecondes et n a rien d anormal, surtout au demarrage.
--
-- 🔴 CONSEQUENCE : une barre rouge pouvait s afficher avec ZERO attente sur pool sature. Le rapport ecrit
-- pour l audit affirmait meme le contraire (« une barre rouge veut dire qu une acquisition a depasse 50 ms
-- sur un pool sature »). Un indicateur qui crie au loup se fait ignorer, et il aurait ete ignore le jour ou
-- il aurait eu raison.
--
-- On garde donc les DEUX maximums : celui de toutes les acquisitions (utile pour voir une base lente) et
-- celui des seules acquisitions faites sur un pool SATURE, qui est le signal. Seul le second colore.
--
-- ⚠️ NON BLOQUANTE, comme les trois precedentes : colonne a defaut zero, la lecture s en passe.

alter table pool_attentes add column if not exists max_attente_ms integer not null default 0;
