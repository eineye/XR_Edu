# MR EDU MOBILE 2.0 관리자 서버 (화면 포함 단일 이미지)
# 웹 데모: docker run -p 8000:8000 -e MR_EDU_DEMO=1 mr-edu
FROM node:22-slim AS web
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
COPY backend/ backend/
COPY simulator/ simulator/
COPY --from=web /src/frontend/dist frontend/dist
WORKDIR /app/backend
EXPOSE 8000
CMD ["python", "-m", "app.main"]
