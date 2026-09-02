-- 0106_clics_attribues.sql : savoir QUI a clique, pas seulement COMBIEN.
--
-- Julien, le 2026-09-02 : « je veux qu on mesure le nombre d occurrence certes mais je veux aussi savoir QUI a
-- reagi, c est la base de l engagement ». La migration 0066 avait fait l inverse en conscience (« un clic est
-- un horodatage rattache a un lien, pas a une personne ») ; cette decision est revenue.
--
-- 🔴 L OBSTACLE ETAIT PHYSIQUE, PAS TECHNIQUE. Le lien trace est le MEME pour tous les destinataires :
-- `https://base/r/<code>` est fige dans le template approuve par Meta, identique pour les 5 000 personnes. Au
-- moment du clic, l information « qui » n existe NULLE PART dans la requete. Il faut donc que l URL la porte,
-- ce qui veut dire un jeton par destinataire dans l adresse.
--
-- ⚠️ CONSEQUENCE QUE RIEN NE PEUT CHANGER : les templates DEJA APPROUVES gardent leur URL sans jeton, pour
-- toujours. Leurs clics resteront anonymes. L attribution ne vaut que pour les templates soumis apres, et
-- Julien l a accepte : « on s en fout des vieux templates, l essentiel c est que ca marche pour les
-- prochains ». Le RCS, lui, n a pas ce probleme : un message RCS est compose A L ENVOI, donc son URL peut
-- porter le jeton sans que rien ne soit a resoumettre.
--
-- 🔴 UN JETON PAR CONTACT, ET NON PAR (LIEN x DESTINATAIRE). Le second aurait fait une ligne par personne et
-- par lien : une campagne de 5 000 avec deux liens en produit 10 000, et une campagne hebdomadaire un demi
-- million par an. Le jeton par contact repond exactement a la question posee (« qui a clique »), tient dans
-- la ligne du contact, et disparait donc avec lui sans code de purge supplementaire.
--
-- ⚠️ Un jeton dans une URL publique est un identifiant OPAQUE, pas un secret : quiconque recoit le message
-- peut le lire, et un message TRANSFERE attribuera le clic au destinataire d origine. C est la limite de tout
-- suivi de lien, elle n a pas de solution, et elle ne divulgue rien : le jeton ne porte ni numero ni nom.

-- Le jeton public d un contact. NULL tant qu il n a jamais recu de lien trace : on ne fabrique pas des
-- identifiants pour des gens a qui on n envoie rien.
alter table contacts add column if not exists jeton_public text;

-- Unicite GLOBALE et non par espace : le jeton se lit depuis une URL publique, avant de savoir de quel espace
-- il s agit. Deux espaces qui tireraient le meme jeton rendraient la resolution ambigue, donc fausse.
create unique index if not exists contacts_jeton_public_uidx
  on contacts (jeton_public) where jeton_public is not null;

-- Le clic porte desormais QUI, quand on le sait. NULLABLE, et ce n est pas un defaut : un clic venu d un
-- template approuve avant cette migration n a pas de jeton dans son URL, et il ne pourra jamais en avoir.
-- Compter ces clics-la sans savoir qui reste mieux que ne pas les compter.
--
-- 🔴 `on delete SET NULL`, et surtout pas `cascade`. Effacer une personne ne doit pas effacer le COMPTEUR de
-- la campagne : le clic a EU LIEU, il compte dans les mesures, et le faire disparaitre changerait
-- retroactivement des chiffres deja lus. Ce qui doit disparaitre est le lien vers la personne, pas le fait.
-- C est la meme doctrine que `campaign_recipients`, dont l anonymisation remplace le numero au lieu de
-- supprimer la ligne : la statistique survit, l identite non.
alter table tracked_link_clicks add column if not exists contact_id uuid
  references contacts(id) on delete set null;

-- Lecture type : « qui a clique sur ce lien », et « sur quoi cette personne a clique ».
create index if not exists tracked_link_clicks_contact_idx
  on tracked_link_clicks (tenant_id, contact_id) where contact_id is not null;

-- 🔴 CE LIEN PORTE-T-IL UN SUFFIXE VARIABLE ? C est la colonne qui evite de casser la production.
--
-- Un template soumis avec `/r/<code>/{{1}}` EXIGE que chaque envoi fournisse ce {{1}} : sans le composant de
-- bouton correspondant, Meta refuse l appel avec un 132000. Et inversement, envoyer ce composant pour un
-- template dont l URL n a PAS de variable le fait echouer de la meme facon. Les deux erreurs sont
-- symetriques et toutes deux fatales a l envoi.
--
-- On ne peut pas le DEDUIRE : rien dans la ligne ne dit quelle forme d URL a ete soumise, et se fier a la date
-- de creation serait une regle qui se casse au premier retard de deploiement. On l ECRIT donc.
--
-- `false` par defaut : toutes les lignes existantes decrivent des templates approuves SANS suffixe, ce qui est
-- exactement ce que ce defaut affirme.
alter table tracked_links add column if not exists avec_jeton boolean not null default false;

-- Les liens traces d un message RCS. Jusqu ici SEULS les boutons de template WhatsApp etaient traces (0066) :
-- un lien dans un message RCS n etait compte nulle part.
alter table tracked_links add column if not exists rcs_message_id uuid
  references rcs_messages(id) on delete cascade;

-- Le nom et la langue de template n ont plus de sens pour un lien RCS.
alter table tracked_links alter column template_name drop not null;
alter table tracked_links alter column template_language drop not null;

-- 🔴 L unicite d origine portait sur (tenant, template, langue, carte, bouton) et acceptait donc n importe
-- quel nombre de lignes RCS, dont les colonnes de template sont NULL (deux NULL ne sont jamais egaux pour un
-- index unique). On la remplace par DEUX index partiels, un par famille, ce qui garde la garantie des deux
-- cotes : un bouton = un lien.
drop index if exists tracked_links_bouton_unique;

create unique index if not exists tracked_links_bouton_whatsapp_uidx
  on tracked_links (tenant_id, template_name, template_language, coalesce(card_index, -1), button_index)
  where template_name is not null;

create unique index if not exists tracked_links_bouton_rcs_uidx
  on tracked_links (tenant_id, rcs_message_id, coalesce(card_index, -1), button_index)
  where rcs_message_id is not null;

-- Une ligne appartient a UNE famille, jamais aux deux ni a aucune. Sans cette contrainte, une ligne sans
-- template ni message RCS serait un lien que rien ne rattache, donc impossible a reconstruire.
alter table tracked_links drop constraint if exists tracked_links_famille_chk;
alter table tracked_links add constraint tracked_links_famille_chk
  check ((template_name is not null and rcs_message_id is null)
      or (template_name is null and rcs_message_id is not null));
