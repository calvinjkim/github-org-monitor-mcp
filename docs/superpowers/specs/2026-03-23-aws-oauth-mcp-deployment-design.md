# GitHub Org Monitor MCP — AWS 배포 + OAuth 설계

## 개요

GitHub Org Monitor MCP 서버를 AWS Lambda에 배포하고, GitHub App OAuth 2.1 인증을 통해 claude.ai에서 팀원들이 각자의 GitHub 권한으로 사용할 수 있도록 한다.

## 결정사항

| 항목 | 결정 | 근거 |
|------|------|------|
| GitHub 인증 | GitHub App | 조직 도구에 적합, 세밀한 권한 제어, 단기 토큰 |
| AWS 인프라 | Lambda + API Gateway (HTTP API) | 간헐적 사용 패턴, 비용 최소화 |
| OAuth 구현 | Lambda에 직접 구현 | MCP 스펙 맞춤, 외부 의존성 최소 |
| 접근 제어 | fastfive-dev 조직 멤버만 허용 | 보안 |
| 토큰 저장 | DynamoDB | 영구 저장, 재로그인 불필요, 무료 티어 |
| IaC | AWS SAM | YAML 하나로 정리, Lambda에 최적화 |
| 접근 방식 | 단일 Lambda | 관리 포인트 최소화, 팀 규모에 적합 |

## 아키텍처

```
팀원 (claude.ai)
    │
    │  1. MCP 커넥터 추가 → /authorize
    │  2. GitHub 로그인 & App 권한 승인
    │  3. 콜백 → /callback → 토큰 저장
    │  4. MCP 도구 호출 → /mcp
    │
    ▼
API Gateway (HTTP API, HTTPS)
    │
    ▼
Lambda (단일 함수)
    ├── OAuth 2.1 핸들러
    │   ├── GET  /.well-known/oauth-authorization-server (메타데이터)
    │   ├── GET  /authorize (→ GitHub 리다이렉트)
    │   ├── GET  /callback (GitHub → 토큰 교환 → DynamoDB 저장)
    │   └── POST /token (claude.ai에 MCP 토큰 발급)
    │
    ├── MCP 핸들러
    │   └── POST /mcp (Streamable HTTP, 사용자별 GitHub 토큰으로 API 호출)
    │
    └── GET /health
    │
    ▼
DynamoDB (mcp-github-tokens)
    ├── pk: github_user_id (String, Hash Key)
    ├── access_token (GitHub App 사용자 토큰)
    ├── refresh_token
    ├── expires_at
    └── ttl (자동 만료)
```

## OAuth 2.1 상세 흐름

### 이중 토큰 구조

- **MCP 토큰**: claude.ai ↔ Lambda 간 인증 (자체 발급 JWT, subject에 GitHub user ID)
- **GitHub 토큰**: Lambda ↔ GitHub API 간 인증 (GitHub App이 발급, DynamoDB에 저장)

MCP 호출 시 JWT에서 사용자 ID 추출 → DynamoDB에서 GitHub 토큰 조회 → GitHub API 호출.

### 인증 시퀀스

```
claude.ai                    Lambda                   GitHub
   │                           │                        │
   │  1. GET /authorize        │                        │
   │  (code_challenge, state)  │                        │
   │ ────────────────────────► │                        │
   │                           │  2. 302 Redirect       │
   │                           │ ─────────────────────► │
   │                           │                        │
   │  3. 사용자: GitHub 로그인 & App 승인                │
   │                           │                        │
   │                           │  4. GET /callback      │
   │                           │  (code, state)         │
   │                           │ ◄───────────────────── │
   │                           │                        │
   │                           │  5. POST github/access_token
   │                           │ ─────────────────────► │
   │                           │  (사용자 토큰 수신)     │
   │                           │ ◄───────────────────── │
   │                           │                        │
   │                           │  6. GET /user          │
   │                           │  + GET /orgs/fastfive-dev/members
   │                           │  (사용자 정보 + 멤버십 검증)
   │                           │ ─────────────────────► │
   │                           │ ◄───────────────────── │
   │                           │                        │
   │                           │  7. DynamoDB에 토큰 저장│
   │                           │                        │
   │  8. 302 redirect back     │                        │
   │  (authorization_code)     │                        │
   │ ◄──────────────────────── │                        │
   │                           │                        │
   │  9. POST /token           │                        │
   │  (code, code_verifier)    │                        │
   │ ────────────────────────► │                        │
   │                           │                        │
   │  10. MCP access_token     │                        │
   │  (JWT)                    │                        │
   │ ◄──────────────────────── │                        │
```

### OAuth Authorization Server Metadata

`GET /.well-known/oauth-authorization-server` 응답:

```json
{
  "issuer": "https://{api-gateway-url}",
  "authorization_endpoint": "https://{api-gateway-url}/authorize",
  "token_endpoint": "https://{api-gateway-url}/token",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"]
}
```

### 보안 요소

- PKCE (S256) 필수 — MCP OAuth 2.1 스펙 요구사항
- state 파라미터로 CSRF 방지
- 조직 멤버십 검증 실패 시 403 반환
- GitHub 토큰은 DynamoDB에만 저장, 클라이언트에 노출되지 않음
- MCP 토큰은 JWT로 발급, Lambda에서 서명 검증

### 토큰 갱신

