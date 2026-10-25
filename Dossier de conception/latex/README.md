# Cahier de conception LaTeX

La source de référence est désormais `main.tex`. Le PDF compilé est `main.pdf`.
La présentation suit une structure académique : couverture institutionnelle bilingue, résumé, abstract, glossaire, tables automatiques et chapitres d'analyse et de conception. Le logo ENSPY figure dans `assets/`.

## Compilation locale

Depuis ce dossier :

```sh
latexmk -pdf -interaction=nonstopmode -halt-on-error main.tex
```

Les auxiliaires restent locaux. Pour les nettoyer en conservant le PDF :

```sh
latexmk -c main.tex
```

Sur Overleaf, importer le contenu de ce dossier et choisir `main.tex` comme document principal, avec pdfLaTeX.

## Personnalisation

- `informations.tex` : auteur, classe, année et supervision.
- `couverture.tex` : couverture institutionnelle bilingue.
- `preambule.tex` : typographie, marges, couleurs et figures.
- `liminaires.tex` : résumé, abstract, sigles et glossaire.
- `chapitres/` : contenu rédactionnel éditable directement en LaTeX.

La supervision est indiquée comme « Pr Jean Marc Menaud ». Le nom de l'auteur reste à renseigner ; le nom figurant sur le modèle n'a pas été attribué automatiquement à ce projet.

## Insérer les diagrammes

Les codes Mermaid sont conservés dans `../diagrammes/`. Après rendu dans draw.io, exporter chaque image en **PDF ou PNG**, puis la déposer dans `images/` avec le même nom de base que sa source :

```text
../diagrammes/03_classes_metier.mmd
images/03_classes_metier.pdf
```

À la prochaine compilation, l'image remplace automatiquement son cadre. Aucun changement dans le texte n'est nécessaire. Le PDF est prioritaire sur le PNG si les deux existent. Les SVG doivent être convertis en PDF ou PNG avant insertion.

Les figures sont numérotées automatiquement par chapitre. Les préfixes 01 à 10 des fichiers sont des identifiants stables, indépendants des numéros imprimés.

Le PDF contient des emplacements réservés tant que les images ne sont pas fournies ; il ne prétend pas montrer les diagrammes rendus. Les sources Mermaid héritées restent à vérifier dans draw.io avant leur insertion définitive.

Les anciennes versions HTML et Word sont des versions antérieures. Les modifications futures doivent porter sur les fichiers `.tex`.
