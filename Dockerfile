FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8000

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --chown=node:node . .

USER node

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const http=require('http'); const port=process.env.PORT||8000; const path='/app'; const req=http.get({host:'127.0.0.1',port,path,timeout:2000},res=>{res.resume(); process.exit(res.statusCode<500?0:1);}); req.on('error',()=>process.exit(1)); req.on('timeout',()=>{req.destroy(); process.exit(1);});"

CMD ["npm", "start"]
