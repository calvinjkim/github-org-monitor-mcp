# GitHub Org Monitor MCP Server

GitHub 조직의 활동을 모니터링하고 인원별 퍼포먼스를 측정하기 위한 MCP 서버입니다.

## 기능

| Tool | 설명 |
|------|------|
| `list_org_members` | 조직 멤버 목록 조회 |
| `list_org_teams` | 조직 팀 목록 조회 |
| `list_team_members` | 특정 팀 멤버 목록 조회 |
| `list_org_repos` | 조직 레포지토리 목록 조회 |
| `get_user_commits` | 사용자별 커밋 통계 |
| `get_user_prs` | 사용자별 PR 통계 (생성/머지/평균 머지 시간) |
| `get_user_reviews` | 사용자별 코드 리뷰 활동 |
| `get_user_loc` | 사용자별 LOC (추가/삭제 라인 수) |
| `get_repo_contributors` | 레포별 기여자 순위 |
| `get_repo_stats` | 레포 전체 통계 요약 |
| `get_member_activity` | 멤버 전체 활동 종합 요약 |

## 설치

```bash
cd github-mcp
npm install
npm run build
```

## 환경변수

| 변수 | 필수 | 설명 |
|------|------|------|
| `GITHUB_TOKEN` | Yes | GitHub Personal Access Token (`repo`, `read:org` 스코프 필요) |

GitHub PAT 생성: https://github.com/settings/tokens

## 실행 모드

### 1. Claude Code (stdio 모드, 기본)

프로젝트 루트 또는 `~/.claude/`에 `.mcp.json` 파일 생성:

```json
{
  "mcpServers": {
    "github-org-monitor": {
      "command": "node",
      "args": ["/absolute/path/to/github-mcp/build/index.js"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token_here"
      }
    }
  }
}
```

### 2. HTTP 서버 모드 (독립 실행)

다른 MCP 클라이언트나 커스텀 앱에서 사용할 때:

```bash
# 기본 포트 3100으로 실행
GITHUB_TOKEN=ghp_your_token_here node build/index.js --http

# 포트 지정
GITHUB_TOKEN=ghp_your_token_here node build/index.js --http --port 8080
```

- MCP 엔드포인트: `http://localhost:3100/mcp`
- 헬스체크: `http://localhost:3100/health`

## 사용 예시

Claude Code에서:

- "우리 org의 멤버 목록을 보여줘"
- "지난 한 달간 username의 커밋 수는?"
- "repo-name의 기여자 순위를 알려줘"
- "username의 지난 분기 PR과 리뷰 통계를 보여줘"
- "2024년 1월부터 3월까지 username의 LOC를 분석해줘"

## 날짜 필터

모든 통계 도구는 `since`와 `until` 파라미터를 지원합니다:
- ISO 8601 형식: `2024-01-01` 또는 `2024-01-01T00:00:00Z`
- 생략 시 전체 기간 조회

## API 제한사항

- GitHub API: 인증된 요청 5,000/hour
- Search API: 30 requests/minute
- Stats API: 캐시 미생성 시 202 응답 후 재시도 (최대 3회)
- 대규모 조직의 경우 전체 레포 스캔 시 시간이 걸릴 수 있음
