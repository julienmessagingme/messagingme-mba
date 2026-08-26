-- 0084 : campagne AU FIL DE L'EAU, alimentee par un webhook entrant (menu Tools > Webhooks).
--
-- Une campagne ordinaire fige ses destinataires a la creation : on choisit une liste, on lance, ca part, c'est
-- fini. Celle-ci n'en a AUCUN au depart. Elle reste ouverte, et chaque contact qui arrive par le webhook
-- designe devient un destinataire de plus, envoye dans la foulee. C'est le meme moteur d'envoi que les autres
-- (meme cadence, meme quality gate, meme opt-in, memes statistiques) : seule la porte d'entree change.
--
-- Pourquoi une colonne plutot qu'un type de campagne. `webhook_id is not null` DIT deja tout : c'est la
-- source, et c'est le drapeau. Ajouter en plus un `source text` decrirait deux fois la meme chose, avec le
-- risque classique que les deux divergent.
--
-- on delete set null : supprimer l'adresse ne doit pas emporter l'historique d'envoi d'une campagne terminee.
-- Une campagne ENCORE ACTIVE, elle, est protegee en amont : la route de suppression d'un webhook refuse tant
-- qu'une campagne vivante s'en nourrit (sans quoi la campagne resterait << en cours >> sans jamais rien
-- recevoir, ce qui est exactement le genre de panne muette qu'on ne voit qu'apres coup).
alter table campaigns add column if not exists webhook_id uuid references webhooks(id) on delete set null;

-- L'index sert le chemin CHAUD : a chaque appel du webhook, on cherche les campagnes vivantes qui s'en
-- nourrissent. Partiel sur `running` parce que c'est le seul statut qui alimente : une campagne en pause,
-- terminee ou en brouillon ne prend pas les arrivants.
create index if not exists campaigns_webhook_running_idx
  on campaigns (webhook_id) where webhook_id is not null and status = 'running';
