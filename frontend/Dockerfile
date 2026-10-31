# Sentinel dashboard — static build served by nginx (for self-hosting; Vercel builds it directly).
FROM node:22-alpine AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci
# The dashboard imports type definitions from the backend source (types only, erased at build).
COPY backend/src/types.ts ./backend/src/types.ts
COPY frontend ./frontend
ARG VITE_API_URL=http://localhost:4000
ENV VITE_API_URL=$VITE_API_URL
RUN cd frontend && npm run build

FROM nginx:1.29-alpine
COPY --from=build /app/frontend/dist /usr/share/nginx/html
RUN printf 'server {\n  listen 80;\n  root /usr/share/nginx/html;\n  add_header X-Content-Type-Options nosniff;\n  add_header Referrer-Policy no-referrer;\n  location /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; }\n  location / { try_files $uri /index.html; }\n}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 80
