# 동인고 학습지 풀이 앱 (Costudy)

동인고 1학년 학생을 위한 학습지 풀이 학습 웹앱. 학생이 **학습지 문제 + 선생님 손풀이**를 보고
막히는 부분을 **그 자리에서 AI 선생님**에게 질문한다. 어려운 문제는 **오답노트**에 저장하고
**메모**와 **AI 대화기록**을 남긴다. 선생님(관리자)은 문제·손풀이 이미지를 올리고 학생/질문을 관리한다.

> 사직여고 학습지 풀이 앱과 **동일한 구조**. 바뀐 것은 ① 학습지 단원/문항수, ② 학생 명단, ③ 학교명 표기, ④ AI 선생님 프롬프트(동인고 1학년 수학) 뿐.

## 학습지 (시드됨)
1. 여러 가지 방정식과 부등식 — 13문항
2. 순열과 조합 — 13문항
3. 행렬 — 13문항

## 기술 스택
- 프론트: Vite + React 18 (`src/App.jsx` 단일 파일)
- 서버리스: Vercel Functions (`api/admin.js`, `api/ask.js`)
- DB/스토리지: Supabase (Postgres + Storage 공개 버킷 `problem-images`)
- AI: Anthropic Claude (`/api/ask`가 키 보관 후 대신 호출, 기본 모델 `claude-sonnet-4-6`)

## 배포 순서 (새 프로젝트)
1. **Supabase** 새 프로젝트 생성 → SQL Editor에 `supabase-schema.sql` 1회 Run
   (테이블·RLS·이미지 버킷·학습지 3개·학생 36명까지 자동 생성)
2. **Anthropic API 키** 발급
3. **GitHub** 새 저장소에 이 폴더 push → **Vercel** Import
4. **Vercel 환경변수 7개** 등록 후 Deploy (아래)
5. 배포 후 첫 진입 → 선생님 로그인 → 문제 이미지 업로드

> `VITE_`로 시작하는 2개는 **빌드 시 번들에 박힘** → 값 바꾸면 반드시 **재배포(Redeploy)**.

## 환경변수 (Vercel, 7개)
| 변수 | 위치 | 설명 |
|---|---|---|
| `VITE_SUPABASE_URL` | 프론트(공개) | Supabase 프로젝트 URL |
| `VITE_SUPABASE_ANON_KEY` | 프론트(공개) | anon 공개 키 |
| `SUPABASE_URL` | 서버 전용 | 서버리스용 URL (끝 슬래시 `/` 금지) |
| `SUPABASE_SERVICE_ROLE_KEY` | 서버 전용 | RLS 우회용. **외부 노출 절대 금지** |
| `ANTHROPIC_API_KEY` | 서버 전용 | Claude API 키 |
| `ANTHROPIC_MODEL` | 서버 전용 | 미설정 시 `claude-sonnet-4-6` |
| `ADMIN_CODE` | 서버 전용 | 관리자 로그인 코드 (**기본값 두지 말고 꼭 직접 지정**) |

## 로그인
- 학생: 이름 + 휴대폰 **뒤 4자리**(= 학생 연락처 기준으로 시드됨)
- 선생님: 관리자 코드(`ADMIN_CODE`)

## 명단 메모 (시드 시 정리한 부분)
- 원본 14~20행이 7~13행과 완전 중복 → 중복 제거(1건씩만).
- 동명이인 정지우 2명 → `정지우A`(1685) / `정지우B`(1935)로 분리(이름이 로그인 PK라 분리 필수).
- 34행은 이름이 비어 있어(이름칸="동인고") 제외. 이름 확인되면 `supabase-schema.sql` 하단 주석 한 줄로 추가.

## 로컬 개발
```
npm install
npm run dev      # http://localhost:5173
npm run build
```
