FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY contract ./contract
RUN npm run build && npm prune --omit=dev --ignore-scripts
FROM node:22-bookworm-slim
ENV NODE_ENV=production ALPHAPILOT_MCP_HOST=0.0.0.0 ALPHAPILOT_MCP_PORT=19902 ALPHAPILOT_MCP_CREDENTIAL_DIR=/credentials
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/contract ./contract
COPY package.json ./
USER node
EXPOSE 19902
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:19902/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve", "--transport", "http"]
