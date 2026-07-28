# Usion City — production image.
#
# The server is a single pre-built file (dist/server.mjs) with the world
# engine inlined, so the image needs exactly two runtime dependencies and no
# access to the monorepo. Rebuild the artifact with `npm run build` before
# deploying; `npm test` fails if it is stale.
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY dist ./dist
COPY client ./client

EXPOSE 3040
CMD ["node", "dist/server.mjs"]
