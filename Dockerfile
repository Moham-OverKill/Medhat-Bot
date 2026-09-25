FROM node:18-alpine

WORKDIR /app

# Install fontconfig and fonts for canvas graphics rendering
RUN apk add --no-cache fontconfig ttf-dejavu

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production

CMD ["npm", "start"]
