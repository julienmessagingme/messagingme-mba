/**
 * Les plafonds de poids d'une pièce jointe donnée à l'assistant de construction d'un agent, en octets. Les nôtres :
 * les octets traversent notre API, l'extraction tourne dans le processus, et une image part chez un fournisseur qui la
 * facture, d'où un plafond plus serré pour elle. L'écran refuse AVANT de téléverser, le serveur en dernier ressort : un
 * écran qui annoncerait un autre chiffre promettrait ce que le serveur refuse, avec un 413 que personne ne relie.
 */
export const TAILLE_DOCUMENT_MAX = 8 * 1024 * 1024;
export const TAILLE_IMAGE_MAX = 5 * 1024 * 1024;
