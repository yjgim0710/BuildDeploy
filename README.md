# Jenkins View Build Trigger (Node)

Jenkins view를 선택하고, 해당 view 안에서 `-frontend`가 포함된 job만 체크박스로 선택 빌드하는 Node 웹앱입니다.
선택한 frontend job이 모두 성공하면 같은 view의 `-nignx`가 포함된 job을 후속 빌드합니다.

## 기능
- Jenkins view 목록 조회 및 선택
- 선택 view 내 `-frontend` job만 체크박스 표시
- 후속 `-nignx`/`-nginx` 대상은 라디오로 1개 선택
- 제외할 job 문자열을 콤마(`,`)로 입력해 대상에서 제외
- 선택한 frontend job 병렬 빌드 + 결과 대기
- frontend 전부 성공 시 선택한 `-nignx` job 빌드
- nginx 실행 시 `IMAGE_NAME`은 수동 입력 우선, 미입력 시 `이전 빌드 파라미터 -> Jenkins job config -> .env fallback` 순으로 찾고 patch 버전(+1) 자동 증가
- nginx 빌드 성공 후 Jenkins job `config.xml`의 `IMAGE_NAME` 기본값/파이프라인 값도 새 버전으로 저장
- Jenkins crumb(CSRF) 자동 처리

## 빠른 시작
1. 환경 변수 준비
```bash
cp .env.example .env
```

2. `.env` 수정
```env
PORT=3000
JENKINS_URL=http://jenkins.local
JENKINS_USER=jenkins-user
JENKINS_API_TOKEN=replace-with-api-token
FRONTEND_KEYWORD=-frontend
NGINX_KEYWORDS=-nignx
DEFAULT_EXCLUDE_JOBS=nginx, msa, imp, api-mapper, user-mgmt, company-mgmt, sr-, private-cloud, cm-, tm-, pm-, devops-
POLL_INTERVAL_MS=3000
JOB_TIMEOUT_MS=1800000

# Optional image versioning behavior for nginx job
NGINX_IMAGE_PARAM_NAME=IMAGE_NAME
NGINX_DEFAULT_IMAGE_NAME=harbor-product.strato.co.kr:8443/develop/strato-frontend:1.0.0
```

3. 실행
```bash
npm start
```

4. 접속
- [http://localhost:3000](http://localhost:3000)

## API
- `GET /api/views`: Jenkins view 목록
- `GET /api/views/:viewName/jobs`: 해당 view의 frontend/nginx 매칭 job 목록
- `POST /api/trigger`: 선택한 frontend job 실행 후 성공 시 nginx 실행

Request body 예시:
```json
{
  "viewName": "my-view",
  "jobs": ["service-a-frontend", "service-b-frontend"]
}
```

## 참고
- job 이름 매칭 기준은 기본값으로 `-frontend`, `-nignx`입니다.
- Jenkins에는 트리거 전용 사용자/토큰 사용을 권장합니다.
