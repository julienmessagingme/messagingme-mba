-- 0252 : ecrire en premier sur un numero relie par QR code (plan docs/superpowers/plans/2026-10-23-shopify-numero-qr.md,
-- tache 2 ; conception docs/superpowers/specs/2026-10-23-shopify-numero-qr-design.md).
--
-- application_premiers_messages : la file des messages qu un espace de la filiere application ecrit en premier (Shopify,
--   Claude, l API, une reponse hors des 24 heures). Une ligne par message, posee par la porte
--   (src/application/premier-message.ts), envoyee par la file application-premier-message a son creneau (prevu_le).
--   cle : l idempotence, unique par espace (application_premiers_messages_cle_uniq) : un webhook Shopify rejoue ne
--   cree pas un second message. wa_id : les chiffres du numero du contact. reference : la cle d evenement Shopify ou le
--   jeton du panier, pour inscrire l issue chez l appelant. statut : en_file (attend son creneau), envoi (reclame par
--   le job : un job en double ne le reprend pas, et un crash apres la reclamation ne renvoie jamais), envoye,
--   abandonne. issue : pourquoi c est fini. essais : les reclamations, bornees par le job. Purgee a 30 jours une fois
--   finie.
-- comptes_application.premiers_geles_jusqu_au : WhatsApp a refuse un premier message de ce numero (erreur 463) ; les
--   premiers messages du compte sont suspendus jusque-la (72 heures), les reponses continuent.
-- shopify_messages : un message se regle par un modele (filiere API) OU par un texte (filiere application), jamais les
--   deux : modele devient facultatif, texte apparait, et shopify_messages_modele_ou_texte exige exactement l un des
--   deux. Toutes les lignes existantes ont un modele et pas de texte : la contrainte tient a la creation.
--
-- A appliquer SEULE et AVANT le code : une table et des colonnes neuves que l ancien code ne lit pas, et une contrainte
-- relachee (modele drop not null) que l ancien code, qui ecrit toujours un modele, respecte : l ancien code survit.
-- shopify_messages ne compte que quelques lignes (les CHECK sont instantanes), mais la cle etrangere de la table neuve
-- prend un verrou SHARE ROW EXCLUSIVE sur tenants, lue par le chemin chaud : un lock_timeout de 5 s, en set local.
set local lock_timeout = '5s';

create table if not exists application_premiers_messages (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  cle         text not null check (char_length(cle) between 1 and 200),
  wa_id       text not null check (wa_id ~ '^[0-9]{8,15}$'),
  texte       text not null check (char_length(texte) between 1 and 4096),
  origine     text not null check (origine in ('shopify_commande', 'shopify_panier', 'mcp', 'api', 'reponse')),
  reference   text check (reference is null or char_length(reference) <= 200),
  statut      text not null default 'en_file' check (statut in ('en_file', 'envoi', 'envoye', 'abandonne')),
  issue       text check (issue is null or char_length(issue) <= 40),
  prevu_le    timestamptz not null,
  essais      integer not null default 0,
  message_id  text,
  cree_le     timestamptz not null default now(),
  envoye_le   timestamptz,
  constraint application_premiers_messages_cle_uniq unique (tenant_id, cle)
);

-- Le creneau suivant d un espace se calcule sur le dernier prevu (max(prevu_le) de l espace).
create index if not exists application_premiers_messages_prevu_le
  on application_premiers_messages (tenant_id, prevu_le desc);

alter table comptes_application add column if not exists premiers_geles_jusqu_au timestamptz;

alter table shopify_messages alter column modele drop not null;

alter table shopify_messages
  add column if not exists texte text
    constraint shopify_messages_texte_check check (texte is null or char_length(texte) between 1 and 4096);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'shopify_messages_modele_ou_texte') then
    alter table shopify_messages
      add constraint shopify_messages_modele_ou_texte check ((modele is null) <> (texte is null));
  end if;
end
$$;
