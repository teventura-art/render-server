FROM node:20-alpine

# Install FFmpeg and fonts
RUN apk add --no-cache \
    ffmpeg \
    font-dejavu \
    fontconfig \
    && fc-cache -f

WORKDIR /app

COPY package.json .
RUN npm install --production

COPY . .

RUN mkdir -p /app/videos /app/temp

EXPOSE 5001

CMD ["node", "server.js"]
