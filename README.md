# Atelier éditorial collaboratif

Application web de rédaction collaborative, de gestion des versions et de publication de documents en PDF. Le projet comprend également son rapport de conception et ses diagrammes.

## Contenu du dépôt

- `application/` : application web, API, base PostgreSQL et worker de génération PDF.
- `Dossier de conception/` : rapport, sources LaTeX et diagrammes Mermaid.

## Lancer l’application en local

Prérequis : Node.js 22 ou plus récent, npm 10 ou plus récent, Docker et Docker Compose.

Dans un terminal, depuis le dossier du projet :

```sh
cd application
cp -n .env.example .env
npm install
sudo docker compose up --build -d
```

Configurez `ADMIN_EMAILS` et `ADMIN_BOOTSTRAP_PASSWORD` dans `application/.env`. Dans un second terminal :

```sh
cd application
npm run dev:web
```

Ouvrez ensuite <http://localhost:5173>. L’API écoute sur le port `3000` et PostgreSQL est publié sur le port `5433`. Un rédacteur peut créer un document, l’éditer et créer un lien public de téléchargement. Le rapport de conception en PDF se trouve dans `Dossier de conception/latex/main.pdf`.

Pour arrêter les services Docker :

```sh
cd application
sudo docker compose down
```
