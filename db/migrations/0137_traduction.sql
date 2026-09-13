-- 0137_traduction.sql : garder la traduction A COTE de l original, jamais a sa place.
--
-- 🔴 EN ENTREE ET EN SORTIE, LE SENS S INVERSE, et c est le piege de ce lot.
-- Entrant : `body` garde ce que le client a ECRIT, `traduction` porte notre lecture.
-- Sortant : `body` garde ce qui est PARTI (donc le texte traduit, c est ce que le client a recu et
-- notre trace doit y correspondre le jour d un litige), et `redaction_origine` garde ce que
-- l operateur a ECRIT, sans quoi il ne peut plus se relire.
-- Ne garder qu un des deux est faux dans les deux sens : le traduit seul rend l operateur aveugle a
-- sa propre conversation, l original seul rend notre historique mensonger.
--
-- 🔴 BLOQUANTE. ELLE PASSE AVANT LE DEPLOIEMENT, SANS EXCEPTION, et c est la lecon de la 0133 (et
-- avant elle celle du 2026-08-17, 1 h 30 sans enregistrer un seul message entrant). Ces colonnes ne
-- sont pas seulement ECRITES : elles sont NOMMEES dans des `select` du chemin chaud. `getMessages`
-- (le fil, rafraichi toutes les 4 secondes) liste `traduction`, `traduction_langue`,
-- `redaction_origine` et `transcription_langue` ; `getConversationContext` liste
-- `contacts.langue_detectee`. Sans ces colonnes, Postgres rend `42703 column does not exist` et
-- l Inbox entiere tombe. Le `?? null` du code protege une valeur absente d un objet, pas une
-- colonne absente d une table.
alter table conversation_messages add column if not exists traduction text;

-- 🔴 LA LANGUE DE LA TRADUCTION EST BORNEE A NOS DEUX LANGUES DE CONSOLE, et c est ce qui rend la
-- reutilisation sure. Le fil est relu avec une cible (`?traduire=fr`) : si la traduction rangee
-- n est pas dans cette langue, on retraduit. Une valeur hors de cet ensemble ne pourrait donc
-- jamais etre reconnue comme « deja traduit », et on repaierait la meme traduction a chaque
-- ouverture sans que rien ne le signale.
alter table conversation_messages add column if not exists traduction_langue text
  check (traduction_langue is null or traduction_langue in ('fr', 'en'));

alter table conversation_messages add column if not exists redaction_origine text;

-- LA LANGUE DETECTEE D UNE TRANSCRIPTION, qu on jetait (migration 0125).
--
-- ⚠️ `transcrire` (src/agent/llm/transcription.ts) rend deja `langue` et personne ne la gardait :
-- c est la troisieme donnee de ce genre trouvee la meme semaine, apres le verdict de joignabilite
-- WhatsApp. Elle sert deux fois : eviter de traduire un vocal deja dans la langue du lecteur (un
-- appel de modele paye pour rien), et alimenter la langue du contact ci-dessous.
--
-- ⚠️ PAS de contrainte sur les valeurs, contrairement a `traduction_langue` : un contact parle la
-- langue qu il veut, ce sont NOS deux langues qui sont bornees, pas les siennes.
alter table conversation_messages add column if not exists transcription_langue text;

-- La langue du contact, APPRISE et jamais demandee. `null` = on ne sait pas encore, et ce n est
-- pas « francais » : supposer ferait envoyer la mauvaise langue en silence.
-- ⚠️ Pas de contrainte sur les valeurs, meme raison que ci-dessus.
alter table contacts add column if not exists langue_detectee text;

-- ⚠️ LA DATE EST A PART, et elle est REECRITE a chaque apprentissage meme quand la valeur ne change
-- pas : meme forme que `whatsapp_joignable_le` (0133). Sans elle, « ce contact ecrit en espagnol »
-- est une affirmation sans age, et le cadrage previent qu elle peut etre FAUSSE une fois (un
-- francophone qui repond « ok » ou par un emoji). Savoir de quand date la mesure est ce qui permet
-- de la corriger plutot que de la subir.
alter table contacts add column if not exists langue_detectee_le timestamptz;

-- Aucun index, et c est delibere. Les trois seuls chemins de lecture (« le fil de CETTE
-- conversation », « le contexte de CETTE conversation », « ce message est-il deja traduit ? »)
-- passent par la conversation ou par la cle primaire. Un index de plus serait de l ecriture en plus
-- sur la table la plus ecrite du produit, pour une requete que personne n ecrit.
