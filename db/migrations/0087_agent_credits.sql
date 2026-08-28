-- 0087 : le solde prepaye d un workspace pour l agent IA, et son journal.
--
-- POURQUOI UN SOLDE PAR WORKSPACE. Un agent consomme un modele a chaque message d un contact, et cette
-- consommation est facturee au client. Le plafond PAR CONVERSATION de la fiche protege d une conversation
-- qui s emballe ; il ne dit rien de ce qu un client depense au total. Le prepaye est le modele du cadrage :
-- le client charge, l agent consomme, et quand c est vide il s arrete au lieu de creuser.
--
-- POURQUOI UN JOURNAL EN PLUS DU SOLDE. Un solde seul est inexplicable la premiere fois qu il baisse. Le
-- journal dit quand, combien, et pour quelle conversation : c est ce qui permet de repondre a un client qui
-- demande ou est passe son argent, et c est aussi la seule facon d instruire une consommation anormale.

create table if not exists agent_credits (
  tenant_id        uuid primary key references tenants(id) on delete cascade,
  -- En MICRO-EUROS, et le nom le dit. Le fournisseur facture en dollars : la conversion se fait a l entree,
  -- une seule fois, avec le taux de la configuration (`src/agent/devise.ts`). Le client voit, charge et paie
  -- des euros, ce qui est ce qu on lui facture.
  --
  -- `bigint` et SIGNE : le solde peut finir legerement NEGATIF, et c est voulu. Un tour deja joue a deja
  -- coute ; refuser de l enregistrer pour garder un solde a zero reviendrait a offrir la derniere
  -- conversation. La garde est a l ENTREE du tour (solde epuise -> on ne demarre pas), pas a l ecriture.
  solde_micro_eur  bigint not null default 0,
  updated_at       timestamptz not null default now()
);

create table if not exists agent_credit_mouvements (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  -- Negatif = consommation, positif = rechargement. Un seul sens de lecture, une seule colonne.
  delta_micro_eur bigint not null,
  -- `conso` ou `recharge`. Volontairement pas un enum SQL : une valeur de plus ne doit pas demander une
  -- migration, et la liste vit dans le code (`src/agent/credits.ts`).
  raison          text not null,
  -- La session qui a consomme, quand il y en a une. `set null` : la trace comptable survit a la purge des
  -- conversations, sinon le journal se viderait tout seul au bout de 30 jours et le client n aurait plus
  -- aucune explication de ce qu il a paye. Null aussi pour un essai depuis la console, qui consomme
  -- vraiment mais n ouvre aucune session : c est la `note` qui le dit alors.
  session_id      uuid references agent_sessions(id) on delete set null,
  -- Pourquoi ce mouvement. TOUJOURS renseignee sur un rechargement (la route l exige) : le jeton d
  -- exploitation est partage, il n y a aucune identite d operateur a enregistrer, donc cette phrase est la
  -- seule trace de qui a recharge et pourquoi.
  note            text,
  at              timestamptz not null default now()
);

-- Le journal se lit TOUJOURS par workspace et du plus recent au plus ancien : c est la seule facon dont on
-- l interroge, en exploitation comme dans la console.
create index if not exists agent_credit_mouvements_tenant_idx
  on agent_credit_mouvements (tenant_id, at desc);
