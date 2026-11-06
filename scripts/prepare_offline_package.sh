#!/usr/bin/env bash
# 인터넷이 되는 PC에서 실행: 오프라인 설치 패키지(wheels + 빌드된 화면) 준비
# Windows 관리자 PC용 wheel 을 받으려면: PLATFORM=win_amd64 PYVER=312 ./scripts/prepare_offline_package.sh
set -e
cd "$(dirname "$0")/.."
PLATFORM=${PLATFORM:-}
PYVER=${PYVER:-}
if [ -n "$PLATFORM" ]; then
  pip download -r backend/requirements.txt -d wheels --only-binary=:all: --platform "$PLATFORM" --python-version "$PYVER"
else
  pip download -r backend/requirements.txt -d wheels
fi
(cd frontend && npm ci && npm run build)
echo "준비 완료: wheels/ 와 frontend/dist/ 를 포함해 폴더 전체를 관리자 PC로 복사하세요."
