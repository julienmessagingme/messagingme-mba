-- 0073 : ouvrir la porte au multi-espaces pour une même adresse.
--
-- Migration SÉPARÉE de 0072 À DESSEIN. 0072 est additive et sans effet : on peut l'appliquer, la vérifier, et
-- s'arrêter là. C'est CELLE-CI qui change le comportement, en retirant l'unicité de l'adresse sur les comptes.
--
-- 🔴 À appliquer AVEC le déploiement du code, pas avant. Tant que le code ne sait pas gérer plusieurs comptes
-- pour une adresse, retirer cet index ne servirait à rien, et laisserait la porte ouverte à des doublons que
-- l'ancien `findByEmail` départagerait au hasard (c'est exactement ce que la migration 0010 avait fermé).
--
-- ⚠️ CHEMIN DE RETOUR : recréer l'index n'est possible que TANT QU'AUCUN doublon n'a été créé. Une fois qu'une
-- adresse porte deux comptes, le retour arrière demande de choisir lequel supprimer. C'est la seule étape
-- irréversible du lot, et c'est pour cela qu'elle est isolée dans sa propre migration.
--
--   Pour revenir en arrière AVANT tout doublon :
--     create unique index users_email_lower_unique on users (lower(email));
drop index if exists users_email_lower_unique;

-- L'unicité par ESPACE, elle, reste : deux comptes de la même adresse dans le MÊME espace n'auraient aucun
-- sens et rendraient le choix impossible à présenter. Elle vient de la migration 0001, on la rend explicite.
create unique index if not exists users_tenant_email_unique on users (tenant_id, lower(email));
