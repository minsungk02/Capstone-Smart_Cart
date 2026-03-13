# 협업 가이드 (브랜치 전략)

## 브랜치 구조

```
main   ← 최종 배포 브랜치. PR로만 merge 가능. 직접 push 금지.
  └── dev   ← 팀원 작업 통합 브랜치. PR로만 merge 가능.
        ├── feat/기능명
        ├── feat/기능명
        └── fix/버그명
```

## 작업 흐름

### 1. 새 기능 시작
```bash
# 항상 dev 기준으로 브랜치 생성
git checkout dev
git pull origin dev
git checkout -b feat/내기능명
```

### 2. 작업 및 커밋
```bash
git add .
git commit -m "feat: 기능 설명"
git push origin feat/내기능명
```

### 3. PR 생성
- `feat/내기능명` → `dev` 로 PR 생성
- PR 제목: `feat: 기능 설명` 또는 `fix: 버그 설명`
- 팀원 1명 이상 리뷰 후 merge

### 4. 배포 (main 반영)
- `dev` → `main` PR은 팀장이 직접 생성
- 충분히 테스트된 상태에서만 merge

---

## 브랜치 네이밍 규칙

| 접두사 | 용도 | 예시 |
|--------|------|------|
| `feat/` | 새 기능 | `feat/chatbot-voice-input` |
| `fix/` | 버그 수정 | `fix/ocr-timeout-error` |
| `refactor/` | 코드 개선 | `refactor/session-manager` |
| `docs/` | 문서 수정 | `docs/readme-update` |
| `hotfix/` | 긴급 수정 (main 직접) | `hotfix/login-crash` |

---

## 커밋 메시지 규칙

```
feat: 새로운 기능 추가
fix: 버그 수정
docs: 문서 수정
refactor: 코드 리팩토링 (기능 변경 없음)
style: 포맷, 세미콜론 등 (기능 변경 없음)
chore: 빌드 설정, 패키지 업데이트 등
```

예시:
```
feat: 컵밥 OCR 정밀 인식 파이프라인 추가
fix: 로그인 토큰 만료 시 무한 리다이렉트 수정
docs: jangbogo_run.md 실행 가이드 업데이트
```

---

## 브랜치 보호 규칙 (GitHub 설정 필요)

아래 설정을 `main`과 `dev` 브랜치 각각 적용해주세요.

**경로**: GitHub 레포 → Settings → Branches → Add branch ruleset

### main 보호 규칙
- ✅ Require a pull request before merging
- ✅ Require approvals: **1명**
- ✅ Do not allow force pushes
- ✅ Do not allow deletions

### dev 보호 규칙
- ✅ Require a pull request before merging
- ✅ Require approvals: **1명**
- ✅ Do not allow force pushes

---

## 충돌 해결

```bash
# dev 최신화 후 내 브랜치에 rebase
git checkout feat/내기능명
git fetch origin
git rebase origin/dev

# 충돌 해결 후
git add .
git rebase --continue
git push origin feat/내기능명 --force-with-lease
```
