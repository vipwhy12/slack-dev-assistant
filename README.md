# slack-dev-assistant

Slack 스레드의 논의를 원문 근거가 연결된 개발 요구사항으로 정리하는 TypeScript/Node.js CLI입니다. 첫 MVP는 `analyze`와 사람의 검토 이력에 집중합니다. 요구사항의 논의 상태와 사람이 검토한 상태를 분리하며, 분석 결과가 코드 실행 권한을 부여하지 않습니다.

## 구현 범위

- Slack Web API를 통한 스레드 수집, 페이지 처리, 메시지 버전과 원문 링크 보존
- 프로젝트별 Slack 워크스페이스·채널 허용 범위 확인
- Zod 기반 요구사항·질문·수용 기준 스키마 및 원문 인용 검증
- `confirmed`, `proposed`, `open`, `rejected`, `superseded` 구분
- 원문에 명시된 수용 기준(`source`)과 분석기가 제안한 기준(`derived`) 구분
- SQLite 실행 이력, 불변 스냅샷, 분석 및 사람의 수정 버전, 단계·실패 기록
- JSON·Markdown 결과물, 동일 입력 재사용, 명시적 재분석(`--force`)
- 네트워크와 API 키가 필요 없는 합성 예제 및 자동 테스트

`plan`과 `implement`는 확장을 위한 명령 경계만 정의되어 있습니다. 호출하면 미지원 오류로 종료합니다. 현재 버전은 저장소 코드를 변경하거나 PR을 생성하지 않습니다.

## 시작하기

Node.js **24 이상**과 npm이 필요합니다. SQLite는 Node.js 내장 `node:sqlite`를 사용하므로 별도 데이터베이스 서버나 네이티브 애드온 설치가 필요하지 않습니다. 일부 Node.js 24 버전은 SQLite experimental 경고를 표시할 수 있습니다.

```sh
git clone https://github.com/vipwhy12/slack-dev-assistant.git
cd slack-dev-assistant
npm ci
npm run check
```

합성 예제를 실행합니다. 이 명령은 Slack이나 모델 API를 호출하지 않습니다.

```sh
node dist/cli.js analyze \
  'https://example.slack.com/archives/CDEMO12345/p1795046400000001' \
  --config examples/project.json \
  --snapshot examples/thread.json \
  --analysis-file examples/analysis.json

node dist/cli.js history --config examples/project.json --limit 20
```

`examples/`의 대화·인물·요구사항은 모두 가상 데이터입니다. 동일 명령을 다시 실행하면 입력이 같은 완료 결과를 재사용합니다. 새 실행을 남기려면 `--force`를 추가합니다. 개발 중에는 `node dist/cli.js` 대신 `npm run dev --`를 사용할 수 있습니다.

## 실제 Slack 연결

1. Slack 앱을 만들고 대상 워크스페이스에 설치합니다.
2. 대상 채널 스레드를 읽을 수 있는 OAuth 토큰을 준비합니다. 공개 채널은 `channels:history`, 비공개 채널은 `groups:history` 권한과 대상 채널 접근 권한이 필요합니다. 현재 `conversations.replies` 공식 문서는 봇·사용자 토큰을 지원 대상으로 안내합니다. 실제 토큰과 채널 조합은 작은 스레드로 먼저 확인하세요.
3. `.env.example`을 `.env`로 복사하고 `SLACK_TOKEN`, `OPENAI_API_KEY`를 설정합니다. `.env`는 CLI를 실행하는 현재 디렉터리에서 읽습니다.
4. 프로젝트 설정에서 실제 워크스페이스와 허용 채널을 지정합니다. 설정 파일에 토큰을 넣지 않습니다.

```json
{
  "projectId": "orders-service",
  "slack": {
    "workspace": "your-workspace",
    "channelIds": ["C0123456789"]
  },
  "storageDir": ".slack-dev",
  "repoPath": ".",
  "model": "gpt-4.1-mini"
}
```

`workspace`는 `.slack.com`을 제외한 서브도메인입니다. `storageDir`, `repoPath`는 **설정 파일 디렉터리 기준**으로 해석합니다. `repoPath`는 선택 사항이며 Git 커밋 정보를 기록하는 데 사용합니다. 모델은 계정에서 사용 가능한 구조화 출력 지원 모델로 변경할 수 있습니다.

