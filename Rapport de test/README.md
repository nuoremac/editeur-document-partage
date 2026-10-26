# Rapport de tests

Ce dossier contient le rapport LaTeX et son PDF. Le contenu après la page de garde est composé en noir sur blanc. Les résultats sont ceux mesurés localement le 26 octobre 2026; ils ne démontrent pas encore la cible AWS de 15 000 visiteurs et 300 rédacteurs.

Le sous-dossier `preuves/` conserve les sorties de compilation et d’intégration, les résultats JSON de charge et du parcours PDF, des rendus visuels en noir et blanc dérivés de ces sorties, ainsi que leurs empreintes SHA-256. Les images sont des extraits illustratifs; les journaux bruts restent la preuve de référence. Les scripts reproductibles sont dans `outils/`. Le rapport précise que la pièce de facturation AWS reste à fournir après un déploiement réel. Pour contrôler l’intégrité des journaux et des captures :

```sh
sha256sum -c preuves/SHA256SUMS
```

Pour reconstruire le PDF depuis ce dossier :

```sh
pdflatex -interaction=nonstopmode -halt-on-error main.tex
pdflatex -interaction=nonstopmode -halt-on-error main.tex
```

Le rapport doit être mis à jour après la campagne complète sur l’environnement AWS, avec les mesures brutes et les journaux associés.
