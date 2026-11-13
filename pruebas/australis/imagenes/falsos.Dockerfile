FROM node:22-alpine
WORKDIR /app
COPY falsos/falsos.mjs ./falsos.mjs
USER node
EXPOSE 8090 8091 9000
CMD ["node", "falsos.mjs"]
