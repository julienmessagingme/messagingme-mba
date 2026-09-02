-- 0107_liens_rcs.sql : les liens traces d un message RCS, cles sur LEUR DESTINATION.
--
-- 🔴 CETTE MIGRATION CORRIGE LA MOITIE RCS DE LA 0106, QUI S EST TROMPEE DE CLE. La 0106 a pose
-- `tracked_links.rcs_message_id`, une reference vers la BIBLIOTHEQUE de messages RCS (`rcs_messages`, 0077).
-- La reconnaissance faite en ecrivant le code a montre que cette cle ne couvre presque rien :
--
--   * une campagne RCS porte son message EMBARQUE dans la ligne de campagne (`campaigns.rcs_message`), pas une
--     reference a la bibliotheque ; l assistant copie le contenu du message choisi et oublie son identifiant ;
--   * un bloc RCS de scenario porte lui aussi son message EMBARQUE dans le graphe ;
--   * la reponse rapide convertie en RCS par l executeur fabrique son message a la volee, il n existe nulle part ;
--   * SEUL l envoi depuis l inbox lit la bibliotheque par identifiant.
--
-- Autrement dit, la cle de la 0106 aurait trace le cas le moins utile (un envoi manuel, un contact a la fois) et
-- laisse sans mesure les deux cas qui comptent : la campagne et le scenario. Aucune ligne ne l utilise encore
-- (verifie en base le 2026-09-02 : 0), donc on la corrige maintenant, ou jamais.
--
-- 🔴 LA BONNE CLE EST LA DESTINATION, ET C EST UNE CONSEQUENCE DE LA NATURE DU CANAL. Un template WhatsApp est
-- SOUMIS puis fige : son lien doit etre reserve avant la soumission, et re-soumettre le meme bouton doit
-- retrouver LE MEME code, sinon les messages deja livres pointent une ligne orpheline. D ou une cle
-- (template, langue, carte, bouton) : elle sert l IDEMPOTENCE DE LA RESERVATION, pas la finesse de la mesure.
--
-- Un message RCS n est soumis a personne. Il est compose A L ENVOI, donc son URL peut etre reecrite au dernier
-- moment, et il n y a aucune reservation a rendre idempotente. Il ne reste que trois besoins : ne pas creer une
-- ligne par destinataire, qu un lien envoye hier resolve encore aujourd hui, et que les clics s accumulent sur
-- un code. `(tenant_id, destination)` les satisfait tous les trois, et c est la cle la plus simple qui le fasse.
--
-- ⚠️ CE QU ON PERD, ET POURQUOI C EST ACCEPTE : deux campagnes RCS qui pointent la MEME adresse partagent un
-- code, donc un compteur. C est exactement l approximation que le cote WhatsApp documente deja depuis la 0066
-- (« si le meme template sert dans deux blocs, les deux affichent le meme total »). Et depuis la 0106 chaque
-- clic porte SON contact et SA date : le detail par campagne reste reconstructible, il n est simplement pas
-- pre-agrege.
--
-- ⚠️ CE QU ON GAGNE, ET C EST LE POINT DECISIF : les quatre chemins d envoi RCS convergent deja sur UN SEUL
-- point de passage (`RcsSender.sendTo`), dont le commentaire dit pourquoi les mises en forme vivent la : « y
-- penser dans chaque appelant serait exactement le genre d oubli qui se voit six mois plus tard ». A cet
-- endroit, la seule identite disponible est l URL elle-meme. Toute autre cle obligerait a reecrire les liens
-- dans quatre appelants.

-- La colonne de la 0106, jamais ecrite, et son index. On la RETIRE au lieu de la laisser dormir : la contrainte
-- de famille ci-dessous l EXIGEAIT pour toute ligne sans template, donc la garder tout en la laissant vide
-- reviendrait a interdire la famille RCS avec une colonne morte pour seule explication.
drop index if exists tracked_links_bouton_rcs_uidx;
alter table tracked_links drop constraint if exists tracked_links_famille_chk;
alter table tracked_links drop column if exists rcs_message_id;

-- Un lien RCS ne vise aucun bouton en particulier : il vise une ADRESSE. `button_index` et `card_index`
-- n ont donc pas de valeur a porter, et ecrire un 0 de convenance serait un mensonge dans la donnee.
-- La contrainte de famille plus bas garde le NOT NULL la ou il a un sens, cote WhatsApp.
alter table tracked_links alter column button_index drop not null;

-- Une adresse = un code, par espace. `where template_name is null` isole la famille RCS : les lignes WhatsApp
-- gardent leur propre index d unicite (pose par la 0106), et rien n empeche la meme adresse d exister dans les
-- deux familles, ce qui est correct puisqu elles ne se mesurent pas ensemble.
--
-- ⚠️ Index sur une colonne texte libre : une URL demesuree ferait echouer l insertion (limite de page btree).
-- Le code s en protege en amont en NE TRACANT PAS les adresses trop longues (elles partent telles quelles,
-- non mesurees), parce qu un message doit toujours partir.
create unique index if not exists tracked_links_rcs_destination_uidx
  on tracked_links (tenant_id, destination) where template_name is null;

-- Une ligne appartient a UNE famille, et chaque famille porte exactement ses colonnes.
--   * WhatsApp : nom ET langue de template, et un index de bouton (la maille « un bouton = un lien ») ;
--   * RCS : ni l un ni l autre, et aucun index de bouton (la maille est l adresse).
-- Sans cette contrainte, une ligne a moitie remplie serait un lien que ni l une ni l autre des lectures ne
-- retrouverait, donc un lien mort dans des messages deja livres.
alter table tracked_links add constraint tracked_links_famille_chk
  check ((template_name is not null and template_language is not null and button_index is not null)
      or (template_name is null and template_language is null and button_index is null and card_index is null));