```sh
node dist/cli.js analyze \
  'https://your-workspace.slack.com/archives/C0123456789/p1795046400000001' \
  --config project.json
```

실제 분석 시 수집한 스레드 텍스트가 설정된 OpenAI 모델 API로 전송됩니다. 접근 가능한 채널 중에서도 설정에 허용된 채널만 수집합니다. API 키는 환경 변수로 전달하며 결과물과 이력에 저장하지 않습니다. 메시지 텍스트에 포함된 지시문은 분석 대상 데이터로 취급합니다.

Slack API의 권한·보존 정책에 따라 원문을 전부 읽지 못할 수 있습니다. 수집이 불완전하면 `needs_input`으로 기록하고 모델 분석을 중단합니다. 첨부 파일 본문은 수집하지 않으며 첨부 존재와 경고를 보존합니다. 권한 설정 및 API 호출 제한은 [Slack conversations.replies 문서](https://docs.slack.dev/reference/methods/conversations.replies/)를 확인하세요.

## 명령

| 명령 | 용도 |
| --- | --- |
| `analyze <thread-url> --config <file>` | Slack 스레드를 수집하고 요구사항을 분석합니다. |
| `analyze ... --snapshot <file>` | 검증된 스냅샷 파일로 Slack 수집을 대체합니다. |
| `analyze ... --analysis-file <file>` | Zod 스키마의 JSON 파일로 모델 호출을 대체합니다. 원문 검증은 그대로 수행합니다. |
| `analyze ... --force` | 같은 입력이어도 새 실행을 생성합니다. |
| `history --config <file> --limit 20` | 실행 목록을 조회합니다. |
| `show <runId> --config <file>` | 실행의 결과·수정 버전·단계·개입 기록을 JSON으로 조회합니다. |
| `review <runId> --file <file> --reason <text> --minutes <n> --config <file>` | 사람이 수정한 분석 JSON을 검증하고 별도 버전으로 기록합니다. |
| `plan`, `implement` | 현재 MVP에서는 지원하지 않습니다. |

`--snapshot`은 스키마, 스레드 식별자와 메시지 원문 링크를 검증한 뒤 실제 내용으로 `contentHash`를 다시 계산합니다. 파일에 들어 있는 기존 해시를 무결성 서명으로 신뢰하지 않습니다. `--analysis-file`은 `examples/analysis.json`과 같은 분석 객체를 받습니다. 실행 결과 전체를 그대로 넣는 형식은 아닙니다.

`--config`를 생략하면 현재 디렉터리의 `slack-dev.config.json`을 읽습니다. `analyze`는 stdout에 `runId`, `requestRunId`, `status`, `reused`, `reportPath`를 담은 JSON을 출력합니다. 재사용된 경우 `runId`는 원래 분석 실행, `requestRunId`는 이번 요청 기록을 가리킵니다. 사람이 검토한 수정본이 있으면 `reportPath`는 가장 최근에 수락된 수정본의 보고서를 가리키며, 검토 이력이 없으면 모델 초안 보고서를 가리킵니다.

모델 초안은 차단 질문이 없어도 사람 검토 전까지 `needs_input`입니다. 검토 후 차단 질문이 없으면 `ready`, 남아 있으면 `needs_input`으로 유지합니다. `ready`도 구현 실행 허가는 아닙니다. 정상 보고서 생성·재사용의 종료 코드는 `0`, 부분 수집으로 분석이 중단된 경우는 `2`, 오류는 `1`입니다. 자동화에서는 종료 코드와 `status`를 함께 확인하세요.

## 원문 근거와 검토

각 요구사항과 원문 기반 수용 기준에는 `sourceRefs`가 있습니다. 근거는 `messageVersionId`와 **원문에 실제 존재하는 인용문**을 지정합니다. 보고서에서는 해당 메시지의 Slack 링크를 확인할 수 있습니다. 모델이 임의 링크를 만들거나 존재하지 않는 메시지를 참조하면 결과를 거부합니다.

```json
{
  "messageVersionId": "demo-message-1-v1",
  "quote": "파일은 UTF-8로 인코딩해 주세요."
}
```

`decisionState: "confirmed"`는 대화에서 확정된 요구사항이라는 분석입니다. 사람의 검토 완료나 구현 허가와는 별개입니다. 분석기는 검토 상태를 출력할 수 없습니다. 미해결 질문은 `blockingQuestionIds`와 `affectedRequirementIds` 양쪽에서 연결하고, 파생 수용 기준은 `derived`로 표시합니다. 구조·인용 검증이 요구사항 해석의 정확성까지 보장하지는 않으므로 실제 적용 전에는 원문과 결과를 검토해야 합니다.

분석 JSON을 복사해 사람이 수정한 후 검토 기록을 남깁니다.

```sh
node dist/cli.js review '<runId>' \
  --file reviewed-analysis.json \
  --reason '시간대 결정은 미확정이므로 질문으로 유지' \
  --minutes 5 \
  --config project.json

node dist/cli.js show '<runId>' --config project.json
```

이 명령은 원본 분석을 덮어쓰지 않습니다. 수정본, 이유, 소요 시간, 로컬 사용자 정보를 별도로 저장합니다. `review`는 실행 권한을 부여하지 않으며 로컬 사용자 기록은 인증 시스템이나 전자 서명이 아닙니다.

검토자 이름은 기본적으로 OS 사용자명이며 `--actor <name>`으로 지정할 수 있습니다. 검토 결과 파일은 해당 실행의 `reviews/<revisionId>/`에 저장됩니다.

## 저장되는 데이터

설정한 `storageDir`에 `history.sqlite`와 실행별 결과를 저장합니다.

- `snapshot.json`: 수집 당시 메시지와 버전·원문 링크·수집 경고
- `analysis.json`: 검증된 구조화 분석
- `report.md`: 사람이 읽을 수 있는 요구사항과 근거 보고서
- `metadata.json`: 입력·스키마·프롬프트·모델·Git 버전, 초기 검토 상태와 모델 토큰 사용량
- SQLite: 실행 상태, 단계, 오류, 설정·모델·프롬프트·Git 정보 및 검토 이력

실행별 파일은 `runs/<runId>/` 아래에 있습니다. 부분 수집이나 실패한 실행에는 결과물이 일부만 남을 수 있으므로 파일 존재만으로 완료를 판단하지 말고 `history` 또는 `show`의 상태를 확인합니다. 초기 `metadata.json`의 검토 상태는 생성 당시의 값이며 최신 검토 이력은 `show`로 확인합니다.

모델이 반환한 토큰 사용량은 `metadata.json`의 `usage`에 기록하며, 파일 재생처럼 사용량이 없으면 `null`입니다. 비용은 추정하지 않으며 `cost`는 `null`입니다.

저장 경로에는 Slack 원문이 포함됩니다. `.env`, 실행 데이터와 SQLite 파일은 Git 추적 대상에서 제외합니다. MVP의 로컬 저장소는 암호화·보존 기간 관리·원격 감사 서버를 제공하지 않습니다. 메시지 수정 후 재수집하면 내용 해시가 달라져 새 분석으로 처리하며, 기존 실행은 당시 원문 버전을 보존합니다.

## 개발과 검증

```sh
npm run typecheck
npm test
npm run build
# 위 세 단계를 한 번에 실행
npm run check
```

자동 테스트는 Slack과 모델 호출을 대체해 네트워크·비밀 키 없이 실행합니다. 수집 페이지 처리, 권한 범위, 부분 수집, 잘못된 근거, 분석 스키마, 이력과 재실행 동작을 검증합니다. GitHub Actions에서도 Node.js 24로 전체 검사와 합성 CLI 예제를 실행합니다.

실제 워크스페이스와 API 키를 사용하는 검증은 별도 단계입니다. 작은 스레드 하나로 권한·페이지 처리·원문 링크·요구사항 품질을 먼저 확인한 뒤 사용 범위를 넓히세요.

설계의 경계와 확장 방식은 [아키텍처 문서](docs/architecture.md)에 설명합니다. 기준 설계는 [Slack 논의 기반 개발 보조 도구 설계안](https://chatgpt.com/space/page_ee5453d201508191b26f17dc9f064f95)입니다.
