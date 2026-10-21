Je voudrais créer une application web qui sera comme paperless-ngx. En gros elle permettera de ranger factures, bulletins de paye, notices d'utilisation etc...

En gros je veux une super belle interface moderne où je peux ranger mes documents, les retrouver facilement, les classer, les télécharger et les partager.

Cette application devra aussi etre responsive et adaptée pour mobile car je voudrais qu'on l'adapte pour une PWA.

Le serveur s'exécutera sous Debian avec une image dédiée pour .deb x86 et arm64 ainsi que docker.

J'aimerais qu'on inclut aussi un système de mises à jour, un système de sauvegarde de la base de données SQLite et de tout l'ensemble des documents et paramètres (tags...) et d'import.

J'aimerais qu'on inclut une barre de recherche aussi. Le serveur tournera sur le port 3001 et on demandera de créer un compte administrateur (je ne veux pas de coder à retrouver dans des logs).

J'aimerais aussi qu'on ai un lecteur PDF pour lire le document, et que lors de l'ajout on puisse lire tout le contenu à partir de mots clés saisis dans la barre de recherche on peut retrouver plus rapidement le document.

Je voudrais une application très moderne, responsive et PWA.

En terme de stack voici ce que j'aimerais avoir :
- React
- TailwindCSS
- SQLite

Je veux aucune communication avec des CDN tiers (comme Google Fonts par exemple)
