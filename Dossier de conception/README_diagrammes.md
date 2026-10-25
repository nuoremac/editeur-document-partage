# Diagrammes du cahier de conception

Les fichiers `.mmd` constituent les sources Mermaid du cahier d'analyse et de conception LaTeX. Les identifiants 01 à 10 restent stables ; le diagramme 11 détaille la création du lien limité. Les numéros imprimés des figures sont calculés automatiquement par chapitre.

| Identifiant | Fichier | Type |
|---|---|---|
| 1 | `01_cas_utilisation.mmd` | Cas d'utilisation représentés par un flowchart |
| 2 | `02_architecture_generale.mmd` | Architecture logique |
| 3 | `03_classes_metier.mmd` | Diagramme de classes UML |
| 4 | `04_sequence_edition.mmd` | Diagramme de séquence |
| 5 | `05_sequence_telechargement.mmd` | Diagramme de séquence |
| 6 | `06_sequence_credit.mmd` | Diagramme de séquence |
| 7 | `07_etats_lien.mmd` | Diagramme états-transitions |
| 8 | `08_composants.mmd` | Diagramme de composants simplifié |
| 9 | `09_deploiement_aws.mmd` | Diagramme de déploiement |
| 10 | `10_activite_pic.mmd` | Diagramme d'activité simplifié |
| 11 | `11_sequence_creation_lien_limite.mmd` | Création d'un lien de téléchargement limité |

## Utilisation dans draw.io

1. Ouvrir le fichier `.mmd` avec un éditeur de texte et copier tout son contenu.
2. Dans draw.io, utiliser la fonction d'insertion Mermaid, puis coller le code.
3. Générer le diagramme et corriger manuellement la disposition si nécessaire.
4. Exporter en PDF vectoriel ou PNG haute résolution.
5. Déposer l'image dans `latex/images/`, avec le même nom de base que le fichier Mermaid (exemple : `03_classes_metier.pdf`).
6. Depuis `latex/`, exécuter `latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex`. Le cadre correspondant est automatiquement remplacé par l'image, avec sa légende et ses renvois.

Le fichier principal est `latex/main.tex` ; le document compilé est `latex/main.pdf`. Modifier les fichiers `.tex`, jamais les fichiers générés `.toc`, `.aux` ou `.lof`. Les versions HTML et Word sont des versions antérieures.

Le diagramme de cas d'utilisation est exprimé sous forme de flowchart parce que Mermaid ne possède pas de syntaxe UML native pour ce diagramme. Dans draw.io, il peut être redessiné avec les symboles UML `Actor` et `Use Case` en conservant exactement les mêmes acteurs et fonctionnalités.

## Contrôles de cohérence

- Un objet recevant un message dans un diagramme de séquence doit posséder l'opération correspondante dans le modèle détaillé.
- Les noms `Document`, `VersionDocument`, `LienTelechargement`, `Reservation` et `CreditJournalier` doivent rester identiques dans le cahier, le code et l'API.
- Si l'architecture réellement implémentée change, modifier la figure, son texte d'accompagnement et la matrice de traçabilité.
- Conserver les fichiers `.mmd` dans le dépôt afin que les diagrammes restent reproductibles.