- GitHub App 사용자 토큰은 8시간 만료
- MCP 호출 시 만료 체크 → refresh_token으로 자동 갱신 → DynamoDB 업데이트
- 팀원은 재로그인 불필요

## 코드 구조

```
github-mcp/
├── src/
│   ├── index.ts              # 수정: Lambda 핸들러 추가 (stdio/Lambda 분기)
│   ├── github-client.ts      # 수정: 싱글톤 → 사용자별 인스턴스 팩토리
│   ├── oauth/
│   │   ├── handler.ts        # 신규: OAuth 엔드포인트 라우팅
│   │   ├── github-app.ts     # 신규: GitHub App OAuth 로직 (토큰 교환, 갱신)
│   │   ├── tokens.ts         # 신규: JWT 발급/검증, PKCE 처리
│   │   └── membership.ts     # 신규: 조직 멤버십 검증
│   ├── storage/
│   │   └── dynamo.ts         # 신규: DynamoDB 토큰 CRUD
│   ├── mcp/
│   │   └── handler.ts        # 신규: MCP Streamable HTTP 핸들러 (인증 미들웨어)
│   └── tools/                # 변경 없음
│       ├── commits.ts
│       ├── contributions.ts
│       ├── loc.ts
│       ├── org.ts
│       ├── pull-requests.ts
│       └── reviews.ts
├── infra/
│   └── template.yaml         # 신규: SAM 템플릿
├── samconfig.toml             # 신규: SAM 배포 설정
└── package.json               # 수정: 의존성 추가
```

### 핵심 변경 포인트

**`github-client.ts`** — 가장 중요한 변경:
- 현재: `GITHUB_TOKEN` 환경변수로 싱글톤 Octokit 생성
- 변경: 사용자별 토큰을 받아 Octokit 인스턴스를 생성하는 팩토리 패턴
- stdio 모드는 기존 환경변수 토큰 사용 (하위호환 유지)

**`index.ts`** — 진입점 분기:
- stdio 모드: 기존 그대로 (Claude Code 로컬 사용)
- Lambda 모드: API Gateway 이벤트를 OAuth/MCP 핸들러로 라우팅

**`tools/`** — 변경 없음:
- 이미 `GitHubClient` 인스턴스를 받아 사용하는 구조
- 클라이언트만 사용자별로 바뀌면 자연스럽게 권한 분리

### 새 의존성

- `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` — DynamoDB 접근
- `jsonwebtoken` + `@types/jsonwebtoken` — MCP 토큰 JWT 발급/검증

## 인프라 (SAM 템플릿)

### AWS 리소스

- **HTTP API (API Gateway v2)**: HTTPS 엔드포인트, CORS 설정
- **Lambda 함수**: Node.js 20.x, 256MB, 30초 타임아웃
- **DynamoDB 테이블**: PAY_PER_REQUEST, TTL 활성화

### 환경변수

| 변수 | 설명 | 출처 |
|------|------|------|
| `GITHUB_APP_CLIENT_ID` | GitHub App Client ID | GitHub App 설정에서 발급 |
| `GITHUB_APP_CLIENT_SECRET` | GitHub App Client Secret | GitHub App 설정에서 발급 |
| `JWT_SECRET` | MCP 토큰 서명용 시크릿 | 자체 생성 |
| `ALLOWED_ORG` | 허용 조직 이름 | `fastfive-dev` |
| `TOKEN_TABLE` | DynamoDB 테이블 이름 | SAM에서 자동 참조 |

### 비용 추정 (팀 16명)

- Lambda: 월 수백 호출 → 무료 티어 내
- API Gateway HTTP API: 100만 요청당 $1 → 거의 무료
- DynamoDB: 16건 토큰 저장 → 무료 티어 내
- **예상 월 비용: $0 ~ $1**

## 배포 및 사용

### 사전 준비 (1회)

1. GitHub App 생성 (`github.com/organizations/fastfive-dev/settings/apps/new`)
   - Callback URL: `https://{api-gateway-url}/callback`
   - 권한: Repository contents (read), Organization members (read)
   - fastfive-dev 조직에 설치
2. `sam deploy --guided` 로 AWS 배포
3. Client ID, Client Secret, JWT Secret 설정

### 배포 명령

```bash
npm run build
sam build
sam deploy --guided   # 최초 1회
sam deploy            # 이후 배포
```

### 팀원 사용 흐름

1. `claude.ai/settings/connectors` 접속
2. "Add Custom Connector" 클릭
3. MCP 서버 URL 입력: `https://{api-gateway-url}/mcp`
4. "Connect" → GitHub 로그인 페이지로 이동
5. GitHub App 권한 승인
6. 완료 — claude.ai에서 11개 MCP 도구 사용 가능

### 로컬 개발 (기존 그대로)

```bash
GITHUB_TOKEN=xxx node build/index.js          # stdio 모드
GITHUB_TOKEN=xxx node build/index.js --http   # HTTP 모드
```

Claude Code `.mcp.json` 설정 — 변경 없음.

## 하위호환성

- stdio 모드: 기존 동작 100% 유지
- HTTP 모드 (`--http`): 기존 동작 유지
- Lambda 모드: 새로 추가되는 진입점, 기존 코드에 영향 없음
- tools/ 디렉토리: 코드 변경 없음
