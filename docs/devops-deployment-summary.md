# GitHub Org Monitor MCP — AWS 배포 요약

## 뭘 하려는 건지

플랫폼개발팀이 쓰는 GitHub 조직 활동 모니터링 MCP 서버(커밋, PR, 리뷰, LOC 분석 등 11개 도구)를 **AWS에 배포**해서, 팀원들이 **claude.ai에서 직접** 사용할 수 있게 하려고 합니다. 각 팀원이 GitHub OAuth로 로그인하면 **본인 권한 범위 내에서만** 데이터에 접근합니다.

## 아키텍처

```
claude.ai → API Gateway (HTTP API) → Lambda (단일) → GitHub API
                                         ↕
                                      DynamoDB
```

## 필요한 AWS 리소스

| 리소스 | 스펙 | 비용 |
|--------|------|------|
| **Lambda** | Node.js 20.x, 256MB, 60s timeout | 무료 티어 |
| **API Gateway** | HTTP API (v2), HTTPS | 거의 무료 |
| **DynamoDB** | PAY_PER_REQUEST, TTL 활성화 | 무료 티어 |

**예상 월 비용: $0 ~ $1** (16명, 간헐적 사용)

## 배포 방식

- **IaC: AWS SAM** (`infra/template.yaml`)
- `sam build && sam deploy`로 배포
- 코드는 이미 완성, SAM 템플릿도 준비됨

## SAM이 만드는 것

- API Gateway HTTP API (6개 라우트: OAuth 4개 + MCP 1개 + health 1개)
- Lambda 함수 1개 (모든 라우트 처리)
- DynamoDB 테이블 1개 (`mcp-github-tokens`)
- IAM 역할 (Lambda → DynamoDB CRUD)

## 환경변수 (Lambda에 설정)

| 변수 | 설명 |
|------|------|
| `GITHUB_APP_CLIENT_ID` | GitHub App에서 발급 |
| `GITHUB_APP_CLIENT_SECRET` | GitHub App에서 발급 (NoEcho) |
| `JWT_SECRET` | MCP 토큰 서명용 (NoEcho) |
| `ALLOWED_ORG` | `fastfive-dev` |
| `TOKEN_TABLE` | SAM이 자동 참조 |
| `BASE_URL` | SAM이 API Gateway URL로 자동 설정 |

## 보안

- OAuth 2.1 + PKCE (S256) — claude.ai MCP 스펙 요구사항
- fastfive-dev 조직 멤버만 접근 가능 (멤버십 검증)
- GitHub 토큰은 DynamoDB에만 저장, 클라이언트 노출 없음
- 인증코드 10분 TTL, 일회용

## DevOps에게 필요한 것

1. SAM 배포할 AWS 계정/리전 확인 (ap-northeast-2 예정)
2. 배포 IAM 권한 (CloudFormation, Lambda, API Gateway, DynamoDB, IAM 생성 권한)
3. 필요하면 기존 CI/CD 파이프라인에 통합
