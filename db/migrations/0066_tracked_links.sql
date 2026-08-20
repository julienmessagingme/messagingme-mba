-- 0066 : liens de redirection TRACÉS (clics sur les boutons URL des templates).
--
-- Principe : l'utilisateur saisit son lien normalement. À la SOUMISSION à Meta, le serveur le remplace par
-- `https://<base>/r/<code>` et garde ici la destination d'origine. Au clic, on compte puis on redirige.
--
-- ⚠️ Une fois un template APPROUVÉ, il porte notre lien POUR TOUJOURS, et Meta ne garde plus la destination
-- d'origine : elle n'existe QUE dans cette table. Une ligne perdue = un lien mort dans des messages déjà
-- livrés. D'où l'ordre d'écriture imposé côté code : on enregistre la destination AVANT de soumettre à Meta.
-- Un refus de Meta laisse une ligne orpheline, ce qui est sans conséquence ; l'inverse serait irréparable.
--
-- ⚠️ RGPD : rien de personnel n'entre ici. Pas de wa_id, pas de numéro, pas d'IP, pas de user-agent. Un clic
-- est un horodatage rattaché à un lien, pas à une personne. C'est aussi pour ça que la purge d'un contact
-- (`purgeMany`) n'a rien à y faire : il n'y a rien à anonymiser.
create table if not exists tracked_links (
  -- Code public court et opaque, tel qu'il apparaît dans l'URL. Minuscules (canonique).
  code              text primary key,
  tenant_id         uuid not null references tenants(id) on delete cascade,
  -- Le template est identifié par son NOM et sa LANGUE : chez Meta, c'est sa clé. Aucun template n'étant
  -- stocké chez nous, il n'y a pas d'id local à référencer.
  template_name     text not null,
  template_language text not null,
  -- Carousel : index de la carte (0-based). null = bouton du template lui-même.
  card_index        int,
  -- Index du bouton dans TOUS les boutons (la numérotation de Meta), boutons non-URL compris.
  button_index      int not null,
  destination       text not null,
  -- Posé quand Meta a ACCEPTÉ le template portant ce lien. Tant qu'il est null, le template soumis porte
  -- peut-être encore l'URL brute (refus de Meta, panne en vol) : la ligne existe mais ne prouve rien.
  --
  -- C'est ce qui empêche une case qui ment dans Analytics : les mesures et le ré-habillage d'affichage ne
  -- lisent QUE les lignes confirmées. Sans ça, une réservation suivie d'un refus de Meta ferait apparaître
  -- « a cliqué sur le lien » sur un template qui n'a jamais porté notre lien, et la barre resterait à zéro
  -- sans que personne ne comprenne pourquoi.
  --
  -- ⚠️ La REDIRECTION, elle, ne filtre PAS là-dessus : si Meta a accepté mais que notre confirmation a
  -- échoué, le lien circule déjà dans des messages livrés et doit fonctionner. On préfère un lien qui marche
  -- sans être mesuré à un lien mort proprement comptabilisé.
  confirmed_at      timestamptz,
  created_at        timestamptz not null default now()
);

-- Un bouton = un lien. C'est la maille qui garde le compteur juste : un template peut porter deux boutons
-- URL, et un carousel en porte par carte. Compter les deux ensemble mélangerait deux destinations.
create unique index if not exists tracked_links_bouton_unique
  on tracked_links (tenant_id, template_name, template_language, coalesce(card_index, -1), button_index);

-- Lecture type : « les liens tracés de ces templates », pour ré-habiller l'affichage et alimenter les mesures.
create index if not exists idx_tracked_links_template
  on tracked_links (tenant_id, template_name, template_language);

-- Un clic = une ligne. Pas un compteur incrémenté : l'écran Analytics filtre sur une PÉRIODE, et un total
-- cumulé ne sait pas répondre « combien entre le 1er et le 15 ».
create table if not exists tracked_link_clicks (
  id        bigserial primary key,
  code      text not null references tracked_links(code) on delete cascade,
  -- Dénormalisé : les mesures se lisent toujours scopées au tenant, et sans lui il faudrait joindre
  -- `tracked_links` sur chaque agrégat.
  tenant_id uuid not null references tenants(id) on delete cascade,
  at        timestamptz not null default now()
);

create index if not exists idx_tracked_link_clicks_lecture
  on tracked_link_clicks (tenant_id, code, at);
