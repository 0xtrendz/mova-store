# Pinned production build for Railway.
#
# Why this exists instead of Railpack's auto-detected build: Railpack reuses a
# cached node_modules between builds, and after the failed @stellar/stellar-sdk
# v17 build that cache left a mix of v17 and v16 package files behind. The result
# was a build that reported installing @stellar/stellar-sdk@16.3.0 while webpack
# resolved a path (`./xdr/index.js`) that only exists in the v17 layout, so the
# build failed with an unresolvable module that does not exist in the version it
# claimed to install.
#
# Building in an explicit image with `npm ci` makes the install reproducible from
# the lockfile and immune to a poisoned package cache. `npm ci` also removes
# node_modules first, which is exactly the property that was missing.
#
# Node 20 matches .nvmrc.
#
# Note: the NEXT_PUBLIC_* values must be present at *build* time - Next.js inlines
# them into the client bundle, and lib/supabase.js throws while collecting page
# data if the Supabase pair is missing. Railway injects the service variables into
# the build, so no --build-arg wiring is needed here.

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:20-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next

EXPOSE 3000
CMD ["npm", "start"]
