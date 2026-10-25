FROM node:22-alpine
WORKDIR /app/apps/api
COPY apps/api/package.json ./package.json
RUN npm install
COPY apps/api/tsconfig.json ./tsconfig.json
COPY apps/api/src ./src
COPY db/init /app/db/init
RUN npm run build && npm prune --omit=dev
EXPOSE 3000
CMD ["npm", "run", "start"]
